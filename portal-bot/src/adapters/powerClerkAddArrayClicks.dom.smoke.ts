// A RECORDED "ADD ARRAY" CLICK NEVER DECIDES HOW MANY ROWS A PROJECT GETS (issue #382).
//
// Live PacifiCorp PowerClerk NEM learn, 2026-10-21: the learner filled one PV Array row and the
// owner added rows 2–4 by hand at review. Patch-by-demonstration recorded the owner's two "Add
// Array" clicks into the recipe as ordinary clicks, so every later replay would add exactly two
// rows — three rows for a one-array project, six for a four-array one — whatever the project's
// own arrays say.
//
// The recipe here is the PacifiCorp row recipe (powerClerkRowFixture.ts) plus two recorded "Add
// Array" clicks after the row, the shapes the capture records: one by role + name, one by the
// button's test hook only, both noted "human-patch: Add Array".
//
//   MUST PASS — a 1-array project ends with ONE row holding its array, and reaches review.
//   MUST PASS — a 4-array project ends with FOUR rows, each holding ITS OWN array (the rows come
//               from the project's arrays, one per array), and reaches review.
//   MUST PASS — the run says the recorded clicks were not replayed.
//
//   npx tsx portal-bot/src/adapters/powerClerkAddArrayClicks.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import { chromium } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { CERT_MAKE, MODEL, fieldsFor, recipe, startRowFixture } from "./powerClerkRowFixture";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// The row recipe with the owner's two recorded clicks spliced in after the row (before Next).
const withRecordedAdds = (url: string): PortalRecipe => {
  const base = recipe(url);
  const steps = [...base.steps];
  const next = steps.findIndex((s) => s.action === "click" && /next/i.test(String(s.note ?? "")));
  const adds: RecipeStep[] = [
    { action: "click", selector: { role: "button", name: "Add Array" }, note: "human-patch: Add Array" },
    { action: "click", selector: { css: '[data-test-role="add-array-btn"]' }, note: "human-patch: Add Array" },
  ];
  steps.splice(next, 0, ...adds);
  return { ...base, steps };
};

const { run, close } = await startRowFixture(chromium);

const LIVE = [{ qty: "9", azi: "172" }, { qty: "5", azi: "82" }, { qty: "5", azi: "262" }, { qty: "2", azi: "262" }];
for (const arrays of [LIVE.slice(0, 1), LIVE]) {
  const T0 = Date.now();
  const n = arrays.length;
  console.log(`\n[${n}] a recipe holding two recorded "Add Array" clicks, replayed for a ${n}-array project`);
  const w = await run("/", fieldsFor(arrays), withRecordedAdds);
  const rows = w.committed.rows ?? [];
  const summary = JSON.stringify(rows.map((r) => [r.qty, r.mfr, r.model ? "model" : "-", r.tilt, r.azi]));
  check(`the project's ${n} array(s) decide the rows: ${n} row(s), not ${n + 2}`, rows.length === n, `rows=${summary}`);
  arrays.forEach((a, i) => {
    const row = rows[i] ?? {};
    check(`row ${i + 1} holds ITS OWN array: Qty ${a.qty}, ${CERT_MAKE}, 440W, tilt 24, azimuth ${a.azi}`,
      row.qty === a.qty && row.mfr === CERT_MAKE && row.model === MODEL && row.tilt === "24" && row.azi === a.azi,
      `row ${i + 1} committed ${JSON.stringify(row)}; all rows ${summary}`);
  });
  check("the run reaches REVIEW", w.r.ok === true && w.url.endsWith("/review"),
    `ok=${w.r.ok} url=${w.url} message=${String(w.r.message ?? "").slice(0, 300)}`);
  const warnings = ((w.r as unknown as { data?: { driftWarnings?: string[] } }).data?.driftWarnings ?? []).join(" | ");
  check("the run says the recorded \"Add Array\" clicks were not replayed",
    (warnings.match(/recorded "Add Array" click \(step \d+\) not replayed/g) ?? []).length === 2, warnings.slice(0, 500));
  check("nothing was filed (the final submit is a person's)", !w.filed, "Submit Application was clicked");
  console.log(`  (section [${n}] took ${Math.round((Date.now() - T0) / 1000)} s)`);
}

await close();
if (failures) { console.error(`\n${failures} powerClerkAddArrayClicks.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log("\nAll powerClerkAddArrayClicks.dom.smoke checks passed.");
process.exit(0);
