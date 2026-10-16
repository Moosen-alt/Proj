// HUMAN-VERIFIED INFORMATION PAGES (#344, owner ruling 2026-10-15: option B; proposal approved
// 2026-10-16) — the backend half.
//
// The network backstop (portal-bot/src/filingBackstop.ts openInfoPagePass) may let ONE forward
// request off an information page through hard rule 1's review lockdown (4b), only when a NAMED
// PERSON verified that exact page and the run has entered nothing (shared/src/infoPagePass.ts).
// This module is the ONLY writer of both tables (infoPagePass.test's source scan pins it):
//
//   portal_info_page_candidates — project-scoped EVIDENCE a learn recorded when the backstop held
//     an unverified information page (recordInfoPageCandidate, called by autoLearn's finalize).
//     Evidence, never authority.
//   portal_info_page_passes — the SERVER-OWNED RECORD (shared knowledge: hashes, names, structure).
//     ONE function creates a row: verifyInfoPageCandidate, a named person's verify, built from the
//     candidate ROW (never a request body). No path ever UPDATEs a row. A row is WITHDRAWN by a
//     DELETE (removeInfoPagePass, the one delete) — by a person, by an incident a run reports (§4 of
//     the proposal: the page drifted before the click, or did not read as "not filed" after it),
//     or with the project it was verified on. History stays in the audit log. Never written by a
//     learn, an import, research, a replay, a recipe save, a correction or a migration (rule 3).
//
// AUTHORITY IS THE PERSON'S VERIFICATION ON RECORD (liveInfoPagePasses, the ONE effective-row
// predicate the bot input and the KB list both read): a pass row counts only while its source
// candidate row says a person verified it — status 'verified', pass_id = this row, the same person
// and time — and the row is exactly what verifyInfoPageCandidate builds from that candidate. A row
// written any other way (a direct INSERT, a copy, a row "moved" to another host / path / control /
// step sequence) is never handed to a run (the #354 lesson: data a generic path can write is never
// authority for a click).
//
// AT MOST ONCE PER PROJECT (round 2): this module also owns the project's LEARN LEDGER in the audit
// log — each learn attempt's start (before it touches the portal), whether it ended as a clean hold,
// each admitted use (written the moment the learner reports it), each hold at a verified page, and
// a named person's "allow once more" — and infoPagePriorProgress reads it with the project's
// filings, numbers, drafts and staged / paused / interrupted runs. Every one of those actions is
// named only here and written by one function each (infoPagePass.test's source scan).
//
// MAY HAVE FILED (round 3): an after-click incident (a receipt-like page, the run entering none of
// the job's data on the page the verified click led to, or a learn that died before that page was
// judged) puts a warning on EVERY project in the pass's use ledger — "The verified page may have
// filed — check the portal for this project" — read on the project's card and, named within the
// viewer's own org, on the pass's knowledge-base entry.
import { DEFAULT_ORG_ID, type AppDb } from "./db";
import { addAuditLog } from "./audit";
import { HttpError } from "./httpError";
import { id as newId } from "./ids";
import { nowIso } from "./time";
import {
  INFO_PAGE_IDENTITY_VERSION, infoPageProjectValueRefusals, infoPageRequestRefusals, infoPageShapeRefusals, infoPageVerifyWarnings,
  verifiedInfoPageFromCandidate,
  type InfoPageDigest, type InfoPageEvidence, type InfoPageObservedRequest, type InfoPagePrefixStep,
} from "../../shared/src/infoPagePass";
import { isFilingOrPaymentRequest, isPayRequestUrl } from "../../shared/src/portalSafety";
import type { InfoPageCandidateCapture, InfoPageCandidateRecord, InfoPageFilingWarning, InfoPageIncident, InfoPagePassFilingWarning, InfoPagePassRecord, InfoPageProjectSideState, VerifiedInfoPage } from "../../shared/src/types";

type Row = Record<string, unknown>;
const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const parse = <T>(text: unknown, fallback: T): T => { try { return JSON.parse(s(text)) as T; } catch { return fallback; } };
const HEX64 = /^[0-9a-f]{64}$/;

/** Canonical JSON (object keys sorted, arrays in order): the provenance comparison. */
const canon = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
};

// ---------------------------------------------------------------------------------------------
// The bot's input
// ---------------------------------------------------------------------------------------------

const passRowToVerified = (r: Row): VerifiedInfoPage => ({
  id: s(r.id),
  identityVersion: Number(r.identity_version),
  identitySha256: s(r.identity_sha256),
  origin: s(r.origin),
  path: s(r.path),
  queryKeys: parse<string[]>(r.query_keys_json, []),
  components: {
    pageSha: s(r.page_sha256), titleSha: s(r.title_sha256), structureSha: s(r.structure_sha256),
    textSha: s(r.text_sha256), controlSha: s(r.control_sha256), requestSha: s(r.request_sha256),
  },
  controlTag: s(r.control_tag),
  controlType: s(r.control_type),
  controlName: s(r.control_name),
  controlLabel: s(r.control_label),
  request: { method: s(r.request_method), where: s(r.request_where), actionSha256: s(r.request_action_sha256), media: s(r.request_media), body: parse<Array<[string, string]>>(r.request_body_json, []) },
  prefix: parse<Array<[string, string, string]>>(r.prefix_json, []),
  verifiedAt: s(r.verified_at),
});

/**
 * IS THIS PASS ROW A PERSON'S VERIFICATION ON RECORD? Its source candidate says so (verified, this
 * pass, the same person at the same time), and the row is EXACTLY what verifyInfoPageCandidate
 * builds from that candidate. Anything else — a row inserted by another path, or one whose host,
 * path, control, request or step sequence was changed after the fact — is not authority.
 */
