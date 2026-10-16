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
import type { AppDb } from "./db";
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
import type { InfoPageCandidateCapture, InfoPageCandidateRecord, InfoPageIncident, InfoPagePassRecord, VerifiedInfoPage } from "../../shared/src/types";

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

/**
 * HAS THIS PROJECT ALREADY MADE PROGRESS ON THIS PORTAL? (critique [1]) The portal session and its
 * server-side interview survive between runs (a persistent per-client profile), so a page a person
 * verified at the START of the interview could be shown again at a later server position where its
 * Next files. Refused (true) when this project already has, on this portal:
 *   - a tracking target on the same origin with an application or permit number;
 *   - a submission on the same side (permit vs NEM) that reached review or was filed;
 *   - a portal run on the same side that reached review, was submitted or recorded a number;
 *   - a draft recorded on the same side (portal.draft_created).
 * Unknown (an unparseable portal URL, a read error) is true: an unknown never reassures.
 */
export function infoPagePriorProgress(db: AppDb, projectId: string, portalUrl: string, scopeType: "ahj" | "utility"): boolean {
  let origin = "";
  try { origin = new URL(portalUrl).origin; } catch { return true; }
  if (!origin || origin === "null") return true;
  try {
    const targets = db.query<Row>("SELECT portal_url, application_number, permit_number FROM permit_check_targets WHERE project_id = ?", [projectId]);
    for (const t of targets) {
      let o = "";
      try { o = new URL(s(t.portal_url)).origin; } catch { o = ""; }
      if (o === origin && (s(t.application_number).trim() || s(t.permit_number).trim())) return true;
    }
    const nem = scopeType === "utility";
    const subs = db.query<Row>("SELECT permit_type, status FROM submissions WHERE project_id = ?", [projectId]);
    if (subs.some((x) => (s(x.permit_type) === "nem") === nem && ["awaiting_human_submit", "submitted", "submitted_unconfirmed", "staged", "approved", "issued"].includes(s(x.status)))) return true;
    const runs = db.query<Row>("SELECT permit_type, status, confirmation_number FROM portal_runs WHERE project_id = ?", [projectId]);
    if (runs.some((x) => (s(x.permit_type) === "nem") === nem && (s(x.confirmation_number).trim() !== "" || ["awaiting_human_submit", "submitted", "submitted_unconfirmed"].includes(s(x.status))))) return true;
    const drafts = db.query<Row>("SELECT details FROM audit_logs WHERE project_id = ? AND action = 'portal.draft_created'", [projectId]);
    if (drafts.some((d) => (s(parse<Row>(d.details, {}).track) === "nem") === nem)) return true;
    return false;
  } catch {
    return true;
  }
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
 */
export function recordInfoPagePassIncidents(db: AppDb, projectId: string | null, runId: string, incidents: ReadonlyArray<InfoPageIncident> | null | undefined): { withdrawn: string[] } {
  const withdrawn: string[] = [];
  for (const inc of Array.isArray(incidents) ? incidents : []) {
    const passId = s(inc?.passId).slice(0, 80);
    const phase = inc?.phase === "after" ? "after" : "before";
    const why = (Array.isArray(inc?.why) ? inc.why as unknown[] : []).map((w: unknown) => s(w).slice(0, 240)).slice(0, 8);
    if (!passId) continue;
    db.transaction(() => {
      const r = db.get<Row>("SELECT * FROM portal_info_page_passes WHERE id = ?", [passId]);
      const details = { phase, why, runId: s(runId).slice(0, 120), where: s(inc?.where).slice(0, 200) };
      if (r) {
        removeInfoPagePass(db, r, { projectId, actorType: "portal_bot", actor: "network backstop", action: "portal.info_page_pass_incident", details: { ...details, withdrawn: true } });
        withdrawn.push(passId);
      } else {
        addAuditLog(db, projectId, "portal_bot", "network backstop", "portal.info_page_pass_incident", { passId, ...details, withdrawn: false });
      }
    });
  }
  return { withdrawn };
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

/** Every use of the relaxation is on record: one audit row per admission. */
export function recordInfoPagePassUses(db: AppDb, projectId: string, runId: string, passed: ReadonlyArray<{ passId: string; where: string }> | null | undefined): void {
  for (const p of Array.isArray(passed) ? passed : []) {
    try { addAuditLog(db, projectId, "portal_bot", "network backstop", "portal.info_page_passed", { runId, passId: s(p.passId), where: s(p.where).slice(0, 200) }); } catch { /* best-effort */ }
  }
}
