// ---------------------------------------------------------------------------------------------
// A NAMED PERSON APPROVES ONE RUN'S SIGNATURE REQUEST (#308; owner ruling 2026-10-14 on #305).
//
// PSE's PowerClerk "Request Signatures" emails the homeowner a DocuSign request. The bot clicks it
// only in a run a named person approved after reviewing the staged application: this row is that
// approval. It mirrors the final-submit approval (repository.createRunApproval / claimRunApproval)
// and is deliberately a SEPARATE table, so neither approval can ever be claimed as the other:
//
//   - minted only by POST /api/projects/:id/prepare-submission with requestSignatures (the
//     "Approve & request signatures" action), for the NEM track, under the approver's name;
//   - its id travels with the request (the job payload's signatureRequestApprovalId) and is
//     claimed BY ID, before the first staging gate: a run that a gate refuses has spent it;
//   - its id becomes the run's id, so it names that run and no other (signatureRequestGate checks
//     the two match at the click);
//   - it expires unclaimed after thirty minutes, and is single use.
//
// PORTAL_ALLOW_FINAL_SUBMIT plays no part: Request Signatures files nothing.
// ---------------------------------------------------------------------------------------------
import { randomUUID } from "node:crypto";
import type { AppDb } from "./db";
import { addAuditLog } from "./audit";
import { HttpError } from "./httpError";

type Row = Record<string, unknown>;
const text = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const nowIso = (): string => new Date().toISOString();

/** How long an approval waits for its run (the route enqueues the run at once). */
export const SIGNATURE_REQUEST_APPROVAL_TTL_MS = 30 * 60_000;

/** Record a named person's approval of the NEXT staging run's signature request for (project, track). */
export function createSignatureRequestApproval(
  db: AppDb,
  input: { projectId: string; track: string; approver: string; approverUserId?: string | null },
): { id: string; approver: string; expiresAt: string } {
  const approver = String(input.approver ?? "").trim();
  if (!approver) throw new HttpError(400, "A signature request needs a named approver — sign in, or give your name, before approving.");
  const track = String(input.track || "").trim();
  if (track !== "nem") throw new HttpError(400, "Request Signatures is a step of a utility interconnection application; approve it on the utility (NEM) filing.");
  const approvalId = randomUUID();
  const now = Date.now();
  const expiresAt = new Date(now + SIGNATURE_REQUEST_APPROVAL_TTL_MS).toISOString();
  db.run(
    `INSERT INTO portal_signature_request_approvals (id, project_id, track, approver, approver_user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [approvalId, input.projectId, track, approver, input.approverUserId ?? null, new Date(now).toISOString(), expiresAt],
  );
  addAuditLog(db, input.projectId, "human", approver, "portal.signature_request_approved", { approvalId, track, expiresAt });
  return { id: approvalId, approver, expiresAt };
}

/**
 * Take (and consume, atomically) ONE named approval, BY ID, for (project, track). Null when the id
 * is blank, unknown, another project's or track's, already used, or expired. Single use.
 */
export function claimSignatureRequestApproval(
  db: AppDb, projectId: string, track: string, approvalId: string | null | undefined,
): { id: string; approver: string; createdAt: string } | null {
  const wanted = String(approvalId ?? "").trim();
  if (!wanted) return null;
  const row = db.get<Row>(
    `SELECT id, approver, created_at FROM portal_signature_request_approvals
      WHERE id = ? AND project_id = ? AND track = ? AND consumed_at IS NULL AND expires_at > ?`,
    [wanted, projectId, track || "", nowIso()],
  );
  if (!row) return null;
  db.run("UPDATE portal_signature_request_approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL", [nowIso(), text(row.id)]);
  if (Number(db.get<{ n: number }>("SELECT changes() AS n")?.n ?? 0) === 0) return null; // another run took it
  return { id: text(row.id), approver: text(row.approver), createdAt: text(row.created_at) };
}

/** The signature-request approval id the RUNNING prepare_submission job for this project carries:
 *  the job the route enqueued for the request that minted it (one portal-effect job per project
 *  runs at a time). Null when no job is running or it names none. */
export function runningJobSignatureRequestApprovalId(db: AppDb, projectId: string): string | null {
  const row = db.get<Row>(
    `SELECT payload FROM job_queue WHERE project_id = ? AND job_type = 'prepare_submission' AND status = 'running'
      ORDER BY started_at DESC LIMIT 1`,
    [projectId],
  );
  if (!row) return null;
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(text(row.payload) || "{}") as Record<string, unknown>; } catch { return null; }
  const id = typeof payload.signatureRequestApprovalId === "string" ? payload.signatureRequestApprovalId.trim() : "";
  return id || null;
}
