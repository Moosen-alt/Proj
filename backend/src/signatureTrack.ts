// ---------------------------------------------------------------------------------------------
// THE NEM TRACK BETWEEN THE SIGNATURE REQUEST AND THE FILING (#310).
//
// PSE's PowerClerk Part 2: step 4 ends in Request Signatures (a DocuSign email to the homeowner,
// #308), and the filing is step 5's Submit, after the homeowner signs. Between the two the
// application sits on the portal as "Application Draft / Unsubmitted", so the track must never read
// as filed. Its states, in order:
//
//   awaiting_signature_request   a run staged step 4 and stopped in front of Request Signatures
//   signature_request_unconfirmed an approved click the status did not confirm (a person checks)
//   awaiting_customer_signature  the request went: an approved run's click whose status reads
//                                requested (#308), OR a named person confirming here that they
//                                clicked it themselves (recorded with who and when); a resume
//                                that read the record as not signed, or unreadable, stays here
//   ready_to_submit              a resume read the signature as complete (every status, positively)
//                                but did not reach step 5's Submit
//   awaiting_human_submit        a resume read it complete and stopped in front of step 5's Submit
//   submitted                    the track is filed (a person's capture, or a click under the gate)
//
// The step 5 Submit is clicked only under hard rule 1's gate (mayClickFinalSubmit /
// automaticSubmitRefusals), unchanged; nothing in this module decides a click. "Check signature now"
// is a manual stage of the track (no cadence): a stage while the track waits on the signature is a
// resume (repository.prepareSubmission passes continueDraft.awaitingSignature).
//
// The state is DERIVED, never stored: each run's result_json.reviewState and each person's
// confirmation (an audit row, as the draft itself is recorded: portalDraft.ts) are events; the
// newest event that applies decides. A run that read nothing about the signature (a failed login, a
// walk that never reached the record) is no event, so it never moves the track backwards.
// ---------------------------------------------------------------------------------------------
import type { AppDb } from "./db";
import { addAuditLog } from "./audit";
import { HttpError } from "./httpError";
import { parseJson, text as s } from "./json";

/** The NEM track's permit_type family (submittalTracks.trackPermitTypes("nem")), named here so this
 *  module, which submittalTracks reads, imports nothing back from it. */
const NEM_FAMILY = ["nem"];

export type NemSignatureState =
  | "awaiting_signature_request"
  | "signature_request_unconfirmed"
  | "awaiting_customer_signature"
  | "ready_to_submit"
  | "awaiting_human_submit"
  | "submitted";

/** A run's review state that is a signature state (result_json.reviewState). */
const RUN_STATES = new Set<string>([
  "awaiting_signature_request", "signature_request_unconfirmed", "awaiting_customer_signature", "ready_to_submit", "awaiting_human_submit",
]);

/** The audit action a person's "I clicked Request Signatures" writes. */
export const SIGNATURE_REQUEST_CONFIRMED_ACTION = "portal.signature_request_confirmed";

export type SignatureEvent =
  | { kind: "run"; reviewState: string; at: string; why?: string }
  | { kind: "confirmed"; by: string; at: string };

export interface NemSignatureView {
  state: NemSignatureState;
  /** When the deciding event happened. */
  at: string;
  /** Who confirmed the request, when a person did. */
  by?: string;
  /** What the deciding run read (the signature check's sentence), when it said. */
  why?: string;
}

/**
 * THE TRANSITIONS, as a pure fold over events (oldest first). A person's confirmation applies only
 * in front of Request Signatures (awaiting_signature_request or signature_request_unconfirmed);
 * anywhere else it is ignored. Filed wins over everything. null = the track is not at the signature
 * part of the flow.
 */
export function reduceNemSignatureState(events: ReadonlyArray<SignatureEvent>, filed: { at: string } | null): NemSignatureView | null {
  let view: NemSignatureView | null = null;
  const ordered = [...events].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  for (const e of ordered) {
    if (e.kind === "run") {
      if (!RUN_STATES.has(e.reviewState)) continue;
      view = { state: e.reviewState as NemSignatureState, at: e.at, ...(e.why ? { why: e.why } : {}) };
    } else if (view && (view.state === "awaiting_signature_request" || view.state === "signature_request_unconfirmed")) {
      view = { state: "awaiting_customer_signature", at: e.at, by: e.by };
    }
  }
  if (filed) return { state: "submitted", at: filed.at };
  return view;
}

