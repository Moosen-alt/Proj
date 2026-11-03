// EACH PV ARRAY ROW GETS ITS OWN QUANTITY AND THE JOB'S ONE MODULE MODEL (issue #535).
//
// Live PacifiCorp PowerClerk NEM learn, 2026-11-02 (the owner's multi-array test: two arrays of 4
// modules, tilt 23°, azimuths 270° and 90°, Enphase IQ8+ micros). On PV System Specification the
// learn added the second row with the right tilt and azimuth, but:
//   - row 1's Qty held 8, the SYSTEM total, and row 2's Qty stayed blank;
//   - the two rows held different module models (405 W and 440 W) for one module type;
//   - the inverter model stayed on "Please select…".
//
// The live DOM was not captured, so this fixture models the mechanisms the code shows
// (powerClerkRowFixture.ts, ?ownRows=1):
//   - the planner filled the row's Qty (the page's only "pv array quantity") with the system
//     total. The equipment pass skips a label the planner filled when the label is unique on the
//     page, so array1ModuleQuantity was never typed or recorded, and the replay's row code, which
//     fills rows 2..N from the recorded array1* steps, had no Qty step to carry over;
//   - the module list carries one series in several wattages, and the plan set names it without
//     the wattage ("Q.TRON BLK M-G2+"). The learner matched the plan-set name, which every
//     wattage contains, and took the first (405 W). The rows it added used the replay's code,
//     which reads the backend's certified name (moduleModelCertified, 440 W);
//   - the plan set names the inverter "IQ8+ Microinverter", and the list names it only by its
//     part number. Nothing matched, so the learner left it blank. The certified name
//     (inverterModelCertified) is that part number.
//
//   MUST PASS — two rows; each holds ITS OWN Qty (4 and 4, never 8), the job's one certified module
//               model (440 W) and its own azimuth; the inverter model is chosen; the recipe binds
//               the row's Qty to array1ModuleQuantity and keeps no step that types the total there.
//               (Checks: powerClerkLearnOwnRowsHarness.ts. The same job without the certified
//               inverter name: powerClerkLearnOwnRowsNoCert.dom.smoke.ts.)
//
//   npx tsx portal-bot/src/adapters/powerClerkLearnOwnRows.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import { runOwnRows } from "./powerClerkLearnOwnRowsHarness";

const failures = await runOwnRows(true);
if (failures) { console.error(`\n${failures} powerClerkLearnOwnRows.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log("\nAll powerClerkLearnOwnRows.dom.smoke checks passed.");
process.exit(0);
