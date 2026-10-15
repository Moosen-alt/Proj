// ROWS THE PORTAL WILL NOT KEEP STOP THE RUN — CAPTURED, AND NAMED ROW BY ROW (issue #347).
//
// The live row read-back stop (2026-10-15) kept no page capture — the fix had to be diagnosed
// from a two-week-old learn capture — and its message was cut mid-word by a downstream reader
// that keeps ~300 characters, having listed only row 1 by then. Here the portal rewrites every
// row's azimuth on save (the captured PowerClerk row markup, shared fixture powerClerkRowFixture):
//
//   MUST PASS — the run stops before review; the stop writes a page capture (screenshot +
//               sanitized HTML, as other stops do); and the message names EVERY failing row with
//               its expected values inside the first 300 characters.
//
//   npx tsx portal-bot/src/adapters/powerClerkRowHooksStop.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { ARRAYS, fieldsFor, startRowFixture } from "./powerClerkRowFixture";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const { run, close } = await startRowFixture(chromium);

const T1 = Date.now();
console.log("\n[2] the portal rewrites every row's azimuth on save: stop before review, captured, every row named");
const captureRoots = [process.env.REPLAY_CAPTURE_DIR, process.env.REPLAY_RUN_DIR].filter((d): d is string => !!d);
const filesUnder = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => {
    let ents: fs.Dirent[] = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full); else out.push(full);
    }
  };
  walk(dir);
  return out;
};
const before = new Set(captureRoots.flatMap(filesUnder));
const TWO = ARRAYS.slice(0, 2);
const s = await run("/?rewrite=1", fieldsFor(TWO));
const msg = String(s.r.message ?? "");
const captures = captureRoots.flatMap(filesUnder).filter((f) => !before.has(f) && /array-rows/i.test(path.basename(f)));
check("the run stops before review (nothing staged)", s.r.ok === false, `ok=${s.r.ok} message=${msg.slice(0, 300)}`);
check("the stop wrote a page capture", captures.length > 0, `new files under ${captureRoots.join(", ")}: none named array-rows`);
check("the message names EVERY failing row with its expected values",
  /row 1\b[^|]*9\b[^|]*172/i.test(msg) && /row 2\b[^|]*6\b[^|]*82/i.test(msg), msg.slice(0, 600));
// The live cut was DOWNSTREAM (a reader keeps ~300 characters of a failure), so the rows must be
// complete before that point — every row, with its values, in the first 300 characters.
check("...complete within the first 300 characters a downstream reader keeps",
  /row 1\b[^|]*9\b[^|]*172/i.test(msg.slice(0, 300)) && /row 2\b[^|]*6\b[^|]*82/i.test(msg.slice(0, 300)),
  msg.slice(0, 320));

console.log(`  (section [2] took ${Math.round((Date.now() - T1) / 1000)} s)`);

await close();
if (failures) { console.error(`\n${failures} powerClerkRowHooksStop.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log("\nAll powerClerkRowHooksStop.dom.smoke checks passed.");
process.exit(0);
