// HUMAN-VERIFIED INFORMATION PAGES, THE BACKEND (#344, option B): backend/src/infoPages.ts, migration
// v50, autoLearn's finalize, repository.deleteProject and the six routes — on a scratch DB, through
// the real write paths.
//
//   MIGRATION — v50 creates both tables and all four indexes, and replays after its schema_meta row is
//               deleted; listing on a fresh DB writes nothing.
//   CAPTURE   — a learn the backstop held at an unverified page (the learner stubbed through
//               setAutoLearnSeamsForTests) records ONE open candidate with its screenshot through
//               autoLearn's finalize, audits it, and says so in the message; the learn is handed
//               the live passes and the prior-progress answer. A second sighting bumps it; a
//               dismissed one stays dismissed (and the message names who); a verified one is never
//               touched; after a withdrawal a re-capture is a NEW open row.
//   VERIFY    — refuses (409) a stale card, a non-open row, no screenshot, an older identity version,
//               a page with a field / a GET form / a filing action, a missing / unreadable / file-
//               carrying / different held request, the project's own values on the page, a prefix
//               that is not entry clicks, and a duplicate live identity. Success writes the shared
//               row FROM THE ROW, audits it, stamps the candidate.
//   RULE 3    — a re-capture with another identity leaves the pass byte-identical; a person's
//               withdraw DELETES the row (the audit keeps its history) and the bot stops receiving it.
//   FORGED    — a pass row written by any path but the verify action (a direct insert, a copy of a
//               real row) is never handed to a run; a pass "moved" to another host, path, control,
//               request or step sequence, or whose candidate no longer records the verification,
//               neither; pass-shaped fields saved onto recipe steps through the real save change
//               nothing. (Kill: drop the provenance check in liveInfoPagePasses and these go red.)
//   INCIDENTS — before the click (the page drifted) and after it (the page read as filed): audited
//               on the project, the pass DELETED, the fresh candidate recorded, the learn "failed"
//               with nothing recorded as filed; an unknown pass id is audited all the same.
//   DELETE    — deleting the project a page was verified on deletes its candidates and withdraws
//               that pass (audited with no project, so the history survives the project).
//   SHARED    — GET /api/info-page-passes carries no text, no hash of a value, no verifier, no project.
//   PROGRESS  — (round 2, fail closed) a tracking number of this project WHATEVER its URL (P5), a
//               staged / paused (P6) / interrupted (P4) / numbered run or submission on the same side,
//               an interrupted staging job, a recorded draft, and this project's earlier LEARNS
//               refuse: a use of a pass (at most once per project: B1a/P1, B1b/P2), and any learn that
//               did not end held, untouched, at an information page. The positive control: capture →
//               verify → the SAME project's next learn is handed false. THE HEADED RETRY is asked
//               afresh (P3/B2): attempt 1's use is on record and attempt 2 gets no pass. A learn that
//               throws after a use withdraws the pass. ALLOW ONCE MORE: a named person lifts the
//               learn history once; a hard reason, nothing to allow or a bad side refuses.
//   ROUTES    — auth OFF: JSON only (415); cross-origin and a rebinding Host are 403 and write
//               nothing; no name / "operator" is 400; a typed name verifies. Auth ON: 401 signed
//               out; an org ADMIN is 403 on verify (superadmin only) and the superadmin's verify
//               ignores a body name; another org's admin gets 404; withdraw needs a reason. Allow
//               once more: the same guards, superadmin when signed in, another org 404.
//
//   npx tsx backend/test/infoPages.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { REPO } from "./_isolate";
import { setupStageFixture, check, finish } from "./_stageFixture";
import {
  INFO_PAGE_IDENTITY_VERSION, digestInfoPageIdentity, infoPageEvidence, infoPagePrefixOf, sha256Hex,
  type InfoPageIdentityMaterial,
} from "../../shared/src/infoPagePass";
import type { InfoPageCandidateCapture, InfoPageIncident } from "../../shared/src/types";

const fx = await setupStageFixture("info-pages");
const { db } = fx;
const IP = await import("../src/infoPages");
const autoLearn = await import("../src/autoLearn");

const ORIGIN = "https://permits.example.test";
const PROSE = "This is a permit request only. A Permit Tech will review your submission for minimum submittal standards. Please do not submit additional requests.";
const material = (patch: (m: InfoPageIdentityMaterial) => void = () => undefined): InfoPageIdentityMaterial => {
  const m: InfoPageIdentityMaterial = {
    version: INFO_PAGE_IDENTITY_VERSION,
    page: { origin: ORIGIN, path: "/permits/sfjsp", query: [] },
    title: "Development Hub Fixture",
    structure: {
      headings: [["1", "Development Hub Fixture"]],
      forms: [{ id: "smartguide_ApplyForAPermit", name: "", method: "post", enctype: "multipart/form-data", action: `${ORIGIN}/permits/sfjsp`, target: "", elements: [["button", "submit", "t_p1", null], ["button", "submit", "t_n1", null]] }],
      fillable: [], clickables: [["button", "submit", "t_p1", 0, ""], ["button", "submit", "t_n1", 0, ""]], frames: [],
    },
    facts: { fileInputsInForm: 0, customFormElements: 0, summaryOutsideChrome: 0, summaryInForm: 0, controlLabels: ["Previous", "Next"], hiddenNames: [], masked: 0, baseTarget: "" },
    text: `Development Hub Fixture Permitting Information ${PROSE} Previous Next`,
    control: { tag: "button", type: "submit", name: "t_n1", value: "", label: "Next", formIndex: 0, submitterIndex: 1, method: "post", action: `${ORIGIN}/permits/sfjsp`, enctype: "multipart/form-data", target: "" },
    request: { method: "POST", url: `${ORIGIN}/permits/sfjsp`, media: "multipart/form-data", body: [["t_n1", ""]] },
  };
  patch(m);
  return m;
};
const PREFIX = infoPagePrefixOf([
  { action: "goto", note: "entry url", value: `${ORIGIN}/permits/sfjsp?interviewID=Home` },
  { action: "click", note: "application entry: Apply For A Permit" },
  { action: "click", note: "permit type: Solar Permit Request" },
]);
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex").toString("base64");
const capture = (m: InfoPageIdentityMaterial = material(), o: Partial<InfoPageCandidateCapture> = {}): InfoPageCandidateCapture => {
  const d = digestInfoPageIdentity(m);
  return {
    identityVersion: d.version, identitySha256: d.identitySha256, origin: d.origin, path: d.path, controlLabel: d.control.label,
    digest: d, prefix: PREFIX,
    observed: { method: "POST", where: d.expected.where, actionUrlSha: d.expected.actionUrlSha, media: d.expected.media, body: d.expected.body, hasFilenamePart: false },
    evidence: infoPageEvidence(m), screenshotBase64: PNG, ...o,
  };
};
const cand = (projectId: string) => db.query<Record<string, unknown>>("SELECT * FROM portal_info_page_candidates WHERE project_id = ? ORDER BY first_seen_at, rowid", [projectId]);
const passRows = () => db.query<Record<string, unknown>>("SELECT * FROM portal_info_page_passes ORDER BY verified_at, rowid");
const verifyFn = (projectId: string, cid: string, identitySha256: string) => IP.verifyInfoPageCandidate(db, projectId, cid, { identitySha256, verifiedBy: "Pat Verifier", userId: "" });
const expect409 = (fn: () => unknown, re: RegExp): void => {
  try { fn(); } catch (e) {
    const err = e as { status?: number; message?: string };
    assert.equal(err.status, 409, `status ${err.status}: ${err.message}`);
    assert.match(String(err.message), re);
    return;
  }
  assert.fail("expected a 409");
};

// ── MIGRATION ─────────────────────────────────────────────────────────────────────────────────
await check("v50 creates both tables and all four indexes (and the pass table has no update-only columns)", () => {
  const names = db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE name LIKE '%info_page%' AND name NOT LIKE 'sqlite_%'").map((r) => r.name).sort();
  assert.deepEqual(names, ["idx_info_page_cand_project", "idx_info_page_pass_origin", "portal_info_page_candidates", "portal_info_page_passes", "ux_info_page_cand_live", "ux_info_page_pass_identity"]);
  const cols = db.query<{ name: string }>("PRAGMA table_info(portal_info_page_passes)").map((r) => r.name);
  assert.ok(!cols.some((c) => /withdrawn/.test(c)), JSON.stringify(cols));
  assert.equal(Number(db.get<{ v: number }>("SELECT MAX(version) AS v FROM schema_meta")!.v), 50);
});
await check("listing on a fresh DB writes nothing (reads write nothing)", () => {
  const before = Number(db.get<{ n: number }>("SELECT total_changes() AS n")!.n);
  IP.liveInfoPagePasses(db); IP.listInfoPagePasses(db); IP.listInfoPageCandidates(db, "no-such-project");
  assert.equal(Number(db.get<{ n: number }>("SELECT total_changes() AS n")!.n), before);
});

