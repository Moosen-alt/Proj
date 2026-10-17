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
import { trackKind } from "./permitMonitor";
import { isInformationalPageUrl, isUtilityPlatformUrl, portalHostOf, portalUrlsInText } from "./portalChannel";
import { sameUtilityEntity } from "./utilityIdentity";
import { sameEntity } from "./portalRecipes";
import { addAuditLog } from "./audit";
import { HttpError } from "./httpError";
import { id as newId } from "./ids";
import { nowIso } from "./time";
import {
  INFO_PAGE_IDENTITY_VERSION, infoPagePassExpiryRefusals, infoPageProjectValueRefusals, infoPageRequestRefusals, infoPageShapeRefusals, infoPageVerifyWarnings,
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
 *  version, and (round 4) NOT EXPIRED — within INFO_PAGE_PASS_MAX_AGE_DAYS of the verification and
 *  under INFO_PAGE_PASS_MAX_PROJECTS distinct projects in the use ledger (shared
 *  infoPagePassExpiryRefusals; an unreadable ledger is expired). The bot input (autoLearn) and the KB
 *  list both read it. Reads only. */
export function liveInfoPagePasses(db: AppDb, nowMs: number = Date.now()): VerifiedInfoPage[] {
  const rows = db.query<Row>(
    `SELECT * FROM portal_info_page_passes
      WHERE verified_at <> '' AND verified_by <> '' AND identity_version = ?
      ORDER BY verified_at`, [INFO_PAGE_IDENTITY_VERSION]);
  const uses = infoPagePassUseCounts(db);
  return rows.filter((r) => passIsOnRecord(db, r))
    .filter((r) => infoPagePassExpiryRefusals(s(r.verified_at), uses ? uses.get(s(r.id)) ?? 0 : null, nowMs).length === 0)
    .map(passRowToVerified);
}

/** ROUND 4 — HOW MANY DISTINCT PROJECTS EACH PASS ADMITTED: the use ledger (ACT_PASSED, one row per
 *  admission, written the moment the learner reports it), plus the uses a deleted project left behind
 *  (ACT_USE_RETAINED — deleting a project deletes its audit rows, and must never hand a pass a use
 *  back). Read in JS (a malformed row names no pass). null = unreadable (the caller fails closed).
 *  Reads only. */
function infoPagePassUseCounts(db: AppDb): Map<string, number> | null {
  try {
    const by = new Map<string, Set<string>>();
    for (const u of db.query<{ project_id: string | null; action: string; details: string }>(
      "SELECT project_id, action, details FROM audit_logs WHERE action IN (?, ?)", [ACT_PASSED, ACT_USE_RETAINED])) {
      const d = parse<Row>(u.details, {});
      const passId = s(d.passId);
      const pid = u.action === ACT_PASSED ? s(u.project_id) : s(d.projectId);
      if (!passId || !pid) continue;
      if (!by.has(passId)) by.set(passId, new Set());
      by.get(passId)!.add(pid);
    }
    return new Map(Array.from(by.entries()).map(([k, v]) => [k, v.size]));
  } catch { return null; }
}

/** The use counts, read at most once per caller (a list reads the ledger once, not once per row). */
type UsesOf = () => Map<string, number> | null;
const usesOnce = (db: AppDb): UsesOf => {
  let memo: Map<string, number> | null | undefined;
  return () => (memo === undefined ? (memo = infoPagePassUseCounts(db)) : memo);
};

/** ROUND 4 — why this pass row's verification is no longer authority (empty = within both limits).
 *  Reads only. */
function passExpiry(db: AppDb, r: Row, nowMs: number = Date.now(), usesOf: UsesOf = usesOnce(db)): string[] {
  const uses = usesOf();
  return infoPagePassExpiryRefusals(s(r.verified_at), uses ? uses.get(s(r.id)) ?? 0 : null, nowMs);
}

/** ROUND 4 — the EXPIRED pass for this exact page, if one is on file: why it expired (the card and
 *  the run message say "verification expired — a person re-verifies"). Empty = none, or it is live.
 *  Reads only. */
export function expiredInfoPagePassFor(db: AppDb, identitySha256: string, nowMs: number = Date.now(), usesOf: UsesOf = usesOnce(db)): { passId: string; verifiedAt: string; why: string[] } | null {
  const r = db.get<Row>("SELECT * FROM portal_info_page_passes WHERE identity_sha256 = ?", [s(identitySha256)]);
  if (!r) return null;
  const why = passExpiry(db, r, nowMs, usesOf);
  return why.length ? { passId: s(r.id), verifiedAt: s(r.verified_at), why } : null;
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
 *  for this project (the warning on its card and on the pass's knowledge-base entry). Evidence only.
 *  ROUND 4 (rule 6): the incident's text rides only on rows of projects in the incident project's
 *  org; any other org's project gets a GENERIC row (no text, no names, no counts). */
const ACT_MAY_HAVE_FILED = "portal.info_page_may_have_filed";
/** ROUND 4: a deleted project's uses of a pass, kept project-less so the expiry count never drops
 *  (deleting a project deletes its audit rows). Authority for the count: one writer. */
const ACT_USE_RETAINED = "portal.info_page_pass_use_retained";

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
export function recordInfoPageLearnStart(db: AppDb, projectId: string, scope: Side, attempt: number, portalUrl: string): string {
  const startId = newId();
  // The learn's own portal URL: the project card reads it back (listInfoPageProjectState), so the
  // card judges the same portal the learner's own check did.
  addAuditLog(db, projectId, "system", "auto-learn", ACT_LEARN_STARTED, { startId, scope, attempt, portalUrl: s(portalUrl).slice(0, 300) });
  return startId;
}

/** IS THIS LEARN'S RESULT A CLEAN HOLD? It stopped at the backstop's hold of an information page
 *  whose run state was clean at the click (the candidate watch opens only then — #366: the
 *  project's history may also have refused, which is not this run's own state — and its request
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

/** Whose filing a tracked row is (#365): "utility" or "ahj" only when its columns say so and agree —
 *  trackKind, the one answer, plus a consistency check. A row on the columns' defaults (no
 *  permit_type: legacy rows, raw writes) or with contradictory columns ('nem' + a permit discipline)
 *  cannot say: null, and it counts on both sides. */
function trackedRowSide(t: Row): Side | null {
  const pt = s(t.permit_type).trim().toLowerCase();
  if (trackKind(s(t.target_type), pt) === "nem") return pt === "" || pt === "nem" ? "utility" : null;
  return pt !== "" ? "ahj" : null;
}

/** POSITIVE EVIDENCE THAT THIS UTILITY'S NEM IS FILED ON ITS OWN PLATFORM (#365): its own records —
 *  utility-keyed KB rows of ANY confidence and its utility recipes — name at least one portal, and
 *  every portal they name is a utility interconnection platform (information pages ignored). A
 *  utility that names a city's portal anywhere (a carve-out utility, verified or only seeded: the
 *  operator may have filed it there by hand), any other portal, or nothing at all: false.
 *  WHOSE records: only a STRONG match (a known identity, or the same name) is evidence FOR the
 *  platform; a row that matches only by the fuzzy entity score (portalRecipes.sameEntity) can add
 *  caution — a non-platform portal there counts the number — but never vouches for a platform. */
function utilityFilesOnlyOnInterconnectionPlatform(db: AppDb, state: string, utility: string): boolean {
  if (!utility.trim()) return false;
  const st = state.trim().toUpperCase();
  const norm = (x: string): string => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const inState = (r: Row) => !s(r.state).trim() || s(r.state).trim().toUpperCase() === st;
  const strong = (r: Row) => inState(r) && (sameUtilityEntity(state, s(r.utility), utility) || norm(s(r.utility)) === norm(utility));
  const weak = (r: Row) => !strong(r) && sameEntity(state, utility, s(r.state).trim() || state, s(r.utility));
  const rows: Array<{ r: Row; urls: string[] }> = [
    ...db.query<Row>("SELECT state, utility, portal_url, portal_name FROM permit_utility_knowledge WHERE (ahj IS NULL OR ahj = '') AND utility != ''")
      .map((r) => ({ r, urls: [...portalUrlsInText(s(r.portal_url)), ...portalUrlsInText(s(r.portal_name))] })),
    ...db.query<Row>("SELECT state, utility, portal_url FROM portal_recipes WHERE scope_type = 'utility' AND portal_url IS NOT NULL AND portal_url != ''")
      .map((r) => ({ r, urls: [s(r.portal_url)] })),
  ];
  const portals = (pick: (r: Row) => boolean) => rows.filter((x) => pick(x.r)).flatMap((x) => x.urls)
    .filter((u) => portalHostOf(u) !== "" && !isInformationalPageUrl(u));
  const own = portals(strong);
  if (!own.length || !own.every((u) => isUtilityPlatformUrl(u))) return false;
  return portals(weak).every((u) => isUtilityPlatformUrl(u));
}

/** A TRACKED NUMBER OF THIS PROJECT AS A HARD REASON (#365), or "" — the one answer for the hand-out
 *  (infoPagePriorProgressReasons) and the admission (reserveInfoPagePassUse). A number of the OTHER
 *  side is skipped only when its row positively is that side's, it was not recorded on any portal in
 *  question, and there is positive evidence it was filed elsewhere (see the HARD bullet above). No
 *  readable portal: every number counts. A read error is a reason. */
function trackedNumberHardReason(db: AppDb, projectId: string, side: Side, portalUrls: ReadonlyArray<string>): string {
  try {
    const nem = side === "utility";
    const urls = (Array.isArray(portalUrls) ? portalUrls : []).map((u) => s(u).trim()).filter((u) => portalHostOf(u) !== "");
    const hosts = new Set(urls.map((u) => portalHostOf(u)));
    let elsewhere: boolean | null = null;
    const filedElsewhere = (): boolean => {
      if (elsewhere !== null) return elsewhere;
      elsewhere = false;
      if (!urls.length) return false;
      if (nem) {
        // A permit number on the utility side: permits are never filed on an interconnection platform.
        elsewhere = urls.every((u) => isUtilityPlatformUrl(u));
      } else {
        // A NEM number on the permit side: this utility files only on its own platform.
        const p = db.get<Row>("SELECT state, utility FROM projects WHERE id = ?", [projectId]);
        elsewhere = !!p && utilityFilesOnlyOnInterconnectionPlatform(db, s(p.state), s(p.utility));
      }
      return elsewhere;
    };
    for (const t of db.query<Row>("SELECT application_number, permit_number, target_type, permit_type, portal_url, tracking_url FROM permit_check_targets WHERE project_id = ?", [projectId])) {
      const n = s(t.application_number).trim() || s(t.permit_number).trim();
      if (!n) continue;
      const rowSide = trackedRowSide(t);
      if (rowSide !== null && rowSide !== side) {
        const recordedHere = [portalHostOf(s(t.portal_url)), portalHostOf(s(t.tracking_url))].some((h) => h !== "" && hosts.has(h));
        if (!recordedHere && filedElsewhere()) continue;
      }
      return `a filing of this project is tracked by number (${maskDigits(n).slice(0, 24)})`;
    }
    return "";
  } catch {
    return "this project's tracked filings could not be read";
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
 *   - a tracked application or permit number of this project (trackedNumberHardReason, #365). A
 *     number of the OTHER side is skipped only on POSITIVE evidence that it was filed elsewhere: a
 *     NEM number when this utility's own records (KB rows of any confidence, its recipes) name a
 *     portal and every one is a utility interconnection platform (PowerClerk and kin — never a
 *     city's permit portal); a permit number when every portal in question is such a platform
 *     (permits are never filed there). A row on the columns' defaults or with contradictory columns,
 *     a number recorded on this very host, a utility that names any other portal or none, or no
 *     portal given: it counts, as before. Asked again at the admission on the page the request
 *     actually leaves from (reserveInfoPagePassUse);
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
export function infoPagePriorProgressReasons(db: AppDb, projectId: string, scopeType: Side, portalUrls: ReadonlyArray<string>): PriorProgressReasons {
  const hard: string[] = [];
  const learn: string[] = [];
  const side: Side = scopeType === "utility" ? "utility" : "ahj";
  const nem = side === "utility";
  try {
    const tracked = trackedNumberHardReason(db, projectId, side, portalUrls);
    if (tracked) hard.push(tracked);
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
  const r = infoPagePriorProgressReasons(db, projectId, scopeType, [portalUrl]);
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
    // THE PORTAL(S) IN QUESTION: every verified page this side passed or was held at, and every
    // learn's own portal URL on this side — a number counts unless it is ruled off ALL of them, so
    // the card is never more permissive than the learner's own check (which reads its portal URL).
    // None known: every number counts.
    const portals = [
      ...since.map((r) => s(r.d.where)),
      ...db.query<{ details: string }>("SELECT details FROM audit_logs WHERE project_id = ? AND action = ?", [projectId, ACT_LEARN_STARTED])
        .map((r) => parse<Row>(r.details, {})).filter((d) => rowOnSide(d, side)).map((d) => s(d.portalUrl)),
    ];
    const reasons = infoPagePriorProgressReasons(db, projectId, side, portals);
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
      "SELECT id, status, decided_by, decided_at, evidence_json FROM portal_info_page_candidates WHERE project_id = ? AND identity_sha256 = ? AND status <> 'verified'",
      [projectId, c.identitySha256]);
    if (existing) {
      const open = s(existing.status) === "open";
      if (open && shot && shot.length) {
        db.run("UPDATE portal_info_page_candidates SET last_seen_at = ?, seen_count = seen_count + 1, learn_run_id = ?, screenshot_png = ?, observed_json = CASE WHEN ? <> 'null' THEN ? ELSE observed_json END WHERE id = ?",
          [at, learnRunId, shot, JSON.stringify(c.observed ?? null), JSON.stringify(c.observed ?? null), s(existing.id)]);
      } else {
        db.run("UPDATE portal_info_page_candidates SET last_seen_at = ?, seen_count = seen_count + 1, learn_run_id = ? WHERE id = ?", [at, learnRunId, s(existing.id)]);
      }
      if (open && c.capturedWithHistory === true) {
        const ev = parse<Record<string, unknown>>(existing.evidence_json, {});
        if (ev.capturedWithHistory !== true) db.run("UPDATE portal_info_page_candidates SET evidence_json = ? WHERE id = ?", [JSON.stringify({ ...ev, capturedWithHistory: true }), s(existing.id)]);
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
        JSON.stringify(c.digest), JSON.stringify(c.prefix), JSON.stringify(c.capturedWithHistory === true ? { ...((c.evidence ?? {}) as Record<string, unknown>), capturedWithHistory: true } : (c.evidence ?? {})), JSON.stringify(c.observed ?? null), shot && shot.length ? shot : null],
    );
    return { id: cid, status: "open" as const, inserted: true, decidedBy: "", decidedAt: "" };
  });
}

/** #366: the warning a card captured on a project with history carries. */
export const INFO_PAGE_HISTORY_CAPTURE_WARNING = "Captured on a project that already made progress on this portal: make sure this is the page EVERY project sees at this step — not this project's own resumed or in-progress application.";

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
function candidateRefusals(db: AppDb, r: Row, usesOf: UsesOf = usesOnce(db)): string[] {
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
  // A pass for this exact page refuses a second one — unless its verification EXPIRED (round 4): then
  // this verify is the re-verification, and it replaces the expired row (verifyInfoPageCandidate).
  const existing = db.get<Row>("SELECT * FROM portal_info_page_passes WHERE identity_sha256 = ?", [s(r.identity_sha256)]);
  if (existing && !passExpiry(db, existing, Date.now(), usesOf).length) out.push("a pass for this exact page already exists (withdraw it first to verify again)");
  return Array.from(new Set(out));
}

const candidateRowToRecord = (db: AppDb, r: Row, usesOf: UsesOf = usesOnce(db)): InfoPageCandidateRecord => {
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
    passLive: s(r.status) === "verified" && !!s(r.pass_id) && ((): boolean => {
      const p = db.get<Row>("SELECT * FROM portal_info_page_passes WHERE id = ?", [s(r.pass_id)]);
      return !!p && passExpiry(db, p, Date.now(), usesOf).length === 0;
    })(),
    refusals: s(r.status) === "open" ? candidateRefusals(db, r, usesOf) : [],
    warnings: [
      ...infoPageVerifyWarnings(digest ? digest.shape : null, evidence.text),
      ...((evidence as { capturedWithHistory?: unknown }).capturedWithHistory === true ? [INFO_PAGE_HISTORY_CAPTURE_WARNING] : []),
    ],
    // ROUND 4: this exact page's verification EXPIRED (30 days / 10 projects): the run was held as on
    // main, and a person re-verifies on this card.
    expiredPass: s(r.status) === "open" ? expiredInfoPagePassFor(db, s(r.identity_sha256), Date.now(), usesOf) : null,
  };
};

/** The project's candidates for the card (never screenshot bytes). Reads only. */
export function listInfoPageCandidates(db: AppDb, projectId: string): InfoPageCandidateRecord[] {
  const rows = db.query<Row>(
    "SELECT * FROM portal_info_page_candidates WHERE project_id = ? ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'dismissed' THEN 1 ELSE 2 END, last_seen_at DESC LIMIT 50",
    [projectId]);
  const usesOf = usesOnce(db);
  return rows.map((r) => candidateRowToRecord(db, r, usesOf));
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
    // ROUND 4 — RE-VERIFICATION: a pass for this exact page whose verification EXPIRED (candidateRefusals
    // refused a live one) is withdrawn first, through the one delete, and the new verification replaces it.
    const expired = db.get<Row>("SELECT * FROM portal_info_page_passes WHERE identity_sha256 = ?", [s(r.identity_sha256)]);
    if (expired) {
      removeInfoPagePass(db, expired, { projectId, actorType: "human", actor: input.verifiedBy, action: "portal.info_page_pass_withdrawn",
        details: { reason: "verification expired — re-verified by a person", expired: passExpiry(db, expired).slice(0, 2), byUserId: input.userId } });
    }
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
 *  hash of a value or the verifier (the withdrawal row may carry no project).
 *  RULE 6 (Helm's review of #349): WHICH candidate the pass came from and WHEN a person verified it
 *  belong to the org of the project it was verified on. They ride only on an audit row written on a
 *  project of THAT org; a row on another org's project, on no project, or where either org cannot be
 *  read carries neither (the pass id still links it to the verification's own audit row). */
const passHistory = (db: AppDb, r: Row, auditProjectId: string | null): Record<string, unknown> => {
  let sameOrg = false;
  try {
    const src = db.get<{ project_id: string }>("SELECT project_id FROM portal_info_page_candidates WHERE id = ?", [s(r.source_candidate_id)]);
    const srcOrg = src && s(src.project_id) ? projectOrgOf(db, s(src.project_id)) : null;
    const auditOrg = auditProjectId ? projectOrgOf(db, auditProjectId) : null;
    sameOrg = srcOrg !== null && auditOrg !== null && srcOrg === auditOrg;
  } catch { sameOrg = false; }
  return {
    origin: s(r.origin), path: s(r.path), controlLabel: s(r.control_label), controlName: s(r.control_name),
    request: { method: s(r.request_method), where: s(r.request_where), media: s(r.request_media), fieldNames: parse<Array<[string, string]>>(r.request_body_json, []).map(([n]) => n) },
    identitySha256Prefix: s(r.identity_sha256).slice(0, 12),
    ...(sameOrg ? { verifiedAt: s(r.verified_at), sourceCandidateId: s(r.source_candidate_id) } : {}),
  };
};

/** THE ONE DELETE of a pass (every withdrawal goes through here), with its audit row. A run already
 *  in flight keeps the entries it started with (they are frozen per run). */
function removeInfoPagePass(db: AppDb, r: Row, audit: { projectId: string | null; actorType: "human" | "system" | "portal_bot"; actor: string; action: string; details: Record<string, unknown> }): void {
  // The history is read BEFORE the delete (it looks up the source candidate's project).
  const history = passHistory(db, r, audit.projectId);
  db.run("DELETE FROM portal_info_page_passes WHERE id = ?", [s(r.id)]);
  addAuditLog(db, audit.projectId, audit.actorType, audit.actor, audit.action, { passId: s(r.id), ...audit.details, pass: history });
}

/** HELM'S REVIEW OF #349 — A NAMED PERSON, NOT AN AGENT: the extra test an information-page decision's
 *  name must pass on top of feeConfirm.isConfirmingPerson (server.ts infoPagePerson asks both). At
 *  least three letters, and never an agent's or the product's own name ("Claude", "auto-learn",
 *  "bot", "system", "operator", "assistant", …): one verification relaxes rule 1's lockdown for every
 *  tenant, so a name a script or an agent would type is refused (fail closed: a real person whose
 *  whole name is one of these types their full name). */
const AGENT_NAME = /^(?:claude(?:[\s_-]*(?:code|ai|agent|bot|opus|sonnet|haiku))?|anthropic|auto[\s_-]*(?:learn(?:er|ing)?|pilot|mation|matic)?|autopilot|portal[\s_-]*bot|bot|robot|system|operator|assistant|agent|ai|llm|gpt|chat[\s_-]*gpt|copilot|helm|worker(?:[\s_-]*[\p{L}\p{N}]+)?|network[\s_-]*backstop|backstop|script|admin|dashboard)$/iu;
export function isInfoPageDeciderName(name: string): boolean {
  const n = String(name ?? "").replace(/\s+/g, " ").trim();
  if ((n.match(/\p{L}/gu) ?? []).length < 3) return false;
  const bare = n.replace(/[^\p{L}\p{N}\s_-]/gu, " ").replace(/\s+/g, " ").trim();
  return !AGENT_NAME.test(bare);
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
 *
 * ROUND 4 — RULE 6: the incident's text (its `why` quotes the incident project's page: a homeowner's
 * name, a confirmation code), the control label and the run id stay inside the INCIDENT PROJECT'S
 * ORG. A project of any other org in the use ledger gets only a GENERIC row — the pass and its place
 * (shared knowledge), `generic: true`, nothing else — and the run message counts only the incident
 * org's projects (`warnedInOrg`). An org that cannot be read is another org (generic).
 */
export function recordInfoPagePassIncidents(db: AppDb, projectId: string | null, runId: string, incidents: ReadonlyArray<InfoPageIncident> | null | undefined): { withdrawn: string[]; warned: string[]; warnedInOrg: string[]; warnError: string } {
  const withdrawn: string[] = [];
  const warned: string[] = [];
  const warnedInOrg: string[] = [];
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
      const inOrg: string[] = [];
      db.transaction(() => {
        for (const u of db.query<{ project_id: string; details: string }>("SELECT project_id, details FROM audit_logs WHERE action = ? AND project_id IS NOT NULL", [ACT_PASSED])) {
          if (s(parse<Row>(u.details, {}).passId) === passId && s(u.project_id)) users.add(s(u.project_id));
        }
        if (projectId) users.add(projectId);
        // RULE 6 (round 4): the incident's org; a project of any other org — or of an org that
        // cannot be read — gets the generic row only.
        const incidentOrg = projectId ? projectOrgOf(db, projectId) : null;
        for (const pid of users) {
          const same = incidentOrg !== null && projectOrgOf(db, pid) === incidentOrg;
          if (same) inOrg.push(pid);
          addAuditLog(db, pid, "portal_bot", "network backstop", ACT_MAY_HAVE_FILED, same
            ? { passId, where, controlLabel, why, org: incidentOrg, ...(pid === projectId ? { runId: s(runId).slice(0, 120) } : {}) }
            : { passId, where, generic: true });
        }
      });
      warned.push(...users);
      warnedInOrg.push(...inOrg);
    } catch (err) {
      warnError = `the may-have-filed warning could not be written (${err instanceof Error ? err.message.slice(0, 100) : String(err).slice(0, 100)})`;
    }
  }
  return { withdrawn, warned: Array.from(new Set(warned)), warnedInOrg: Array.from(new Set(warnedInOrg)), warnError };
}

/** A project's org (a project with no org row belongs to the default tenant, scope.assertInScope's
 *  rule); null = no such project, or unreadable. Reads only. */
function projectOrgOf(db: AppDb, projectId: string): string | null {
  try {
    const r = db.get<{ org_id: string | null }>("SELECT org_id FROM projects WHERE id = ?", [projectId]);
    return r ? (s(r.org_id) || DEFAULT_ORG_ID) : null;
  } catch { return null; }
}

/** THE WARNING ON A PROJECT'S CARD (round 3): every after-click incident on a pass this project used
 *  — the verified page may have filed for it. Newest first. Reads only.
 *  ROUND 4 (rule 6): a row carries the incident's text only when it was written for THIS project's
 *  org (its `org` stamp equals the project's org); any other row — a generic one, an older one, one
 *  whose org cannot be read — is returned GENERIC: the pass and its place, no text, no label, no time. */
export function listInfoPageFilingWarnings(db: AppDb, projectId: string): InfoPageFilingWarning[] {
  const own = projectOrgOf(db, projectId);
  return db.query<{ details: string; created_at: string }>(
    "SELECT details, created_at FROM audit_logs WHERE project_id = ? AND action = ? ORDER BY rowid DESC LIMIT 20", [projectId, ACT_MAY_HAVE_FILED])
    .map((r) => {
      const d = parse<Row>(r.details, {});
      const full = d.generic !== true && own !== null && s(d.org) === own;
      return full
        ? { passId: s(d.passId), where: s(d.where), controlLabel: s(d.controlLabel), at: s(r.created_at), why: (Array.isArray(d.why) ? d.why as unknown[] : []).map((w) => s(w)).slice(0, 4), generic: false }
        : { passId: s(d.passId), where: s(d.where), controlLabel: "", at: "", why: [], generic: true };
    });
}

/**
 * THE WARNING ON THE PASS'S KNOWLEDGE-BASE ENTRY (round 3): each pass an after-click incident
 * withdrew, with every project that used it NAMED — only the projects inside `orgId` (null = every
 * org: the superadmin). The pass itself is shared knowledge; which projects used it is tenant data,
 * so another org's project is never named or counted here (rule 6). Newest first. Reads only.
 * ROUND 4 (rule 6): each org sees ONLY ITS OWN ROWS — an entry exists for a caller's org only when
 * one of its own projects carries the warning, and its time and label come from those rows (a
 * generic row lends neither); another org's rows, times and projects never shape the entry.
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
    // A deleted project belongs to no org: only the superadmin sees its row (unnamed). A project with
    // no org row belongs to the default tenant (scope.assertInScope's rule).
    const rowOrg = r.project_id && r.pid ? (s(r.org_id) || DEFAULT_ORG_ID) : null;
    if (orgId !== null && rowOrg !== orgId) continue;
    const full = d.generic !== true && (orgId === null || s(d.org) === orgId);
    let w = byPass.get(passId);
    if (!w) { w = { passId, where: s(d.where), controlLabel: full ? s(d.controlLabel) : "", at: full ? s(r.created_at) : "", projects: [] }; byPass.set(passId, w); }
    else if (full && !w.at) { w.at = s(r.created_at); w.controlLabel = s(d.controlLabel); }
    if (!r.project_id || !r.pid) continue;
    if (w.projects.some((p) => p.id === s(r.project_id))) continue;
    w.projects.push({ id: s(r.project_id), name: s(r.homeowner_name), address: s(r.project_address).split(",")[0].trim() });
  }
  return Array.from(byPass.values()).slice(0, 50);
}

/** THE PROJECT IS BEING DELETED (repository.deleteProject, inside its transaction): its candidates
 *  go with it (tenant evidence), and every pass a person verified on one of them is withdrawn — a
 *  pass is authority only while the verification it came from is on record. */
export function deleteProjectInfoPages(db: AppDb, projectId: string): void {
  // ROUND 4 — THE EXPIRY COUNT NEVER DROPS: deleteProject deletes this project's audit rows after
  // this, so each pass it USED is first kept as a project-less row (infoPagePassUseCounts reads both).
  const used = new Set<string>();
  for (const u of db.query<{ details: string }>("SELECT details FROM audit_logs WHERE project_id = ? AND action = ?", [projectId, ACT_PASSED])) {
    const passId = s(parse<Row>(u.details, {}).passId);
    if (passId) used.add(passId);
  }
  for (const passId of used) addAuditLog(db, null, "system", "project deletion", ACT_USE_RETAINED, { passId, projectId });
  const verified = db.query<Row>("SELECT id, pass_id FROM portal_info_page_candidates WHERE project_id = ? AND status = 'verified' AND pass_id <> ''", [projectId]);
  for (const c of verified) {
    const r = db.get<Row>("SELECT * FROM portal_info_page_passes WHERE id = ? AND source_candidate_id = ?", [s(c.pass_id), s(c.id)]);
    if (r) removeInfoPagePass(db, r, { projectId: null, actorType: "system", actor: "project deletion", action: "portal.info_page_pass_withdrawn", details: { reason: "the project it was verified on was deleted" } });
  }
  db.run("DELETE FROM portal_info_page_candidates WHERE project_id = ?", [projectId]);
}

/** The shared list (critique [5]): places, names and dates only — no component or value hash, no
 *  verifier, no project. `live` = a person's verification on record and not expired (what a run
 *  receives); `expired` = why it expired (round 4: the limit reached, never a count — the count spans
 *  tenants). */
export function listInfoPagePasses(db: AppDb, nowMs: number = Date.now()): InfoPagePassRecord[] {
  const usesOf = usesOnce(db);
  return db.query<Row>("SELECT * FROM portal_info_page_passes ORDER BY verified_at DESC LIMIT 200").map((r) => {
    const expired = passExpiry(db, r, nowMs, usesOf);
    return {
      id: s(r.id),
      origin: s(r.origin),
      path: s(r.path),
      queryKeys: parse<string[]>(r.query_keys_json, []),
      controlLabel: s(r.control_label),
      controlName: s(r.control_name),
      request: { method: s(r.request_method), where: s(r.request_where), media: s(r.request_media), fieldNames: parse<Array<[string, string]>>(r.request_body_json, []).map(([n]) => n) },
      identityPrefix: s(r.identity_sha256).slice(0, 12),
      verifiedAt: s(r.verified_at),
      live: Number(r.identity_version) === INFO_PAGE_IDENTITY_VERSION && passIsOnRecord(db, r) && expired.length === 0,
      expired,
    };
  });
}

/**
 * ROUND 5 — A USE IS RESERVED AT ADMISSION, NOT WHEN THE PASS IS HANDED OUT. The network backstop
 * awaits this (through the learner's reserveInfoPagePass, autoLearn) at the moment it would let a
 * verified page's ONE request through; a refusal — or a throw — holds that request exactly as on
 * main. Inside ONE transaction: re-read the pass (still a person's verification on record, at the
 * current identity version — a pass withdrawn while the run was in flight refuses), re-read the use
 * ledger, refuse when the verification is expired NOW (shared infoPagePassExpiryRefusals: 30 days,
 * a clock-skewed time, or INFO_PAGE_PASS_MAX_PROJECTS distinct projects already — so a NEW project
 * that would make it 11 refuses), refuse when THIS project already has an admitted use on this side
 * since the latest allowance (at most once per project — Helm's review of #349: two runs of one
 * project in flight were each handed the pass), else write the use row. The pass is handed out earlier
 * (liveInfoPagePasses, per attempt): runs in flight at the same time were each handed it, and only
 * this check decides. THE ONLY WRITER OF ACT_PASSED (the source scan pins it).
 *
 * `admitted` (recordInfoPagePassUses only): the request ALREADY went — a use the learner reported
 * without a reservation. Nothing can be refused then; it is written all the same (counted, never
 * dropped: over-counting holds runs, under-counting would admit them). Returns the refusals (empty =
 * reserved / recorded).
 */
export function reserveInfoPagePassUse(
  db: AppDb, projectId: string, runId: string, scope: Side, use: { passId: string; where: string },
  opts: { nowMs?: number; admitted?: boolean } = {},
): string[] {
  const passId = s(use?.passId);
  const where = s(use?.where).slice(0, 200);
  return db.transaction(() => {
    if (opts.admitted !== true) {
      // The clock is read HERE, at the admission — never the hand-out's.
      const nowMs = typeof opts.nowMs === "number" && Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
      if (!passId) return ["the use could not be reserved (no verified page named)"];
      const r = db.get<Row>("SELECT * FROM portal_info_page_passes WHERE id = ?", [passId]);
      if (!r || Number(r.identity_version) !== INFO_PAGE_IDENTITY_VERSION || !passIsOnRecord(db, r)) {
        return ["the use could not be reserved (that verification is no longer on record: it was withdrawn or changed while the run was in flight)"];
      }
      const uses = infoPagePassUseCounts(db);
      const why = infoPagePassExpiryRefusals(s(r.verified_at), uses ? uses.get(passId) ?? 0 : null, nowMs);
      if (why.length) return why;
      // AT MOST ONCE PER PROJECT, DECIDED HERE TOO (Helm's review of #349). The hand-out asks it
      // (infoPagePriorProgress), but runs of the SAME project in flight at once were each handed the
      // pass: only this transaction decides. An earlier admitted use of this project on this side,
      // after the latest "allow once more" on it, refuses. (Not infoPagePriorProgress itself: this
      // run's own learn start is on record, and it is not progress here.)
      const earlier = earlierInfoPageUseOnSide(db, projectId, scope === "utility" ? "utility" : "ahj");
      if (earlier) return [earlier];
      // #365, ASKED AGAIN ON THE REAL PAGE: the hand-out judged the learn's own portal URL; the walk
      // may have reached a page on another host. The use is judged on the page the verified request
      // leaves from. Only the tracked-number reason: this run's own learn start is on record.
      const tracked = trackedNumberHardReason(db, projectId, scope === "utility" ? "utility" : "ahj", [where]);
      if (tracked) return [`the use could not be reserved (${tracked})`];
    }
    addAuditLog(db, projectId, "portal_bot", "network backstop", ACT_PASSED, { runId, scope, passId, where });
    return [];
  });
}

/** The refusal a reservation gives when this project already used a verified page on this side. */
export const INFO_PAGE_ALREADY_USED_REFUSAL = "this project already passed a verified information page on this portal (an earlier or concurrent run of it) — a pass admits at most once per project; a person may allow it once more";

/** An admitted use (ACT_PASSED) of this project on this side after the latest allowance on that side,
 *  as a refusal; "" = none. A ledger that cannot be read is a refusal (an unknown never reassures).
 *  Reads only. */
function earlierInfoPageUseOnSide(db: AppDb, projectId: string, side: Side): string {
  try {
    const rows = db.query<{ rid: number; action: string; details: string }>(
      "SELECT rowid AS rid, action, details FROM audit_logs WHERE project_id = ? AND action IN (?, ?) ORDER BY rowid", [projectId, ACT_PASSED, ACT_ALLOWED_AGAIN]);
    const parsed = rows.map((r) => ({ rid: Number(r.rid), action: s(r.action), d: parse<Row>(r.details, {}) }));
    const allowedAt = Math.max(0, ...parsed.filter((r) => r.action === ACT_ALLOWED_AGAIN && sideOf(r.d.scope) === side).map((r) => r.rid));
    return parsed.some((r) => r.action === ACT_PASSED && r.rid > allowedAt && rowOnSide(r.d, side)) ? INFO_PAGE_ALREADY_USED_REFUSAL : "";
  } catch {
    return "the use could not be reserved (this project's earlier uses could not be read)";
  }
}

/** Every use of the relaxation is on record: one audit row per admission — RESERVED at the admission
 *  itself (round 5: reserveInfoPagePassUse, the one writer) — with its side, and every later run of
 *  this project on that side counts it as progress (a pass admits at most once per project and
 *  side). This records a use the learner reported that was NOT reserved (autoLearn skips the ones it
 *  reserved: one row per use, never two). A write that fails throws: the caller's own counter and
 *  the unclean learn start still refuse. */
export function recordInfoPagePassUses(db: AppDb, projectId: string, runId: string, scope: Side, passed: ReadonlyArray<{ passId: string; where: string }> | null | undefined): void {
  for (const p of Array.isArray(passed) ? passed : []) {
    reserveInfoPagePassUse(db, projectId, runId, scope, { passId: s(p.passId), where: s(p.where) }, { admitted: true });
  }
}
