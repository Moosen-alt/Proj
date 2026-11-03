// #436 PR1 — THE STAGED DRAFT'S REVIEW ROW: ONE WRITER, AND ITS READERS.
//
// A plain NEM Stage that stops at review reads every step page of its draft read-only (portal-bot
// reviewDigest.ts) and hands the reading back IN MEMORY as the adapter result's top-level
// `stagedReview`. prepareSubmission takes it off that result before anything is persisted
// (takeStagedReviewCapture: result_json never carries it) and records it HERE — recordStagedReview
// is the only INSERT INTO portal_staged_reviews in the backend (stagedReviewRow.test scans for it).
// Nothing reads result_json for it: result_json has a second writer (portalDraft), so a reading from
// there could be forged.
//
// RULE 2, AGAIN AT THE DOOR. The reader already hashed every value and redacted every label; the
// writer re-checks it: every mac and digest must be a 64-hex HMAC (an identity "hash" — a raw value —
// is refused and nothing from that reading is kept), and every label, display value and reason is
// scrubbed again against the project's own secrets (projectSecretValues) and redactCaptureText.
// The draft id and review link are the exception: they are KEPT EXACTLY (PR2 binds them) or refused
// by name, never masked — stagedDraftReference, the one predicate the reader uses too.
//
// PR1 records and shows. Nothing clicks on a row: Approve on a staged draft stays held (#449), and
// `approvable` is what the card says, not an authority anywhere.
import fs from "node:fs";
import path from "node:path";
import type { AppDb } from "./db";
import type {
  StagedReviewAttachment, StagedReviewCapture, StagedReviewFieldReportRow, StagedReviewSection, StagedReviewView,
} from "../../shared/src/types";
import { redactSecretValues } from "../../shared/src/portalSafety";
import { maskId, redactCaptureText } from "../../portal-bot/src/safeAction";
import { stagedDraftReference } from "../../portal-bot/src/stagedDraftReference";
import { stagedReviewShotsDir } from "./statePaths";
import { nowIso } from "./time";
import { id } from "./ids";

type Row = Record<string, unknown>;
const s = (v: unknown): string => (v == null ? "" : String(v));
const HEX64 = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{16,64}$/;
const KEY_ID = /^[0-9a-f]{8,64}$/;

/** TAKE the capture off an in-memory adapter result — and out of every step's data, so nothing of it
 *  can reach result_json. Returns it (or null). The only way a capture gets to the writer. */
export function takeStagedReviewCapture(result: unknown): StagedReviewCapture | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const c = r.stagedReview;
  delete r.stagedReview;
  if (Array.isArray(r.steps)) {
    for (const step of r.steps) {
      const data = step && typeof step === "object" ? (step as { data?: unknown }).data : null;
      if (data && typeof data === "object") delete (data as Record<string, unknown>).stagedReview;
    }
  }
  return c && typeof c === "object" ? (c as StagedReviewCapture) : null;
}

/** A LATER STAGE OF THE TRACK SUPERSEDES EVERY EARLIER ROW — at the new run's start (the draft may
 *  change under it whatever the run's outcome). Returns how many rows it superseded. */
export function supersedeStagedReviews(db: AppDb, projectId: string, track: string, byRunId: string): number {
  const before = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM portal_staged_reviews WHERE project_id = ? AND track = ? AND superseded_at = '' AND run_id <> ?",
    [projectId, track, byRunId],
  )?.n ?? 0;
  if (before > 0) {
    db.run(
      "UPDATE portal_staged_reviews SET superseded_at = ?, superseded_by = ? WHERE project_id = ? AND track = ? AND superseded_at = '' AND run_id <> ?",
      [nowIso(), byRunId, projectId, track, byRunId],
    );
  }
  return Number(before);
}