// ── CAPTURE through autoLearn's finalize ──────────────────────────────────────────────────────
let handed: { infoPagePasses?: unknown[]; infoPagePriorProgress?: boolean } | null = null;
let nextCapture: InfoPageCandidateCapture | undefined;
let nextPassed: Array<{ passId: string; where: string }> | undefined;
let nextIncidents: InfoPageIncident[] | undefined;
const stubLearn = () => ({
  ok: false, portalName: "stub", steps: [], reviewScreen: { fields: [], bodyTextSnippet: "" }, finalSubmitRecorded: false, pageCount: 2, pauseReason: null,
  message: nextIncidents?.some((i) => i.phase === "after") ? "STOPPED AFTER A VERIFIED INFORMATION PAGE: the page it led to reads as filed." : "HELD AT AN INFORMATION PAGE NO PERSON HAS VERIFIED: the network backstop held \"Next\".",
  stopReason: nextIncidents?.some((i) => i.phase === "after") ? "info_page_incident" : "backstop_abort",
  ...(nextCapture ? { infoPageCandidate: nextCapture } : {}), ...(nextPassed ? { infoPagePassed: nextPassed } : {}), ...(nextIncidents ? { infoPageIncidents: nextIncidents } : {}),
});
// Round 2: every attempt's input is kept (the headed retry is a second call), and a test may script
// the attempts itself (report a use through the learner's own callback, throw, look bot-blocked…).
type LearnInput = { infoPagePasses?: Array<{ id: string }>; infoPagePriorProgress?: boolean; onInfoPagePassed?: (p: { passId: string; where: string }) => void };
let handedAll: LearnInput[] = [];
let scripted: Array<(input: LearnInput) => unknown> = [];
autoLearn.setAutoLearnSeamsForTests({ learnPortal: (async (input: LearnInput) => {
  handed = input; handedAll.push(input);
  const next = scripted.shift();
  return next ? next(input) : stubLearn();
}) as never });
const runLearn = async (projectId: string, c?: InfoPageCandidateCapture, passed?: Array<{ passId: string; where: string }>, incidents?: InfoPageIncident[]) => {
  nextCapture = c; nextPassed = passed; nextIncidents = incidents; handed = null; handedAll = [];
  return autoLearn.autoLearnPortal(db, projectId, { scope: "ahj", portalUrl: `${ORIGIN}/permits/sfjsp?interviewID=Home`, createdBy: "operator", permitType: "structural" });
};

const P1 = fx.newProject();
let cid1 = "";
await check("a held learn records ONE open candidate through autoLearn's finalize, with its screenshot, audited and named in the message", async () => {
  const r = await runLearn(P1, capture());
  const rows = cand(P1);
  assert.equal(rows.length, 1);
  cid1 = String(rows[0].id);
  assert.equal(rows[0].status, "open");
  assert.ok(Buffer.isBuffer(rows[0].screenshot_png) && (rows[0].screenshot_png as Buffer).length > 0, "no screenshot stored");
  assert.equal(fx.audits("portal.info_page_candidate_recorded").length, 1);
  assert.match(String(r.message), /Recorded for a person to verify/);
});
await check("the learn was handed the live passes (none yet) and the prior-progress answer (false: a fresh project)", () => {
  assert.ok(handed, "the stub learn was reached");
  assert.deepEqual(handed!.infoPagePasses, []);
  assert.equal(handed!.infoPagePriorProgress, false);
});
await check("a learn whose candidate was never held (no observed request) records nothing", async () => {
  const P = fx.newProject();
  await runLearn(P, capture(material(), { observed: null as never }));
  assert.equal(cand(P).length, 0);
});
await check("a second sighting bumps the open row (seen_count 2), never a second row", async () => {
  await runLearn(P1, capture());
  const rows = cand(P1);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].seen_count), 2);
});
await check("the card lists it with no refusal (DevHub's shape) and the fee / review WARNINGS", () => {
  const list = IP.listInfoPageCandidates(db, P1);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].refusals, []);
  assert.ok(list[0].warnings.some((w) => /review wording/.test(w)), JSON.stringify(list[0].warnings));
  assert.equal(list[0].hasScreenshot, true);
  assert.ok(!("screenshot_png" in (list[0] as unknown as Record<string, unknown>)));
  assert.deepEqual(list[0].steps, [`go to ${ORIGIN}/permits/sfjsp?interviewID`, "application entry: Apply For A Permit", "permit type: Solar Permit Request"]);
});

// ── VERIFY: every refusal is a 409 that writes nothing ────────────────────────────────────────
const refusalCase = async (what: string, m: InfoPageIdentityMaterial, o: Partial<InfoPageCandidateCapture>, re: RegExp, after?: (cid: string) => void) => {
  await check(`verify refuses (409, nothing written): ${what}`, async () => {
    const P = fx.newProject();
    const c = capture(m, o);
    await runLearn(P, c);
    const cid = String(cand(P)[0].id);
    after?.(cid);
    const before = passRows().length;
    expect409(() => verifyFn(P, cid, c.identitySha256), re);
    assert.equal(passRows().length, before);
    assert.equal(String(cand(P)[0].status) === "verified", false);
  });
};
await check("verify refuses a STALE card (the identity on the card is not the row's)", () => {
  expect409(() => verifyFn(P1, cid1, sha256Hex("another page")), /changed/);
});
await refusalCase("no screenshot", material(), { screenshotBase64: undefined }, /no screenshot/);
await refusalCase("an older identity version", material(), {}, /identity version/, (cid) => db.run("UPDATE portal_info_page_candidates SET identity_version = ? WHERE id = ?", [INFO_PAGE_IDENTITY_VERSION - 1, cid]));
await refusalCase("a page with a field", material((m) => { m.structure.fillable.push(["input", "text", "addr", 0]); }), {}, /fillable/);
await refusalCase("a GET form", material((m) => { m.request.method = "GET"; }), {}, /not POST/);
await refusalCase("a filing-shaped action", material((m) => { m.request.url = `${ORIGIN}/permits/submitApplication`; }), {}, /filing/);
await refusalCase("the held request missing", material(), {}, /./, (cid) => db.run("UPDATE portal_info_page_candidates SET observed_json = 'null' WHERE id = ?", [cid]));
await refusalCase("the held request's body unreadable", material(), {}, /could not be read/, (cid) => {
  const o = JSON.parse(String(cand(db.get<{ project_id: string }>("SELECT project_id FROM portal_info_page_candidates WHERE id = ?", [cid])!.project_id)[0].observed_json));
  db.run("UPDATE portal_info_page_candidates SET observed_json = ? WHERE id = ?", [JSON.stringify({ ...o, body: null }), cid]);
});
await refusalCase("the held request carried a file part", material(), {}, /file/, (cid) => {
  const row = db.get<{ observed_json: string }>("SELECT observed_json FROM portal_info_page_candidates WHERE id = ?", [cid])!;
  db.run("UPDATE portal_info_page_candidates SET observed_json = ? WHERE id = ?", [JSON.stringify({ ...JSON.parse(row.observed_json), hasFilenamePart: true }), cid]);
});
await refusalCase("the held request differs from what the control sends", material(), {}, /not what the page's control sends/, (cid) => {
  const row = db.get<{ observed_json: string }>("SELECT observed_json FROM portal_info_page_candidates WHERE id = ?", [cid])!;
  db.run("UPDATE portal_info_page_candidates SET observed_json = ? WHERE id = ?", [JSON.stringify({ ...JSON.parse(row.observed_json), body: [["t_n1", sha256Hex("")], ["addr", sha256Hex("1 Main")]] }), cid]);
});
await refusalCase("a prefix that is not entry clicks", material(), { prefix: [...PREFIX, ["click", "advance: Yes", ""]] }, /not an entry click/);
await check("verify refuses (409): the project's own street on the page", async () => {
  const P = fx.newProject({ street: "4421 Unique Lane" });
  const c = capture(material((m) => { m.text += " Site: 4421 Unique Lane"; }));
  await runLearn(P, c);
  expect409(() => verifyFn(P, String(cand(P)[0].id), c.identitySha256), /own values/);
});

