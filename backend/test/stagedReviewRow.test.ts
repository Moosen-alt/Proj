// #436 PR1 — THE STAGED REVIEW ROW: ONE WRITER, FROM THE IN-MEMORY STAGE RESULT, AND ITS PICTURE ROUTE.
//
// A plain NEM Stage that stops at review reads its draft (portal-bot reviewDigest.ts) and hands the
// reading back IN MEMORY as the result's top-level `stagedReview`; stagedReviews.recordStagedReview is
// the one writer, and the masked picture is served by /api/projects/:id/staged-reviews/:runId/screenshot.
// Pinned on the REAL prepareSubmission (browser stubbed) and a real server:
//   (a) ONE WRITER (source scan): exactly one INSERT INTO portal_staged_reviews and every UPDATE of it in
//       stagedReviews.ts; that module never reads result_json; repository records only the capture it
//       TOOK off the in-memory result (takeStagedReviewCapture), once.
//   (b) THE STAGE RECORDS THE ROW AT ITS REVIEW STOP: a NEM stage passes the replay `stagedReview` (with
//       the project's secrets); the row names this run, the recipe and its exact steps' signature, the
//       draft id; result_json never carries the reading; the card shows it (masked picture URL).
//   (c) a reading that is NOT the result's top-level field (only inside a step's data) records nothing,
//       and is stripped from result_json too.
//   (d) A FORGED result_json CHANGES NOTHING: a `stagedReview` written into a staged run's result_json
//       makes no row, no card view, and no picture.
//   (e) a later Stage of the track supersedes the earlier row at its start (the card shows the new one).
//   (f) a trackless (permit) stage never asks for the reading and records no row, whatever comes back.
//   (g) THE ROUTE (rule 6): the project's own run → 200, the masked file's bytes; the same run id under
//       ANOTHER project → 404; no row → 404; a row naming a file outside the staged-review folder → 404;
//       the run's portal_runs.screenshots_path (the unmasked outcome shot) is never served by it.
//   (h) THE DRAFT ID AND LINK ARE KEPT EXACTLY: ProjectId 204411 / 42199 / AB12345CDE and an Accela
//       capID row hold the portal's own id and link, approvable; an id the link does not carry, or a
//       link with session material, is refused (both ""), never masked.
//   (i) a picture beside a review page the reader could not read, or a reading not hashed, is never
//       kept (the row and the card name none; this run's own file is deleted).
//
// KILL TESTS (run by hand on this tree):
//   K1 repository: record from JSON.parse(result_json).stagedReview instead of the taken capture → (d) fails.
//   K2 stagedReviewScreenshotFile: drop `AND project_id = ?` → (g) "another project" fails (200).
//   K3 takeStagedReviewCapture: do not strip steps[].data → (c) fails (result_json carries it).
//   K4 repository: drop the supersede at run start and in the writer → (e) fails.
//   K5 recordStagedReview: store scrub(draftId) / scrub(reviewLink) again (the pre-fix display
//      redaction) → (h) fails: "**4411", "*****", "AB*****CDE".
//   K6 recordStagedReview: keep servableShot(c.screenshotPath) whatever the review section reads → (i) fails.
//
// Run: npx tsx backend/test/stagedReviewRow.test.ts
import "./_isolate"; // FIRST
import { REPO } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { setupStageFixture, check, finish } from "./_stageFixture";

process.env.SESSION_ENCRYPTION_KEY = "staged-review-row-test-key-not-a-secret";
const fx = await setupStageFixture("staged-review-row");
const { db, repo, recipes } = fx;
const tracksMod = await import("../src/submittalTracks");
const { stagedReviewShotsDir } = await import("../src/statePaths");
const digest = await import("../../portal-bot/src/reviewDigest");

const NEM_URL = "https://pgenm.powerclerk.example/MvcAccount/Login";
const REVIEW_URL = "https://pgenm.powerclerk.example/MvcProjects/EditForm?ProjectId=4417&FormId=9";
const STEPS = [...fx.fills(2), fx.REVIEW, fx.FINAL];
const nemRecipe = recipes.savePortalRecipeSteps(db,
  recipes.startPortalRecording(db, { scopeType: "utility", state: "OR", utility: "PGE", portalUrl: NEM_URL, portalPlatform: "powerclerk", createdBy: "test" }).id,
  STEPS, { status: "complete", notes: "test" });

