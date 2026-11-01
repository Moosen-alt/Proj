// EVERY ON-DISK STATE PATH, FROM ONE PLACE (#430).
//
// The app writes state into three trees that each resolved against process.cwd() on their own:
//   backend/data/     the database, project documents, filled forms, backups, uploads
//   data/             learn and replay runs, screenshots, portal-debug, logs, the draft ledger
//   portal-profiles/  one Chrome profile per (client, portal): the live portal logins
// A container mounts ONE volume. Docker mounted it at /app/backend/data only, so the portal
// logins, the draft ledger (the record of drafts left on real portals), every run bundle and the
// log were written into the container layer and lost on every redeploy.
//
// AUTOPILOT_STATE_DIR names that one root. When it is set, all three trees live in it, flat:
//   <state>/autopilot.sqlite, <state>/project-documents, <state>/backups, ...   (was backend/data/)
//   <state>/learn-runs, <state>/replay-runs, <state>/screenshots, <state>/logs,
//   <state>/portal-debug, <state>/portal-drafts.jsonl, ...                     (was data/)
//   <state>/portal-profiles                                                     (was portal-profiles/)
// Flat on purpose: the Docker volume is already /app/backend/data, so pointing the setting at it
// keeps an existing container's database, documents and backups exactly where they are and moves
// in only what used to be lost. The two old trees share no entry names (statePaths.test pins it).
//
// UNSET, NOTHING MOVES: every path below resolves exactly as it did before this module existed
// (statePaths.test pins each one), so the desk install is unchanged. A per-path override
// (AUTOPILOT_DB_PATH, PROJECT_DOCS_DIR, PORTAL_PROFILES_DIR, PORTAL_DRAFT_LEDGER, AUTOLEARN_RUN_DIR,
// REPLAY_RUN_DIR, PORTAL_SCREENSHOT_DIR, POWERCLERK_DEBUG_DIR, BACKUP_DIR, AUTOPILOT_LOG_FILE)
// still wins over both. Relative overrides resolve against the working directory, as they always
// did.
//
// Every function reads the environment when CALLED, never at import, so a script that loads
// dotenv after its static imports (the ops scripts) still sees the setting.
//
// statePaths.test also scans the source: a new `path.join(process.cwd(), "data", …)`, a
// "backend/data" literal or a "portal-profiles" literal outside this file fails it. Add the path
// here instead.
import fs from "node:fs";
import path from "node:path";

type Env = Record<string, string | undefined>;

export interface StatePathOptions {
  env?: Env;
  cwd?: string;
}

const envOf = (o?: StatePathOptions): Env => o?.env ?? process.env;
const cwdOf = (o?: StatePathOptions): string => path.resolve(o?.cwd ?? process.cwd());
const setting = (env: Env, key: string): string => String(env[key] ?? "").trim();

/** The AUTOPILOT_STATE_DIR root, resolved, or null when unset (today's layout). */
export function stateDirSetting(o?: StatePathOptions): string | null {
  const v = setting(envOf(o), "AUTOPILOT_STATE_DIR");
  return v ? path.resolve(cwdOf(o), v) : null;
}

/** The root every default lives under: the state dir, else the working directory. */
export function stateRoot(o?: StatePathOptions): string {
  return stateDirSetting(o) ?? cwdOf(o);
}

/** Today's backend/data/ — the database's own folder. */
export function backendDataDir(o?: StatePathOptions): string {
  return stateDirSetting(o) ?? path.join(cwdOf(o), "backend", "data");
}

/** Today's data/ — run bundles, screenshots, logs, the draft ledger. */
export function runDataDir(o?: StatePathOptions): string {
  return stateDirSetting(o) ?? path.join(cwdOf(o), "data");
}

/** A per-path override resolved against the cwd, or the default under the state root. */
const pick = (o: StatePathOptions | undefined, key: string, fallback: string): string => {
  const v = setting(envOf(o), key);
  return v ? path.resolve(cwdOf(o), v) : fallback;
};

export function dbPath(o?: StatePathOptions): string {
  return pick(o, "AUTOPILOT_DB_PATH", path.join(backendDataDir(o), "autopilot.sqlite"));
}

export function projectDocsDir(o?: StatePathOptions): string {
  return pick(o, "PROJECT_DOCS_DIR", path.join(backendDataDir(o), "project-documents"));
}

export function backupDir(o?: StatePathOptions): string {
  return pick(o, "BACKUP_DIR", path.join(backendDataDir(o), "backups"));
}

export function portalProfilesDir(o?: StatePathOptions): string {
  return pick(o, "PORTAL_PROFILES_DIR", path.join(stateRoot(o), "portal-profiles"));
}

export function learnRunsDir(o?: StatePathOptions): string {
  return pick(o, "AUTOLEARN_RUN_DIR", path.join(runDataDir(o), "learn-runs"));
}

export function replayRunsDir(o?: StatePathOptions): string {
  return pick(o, "REPLAY_RUN_DIR", path.join(runDataDir(o), "replay-runs"));
}

export function screenshotsDir(o?: StatePathOptions): string {
  return pick(o, "PORTAL_SCREENSHOT_DIR", path.join(runDataDir(o), "screenshots"));
}

