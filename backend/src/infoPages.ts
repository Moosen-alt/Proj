// HUMAN-VERIFIED INFORMATION PAGES (#344, owner ruling 2026-10-15: option B) — the backend half.
//
// The network backstop (portal-bot/src/filingBackstop.ts openInfoPagePass) may let ONE forward
// request off an information page through hard rule 1's review lockdown (4b), only when a NAMED
// PERSON verified that exact page and the run has entered nothing (shared/src/infoPagePass.ts).
// This module is the ONLY writer of both tables (an infoPagePass.test grep pin):
//
//   portal_info_page_candidates — project-scoped evidence a learn recorded when the backstop held
//     an unverified information page (recordInfoPageCandidate, called by autoLearn's finalize).
//   portal_info_page_passes — shared knowledge (hashes, names, structure), written ONLY by a
//     person's verify (INSERT, built from the candidate ROW, never a request body) and withdraw
//     (UPDATE of the withdrawn_* columns). Never by a learn, import, research, replay or migration;
//     never overwritten (a changed page is a new candidate); never deleted (rule 3).
//
// liveInfoPagePasses is the ONE effective-row predicate: the bot input and the KB list both read it.
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
import type { InfoPageCandidateCapture, InfoPageCandidateRecord, InfoPagePassRecord, VerifiedInfoPage } from "../../shared/src/types";

type Row = Record<string, unknown>;
const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const parse = <T>(text: unknown, fallback: T): T => { try { return JSON.parse(s(text)) as T; } catch { return fallback; } };
const HEX64 = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------------------------
// The bot's input
// ---------------------------------------------------------------------------------------------

/** THE effective-row predicate: verified by a named person, not withdrawn, current identity version. */
export function liveInfoPagePasses(db: AppDb): VerifiedInfoPage[] {
  const rows = db.query<Row>(
    `SELECT * FROM portal_info_page_passes
      WHERE verified_at <> '' AND verified_by <> '' AND withdrawn_at = '' AND identity_version = ?
      ORDER BY verified_at`, [INFO_PAGE_IDENTITY_VERSION]);
  return rows.map(passRowToVerified);
}

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
 * HAS THIS PROJECT ALREADY MADE PROGRESS ON THIS PORTAL? (critique [1]) The portal session and its
 * server-side interview survive between runs (a persistent per-client profile), so a page a person
 * verified at the START of the interview could be shown again at a later server position where its
 * Next files. Refused (true) when this project already has, on this portal:
 *   - a tracking target on the same origin with an application or permit number;
 *   - a submission on the same side (permit vs NEM) that reached review or was filed;
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
    const drafts = db.query<Row>("SELECT details FROM audit_logs WHERE project_id = ? AND action = 'portal.draft_created'", [projectId]);
    if (drafts.some((d) => (s(parse<Row>(d.details, {}).track) === "nem") === nem)) return true;
    return false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
// Candidates (project-scoped)
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
  const live = db.get<Row>("SELECT id FROM portal_info_page_passes WHERE identity_sha256 = ? AND withdrawn_at = ''", [s(r.identity_sha256)]);
  if (live) out.push("a live pass for this exact page already exists");
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

/**
 * A NAMED PERSON VERIFIES the candidate: "This is an information page — OK to advance". One
 * transaction. The pass row is built ONLY from the candidate ROW (verifiedInfoPageFromCandidate);
 * the body names only which card the person looked at (its identity), never what to write.
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
      identitySha256Prefix: pass.identitySha256.slice(0, 12),
    });
    return { passId };
  });
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

/** WITHDRAW a pass (never delete it): runs that start after this no longer receive it; a run already
 *  in flight keeps the pass it started with (entries are frozen per run). */
export function withdrawInfoPagePass(db: AppDb, passId: string, input: { by: string; userId: string; reason: string }): void {
  db.transaction(() => {
    const r = db.get<Row>("SELECT id, withdrawn_at FROM portal_info_page_passes WHERE id = ?", [passId]);
    if (!r) throw new HttpError(404, "Verified information page not found.");
    if (s(r.withdrawn_at)) throw new HttpError(409, "This pass is already withdrawn.");
    db.run("UPDATE portal_info_page_passes SET withdrawn_at = ?, withdrawn_by = ?, withdrawn_by_user_id = ?, withdraw_reason = ? WHERE id = ?",
      [nowIso(), input.by, input.userId, input.reason, passId]);
    addAuditLog(db, null, "human", input.by, "portal.info_page_pass_withdrawn", { passId, reason: input.reason });
  });
}

/** The shared list (critique [5]): places, names and dates only — no component or value hash, no
 *  verifier, no project. Reads only. */
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
    status: s(r.withdrawn_at) ? "withdrawn" as const : "live" as const,
    withdrawnAt: s(r.withdrawn_at),
    withdrawReason: s(r.withdraw_reason),
  }));
}

/** Every use of the relaxation is on record: one audit row per admission. */
export function recordInfoPagePassUses(db: AppDb, projectId: string, runId: string, passed: ReadonlyArray<{ passId: string; where: string }> | null | undefined): void {
  for (const p of Array.isArray(passed) ? passed : []) {
    try { addAuditLog(db, projectId, "portal_bot", "network backstop", "portal.info_page_passed", { runId, passId: s(p.passId), where: s(p.where).slice(0, 200) }); } catch { /* best-effort */ }
  }
}