function passIsOnRecord(db: AppDb, r: Row): boolean {
  if (!s(r.verified_at) || !s(r.verified_by) || !s(r.source_candidate_id)) return false;
  const c = db.get<Row>("SELECT * FROM portal_info_page_candidates WHERE id = ?", [s(r.source_candidate_id)]);
  if (!c) return false;
  if (s(c.status) !== "verified" || s(c.pass_id) !== s(r.id)) return false;
  if (s(c.decided_by) !== s(r.verified_by) || s(c.decided_at) !== s(r.verified_at)) return false;
  const digest = parse<InfoPageDigest | null>(c.digest_json, null);
  if (!digest || digest.identitySha256 !== s(c.identity_sha256)) return false;
  let built: Omit<VerifiedInfoPage, "id" | "verifiedAt">;
  try {
    built = verifiedInfoPageFromCandidate({ identityVersion: Number(c.identity_version), identitySha256: s(c.identity_sha256), digest, prefix: parse<InfoPagePrefixStep[]>(c.prefix_json, []) });
  } catch { return false; }
  const { id: _id, verifiedAt: _at, ...row } = passRowToVerified(r);
  void _id; void _at;
  return canon(row) === canon(built);
}

/** THE effective-row predicate: a person's verification on record, at the current identity
 *  version. The bot input (autoLearn) and the KB list both read it. Reads only. */
export function liveInfoPagePasses(db: AppDb): VerifiedInfoPage[] {
  const rows = db.query<Row>(
    `SELECT * FROM portal_info_page_passes
      WHERE verified_at <> '' AND verified_by <> '' AND identity_version = ?
      ORDER BY verified_at`, [INFO_PAGE_IDENTITY_VERSION]);
  return rows.filter((r) => passIsOnRecord(db, r)).map(passRowToVerified);
}

// ---------------------------------------------------------------------------------------------
// The learn ledger and prior progress (round 2: a pass admits at most once per project)
// ---------------------------------------------------------------------------------------------

// THE AUDIT ACTIONS THAT ARE AUTHORITY for the information-page question. Named only here (the
// infoPagePass.test source scan pins every literal to this file, and each write to its one function):
// a forged "clean" row would turn a learn that entered data into one that did not, a forged
// allowance would lift a project's progress. Only addAuditLog writes audit_logs, never with an action
// a request body chose.
/** A learn of this project touched this portal (written BEFORE the walk: a learn that dies keeps it). */
const ACT_LEARN_STARTED = "portal.info_page_learn_started";
/** That learn ended HELD, untouched, at an information page (the only learn that is not progress). */
const ACT_LEARN_CLEAN = "portal.info_page_learn_clean";
/** The backstop admitted a verified page's one request on a run of this project (written at once). */
const ACT_PASSED = "portal.info_page_passed";
/** A run of this project was held at a verified page only because of its prior progress. */
const ACT_HELD_VERIFIED = "portal.info_page_held_verified";
/** A named person allowed the pass ONCE MORE for this project and side. */
const ACT_ALLOWED_AGAIN = "portal.info_page_pass_allowed_again";
/** ROUND 3: an after-click incident on a pass this project USED — the verified page may have filed
 *  for this project (the warning on its card and on the pass's knowledge-base entry). Evidence only. */
const ACT_MAY_HAVE_FILED = "portal.info_page_may_have_filed";

type Side = "ahj" | "utility";
const sideOf = (scope: unknown): Side | "" => (scope === "ahj" || scope === "utility" ? scope : "");
/** A row's side: its details.scope, else its track (nem = utility). Unknown = both sides. */
const rowOnSide = (details: Row, side: Side): boolean => {
  const sc = sideOf(details.scope);
  if (sc) return sc === side;
  const tr = s(details.track);
  if (tr) return (tr === "nem") === (side === "utility");
  return true;
};
const maskDigits = (x: unknown): string => s(x).replace(/\d/g, "#");

/** BEFORE EACH LEARN ATTEMPT TOUCHES THE PORTAL (autoLearn): on record first, so a learn that dies,
 *  throws or is interrupted is progress unless it ends clean. Returns the start's id. */
export function recordInfoPageLearnStart(db: AppDb, projectId: string, scope: Side, attempt: number): string {
  const startId = newId();
  addAuditLog(db, projectId, "system", "auto-learn", ACT_LEARN_STARTED, { startId, scope, attempt });
  return startId;
}

/** IS THIS LEARN'S RESULT A CLEAN HOLD? It stopped at the backstop's hold of an information page
 *  whose run state was clean at the click (the candidate watch opens only then, and its request
 *  was observed — held), passed no verified page, reported no after-click incident, reached no
 *  review, paused for nothing and continued no draft — and (round 3, V9) its recorded steps are an
 *  array with NO write in them (fill / select / check / uncheck / upload / press), and it says it
 *  filled nothing. Nothing else is clean: unknown is progress. */
const WRITE_STEP = /^(fill|select|check|uncheck|upload|press|type)$/;
export function isCleanInfoPageHold(l: unknown): boolean {
  const r = (l && typeof l === "object" ? l : {}) as Row;
  const cand = r.infoPageCandidate as Row | undefined;
  const passed = r.infoPagePassed as unknown[] | undefined;
  const incidents = r.infoPageIncidents as Array<{ phase?: string }> | undefined;
  const steps = r.steps as Array<{ action?: unknown }> | undefined;
  return r.stopReason === "backstop_abort" && !!cand && typeof cand === "object" && !!cand.observed
    && !(Array.isArray(passed) && passed.length) && !(Array.isArray(incidents) && incidents.some((i) => i && i.phase === "after"))
    && r.reachedReview !== true && !r.pauseReason && !r.continuedDraft
    && Array.isArray(steps) && !steps.some((st) => !st || typeof st !== "object" || WRITE_STEP.test(String(st.action ?? "")))
    && r.filledSomething !== true;
}

/** THE LEARN ENDED CLEAN (isCleanInfoPageHold): its start no longer counts as progress. */
export function recordInfoPageLearnClean(db: AppDb, projectId: string, scope: Side, startId: string): void {
  if (!startId) return;
  addAuditLog(db, projectId, "system", "auto-learn", ACT_LEARN_CLEAN, { startId, scope });
}

/** A run of this project was held at a verified page because of its prior progress (the card then
 *  offers "Allow once more for this project"). Evidence, never authority. */
export function recordInfoPageHeldVerified(db: AppDb, projectId: string, scope: Side, runId: string, held: ReadonlyArray<{ passId: string; where: string; why?: string[] }> | null | undefined): void {
  for (const h of Array.isArray(held) ? held.slice(0, 3) : []) {
    addAuditLog(db, projectId, "portal_bot", "network backstop", ACT_HELD_VERIFIED, {
      scope, runId: s(runId).slice(0, 120), passId: s(h?.passId).slice(0, 80), where: s(h?.where).slice(0, 200),
    });
  }
}

