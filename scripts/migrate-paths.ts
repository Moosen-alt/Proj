// REWRITE STORED FILE PATHS FOR THE MOVE TO THE SERVER (#442, part of #429).
//
//   npx tsx scripts/migrate-paths.ts --from '<old install root>' [--to <state dir>] [--db <path>]            (dry run)
//   npx tsx scripts/migrate-paths.ts --from '<old install root>' [--to <state dir>] [--db <path>] --apply    (writes)
//   add --allow-missing to write even when a rewritten file is not on disk (or a path has no place).
//   add --plain when --from is ONE folder that maps 1:1 onto --to (see LAYOUT).
//
// WHY. The app stores ABSOLUTE paths and reads them back as stored: project_documents.stored_path is
// path.join(DOCS_DIR, projectId, …) on the machine that wrote it, and the download routes and
// fs.existsSync(row.stored_path) take it as is. Copy the Windows install's database to Linux and
// every document, screenshot bundle and run log reads as missing (404). This script finds every
// stored path under the old root, in EVERY table and column (read from sqlite_master, not a
// hand-kept list, so a table added later is not missed), and rewrites it to the server's place.
//
// LAYOUT. --from is the old install's working directory (the folder holding backend/ and data/,
// e.g. C:\Users\…\SOLAR-Proj\.probe\prod-pinned). --to is the server's AUTOPILOT_STATE_DIR (the
// default when --to is left out). The server layout is FLAT under that one root (statePaths.ts, #430):
//   <from>\backend\data\<rest>     -> <to>/<rest>               (database, project-documents, filled, …)
//   <from>\data\<rest>             -> <to>/<rest>               (learn-runs, replay-runs, screenshots, logs, …)
//   <from>\portal-profiles\<rest>  -> <to>/portal-profiles/<rest>
// The tree names come from statePaths.ts itself, so the mapping cannot drift from the resolver. A
// path under --from but outside those three trees has NO place: it is reported and, like a missing
// file, blocks --apply unless --allow-missing. --plain instead maps <from>\<rest> -> <to>/<rest>,
// for an install whose folders were overridden one at a time (run once per folder).
//
// SEPARATOR-AWARE. A Windows --from (drive letter, UNC or any backslash) matches either separator
// and ignores letter case, as Windows does; the tail is re-joined with this machine's separator. A
// POSIX --from matches case-sensitively and splits on "/" only (a backslash is a filename character
// there). The root must end at a separator: C:\root never matches C:\root2\….
//
// WHAT IT TOUCHES. A value that IS a path under the root is rewritten. A JSON value (object or
// array) is parsed and every string in it that IS such a path is rewritten, then re-serialized. A
// path merely MENTIONED inside prose (a note, an error message) is counted and left as is. NEVER
// read or written: portal_credentials (the whole table), any column named like a secret
// (encrypted…, secret, password, pass, token, hash, cipher, storage_state), SQLite's own tables,
// virtual tables and their shadow tables.
//
// SAFETY. The dry run opens the database READ-ONLY at the SQLite level (never through
// openDatabase(), which migrates and seeds — a write) and prints what would change, per table and
// column. --apply takes a `.backup` copy next to the database first (<db>.<timestamp>.backup), then
// re-plans and writes inside ONE transaction, refusing everything if any rewritten file is missing
// or any path has no place (unless --allow-missing). Run it AFTER the state folder has been copied
// onto the server, so the existence check means something. A second run finds nothing to do.
//
// It works on production data only when the owner runs it during the move (#437's runbook).
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { backendDataDir, dbPath, portalProfilesDir, runDataDir, stateDirSetting } from "../backend/src/statePaths";

export type Layout = "install" | "plain";

export interface PathRoots {
  from: string;
  to: string;
  layout?: Layout;
}

