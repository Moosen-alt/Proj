// THE ROWS A PERSON TYPED AT REVIEW ARE NEVER REPLAYED AS FIXED WRITES (issue #386).
//
// Live PacifiCorp PowerClerk NEM learn, 2026-10-21: the owner added rows 2–4 at review by hand.
// Patch-by-demonstration recorded the two "Add Array" clicks (#382 stops those replaying) AND the
// Qty / make / model typed into the new rows. Replayed, those steps write the LEARN project's
// numbers through bare "Qty" / "Manufacturer" / "Model" names: its Qty of "5" (two of its arrays)
// lands on whatever control the name finds first, and on a one-array project rows 2–3 never exist.
//
// The recipe here is the PacifiCorp row recipe (powerClerkRowFixture.ts) plus the owner's hand
// patch as the capture records it and the merge binds it (recipeWithHandPatchedRows): two "Add
// Array" clicks, then rows 2–3's Qty "5", certified make and certified model.
//
//   MUST PASS — a 1-array project (Qty 9) ends with ONE row holding its array, no step failed or
//               was tried and missed, and no "5" anywhere the portal kept; it reaches review.
//   MUST PASS — a 4-array project (9 / 5 / 5 / 2) ends with four rows, each holding ITS OWN array.
//   MUST PASS — the run names each of the six hand-patched row steps it did not replay.
//
//   npx tsx portal-bot/src/adapters/powerClerkHandPatchedRows.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import { chromium } from "playwright";
import { CERT_MAKE, MODEL, fieldsFor, recipeWithHandPatchedRows, startRowFixture } from "./powerClerkRowFixture";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const { run, close } = await startRowFixture(chromium);

const LIVE = [{ qty: "9", azi: "172" }, { qty: "5", azi: "82" }, { qty: "5", azi: "262" }, { qty: "2", azi: "262" }];
for (const arrays of [LIVE.slice(0, 1), LIVE]) {
  const T0 = Date.now();
  const n = arrays.length;
  console.log(`\n[${n}] a recipe holding the owner's hand-patched rows 2–3, replayed for a ${n}-array project`);
  const w = await run("/", fieldsFor(arrays), recipeWithHandPatchedRows);
  const rows = w.committed.rows ?? [];
  const summary = JSON.stringify(rows.map((r) => [r.qty, r.mfr, r.model ? "model" : "-", r.tilt, r.azi]));
  const data = (w.r as unknown as { data?: { driftWarnings?: string[]; skipped?: string[]; failedStepIndex?: number } }).data ?? {};
  check(`the project's ${n} array(s) decide the rows: ${n} row(s)`, rows.length === n, `rows=${summary}`);
  arrays.forEach((a, i) => {
    const row = rows[i] ?? {};
    check(`row ${i + 1} holds ITS OWN array: Qty ${a.qty}, ${CERT_MAKE}, 440W, tilt 24, azimuth ${a.azi}`,
      row.qty === a.qty && row.mfr === CERT_MAKE && row.model === MODEL && row.tilt === "24" && row.azi === a.azi,
      `row ${i + 1} committed ${JSON.stringify(row)}; all rows ${summary}`);
  });
  check("the run reaches REVIEW with no failed step", w.r.ok === true && w.url.endsWith("/review") && data.failedStepIndex === undefined,
    `ok=${w.r.ok} url=${w.url} failedStepIndex=${data.failedStepIndex} message=${String(w.r.message ?? "").slice(0, 300)}`);
  const missed = (data.skipped ?? []).filter((s) => /human-patch/i.test(String(s)));
  check("no hand-patched row step was tried and missed (a row it named does not exist, or its name finds two controls)",
    missed.length === 0, `skipped ${JSON.stringify(missed)}`);
  if (n === 1) {
    // The page as review shows it: every row's Qty and the inverter's (the fixture holds it at 2).
    const qtys = rows.map((r) => r.qty);
    check("no \"5\" was written anywhere: the learn project's Qty never reaches this project", !qtys.includes("5") && !JSON.stringify(w.committed).includes("\"5\""),
      `committed ${JSON.stringify(w.committed)}`);
  }
  const warnings = (data.driftWarnings ?? []).join(" | ");
  check("the run names each of the six hand-patched row steps it did not replay",
    (warnings.match(/hand-patched step \d+ \("(Qty|Manufacturer|Model)"\) not replayed/g) ?? []).length === 6, warnings.slice(0, 900));
  check("nothing was filed (the final submit is a person's)", !w.filed, "Submit Application was clicked");
  console.log(`  (section [${n}] took ${Math.round((Date.now() - T0) / 1000)} s)`);
}

await close();
if (failures) { console.error(`\n${failures} powerClerkHandPatchedRows.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log("\nAll powerClerkHandPatchedRows.dom.smoke checks passed.");
process.exit(0);
