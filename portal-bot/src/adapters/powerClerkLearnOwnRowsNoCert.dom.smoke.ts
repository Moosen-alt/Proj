// THE SAME TWO-ARRAY JOB WITH NO CERTIFIED INVERTER NAME (issue #535) — the CEC table is unsynced,
// so the inverter's plan-set name ("IQ8+ Microinverter") is all the learner has, and the portal's
// list does not carry it. The inverter Model then stays unfilled on the page, honestly. It must not
// cost the ROWS anything: on main that unfillable control kept the revealed set non-empty, the pass
// that filled the module's make did not wait for the make's debounced save, and the scrape after it
// came too early for the row's Model. The row ended with no model, tilt or azimuth, and the rows
// the learn added had nothing recorded to copy them from.
//
// The shape and the live run (PacifiCorp, 2026-11-02) are described in
// powerClerkLearnOwnRows.dom.smoke.ts; the checks are in powerClerkLearnOwnRowsHarness.ts.
//
//   MUST PASS — two rows, each with its own Qty 4, the certified 440 W model, tilt 23 and its own
//               azimuth; no inverter model guessed.
//
//   npx tsx portal-bot/src/adapters/powerClerkLearnOwnRowsNoCert.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import { runOwnRows } from "./powerClerkLearnOwnRowsHarness";

const failures = await runOwnRows(false);
if (failures) { console.error(`\n${failures} powerClerkLearnOwnRowsNoCert.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log("\nAll powerClerkLearnOwnRowsNoCert.dom.smoke checks passed.");
process.exit(0);