interface PriorProgressReasons {
  /** Never lifted by an allowance: a filing, a number, a draft, a stage that reached review, paused
   *  or was interrupted. */
  hard: string[];
  /** This project's earlier LEARNS on this side, after the latest allowance: lifted by a person's
   *  "Allow once more for this project". */
  learn: string[];
}

/**
 * WHY THIS PROJECT HAS ALREADY MADE PROGRESS ON THIS SIDE (critique [1]; round 2: fail closed). The
 * portal session and its server-side interview survive between runs (a persistent per-client
 * profile), so a page a person verified at the START of the interview could be shown again at a
 * later server position where its Next files.
 *
 * HARD (a person can never lift these here — the page is then done by hand for this project):
 *   - any tracked application or permit number of this project, WHATEVER its portal URL (blank, this
 *     host or another: the table carries no side);
 *   - a submission on this side in any status but "failed" (staged, awaiting a person, paused,
 *     submitted, approved, issued — and any status not known here);
 *   - a portal run on this side with a confirmation number, or in any status but queued / running
 *     (this stage's own row) / failed (interrupted, paused for a person, awaiting a submit or a
 *     resubmit, submitted — and any status not known here);
 *   - a draft recorded on this side (portal.draft_created);
 *   - a staging or autopilot job of this project interrupted mid-flight (side unknown: both).
 * LEARN (after the latest allowance on this side; lifted by the next one):
 *   - an earlier admitted pass (ACT_PASSED) — so a pass admits AT MOST ONCE per project and side;
 *   - an earlier learn that did not end clean (ACT_LEARN_STARTED with no ACT_LEARN_CLEAN): it may
 *     have entered data, it reached review, it paused, it threw, or it was cut off;
 *   - an earlier learn's own outcome on record: reached review (auto_learned_trusted / _draft),
 *     paused, continued a draft, filled fields without reaching review, a replay self-test, a
 *     person's fix captured mid-learn.
 * A read error is a hard reason: an unknown never reassures.
 */
export function infoPagePriorProgressReasons(db: AppDb, projectId: string, scopeType: Side): PriorProgressReasons {
  const hard: string[] = [];
  const learn: string[] = [];
  const side: Side = scopeType === "utility" ? "utility" : "ahj";
  const nem = side === "utility";
  try {
    for (const t of db.query<Row>("SELECT application_number, permit_number FROM permit_check_targets WHERE project_id = ?", [projectId])) {
      const n = s(t.application_number).trim() || s(t.permit_number).trim();
      if (n) { hard.push(`a filing of this project is tracked by number (${maskDigits(n).slice(0, 24)})`); break; }
    }
    for (const x of db.query<Row>("SELECT permit_type, status, application_number, permit_number, confirmation_number FROM submissions WHERE project_id = ?", [projectId])) {
      if ((s(x.permit_type) === "nem") !== nem) continue;
      const numbered = !!(s(x.application_number).trim() || s(x.permit_number).trim() || s(x.confirmation_number).trim());
      if (s(x.status) !== "failed" || numbered) { hard.push(`a submission on this side is ${s(x.status) || "of unknown status"}${numbered ? " with a number" : ""}`); break; }
    }
    for (const x of db.query<Row>("SELECT permit_type, status, confirmation_number FROM portal_runs WHERE project_id = ?", [projectId])) {
      if ((s(x.permit_type) === "nem") !== nem) continue;
      const numbered = s(x.confirmation_number).trim() !== "";
      if (numbered || !["queued", "running", "failed"].includes(s(x.status))) { hard.push(`a portal run on this side ${numbered ? "recorded a confirmation number" : `is ${s(x.status) || "of unknown status"}`}`); break; }
    }
    for (const d of db.query<Row>("SELECT details FROM audit_logs WHERE project_id = ? AND action = 'portal.draft_created'", [projectId])) {
      if (rowOnSide(parse<Row>(d.details, {}), side)) { hard.push("a draft of this project is on record on this side"); break; }
    }
    const interrupted = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM job_queue WHERE project_id = ? AND job_type IN ('prepare_submission', 'autopilot') AND status = 'failed' AND error LIKE 'portal run was interrupted%'",
      [projectId]);
    if (Number(interrupted?.n ?? 0) > 0) hard.push("a staging run of this project was interrupted mid-flight");
    // LEARN history, in write order (rowid), after the latest allowance on this side.
    const rows = db.query<{ rid: number; action: string; details: string; created_at: string }>(
      `SELECT rowid AS rid, action, details, created_at FROM audit_logs WHERE project_id = ? AND action IN
        (?, ?, ?, ?, 'portal.auto_learned_trusted', 'portal.auto_learned_draft', 'portal.auto_learn_paused', 'portal.draft_continued',
         'portal.auto_learn_failed', 'portal.replay_selftest_passed', 'portal.replay_selftest_failed', 'portal.recipe_human_patch_started')
       ORDER BY rowid`,
      [projectId, ACT_LEARN_STARTED, ACT_LEARN_CLEAN, ACT_PASSED, ACT_ALLOWED_AGAIN]);
    const parsed = rows.map((r) => ({ rid: Number(r.rid), action: s(r.action), d: parse<Row>(r.details, {}), at: s(r.created_at).slice(0, 10) }));
    const allowedAt = Math.max(0, ...parsed.filter((r) => r.action === ACT_ALLOWED_AGAIN && sideOf(r.d.scope) === side).map((r) => r.rid));
    const clean = new Set(parsed.filter((r) => r.action === ACT_LEARN_CLEAN).map((r) => s(r.d.startId)).filter(Boolean));
    for (const r of parsed) {
      if (r.rid <= allowedAt || r.action === ACT_ALLOWED_AGAIN || r.action === ACT_LEARN_CLEAN || !rowOnSide(r.d, side)) continue;
      if (r.action === ACT_PASSED) learn.push(`an earlier run of this project passed a verified information page (${r.at})`);
      else if (r.action === ACT_LEARN_STARTED) { if (!clean.has(s(r.d.startId))) learn.push(`an earlier learn of this project did not end held, untouched, at an information page — it may have entered data (${r.at})`); }
      else if (r.action === "portal.auto_learn_failed") { if (s(r.d.reason)) learn.push(`an earlier learn of this project ${s(r.d.reason) === "no_review" ? "filled fields" : "reached a review-like screen"} (${r.at})`); }
      else learn.push(`an earlier learn of this project: ${r.action.replace(/^portal\./, "").replace(/_/g, " ")} (${r.at})`);
    }
  } catch {
    hard.push("this project's progress on this portal could not be read");
  }
  return { hard: Array.from(new Set(hard)), learn: Array.from(new Set(learn)) };
}

