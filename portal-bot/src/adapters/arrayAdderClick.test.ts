// A RECORDED "ADD ARRAY" CLICK IS KNOWN AS ONE, AND A ROW FILES ITS OWN MODULE (#382).
//
// The CI-run twin of powerClerkAddArrayClicks.dom.smoke (which needs a real Chromium):
//   - isArrayAdderClick names the shapes patch-by-demonstration records for the PV-array adder
//     (role + name, the note "human-patch: Add Array", the PowerClerk test hook) and nothing else —
//     never "Clone System", "Add Contact", "Add Row" or the final submit;
//   - in row N, moduleMake / moduleModel read array N's own make / model when the plan set gives
//     that roof plane a different module, and fall through to the shared (certified) value when
//     it is the same module as array 1.
//
//   npx tsx portal-bot/src/adapters/arrayAdderClick.test.ts
import assert from "node:assert/strict";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter, isArrayAdderClick } from "./recipeAdapter";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

const click = (selector: RecipeStep["selector"], note = ""): RecipeStep => ({ action: "click", selector, note } as RecipeStep);

check("the recorded adder clicks are adder clicks", () => {
  assert.equal(isArrayAdderClick(click({ role: "button", name: "Add Array" }, "human-patch: Add Array")), true);
  assert.equal(isArrayAdderClick(click({ css: '[data-test-role="add-array-btn"]' }, "human-patch")), true);
  assert.equal(isArrayAdderClick(click({ css: "#btn7" }, "human-patch: Add Array")), true);
  assert.equal(isArrayAdderClick(click({ text: "+ Add PV Array" })), true);
  assert.equal(isArrayAdderClick(click({ css: "#x", fallbacks: [{ role: "link", name: "Add another array" }] })), true);
});

check("other clicks are not", () => {
  assert.equal(isArrayAdderClick(click({ role: "button", name: "Clone System" })), false);
  assert.equal(isArrayAdderClick(click({ role: "button", name: "Clone" })), false);
  assert.equal(isArrayAdderClick(click({ role: "button", name: "Add Contact" }, "human-patch: Add Contact")), false);
  assert.equal(isArrayAdderClick(click({ role: "button", name: "Add Row" })), false);
  assert.equal(isArrayAdderClick(click({ role: "button", name: "Next" }, "advance: Next")), false);
  assert.equal(isArrayAdderClick(click({ role: "button", name: "Add Array Details Later" })), false);
  assert.equal(isArrayAdderClick({ action: "fill", selector: { label: "Add Array" }, note: "Add Array" } as RecipeStep), false);
  assert.equal(isArrayAdderClick({ ...click({ role: "button", name: "Add Array" }), isFinalSubmit: true } as RecipeStep), false);
  assert.equal(isArrayAdderClick(undefined), false);
});

const recipe = { id: "u382", steps: [] } as unknown as PortalRecipe;
const fields: Record<string, string> = {
  moduleMake: "ZNShine Solar", moduleModel: "ZXM7-UHLDD108-440/N", moduleModelCertified: "440W (Model ZXM7-UHLDD108-440/N)",
  array1ModuleManufacturer: "ZNShine Solar", array1ModuleModel: "ZXM7-UHLDD108-440/N",
  array2ModuleManufacturer: "ZNShine Solar", array2ModuleModel: "ZXM7-UHLDD108-440/N",
  array3ModuleManufacturer: "REC Solar", array3ModuleModel: "REC400AA",
};
const valueIn = (row: number, field: string): string => {
  const a = new RecipeAdapter(recipe, fields, {}, { autoSubmit: false }) as unknown as { arrayPass: number; resolveValue: (s: RecipeStep) => string };
  a.arrayPass = row;
  return a.resolveValue({ action: "select", selector: { label: "x" }, field } as RecipeStep);
};

check("row 1 and a row with array 1's module file the shared (certified) module", () => {
  assert.equal(valueIn(1, "moduleMake"), "ZNShine Solar");
  assert.equal(valueIn(1, "moduleModel"), "440W (Model ZXM7-UHLDD108-440/N)");
  assert.equal(valueIn(2, "moduleMake"), "ZNShine Solar");
  assert.equal(valueIn(2, "moduleModel"), "440W (Model ZXM7-UHLDD108-440/N)");
});

check("a row whose array has its own module files THAT module", () => {
  assert.equal(valueIn(3, "moduleMake"), "REC Solar");
  assert.equal(valueIn(3, "moduleModel"), "REC400AA");
});

if (failures) { console.error(`\n${failures} arrayAdderClick check(s) FAILED.`); process.exit(1); }
console.log("\nAll arrayAdderClick checks passed.");
