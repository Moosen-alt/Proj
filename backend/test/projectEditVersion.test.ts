// TWO TEAMMATES, ONE PROJECT: A STALE SAVE IS REFUSED, NOT SILENTLY WON (#440, shared server #429).
//
// Project saves were last-write-wins: two people editing the same project on the shared server lost
// one person's change with no message. Now a dashboard save carries the editVersion it loaded, and:
//   (a) a save with the CURRENT version succeeds, writes, and bumps the version;
//   (b) a save with a STALE version is a 409 (details.editConflict) and writes NOTHING — not the
//       row, not the snapshot, not the audit trail, not updated_at, not the version;
//   (c) BACKGROUND DATA WRITERS bump the version and never 409: an update with no expected version
//       (the bill / datasheet reads, intake, the parser, API keys) and raw writes of the data that
//       never touch updated_at (the v51 trigger covers every call site, so a new writer can't forget);
//  (c2) LIFECYCLE writes (status, stage, the share link) do NOT bump it: an editor's save never
//       writes those, and the stage chain writes them for seconds after every save, so bumping on
//       them would refuse the editor's next save for nothing;
//   (d) THE ROUTE, on a real server: PUT /api/projects/:id with a stale expectedVersion → 409 and
//       the DB unchanged; with the current one → 200, bumped, and expectedVersion never lands in the
//       parser snapshot; without one → 200 (unconditional, as before); a malformed one → 400.
//   (e) the migration is idempotent (a replay of v51 leaves one trigger and one column).
//
// KILL TESTS (each turns this file red):
//   K1 repository.updateProject: drop the assertProjectEditVersion call → (b) and (d1) fail.
//   K2 db.ts v51: drop the trigger → (a) "bumps" and (c) fail.
//   K4 db.ts v51: drop the OF column list (bump on every write) → (c2) fails.
//   K3 server.ts PUT: pass the raw body as the payload → (d2) "expectedVersion in the snapshot" fails.
//
// Run: npx tsx backend/test/projectEditVersion.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { REPO } from "./_isolate";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("project-edit-version");
const { db, repo } = fx;
const { HttpError } = await import("../src/httpError");
const { ensureStatusShareToken } = await import("../src/clientNotifier");

type Row = { edit_version: number; parser_json: string; updated_at: string; homeowner_phone?: string };
const row = (pid: string) => db.get<Row>("SELECT edit_version, parser_json, updated_at FROM projects WHERE id = ?", [pid])!;
const snap = (pid: string) => JSON.parse(row(pid).parser_json) as Record<string, unknown>;
const updateAudits = (pid: string) =>
  db.query("SELECT id FROM audit_logs WHERE project_id = ? AND action = 'project.updated_from_parser_snapshot'", [pid]).length;
const versionOf = (pid: string) => repo.getProjectDetail(db, pid).project.editVersion as number;

await check("(a) a save with the current version succeeds, writes, and bumps the version", async () => {
  const pid = fx.newProject();
  const v0 = versionOf(pid);
  assert.ok(Number.isInteger(v0), `editVersion is not on the project record: ${v0}`);
  const detail = repo.updateProject(db, pid, { homeownerPhone: "(503) 555-0101" }, { expectedVersion: v0 });
  assert.equal(snap(pid).homeownerPhone, "(503) 555-0101");
  assert.ok((detail.project.editVersion as number) > v0, `the save did not bump the version (${v0} → ${detail.project.editVersion})`);
  assert.equal(detail.project.editVersion, row(pid).edit_version, "the returned record carries a different version from the row");
});