/** Tables never read or written. portal_credentials holds the encrypted client logins. */
export const SKIPPED_TABLES = new Set(["portal_credentials"]);
/** Columns never read or written, whatever table they are in. */
export const SECRET_COLUMN = /encrypt|secret|passw|(^|_)pass($|_)|token|hash|cipher|storage_state/i;

const isWindowsRoot = (p: string): boolean => /^[A-Za-z]:([\\/]|$)/.test(p) || p.startsWith("\\\\") || p.includes("\\");

/** The tree names (as segments) the resolver puts under the install root, read from statePaths.ts. */
function installTrees(): { backendData: string[]; runData: string[]; profiles: string[]; profilesUnderState: string[] } {
  const cwd = path.resolve(path.sep, "install-root");
  const state = path.resolve(path.sep, "state-root");
  const rel = (from: string, to: string): string[] => path.relative(from, to).split(path.sep).filter(Boolean);
  const unset = { env: {}, cwd };
  return {
    backendData: rel(cwd, backendDataDir(unset)),
    runData: rel(cwd, runDataDir(unset)),
    profiles: rel(cwd, portalProfilesDir(unset)),
    profilesUnderState: rel(state, portalProfilesDir({ env: { AUTOPILOT_STATE_DIR: state }, cwd })),
  };
}

export interface PathMapper {
  /** True when `value` is the root itself or a path below it. */
  isUnder(value: string): boolean;
  /** True when the root appears anywhere in `value` (a path, or prose mentioning one). */
  mentions(value: string): boolean;
  /** The new path, or null when `value` is not under the root or has no place in the layout. */
  map(value: string): string | null;
  /** A lowered, slash-normalized needle for the SQL prefilter, and whether to normalize the column. */
  needle: string;
  windows: boolean;
}

export function makePathMapper(roots: PathRoots): PathMapper {
  const layout = roots.layout ?? "install";
  const windows = isWindowsRoot(roots.from);
  const from = roots.from.replace(windows ? /[\\/]+$/ : /\/+$/, "");
  if (!from) throw new Error("--from must name a folder, not a bare root");
  const norm = (s: string): string => (windows ? s.replace(/\\/g, "/").toLowerCase() : s);
  const fromN = norm(from);
  const isSep = (c: string): boolean => c === "/" || (windows && c === "\\");
  const tailOf = (value: string): string[] | null => {
    if (norm(value.slice(0, from.length)) !== fromN) return null;
    const next = value.charAt(from.length);
    if (next && !isSep(next)) return null;
    return value.slice(from.length).split(windows ? /[\\/]+/ : /\/+/).filter(Boolean);
  };
  const trees = installTrees();
  const eq = (a: string, b: string): boolean => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  const startsWith = (segs: string[], prefix: string[]): boolean =>
    prefix.length > 0 && segs.length >= prefix.length && prefix.every((p, i) => eq(segs[i], p));
  return {
    windows,
    needle: fromN,
    isUnder: (value) => tailOf(value) !== null,
    mentions: (value) => norm(value).includes(fromN),
    map: (value) => {
      const segs = tailOf(value);
      if (!segs) return null;
      if (layout === "plain") return path.join(roots.to, ...segs);
      // Segment-wise, so backend\data\… is never read as the data\ run tree (it starts "backend").
      if (startsWith(segs, trees.backendData)) return path.join(roots.to, ...segs.slice(trees.backendData.length));
      if (startsWith(segs, trees.runData)) return path.join(roots.to, ...segs.slice(trees.runData.length));
      if (startsWith(segs, trees.profiles)) return path.join(roots.to, ...trees.profilesUnderState, ...segs.slice(trees.profiles.length));
      return null;
    },
  };
}

export interface ColumnPlan {
  table: string;
  column: string;
  /** Paths that would be rewritten (whole values and paths inside JSON). */
  rewrites: number;
  /** Rows whose value changes. */
  rows: number;
  /** Rewritten paths with no file or folder at the new place. */
  missing: string[];
  /** Paths under --from that have no place in the layout (left as is). */
  unplaced: string[];
  /** Values that mention the root inside prose (left as is). */
  mentions: number;
}