export function portalDebugDir(o?: StatePathOptions): string {
  return pick(o, "POWERCLERK_DEBUG_DIR", path.join(runDataDir(o), "portal-debug"));
}

/** Watchdog state and log (scripts/ops). */
export function opsDir(o?: StatePathOptions): string {
  return path.join(runDataDir(o), "ops");
}

/**
 * THE LOG BELONGS TO THE DATABASE IT DESCRIBES (logger.ts tells the history). A process whose
 * database lives outside its state root is not this installation's server, so it logs beside its
 * own database; otherwise the log is <data>/logs/backend.log. With the setting unset the root is
 * the working directory, exactly the old rule. Returns "" when AUTOPILOT_LOG_FILE is set to "".
 */
export function logFilePath(o?: StatePathOptions): string {
  const env = envOf(o);
  if (env.AUTOPILOT_LOG_FILE === "") return "";
  if (env.AUTOPILOT_LOG_FILE) return env.AUTOPILOT_LOG_FILE;
  const db = dbPath(o);
  const rel = path.relative(stateRoot(o), db);
  const dbOutsideRoot = rel.startsWith("..") || path.isAbsolute(rel);
  return dbOutsideRoot ? path.join(path.dirname(db), "logs", "backend.log") : path.join(runDataDir(o), "logs", "backend.log");
}

/**
 * THE DRAFT LEDGER IS NEVER SILENTLY RELOCATED. It is the only unpruned record of drafts left on
 * real portals (draftLedger.ts). An install that turns AUTOPILOT_STATE_DIR on with a ledger
 * already at the old data/portal-drafts.jsonl keeps writing THAT file (and says so) until the
 * operator moves it, rather than quietly starting an empty one under the new root. A fresh
 * container has no old ledger, so it writes under the state dir from its first run.
 */
export interface DraftLedgerLocation {
  path: string;
  /** "override" (PORTAL_DRAFT_LEDGER), "default", "state-dir", or "legacy-kept". */
  source: "override" | "default" | "state-dir" | "legacy-kept";
  /** One plain sentence when the operator should act; null otherwise. */
  warning: string | null;
}

const hasContent = (file: string): boolean => {
  try { return fs.statSync(file).size > 0; } catch { return false; }
};

export function draftLedgerLocation(o?: StatePathOptions): DraftLedgerLocation {
  const env = envOf(o);
  const override = setting(env, "PORTAL_DRAFT_LEDGER");
  if (override) return { path: path.resolve(cwdOf(o), override), source: "override", warning: null };
  const legacy = path.join(cwdOf(o), "data", "portal-drafts.jsonl");
  if (!stateDirSetting(o)) return { path: legacy, source: "default", warning: null };
  const next = path.join(runDataDir(o), "portal-drafts.jsonl");
  if (path.resolve(next) === path.resolve(legacy) || !hasContent(legacy)) return { path: next, source: "state-dir", warning: null };
  if (!fs.existsSync(next)) {
    return {
      path: legacy, source: "legacy-kept",
      warning: `AUTOPILOT_STATE_DIR is set but the draft ledger is still at ${legacy}; it stays there until you move it to ${next}.`,
    };
  }
  return {
    path: next, source: "state-dir",
    warning: `Two draft ledgers exist: ${next} (in use) and ${legacy} (older rows). Append the old file to the new one and delete it.`,
  };
}

let ledgerWarned = false;
/** The ledger path the app writes. Warns once per process when the location needs the operator. */
export function draftLedgerPath(o?: StatePathOptions): string {
  const loc = draftLedgerLocation(o);
  if (loc.warning && !ledgerWarned && !o) {
    ledgerWarned = true;
    console.warn(`[draft-ledger] ${loc.warning}`);
  }
  return loc.path;
}

/**
 * portal-bot/src/adapters/recipeAdapter.ts reads REPLAY_RUN_DIR, REPLAY_CAPTURE_DIR and
 * PORTAL_SCREENSHOT_DIR with data/ fallbacks of its own. When the state dir is set, fill the ones
 * the operator left unset so replay output lands under it too (captures, then screenshots, go to
 * <state>/…, the same names they had under data/). Unset, this changes nothing. Returns the keys
 * it set.
 */
export function applyStateDirEnvDefaults(env: Env = process.env, cwd?: string): string[] {
  const o = { env, cwd };
  if (!stateDirSetting(o)) return [];
  const want: Record<string, string> = {
    REPLAY_RUN_DIR: replayRunsDir(o),
    // recipeAdapter sends screenshots to REPLAY_CAPTURE_DIR/screenshots whenever REPLAY_CAPTURE_DIR
    // is set, so filling it would override an operator's own PORTAL_SCREENSHOT_DIR. Leave it then.
    ...(setting(env, "PORTAL_SCREENSHOT_DIR") ? {} : { REPLAY_CAPTURE_DIR: runDataDir(o) }),
    PORTAL_SCREENSHOT_DIR: screenshotsDir(o),
  };
  const set: string[] = [];
  for (const [k, v] of Object.entries(want)) {
    if (setting(env, k)) continue;
    env[k] = v;
    set.push(k);
  }
  return set;
}
