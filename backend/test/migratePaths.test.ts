// THE STORED-PATH REWRITE FOR THE SERVER MOVE (#442): a dry run lists Windows paths and writes
// nothing, --apply rewrites them into the flat state layout, a missing file blocks --apply, a
// second run is a no-op, and portal credentials and secret columns are never touched.
//
// scripts/migrate-paths.ts is exercised as the OWNER runs it: the CLI in its own process, on a
// scratch database made by the real openDatabase (real schema). Rows carry synthetic Windows paths
// of the old install's three trees (backend\data, data, portal-profiles); the files are created
// under a scratch state folder, as they would be after the state folder is copied to the server.
//
// KILL TESTS (each makes at least one check red):
//   K1 planRefusal: drop the missing-file refusal         -> (c) red.
//   K2 makePathMapper: match case-sensitively on Windows -> (a) and (m2) red.
//   K3 makePathMapper: drop the separator boundary        -> (m3) red.
//   K4 candidateTables: stop skipping portal_credentials  -> (b) red.
// Run: npx tsx backend/test/migratePaths.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { REPO } from "./_isolate";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-paths-"));
const DB_PATH = path.join(tmp, "autopilot.sqlite");
const STATE = path.join(tmp, "state");
process.env.AUTOPILOT_DB_PATH = DB_PATH;
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.AUTOPILOT_STATE_DIR;

const { openDatabase } = await import("../src/db");
const M = await import("../../scripts/migrate-paths");

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// ---------------------------------------------------------------------------------------------
// The mapper on its own: layout, case, separators, boundaries.
// ---------------------------------------------------------------------------------------------
const WIN = "C:\\Users\\op\\SOLAR-Proj\\.probe\\prod-pinned";
const TO = path.resolve(path.sep, "srv", "keelix", "state");
{
  const m = M.makePathMapper({ from: WIN, to: TO });
  await check("(m1) flat layout: backend\\data, data and portal-profiles each land in their place", () => {
    assert.equal(m.map(`${WIN}\\backend\\data\\project-documents\\p1\\d1-plans.pdf`), path.join(TO, "project-documents", "p1", "d1-plans.pdf"));
    assert.equal(m.map(`${WIN}\\data\\screenshots\\run-1`), path.join(TO, "screenshots", "run-1"));
    assert.equal(m.map(`${WIN}\\portal-profiles\\c1\\pge`), path.join(TO, "portal-profiles", "c1", "pge"));
    // Another backend\data tree keeps its own name under the state root.
    assert.equal(m.map(`${WIN}\\backend\\data\\filled\\x.pdf`), path.join(TO, "filled", "x.pdf"));
  });
  await check("(m2) a Windows root ignores letter case and takes either separator", () => {
    assert.equal(m.map(`c:/users/OP/solar-proj/.probe/PROD-PINNED/backend/data/project-documents/p1/a.pdf`), path.join(TO, "project-documents", "p1", "a.pdf"));
    assert.equal(m.map(`${WIN}/data\\logs//backend.log`), path.join(TO, "logs", "backend.log"));
  });
  await check("(m3) the root ends at a separator: a sibling folder sharing its prefix never matches", () => {
    assert.equal(m.map(`${WIN}2\\backend\\data\\x.pdf`), null);
    assert.equal(m.isUnder(`${WIN}-old\\data\\x`), false);
  });
  await check("(m4) a path under the root outside the three trees has no place", () => {
    assert.equal(m.isUnder(`${WIN}\\frontend\\logo.png`), true);
    assert.equal(m.map(`${WIN}\\frontend\\logo.png`), null);
  });
  await check("(m5) --plain maps the folder 1:1", () => {
    const p = M.makePathMapper({ from: "E:\\docs", to: TO, layout: "plain" });
    assert.equal(p.map("E:\\docs\\p1\\a.pdf"), path.join(TO, "p1", "a.pdf"));
  });
  await check("(m6) a POSIX root is case-sensitive and keeps a backslash as a filename character", () => {
    const p = M.makePathMapper({ from: "/opt/old", to: TO });
    assert.equal(p.map("/opt/old/data/logs/a\\b.log"), path.join(TO, "logs", "a\\b.log"));
    assert.equal(p.map("/OPT/old/data/logs/a.log"), null);
  });
  await check("(m7) --to inside --from is refused (a second run would rewrite its own output)", () => {
    assert.match(M.rootsRefusal({ from: "/opt/old", to: "/opt/old/state" }), /inside --from/);
    assert.match(M.rootsRefusal({ from: "", to: TO }), /--from is required/);
    assert.equal(M.rootsRefusal({ from: WIN, to: TO }), "");
  });
}

// ---------------------------------------------------------------------------------------------
// Seed a scratch database with the real schema and synthetic Windows-install rows.
// ---------------------------------------------------------------------------------------------
const app = await openDatabase();
app.close();

