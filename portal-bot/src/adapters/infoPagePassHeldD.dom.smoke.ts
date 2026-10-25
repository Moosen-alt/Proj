// HELD-PINS D (#344, option B): skeptic B's lrp under the PRODUCTION readiness gate
// (PORTAL_SECTION_READY_MS unset = 12 s; the form's input renders 22 s after load, so the learner's
// scan sees no fillable control), walked by the real learner with NO verified page and with a
// NEAR-MISS verified page — main's outcome both ways, and no information page passed. Its own file:
// the gate is process-wide. See infoPageHeldHarness.ts.
//
//   npx tsx portal-bot/src/adapters/infoPagePassHeldD.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import { runHeldShapes } from "./infoPageHeldHarness";

await runHeldShapes("infoPagePassHeldD.dom.smoke", ["lrp"], { concurrency: 1, readyMs: null });
