// ONE STATE ROOT (#430).
//
// 1. With AUTOPILOT_STATE_DIR unset, every state path resolves EXACTLY as the code did before the
//    resolver existed: each expected value below is the old expression, copied from the line it
//    replaced. The desk install must not move a file.
// 2. With it set, the database, documents, portal profiles, draft ledger, learn and replay runs,
//    screenshots, portal-debug and logs all resolve under it, and every per-path override still wins.
// 3. The draft ledger is never silently relocated on an install that already has one.
// 4. A source scan fails when a new cwd-relative state path (process.cwd() + "data…" or
//    "backend/data…", a relative path.join("data", …), or a "portal-profiles" literal) appears
//    outside backend/src/statePaths.ts.
// 5. Docker and compose point the setting at the volume they mount.
//
// Synthetic paths and temp folders only. Run: tsx backend/test/statePaths.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyStateDirEnvDefaults, backendDataDir, backupDir, dbPath, draftLedgerLocation, learnRunsDir, logFilePath,
  opsDir, portalDebugDir, portalProfilesDir, projectDocsDir, replayRunsDir, runDataDir, screenshotsDir, stateDirSetting,
} from "../src/statePaths";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`ok   - ${label}`);
  else { failures++; console.error(`FAIL - ${label}${detail ? `\n       ${detail}` : ""}`); }
};
const eq = (label: string, got: string, want: string): void => check(label, got === want, `got ${got}\n       want ${want}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "state-paths-"));
const cwd = path.join(tmp, "install");
fs.mkdirSync(cwd, { recursive: true });

// ---------------------------------------------------------------------------------------------
// 1. Unset: today's values, each written as the expression it replaced.
// ---------------------------------------------------------------------------------------------
{
  const o = { env: {}, cwd };
  check("unset: no state dir", stateDirSetting(o) === null);
  eq("unset: database (db.ts)", dbPath(o), path.resolve(cwd, "backend/data/autopilot.sqlite"));
  eq("unset: project documents (projectDocuments.ts)", projectDocsDir(o), path.resolve(cwd, "backend/data/project-documents"));
  eq("unset: backups (backup.ts)", backupDir(o), path.resolve(cwd, "backend/data/backups"));
  eq("unset: portal profiles (clients.ts, repository.ts, server.ts)", portalProfilesDir(o), path.join(cwd, "portal-profiles"));
  eq("unset: draft ledger (draftLedger.ts)", draftLedgerLocation(o).path, path.resolve(cwd, "data", "portal-drafts.jsonl"));
  check("unset: draft ledger is the plain default", draftLedgerLocation(o).source === "default" && draftLedgerLocation(o).warning === null);
  eq("unset: learn runs (learnDebug.ts, server.ts, runTriage.ts)", learnRunsDir(o), path.resolve(cwd, "data", "learn-runs"));
  eq("unset: replay runs (recipeAdapter.ts default)", replayRunsDir(o), path.join(cwd, "data", "replay-runs"));
  eq("unset: screenshots (autoLearn.ts, recipeAdapter.ts default)", screenshotsDir(o), path.join(cwd, "data", "screenshots"));
  eq("unset: portal-debug (powerClerk.ts)", portalDebugDir(o), path.resolve(cwd, path.join("data", "portal-debug")));
  eq("unset: log file (logger.ts)", logFilePath(o), path.join(cwd, "data", "logs", "backend.log"));
  eq("unset: ops state (watchdog.ts)", opsDir(o), path.resolve(cwd, "data/ops"));
  eq("unset: backend data dir (ahjForms.ts, generatedDocFiles.ts, ...)", backendDataDir(o), path.resolve(cwd, "backend/data"));
  eq("unset: run data dir (artifactRetention.ts)", runDataDir(o), path.resolve(cwd, "data"));
  // logger.ts: a database outside the install logs beside itself.
  const elsewhere = path.join(tmp, "scratch", "test.sqlite");
  eq("unset: a database outside the install logs beside its own database",
    logFilePath({ env: { AUTOPILOT_DB_PATH: elsewhere }, cwd }), path.join(path.dirname(elsewhere), "logs", "backend.log"));
  eq("unset: AUTOPILOT_LOG_FILE=\"\" still disables the file", logFilePath({ env: { AUTOPILOT_LOG_FILE: "" }, cwd }), "");
  const env: Record<string, string | undefined> = {};
  check("unset: no env defaults are filled for replay", applyStateDirEnvDefaults(env, cwd).length === 0 && Object.keys(env).length === 0);
}

// ---------------------------------------------------------------------------------------------
// 2. Set: everything under the root; overrides still win.
// ---------------------------------------------------------------------------------------------
{
  const state = path.join(tmp, "volume");
  const o = { env: { AUTOPILOT_STATE_DIR: state }, cwd };
  const under = (p: string): boolean => { const rel = path.relative(state, p); return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel); };
  eq("set: the setting resolves", stateDirSetting(o) ?? "", state);
  eq("set: relative setting resolves against the cwd", stateDirSetting({ env: { AUTOPILOT_STATE_DIR: "state" }, cwd }) ?? "", path.join(cwd, "state"));
  // The Docker volume is the old backend/data: the database keeps its path inside it.
  eq("set: database at <state>/autopilot.sqlite", dbPath(o), path.join(state, "autopilot.sqlite"));
  eq("set: documents at <state>/project-documents", projectDocsDir(o), path.join(state, "project-documents"));
  eq("set: backups at <state>/backups", backupDir(o), path.join(state, "backups"));
  eq("set: portal profiles at <state>/portal-profiles", portalProfilesDir(o), path.join(state, "portal-profiles"));
  eq("set: draft ledger at <state>/portal-drafts.jsonl (fresh install)", draftLedgerLocation(o).path, path.join(state, "portal-drafts.jsonl"));
  eq("set: learn runs", learnRunsDir(o), path.join(state, "learn-runs"));
  eq("set: replay runs", replayRunsDir(o), path.join(state, "replay-runs"));
  eq("set: screenshots", screenshotsDir(o), path.join(state, "screenshots"));
  eq("set: portal-debug", portalDebugDir(o), path.join(state, "portal-debug"));
  eq("set: log file", logFilePath(o), path.join(state, "logs", "backend.log"));
  eq("set: ops state", opsDir(o), path.join(state, "ops"));
  for (const [name, p] of Object.entries({
    dbPath: dbPath(o), projectDocsDir: projectDocsDir(o), backupDir: backupDir(o), portalProfilesDir: portalProfilesDir(o),
    ledger: draftLedgerLocation(o).path, learnRunsDir: learnRunsDir(o), replayRunsDir: replayRunsDir(o),
    screenshotsDir: screenshotsDir(o), portalDebugDir: portalDebugDir(o), logFilePath: logFilePath(o),
  })) check(`set: ${name} is inside the state dir`, under(p), p);

  const overrides = {
    AUTOPILOT_STATE_DIR: state,
    AUTOPILOT_DB_PATH: "elsewhere/db.sqlite",
    PROJECT_DOCS_DIR: path.join(tmp, "docs"),
    BACKUP_DIR: path.join(tmp, "bk"),
    PORTAL_PROFILES_DIR: path.join(tmp, "profiles"),
    PORTAL_DRAFT_LEDGER: path.join(tmp, "ledger.jsonl"),
    AUTOLEARN_RUN_DIR: path.join(tmp, "learn"),
    REPLAY_RUN_DIR: path.join(tmp, "replay"),
    PORTAL_SCREENSHOT_DIR: path.join(tmp, "shots"),
    POWERCLERK_DEBUG_DIR: path.join(tmp, "pcdebug"),
    AUTOPILOT_LOG_FILE: path.join(tmp, "my.log"),
  };
  const ov = { env: overrides, cwd };
  eq("override: AUTOPILOT_DB_PATH wins (relative to the cwd, as before)", dbPath(ov), path.resolve(cwd, "elsewhere/db.sqlite"));
  eq("override: PROJECT_DOCS_DIR wins", projectDocsDir(ov), overrides.PROJECT_DOCS_DIR);
  eq("override: BACKUP_DIR wins", backupDir(ov), overrides.BACKUP_DIR);
  eq("override: PORTAL_PROFILES_DIR wins", portalProfilesDir(ov), overrides.PORTAL_PROFILES_DIR);
  eq("override: PORTAL_DRAFT_LEDGER wins", draftLedgerLocation(ov).path, overrides.PORTAL_DRAFT_LEDGER);
  eq("override: AUTOLEARN_RUN_DIR wins", learnRunsDir(ov), overrides.AUTOLEARN_RUN_DIR);
  eq("override: REPLAY_RUN_DIR wins", replayRunsDir(ov), overrides.REPLAY_RUN_DIR);
  eq("override: PORTAL_SCREENSHOT_DIR wins", screenshotsDir(ov), overrides.PORTAL_SCREENSHOT_DIR);
  eq("override: POWERCLERK_DEBUG_DIR wins", portalDebugDir(ov), overrides.POWERCLERK_DEBUG_DIR);
  eq("override: AUTOPILOT_LOG_FILE wins", logFilePath(ov), overrides.AUTOPILOT_LOG_FILE);
  eq("set + database moved outside the state dir: log goes beside the database",
    logFilePath({ env: { AUTOPILOT_STATE_DIR: state, AUTOPILOT_DB_PATH: path.join(tmp, "other", "x.sqlite") }, cwd }),
    path.join(tmp, "other", "logs", "backend.log"));

  // recipeAdapter.ts (not edited here) reads three env vars with data/ fallbacks of its own.
  const env: Record<string, string | undefined> = { AUTOPILOT_STATE_DIR: state };
  const filled = applyStateDirEnvDefaults(env, cwd).sort();
  check("set: replay env defaults filled", filled.join(",") === "PORTAL_SCREENSHOT_DIR,REPLAY_CAPTURE_DIR,REPLAY_RUN_DIR", filled.join(","));
  eq("set: REPLAY_RUN_DIR -> <state>/replay-runs", env.REPLAY_RUN_DIR ?? "", path.join(state, "replay-runs"));
  eq("set: REPLAY_CAPTURE_DIR -> <state> (screenshots then land in <state>/screenshots)", env.REPLAY_CAPTURE_DIR ?? "", state);
  const own: Record<string, string | undefined> = { AUTOPILOT_STATE_DIR: state, REPLAY_RUN_DIR: "/mine/replay", PORTAL_SCREENSHOT_DIR: "/mine/shots" };
  applyStateDirEnvDefaults(own, cwd);
  check("set: an operator's REPLAY_RUN_DIR is kept", own.REPLAY_RUN_DIR === "/mine/replay");
  check("set: an operator's PORTAL_SCREENSHOT_DIR is kept, and REPLAY_CAPTURE_DIR is not filled over it",
    own.PORTAL_SCREENSHOT_DIR === "/mine/shots" && own.REPLAY_CAPTURE_DIR === undefined, JSON.stringify(own));
}

// ---------------------------------------------------------------------------------------------
// 3. The draft ledger is never silently relocated.
// ---------------------------------------------------------------------------------------------
{
  const install = path.join(tmp, "desk");
  const state = path.join(tmp, "desk-state");
  const legacy = path.join(install, "data", "portal-drafts.jsonl");
  const next = path.join(state, "portal-drafts.jsonl");
  const o = { env: { AUTOPILOT_STATE_DIR: state }, cwd: install };
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, `${JSON.stringify({ at: "2026-01-01T00:00:00Z", host: "portal.example.test" })}\n`);
  let loc = draftLedgerLocation(o);
  check("ledger: an existing ledger is kept where it is when the state dir is turned on",
    loc.path === legacy && loc.source === "legacy-kept" && !!loc.warning && loc.warning.includes(next), JSON.stringify(loc));
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(next, "");
  loc = draftLedgerLocation(o);
  check("ledger: with both files present the new one is used and the old one is named",
    loc.path === next && !!loc.warning && loc.warning.includes(legacy), JSON.stringify(loc));
  fs.writeFileSync(legacy, "");
  fs.rmSync(next);
  loc = draftLedgerLocation(o);
  check("ledger: an empty old file does not hold the ledger back", loc.path === next && loc.warning === null, JSON.stringify(loc));
  // Pointing the state dir at the install's own data/ is not a move.
  const same = draftLedgerLocation({ env: { AUTOPILOT_STATE_DIR: path.join(install, "data") }, cwd: install });
  check("ledger: a state dir that IS data/ keeps the same file", same.path === legacy && same.warning === null, JSON.stringify(same));
}

// ---------------------------------------------------------------------------------------------
// 4. Flat layout: the old backend/data/ and data/ trees share no entry names.
// ---------------------------------------------------------------------------------------------
{
  const backendNames = ["autopilot.sqlite", "project-documents", "backups", "filled", "ahj-forms", "review-submissions",
    "batch-reports", "page-images", "batch-uploads", "storage-state", "portal-profiles"];
  const dataNames = ["learn-runs", "replay-runs", "screenshots", "portal-debug", "logs", "portal-drafts.jsonl", "ops",
    "learn-benchmark", "replay-benchmark", "cross-project-replay", "portal-replicas", "live-probe",
    "replay-failures", "replay-review-misses"];
  const clash = backendNames.filter((n) => dataNames.includes(n));
  check("flat layout: no name is used under both backend/data/ and data/", clash.length === 0, clash.join(", "));
}

// ---------------------------------------------------------------------------------------------
// 5. Source scan: no new cwd-relative state path outside the resolver.
// ---------------------------------------------------------------------------------------------
{
  const repo = process.cwd();
  const ROOTS = ["backend/src", "portal-bot/src", "scripts"];
  const RESOLVER = path.join("backend", "src", "statePaths.ts");
  const PATTERNS: Array<[string, RegExp]> = [
    ["process.cwd() + \"data…\"", /process\.cwd\(\)\s*,\s*["'`]data(?:["'`/\\])/],
    ["process.cwd() + \"backend/data…\"", /process\.cwd\(\)\s*,\s*["'`]backend(?:[/\\]data|["'`]\s*,\s*["'`]data)/],
    ["relative path.join/resolve(\"data\"…)", /path\.(?:join|resolve)\(\s*["'`]data(?:["'`/\\])/],
    ["\"portal-profiles\" literal", /["'`]portal-profiles(?:["'`/\\])/],
  ];
  // Each entry: file -> [number of matching lines allowed, why]. A new match in an allowed file
  // still fails (the count is exact), and a count that drops fails too so the list stays tight.
  const ALLOWED: Record<string, [number, string]> = {
    "portal-bot/src/adapters/recipeAdapter.ts": [3,
      "not edited by this change (replay core); its REPLAY_RUN_DIR / REPLAY_CAPTURE_DIR / PORTAL_SCREENSHOT_DIR fallbacks are filled from the state dir by applyStateDirEnvDefaults in server.ts"],
    "backend/src/smoke.ts": [3, "the smoke's own scratch database and files, deleted after the run; never server state"],
    "backend/src/processProfiles.ts": [1, "a checked-in reference file (backend/data/reference-ahj-processes.json), code not state"],
    "backend/src/codeProfiles.ts": [1, "a checked-in reference file (backend/data/reference-code-profiles.json), code not state"],
    "backend/src/backup.ts": [1, "the mirror folder's name INSIDE the backup directory, not the live profile tree"],
    "scripts/run-unit-tests.ts": [1, "a folder name the test discovery walk skips, not a path it writes"],
    "scripts/run-dom-smokes.ts": [1, "a folder name the smoke discovery walk skips, not a path it writes"],
  };
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(full); continue; }
      if (!/\.(ts|js|mjs|cjs)$/.test(e.name)) continue;
      if (/\.test\.ts$|\.smoke\.ts$/.test(e.name)) continue; // tests build temp layouts on purpose
      files.push(full);
    }
  };
  for (const r of ROOTS) walk(path.join(repo, r));
  check("source scan: found the source files", files.length > 200, String(files.length));
  const counts: Record<string, string[]> = {};
  for (const full of files) {
    const rel = path.relative(repo, full).split(path.sep).join("/");
    if (rel === RESOLVER.split(path.sep).join("/")) continue;
    const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
      const hit = PATTERNS.find(([, re]) => re.test(line));
      if (hit) (counts[rel] ??= []).push(`${rel}:${i + 1} (${hit[0]}): ${t.slice(0, 140)}`);
    });
  }
  const offenders: string[] = [];
  for (const [rel, hits] of Object.entries(counts)) {
    const allowed = ALLOWED[rel]?.[0] ?? 0;
    if (hits.length !== allowed) offenders.push(...hits, `  -> ${rel}: ${hits.length} match(es), ${allowed} allowed`);
  }
  for (const [rel, [n]] of Object.entries(ALLOWED)) {
    if (!counts[rel] && n > 0) offenders.push(`${rel}: allow-list says ${n}, found 0 — delete the entry`);
  }
  check("source scan: every cwd-relative state path goes through backend/src/statePaths.ts", offenders.length === 0,
    `${offenders.join("\n       ")}\n       Add the path to statePaths.ts and call it, so AUTOPILOT_STATE_DIR moves it with the rest (#430).`);
}

