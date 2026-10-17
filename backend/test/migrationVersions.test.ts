// THE VERSIONED MIGRATIONS ARE CONTIGUOUS (Helm's review of #349).
//
// runVersionedMigrations (backend/src/db.ts) applies only the versions ABOVE MAX(schema_meta.version).
// So when two parallel PRs each add a migration and land out of order — #349's v50 before #354's v49 —
// every database that ran v50 first NEVER runs v49: its table is silently missing on that install,
// and nothing says so. This guard reads the migrations this tree carries and fails on a gap or a
// duplicate, naming it, BEFORE the tree can merge.
//
//   MUST PASS    — every version from 1 to the newest is present exactly once.
//   MUST EXCLUDE — a gap (a version a parallel PR holds, merged after one above it) and a duplicate
//                  (two PRs that took the same number) both fail, by name.
//
// On #349's branch this is RED BY DESIGN until #354 (v49) is on main and main is merged into #349:
// it is the merge-order guard Helm asked for, not a flake. Do not add it to scripts/known-red.json.
//
//   npx tsx backend/test/migrationVersions.test.ts
import "./_isolate";
import assert from "node:assert/strict";

const { versionedMigrationVersions, latestSchemaVersion } = await import("../src/db");

let failures = 0;
let total = 0;
const check = (label: string, fn: () => void): void => {
  total++;
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

/** Why a list of versions is not 1..max exactly once (empty = contiguous). */
const gapsOf = (versions: number[]): string[] => {
  const out: string[] = [];
  const seen = new Map<number, number>();
  for (const v of versions) seen.set(v, (seen.get(v) ?? 0) + 1);
  for (const [v, n] of seen) if (n > 1) out.push(`v${v} is declared ${n} times`);
  for (const v of versions) if (!Number.isInteger(v) || v < 1) out.push(`v${v} is not a positive whole number`);
  const max = versions.reduce((m, v) => Math.max(m, v), 0);
  for (let v = 1; v <= max; v++) if (!seen.has(v)) out.push(`v${v} is missing (v${max} is declared): a database that runs v${max} first never runs a v${v} merged later`);
  return out;
};

check("the guard itself: a gap and a duplicate are each named; 1..n once is clean", () => {
  assert.deepEqual(gapsOf([1, 2, 3]), []);
  assert.ok(gapsOf([1, 2, 4]).some((x) => /^v3 is missing/.test(x)), JSON.stringify(gapsOf([1, 2, 4])));
  assert.ok(gapsOf([1, 2, 2, 3]).some((x) => /^v2 is declared 2 times/.test(x)), JSON.stringify(gapsOf([1, 2, 2, 3])));
});

const migrations = versionedMigrationVersions();
check("premise: the tree carries versioned migrations, and the newest is latestSchemaVersion()", () => {
  assert.ok(migrations.length > 0, "no versioned migrations read");
  assert.equal(Math.max(...migrations.map((m) => m.version)), latestSchemaVersion());
});
check("the versioned migrations this tree carries are 1..newest, each exactly once (a parallel PR's migration lands BEFORE any above it)", () => {
  const why = gapsOf(migrations.map((m) => m.version));
  assert.equal(why.length, 0, `${why.join("; ")}. Merge order: the PR holding the missing version merges first, then main is merged into the PR above it (for #349: #354's v49 first).`);
});
check("migration names are unique (a copied entry under a new number is caught too)", () => {
  const names = migrations.map((m) => m.name);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  assert.equal(dup.length, 0, `duplicate migration name(s): ${Array.from(new Set(dup)).join(", ")}`);
});

console.log(failures === 0
  ? `\nAll ${total}/${total} migrationVersions checks passed.`
  : `\n${failures}/${total} migrationVersions check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