/** The NEM track's signature state for one project, from its runs and confirmations. */
export function nemSignatureState(db: AppDb, projectId: string): NemSignatureView | null {
  const family = NEM_FAMILY;
  const ph = family.map(() => "?").join(",");
  const events: SignatureEvent[] = [];
  for (const r of db.query<Record<string, unknown>>(
    `SELECT result_json, started_at FROM portal_runs
      WHERE project_id = ? AND permit_type IN (${ph}) AND run_type = 'prepare_submit'
      ORDER BY started_at DESC, rowid DESC LIMIT 40`,
    [projectId, ...family],
  )) {
    const result = parseJson<{ reviewState?: unknown; signatureCheck?: { why?: unknown } }>(s(r.result_json) || "{}", {});
    const reviewState = typeof result.reviewState === "string" ? result.reviewState : "";
    if (!reviewState) continue;
    const why = typeof result.signatureCheck?.why === "string" ? result.signatureCheck.why : "";
    events.push({ kind: "run", reviewState, at: s(r.started_at), ...(why ? { why } : {}) });
  }
  for (const a of db.query<Record<string, unknown>>(
    "SELECT details, created_at FROM audit_logs WHERE project_id = ? AND action = ? ORDER BY created_at DESC LIMIT 20",
    [projectId, SIGNATURE_REQUEST_CONFIRMED_ACTION],
  )) {
    const d = parseJson<{ confirmedBy?: unknown }>(s(a.details) || "{}", {});
    events.push({ kind: "confirmed", by: s(d.confirmedBy), at: s(a.created_at) });
  }
  const filedRow = db.get<Record<string, unknown>>(
    `SELECT COALESCE(submitted_at, created_at) AS at FROM submissions
      WHERE project_id = ? AND permit_type IN (${ph}) AND status IN ('submitted', 'submitted_unconfirmed')
      ORDER BY created_at DESC LIMIT 1`,
    [projectId, ...family],
  );
  return reduceNemSignatureState(events, filedRow ? { at: s(filedRow.at) } : null);
}

/** Does the NEM track wait on (or already have) the homeowner's signature? Then a stage is a RESUME:
 *  it reads the record's signature status before opening anything (continueDraft.awaitingSignature). */
export function nemStageIsResume(view: NemSignatureView | null): boolean {
  return Boolean(view && (view.state === "awaiting_customer_signature" || view.state === "ready_to_submit" || view.state === "awaiting_human_submit"));
}

/**
 * A NAMED PERSON SAYS THEY CLICKED REQUEST SIGNATURES THEMSELVES (the track card's "I sent the
 * signature request"). Recorded with who and when; it moves the track to awaiting customer signature
 * only from in front of Request Signatures. It clicks nothing and files nothing.
 */
export function confirmSignatureRequestSent(db: AppDb, projectId: string, input: { confirmedBy: string; userId?: string | null }): NemSignatureView {
  const confirmedBy = String(input.confirmedBy ?? "").trim();
  if (!confirmedBy) throw new HttpError(400, "Say who sent the signature request: sign in, or give your name.");
  const before = nemSignatureState(db, projectId);
  if (!before || (before.state !== "awaiting_signature_request" && before.state !== "signature_request_unconfirmed")) {
    throw new HttpError(409, before
      ? `The utility application is not in front of Request Signatures (it is ${before.state.replace(/_/g, " ")}), so there is nothing to confirm.`
      : "No run has staged this utility application's signature step yet, so there is nothing to confirm.");
  }
  addAuditLog(db, projectId, "human", confirmedBy, SIGNATURE_REQUEST_CONFIRMED_ACTION, {
    track: "nem", confirmedBy, userId: input.userId ?? null, from: before.state,
  });
  const after = nemSignatureState(db, projectId);
  if (!after) throw new HttpError(500, "The confirmation was recorded but the track state could not be read back.");
  return after;
}