await check("(b) a save with a stale version is a 409 and writes nothing", async () => {
  const pid = fx.newProject();
  const loaded = versionOf(pid); // editor A opens the project
  repo.updateProject(db, pid, { homeownerPhone: "(503) 555-0102" }, { expectedVersion: loaded }); // editor B saves first
  const before = row(pid);
  const auditsBefore = updateAudits(pid);
  let thrown: unknown = null;
  try {
    repo.updateProject(db, pid, { homeownerPhone: "(503) 555-0199", jobValue: "31500" }, { expectedVersion: loaded }); // A saves
  } catch (err) { thrown = err; }
  assert.ok(thrown instanceof HttpError, `a stale save was not refused: ${String(thrown)}`);
  const e = thrown as InstanceType<typeof HttpError>;
  assert.equal(e.status, 409);
  assert.equal(e.details.editConflict, true);
  assert.equal(e.details.expectedVersion, loaded);
  assert.equal(e.details.currentVersion, before.edit_version);
  assert.match(e.message, /changed by someone else/);
  const after = row(pid);
  assert.equal(after.parser_json, before.parser_json, "MUST-EXCLUDE: a refused save changed the snapshot");
  assert.equal(after.edit_version, before.edit_version, "MUST-EXCLUDE: a refused save moved the version");
  assert.equal(after.updated_at, before.updated_at, "MUST-EXCLUDE: a refused save touched updated_at");
  assert.equal(snap(pid).homeownerPhone, "(503) 555-0102", "B's save was overwritten");
  assert.equal(snap(pid).jobValue === "31500", false, "MUST-EXCLUDE: part of the refused save landed");
  assert.equal(updateAudits(pid), auditsBefore, "MUST-EXCLUDE: a refused save wrote an audit row");
});

await check("(c) background data writers bump the version and never 409", async () => {
  const pid = fx.newProject();
  const loaded = versionOf(pid);
  // The bill / datasheet reads, intake and the parser all save through updateProject with no expected
  // version: unconditional, as before, and it bumps.
  repo.updateProject(db, pid, { homeownerPhone: "(503) 555-0103" });
  assert.equal(snap(pid).homeownerPhone, "(503) 555-0103", "an unversioned (background) save was refused");
  const afterBg = versionOf(pid);
  assert.ok(afterBg > loaded, `a background updateProject did not bump the version (${loaded} → ${afterBg})`);
  // ANY writer of the data, even a raw one that never touches updated_at (the review queue's
  // applyVerifiedField writes parser_json directly): the trigger is per row, not per call site.
  db.run("UPDATE projects SET parser_json = json_set(parser_json, '$.jobValue', '12000') WHERE id = ?", [pid]);
  const afterRaw = versionOf(pid);
  assert.equal(afterRaw, afterBg + 1, `a raw parser_json write did not bump the version by one (${afterBg} → ${afterRaw})`);
  db.run("UPDATE projects SET homeowner_name = ? WHERE id = ?", ["Background Owner", pid]);
  assert.equal(versionOf(pid), afterRaw + 1, "a raw column write did not bump the version by one");
  // And the editor who loaded before all of it is now stale.
  assert.throws(() => repo.updateProject(db, pid, { homeownerPhone: "x" }, { expectedVersion: loaded }), (err: unknown) => (err as { status?: number }).status === 409);
});

await check("(c2) lifecycle writes (status, stage, share link) do not bump: the editor is never refused for them", async () => {
  const pid = fx.newProject();
  const loaded = versionOf(pid);
  // The client notifier / permit monitor's share link, the stage chain's status and stage prose.
  ensureStatusShareToken(db, pid);
  db.run("UPDATE projects SET status = 'qc_passed', current_stage = ?, stage_detail = 'qc_passed', updated_at = ? WHERE id = ?", ["QC passed: ready to stage", new Date().toISOString(), pid]);
  repo.setProjectStatusByOperator(db, pid, "blocked", "waiting on the homeowner", "operator");
  assert.equal(versionOf(pid), loaded, "a lifecycle write moved the edit version");
  // The editor's save, made against the version loaded before them, goes through.
  repo.updateProject(db, pid, { homeownerPhone: "(503) 555-0104" }, { expectedVersion: loaded });
  assert.equal(snap(pid).homeownerPhone, "(503) 555-0104");
  // ...and its own QC pass (status only) leaves the returned version current for the next save.
  const v = versionOf(pid);
  repo.updateProject(db, pid, { homeownerPhone: "(503) 555-0105" }, { expectedVersion: v });
  assert.equal(snap(pid).homeownerPhone, "(503) 555-0105", "a save right after a save was refused");
});

await check("(e) the v51 migration is idempotent: a replay leaves one column and one trigger", async () => {
  db.run("DELETE FROM schema_meta WHERE version >= 51");
  const dbMod = await import("../src/db");
  const again = await dbMod.openDatabase();
  const cols = again.query<{ name: string }>("PRAGMA table_info(projects)").filter((c) => c.name === "edit_version");
  assert.equal(cols.length, 1);
  const triggers = again.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'projects_bump_edit_version'");
  assert.equal(triggers.length, 1);
  again.close();
});

