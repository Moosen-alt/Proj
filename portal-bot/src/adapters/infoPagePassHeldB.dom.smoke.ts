// HELD-PINS B (#344, option B): skeptic A's shapes (send pages, beacons, on-load POSTs, a
// deterministic record-type pass, a resumed draft, pay-now wording, the run's first page) and
// Helm's m1-m6 / d1-d2, each walked by the real learner with NO verified page and with a NEAR-MISS
// verified page — main's outcome both ways, and no information page passed. See
// infoPageHeldHarness.ts for the shapes and the assertions.
//
//   npx tsx portal-bot/src/adapters/infoPagePassHeldB.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import { runHeldShapes } from "./infoPageHeldHarness";

await runHeldShapes("infoPagePassHeldB.dom.smoke", ["a1", "a2", "a3", "a4", "a5", "a6", "b1", "e1", "e2", "f1", "f2", "k1", "dr1", "pay1", "pay2", "h1", "m1", "m2", "m3", "m4", "m5", "m6", "d1", "d2"], { concurrency: 3 });