let pass1 = "";
await check("a person's verify writes the shared row FROM THE ROW, audits it and stamps the candidate", () => {
  const out = verifyFn(P1, cid1, capture().identitySha256);
  pass1 = out.passId;
  const p = passRows();
  assert.equal(p.length, 1);
  const c = capture();
  assert.equal(p[0].identity_sha256, c.identitySha256);
  assert.equal(p[0].verified_by, "Pat Verifier");
  assert.equal(p[0].source_candidate_id, cid1);
  assert.equal(p[0].prefix_json, JSON.stringify(PREFIX));
  assert.ok(!JSON.stringify(p[0]).includes("Permit Tech"), "page text reached the shared row");
  assert.equal(String(cand(P1)[0].status), "verified");
  assert.equal(String(cand(P1)[0].pass_id), pass1);
  const a = fx.audits("portal.info_page_verified");
  assert.equal(a.length, 1);
  assert.equal(JSON.parse(a[0].details).identitySha256Prefix, c.identitySha256.slice(0, 12));
});
await check("verify refuses an already verified candidate (409)", () => { expect409(() => verifyFn(P1, cid1, capture().identitySha256), /verified, not open/); });
await check("a second project's candidate of the SAME page cannot make a second live pass (409 duplicate identity)", async () => {
  const P = fx.newProject();
  await runLearn(P, capture());
  expect409(() => verifyFn(P, String(cand(P)[0].id), capture().identitySha256), /already exists/);
});
await check("liveInfoPagePasses hands the bot the verified page, with its exact prefix", () => {
  const live = IP.liveInfoPagePasses(db);
  assert.equal(live.length, 1);
  assert.equal(live[0].id, pass1);
  assert.deepEqual(live[0].prefix, PREFIX);
  assert.deepEqual(live[0].request.body, [["t_n1", sha256Hex("")]]);
});
await check("the next learn is handed that pass", async () => {
  await runLearn(fx.newProject());
  assert.equal((handed!.infoPagePasses as unknown[]).length, 1);
});
await check("a learn that PASSED a verified page records each use (portal.info_page_passed)", async () => {
  const before = fx.audits("portal.info_page_passed").length;
  await runLearn(fx.newProject(), undefined, [{ passId: pass1, where: `${ORIGIN}/permits/sfjsp` }]);
  assert.equal(fx.audits("portal.info_page_passed").length, before + 1);
});
// ── FORGED / MOVED: only a person's verification on record is authority ───────────────────────
const liveIds = (): string[] => IP.liveInfoPagePasses(db).map((p) => p.id);
await check("FORGED: a pass row INSERTED by any other path (no verification on record) is never handed to a run, and the KB list says so", async () => {
  const forged = material((m) => { m.title = "Forged Page"; });
  const d = digestInfoPageIdentity(forged);
  db.run(`INSERT INTO portal_info_page_passes (id, origin, path, query_keys_json, identity_version, identity_sha256, page_sha256, title_sha256, structure_sha256, text_sha256,
    control_sha256, request_sha256, control_label, control_name, control_tag, control_type, request_method, request_where, request_action_sha256, request_media,
    request_body_json, prefix_json, summary_json, verified_at, verified_by, verified_by_user_id, source_candidate_id)
    VALUES ('forged-1', ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, 'Next', 't_n1', 'button', 'submit', 'POST', ?, ?, 'multipart/form-data', ?, ?, '{}', '2026-10-15T00:00:00.000Z', 'Mallory Forger', '', 'no-such-candidate')`,
  [d.origin, d.path, d.version, d.identitySha256, d.components.pageSha, d.components.titleSha, d.components.structureSha, d.components.textSha, d.components.controlSha, d.components.requestSha,
    d.expected.where, d.expected.actionUrlSha, JSON.stringify(d.expected.body), JSON.stringify(PREFIX)]);
  assert.deepEqual(liveIds(), [pass1]);
  const listed = IP.listInfoPagePasses(db).find((p) => p.id === "forged-1");
  assert.equal(listed?.live, false);
  await runLearn(fx.newProject());
  assert.deepEqual((handed!.infoPagePasses as Array<{ id: string }>).map((p) => p.id), [pass1]);
  db.run("DELETE FROM portal_info_page_passes WHERE id = 'forged-1'");
});
await check("FORGED: a COPY of a real pass row under another id (pointing at the real candidate) is never handed to a run", () => {
  const forged = material((m) => { m.title = "Copied Page"; });
  const d = digestInfoPageIdentity(forged);
  db.run(`INSERT INTO portal_info_page_passes SELECT 'copied-1', origin, path, query_keys_json, identity_version, ?, page_sha256, title_sha256, structure_sha256, text_sha256,
    control_sha256, request_sha256, control_label, control_name, control_tag, control_type, request_method, request_where, request_action_sha256, request_media,
    request_body_json, prefix_json, summary_json, verified_at, verified_by, verified_by_user_id, source_candidate_id FROM portal_info_page_passes WHERE id = ?`, [d.identitySha256, pass1]);
  assert.deepEqual(liveIds(), [pass1]);
  db.run("DELETE FROM portal_info_page_passes WHERE id = 'copied-1'");
});
const moves: Array<[string, string, string]> = [
  ["another host", "origin", "https://permits.other.test"],
  ["another path (tenant)", "path", "/agency-b/permits/sfjsp"],
  ["another control", "control_name", "t_n9"],
  ["another request", "request_where", "https://permits.example.test/permits/file"],
  ["another step sequence", "prefix_json", JSON.stringify([...PREFIX.slice(0, 2), ["click", "permit type: Trade Permits", ""]])],
  ["another verifier", "verified_by", "Somebody Else"],
];
for (const [what, col, value] of moves) {
  await check(`MOVED RECORD: the pass row moved to ${what} is not authority until it is exactly what the person verified`, () => {
    const before = db.get<Record<string, unknown>>(`SELECT ${col} AS v FROM portal_info_page_passes WHERE id = ?`, [pass1])!.v;
    db.run(`UPDATE portal_info_page_passes SET ${col} = ? WHERE id = ?`, [value, pass1]);
    try { assert.deepEqual(liveIds(), []); } finally { db.run(`UPDATE portal_info_page_passes SET ${col} = ? WHERE id = ?`, [before, pass1]); }
    assert.deepEqual(liveIds(), [pass1]);
  });
}
await check("MOVED RECORD: a pass whose candidate no longer records the verification (status / pass id) is not authority", () => {
  db.run("UPDATE portal_info_page_candidates SET status = 'open' WHERE id = ?", [cid1]);
  try { assert.deepEqual(liveIds(), []); } finally { db.run("UPDATE portal_info_page_candidates SET status = 'verified' WHERE id = ?", [cid1]); }
  db.run("UPDATE portal_info_page_candidates SET pass_id = 'other' WHERE id = ?", [cid1]);
  try { assert.deepEqual(liveIds(), []); } finally { db.run("UPDATE portal_info_page_candidates SET pass_id = ? WHERE id = ?", [pass1, cid1]); }
  assert.deepEqual(liveIds(), [pass1]);
});
await check("FORGED: pass-shaped fields saved onto RECIPE STEPS through the real save are ignored (the run is handed the record, nothing else)", async () => {
  const forgedFields = { infoPagePass: { identitySha256: sha256Hex("x"), verifiedBy: "Mallory" }, verifiedInfoPage: { id: "forged", prefix: [] }, infoPagePasses: [{ id: "forged" }] };
  // Its own AHJ, so no later learn here meets a complete recipe.
  const r = fx.recipes.startPortalRecording(db, { scopeType: "ahj", state: "OR", ahj: "Forgedville", utility: "PGE", portalUrl: `${ORIGIN}/permits/sfjsp`, portalPlatform: "other", createdBy: "test" });
  fx.recipes.savePortalRecipeSteps(db, r.id, [{ ...(fx.fills(1)[0]), ...forgedFields } as never, { action: "click", selector: { text: "Next" }, note: "advance: Next", ...forgedFields } as never, fx.REVIEW, fx.FINAL], { status: "complete" });
  assert.deepEqual(liveIds(), [pass1]);
  await runLearn(fx.newProject());
  assert.deepEqual((handed!.infoPagePasses as Array<{ id: string }>).map((p) => p.id), [pass1]);
  assert.equal(db.query("SELECT id FROM portal_info_page_passes").length, 1);
});

await check("RULE 3: a re-capture with ANOTHER identity is a new candidate; the pass row stays byte-identical", async () => {
  const before = JSON.stringify(passRows());
  await runLearn(P1, capture(material((m) => { m.text += " New paragraph."; })));
  assert.equal(JSON.stringify(passRows()), before);
  assert.equal(cand(P1).filter((r) => r.status === "open").length, 1);
});
await check("RULE 3: a re-capture of the VERIFIED identity never touches the verified row", async () => {
  const verifiedBefore = JSON.stringify(cand(P1).filter((r) => r.status === "verified").map((r) => ({ ...r, screenshot_png: null })));
  await runLearn(P1, capture());
  assert.equal(JSON.stringify(cand(P1).filter((r) => r.status === "verified").map((r) => ({ ...r, screenshot_png: null }))), verifiedBefore);
});

// ── DISMISS ──────────────────────────────────────────────────────────────────────────────────────
await check("a dismissed page stays dismissed on a re-capture, and the run says who dismissed it", async () => {
  const P = fx.newProject();
  const c = capture(material((m) => { m.title = "Another Info Page"; }));
  await runLearn(P, c);
  IP.dismissInfoPageCandidate(db, P, String(cand(P)[0].id), { dismissedBy: "Dana Dismisser", userId: "" });
  const r = await runLearn(P, c);
  const rows = cand(P);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "dismissed");
  assert.equal(Number(rows[0].seen_count), 2);
  assert.match(String(r.message), /not an information page.*Dana Dismisser/);
  assert.equal(fx.audits("portal.info_page_candidate_dismissed").length, 1);
});

