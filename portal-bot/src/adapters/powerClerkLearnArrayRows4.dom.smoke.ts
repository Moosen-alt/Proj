// THE LEARNER FILLS EVERY PV ARRAY ROW, EACH WITH ITS OWN ARRAY (issue #382) — the live project's
// four arrays (9 / 5 / 5 / 2 modules), where the learn filled row 1 and never clicked "Add Array".
//
// Same harness and fixture as powerClerkLearnArrayRows.dom.smoke.ts (1 and 2 arrays); split so
// each file stays well inside the DOM runner's 600 s budget.
//
//   MUST PASS — four rows, each holding ITS OWN array; the inverter keeps its own; the recipe
//               records one row bound to array1*, and no "Add Array" click.
//
//   npx tsx portal-bot/src/adapters/powerClerkLearnArrayRows4.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import { LIVE_ARRAYS, runLearnRows } from "./powerClerkLearnRowsHarness";

const failures = await runLearnRows([LIVE_ARRAYS]);
if (failures) { console.error(`\n${failures} powerClerkLearnArrayRows4.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log("\nAll powerClerkLearnArrayRows4.dom.smoke checks passed.");
process.exit(0);
