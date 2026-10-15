// THE PORTAL REWRITES THE MODEL ON SAVE: THE STOP NAMES EVERY ROW (issue #347, Helm's #348
// review, blocker 1's visible-face shape).
//
// The row read-back also let a select hold when what it read equalled what this run saw LAND in
// that row. That capture is read the same way, right after the fill — so when it happened to be
// taken after the portal's own rewrite, the rewritten value blessed itself. Helm's re-checker saw
// the stop name row 1 only: row 2 held the portal's 430W and passed. The fix drops that
// evidence: a select holds only when the row SHOWS the wanted value (or the make's certified
// alias); what landed still feeds the stop message's expected text.
//
// Variant of the captured PowerClerk row markup (powerClerkRowFixture.ts), two arrays, the REAL
// replay in real Chromium: the row's hidden combobox inputs carry no value; a visible
// <label class="control-label">Model</label> in the model's hook div; the face VISIBLE; the
// portal saves 430W when 440W is picked (debounced ~900 ms, then re-renders).
//
//   MUST PASS — the run stops before review, naming BOTH rows, each reading the portal's 430W.
//
// NOT A DISCRIMINATOR HERE (said plainly): on the pre-review head (daae5eb7) this passes too in
// this environment. Whether the landed capture comes before or after the rewrite is a race
// between one CDP read (~20 ms after the fill's own held-check) and the portal's debounce; here
// it always comes before, so the old rule never blesses a row. A fixture cannot split those two
// reads deterministically — the held-check and the capture read the same face with nothing but
// reads between them, and a rewrite that lands before the held-check fails the select outright.
// This file pins the fixed behaviour (every rewritten row named); the rule itself is pinned by
// powerClerkRowHiddenFace.dom.smoke.ts, where the old head reaches review.
//
//   npx tsx portal-bot/src/adapters/powerClerkRowModelRewrite.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import { chromium } from "playwright";
import { TWO_ARRAYS, fieldsFor, outline, startRowFixture } from "./powerClerkRowFixture";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const { run, close } = await startRowFixture(chromium);

const T = Date.now();
console.log("\n[1] visible Model face, the portal saves 430W for 440W: the stop names both rows");
const w = await run("/?rewriteModel=1&emptyValue=1&modelLabel=1", fieldsFor(TWO_ARRAYS));
console.log(`  (${outline(w)})`);
const msg = String(w.r.message ?? "");
check("the run stops before review, naming BOTH rows",
  w.r.ok === false && /\brow 1 wants\b/.test(msg) && /\brow 2 wants\b/.test(msg),
  outline(w));
check("...and what each row reads is the portal's 430W",
  /\brows 1, 2: [^|]*Model reads "430W/.test(msg) || (/\brow 1: [^|]*Model reads "430W/.test(msg) && /\brow 2: [^|]*Model reads "430W/.test(msg)),
  msg.slice(0, 600));
console.log(`  (section [1] took ${Math.round((Date.now() - T) / 1000)} s)`);

await close();
if (failures) { console.error(`\n${failures} powerClerkRowModelRewrite.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log("\nAll powerClerkRowModelRewrite.dom.smoke checks passed.");
process.exit(0);
