// HELD-PINS C (#344, option B): skeptic B's shapes (a summary straight after the tile, m7 / m7a /
// m7c / m7g / m8, late-rendered form pages lr / lrn, a review sentence rendered after load), each
// walked by the real learner with NO verified page and with a NEAR-MISS verified page — main's
// outcome both ways, and no information page passed. See infoPageHeldHarness.ts.
//
//   npx tsx portal-bot/src/adapters/infoPagePassHeldC.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import { runHeldShapes } from "./infoPageHeldHarness";

await runHeldShapes("infoPagePassHeldC.dom.smoke", ["m7", "m7a", "m7c", "m7g", "m8", "lr", "lrn", "late"], { concurrency: 3 });