// ---------------------------------------------------------------------------------------------
// 6. Docker and compose point the setting at the volume they mount.
// ---------------------------------------------------------------------------------------------
{
  const repo = process.cwd();
  const dockerfile = fs.readFileSync(path.join(repo, "Dockerfile"), "utf8");
  const compose = fs.readFileSync(path.join(repo, "docker-compose.yml"), "utf8");
  const envMatch = dockerfile.match(/^ENV\s+AUTOPILOT_STATE_DIR=(\S+)/m);
  check("Dockerfile sets AUTOPILOT_STATE_DIR", !!envMatch);
  const volMatch = compose.match(/^\s*-\s*[\w-]+:(\/\S+)\s*$/m);
  check("docker-compose mounts a named volume", !!volMatch);
  if (envMatch && volMatch) check("Dockerfile's AUTOPILOT_STATE_DIR is the path compose mounts", envMatch[1] === volMatch[1], `${envMatch[1]} vs ${volMatch[1]}`);
  const composeEnv = compose.match(/AUTOPILOT_STATE_DIR[:=]\s*"?([^"\s]+)"?/);
  check("docker-compose sets AUTOPILOT_STATE_DIR to the mounted path", !!composeEnv && !!volMatch && composeEnv[1] === volMatch[1],
    composeEnv ? composeEnv[1] : "not set");
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nstatePaths: all checks passed");