export interface PathPlan {
  columns: ColumnPlan[];
  /** Tables left out entirely (and why). */
  skipped: string[];
  /** rowid -> new value, per table.column — what --apply writes. */
  updates: Array<{ table: string; column: string; rowid: number | bigint; before: string; after: string }>;
}

const q = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Every table this script may read: user tables with a rowid, minus the skipped and virtual ones. */
function candidateTables(db: Database.Database, skipped: string[]): string[] {
  const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string; sql: string | null }>;
  const virtual = rows.filter((r) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(r.sql ?? "")).map((r) => r.name);
  const out: string[] = [];
  for (const r of rows) {
    if (r.name.startsWith("sqlite_")) continue;
    if (SKIPPED_TABLES.has(r.name)) { skipped.push(`${r.name} (portal credentials: never read)`); continue; }
    if (virtual.includes(r.name) || virtual.some((v) => r.name.startsWith(`${v}_`))) { skipped.push(`${r.name} (virtual table)`); continue; }
    if (/WITHOUT\s+ROWID/i.test(r.sql ?? "")) { skipped.push(`${r.name} (WITHOUT ROWID)`); continue; }
    out.push(r.name);
  }
  return out;
}

/** Rewrite every string in a parsed JSON value that IS a path under the root. */
function rewriteJson(node: unknown, mapper: PathMapper, onPath: (before: string, after: string | null) => void): { value: unknown; changed: boolean } {
  if (typeof node === "string") {
    if (!mapper.isUnder(node)) return { value: node, changed: false };
    const after = mapper.map(node);
    onPath(node, after);
    return after === null ? { value: node, changed: false } : { value: after, changed: true };
  }
  if (Array.isArray(node)) {
    let changed = false;
    const value = node.map((n) => { const r = rewriteJson(n, mapper, onPath); changed ||= r.changed; return r.value; });
    return { value, changed };
  }
  if (node && typeof node === "object") {
    let changed = false;
    const value: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) { const r = rewriteJson(v, mapper, onPath); changed ||= r.changed; value[k] = r.value; }
    return { value, changed };
  }
  return { value: node, changed: false };
}

export function planPathRewrites(db: Database.Database, roots: PathRoots, opts: { exists?: (p: string) => boolean } = {}): PathPlan {
  const exists = opts.exists ?? ((p: string) => fs.existsSync(p));
  const mapper = makePathMapper(roots);
  const skipped: string[] = [];
  const columns: ColumnPlan[] = [];
  const updates: PathPlan["updates"] = [];
  for (const table of candidateTables(db, skipped)) {
    const cols = db.prepare(`PRAGMA table_info(${q(table)})`).all() as Array<{ name: string }>;
    for (const { name: column } of cols) {
      if (SECRET_COLUMN.test(column)) continue;
      // Superset prefilter in SQL; the mapper decides. Only text values are ever considered.
      // A path inside JSON text has its backslashes doubled, so "\\" folds to "/" before "\".
      const expr = mapper.windows ? `lower(replace(replace(${q(column)}, char(92) || char(92), '/'), char(92), '/'))` : q(column);
      const hits = db.prepare(
        `SELECT rowid AS rid, ${q(column)} AS v FROM ${q(table)} WHERE typeof(${q(column)}) = 'text' AND instr(${expr}, ?) > 0`,
      ).all(mapper.needle) as Array<{ rid: number | bigint; v: string }>;
      if (!hits.length) continue;
      const plan: ColumnPlan = { table, column, rewrites: 0, rows: 0, missing: [], unplaced: [], mentions: 0 };
      const onPath = (before: string, after: string | null): void => {
        if (after === null) { plan.unplaced.push(before); return; }
        plan.rewrites++;
        if (!exists(after)) plan.missing.push(after);
      };
      for (const { rid, v } of hits) {
        let after: string | null = null;
        if (mapper.isUnder(v)) {
          const mapped = mapper.map(v);
          onPath(v, mapped);
          after = mapped;
        } else {
          const t = v.trim();
          let parsed: unknown = undefined;
          if (t.startsWith("{") || t.startsWith("[")) { try { parsed = JSON.parse(t); } catch { parsed = undefined; } }
          if (parsed !== undefined) {
            const before = { rewrites: plan.rewrites, unplaced: plan.unplaced.length };
            const r = rewriteJson(parsed, mapper, onPath);
            if (r.changed) after = JSON.stringify(r.value);
            // A JSON value whose strings only MENTION the root (no whole path) is prose, left as is.
            if (plan.rewrites === before.rewrites && plan.unplaced.length === before.unplaced) plan.mentions++;
          } else {
            plan.mentions++;
          }
        }
        if (after !== null && after !== v) { plan.rows++; updates.push({ table, column, rowid: rid, before: v, after }); }
      }
      columns.push(plan);
    }
  }
  return { columns, skipped, updates };
}

