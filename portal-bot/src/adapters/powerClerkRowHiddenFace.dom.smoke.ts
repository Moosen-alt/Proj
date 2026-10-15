// A LABEL BESIDE A HIDDEN FACE IS NOT THE COMBOBOX'S VALUE (issue #347, Helm's #348 review,
// blocker 1).
//
// The row read-back read a hidden-input combobox off its "face", and the face walk took the first
// ancestor level with anything visible, treating any class like /control|select|…/ as the face.
// A <label class="control-label">Model</label> in the model's hook div qualified, so with the
// real face display:none (a re-render that shows it only once opened) the widget "showed" Model.
// The read-back's containment ran both ways, so "Model" — merely PART of the wanted "440W (Model
// ZXM7-UHLDD108-440/N)" — held, and the run reached review with the portal's own 430W in both
// rows. The fix reads the face only inside the widget's own container, never from a label or
// another control, and a select holds only when the row SHOWS the wanted value.
//
// Variant of the captured PowerClerk row markup (powerClerkRowFixture.ts), two arrays, the REAL
// replay (RecipeAdapter.fillApplication) in real Chromium: the row's hidden combobox inputs carry
// no value; the Model face is display:none after a re-render until opened; a visible
// <label class="control-label">Model</label> in the model's hook div; the portal saves 430W when
// 440W is picked.
//
//   MUST PASS — the run does NOT reach review with 430W in any row; it stops before review.
//
// (Blocker 1's other shape, the face visible: powerClerkRowModelRewrite.dom.smoke.ts. Blocker 2,
//  a per-row microinverter: powerClerkRowMicroinverter.dom.smoke.ts. One variant per file keeps
//  each well inside the DOM runner's 600 s budget: a stop waits out every row control.)
//
//   npx tsx portal-bot/src/adapters/powerClerkRowHiddenFace.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import { chromium } from "playwright";
import { TWO_ARRAYS, fieldsFor, outline, reachedReview, startRowFixture } from "./powerClerkRowFixture";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const { run, close } = await startRowFixture(chromium);

const T = Date.now();
console.log("\n[1] hidden Model face + a 'Model' label in the hook div + the portal saves 430W for 440W");
const w = await run("/?rewriteModel=1&emptyValue=1&hideModelFace=1&modelLabel=1", fieldsFor(TWO_ARRAYS));
console.log(`  (${outline(w)})`);
const with430 = (w.committed.rows ?? []).map((r, i) => /430W/.test(String(r.model ?? "")) ? i + 1 : 0).filter(Boolean);
check("the run does NOT reach review with 430W in any row",
  !(reachedReview(w) && with430.length > 0),
  `reached review with 430W in row(s) ${with430.join(", ")}: ${outline(w)}`);
check("...it stops before review instead", w.r.ok === false && !w.url.endsWith("/review"), outline(w));
console.log(`  (section [1] took ${Math.round((Date.now() - T) / 1000)} s)`);

await close();
if (failures) { console.error(`\n${failures} powerClerkRowHiddenFace.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log("\nAll powerClerkRowHiddenFace.dom.smoke checks passed.");
process.exit(0);