// ── (d) the route, on a real server with sign-in off ─────────────────────────────────────────
// THIS PROCESS WRITES NOTHING WHILE THE SERVER IS UP. Both write the same WAL file, and a deferred
// transaction here (fx.newProject) that reads, then loses the race to the server's post-save commit,
// gets SQLITE_BUSY_SNAPSHOT at once — busy_timeout never applies — so the run went red now and then
// ("database is locked"). Every (d) project, and every write it needs, is made BEFORE the spawn;
// from here on this process only reads.
const routePids = { d1: fx.newProject(), d2: fx.newProject(), d3: fx.newProject() };
db.run("UPDATE projects SET parser_json = json_set(parser_json, '$.jobValue', '9000') WHERE id = ?", [routePids.d3]); // a background data write before the editor's save
const dbPath = String(process.env.AUTOPILOT_DB_PATH);
const PORT = 5410 + Math.floor(Math.random() * 15); // never 4173 / 4270
const BASE = `http://127.0.0.1:${PORT}`;
const env: Record<string, string | undefined> = {
  ...process.env, AUTOPILOT_DB_PATH: dbPath, PORT: String(PORT), AUTOPILOT_AUTO_START: "0", SEED_TEST_INSTALLER: "false",
  MONITOR_INTERVAL_MINUTES: "0", LOG_LEVEL: "warn", ANTHROPIC_API_KEY: "", CODE_RESEARCH: "off", BACKGROUND_WORKERS: "off",
  SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
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
    await new Promise((r) => setTimeout(r, 1000));
  }
  const put = (pid: string, body: Record<string, unknown>) =>
    fetch(`${BASE}/api/projects/${pid}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  await check("(d1) PUT with a stale expectedVersion is a 409 with editConflict, and the DB is unchanged", async () => {
    const pid = routePids.d1;
    const loaded = versionOf(pid);
    const first = await put(pid, { homeownerPhone: "(503) 555-0111", expectedVersion: loaded });
    assert.equal(first.status, 200, await first.text());
    const before = row(pid);
    const res = await put(pid, { homeownerPhone: "(503) 555-0122", expectedVersion: loaded });
    const body = JSON.parse(await res.text()) as { error: string; details: Record<string, unknown> };
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.equal(body.details.editConflict, true);
    assert.match(body.error, /changed by someone else/);
    const after = row(pid);
    assert.equal(after.parser_json, before.parser_json, "MUST-EXCLUDE: a refused PUT changed the snapshot");
    assert.equal(after.edit_version, before.edit_version, "MUST-EXCLUDE: a refused PUT moved the version");
  });

  await check("(d2) PUT with the current expectedVersion saves, bumps, and keeps expectedVersion out of the snapshot", async () => {
    const pid = routePids.d2;
    const v = versionOf(pid);
    const res = await put(pid, { homeownerPhone: "(503) 555-0133", expectedVersion: v });
    const body = JSON.parse(await res.text()) as { project: { editVersion: number } };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.ok(body.project.editVersion > v, "the response does not carry the bumped version");
    assert.equal(snap(pid).homeownerPhone, "(503) 555-0133");
    assert.equal("expectedVersion" in snap(pid), false, "MUST-EXCLUDE: expectedVersion was saved as a project field");
    // The wrapped shape ({ payload, expectedVersion }) is checked too.
    const stale = await put(pid, { payload: { homeownerPhone: "nope" }, expectedVersion: v });
    assert.equal(stale.status, 409, "a stale save in the { payload } shape was not refused");
  });

  await check("(d3) PUT without expectedVersion stays unconditional (the parser and API keys); a malformed one is a 400", async () => {
    const pid = routePids.d3; // its version was moved by a background data write before the spawn
    const res = await put(pid, { homeownerPhone: "(503) 555-0144" });
    assert.equal(res.status, 200, await res.text());
    assert.equal(snap(pid).homeownerPhone, "(503) 555-0144");
    const before = row(pid);
    const bad = await put(pid, { homeownerPhone: "(503) 555-0155", expectedVersion: "abc" });
    assert.equal(bad.status, 400, await bad.text());
    assert.equal(row(pid).parser_json, before.parser_json, "MUST-EXCLUDE: a malformed version wrote");
  });
} finally {
  server.kill("SIGTERM");
}

finish("project-edit-version");