/** Why --apply must not write this plan, or "" when it may. */
export function planRefusal(plan: PathPlan, opts: { allowMissing?: boolean } = {}): string {
  if (opts.allowMissing) return "";
  const missing = plan.columns.reduce((n, c) => n + c.missing.length, 0);
  const unplaced = plan.columns.reduce((n, c) => n + c.unplaced.length, 0);
  const why: string[] = [];
  if (missing) why.push(`${missing} rewritten path(s) have no file at the new place (copy the state folder first)`);
  if (unplaced) why.push(`${unplaced} path(s) under --from have no place in the server layout`);
  return why.length ? `${why.join("; ")}. Nothing written. Pass --allow-missing to write anyway.` : "";
}

/** Write the plan's updates in ONE transaction. Each row is matched on its old value too. */
export function applyPathRewrites(db: Database.Database, plan: PathPlan): number {
  let changed = 0;
  db.transaction(() => {
    for (const u of plan.updates) {
      const r = db.prepare(`UPDATE ${q(u.table)} SET ${q(u.column)} = ? WHERE rowid = ? AND ${q(u.column)} = ?`).run(u.after, u.rowid, u.before);
      if (r.changes !== 1) throw new Error(`${u.table}.${u.column} row ${String(u.rowid)} changed under the script; nothing written`);
      changed += r.changes;
    }
  })();
  return changed;
}

/** Refuse roots that would make a second run rewrite its own output. */
export function rootsRefusal(roots: PathRoots): string {
  if (!roots.from.trim()) return "--from is required: the old install's folder (the one holding backend\\ and data\\).";
  if (!roots.to.trim()) return "--to is required when AUTOPILOT_STATE_DIR is not set: the server's state folder.";
  if (!path.isAbsolute(roots.to)) return `--to must be an absolute path (got ${roots.to}).`;
  const m = makePathMapper({ ...roots, layout: "plain" });
  if (m.isUnder(roots.to)) return "--to is inside --from: a second run would rewrite its own output.";
  return "";
}

