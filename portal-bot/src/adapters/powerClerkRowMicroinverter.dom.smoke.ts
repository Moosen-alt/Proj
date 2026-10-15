// A PER-ROW MICROINVERTER IS NEVER WRITTEN FOR THE MODULE (issue #347, Helm's #348 review,
// blocker 2: the fill and the read-back acting on different controls).
//
// The row resolver counted only USABLE controls. A row with its own microinverter Manufacturer /
// Model before the module's, and the module's face in a class the face walk does not know, made
// "two Manufacturers, one unrecognised" read as "one Manufacturer": the micro's. The fill (which
// walked the levels its own way) wrote the module make/model into the micro — the micro list also
// carries the module makes — the module was never written, and the read-back checked the micro,
// so the run reached review. The fix counts every control a level NAMES (two = ambiguous, one that
// is not usable = a veto, never a fall-through), and the fill writes through the one level the
// resolver accepted.
//
// Variant of the captured PowerClerk row markup (powerClerkRowFixture.ts), two arrays, the REAL
// replay in real Chromium: a per-row microinverter Manufacturer / Model (Enphase / QT2) before the
// module's, whose make list also carries the module makes; no row hooks (no data-test-role on the
// row's controls); the module make/model faces in classes the face walk does not know.
//
//   MUST PASS — the microinverter keeps its own make/model in every row, and the run does not reach
//               review with the module unfilled.
//
//   npx tsx portal-bot/src/adapters/powerClerkRowMicroinverter.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import { chromium } from "playwright";
import { MICRO_MAKE, MICRO_MODEL, TWO_ARRAYS, fieldsFor, outline, reachedReview, startRowFixture } from "./powerClerkRowFixture";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const { run, close } = await startRowFixture(chromium);

const T = Date.now();
console.log("\n[1] per-row micro before the module, no row hooks, the module face in an unknown class");
const w = await run("/?micro=1&noHooks=1&moduleFace=unknown", fieldsFor(TWO_ARRAYS));
console.log(`  (${outline(w)})`);
const rows = w.committed.rows ?? [];
const microHit = rows.map((r, i) => r.microMfr === MICRO_MAKE && r.microModel === MICRO_MODEL ? 0 : i + 1).filter(Boolean);
check(`the microinverter keeps its own make/model (${MICRO_MAKE} / QT2) in every row`,
  rows.length === 2 && microHit.length === 0,
  `micro overwritten in row(s) ${microHit.join(", ") || "?"}: ${outline(w)}`);
const unfilled = rows.map((r, i) => r.mfr && r.model ? 0 : i + 1).filter(Boolean);
check("the run does not reach review with the module unfilled",
  !(reachedReview(w) && (unfilled.length > 0 || rows.length < 2)),
  `reached review with no module make/model in row(s) ${unfilled.join(", ")}: ${outline(w)}`);
console.log(`  (section [1] took ${Math.round((Date.now() - T) / 1000)} s)`);

await close();
if (failures) { console.error(`\n${failures} powerClerkRowMicroinverter.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log("\nAll powerClerkRowMicroinverter.dom.smoke checks passed.");
process.exit(0);