/**
 * HAS THIS PROJECT ALREADY MADE PROGRESS ON THIS PORTAL? true refuses the pass (the learner's
 * INFO_PAGE_PRIOR_PROGRESS_REFUSAL). Every reason of infoPagePriorProgressReasons counts; an
 * unparseable portal URL or a read error is true: an unknown never reassures.
 */
export function infoPagePriorProgress(db: AppDb, projectId: string, portalUrl: string, scopeType: Side): boolean {
  try { const o = new URL(portalUrl).origin; if (!o || o === "null") return true; } catch { return true; }
  const r = infoPagePriorProgressReasons(db, projectId, scopeType);
  return r.hard.length > 0 || r.learn.length > 0;
}

/** What the project's card shows per side (round 2): the verified pages this project passed or was
 *  held at since the latest allowance, why later runs stop there, and whether a person may allow
 *  the pass once more (only when nothing HARD stands in the way). Reads only. */
export function listInfoPageProjectState(db: AppDb, projectId: string): InfoPageProjectSideState[] {
  const out: InfoPageProjectSideState[] = [];
  const rows = db.query<{ rid: number; action: string; details: string; created_at: string }>(
    "SELECT rowid AS rid, action, details, created_at FROM audit_logs WHERE project_id = ? AND action IN (?, ?, ?) ORDER BY rowid",
    [projectId, ACT_PASSED, ACT_HELD_VERIFIED, ACT_ALLOWED_AGAIN]);
  for (const side of ["ahj", "utility"] as const) {
    const parsed = rows.map((r) => ({ rid: Number(r.rid), action: s(r.action), d: parse<Row>(r.details, {}), at: s(r.created_at) }));
    const allowed = parsed.filter((r) => r.action === ACT_ALLOWED_AGAIN && sideOf(r.d.scope) === side);
    const last = allowed.length ? allowed[allowed.length - 1] : null;
    const since = parsed.filter((r) => r.rid > (last?.rid ?? 0) && r.action !== ACT_ALLOWED_AGAIN && rowOnSide(r.d, side));
    if (!since.length) continue;
    const reasons = infoPagePriorProgressReasons(db, projectId, side);
    out.push({
      scope: side,
      passed: since.filter((r) => r.action === ACT_PASSED).map((r) => ({ passId: s(r.d.passId), where: s(r.d.where), at: r.at })).slice(-5),
      held: since.filter((r) => r.action === ACT_HELD_VERIFIED).map((r) => ({ passId: s(r.d.passId), where: s(r.d.where), at: r.at })).slice(-5),
      hard: reasons.hard,
      learn: reasons.learn,
      canAllow: reasons.hard.length === 0 && reasons.learn.length > 0,
      lastAllowedBy: last ? s(last.d.by) : "",
      lastAllowedAt: last ? last.at : "",
    });
  }
  return out;
}

/**
 * "ALLOW ONCE MORE FOR THIS PROJECT" (round 2): a NAMED PERSON who checked this project's application
 * on the portal lifts its LEARN history on one side — the next run may pass a verified page once
 * more; after that it stops there again. THE ONLY WRITER of ACT_ALLOWED_AGAIN (the source scan pins
 * it). Refused (409) unless a verified page was passed or held on this side since the last allowance
 * and nothing HARD stands in the way (a filing, a number, a draft, a paused / interrupted / staged run).
 */
export function allowInfoPagePassOnceMore(db: AppDb, projectId: string, scope: string, input: { by: string; userId: string }): void {
  const side = sideOf(scope);
  if (!side) throw new HttpError(400, "scope must be \"ahj\" or \"utility\".");
  db.transaction(() => {
    const state = listInfoPageProjectState(db, projectId).find((x) => x.scope === side);
    if (!state) throw new HttpError(409, "No verified information page was passed or held for this project on this side since it was last allowed.");
    if (state.hard.length) throw new HttpError(409, `This project cannot be allowed again here: ${state.hard.join("; ")}. Do that page by hand.`, { refusals: state.hard });
    if (!state.learn.length) throw new HttpError(409, "Nothing stands in the way: the next run may already pass the page.");
    addAuditLog(db, projectId, "human", input.by, ACT_ALLOWED_AGAIN, { scope: side, by: input.by, byUserId: input.userId, lifted: state.learn.slice(0, 8) });
  });
}

// ---------------------------------------------------------------------------------------------
// Candidates (project-scoped evidence)
// ---------------------------------------------------------------------------------------------

/** A capture the bot handed back, checked before anything is written (the bot is trusted, its
 *  page is not: everything is re-validated for shape). null = unusable. */
function validCapture(c: InfoPageCandidateCapture | null | undefined): (InfoPageCandidateCapture & { digest: InfoPageDigest }) | null {
  if (!c || typeof c !== "object") return null;
  const d = c.digest as InfoPageDigest | undefined;
  if (!d || typeof d !== "object" || !HEX64.test(s(c.identitySha256)) || d.identitySha256 !== c.identitySha256) return null;
  if (typeof c.identityVersion !== "number" || !Number.isFinite(c.identityVersion)) return null;
  if (!s(c.origin) || !s(c.path) || !Array.isArray(c.prefix)) return null;
  return c as InfoPageCandidateCapture & { digest: InfoPageDigest };
}

/**
 * RECORD A HELD, UNVERIFIED INFORMATION PAGE for this project (autoLearn finalize; one transaction).
 * An open or dismissed row for the same identity is bumped (last seen, count, learn run; an OPEN row
 * also takes the new screenshot) — a dismissed page never re-nags. Otherwise a new open row (a first
 * sighting, or a page whose pass was withdrawn). A verified row is never touched.
 */