/** `<db>.<UTC timestamp>.backup`, next to the database. Uses SQLite's online backup API (WAL-safe). */
export async function backupBeside(file: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${file}.${stamp}.backup`;
  const src = new Database(file, { readonly: true, fileMustExist: true });
  try { await src.backup(dest); } finally { src.close(); }
  if (!fs.existsSync(dest)) throw new Error(`backup was not written: ${dest}`);
  return dest;
}

function printPlan(plan: PathPlan): void {
  const SHOW = 5;
  if (!plan.columns.length) console.log("  No stored path under --from in any table.");
  for (const c of plan.columns) {
    const parts = [`${c.rewrites} path(s) in ${c.rows} row(s)`];
    if (c.missing.length) parts.push(`${c.missing.length} MISSING at the new place`);
    if (c.unplaced.length) parts.push(`${c.unplaced.length} with NO PLACE in the layout`);
    if (c.mentions) parts.push(`${c.mentions} mention(s) in text, left as is`);
    console.log(`  ${c.table}.${c.column}: ${parts.join(", ")}`);
    for (const p of c.missing.slice(0, SHOW)) console.log(`      missing  ${p}`);
    if (c.missing.length > SHOW) console.log(`      … ${c.missing.length - SHOW} more missing`);
    for (const p of c.unplaced.slice(0, SHOW)) console.log(`      no place ${p}`);
    if (c.unplaced.length > SHOW) console.log(`      … ${c.unplaced.length - SHOW} more without a place`);
  }
  if (plan.skipped.length) console.log(`\n  Not read: ${plan.skipped.join("; ")}; and every column named like a secret.`);
  const rows = plan.updates.length;
  const paths = plan.columns.reduce((n, c) => n + c.rewrites, 0);
  console.log(`\n  ${paths} path(s) in ${rows} row(s) would be rewritten.`);
}

// ---------------------------------------------------------------------------------------------
// CLI — only when invoked directly (the test imports the functions without side effects).
// ---------------------------------------------------------------------------------------------
const invokedDirectly = ((): boolean => {
  try {
    return !!process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  } catch { return false; }
})();

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const val = (flag: string): string => { const i = argv.indexOf(flag); return i >= 0 ? String(argv[i + 1] ?? "") : ""; };
  const apply = argv.includes("--apply");
  const allowMissing = argv.includes("--allow-missing");
  const layout: Layout = argv.includes("--plain") ? "plain" : "install";
  const from = val("--from");
  const toArg = val("--to");
  const to = toArg ? path.resolve(toArg) : stateDirSetting() ?? "";
  const file = val("--db") ? path.resolve(val("--db")) : dbPath();
  const roots: PathRoots = { from, to, layout };
  const bad = rootsRefusal(roots);
  if (bad) {
    console.error(`${bad}\nUsage: npx tsx scripts/migrate-paths.ts --from '<old install root>' [--to <state dir>] [--db <path>] [--plain] [--apply] [--allow-missing]`);
    process.exit(2);
  }

  const run = async (): Promise<number> => {
    if (!fs.existsSync(file)) { console.error(`No database at ${file}. Pass --db.`); return 2; }
    console.log(`\nStored path rewrite — ${apply ? "APPLY" : "DRY RUN (read-only; nothing written)"}`);
    console.log(`  database: ${file}\n  from:     ${from}\n  to:       ${to}  (${layout === "plain" ? "plain: <from>/<rest> -> <to>/<rest>" : "flat state layout"})\n`);
    const probe = new Database(file, { readonly: true, fileMustExist: true });
    let plan: PathPlan;
    try { plan = planPathRewrites(probe, roots); } finally { probe.close(); }
    printPlan(plan);
    const refusal = planRefusal(plan, { allowMissing });
    if (!apply) {
      console.log(refusal ? `\n  --apply would refuse: ${refusal}\n` : "\n  Dry run. Re-run with --apply to write (a .backup copy is taken first).\n");
      return 0;
    }
    if (refusal) { console.error(`\n  ${refusal}\n`); return 2; }
    if (!plan.updates.length) { console.log("\n  Nothing to write.\n"); return 0; }
    const backup = await backupBeside(file);
    console.log(`\n  Backup: ${backup}`);
    const rw = new Database(file, { fileMustExist: true });
    rw.pragma("busy_timeout = 5000");
    try {
      // Re-plan on the write connection: the file may have changed since the read-only pass.
      const fresh = planPathRewrites(rw, roots);
      const again = planRefusal(fresh, { allowMissing });
      if (again) { console.error(`\n  ${again}\n`); return 2; }
      const n = applyPathRewrites(rw, fresh);
      console.log(`  Written: ${n} row(s). Re-run without --apply to confirm nothing is left.\n`);
    } finally { rw.close(); }
    return 0;
  };
  run().then((code) => process.exit(code), (err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
}
