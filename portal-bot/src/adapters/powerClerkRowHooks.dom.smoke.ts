// EVERY ROW GETS ITS MODULE: THE ROW'S OWN HOOKS, AND A COMBOBOX WHOSE LABELLED INPUT IS HIDDEN
// (issue #347, the live follow-up to #339).
//
// Live PacifiCorp PowerClerk NEM re-stage, 2026-10-15 (six arrays). Row targeting worked — each
// row received ITS OWN Qty — but no row's manufacturer was ever chosen, so Model / Tilt / Azimuth
// never rendered and the run stopped before review. The module make/model are PowerClerk's Vue
// "filtered select": the labelled input (role=combobox, aria-label "Manufacturer") is
// `visually-hidden`; the visible part is div[data-test-role=filteredSelectField] inside
// [data-test-role=pv-array-manufacturer-select]. The row resolver kept only truly-visible
// matches, so "Manufacturer" resolved to nothing in the row, every row, every pass. The Qty was
// recorded as "pv array quantity" (the test-role, humanised), not the row's "Qty"; the read-back
// compared the plan-set make ("ZNShine Solar") instead of the certified name the fill chose; and
// the stop kept no page capture and was cut mid-word.
//
// The fixture is the captured row markup (data/learn-runs/2026-09-28_16-05-17_pacificorp_0upf,
// page p009; equipment only, no customer data; learner marks stripped): the delete button inside
// the legend, the row's own Clone, Add Array / Calculate outside the rows, per-render
// pcInputBase… ids (row 1's Qty is #pcInputBase56 at learn time, as captured), a fresh row that
// renders only Qty until its Qty saves, the make combobox (hidden labelled input + visible field +
// a teleported listbox), the model's cascade from the make, Tilt / Azimuth / Tracking after the
// model saves, a debounced per-field autosave, and a review page.
//
//   MUST PASS — six arrays: every row ends with ITS OWN qty / make (the certified "Znshine
//               PV-Tech") / model / tilt / azimuth / tracking, the inverter keeps its own, and the
//               run reaches review.
//   (The stop — rows the portal will not keep, its capture and its every-row message — is
//    powerClerkRowHooksStop.dom.smoke.ts, on the same fixture: powerClerkRowFixture.ts. Two files
//    keep each well inside the DOM runner's 600 s budget; six rows of combobox picks take ~5 min.)
//
//   npx tsx portal-bot/src/adapters/powerClerkRowHooks.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import { chromium } from "playwright";
import { ARRAYS, CERT_MAKE, MODEL, fieldsFor, startRowFixture } from "./powerClerkRowFixture";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const { run, close } = await startRowFixture(chromium);

// ===========================================================================================
// 1) MUST PASS — six arrays: every row gets its module, the run reaches review.
// ===========================================================================================
const T0 = Date.now();
console.log("\n[1] six PV arrays on the captured PowerClerk row markup");
const w = await run("/", fieldsFor(ARRAYS));
const rows = w.committed.rows ?? [];
const summary = JSON.stringify(rows.map((r) => [r.qty, r.mfr, r.model ? "model" : "-", r.tilt, r.azi, r.track]));
check("one row per array: six rows", rows.length === 6, `rows=${summary}`);
ARRAYS.forEach((a, i) => {
  const row = rows[i] ?? {};
  check(`row ${i + 1} holds ITS OWN array: Qty ${a.qty}, ${CERT_MAKE}, 440W, tilt 24, azimuth ${a.azi}, Fixed`,
    row.qty === a.qty && row.mfr === CERT_MAKE && row.model === MODEL && row.tilt === "24" && row.azi === a.azi && (row.track || "Fixed") === "Fixed",
    `row ${i + 1} committed ${JSON.stringify(row)}; all rows ${summary}`);
});
check("the inverter keeps ITS OWN make and model",
  w.committed.invMfr === "Altenergy Power System" && /DS3-L \{240V\}/.test(String(w.committed.invModel ?? "")),
  JSON.stringify({ mfr: w.committed.invMfr, model: w.committed.invModel }));
const wData = (w.r as unknown as { pauseReason?: string }).pauseReason;
check("the run reaches REVIEW (staged, not stopped before it)",
  w.r.ok === true && wData !== "stopped_before_review" && /stopped at review/i.test(String(w.r.message ?? "")) && w.url.endsWith("/review"),
  `ok=${w.r.ok} pauseReason=${wData} url=${w.url} message=${String(w.r.message ?? "").slice(0, 300)}`);
check("nothing was filed (the final submit is a person's)", !w.filed, "Submit Application was clicked");
console.log(`  (section [1] took ${Math.round((Date.now() - T0) / 1000)} s)`);

await close();
if (failures) { console.error(`\n${failures} powerClerkRowHooks.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log("\nAll powerClerkRowHooks.dom.smoke checks passed.");
process.exit(0);
