// EDIT A TRACKED FILING FROM ITS CARD: PATCH /api/projects/:id/permit-targets/:targetId (#411).
//
// Owner 2026-10-29, West / Lincoln County (project 7ddfbe48): the building permit was issued but
// its card read ACTIVE. The project was filed before #400/#401 captured the record link, so no
// target had a URL and the monitor logged "no portal URL or recipe to read" forever. Nothing on the
// card could fix that. The PATCH edits the row the card shows:
//   - only the named fields change; a frequency change recomputes next_check_at; a new portal URL
//     re-detects portal_platform; one audit row permit_target.edited naming the FIELDS, no values;
//   - another project's target -> 404, and another org's project -> 404 (never 403);
//   - rule 5: a utility (PowerClerk) URL on a permit target is refused with creation's own message,
//     and a URL that is not http(s) is refused;
//   - clearing a number never leaves the row with neither number.
// And the owner's own case end to end: "Issued" recorded from the card (the words the dashboard's
// pick posts) on the electrical target finishes THAT filing, as a manual reading.
//
// Fixtures are synthetic. The route part boots a real server on a temp DB and a free port.
//   npx tsx backend/test/permitTargetEdit.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "permit-target-edit-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_DB_PATH = dbPath;
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
process.env.CODE_RESEARCH = "off";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const POWERCLERK = "https://pacificorpnetmetering.powerclerk.com/MvcProjects/ProjectDetails";
const ACCELA = "https://aca-oregon.accela.com/oregon/Cap/CapDetail.aspx?Module=Building&capID1=26CAP&capID2=00000&capID3=001AB";

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const refusal = (fn: () => void): { status?: number; message: string } | null => {
  try { fn(); return null; } catch (e) { return { status: (e as { status?: number }).status, message: (e as Error).message }; }
};

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const T = await import("../src/submittalTracks");
const db = await openDatabase();
let n = 0;
const mk = () => R.createProject(db, {
  owner: "Edit Owner", state: "OR", dcKw: "8.4", acKw: "7.7", street: `${++n} Edit Way`, city: "Newport", zip: "97365",
  ahj: "Lincoln County", utility: "Central Lincoln PUD",
} as never).project;
// Two filings on one project, the West / Lincoln County shape: structural + electrical, no URL.
const withTargets = () => {
  const p = mk();
  R.createPermitCheckTarget(db, p.id, { targetType: "permit", permitType: "building", jurisdiction: "Lincoln County", applicationNumber: "519-26-001665-STR", permitNumber: "519-26-001665-STR" });
  const d = R.createPermitCheckTarget(db, p.id, { targetType: "permit", permitType: "electrical", jurisdiction: "Lincoln County", applicationNumber: "519-26-001666-ELEC", permitNumber: "519-26-001666-ELEC" });
  const str = d.permitCheckTargets.find((t) => t.applicationNumber === "519-26-001665-STR")!;
  const elec = d.permitCheckTargets.find((t) => t.applicationNumber === "519-26-001666-ELEC")!;
  return { p, str, elec };
};
const rowOf = (id: string) => db.get<Record<string, unknown>>("SELECT * FROM permit_check_targets WHERE id = ?", [id])!;
const edits = (projectId: string) => db.query<{ details: string; actor_name: string; actor_type: string }>(
  "SELECT details, actor_name, actor_type FROM audit_logs WHERE project_id = ? AND action = 'permit_target.edited'", [projectId]);