/** The picture a row may name: a .png inside the staged-review folder, that exists. Else "". */
function servableShot(raw: unknown): string {
  const p = s(raw).trim();
  if (!p || !/\.png$/i.test(p)) return "";
  const dir = path.resolve(stagedReviewShotsDir());
  const file = path.resolve(p);
  const rel = path.relative(dir, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return "";
  try { return fs.statSync(file).isFile() ? file : ""; } catch { return ""; }
}

export interface RecordStagedReviewInput {
  runId: string;
  projectId: string;
  track: string;
  recipeId: string;
  stepsSignature: string;
  capture: StagedReviewCapture;
  /** The project's own secrets (projectSecretValues): every label and value is scrubbed against them again. */
  secrets: readonly string[];
}

/**
 * THE ONE WRITER of portal_staged_reviews. From the in-memory capture only. Supersedes every earlier
 * row of the track, re-checks rule 2 (hashes are hashes; text is scrubbed), and keeps the picture only
 * when it sits in the staged-review folder. Returns the row it wrote.
 */
export function recordStagedReview(db: AppDb, input: RecordStagedReviewInput): { id: string; approvable: boolean; why: string } {
  const c = input.capture;
  const secrets = (input.secrets ?? []).map((x) => s(x).trim()).filter((x) => x.length >= 4);
  const scrub = (t: unknown, max = 80): string =>
    redactCaptureText(redactSecretValues(s(t), secrets, (hit) => maskId(hit.replace(/[^0-9A-Za-z]/g, ""))), 4000).replace(/\s+/g, " ").trim().slice(0, max);
  const sectionsIn = Array.isArray(c?.sections) ? c.sections : [];
  // HASHES ARE HASHES: a raw value posing as a mac (an identity swap, a bug) keeps nothing.
  const hashed = NONCE.test(s(c?.nonce)) && KEY_ID.test(s(c?.keyId))
    && (s(c?.digest) === "" || HEX64.test(s(c?.digest)))
    && sectionsIn.every((sec) => (s(sec?.digest) === "" || HEX64.test(s(sec?.digest)))
      && (Array.isArray(sec?.items) ? sec.items : []).every((it) => HEX64.test(s(it?.mac))));
  const why: string[] = (Array.isArray(c?.why) ? c.why : []).map((w) => scrub(w, 200)).filter(Boolean);
  if (!hashed) why.unshift("the reading did not come back hashed, so nothing from it was kept");
  const sections: StagedReviewSection[] = sectionsIn.slice(0, 40).map((sec) => ({
    step: scrub(sec?.step),
    where: scrub(sec?.where, 200),
    digest: hashed ? s(sec?.digest) : "",
    items: hashed ? (Array.isArray(sec?.items) ? sec.items : []).slice(0, 600).map((it) => ({
      kind: it.kind, label: scrub(it.label), ordinal: Number(it.ordinal) || 1, mac: s(it.mac),
    })) : [],
    unreadable: scrub(sec?.unreadable, 200),
  }));
  const fieldReport: StagedReviewFieldReportRow[] = (Array.isArray(c?.fieldReport) ? c.fieldReport : []).slice(0, 200).map((r) => ({
    label: scrub(r?.label), display: scrub(r?.display), source: scrub(r?.source, 60), step: scrub(r?.step),
  }));
  const attachments: StagedReviewAttachment[] = (Array.isArray(c?.attachments) ? c.attachments : []).slice(0, 40).map((a) => ({
    name: scrub(a?.name, 120), docType: scrub(a?.docType, 60), sha256: HEX64.test(s(a?.sha256)) ? s(a?.sha256) : "", listed: a?.listed === true,
  }));
  const shot = servableShot(c?.screenshotPath);
  const digest = hashed ? s(c?.digest) : "";
  // THE DRAFT ID AND LINK ARE KEPT EXACTLY OR NOT AT ALL (stagedDraftReference, the reader's own
  // predicate, again with the project's secrets): never through scrub(), whose display redaction masks
  // every 5+ digit run — PowerClerk's ProjectId=204411 became "**4411", an id that binds nothing.
  const ref = stagedDraftReference(c?.draftId, c?.reviewLink, secrets);
  if (ref.refused) why.push(ref.refused);
  const draftId = ref.draftId;
  const approvable = hashed && c?.approvable === true && HEX64.test(digest) && !!draftId
    && sections.length > 0 && sections.every((sec) => !sec.unreadable) && why.length === 0;
  if (!approvable && !why.length) why.push("the reading is not approvable");
  const rowId = id();
  const reason = Array.from(new Set(why)).join("; ").slice(0, 1200);
  db.transaction(() => {
    supersedeStagedReviews(db, input.projectId, input.track, input.runId);
    db.run(
      `INSERT INTO portal_staged_reviews
        (id, run_id, project_id, track, recipe_id, steps_signature, digest_version, key_id, nonce, digest,
         sections_json, draft_id, review_link, field_report_json, attachments_json, screenshot_path,
         approvable, unapprovable_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rowId, input.runId, input.projectId, input.track, s(input.recipeId), s(input.stepsSignature),
        Number(c?.version) || 0, KEY_ID.test(s(c?.keyId)) ? s(c?.keyId) : "", NONCE.test(s(c?.nonce)) ? s(c?.nonce) : "", digest,
        JSON.stringify(sections), draftId, ref.reviewLink, JSON.stringify(fieldReport), JSON.stringify(attachments), shot,
        approvable ? 1 : 0, approvable ? "" : reason, nowIso(),
      ],
    );
  });
  return { id: rowId, approvable, why: approvable ? "" : reason };
}

/** The newest staged review of a track that no later Stage superseded, or null. A read: writes nothing. */
export function latestStagedReview(db: AppDb, projectId: string, track: string): Row | null {
  return db.get<Row>(
    `SELECT * FROM portal_staged_reviews WHERE project_id = ? AND track = ? AND superseded_at = ''
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [projectId, track],
  );
}

const parse = <T>(raw: unknown, fallback: T): T => { try { const v = JSON.parse(s(raw)); return (v ?? fallback) as T; } catch { return fallback; } };

/** The track card's view of a row (labels and masked values only; no mac, no nonce). */
export function stagedReviewView(row: Row): StagedReviewView {
  const projectId = s(row.project_id);
  const runId = s(row.run_id);
  const sections = parse<StagedReviewSection[]>(row.sections_json, []);
  return {
    runId,
    approvable: Number(row.approvable) === 1,
    why: s(row.unapprovable_reason),
    createdAt: s(row.created_at),
    screenshotUrl: servableShot(row.screenshot_path)
      ? `/api/projects/${encodeURIComponent(projectId)}/staged-reviews/${encodeURIComponent(runId)}/screenshot`
      : "",
    fieldReport: parse<StagedReviewFieldReportRow[]>(row.field_report_json, []),
    attachments: parse<StagedReviewAttachment[]>(row.attachments_json, []).map((a) => ({ name: s(a.name), docType: s(a.docType), listed: a.listed === true })),
    sections: sections.map((sec) => ({ step: s(sec.step), items: Array.isArray(sec.items) ? sec.items.length : 0, unreadable: s(sec.unreadable) })),
  };
}

/** The masked picture for ONE project's run: the row must be that project's (else null — a 404, rule
 *  6), and the file must sit in the staged-review folder. Never portal_runs.screenshots_path. */
export function stagedReviewScreenshotFile(db: AppDb, projectId: string, runId: string): string | null {
  const row = db.get<Row>("SELECT screenshot_path FROM portal_staged_reviews WHERE run_id = ? AND project_id = ?", [runId, projectId]);
  if (!row) return null;
  return servableShot(row.screenshot_path) || null;
}