// A masked picture, as the adapter writes it (the bytes are the fixture's own).
fs.mkdirSync(stagedReviewShotsDir(), { recursive: true });
const shotFor = (tag: string): string => {
  const p = path.join(stagedReviewShotsDir(), `staged-review-${tag}.png`);
  fs.writeFileSync(p, Buffer.from(`\x89PNG fixture masked picture ${tag}`, "latin1"));
  return p;
};

/** The capture a real walk of a two-step draft would hand back (the real builder, the real key). */
const captureOf = (tag: string, systemSize = "7.2", reviewUrl = REVIEW_URL) => {
  const r = (items: Array<{ kind: "field" | "line" | "check"; label: string; value: string }>, url = reviewUrl) => ({ title: "Review and Submit", url, items, unreadable: "" });
  const review = r([{ kind: "line", label: "", value: "Review and Submit" }, { kind: "field", label: "System Size (kW DC)", value: systemSize }]);
  const step = r([{ kind: "field", label: "Customer Name", value: "Avery Fenwick" }], REVIEW_URL.replace("FormId=9", "FormId=1"));
  return digest.buildStagedReviewCapture({
    walk: {
      sections: [
        { step: "review", where: "https://pgenm.powerclerk.example/MvcProjects/EditForm", first: review, second: review, unreadable: "" },
        { step: "Customer", where: "https://pgenm.powerclerk.example/MvcProjects/EditForm", first: step, second: step, unreadable: "" },
      ],
      reasons: [], stepsFound: 1, stepsRead: 1, writesBlocked: 0, reviewUrl,
    },
    secrets: [], boundValues: [{ key: "systemSizeDcKw", value: systemSize }], screenshotPath: shotFor(tag),
  });
};
const staged = (extra: Record<string, unknown> = {}) => ({
  portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null,
  steps: [{ ok: true, message: "Opened stub portal." }, { ok: true, message: "Human review required. AUTOMATION HAS STOPPED.", data: { finalSubmitClicked: false } }],
  ...extra,
});
let seenOpts: Record<string, unknown> | null = null;
let nextResult: () => Record<string, unknown> = () => staged();
fx.stubRunner((async (_recipe: unknown, _p: unknown, _v: unknown, _d: unknown, _f: unknown, opts: unknown) => { seenOpts = (opts ?? {}) as Record<string, unknown>; return nextResult() as never; }) as never);

const rowsFor = (pid: string) => db.query<Record<string, unknown>>("SELECT * FROM portal_staged_reviews WHERE project_id = ? ORDER BY created_at, rowid", [pid]);
const nemCard = (pid: string) => tracksMod.getSubmittalTracks(db, repo.getProjectDetail(db, pid).project).find((t) => t.type === "nem")!;
const SRC = path.join(REPO, "backend", "src");