console.log("1. The data layer: updatePermitCheckTarget");
await check("a record URL pasted on the card is stored, its platform re-detected, nothing else touched", () => {
  const { p, elec } = withTargets();
  const before = rowOf(elec.id);
  assert.equal(before.portal_platform, "unknown");
  const d = R.updatePermitCheckTarget(db, p.id, elec.id, { portalUrl: ACCELA }, "owner@test");
  const after = rowOf(elec.id);
  assert.equal(after.portal_url, ACCELA, "the URL is stored whole — the record link's ids are what make it readable");
  assert.equal(after.portal_platform, "accela");
  for (const col of ["application_number", "permit_number", "portal_name", "check_frequency_days", "next_check_at", "active", "tracking_url"]) {
    assert.equal(after[col], before[col], col);
  }
  assert.equal(d.permitCheckTargets.find((t) => t.id === elec.id)?.portalUrl, ACCELA, "the response is the detail the card re-renders from");
});
await check("audit: ONE permit_target.edited row naming the changed fields — never a value", () => {
  const { p, elec } = withTargets();
  R.updatePermitCheckTarget(db, p.id, elec.id, { portalUrl: `${ACCELA}&session=SECRET-TOKEN`, portalName: "Oregon ePermitting", checkFrequencyDays: 7 }, "owner@test");
  const rows = edits(p.id);
  assert.equal(rows.length, 1);
  const details = JSON.parse(rows[0].details);
  assert.deepEqual(details.fields, ["portalUrl", "portalName"], "frequency 7 = the stored 7, so it is not a change");
  assert.equal(details.targetId, elec.id);
  assert.ok(!rows[0].details.includes("SECRET-TOKEN") && !rows[0].details.includes("accela"), `a value reached the audit: ${rows[0].details}`);
  assert.ok(!String(rowOf(elec.id).portal_url).includes("SECRET-TOKEN"), `the session token was stored: ${rowOf(elec.id).portal_url}`);
  assert.equal(rowOf(elec.id).portal_url, ACCELA, "the record's own ids are kept");
  assert.equal(rows[0].actor_type, "human");
  assert.equal(rows[0].actor_name, "owner@test");
});
await check("an edit that changes nothing writes nothing (no audit row, no updated_at)", () => {
  const { p, elec } = withTargets();
  const before = rowOf(elec.id);
  R.updatePermitCheckTarget(db, p.id, elec.id, { applicationNumber: "519-26-001666-ELEC", active: true });
  assert.equal(edits(p.id).length, 0);
  assert.equal(rowOf(elec.id).updated_at, before.updated_at);
});
await check("a frequency change recomputes next_check_at (an issued filing keeps the new cadence)", () => {
  const { p, elec } = withTargets();
  db.run("UPDATE permit_check_targets SET latest_outcome = 'issued', next_check_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [elec.id]);
  const t0 = Date.now();
  R.updatePermitCheckTarget(db, p.id, elec.id, { checkFrequencyDays: 30 });
  const row = rowOf(elec.id);
  assert.equal(row.check_frequency_days, 30);
  const next = Date.parse(String(row.next_check_at));
  assert.ok(next - t0 > 29 * 86400_000 && next - t0 < 31 * 86400_000, `next_check_at ${row.next_check_at} is not ~30 days out`);
});
await check("a bad frequency is refused (400)", () => {
  const { p, elec } = withTargets();
  for (const bad of [0, -3, 2.5, 9999]) assert.equal(refusal(() => R.updatePermitCheckTarget(db, p.id, elec.id, { checkFrequencyDays: bad }))?.status, 400, String(bad));
});
await check("stop / resume tracking", () => {
  const { p, elec } = withTargets();
  R.updatePermitCheckTarget(db, p.id, elec.id, { active: false });
  assert.equal(rowOf(elec.id).active, 0);
  R.updatePermitCheckTarget(db, p.id, elec.id, { active: true });
  assert.equal(rowOf(elec.id).active, 1);
  assert.equal(refusal(() => R.updatePermitCheckTarget(db, p.id, elec.id, { active: "false" as never }))?.status, 400);
});
await check("SCOPE: another project's target through this project's id -> 404, and that target is untouched", () => {
  const a = withTargets();
  const b = withTargets();
  const before = rowOf(b.elec.id);
  const r = refusal(() => R.updatePermitCheckTarget(db, a.p.id, b.elec.id, { portalName: "hijack" }));
  assert.equal(r?.status, 404);
  assert.deepEqual(rowOf(b.elec.id), before);
});
await check("RULE 5: a PowerClerk URL on a permit target is refused with creation's own message; nothing written", () => {
  const { p, elec } = withTargets();
  const before = rowOf(elec.id);
  for (const field of ["portalUrl", "trackingUrl"] as const) {
    const r = refusal(() => R.updatePermitCheckTarget(db, p.id, elec.id, { [field]: POWERCLERK }));
    assert.equal(r?.status, 400, field);
    assert.equal(r?.message, T.UTILITY_URL_ON_PERMIT_TARGET_MESSAGE, field);
  }
  assert.deepEqual(rowOf(elec.id), before);
});
await check("RULE 5 MUST EXCLUDE: the same URL on the NEM target is saved", () => {
  const p = mk();
  const d = R.createPermitCheckTarget(db, p.id, { targetType: "nem", permitType: "nem", applicationNumber: "APP-112491" });
  const nem = d.permitCheckTargets[0];
  R.updatePermitCheckTarget(db, p.id, nem.id, { trackingUrl: POWERCLERK });
  assert.equal(rowOf(nem.id).tracking_url, POWERCLERK);
});
await check("a URL that is not http(s) is refused", () => {
  const { p, elec } = withTargets();
  for (const bad of ["javascript:alert(1)", "ftp://x.test/a", "file:///C:/x", "not a url"]) {
    const r = refusal(() => R.updatePermitCheckTarget(db, p.id, elec.id, { portalUrl: bad }));
    assert.equal(r?.status, 400, bad);
  }
  assert.equal(rowOf(elec.id).portal_url, "");
});
await check("clearing a URL is allowed (and the platform goes back to unknown)", () => {
  const { p, elec } = withTargets();
  R.updatePermitCheckTarget(db, p.id, elec.id, { portalUrl: ACCELA });
  R.updatePermitCheckTarget(db, p.id, elec.id, { portalUrl: "" });
  assert.equal(rowOf(elec.id).portal_url, "");
  assert.equal(rowOf(elec.id).portal_platform, "unknown");
});
await check("IDENTITY: clearing one number keeps the other; clearing both is refused with a plain message", () => {
  const { p, elec } = withTargets();
  R.updatePermitCheckTarget(db, p.id, elec.id, { applicationNumber: "" });
  assert.equal(rowOf(elec.id).permit_number, "519-26-001666-ELEC");
  const r = refusal(() => R.updatePermitCheckTarget(db, p.id, elec.id, { permitNumber: "  " }));
  assert.equal(r?.status, 400);
  assert.match(r!.message, /application number or a permit number/);
  assert.equal(rowOf(elec.id).permit_number, "519-26-001666-ELEC");
});
await check("THE OWNER'S CASE: 'Permit issued' recorded from the electrical card finishes the electrical filing only", async () => {
  const { p, str, elec } = withTargets();
  await R.recordPermitStatusCheck(db, p.id, { targetId: elec.id, source: "manual", rawStatusText: "Permit issued" });
  assert.equal(rowOf(elec.id).latest_outcome, "issued");
  assert.equal(rowOf(str.id).latest_outcome, null, "the structural filing was not touched");
});

// Fixture for the route part, then release the file for the server process.
const route = withTargets();
const other = withTargets();
db.close();

console.log("\n2. Through the real route: PATCH /api/projects/:id/permit-targets/:targetId");
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const port = (s.address() as net.AddressInfo).port; s.close(() => resolve(port)); });
});
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const env: Record<string, string | undefined> = {
  ...process.env,
  AUTOPILOT_DB_PATH: dbPath, BACKUP_DIR: path.join(tmpDir, "backups"), PROJECT_DOCS_DIR: path.join(tmpDir, "docs"), AUTOPILOT_AUTO_START: "0", PORT: String(PORT),
  SEED_TEST_INSTALLER: "false", MONITOR_INTERVAL_MINUTES: "0", LOG_LEVEL: "warn", ANTHROPIC_API_KEY: "", CODE_RESEARCH: "off",
  SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
  AUTH_ENABLED: "true", ADMIN_EMAIL: "admin@edit.test", ADMIN_PASSWORD: "edit-test-password-1", NO_PROXY: "*", no_proxy: "*",
};
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
const server = spawn(process.execPath, [path.join(repoRoot, "node_modules/tsx/dist/cli.mjs"), path.join(repoRoot, "backend/src/server.ts")], {
  env: env as NodeJS.ProcessEnv, cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], detached: false,
});
let serverLog = "";
server.stdout?.on("data", (d) => { serverLog += String(d); });
server.stderr?.on("data", (d) => { serverLog += String(d); });
const readRow = (id: string): Record<string, unknown> => {
  const ro = new Database(dbPath, { readonly: true });
  try { return ro.prepare("SELECT * FROM permit_check_targets WHERE id = ?").get(id) as Record<string, unknown>; } finally { ro.close(); }
};
const login = async (email: string, password: string): Promise<string> => {
  const res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  assert.equal(res.status, 200, await res.text());
  return String(res.headers.get("set-cookie") || "").split(";")[0];
};
try {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up yet */ }
    if (i === 89) throw new Error(`server never came up. log tail:\n${serverLog.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const cookie = await login("admin@edit.test", "edit-test-password-1");
  const patch = (projectId: string, targetId: string, body: Record<string, unknown>, as = cookie) => fetch(`${BASE}/api/projects/${projectId}/permit-targets/${targetId}`, {
    method: "PATCH", headers: { "content-type": "application/json", cookie: as }, body: JSON.stringify(body),
  });

  await check("MUST PASS (route): the record URL saves and the response is the project detail", async () => {
    const res = await patch(route.p.id, route.elec.id, { portalUrl: ACCELA, checkFrequencyDays: 3 });
    const text = await res.text();
    assert.equal(res.status, 200, text.slice(0, 300));
    const detail = JSON.parse(text);
    assert.equal(detail.project.id, route.p.id);
    assert.equal(detail.permitCheckTargets.find((t: { id: string }) => t.id === route.elec.id)?.portalUrl, ACCELA);
    assert.equal(readRow(route.elec.id).portal_platform, "accela");
    assert.equal(readRow(route.elec.id).check_frequency_days, 3);
  });
  await check("SCOPE (route): another project's target via this project's id -> 404, untouched", async () => {
    const before = readRow(other.elec.id);
    const res = await patch(route.p.id, other.elec.id, { portalName: "hijack" });
    assert.equal(res.status, 404, (await res.text()).slice(0, 200));
    assert.deepEqual(readRow(other.elec.id), before);
  });
  await check("RULE 5 (route): a PowerClerk URL on the permit target -> 400 with creation's message", async () => {
    const res = await patch(route.p.id, route.str.id, { trackingUrl: POWERCLERK });
    const text = await res.text();
    assert.equal(res.status, 400, text.slice(0, 300));
    assert.equal(JSON.parse(text).error, T.UTILITY_URL_ON_PERMIT_TARGET_MESSAGE);
    assert.equal(readRow(route.str.id).tracking_url, "");
  });
  await check("SCOPE (route): a user of ANOTHER org -> 404 (never 403), untouched", async () => {
    const orgRes = await fetch(`${BASE}/api/orgs`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "Other Solar Co", edition: "full" }) });
    const orgText = await orgRes.text();
    assert.equal(orgRes.status, 201, orgText.slice(0, 300));
    const org = JSON.parse(orgText).org;
    const userRes = await fetch(`${BASE}/api/orgs/${org.id}/users`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "Other Operator", email: "op@other.test", password: "other-pass-12345" }) });
    assert.equal(userRes.status, 201, (await userRes.text()).slice(0, 200));
    const otherCookie = await login("op@other.test", "other-pass-12345");
    const before = readRow(route.str.id);
    const res = await patch(route.p.id, route.str.id, { portalName: "cross-org" }, otherCookie);
    assert.equal(res.status, 404, `${res.status} ${(await res.text()).slice(0, 200)}`);
    assert.deepEqual(readRow(route.str.id), before);
  });
} catch (err) {
  failures++;
  console.error(`  FAIL - route harness: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  server.kill();
}

if (failures) { console.error(`\n${failures} permit-target-edit check(s) FAILED.`); process.exit(1); }
console.log("\nAll permit-target-edit checks passed.");
process.exit(0);