// ── WITHDRAW ─────────────────────────────────────────────────────────────────────────────────────
await check("a person's withdraw DELETES the row, audits its history (no verifier, no project), and the bot no longer receives it", () => {
  IP.withdrawInfoPagePass(db, pass1, { by: "Wren Withdrawer", userId: "", reason: "the page changed" });
  assert.equal(passRows().length, 0);
  assert.equal(IP.liveInfoPagePasses(db).length, 0);
  const a = fx.audits("portal.info_page_pass_withdrawn");
  assert.equal(a.length, 1);
  assert.equal(a[0].project_id, null);
  assert.equal(a[0].actor_name, "Wren Withdrawer");
  const d = JSON.parse(a[0].details);
  assert.equal(d.passId, pass1);
  assert.equal(d.reason, "the page changed");
  assert.equal(d.pass.origin, ORIGIN);
  assert.ok(!a[0].details.includes("Pat Verifier"), "the withdrawal row carries the verifier");
  assert.throws(() => IP.withdrawInfoPagePass(db, pass1, { by: "Wren Withdrawer", userId: "", reason: "again" }), /not found/);
});
let pass2 = "";
await check("after a withdrawal a re-capture of that page is a NEW open row (the verified one untouched), and a person can verify it again", async () => {
  await runLearn(P1, capture());
  const open = cand(P1).filter((r) => r.status === "open" && r.identity_sha256 === capture().identitySha256);
  assert.equal(open.length, 1);
  assert.equal(cand(P1).filter((r) => r.status === "verified").length, 1);
  pass2 = verifyFn(P1, String(open[0].id), capture().identitySha256).passId;
  assert.deepEqual(IP.liveInfoPagePasses(db).map((p) => p.id), [pass2]);
  const records = IP.listInfoPageCandidates(db, P1).filter((c) => c.status === "verified");
  assert.deepEqual(records.map((c) => c.passLive).sort(), [false, true]);
});
await check("the shared list carries places, names and dates only — no text, no hash of a value, no verifier, no project", () => {
  const l = IP.listInfoPagePasses(db);
  const s = JSON.stringify(l);
  for (const banned of ["Permit Tech", "Pat Verifier", "Wren Withdrawer", P1, capture().digest && (capture().digest as { components: { textSha: string } }).components.textSha, sha256Hex("")]) {
    assert.ok(!s.includes(String(banned)), `the shared list carries ${banned}`);
  }
  assert.equal(l[0].identityPrefix.length, 12);
  assert.deepEqual(l[0].request.fieldNames, ["t_n1"]);
});

// ── INCIDENTS (proposal §4) ──────────────────────────────────────────────────────────────────────
const verifiedPage = async (title: string): Promise<{ P: string; passId: string; c: InfoPageCandidateCapture }> => {
  const P = fx.newProject();
  const c = capture(material((m) => { m.title = title; }));
  await runLearn(P, c);
  const passId = verifyFn(P, String(cand(P)[0].id), c.identitySha256).passId;
  assert.ok(IP.liveInfoPagePasses(db).some((p) => p.id === passId));
  return { P, passId, c };
};
await check("INCIDENT BEFORE THE CLICK: the pass is DELETED and audited on the project; the page as it is now is the fresh candidate", async () => {
  const { P, passId } = await verifiedPage("Incident Before Page");
  const now = capture(material((m) => { m.title = "Incident Before Page"; m.text += " A new sentence."; }));
  const r = await runLearn(P, now, undefined, [{ passId, phase: "before", why: ["the page's text changed"], where: `${ORIGIN}/permits/sfjsp` }]);
  assert.equal(db.query("SELECT id FROM portal_info_page_passes WHERE id = ?", [passId]).length, 0);
  assert.ok(!IP.liveInfoPagePasses(db).some((p) => p.id === passId));
  const a = fx.audits("portal.info_page_pass_incident").filter((x) => JSON.parse(x.details).passId === passId);
  assert.equal(a.length, 1);
  assert.equal(a[0].project_id, P);
  const d = JSON.parse(a[0].details);
  assert.equal(d.phase, "before");
  assert.equal(d.withdrawn, true);
  assert.deepEqual(d.why, ["the page's text changed"]);
  assert.equal(d.pass.origin, ORIGIN);
  assert.ok(cand(P).some((x) => x.status === "open" && x.identity_sha256 === now.identitySha256), "the page as it is now was not recorded as a candidate");
  assert.match(String(r.message), /verified information page changed; that verification was withdrawn/);
});
await check("INCIDENT AFTER THE CLICK: the pass is DELETED and audited; the learn is 'failed' and NOTHING is recorded as filed", async () => {
  const { P, passId } = await verifiedPage("Incident After Page");
  const r = await runLearn(P, undefined, [{ passId, where: `${ORIGIN}/permits/sfjsp` }],
    [{ passId, phase: "after", why: ["the page after the click reads as filed (\"Confirmation number: PR-####-####\")"], where: `${ORIGIN}/permits/sfjsp` }]);
  assert.equal(db.query("SELECT id FROM portal_info_page_passes WHERE id = ?", [passId]).length, 0);
  const a = fx.audits("portal.info_page_pass_incident").filter((x) => JSON.parse(x.details).passId === passId);
  assert.equal(a.length, 1);
  assert.equal(JSON.parse(a[0].details).phase, "after");
  assert.equal(fx.audits("portal.info_page_passed").filter((x) => JSON.parse(x.details).passId === passId).length, 1, "the use itself is on record too");
  assert.equal(r.status, "failed");
  assert.match(String(r.message), /did not read as an unfiled application form; that verification was withdrawn/);
  assert.equal(db.query("SELECT id FROM submissions WHERE project_id = ? AND status IN ('submitted', 'submitted_unconfirmed', 'awaiting_human_submit', 'staged')", [P]).length, 0);
  assert.equal(db.query("SELECT id FROM portal_runs WHERE project_id = ? AND (confirmation_number <> '' OR status = 'submitted')", [P]).length, 0);
  assert.equal(db.query("SELECT id FROM permit_check_targets WHERE project_id = ? AND (application_number <> '' OR permit_number <> '')", [P]).length, 0);
});
await check("an incident on a pass that is already gone is audited all the same (withdrawn: false)", async () => {
  const P = fx.newProject();
  await runLearn(P, undefined, undefined, [{ passId: "gone-pass", phase: "before", why: ["x"], where: `${ORIGIN}/permits/sfjsp` }]);
  const a = fx.audits("portal.info_page_pass_incident").filter((x) => JSON.parse(x.details).passId === "gone-pass");
  assert.equal(a.length, 1);
  assert.equal(JSON.parse(a[0].details).withdrawn, false);
});

// ── DELETE PROJECT ───────────────────────────────────────────────────────────────────────────────
await check("deleting the project a page was verified on deletes its candidates and withdraws that pass (audited with no project)", async () => {
  const { P, passId } = await verifiedPage("Deleted Project Page");
  fx.repo.deleteProject(db, P);
  assert.equal(db.query("SELECT id FROM portal_info_page_candidates WHERE project_id = ?", [P]).length, 0);
  assert.equal(db.query("SELECT id FROM portal_info_page_passes WHERE id = ?", [passId]).length, 0);
  const a = fx.audits("portal.info_page_pass_withdrawn").filter((x) => JSON.parse(x.details).passId === passId);
  assert.equal(a.length, 1);
  assert.equal(a[0].project_id, null);
  assert.match(JSON.parse(a[0].details).reason, /project it was verified on was deleted/);
  assert.ok(IP.liveInfoPagePasses(db).some((p) => p.id === pass2), "another project's pass was touched");
});