const DOC_A = `${WIN}\\backend\\data\\project-documents\\proj-1\\doc-a-planset.pdf`;
const DOC_B = `${WIN}\\backend\\data\\project-documents\\proj-1\\doc-b-bill.pdf`;
const SHOTS = `${WIN}\\data\\screenshots\\run-1`;
const LOGS = `${WIN}\\data\\learn-runs\\run-1`;
const PROFILE = `${WIN}\\portal-profiles\\client-1\\powerclerk`;
const SECRET_LOOKALIKE = `${WIN}\\backend\\data\\project-documents\\proj-1\\never-touch.pdf`;
{
  const db = new Database(DB_PATH);
  db.pragma("foreign_keys = OFF");
  const now = new Date().toISOString();
  db.prepare("INSERT INTO project_documents (id, project_id, stored_path, uploaded_at) VALUES (?, ?, ?, ?)").run("doc-a", "proj-1", DOC_A, now);
  db.prepare("INSERT INTO project_documents (id, project_id, stored_path, uploaded_at) VALUES (?, ?, ?, ?)").run("doc-b", "proj-1", DOC_B, now);
  db.prepare("INSERT INTO project_documents (id, project_id, stored_path, uploaded_at) VALUES (?, ?, ?, ?)").run("doc-c", "proj-1", "/already/linux/path.pdf", now);
  db.prepare(
    "INSERT INTO portal_runs (id, project_id, run_type, status, started_at, error_message, screenshots_path, logs_path, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("run-1", "proj-1", "learn", "failed", now, `Upload failed reading ${DOC_A} (see log)`, SHOTS, LOGS,
    JSON.stringify({ bundle: LOGS, files: [DOC_A, "relative.txt"], profileDir: PROFILE, n: 3 }));
  // Secrets: a path-looking string in an encrypted column and in portal_credentials must survive.
  db.prepare("INSERT INTO portal_profiles (id, portal_name, portal_type, encrypted_storage_state, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("pp-1", "PowerClerk", "nem", SECRET_LOOKALIKE, now);
  // portal_credentials is never read: even its plain notes column keeps a path-looking string.
  db.prepare("INSERT INTO portal_credentials (id, client_id, portal_type, encrypted_secret, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("cred-1", "client-1", "nem", SECRET_LOOKALIKE, SECRET_LOOKALIKE, now, now);
  db.close();
}

// The copied state folder on the "server": every file except doc-b at first.
const put = (p: string, dir = false): void => {
  if (dir) { fs.mkdirSync(p, { recursive: true }); return; }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "synthetic");
};
put(path.join(STATE, "project-documents", "proj-1", "doc-a-planset.pdf"));
put(path.join(STATE, "screenshots", "run-1"), true);
put(path.join(STATE, "learn-runs", "run-1"), true);
put(path.join(STATE, "portal-profiles", "client-1", "powerclerk"), true);

const SCRIPT = path.join(REPO, "scripts", "migrate-paths.ts");
const TSX = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
const sha = (): string => crypto.createHash("sha1").update(fs.readFileSync(DB_PATH)).digest("hex");
const cli = (...args: string[]): { code: number; out: string } => {
  const r = spawnSync(process.execPath, [TSX, SCRIPT, "--db", DB_PATH, "--from", WIN, "--to", STATE, ...args], {
    cwd: tmp, encoding: "utf8", env: { ...process.env, AUTOPILOT_STATE_DIR: "" },
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};
const read = (sql: string, ...p: unknown[]): Record<string, unknown> => {
  const db = new Database(DB_PATH, { readonly: true });
  try { return db.prepare(sql).get(...p) as Record<string, unknown>; } finally { db.close(); }
};
const backups = (): string[] => fs.readdirSync(tmp).filter((f) => f.endsWith(".backup"));

// ---------------------------------------------------------------------------------------------
await check("(a) the dry run lists every table and column holding a path under the old root, with counts", () => {
  const before = sha();
  const r = cli();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /DRY RUN/);
  assert.match(r.out, /project_documents\.stored_path: 2 path\(s\) in 2 row\(s\), 1 MISSING/);
  assert.match(r.out, /portal_runs\.screenshots_path: 1 path\(s\) in 1 row\(s\)/);
  assert.match(r.out, /portal_runs\.logs_path: 1 path\(s\) in 1 row\(s\)/);
  assert.match(r.out, /portal_runs\.result_json: 3 path\(s\) in 1 row\(s\)/);
  assert.match(r.out, /portal_runs\.error_message: 0 path\(s\) in 0 row\(s\), 1 mention\(s\) in text, left as is/);
  assert.match(r.out, /--apply would refuse: 1 rewritten path\(s\) have no file/);
  assert.equal(sha(), before, "the dry run changed the database file");
  assert.equal(backups().length, 0, "the dry run took a backup");
});

await check("(b) the dry run never reads portal credentials or secret columns", () => {
  const r = cli();
  assert.doesNotMatch(r.out, /portal_credentials\.|encrypted_storage_state|encrypted_secret/);
  assert.match(r.out, /Not read: .*portal_credentials/);
});

await check("(c) a missing file blocks --apply: nothing written, no backup", () => {
  const before = sha();
  const r = cli("--apply");
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /have no file at the new place.*Nothing written/s);
  assert.equal(sha(), before);
  assert.equal(backups().length, 0);
});

put(path.join(STATE, "project-documents", "proj-1", "doc-b-bill.pdf"));

await check("(d) --apply backs up the database, then rewrites every path into the flat state layout", () => {
  const r = cli("--apply");
  assert.equal(r.code, 0, r.out);
  assert.equal(backups().length, 1, r.out);
  assert.equal(read("SELECT stored_path FROM project_documents WHERE id = 'doc-a'").stored_path, path.join(STATE, "project-documents", "proj-1", "doc-a-planset.pdf"));
  assert.equal(read("SELECT stored_path FROM project_documents WHERE id = 'doc-b'").stored_path, path.join(STATE, "project-documents", "proj-1", "doc-b-bill.pdf"));
  assert.equal(read("SELECT stored_path FROM project_documents WHERE id = 'doc-c'").stored_path, "/already/linux/path.pdf");
  const run = read("SELECT * FROM portal_runs WHERE id = 'run-1'");
  assert.equal(run.screenshots_path, path.join(STATE, "screenshots", "run-1"));
  assert.equal(run.logs_path, path.join(STATE, "learn-runs", "run-1"));
  assert.deepEqual(JSON.parse(String(run.result_json)), {
    bundle: path.join(STATE, "learn-runs", "run-1"),
    files: [path.join(STATE, "project-documents", "proj-1", "doc-a-planset.pdf"), "relative.txt"],
    profileDir: path.join(STATE, "portal-profiles", "client-1", "powerclerk"),
    n: 3,
  });
  assert.equal(run.error_message, `Upload failed reading ${DOC_A} (see log)`, "prose was rewritten");
  // The backup holds the old values.
  const b = new Database(path.join(tmp, backups()[0]), { readonly: true });
  try { assert.equal((b.prepare("SELECT stored_path FROM project_documents WHERE id = 'doc-a'").get() as { stored_path: string }).stored_path, DOC_A); }
  finally { b.close(); }
});

await check("(e) a second run is a no-op", () => {
  const before = sha();
  const dry = cli();
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /0 path\(s\) in 0 row\(s\) would be rewritten/);
  const again = cli("--apply");
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /Nothing to write/);
  assert.equal(sha(), before);
  assert.equal(backups().length, 1, "a no-op run took another backup");
});

