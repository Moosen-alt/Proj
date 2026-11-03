// THE LEARNER FILLS EVERY PV ARRAY ROW, EACH WITH ITS OWN ARRAY (issue #382) — 1 and 2 arrays.
//
// Live PacifiCorp PowerClerk NEM learn, 2026-10-21 (a project with four PV arrays: 9, 5, 5 and 2
// modules). The learner (AutoLearnAdapter) filled the ONE row a fresh application renders —
// manufacturer, model, quantity 9 — and never clicked "Add Array"; the owner added rows 2–4 by
// hand. The replay already filled one row per array (#339 / #343 / #348); the learn had no row
// logic at all.
//
// On the captured PowerClerk row markup (powerClerkRowFixture.ts): per-render ids, a fresh row
// that renders only Qty until its Qty saves, the make/model filtered selects, the model cascade,
// a debounced per-field autosave, Add Array outside the rows, a review page. The checks are in
// powerClerkLearnRowsHarness.ts; the live project's four arrays are
// powerClerkLearnArrayRows4.dom.smoke.ts.
//
//   MUST PASS — 1 and 2 arrays: one row per array, each holding ITS OWN array; the inverter keeps
//               its own; the recipe records one row bound to array1*, and no "Add Array" click.
//
//   npx tsx portal-bot/src/adapters/powerClerkLearnArrayRows.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import { LIVE_ARRAYS, runLearnRows } from "./powerClerkLearnRowsHarness";

const failures = await runLearnRows([LIVE_ARRAYS.slice(0, 1), LIVE_ARRAYS.slice(0, 2)]);
if (failures) { console.error(`\n${failures} powerClerkLearnArrayRows.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log("\nAll powerClerkLearnArrayRows.dom.smoke checks passed.");
process.exit(0);