// ── PRIOR PROGRESS ───────────────────────────────────────────────────────────────────────────────
await check("prior progress: a portal run on the same side that recorded a number or was submitted refuses; the other side does not", () => {
  const P = fx.newProject();
  const url = `${ORIGIN}/permits/sfjsp`;
  db.run("INSERT INTO portal_runs (id, project_id, run_type, status, started_at, permit_type, confirmation_number) VALUES (?, ?, 'stage', 'failed', '2026-10-15', 'nem', 'NEM-1234')", [`r1-${P}`, P]);
  assert.equal(IP.infoPagePriorProgress(db, P, url, "ahj"), false);
  assert.equal(IP.infoPagePriorProgress(db, P, url, "utility"), true);
  db.run("INSERT INTO portal_runs (id, project_id, run_type, status, started_at, permit_type) VALUES (?, ?, 'stage', 'awaiting_human_submit', '2026-10-15', 'permit')", [`r2-${P}`, P]);
  assert.equal(IP.infoPagePriorProgress(db, P, url, "ahj"), true);
});
await check("prior progress (round 2, P5): a tracking number of this project refuses WHATEVER its portal URL — another host, a blank one or this one; unknown refuses", () => {
  const url = `${ORIGIN}/permits/sfjsp?interviewID=Home`;
  for (const [what, portalUrl] of [["another host", "https://other.example.test/x"], ["a BLANK portal URL (P5)", ""], ["this host", `${ORIGIN}/records/1`]] as const) {
    const P = fx.newProject();
    assert.equal(IP.infoPagePriorProgress(db, P, url, "ahj"), false, `${what}: fresh`);
    db.run("INSERT INTO permit_check_targets (id, project_id, portal_url, application_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [`t-${P}`, P, portalUrl, "26-104455-RS", "2026-10-15", "2026-10-15"]);
    assert.equal(IP.infoPagePriorProgress(db, P, url, "ahj"), true, what);
    assert.equal(IP.infoPagePriorProgress(db, P, url, "utility"), true, `${what}: the table has no side, so both`);
    assert.ok(!JSON.stringify(IP.infoPagePriorProgressReasons(db, P, "ahj")).includes("104455"), "the number is masked in the reasons");
  }
  assert.equal(IP.infoPagePriorProgress(db, fx.newProject(), "not a url", "ahj"), true);
});

// ── PRIOR PROGRESS, ROUND 2: through the real autoLearnPortal (the learner stubbed) ──────────────
const sfjsp = `${ORIGIN}/permits/sfjsp`;
const handedOf = (i: LearnInput | null | undefined) => ({ passes: Array.isArray(i?.infoPagePasses) ? i!.infoPagePasses!.length : -1, priorProgress: i?.infoPagePriorProgress });
const passedResult = (o: Record<string, unknown> = {}) => ({
  ok: false, portalName: "stub", steps: [{ action: "goto", value: `${ORIGIN}/permits/sfjsp?interviewID=Home` }, { action: "fill", note: "Site Address", value: "{{street}}" }],
  reviewScreen: { fields: [], bodyTextSnippet: "" }, finalSubmitRecorded: false, pageCount: 4, pauseReason: null,
  message: "Auto-learn could not finish the wizard.", stopReason: "no_progress", ...o,
});
await check("THE DISCRIMINATOR FLOW (positive control): capture → a person verifies → the SAME project's next learn is handed the pass and priorProgress FALSE (a clean hold is not progress)", async () => {
  const { P, passId } = await verifiedPage("Discriminator Flow Page");
  assert.equal(fx.audits("portal.info_page_learn_started").filter((a) => a.project_id === P).length, 1, "the capture learn's start is on record");
  assert.equal(fx.audits("portal.info_page_learn_clean").filter((a) => a.project_id === P).length, 1, "…and it ended clean (held, untouched)");
  await runLearn(P);
  assert.deepEqual(handedOf(handed as LearnInput), { passes: IP.liveInfoPagePasses(db).length, priorProgress: false });
  assert.ok((handed as LearnInput).infoPagePasses!.some((e) => e.id === passId));
});
await check("B1a / P1 / 'twice': a learn PASSED the verified page, filled fields and failed mid-wizard → the next learn of that project is handed priorProgress TRUE (at most once per project)", async () => {
  const { P, passId } = await verifiedPage("B1a Page");
  scripted = [(input) => { input.onInfoPagePassed?.({ passId, where: sfjsp }); return passedResult({ infoPagePassed: [{ passId, where: sfjsp }] }); }];
  await runLearn(P);
  assert.equal(handedOf(handedAll[0]).priorProgress, false, "the first use was admitted");
  assert.equal(fx.audits("portal.info_page_passed").filter((a) => a.project_id === P).length, 1, "the use is on record ONCE (the callback; settle wrote no duplicate)");
  assert.equal(JSON.parse(fx.audits("portal.info_page_passed").filter((a) => a.project_id === P)[0].details).scope, "ahj");
  await runLearn(P);
  assert.equal(handedOf(handed as LearnInput).priorProgress, true, "the SAME project's next learn is refused");
  const why = IP.infoPagePriorProgressReasons(db, P, "ahj");
  assert.ok(why.learn.some((w) => /passed a verified information page/.test(w)), JSON.stringify(why));
  assert.ok(why.learn.some((w) => /may have entered data/.test(w)), JSON.stringify(why));
  assert.equal(IP.infoPagePriorProgress(db, P, sfjsp, "utility"), false, "the other side is untouched");
});
await check("B1b / P2: a learn PASSED the page and REACHED REVIEW (the real outcome path) → the next learn is handed priorProgress TRUE", async () => {
  const { P, passId } = await verifiedPage("B1b Page");
  scripted = [(input) => { input.onInfoPagePassed?.({ passId, where: sfjsp }); return passedResult({
    ok: true, reachedReview: true, filledSomething: true, stopReason: undefined, message: "Human review required. Auto-learn reached the review screen after 4 page(s).",
    steps: [{ action: "goto", value: `${ORIGIN}/permits/sfjsp?interviewID=Home` }, { action: "fill", note: "Site Address", value: "{{street}}", selector: { css: "#addr" } }, { action: "stopForReview", note: "review" }],
    reviewScreen: { fields: [{ label: "Site Address", value: "1 Test St" }], bodyTextSnippet: "Review your application" }, infoPagePassed: [{ passId, where: sfjsp }] }); }];
  await runLearn(P);
  const outcomes = db.query<{ action: string }>("SELECT action FROM audit_logs WHERE project_id = ? AND action LIKE 'portal.auto_learn%'", [P]).map((r) => r.action);
  await runLearn(P);
  assert.equal(handedOf(handed as LearnInput).priorProgress, true, JSON.stringify(outcomes));
});
await check("a learn that never passed a page but did NOT end clean (it entered data, then failed) is progress too", async () => {
  const { P } = await verifiedPage("Unclean Page");
  scripted = [() => passedResult()];
  await runLearn(P);
  assert.equal(handedOf(handedAll[0]).priorProgress, false);
  await runLearn(P);
  assert.equal(handedOf(handed as LearnInput).priorProgress, true);
});
await check("P3 / B2 — THE HEADED RETRY IS ASKED AFRESH: attempt 1 passed the page (reported through the callback) and hit a bot wall → attempt 2 is handed NO pass and priorProgress TRUE, and attempt 1's use is on record", async () => {
  const { P, passId } = await verifiedPage("B2 Page");
  const wall = "403 Forbidden. Attention Required — checking your browser.";
  scripted = [
    (input) => { input.onInfoPagePassed?.({ passId, where: sfjsp }); return passedResult({ message: wall, pageCount: 1, infoPagePassed: [{ passId, where: sfjsp }] }); },
    () => passedResult({ message: "headed: still nothing", pageCount: 0 }),
  ];
  await runLearn(P);
  assert.equal(handedAll.length, 2, "the bot wall triggered the headed retry");
  assert.deepEqual(handedOf(handedAll[0]), { passes: IP.liveInfoPagePasses(db).length, priorProgress: false });
  assert.deepEqual(handedOf(handedAll[1]), { passes: 0, priorProgress: true });
  assert.equal(fx.audits("portal.info_page_passed").filter((a) => a.project_id === P && JSON.parse(a.details).passId === passId).length, 1, "attempt 1's use is on record");
  assert.equal(fx.audits("portal.info_page_learn_started").filter((a) => a.project_id === P).length, 3, "capture + both attempts started on record");
});
await check("P3 / B2 — the same when attempt 1's use reaches the backend only in its RESULT (no callback): attempt 2 is still refused, and the use is recorded once", async () => {
  const { P, passId } = await verifiedPage("B2 Result Page");
  scripted = [
    () => passedResult({ message: "403 Forbidden — access denied", pageCount: 1, infoPagePassed: [{ passId, where: sfjsp }] }),
    () => passedResult({ message: "headed: still nothing", pageCount: 0 }),
  ];
  await runLearn(P);
  assert.equal(handedAll.length, 2);
  assert.deepEqual(handedOf(handedAll[1]), { passes: 0, priorProgress: true });
  assert.equal(fx.audits("portal.info_page_passed").filter((a) => a.project_id === P && JSON.parse(a.details).passId === passId).length, 1);
});
await check("P3 — a bot-blocked attempt 1 that passed NOTHING still leaves attempt 2 refused (fail closed: it did not end held, untouched, at an information page)", async () => {
  const { P } = await verifiedPage("B2 Nothing Page");
  scripted = [() => passedResult({ message: "403 Forbidden — access denied", pageCount: 0, steps: [] }), () => passedResult({ message: "headed: still nothing", pageCount: 0 })];
  await runLearn(P);
  assert.equal(handedAll.length, 2);
  assert.equal(handedOf(handedAll[0]).priorProgress, false);
  assert.equal(handedOf(handedAll[1]).priorProgress, true);
  assert.ok(handedOf(handedAll[1]).passes > 0, "the pass is still handed (only prior progress refuses)");
});
await check("a learn that THROWS after the pass was used: the use is on record, the pass is WITHDRAWN as an after-click incident (the page after it was never judged)", async () => {
  const { P, passId } = await verifiedPage("Throw Page");
  scripted = [(input) => { input.onInfoPagePassed?.({ passId, where: sfjsp }); throw new Error("browser crashed"); }];
  await assert.rejects(() => runLearn(P), /Portal learn failed/);
  assert.equal(fx.audits("portal.info_page_passed").filter((a) => a.project_id === P && JSON.parse(a.details).passId === passId).length, 1);
  assert.ok(!IP.liveInfoPagePasses(db).some((p) => p.id === passId), "withdrawn");
  const inc = fx.audits("portal.info_page_pass_incident").filter((a) => JSON.parse(a.details).passId === passId);
  assert.equal(inc.length, 1);
  assert.equal(JSON.parse(inc[0].details).phase, "after");
  assert.equal(IP.infoPagePriorProgress(db, P, sfjsp, "ahj"), true);
});
await check("P4: a stage run INTERRUPTED (recoverInterruptedPortalRuns: 'the portal may already hold a draft or a filing') refuses on its side", async () => {
  const { recoverInterruptedPortalRuns } = await import("../src/repository");
  const P = fx.newProject();
  db.run("INSERT INTO portal_runs (id, project_id, run_type, status, started_at, permit_type, runner) VALUES (?, ?, 'prepare_submit', 'running', '2026-10-15', 'structural', 'gone-runner')", [`ri-${P}`, P]);
  assert.equal(IP.infoPagePriorProgress(db, P, sfjsp, "ahj"), false, "a RUNNING row is this stage's own: not progress");
  recoverInterruptedPortalRuns(db, { projectId: P, isAlive: () => false });
  assert.equal(String(db.get<{ status: string }>("SELECT status FROM portal_runs WHERE id = ?", [`ri-${P}`])!.status), "interrupted");
  assert.equal(IP.infoPagePriorProgress(db, P, sfjsp, "ahj"), true);
  assert.equal(IP.infoPagePriorProgress(db, P, sfjsp, "utility"), false);
});
await check("P6: a submission and a portal run PAUSED FOR A PERSON refuse on their side; a FAILED stage (a held self-seed) does not", async () => {
  const P = fx.newProject();
  db.run("INSERT INTO portal_runs (id, project_id, run_type, status, started_at, permit_type) VALUES (?, ?, 'prepare_submit', 'failed', '2026-10-15', 'structural')", [`rf-${P}`, P]);
  db.run("INSERT INTO submissions (id, project_id, submission_type, permit_type, status, created_at) VALUES (?, ?, 'portal', 'structural', 'failed', '2026-10-15')", [`sf-${P}`, P]);
  assert.equal(IP.infoPagePriorProgress(db, P, sfjsp, "ahj"), false, "a failed stage is not progress (the capture's stage fails)");
  db.run("INSERT INTO submissions (id, project_id, submission_type, permit_type, status, created_at) VALUES (?, ?, 'portal', 'structural', 'paused_for_human', '2026-10-15')", [`sp-${P}`, P]);
  assert.equal(IP.infoPagePriorProgress(db, P, sfjsp, "ahj"), true, "submission paused_for_human");
  const Q = fx.newProject();
  db.run("INSERT INTO portal_runs (id, project_id, run_type, status, started_at, permit_type) VALUES (?, ?, 'prepare_submit', 'paused_for_human', '2026-10-15', 'structural')", [`rp-${Q}`, Q]);
  assert.equal(IP.infoPagePriorProgress(db, Q, sfjsp, "ahj"), true, "portal run paused_for_human");
  const R = fx.newProject();
  db.run("INSERT INTO portal_runs (id, project_id, run_type, status, started_at, permit_type) VALUES (?, ?, 'prepare_submit', 'some_future_status', '2026-10-15', 'structural')", [`ru-${R}`, R]);
  assert.equal(IP.infoPagePriorProgress(db, R, sfjsp, "ahj"), true, "a status not known here refuses");
});
await check("an interrupted staging JOB of this project refuses (side unknown: both sides)", async () => {
  const P = fx.newProject();
  db.run("INSERT INTO job_queue (id, job_type, payload, status, project_id, created_at, error) VALUES (?, 'prepare_submission', '{}', 'failed', ?, '2026-10-15', ?)",
    [`jq-${P}`, P, "portal run was interrupted — not auto-rerun (staging is not idempotent portal-side); a human must check the portal and re-stage"]);
  assert.equal(IP.infoPagePriorProgress(db, P, sfjsp, "ahj"), true);
  assert.equal(IP.infoPagePriorProgress(db, P, sfjsp, "utility"), true);
});

// ── ALLOW ONCE MORE (round 2) ─────────────────────────────────────────────────────────────────────
await check("ALLOW ONCE MORE: after a use the card shows it (canAllow); a named person's allowance lets the NEXT learn pass once; after that use it stops again", async () => {
  const { P, passId } = await verifiedPage("Allow Page");
  const use = () => { scripted = [(input) => { input.onInfoPagePassed?.({ passId, where: sfjsp }); return passedResult({ infoPagePassed: [{ passId, where: sfjsp }] }); }]; };
  use();
  await runLearn(P);
  const st = IP.listInfoPageProjectState(db, P);
  assert.equal(st.length, 1);
  assert.equal(st[0].scope, "ahj");
  assert.equal(st[0].passed.length, 1);
  assert.equal(st[0].canAllow, true, JSON.stringify(st[0]));
  IP.allowInfoPagePassOnceMore(db, P, "ahj", { by: "Pat Allower", userId: "" });
  assert.deepEqual(IP.infoPagePriorProgressReasons(db, P, "ahj"), { hard: [], learn: [] });
  assert.equal(IP.listInfoPageProjectState(db, P).length, 0, "nothing since the allowance");
  use();
  await runLearn(P);
  assert.equal(handedOf(handedAll[0]).priorProgress, false, "allowed once more");
  await runLearn(P);
  assert.equal(handedOf(handed as LearnInput).priorProgress, true, "…and only once");
  const a = fx.audits("portal.info_page_pass_allowed_again").filter((x) => x.project_id === P);
  assert.equal(a.length, 1);
  assert.equal(a[0].actor_name, "Pat Allower");
});
await check("ALLOW ONCE MORE is refused (409, nothing written) with a HARD reason (a paused submission), with nothing to allow, or a bad side (400)", async () => {
  const { P, passId } = await verifiedPage("Allow Hard Page");
  scripted = [(input) => { input.onInfoPagePassed?.({ passId, where: sfjsp }); return passedResult({ infoPagePassed: [{ passId, where: sfjsp }] }); }];
  await runLearn(P);
  db.run("INSERT INTO submissions (id, project_id, submission_type, permit_type, status, created_at) VALUES (?, ?, 'portal', 'structural', 'paused_for_human', '2026-10-15')", [`sh-${P}`, P]);
  assert.equal(IP.listInfoPageProjectState(db, P)[0].canAllow, false);
  expect409(() => IP.allowInfoPagePassOnceMore(db, P, "ahj", { by: "Pat Allower", userId: "" }), /cannot be allowed again here/);
  expect409(() => IP.allowInfoPagePassOnceMore(db, fx.newProject(), "ahj", { by: "Pat Allower", userId: "" }), /No verified information page was passed or held/);
  assert.throws(() => IP.allowInfoPagePassOnceMore(db, P, "nem", { by: "Pat Allower", userId: "" }), (e: { status?: number }) => e.status === 400);
  assert.equal(fx.audits("portal.info_page_pass_allowed_again").filter((x) => x.project_id === P).length, 0);
});
await check("HELD AT A VERIFIED PAGE by prior progress: the learn reports it, the backend records it, and the card offers the allowance", async () => {
  const { P, passId } = await verifiedPage("Held Verified Page");
  scripted = [() => passedResult()];
  await runLearn(P);
  scripted = [() => passedResult({ stopReason: "backstop_abort", message: "HELD AT A VERIFIED INFORMATION PAGE: …", infoPageHeldVerified: [{ passId, where: sfjsp, why: ["this project already made progress on this portal"] }] })];
  const r = await runLearn(P);
  assert.equal(handedOf(handed as LearnInput).priorProgress, true);
  assert.match(String(r.message), /allow it once more/);
  const st = IP.listInfoPageProjectState(db, P);
  assert.equal(st.length, 1);
  assert.equal(st[0].held.length, 1);
  assert.equal(st[0].passed.length, 0);
  assert.equal(st[0].canAllow, true);
});
await check("prior progress: a staged submission on the same side refuses; one on the other side does not", () => {
  const P = fx.newProject();
  const url = `${ORIGIN}/permits/sfjsp`;
  db.run("INSERT INTO submissions (id, project_id, submission_type, permit_type, status, created_at) VALUES (?, ?, 'portal', 'nem', 'awaiting_human_submit', '2026-10-15')", [`s1-${P}`, P]);
  assert.equal(IP.infoPagePriorProgress(db, P, url, "ahj"), false);
  assert.equal(IP.infoPagePriorProgress(db, P, url, "utility"), true);
  db.run("INSERT INTO submissions (id, project_id, submission_type, permit_type, status, created_at) VALUES (?, ?, 'portal', 'structural', 'submitted', '2026-10-15')", [`s2-${P}`, P]);
  assert.equal(IP.infoPagePriorProgress(db, P, url, "ahj"), true);
});

// ── ROUTES ───────────────────────────────────────────────────────────────────────────────────────
// Everything the routes need is written now; the in-process handle closes before a server opens it.
const routeP = fx.newProject();
await runLearn(routeP, capture(material((m) => { m.title = "Route Info Page"; })));
const routeCid = String(cand(routeP)[0].id);
const routeIdentity = String(cand(routeP)[0].identity_sha256);
const authP = fx.newProject();
await runLearn(authP, capture(material((m) => { m.title = "Auth Info Page"; })));
const authCid = String(cand(authP)[0].id);
const authIdentity = String(cand(authP)[0].identity_sha256);
// Round 2: two projects that PASSED a verified page once (so the card offers "Allow once more").
const usedOnce = async (title: string): Promise<string> => {
  const { P, passId } = await verifiedPage(title);
  scripted = [(input) => { input.onInfoPagePassed?.({ passId, where: sfjsp }); return passedResult({ infoPagePassed: [{ passId, where: sfjsp }] }); }];
  await runLearn(P);
  assert.equal(IP.listInfoPageProjectState(db, P)[0]?.canAllow, true);
  return P;
};
const allowRouteP = await usedOnce("Allow Route Page");
const allowAuthP = await usedOnce("Allow Auth Page");
const { setUserPassword } = await import("../src/auth");
const { grantProduct } = await import("../src/entitlements");
db.run("INSERT INTO orgs (id, name, edition, created_at) VALUES ('org-b', 'Org B', 'full', '2026-10-15')");
grantProduct(db, "org-b", "autopilot");
db.run("INSERT INTO users (id, name, email, role, color, active, created_at, org_id) VALUES ('u-super', 'Sam Superadmin', 'super@info.test', 'superadmin', '#000', 1, '2026-10-15', 'org-default')");
setUserPassword(db, "u-super", "info-test-password-1");
db.run("INSERT INTO users (id, name, email, role, color, active, created_at, org_id) VALUES ('u-admin', 'Ada Orgadmin', 'admin@info.test', 'admin', '#000', 1, '2026-10-15', 'org-default')");
setUserPassword(db, "u-admin", "info-test-password-1");
db.run("INSERT INTO users (id, name, email, role, color, active, created_at, org_id) VALUES ('u-other', 'Otto Otherorg', 'other@info.test', 'admin', '#000', 1, '2026-10-15', 'org-b')");
setUserPassword(db, "u-other", "info-test-password-1");
const dbPath = String(process.env.AUTOPILOT_DB_PATH);
db.close();

await check("v50 replays after its schema_meta row is deleted (CREATE … IF NOT EXISTS; nothing lost)", async () => {
  const dbMod = await import("../src/db");
  const before = await (async () => { const d = await dbMod.openDatabase(); try { const n = d.query("SELECT id FROM portal_info_page_candidates").length; d.run("DELETE FROM schema_meta WHERE version >= 50"); return n; } finally { d.close(); } })();
  const d = await dbMod.openDatabase();
  try {
    assert.equal(Number(d.get<{ v: number }>("SELECT MAX(version) AS v FROM schema_meta")!.v) >= 50, true);
    assert.equal(d.query("SELECT id FROM portal_info_page_candidates").length, before);
    assert.equal(d.query("SELECT name FROM sqlite_master WHERE name LIKE '%info_page%' AND name NOT LIKE 'sqlite_%'").length, 6);
  } finally { d.close(); }
});

const stop = (server: ChildProcess): void => { try { process.kill(-server.pid!, "SIGKILL"); } catch { try { server.kill("SIGKILL"); } catch { /* gone */ } } };
async function boot(port: number, auth: boolean): Promise<ChildProcess> {
  const env: Record<string, string | undefined> = {
    ...process.env, AUTOPILOT_DB_PATH: dbPath, PORT: String(port), AUTOPILOT_AUTO_START: "0", SEED_TEST_INSTALLER: "false", MONITOR_INTERVAL_MINUTES: "0",
    LOG_LEVEL: "warn", ANTHROPIC_API_KEY: "", CODE_RESEARCH: "off", SESSION_ENCRYPTION_KEY: "unit-test-key-not-a-real-secret",
    AUTH_ENABLED: auth ? "true" : "false", ADMIN_EMAIL: "seed@info.test", ADMIN_PASSWORD: "info-test-password-1", NO_PROXY: "*", no_proxy: "*",
  };
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
  const server = spawn(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "backend/src/server.ts")], {
    env: env as NodeJS.ProcessEnv, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  let log = "";
  server.stdout?.on("data", (d) => { log += String(d); });
  server.stderr?.on("data", (d) => { log += String(d); });
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return server; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  stop(server);
  throw new Error(`server never came up:\n${log.slice(-1500)}`);
}
/** One request with full control of Host / Origin / Sec-Fetch-Site (fetch forbids setting Host). */
const call = (port: number, method: string, p: string, o: { body?: unknown; headers?: Record<string, string>; json?: boolean } = {}): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> =>
  new Promise((resolve, reject) => {
    const body = o.body === undefined ? undefined : (o.json === false ? String(o.body) : JSON.stringify(o.body));
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: {
      ...(body !== undefined ? { "content-type": o.json === false ? "application/x-www-form-urlencoded" : "application/json", "content-length": Buffer.byteLength(body) } : {}),
      ...(o.headers ?? {}),
    } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
const readDb = async <T>(fn: (d: typeof db) => T): Promise<T> => {
  const dbMod = await import("../src/db");
  const d = await dbMod.openDatabase();
  try { return fn(d); } finally { d.close(); }
};

{
  const PORT = 5340 + Math.floor(Math.random() * 15);
  const server = await boot(PORT, false);
  const same = { "sec-fetch-site": "same-origin", origin: `http://127.0.0.1:${PORT}` };
  const verifyUrl = `/api/projects/${routeP}/info-page-candidates/${routeCid}/verify`;
  try {
    await check("auth off: GET candidates lists the card (no screenshot bytes) and the screenshot route serves the PNG", async () => {
      const r = await call(PORT, "GET", `/api/projects/${routeP}/info-page-candidates`);
      assert.equal(r.status, 200, r.text.slice(0, 200));
      const j = JSON.parse(r.text);
      assert.equal(j.candidates[0].id, routeCid);
      assert.ok(!r.text.includes("screenshot_png"));
      const s = await call(PORT, "GET", `/api/projects/${routeP}/info-page-candidates/${routeCid}/screenshot`);
      assert.equal(s.status, 200);
      assert.equal(s.headers["content-type"], "image/png");
    });
    await check("auth off: a CROSS-ORIGIN verify is 403 and writes nothing", async () => {
      const r = await call(PORT, "POST", verifyUrl, { body: { identitySha256: routeIdentity, verifiedBy: "Pat Synthetic" }, headers: { origin: "http://evil.example", "sec-fetch-site": "cross-site" } });
      assert.equal(r.status, 403, r.text);
      assert.equal(await readDb((d) => d.query("SELECT id FROM portal_info_page_passes WHERE identity_sha256 = ?", [routeIdentity]).length), 0);
    });
    await check("auth off: a form-encoded (non-JSON) verify is 415", async () => {
      const r = await call(PORT, "POST", verifyUrl, { body: `identitySha256=${routeIdentity}&verifiedBy=Pat`, json: false, headers: same });
      assert.equal(r.status, 415, r.text);
    });
    await check("auth off: a DNS-rebinding Host (same-origin to itself, but not 127.0.0.1 / localhost) is 403", async () => {
      const r = await call(PORT, "POST", verifyUrl, { body: { identitySha256: routeIdentity, verifiedBy: "Pat Synthetic" }, headers: { host: `rebind.example:${PORT}`, origin: `http://rebind.example:${PORT}`, "sec-fetch-site": "same-origin" } });
      assert.equal(r.status, 403, r.text);
    });
    await check("auth off: no name, a blank one, 'operator', 'admin' or 'bot' is a 400", async () => {
      for (const n of [undefined, "  ", "operator", "admin", "bot"]) {
        const r = await call(PORT, "POST", verifyUrl, { body: { identitySha256: routeIdentity, verifiedBy: n }, headers: same });
        assert.equal(r.status, 400, `${n}: ${r.text}`);
      }
    });
    await check("auth off: a stale identity is a 409", async () => {
      const r = await call(PORT, "POST", verifyUrl, { body: { identitySha256: sha256Hex("x"), verifiedBy: "Pat Synthetic" }, headers: same });
      assert.equal(r.status, 409, r.text);
    });
    let routePass = "";
    await check("auth off: a named person's same-origin verify writes the pass (extra body fields ignored)", async () => {
      const r = await call(PORT, "POST", verifyUrl, { body: { identitySha256: routeIdentity, verifiedBy: "Pat Synthetic", origin: "https://evil.example", controlName: "x" }, headers: { origin: `http://localhost:${PORT}`, host: `localhost:${PORT}` } });
      assert.equal(r.status, 200, r.text);
      routePass = JSON.parse(r.text).passId;
      const row = await readDb((d) => d.get<Record<string, unknown>>("SELECT * FROM portal_info_page_passes WHERE id = ?", [routePass]));
      assert.equal(row?.verified_by, "Pat Synthetic");
      assert.equal(row?.origin, ORIGIN);
    });
    await check("auth off: the shared list (GET /api/info-page-passes) shows it — names and places only", async () => {
      const r = await call(PORT, "GET", "/api/info-page-passes");
      assert.equal(r.status, 200);
      assert.ok(r.text.includes(routePass));
      assert.ok(!r.text.includes("Pat Synthetic") && !r.text.includes(routeP) && !r.text.includes("Permit Tech"), r.text.slice(0, 400));
    });
    await check("auth off: withdraw needs a reason (400), then stamps it (same origin)", async () => {
      const u = `/api/info-page-passes/${routePass}/withdraw`;
      const none = await call(PORT, "POST", u, { body: { withdrawnBy: "Pat Synthetic" }, headers: same });
      assert.equal(none.status, 400, none.text);
      const cross = await call(PORT, "POST", u, { body: { withdrawnBy: "Pat Synthetic", reason: "x" }, headers: { origin: "http://evil.example" } });
      assert.equal(cross.status, 403, cross.text);
      const ok = await call(PORT, "POST", u, { body: { withdrawnBy: "Pat Synthetic", reason: "the page changed" }, headers: same });
      assert.equal(ok.status, 200, ok.text);
      assert.ok(JSON.parse(ok.text).passes.every((p: { id: string; status: string }) => p.id !== routePass));
    });
    await check("auth off (round 2): GET candidates carries the project's state — the page it passed once, and canAllow", async () => {
      const r = await call(PORT, "GET", `/api/projects/${allowRouteP}/info-page-candidates`);
      assert.equal(r.status, 200, r.text.slice(0, 200));
      const st = JSON.parse(r.text).projectState;
      assert.equal(st.length, 1);
      assert.equal(st[0].scope, "ahj");
      assert.equal(st[0].canAllow, true);
    });
    await check("auth off (round 2): ALLOW ONCE MORE is guarded like verify — cross-origin 403, form-encoded 415, a rebinding Host 403, no name / 'operator' 400 — and writes nothing until a named person's same-origin JSON", async () => {
      const u = `/api/projects/${allowRouteP}/info-page-allow-once-more`;
      const allowed = () => readDb((d) => d.query("SELECT id FROM audit_logs WHERE project_id = ? AND action = 'portal.info_page_pass_allowed_again'", [allowRouteP]).length);
      assert.equal((await call(PORT, "POST", u, { body: { scope: "ahj", allowedBy: "Pat Synthetic" }, headers: { origin: "http://evil.example", "sec-fetch-site": "cross-site" } })).status, 403);
      assert.equal((await call(PORT, "POST", u, { body: "scope=ahj&allowedBy=Pat", json: false, headers: same })).status, 415);
      assert.equal((await call(PORT, "POST", u, { body: { scope: "ahj", allowedBy: "Pat Synthetic" }, headers: { host: `rebind.example:${PORT}`, origin: `http://rebind.example:${PORT}`, "sec-fetch-site": "same-origin" } })).status, 403);
      for (const n of [undefined, "operator"]) assert.equal((await call(PORT, "POST", u, { body: { scope: "ahj", allowedBy: n }, headers: same })).status, 400, String(n));
      assert.equal(await allowed(), 0);
      const ok = await call(PORT, "POST", u, { body: { scope: "ahj", allowedBy: "Pat Synthetic" }, headers: same });
      assert.equal(ok.status, 200, ok.text);
      assert.equal(await allowed(), 1);
      assert.equal(JSON.parse(ok.text).projectState.length, 0, "nothing since the allowance");
      const again = await call(PORT, "POST", u, { body: { scope: "ahj", allowedBy: "Pat Synthetic" }, headers: same });
      assert.equal(again.status, 409, again.text);
    });
  } finally { stop(server); }
}

{
  const PORT = 5360 + Math.floor(Math.random() * 15);
  const server = await boot(PORT, true);
  const login = async (email: string): Promise<string> => {
    const r = await call(PORT, "POST", "/api/auth/login", { body: { email, password: "info-test-password-1" } });
    assert.equal(r.status, 200, r.text);
    return String((r.headers["set-cookie"] ?? [])[0] ?? "").split(";")[0];
  };
  const same = { "sec-fetch-site": "same-origin", origin: `http://127.0.0.1:${PORT}` };
  const verifyUrl = `/api/projects/${authP}/info-page-candidates/${authCid}/verify`;
  try {
    await check("auth on: signed out, verify is 401 and writes nothing", async () => {
      const r = await call(PORT, "POST", verifyUrl, { body: { identitySha256: authIdentity, verifiedBy: "Forged Name" }, headers: same });
      assert.equal(r.status, 401, r.text);
    });
    await check("auth on: an ORG ADMIN (not superadmin) is 403 on verify — one verification relaxes rule 1 for every tenant", async () => {
      const cookie = await login("admin@info.test");
      const r = await call(PORT, "POST", verifyUrl, { body: { identitySha256: authIdentity }, headers: { ...same, cookie } });
      assert.equal(r.status, 403, r.text);
      assert.equal(await readDb((d) => d.query("SELECT id FROM portal_info_page_passes WHERE identity_sha256 = ?", [authIdentity]).length), 0);
    });
    await check("auth on: ANOTHER ORG's admin gets 404 for this project's candidates (rule 6), never 403", async () => {
      const cookie = await login("other@info.test");
      const g = await call(PORT, "GET", `/api/projects/${authP}/info-page-candidates`, { headers: { cookie } });
      assert.equal(g.status, 404, g.text);
      const d = await call(PORT, "POST", `/api/projects/${authP}/info-page-candidates/${authCid}/dismiss`, { body: {}, headers: { ...same, cookie } });
      assert.equal(d.status, 404, d.text);
    });
    await check("auth on: the SUPERADMIN verifies; a body verifiedBy is ignored (the session's name is recorded)", async () => {
      const cookie = await login("super@info.test");
      const r = await call(PORT, "POST", verifyUrl, { body: { identitySha256: authIdentity, verifiedBy: "Forged Name" }, headers: { ...same, cookie } });
      assert.equal(r.status, 200, r.text);
      const row = await readDb((d) => d.get<Record<string, unknown>>("SELECT verified_by, verified_by_user_id FROM portal_info_page_passes WHERE identity_sha256 = ?", [authIdentity]));
      assert.equal(row?.verified_by, "Sam Superadmin");
      assert.equal(row?.verified_by_user_id, "u-super");
    });
    await check("auth on (round 2): ALLOW ONCE MORE — signed out 401, an ORG ADMIN 403, ANOTHER ORG's admin 404 (rule 6); the SUPERADMIN allows, recorded under the session's name", async () => {
      const u = `/api/projects/${allowAuthP}/info-page-allow-once-more`;
      assert.equal((await call(PORT, "POST", u, { body: { scope: "ahj", allowedBy: "Forged Name" }, headers: same })).status, 401);
      const admin = await login("admin@info.test");
      assert.equal((await call(PORT, "POST", u, { body: { scope: "ahj" }, headers: { ...same, cookie: admin } })).status, 403);
      const other = await login("other@info.test");
      assert.equal((await call(PORT, "POST", u, { body: { scope: "ahj" }, headers: { ...same, cookie: other } })).status, 404);
      const zero = await readDb((d) => d.query("SELECT id FROM audit_logs WHERE project_id = ? AND action = 'portal.info_page_pass_allowed_again'", [allowAuthP]).length);
      assert.equal(zero, 0);
      const sup = await login("super@info.test");
      const ok = await call(PORT, "POST", u, { body: { scope: "ahj", allowedBy: "Forged Name" }, headers: { ...same, cookie: sup } });
      assert.equal(ok.status, 200, ok.text);
      const row = await readDb((d) => d.get<{ actor_name: string }>("SELECT actor_name FROM audit_logs WHERE project_id = ? AND action = 'portal.info_page_pass_allowed_again'", [allowAuthP]));
      assert.equal(row?.actor_name, "Sam Superadmin");
    });
  } finally { stop(server); }
}

finish("infoPages");