await check("(a) one writer: one INSERT, every UPDATE in stagedReviews.ts, no result_json read there, one call site from the taken capture", () => {
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith(".ts"));
  // Code lines only: a comment that names the statement is not a writer.
  const code = (f: string) => fs.readFileSync(path.join(SRC, f), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
  const hits = (re: RegExp) => files.flatMap((f) => (code(f).match(re) ?? []).map(() => f));
  assert.deepEqual(hits(/INSERT\s+INTO\s+portal_staged_reviews/gi), ["stagedReviews.ts"], "a second writer of portal_staged_reviews");
  assert.ok(hits(/UPDATE\s+portal_staged_reviews/gi).every((f) => f === "stagedReviews.ts"), "portal_staged_reviews is updated outside its module");
  const mod = fs.readFileSync(path.join(SRC, "stagedReviews.ts"), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
  assert.ok(!/result_json/.test(mod), "stagedReviews.ts reads result_json");
  const repoSrc = fs.readFileSync(path.join(SRC, "repository.ts"), "utf8");
  assert.equal((repoSrc.match(/recordStagedReview\(db,/g) ?? []).length, 1, "recordStagedReview is called more than once");
  assert.match(repoSrc, /const stagedCapture = takeStagedReviewCapture\(result\);/);
  assert.match(repoSrc, /capture: stagedCapture,/);
});

let firstPid = "";
let firstRun = "";
await check("(b) the Stage records the row at its review stop, from the in-memory result; result_json never carries it", async () => {
  firstPid = fx.newProject();
  const cap = captureOf("b1");
  assert.ok(cap.approvable, cap.why.join("; "));
  nextResult = () => staged({ stagedReview: cap });
  await repo.prepareSubmission(db, firstPid, "nem");
  const sr = seenOpts?.stagedReview as { secrets?: string[] } | null;
  assert.ok(sr && Array.isArray(sr.secrets), "the NEM replay was not asked for the staged review");
  assert.ok(sr.secrets.includes("1234567890") && sr.secrets.includes("987654321"), "the project's account/meter were not handed to the reader for masking");
  const run = fx.latestRun(firstPid)!;
  firstRun = String(run.id);
  assert.equal(run.status, "awaiting_human_submit");
  const rows = rowsFor(firstPid);
  assert.equal(rows.length, 1, "no row (or more than one)");
  const row = rows[0];
  assert.equal(row.run_id, firstRun);
  assert.equal(row.track, "nem");
  assert.equal(row.recipe_id, nemRecipe.id);
  assert.equal(row.steps_signature, recipes.recipeStepsSignature(STEPS), "the row does not name the exact steps the replay read");
  assert.equal(row.draft_id, "4417");
  assert.equal(Number(row.approvable), 1, String(row.unapprovable_reason));
  assert.equal(row.digest, cap.digest);
  assert.equal(row.key_id, cap.keyId);
  assert.ok(!String(run.result_json).includes("stagedReview") && !String(run.result_json).includes(cap.digest), "result_json carries the reading");
  const view = nemCard(firstPid).stagedReview!;
  assert.ok(view, "the card does not show the staged review");
  assert.equal(view.runId, firstRun);
  assert.equal(view.screenshotUrl, `/api/projects/${firstPid}/staged-reviews/${firstRun}/screenshot`);
  assert.ok(view.fieldReport.some((r) => r.label === "System Size (kW DC)" && r.display === "7.2" && r.source === "systemSizeDcKw"), JSON.stringify(view.fieldReport));
  assert.ok(view.fieldReport.some((r) => r.label === "Customer Name" && r.source === ""), "a value not from a project field is not said so");
});

await check("(c) a reading only inside a step's data records nothing, and is stripped from result_json", async () => {
  const pid = fx.newProject();
  const cap = captureOf("c1");
  nextResult = () => ({ ...staged(), steps: [{ ok: true, message: "Human review required. AUTOMATION HAS STOPPED.", data: { finalSubmitClicked: false, stagedReview: cap } }] });
  await repo.prepareSubmission(db, pid, "nem");
  assert.equal(rowsFor(pid).length, 0, "a reading nested in a step's data was recorded");
  assert.ok(!String(fx.latestRun(pid)!.result_json).includes("stagedReview"), "result_json carries the nested reading");
});

let forgedPid = "";
let forgedRun = "";
await check("(d) a forged result_json changes nothing: no row, no card view, no picture", async () => {
  forgedPid = fx.newProject();
  nextResult = () => staged();
  await repo.prepareSubmission(db, forgedPid, "nem");
  forgedRun = String(fx.latestRun(forgedPid)!.id);
  const forged = { ...captureOf("d1"), screenshotPath: shotFor("d1") };
  db.run("UPDATE portal_runs SET result_json = ? WHERE id = ?", [JSON.stringify({ stagedReview: forged, finalSubmitClicked: false }), forgedRun]);
  assert.equal(rowsFor(forgedPid).length, 0);
  assert.equal(nemCard(forgedPid).stagedReview ?? null, null, "the card shows a reading forged into result_json");
});

await check("(e) a later Stage of the track supersedes the earlier row at its start", async () => {
  nextResult = () => staged({ stagedReview: captureOf("e1", "7.6") });
  await repo.prepareSubmission(db, firstPid, "nem");
  const rows = rowsFor(firstPid);
  assert.equal(rows.length, 2);
  assert.ok(String(rows[0].superseded_at), "the first row was not superseded");
  assert.equal(rows[0].superseded_by, rows[1].run_id);
  assert.equal(String(rows[1].superseded_at), "");
  assert.equal(nemCard(firstPid).stagedReview!.runId, rows[1].run_id);
  // A run that ends any other way still supersedes: the draft may have changed under it.
  nextResult = () => ({ portalName: "stub", ok: false, finalSubmitClicked: false, pauseReason: null, steps: [{ ok: false, message: "Recipe step failed (click — advance): the control went away" }] });
  await repo.prepareSubmission(db, firstPid, "nem").catch(() => null);
  assert.ok(rowsFor(firstPid).every((r) => String(r.superseded_at)), "a failed re-stage left an earlier reading standing");
});

await check("(f) a trackless (permit) stage never asks for the reading and records no row", async () => {
  fx.completeRecipe();
  const pid = fx.newProject();
  nextResult = () => staged({ stagedReview: captureOf("f1") });
  await repo.prepareSubmission(db, pid);
  assert.equal(seenOpts?.stagedReview ?? null, null, "a permit stage was asked for the staged review");
  assert.equal(rowsFor(pid).length, 0);
});

await check("(f2) STAGED_REVIEW_WALK=0: a NEM stage is not asked for the reading (the operator's off switch)", async () => {
  const pid = fx.newProject();
  nextResult = () => staged();
  process.env.STAGED_REVIEW_WALK = "0";
  try { await repo.prepareSubmission(db, pid, "nem"); } finally { delete process.env.STAGED_REVIEW_WALK; }
  assert.equal(seenOpts?.stagedReview ?? null, null, "the switch did not turn the walk off");
});

await check("(h) the draft id and review link are kept EXACTLY (5- and 6-digit ids, letters, Accela) — or refused, never masked", async () => {
  const PC = "https://pgenm.powerclerk.example/MvcProjects/EditForm";
  for (const [url, id] of [
    [`${PC}?ProjectId=204411&FormId=9`, "204411"],
    [`${PC}?ProjectId=42199&FormId=9`, "42199"],
    [`${PC}?ProjectId=AB12345CDE&FormId=9`, "AB12345CDE"],
    ["https://aca.example.gov/Cap/CapEdit.aspx?capID1=26CAP&capID2=00000&capID3=00ABC", "26CAP-00000-00ABC"],
  ] as const) {
    const pid = fx.newProject();
    const cap = captureOf(`h-${id}`, "7.2", url);
    assert.equal(cap.draftId, id, `fixture: the reader did not take ${id} off the link`);
    nextResult = () => staged({ stagedReview: cap });
    await repo.prepareSubmission(db, pid, "nem");
    const row = rowsFor(pid)[0];
    assert.ok(row, `${id}: no row`);
    assert.equal(row.draft_id, id, `${id}: the row's draft id is not the portal's (masked?): ${String(row.draft_id)}`);
    assert.equal(row.review_link, url, `${id}: the row's review link is not the portal's: ${String(row.review_link)}`);
    assert.equal(Number(row.approvable), 1, `${id}: ${String(row.unapprovable_reason)}`);
  }
  // MUST-EXCLUDE: a reading whose id is not the one its own link carries (a forged or confused capture).
  const pid = fx.newProject();
  const cap = { ...captureOf("h-mismatch", "7.2", `${PC}?ProjectId=204411&FormId=9`), draftId: "204412" };
  nextResult = () => staged({ stagedReview: cap });
  await repo.prepareSubmission(db, pid, "nem");
  const row = rowsFor(pid)[0];
  assert.equal(Number(row.approvable), 0, "a draft id the link does not carry was kept approvable");
  assert.equal(row.draft_id, "");
  assert.equal(row.review_link, "");
  assert.match(String(row.unapprovable_reason), /the draft id is not the one the review page's link carries/);
  // MUST-EXCLUDE: a link carrying session material (more than the record's own parameters).
  const pid2 = fx.newProject();
  const cap2 = { ...captureOf("h-session", "7.2", `${PC}?ProjectId=204411&FormId=9`), reviewLink: `${PC}?ProjectId=204411&FormId=9&sessionToken=abc` };
  nextResult = () => staged({ stagedReview: cap2 });
  await repo.prepareSubmission(db, pid2, "nem");
  const row2 = rowsFor(pid2)[0];
  assert.equal(Number(row2.approvable), 0, "a link carrying a session token was kept approvable");
  assert.equal(row2.review_link, "");
  assert.match(String(row2.unapprovable_reason), /not in its kept form/);
});

await check("(i) #436 fix round 1: a picture beside a review page the reader could not read (or a reading not hashed) is never kept", async () => {
  const unreadableCapture = (tag: string) => {
    const bad = { title: "Review and Submit", url: REVIEW_URL, items: [], unreadable: "the page holds 1 closed shadow root(s), whose controls a page script cannot read" };
    return digest.buildStagedReviewCapture({
      walk: { sections: [{ step: "review", where: "https://pgenm.powerclerk.example/MvcProjects/EditForm", first: bad, second: null, unreadable: bad.unreadable }], reasons: [], stepsFound: 0, stepsRead: 0, writesBlocked: 0, reviewUrl: REVIEW_URL },
      secrets: [], screenshotPath: shotFor(tag),
    });
  };
  // Through the real Stage: the row and the card name no picture.
  const pid = fx.newProject();
  const cap = unreadableCapture("i1");
  assert.ok(cap.screenshotPath, "fixture: the capture offers no picture");
  nextResult = () => staged({ stagedReview: cap });
  await repo.prepareSubmission(db, pid, "nem");
  const row = rowsFor(pid)[0];
  assert.ok(row, "no row");
  assert.equal(String(row.screenshot_path), "", `a picture beside an unreadable review page was kept: ${String(row.screenshot_path)}`);
  assert.equal(Number(row.approvable), 0);
  assert.equal(nemCard(pid).stagedReview?.screenshotUrl, "", "the card offers a picture of an unreadable review page");
  // The writer itself: this run's own file is deleted; a reading that is not hashed keeps no picture either.
  const { recordStagedReview } = await import("../src/stagedReviews");
  const own = path.join(stagedReviewShotsDir(), "staged-review-run-i2.png");
  fs.writeFileSync(own, Buffer.from("\x89PNG fixture i2", "latin1"));
  const pid2 = fx.newProject();
  recordStagedReview(db, { runId: "run-i2", projectId: pid2, track: "nem", recipeId: "", stepsSignature: "", capture: { ...unreadableCapture("i2-other"), screenshotPath: own }, secrets: [] });
  assert.equal(String(rowsFor(pid2)[0].screenshot_path), "");
  assert.ok(!fs.existsSync(own), "this run's own picture of an unreadable review page was left on disk");
  const pid3 = fx.newProject();
  const good = captureOf("i3");
  const forged = { ...good, sections: good.sections.map((sec) => ({ ...sec, items: sec.items.map((it) => ({ ...it, mac: "7.2" })) })) };
  recordStagedReview(db, { runId: "run-i3", projectId: pid3, track: "nem", recipeId: "", stepsSignature: "", capture: forged, secrets: [] });
  assert.equal(String(rowsFor(pid3)[0].screenshot_path), "", "a reading that did not come back hashed kept its picture");
  // MUST PASS: a read review page keeps its picture ((b) above, again here by the writer itself).
  const pid4 = fx.newProject();
  recordStagedReview(db, { runId: "run-i4", projectId: pid4, track: "nem", recipeId: "", stepsSignature: "", capture: captureOf("i4"), secrets: [] });
  assert.ok(String(rowsFor(pid4)[0].screenshot_path).endsWith("staged-review-i4.png"), String(rowsFor(pid4)[0].screenshot_path));
});

// ── the route, on a real server ─────────────────────────────────────────────────────────────
// No job is enqueued here: only GETs of the picture route.
// A fresh live row for the route (the earlier rows were superseded by (e)'s failed re-stage).
const routePid = fx.newProject();
nextResult = () => staged({ stagedReview: captureOf("g1") });
await repo.prepareSubmission(db, routePid, "nem");
const routeRun = String(fx.latestRun(routePid)!.id);
const routeShot = String(rowsFor(routePid)[0].screenshot_path);
// The run's own outcome shot (unmasked), which this route must never serve.
const unmasked = path.join(process.cwd(), "unmasked-outcome.png");
fs.writeFileSync(unmasked, Buffer.from("\x89PNG unmasked outcome shot", "latin1"));
db.run("UPDATE portal_runs SET screenshots_path = ? WHERE id = ?", [unmasked, forgedRun]);
const outsidePid = fx.newProject();
nextResult = () => staged({ stagedReview: captureOf("g2") });
await repo.prepareSubmission(db, outsidePid, "nem");
const outsideRun = String(fx.latestRun(outsidePid)!.id);
db.run("UPDATE portal_staged_reviews SET screenshot_path = ? WHERE run_id = ?", [unmasked, outsideRun]);

const dbPath = String(process.env.AUTOPILOT_DB_PATH);
const PORT = 5440 + Math.floor(Math.random() * 15); // never 4173 / 4270
const BASE = `http://127.0.0.1:${PORT}`;
const env: Record<string, string | undefined> = {
  ...process.env, AUTOPILOT_DB_PATH: dbPath, PORT: String(PORT), AUTOPILOT_AUTO_START: "0", SEED_TEST_INSTALLER: "false",
  MONITOR_INTERVAL_MINUTES: "0", LOG_LEVEL: "warn", ANTHROPIC_API_KEY: "", CODE_RESEARCH: "off", BACKGROUND_WORKERS: "off",
  AUTH_ENABLED: "false", NO_PROXY: "*", no_proxy: "*", AUTOPILOT_TEST_SEAMS: "",
};
delete env.PORTAL_ALLOW_FINAL_SUBMIT;
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
const server = spawn(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "backend/src/server.ts")], {
  env: env as NodeJS.ProcessEnv, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout?.on("data", (d) => { serverLog += String(d); });
server.stderr?.on("data", (d) => { serverLog += String(d); });
try {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up yet */ }
    if (i === 89) throw new Error(`server never came up:\n${serverLog.slice(-2000)}`);
    await new Promise((res) => setTimeout(res, 1000));
  }
  const get = (p: string) => fetch(`${BASE}${p}`);

  await check("(g1) the project's own run → 200, exactly the row's masked file", async () => {
    const res = await get(`/api/projects/${routePid}/staged-reviews/${routeRun}/screenshot`);
    assert.equal(res.status, 200, await res.clone().text().catch(() => ""));
    assert.match(String(res.headers.get("content-type")), /image\/png/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), fs.readFileSync(routeShot));
  });
  await check("(g2) rule 6: the same run id under ANOTHER project → 404", async () => {
    const res = await get(`/api/projects/${forgedPid}/staged-reviews/${routeRun}/screenshot`);
    assert.equal(res.status, 404, `MUST-EXCLUDE: another project's picture was served (${res.status})`);
  });
  await check("(g3) no row (a forged result_json, or no such run) → 404; the unmasked outcome shot is never served", async () => {
    assert.equal((await get(`/api/projects/${forgedPid}/staged-reviews/${forgedRun}/screenshot`)).status, 404, "a run with only a forged result_json served a picture");
    assert.equal((await get(`/api/projects/${routePid}/staged-reviews/no-such-run/screenshot`)).status, 404);
  });
  await check("(g4) a row naming a file outside the staged-review folder → 404", async () => {
    assert.equal((await get(`/api/projects/${outsidePid}/staged-reviews/${outsideRun}/screenshot`)).status, 404, "a file outside the staged-review folder was served");
  });
} finally {
  server.kill("SIGTERM");
}

finish("staged-review-row");
