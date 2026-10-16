// HELD-PINS A (#344, option B): the #349 attack catalogue, skeptic C's pre-form shapes and Helm's
// post-form controls, each walked by the real learner with NO verified page and with a NEAR-MISS
// verified page — main's outcome both ways, and no information page passed. See
// infoPageHeldHarness.ts for the shapes and the assertions.
//
//   npx tsx portal-bot/src/adapters/infoPagePassHeldA.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import { runHeldShapes } from "./infoPageHeldHarness";

await runHeldShapes("infoPagePassHeldA.dom.smoke", ["pf1", "pf1a", "pf1sg", "tw", "d1m", "d1ma", "d1mcap", "cap", "ol", "pns", "gl", "glf", "capf", "capfo", "fo"], { concurrency: 3 });