await check("(f) portal credentials and encrypted columns are untouched", () => {
  assert.equal(read("SELECT encrypted_storage_state AS v FROM portal_profiles WHERE id = 'pp-1'").v, SECRET_LOOKALIKE);
  const cred = read("SELECT encrypted_secret, notes FROM portal_credentials WHERE id = 'cred-1'");
  assert.equal(cred.encrypted_secret, SECRET_LOOKALIKE);
  assert.equal(cred.notes, SECRET_LOOKALIKE);
});

await check("(g) --allow-missing writes over a missing file; a path with no place is left as is", () => {
  const db = new Database(DB_PATH);
  db.pragma("foreign_keys = OFF");
  db.prepare("INSERT INTO project_documents (id, project_id, stored_path, uploaded_at) VALUES (?, ?, ?, ?)")
    .run("doc-gone", "proj-1", `${WIN}\\backend\\data\\project-documents\\proj-1\\gone.pdf`, new Date().toISOString());
  db.prepare("INSERT INTO project_documents (id, project_id, stored_path, uploaded_at) VALUES (?, ?, ?, ?)")
    .run("doc-odd", "proj-1", `${WIN}\\uploads\\odd.pdf`, new Date().toISOString());
  db.close();
  const refused = cli("--apply");
  assert.equal(refused.code, 2, refused.out);
  assert.match(refused.out, /1 path\(s\) under --from have no place/);
  const r = cli("--apply", "--allow-missing");
  assert.equal(r.code, 0, r.out);
  assert.equal(read("SELECT stored_path FROM project_documents WHERE id = 'doc-gone'").stored_path, path.join(STATE, "project-documents", "proj-1", "gone.pdf"));
  assert.equal(read("SELECT stored_path FROM project_documents WHERE id = 'doc-odd'").stored_path, `${WIN}\\uploads\\odd.pdf`);
});

await check("(h) --to defaults to AUTOPILOT_STATE_DIR; neither set is a usage error", () => {
  const r = spawnSync(process.execPath, [TSX, SCRIPT, "--db", DB_PATH, "--from", WIN], {
    cwd: tmp, encoding: "utf8", env: { ...process.env, AUTOPILOT_STATE_DIR: STATE },
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(r.stdout.includes(`to:       ${STATE}`), r.stdout);
  const none = spawnSync(process.execPath, [TSX, SCRIPT, "--db", DB_PATH, "--from", WIN], {
    cwd: tmp, encoding: "utf8", env: { ...process.env, AUTOPILOT_STATE_DIR: "" },
  });
  assert.equal(none.status, 2, `${none.stdout}${none.stderr}`);
});

fs.rmSync(tmp, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nmigratePaths: all checks passed");
