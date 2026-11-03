// A HAND-PATCHED PV-ARRAY ROW WRITE IS KNOWN AS ONE (#386).
//
// The CI-run twin of powerClerkHandPatchedRows.dom.smoke (which needs a real Chromium):
// handPatchedArrayRowSteps names, by step, the human-patched writes a replay must not repeat —
//   - the owner's shape (two recorded "Add Array" clicks, then rows 2–3's Qty / make / model,
//     as the capture records them and the merge binds them) — all six;
//   - a row past the first by its field (array2ModuleQuantity), its section ("PV Array 3") or a
//     row hook's nth, with no adder click recorded;
// and nothing else: row 1's own fixes, the recorded row block, the inverter's "Manufacturer"
// (section "Inverter") after an adder click, a non-row control, a learner step, and a human-patched
// run that a learner step has ended.
//
//   npx tsx portal-bot/src/adapters/handPatchedArrayRows.test.ts
import assert from "node:assert/strict";
import type { RecipeStep } from "../../../shared/src/types";
import { handPatchedArrayRowSteps } from "./recipeAdapter";
import { recipeWithHandPatchedRows } from "./powerClerkRowFixture";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

const adder: RecipeStep = { action: "click", selector: { role: "button", name: "Add Array" }, note: "human-patch: Add Array" };
const patch = (s: Partial<RecipeStep>): RecipeStep => ({ action: "fill", value: "5", note: "human-patch: Qty", selector: { role: "textbox", name: "Qty" }, ...s } as RecipeStep);
const keys = (steps: RecipeStep[]): number[] => [...handPatchedArrayRowSteps(steps).keys()];

check("the owner's shape: all six row writes after the two Add Array clicks, nothing of the recorded recipe", () => {
  const steps = recipeWithHandPatchedRows("http://fixture.invalid/").steps;
  const got = handPatchedArrayRowSteps(steps);
  const want = steps.map((s, i) => ({ s, i })).filter(({ s }) => /^human-patch: (Qty|Manufacturer|Model)$/.test(String(s.note))).map(({ i }) => i);
  assert.equal(want.length, 6);
  assert.deepEqual([...got.keys()], want);
  for (const why of got.values()) assert.match(why, /after the recorded "Add Array" click \(step \d+\)/);
});

check("a row past the first by its field, its section or a row hook's nth — no adder click needed", () => {
  const steps = [
    patch({ field: "array2ModuleQuantity", value: undefined }),
    patch({ fingerprint: { section: "PV Array 3" } }),
    patch({ selector: { css: '[data-test-role="pv-array-quantity"]', nth: 1 } }),
  ];
  const got = handPatchedArrayRowSteps(steps);
  assert.deepEqual([...got.keys()], [0, 1, 2]);
  assert.deepEqual([...got.values()].map((w) => /row (\d+)/.exec(w)?.[1]), ["2", "3", "2"]);
});

check("row 1's own hand fixes replay (no adder click before them)", () => {
  assert.deepEqual(keys([
    patch({}),
    patch({ action: "select", note: "human-patch: Manufacturer", selector: { role: "combobox", name: "Manufacturer" }, value: "Znshine PV-Tech" }),
    patch({ fingerprint: { section: "PV Array 1" } }),
    patch({ field: "array1Tilt", note: "human-patch: Tilt", selector: { label: "Tilt" } }),
  ]), []);
});

check("after an adder click: the inverter's Manufacturer and a non-row control replay", () => {
  assert.deepEqual(keys([
    adder,
    patch({ action: "select", note: "human-patch: Manufacturer", selector: { role: "combobox", name: "Manufacturer" }, fingerprint: { section: "Inverter Clone System" }, value: "Altenergy Power System" }),
    patch({ note: "human-patch: Customer Phone", selector: { role: "textbox", name: "Customer Phone" }, value: "555-0100" }),
    patch({ action: "click", note: "human-patch: Calculate", selector: { role: "button", name: "Calculate" }, value: undefined }),
  ]), []);
});

check("the recorded learner steps are never named, even past an adder click", () => {
  assert.deepEqual(keys([
    adder,
    { action: "fill", selector: { label: "Qty" }, field: "array2ModuleQuantity", note: "pv array quantity" } as RecipeStep,
    { action: "fill", selector: { label: "Qty" }, value: "5", note: "Qty" } as RecipeStep,
  ]), []);
});

check("a learner step ends the human-patched run: a later patch is not 'after the click'", () => {
  assert.deepEqual(keys([
    adder,
    { action: "click", selector: { role: "button", name: "Next" }, note: "advance: Next" } as RecipeStep,
    patch({}),
  ]), []);
  // ...but the run reaches across consecutive patches and clicks
  assert.deepEqual(keys([adder, patch({ note: "human-patch: Clone", action: "click", value: undefined }), patch({})]), [2]);
});

if (failures) { console.error(`\n${failures} handPatchedArrayRows check(s) FAILED.`); process.exit(1); }
console.log("\nAll handPatchedArrayRows checks passed.");