export function recordInfoPageCandidate(db: AppDb, projectId: string, learnRunId: string, capture: InfoPageCandidateCapture | null | undefined): { id: string; status: "open" | "dismissed"; inserted: boolean; decidedBy: string; decidedAt: string } | null {
  const c = validCapture(capture);
  if (!c) return null;
  const shot = c.screenshotBase64 ? Buffer.from(String(c.screenshotBase64), "base64") : null;
  const at = nowIso();
  return db.transaction(() => {
    const existing = db.get<Row>(
      "SELECT id, status, decided_by, decided_at FROM portal_info_page_candidates WHERE project_id = ? AND identity_sha256 = ? AND status <> 'verified'",
      [projectId, c.identitySha256]);
    if (existing) {
      const open = s(existing.status) === "open";
      if (open && shot && shot.length) {
        db.run("UPDATE portal_info_page_candidates SET last_seen_at = ?, seen_count = seen_count + 1, learn_run_id = ?, screenshot_png = ?, observed_json = CASE WHEN ? <> 'null' THEN ? ELSE observed_json END WHERE id = ?",
          [at, learnRunId, shot, JSON.stringify(c.observed ?? null), JSON.stringify(c.observed ?? null), s(existing.id)]);
      } else {
        db.run("UPDATE portal_info_page_candidates SET last_seen_at = ?, seen_count = seen_count + 1, learn_run_id = ? WHERE id = ?", [at, learnRunId, s(existing.id)]);
      }
      return { id: s(existing.id), status: open ? "open" as const : "dismissed" as const, inserted: false, decidedBy: s(existing.decided_by), decidedAt: s(existing.decided_at) };
    }
    const cid = newId();
    db.run(
      `INSERT INTO portal_info_page_candidates
        (id, project_id, learn_run_id, first_seen_at, last_seen_at, seen_count, origin, path, identity_version, identity_sha256,
         digest_json, prefix_json, evidence_json, observed_json, screenshot_png, status)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
      [cid, projectId, learnRunId, at, at, s(c.origin), s(c.path), c.identityVersion, c.identitySha256,
        JSON.stringify(c.digest), JSON.stringify(c.prefix), JSON.stringify(c.evidence ?? {}), JSON.stringify(c.observed ?? null), shot && shot.length ? shot : null],
    );
    return { id: cid, status: "open" as const, inserted: true, decidedBy: "", decidedAt: "" };
  });
}

/** The project's own values, read from its row (street, homeowner, parcel, system size). */
function projectValues(db: AppDb, projectId: string): string[] {
  const p = db.get<Row>("SELECT homeowner_name, project_address, system_size_dc_kw, parser_json FROM projects WHERE id = ?", [projectId]);
  if (!p) return [];
  const parser = parse<Row>(p.parser_json, {});
  const kw = Number(p.system_size_dc_kw);
  return [s(p.project_address).split(",")[0].trim(), s(p.homeowner_name).trim(), s(parser.apn).trim(), Number.isFinite(kw) && kw > 0 ? `${kw} kW` : ""]
    .filter((v) => v.length >= 4);
}

const prefixShapeRefusals = (prefix: InfoPagePrefixStep[]): string[] => {
  const out: string[] = [];
  prefix.forEach((st, i) => {
    const [action, note, place] = [s(st?.[0]), s(st?.[1]), s(st?.[2])];
    const ok = action === "goto" || action === "waitFor" || (action === "click" && /^(application entry|permit type):/.test(note))
      || (action === "click" && /^advance:/.test(note) && place === "admitted");
    if (!ok) out.push(`step ${i + 1} before the page (${action} "${note.slice(0, 40)}") is not an entry click`);
  });
  return out;
};

/** Every reason "OK to advance" is refused for this candidate ROW (verify and the card both ask). */
function candidateRefusals(db: AppDb, r: Row): string[] {
  const out: string[] = [];
  const digest = parse<InfoPageDigest | null>(r.digest_json, null);
  const observed = parse<InfoPageObservedRequest | null>(r.observed_json, null);
  const evidence = parse<InfoPageEvidence | null>(r.evidence_json, null);
  const prefix = parse<InfoPagePrefixStep[]>(r.prefix_json, []);
  if (s(r.status) !== "open") out.push(`the candidate is ${s(r.status)}, not open`);
  if (!r.screenshot_png) out.push("there is no screenshot of the page — re-run the learn so a person can see what they verify");
  if (Number(r.identity_version) !== INFO_PAGE_IDENTITY_VERSION) out.push(`the page was read with identity version ${s(r.identity_version)}, not ${INFO_PAGE_IDENTITY_VERSION} — re-run the learn`);
  if (!digest || digest.identitySha256 !== s(r.identity_sha256)) out.push("the page's identity is unreadable");
  else {
    out.push(...infoPageShapeRefusals(digest.shape));
    if (!observed) out.push("the backstop did not observe the page's forward request — nothing was held to verify");
    else {
      if (observed.body === null) out.push("the held request's body could not be read");
      if (observed.hasFilenamePart) out.push("the held request carried a file");
      const req = infoPageRequestRefusals(digest.expected, observed);
      for (const x of req) out.push(`the held request is not what the page's control sends: ${x}`);
    }
    if (isFilingOrPaymentRequest("POST", digest.expected.where) || isPayRequestUrl(digest.expected.where)) out.push("the request goes to a filing or payment URL");
  }
  out.push(...prefixShapeRefusals(prefix));
  out.push(...infoPageProjectValueRefusals(s(evidence?.text), projectValues(db, s(r.project_id))));
  const existing = db.get<Row>("SELECT id FROM portal_info_page_passes WHERE identity_sha256 = ?", [s(r.identity_sha256)]);
  if (existing) out.push("a pass for this exact page already exists (withdraw it first to verify again)");
  return Array.from(new Set(out));
}

const candidateRowToRecord = (db: AppDb, r: Row): InfoPageCandidateRecord => {
  const digest = parse<InfoPageDigest | null>(r.digest_json, null);
  const evidence = parse<InfoPageEvidence>(r.evidence_json, { title: "", headings: [], forms: [], frames: [], controlLabels: [], text: "" });
  return {
    id: s(r.id),
    projectId: s(r.project_id),
    learnRunId: s(r.learn_run_id),
    firstSeenAt: s(r.first_seen_at),
    lastSeenAt: s(r.last_seen_at),
    seenCount: Number(r.seen_count) || 1,
    origin: s(r.origin),
    path: s(r.path),
    queryKeys: digest ? digest.queryKeys : [],
    identityVersion: Number(r.identity_version),
    identitySha256: s(r.identity_sha256),
    controlLabel: digest ? digest.control.label : "",
    controlName: digest ? digest.control.name : "",
    request: digest ? { method: digest.expected.method, where: digest.expected.where, media: digest.expected.media, fieldNames: digest.expected.body.map(([n]) => n) } : { method: "", where: "", media: "", fieldNames: [] },
    steps: parse<InfoPagePrefixStep[]>(r.prefix_json, []).map(([action, note, place]) => (s(action) === "goto" ? `go to ${s(place) || "the entry page"}` : s(note) || s(action))),
    evidence,
    hasScreenshot: !!r.screenshot_png,
    status: (s(r.status) as InfoPageCandidateRecord["status"]) || "open",
    decidedBy: s(r.decided_by),
    decidedAt: s(r.decided_at),
    passId: s(r.pass_id),
    passLive: s(r.status) === "verified" && !!s(r.pass_id) && !!db.get<Row>("SELECT id FROM portal_info_page_passes WHERE id = ?", [s(r.pass_id)]),
    refusals: s(r.status) === "open" ? candidateRefusals(db, r) : [],
    warnings: infoPageVerifyWarnings(digest ? digest.shape : null, evidence.text),
  };
};

/** The project's candidates for the card (never screenshot bytes). Reads only. */
export function listInfoPageCandidates(db: AppDb, projectId: string): InfoPageCandidateRecord[] {
  const rows = db.query<Row>(
    "SELECT * FROM portal_info_page_candidates WHERE project_id = ? ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'dismissed' THEN 1 ELSE 2 END, last_seen_at DESC LIMIT 50",
    [projectId]);
  return rows.map((r) => candidateRowToRecord(db, r));
}

/** The masked screenshot of THIS project's candidate, or null. */
export function infoPageCandidateScreenshot(db: AppDb, projectId: string, candidateId: string): Buffer | null {
  const r = db.get<{ screenshot_png: Buffer | null }>("SELECT screenshot_png FROM portal_info_page_candidates WHERE id = ? AND project_id = ?", [candidateId, projectId]);
  return r && r.screenshot_png && r.screenshot_png.length ? Buffer.from(r.screenshot_png) : null;
}

// ---------------------------------------------------------------------------------------------
// The record: ONE create (a person's verify), ONE delete (every withdrawal), no update
// ---------------------------------------------------------------------------------------------

/**
 * A NAMED PERSON VERIFIES the candidate: "This is an information page — OK to advance". One
 * transaction. THE ONLY WRITER THAT CREATES A PASS: the row is built ONLY from the candidate ROW
 * (verifiedInfoPageFromCandidate); the body names only which card the person looked at (its
 * identity), never what to write. The candidate is stamped verified with this pass's id, by the
 * same person at the same time — the record liveInfoPagePasses requires before a run may use it.
 */
export function verifyInfoPageCandidate(
  db: AppDb, projectId: string, candidateId: string,
  input: { identitySha256: string; verifiedBy: string; userId: string },
): { passId: string } {
  return db.transaction(() => {
    const r = db.get<Row>("SELECT * FROM portal_info_page_candidates WHERE id = ? AND project_id = ?", [candidateId, projectId]);
    if (!r) throw new HttpError(404, "Information page candidate not found.");
    const refusals: string[] = [];
    if (!HEX64.test(s(input.identitySha256)) || s(input.identitySha256) !== s(r.identity_sha256)) refusals.push("the card you verified is not the page on record (it changed): reload and look again");
    refusals.push(...candidateRefusals(db, r));
    if (refusals.length) throw new HttpError(409, `This page cannot be verified: ${refusals.join("; ")}`, { refusals });
    const digest = parse<InfoPageDigest>(r.digest_json, null as unknown as InfoPageDigest);
    const prefix = parse<InfoPagePrefixStep[]>(r.prefix_json, []);
    const pass = verifiedInfoPageFromCandidate({ identityVersion: Number(r.identity_version), identitySha256: s(r.identity_sha256), digest, prefix });
    const passId = newId();
    const at = nowIso();
    const summary = { forms: digest.summary.forms, fillable: digest.summary.fillable, frames: digest.summary.frames, hiddenNames: digest.summary.hiddenNames, headings: digest.summary.headings };
    db.run(
      `INSERT INTO portal_info_page_passes
        (id, origin, path, query_keys_json, identity_version, identity_sha256, page_sha256, title_sha256, structure_sha256, text_sha256,
         control_sha256, request_sha256, control_label, control_name, control_tag, control_type, request_method, request_where,
         request_action_sha256, request_media, request_body_json, prefix_json, summary_json, verified_at, verified_by, verified_by_user_id, source_candidate_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [passId, pass.origin, pass.path, JSON.stringify(pass.queryKeys), pass.identityVersion, pass.identitySha256,
        pass.components.pageSha, pass.components.titleSha, pass.components.structureSha, pass.components.textSha, pass.components.controlSha, pass.components.requestSha,
        pass.controlLabel, pass.controlName, pass.controlTag, pass.controlType, pass.request.method, pass.request.where, pass.request.actionSha256, pass.request.media,
        JSON.stringify(pass.request.body), JSON.stringify(pass.prefix), JSON.stringify(summary), at, input.verifiedBy, input.userId, candidateId],
    );
    db.run("UPDATE portal_info_page_candidates SET status = 'verified', decided_by = ?, decided_by_user_id = ?, decided_at = ?, pass_id = ? WHERE id = ?",
      [input.verifiedBy, input.userId, at, passId, candidateId]);
    addAuditLog(db, projectId, "human", input.verifiedBy, "portal.info_page_verified", {
      passId, candidateId, origin: pass.origin, path: pass.path, controlLabel: pass.controlLabel, controlName: pass.controlName,
      request: { method: pass.request.method, where: pass.request.where, media: pass.request.media, fieldNames: pass.request.body.map(([n]) => n) },
      prefix: pass.prefix.map(([a, n]) => `${a}${n ? ` ${n}` : ""}`),
      identitySha256Prefix: pass.identitySha256.slice(0, 12),
    });
    return { passId };
  });
}

/** What the audit keeps of a withdrawn pass (the row is gone): places, names and dates — never a
 *  hash of a value or the verifier (the withdrawal row may carry no project). */
const passHistory = (r: Row): Record<string, unknown> => ({
  origin: s(r.origin), path: s(r.path), controlLabel: s(r.control_label), controlName: s(r.control_name),
  request: { method: s(r.request_method), where: s(r.request_where), media: s(r.request_media), fieldNames: parse<Array<[string, string]>>(r.request_body_json, []).map(([n]) => n) },
  identitySha256Prefix: s(r.identity_sha256).slice(0, 12), verifiedAt: s(r.verified_at), sourceCandidateId: s(r.source_candidate_id),
});

/** THE ONE DELETE of a pass (every withdrawal goes through here), with its audit row. A run already
 *  in flight keeps the entries it started with (they are frozen per run). */
function removeInfoPagePass(db: AppDb, r: Row, audit: { projectId: string | null; actorType: "human" | "system" | "portal_bot"; actor: string; action: string; details: Record<string, unknown> }): void {
  db.run("DELETE FROM portal_info_page_passes WHERE id = ?", [s(r.id)]);
  addAuditLog(db, audit.projectId, audit.actorType, audit.actor, audit.action, { passId: s(r.id), ...audit.details, pass: passHistory(r) });
}

/** "Not an information page": the card leaves the open list and a re-capture never re-nags. */
export function dismissInfoPageCandidate(db: AppDb, projectId: string, candidateId: string, input: { dismissedBy: string; userId: string }): void {
  db.transaction(() => {
    const r = db.get<Row>("SELECT id, status, origin, path FROM portal_info_page_candidates WHERE id = ? AND project_id = ?", [candidateId, projectId]);
    if (!r) throw new HttpError(404, "Information page candidate not found.");
    if (s(r.status) !== "open") throw new HttpError(409, `This candidate is already ${s(r.status)}.`);
    db.run("UPDATE portal_info_page_candidates SET status = 'dismissed', decided_by = ?, decided_by_user_id = ?, decided_at = ? WHERE id = ?",
      [input.dismissedBy, input.userId, nowIso(), candidateId]);
    addAuditLog(db, projectId, "human", input.dismissedBy, "portal.info_page_candidate_dismissed", { candidateId, origin: s(r.origin), path: s(r.path) });
  });
}

/** A PERSON WITHDRAWS a pass: the row is deleted (the audit keeps its history). Runs that start
 *  after this no longer receive it; a run already in flight keeps the pass it started with. */
export function withdrawInfoPagePass(db: AppDb, passId: string, input: { by: string; userId: string; reason: string }): void {
  db.transaction(() => {
    const r = db.get<Row>("SELECT * FROM portal_info_page_passes WHERE id = ?", [passId]);
    if (!r) throw new HttpError(404, "Verified information page not found.");
    removeInfoPagePass(db, r, { projectId: null, actorType: "human", actor: input.by, action: "portal.info_page_pass_withdrawn", details: { reason: input.reason, byUserId: input.userId } });
  });
}

/**
 * AN INCIDENT A RUN REPORTED ON A PASS (proposal §4), audited on the run's project and the pass
 * WITHDRAWN (deleted):
 *   - before the click: the page at the pass's host + path read differently (signature, control,
 *     the steps before it, or the request) — the backstop held the click exactly as on main and the
 *     new page was recorded as a fresh candidate;
 *   - after the click: the page the verified click led to did not read as "not filed" (a receipt,
 *     a confirmation number, a filed status, the review page, an error, no form, unreadable) — the
 *     run stopped and nothing is recorded as filed.
 * A pass already gone is audited all the same (withdrawn: false).
 *
 * ROUND 3 — AN AFTER-CLICK INCIDENT MEANS THE VERIFIED PAGE MAY HAVE FILED: the page it led to was a
 * receipt-like page, or the run entered none of the job's data there (proof of progress), or the
 * learn died before it was judged. Every project that USED this pass (the use ledger, ACT_PASSED) —
 * and the incident's own — gets a may-have-filed row: the warning on its card ("The verified page may
 * have filed — check the portal for this project") and, named within the viewer's own org, on the
 * pass's knowledge-base entry. Before-click incidents sent nothing: no warning.
 */
export function recordInfoPagePassIncidents(db: AppDb, projectId: string | null, runId: string, incidents: ReadonlyArray<InfoPageIncident> | null | undefined): { withdrawn: string[]; warned: string[]; warnError: string } {
  const withdrawn: string[] = [];
  const warned: string[] = [];
  let warnError = "";
  for (const inc of Array.isArray(incidents) ? incidents : []) {
    const passId = s(inc?.passId).slice(0, 80);
    const phase = inc?.phase === "after" ? "after" : "before";
    const why = (Array.isArray(inc?.why) ? inc.why as unknown[] : []).map((w: unknown) => s(w).slice(0, 240)).slice(0, 8);
    if (!passId) continue;
    // THE WITHDRAWAL FIRST, in its own transaction: nothing the warning below reads or writes can
    // keep a pass live after an incident (evidence never blocks the removal of authority).
    let where = s(inc?.where).slice(0, 200);
    let controlLabel = "";
    db.transaction(() => {
      const r = db.get<Row>("SELECT * FROM portal_info_page_passes WHERE id = ?", [passId]);
      const details = { phase, why, runId: s(runId).slice(0, 120), where };
      if (r) {
        if (!where) where = `${s(r.origin)}${s(r.path)}`;
        controlLabel = s(r.control_label);
        removeInfoPagePass(db, r, { projectId, actorType: "portal_bot", actor: "network backstop", action: "portal.info_page_pass_incident", details: { ...details, withdrawn: true } });
        withdrawn.push(passId);
      } else {
        addAuditLog(db, projectId, "portal_bot", "network backstop", "portal.info_page_pass_incident", { passId, ...details, withdrawn: false });
      }
    });
    if (phase !== "after") continue;
    // THEN THE WARNING (best effort, reported, never undoing the withdrawal): every project in the
    // pass's use ledger — read in JS, so one malformed audit row cannot fail the query — and the
    // incident's own. Only the incident's own row carries the run id.
    try {
      const users = new Set<string>();
      db.transaction(() => {
        for (const u of db.query<{ project_id: string; details: string }>("SELECT project_id, details FROM audit_logs WHERE action = ? AND project_id IS NOT NULL", [ACT_PASSED])) {
          if (s(parse<Row>(u.details, {}).passId) === passId && s(u.project_id)) users.add(s(u.project_id));
        }
        if (projectId) users.add(projectId);
        for (const pid of users) addAuditLog(db, pid, "portal_bot", "network backstop", ACT_MAY_HAVE_FILED, { passId, where, controlLabel, why, ...(pid === projectId ? { runId: s(runId).slice(0, 120) } : {}) });
      });
      warned.push(...users);
    } catch (err) {
      warnError = `the may-have-filed warning could not be written (${err instanceof Error ? err.message.slice(0, 100) : String(err).slice(0, 100)})`;
    }
  }
  return { withdrawn, warned: Array.from(new Set(warned)), warnError };
}

/** THE WARNING ON A PROJECT'S CARD (round 3): every after-click incident on a pass this project used
 *  — the verified page may have filed for it. Newest first. Reads only. */
export function listInfoPageFilingWarnings(db: AppDb, projectId: string): InfoPageFilingWarning[] {
  return db.query<{ details: string; created_at: string }>(
    "SELECT details, created_at FROM audit_logs WHERE project_id = ? AND action = ? ORDER BY rowid DESC LIMIT 20", [projectId, ACT_MAY_HAVE_FILED])
    .map((r) => {
      const d = parse<Row>(r.details, {});
      return { passId: s(d.passId), where: s(d.where), controlLabel: s(d.controlLabel), at: s(r.created_at), why: (Array.isArray(d.why) ? d.why as unknown[] : []).map((w) => s(w)).slice(0, 4) };
    });
}

/**
 * THE WARNING ON THE PASS'S KNOWLEDGE-BASE ENTRY (round 3): each pass an after-click incident
 * withdrew, with every project that used it NAMED — only the projects inside `orgId` (null = every
 * org: the superadmin). The pass itself is shared knowledge; which projects used it is tenant data,
 * so another org's project is never named or counted here (rule 6). Newest first. Reads only.
 */
export function listInfoPagePassFilingWarnings(db: AppDb, orgId: string | null): InfoPagePassFilingWarning[] {
  const rows = db.query<{ project_id: string; details: string; created_at: string; pid: string | null; homeowner_name: string | null; project_address: string | null; org_id: string | null }>(
    `SELECT a.project_id, a.details, a.created_at, p.id AS pid, p.homeowner_name, p.project_address, p.org_id
       FROM audit_logs a LEFT JOIN projects p ON p.id = a.project_id
      WHERE a.action = ? ORDER BY a.rowid DESC LIMIT 500`, [ACT_MAY_HAVE_FILED]);
  const byPass = new Map<string, InfoPagePassFilingWarning>();
  for (const r of rows) {
    const d = parse<Row>(r.details, {});
    const passId = s(d.passId);
    if (!passId) continue;
    let w = byPass.get(passId);
    if (!w) { w = { passId, where: s(d.where), controlLabel: s(d.controlLabel), at: s(r.created_at), projects: [] }; byPass.set(passId, w); }
    // A deleted project is named nowhere; a project with no org row belongs to the default tenant
    // (scope.assertInScope's rule).
    if (!r.project_id || !r.pid) continue;
    if (orgId !== null && (s(r.org_id) || DEFAULT_ORG_ID) !== orgId) continue;
    if (w.projects.some((p) => p.id === s(r.project_id))) continue;
    w.projects.push({ id: s(r.project_id), name: s(r.homeowner_name), address: s(r.project_address).split(",")[0].trim() });
  }
  return Array.from(byPass.values()).slice(0, 50);
}

/** THE PROJECT IS BEING DELETED (repository.deleteProject, inside its transaction): its candidates
 *  go with it (tenant evidence), and every pass a person verified on one of them is withdrawn — a
 *  pass is authority only while the verification it came from is on record. */
export function deleteProjectInfoPages(db: AppDb, projectId: string): void {
  const verified = db.query<Row>("SELECT id, pass_id FROM portal_info_page_candidates WHERE project_id = ? AND status = 'verified' AND pass_id <> ''", [projectId]);
  for (const c of verified) {
    const r = db.get<Row>("SELECT * FROM portal_info_page_passes WHERE id = ? AND source_candidate_id = ?", [s(c.pass_id), s(c.id)]);
    if (r) removeInfoPagePass(db, r, { projectId: null, actorType: "system", actor: "project deletion", action: "portal.info_page_pass_withdrawn", details: { reason: "the project it was verified on was deleted" } });
  }
  db.run("DELETE FROM portal_info_page_candidates WHERE project_id = ?", [projectId]);
}

/** The shared list (critique [5]): places, names and dates only — no component or value hash, no
 *  verifier, no project. `live` = a person's verification on record (what a run receives). */
export function listInfoPagePasses(db: AppDb): InfoPagePassRecord[] {
  return db.query<Row>("SELECT * FROM portal_info_page_passes ORDER BY verified_at DESC LIMIT 200").map((r) => ({
    id: s(r.id),
    origin: s(r.origin),
    path: s(r.path),
    queryKeys: parse<string[]>(r.query_keys_json, []),
    controlLabel: s(r.control_label),
    controlName: s(r.control_name),
    request: { method: s(r.request_method), where: s(r.request_where), media: s(r.request_media), fieldNames: parse<Array<[string, string]>>(r.request_body_json, []).map(([n]) => n) },
    identityPrefix: s(r.identity_sha256).slice(0, 12),
    verifiedAt: s(r.verified_at),
    live: Number(r.identity_version) === INFO_PAGE_IDENTITY_VERSION && passIsOnRecord(db, r),
  }));
}

/** Every use of the relaxation is on record: one audit row per admission, written the moment the
 *  learner reports it (autoLearn's onInfoPagePassed), with its side — and every later run of this
 *  project on that side counts it as progress (a pass admits at most once per project and side). A
 *  write that fails throws: the caller's own counter and the unclean learn start still refuse. */
export function recordInfoPagePassUses(db: AppDb, projectId: string, runId: string, scope: Side, passed: ReadonlyArray<{ passId: string; where: string }> | null | undefined): void {
  for (const p of Array.isArray(passed) ? passed : []) {
    addAuditLog(db, projectId, "portal_bot", "network backstop", ACT_PASSED, { runId, scope, passId: s(p.passId), where: s(p.where).slice(0, 200) });
  }
}
