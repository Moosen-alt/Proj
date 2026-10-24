// THE LEARN-ROWS HARNESS (#382), shared by powerClerkLearnArrayRows.dom.smoke.ts (1 and 2 arrays)
// and powerClerkLearnArrayRows4.dom.smoke.ts (4 arrays, the live project's shape). Two files keep
// each well inside the DOM runner's 600 s budget: every row is a run of combobox picks with their
// cascades and debounced saves. Not a smoke itself (not discovered by the runners).
//
// Drives the REAL learner (AutoLearnAdapter.learn) on the captured PowerClerk row markup
// (powerClerkRowFixture.ts) and asserts the COMMITTED (server) state the review page carries:
//   - one row per array, each holding ITS OWN qty / make / model / tilt / azimuth; the inverter
//     keeps its own make and model;
//   - what the learn RECORDS is one row, bound to array1* (a replay adds rows 2..N from the
//     project's arrays), and never an "Add Array" click.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import type { ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";
import { CERT_MAKE, MODEL, startRowFixture, type Committed } from "./powerClerkRowFixture";
import { isArrayAdderClick } from "./recipeAdapter";

/** The live project's four arrays (9 / 5 / 5 / 2 modules), with their own orientations. */
export const LIVE_ARRAYS = [{ qty: "9", azi: "172" }, { qty: "5", azi: "82" }, { qty: "5", azi: "262" }, { qty: "2", azi: "262" }];
type Arrays = Array<{ qty: string; azi: string }>;

// The planner contributes nothing on the form (the equipment answers are project data, filled
// deterministically) beyond naming Next; the review page is the review.
const planner: LearnPlanner = async (req) => {
  if (/\/review/.test(req.url)) return { fills: [], atReview: true };
  const next = req.fields.findIndex((f) => f.fieldType === "button" && /^next$/i.test(String(f.label ?? "").trim()));
  return { fills: [], atReview: false, ...(next >= 0 ? { advanceSelectorIndex: next } : {}) };
};

// The project's equipment as the backend hands it to the learner (autoLearn.ts): the plan set's
// make wording ("ZNShine Solar"; the portal lists the certified "Znshine PV-Tech") and one
// array{N}* group per roof plane.
const equipmentFor = (arrays: Arrays): Record<string, string> => {
  const total = String(arrays.reduce((s, a) => s + Number(a.qty), 0));
  const e: Record<string, string> = {
    inverterMake: "Altenergy Power System", inverterModel: "0.8 kW (Model DS3-L {240V} [SI1])", inverterQty: "2",
    moduleMake: "ZNShine Solar", moduleModel: "ZXM7-UHLDD108-440/N", moduleModelCertified: MODEL,
    moduleQty: total, totalModuleQuantity: total, tilt: "24", azimuth: arrays[0].azi, tracking: "Fixed",
  };
  arrays.forEach((a, i) => {
    e[`array${i + 1}ModuleQuantity`] = a.qty;
    e[`array${i + 1}Tilt`] = "24";
    e[`array${i + 1}Azimuth`] = a.azi;
  });
  return e;
};

/** Learn once per entry of `projects`; returns the number of failed checks. */
export async function runLearnRows(projects: Arrays[]): Promise<number> {
  process.env.AUTOLEARN_RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pc-learn-rows-smoke-"));
  let failures = 0;
  const check = (label: string, ok: boolean, detail = ""): void => {
    if (ok) console.log(`  ok   - ${label}`);
    else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
  };
  const { base, context, close } = await startRowFixture(chromium);
  try {
    for (const arrays of projects) {
      const T0 = Date.now();
      const n = arrays.length;
      console.log(`\n[${n}] the learn on a project with ${n} PV array(s)`);
      const p = await context.newPage();
      await p.goto(`${base}/`);
      const a = new AutoLearnAdapter("PacifiCorp PowerClerk (learn rows smoke)", planner, { equipment: equipmentFor(arrays), maxPages: 4 });
      (a as unknown as { page: unknown }).page = p;
      const r = await a.learn({} as never, {} as ProjectRecord);
      await p.waitForTimeout(1500); // let the last debounced autosaves land
      const committed = await p.evaluate(() => (window as unknown as { __server: Committed }).__server);
      await p.close();
      const rows = committed.rows ?? [];
      const summary = JSON.stringify(rows.map((x) => [x.qty, x.mfr, x.model ? "model" : "-", x.tilt, x.azi]));
      check(`one row per array: ${n} row(s)`, rows.length === n, `rows=${summary} message=${String(r.message ?? "").slice(0, 300)}`);
      arrays.forEach((arr, i) => {
        const row = rows[i] ?? {};
        check(`row ${i + 1} holds ITS OWN array: Qty ${arr.qty}, ${CERT_MAKE}, 440W, tilt 24, azimuth ${arr.azi}`,
          row.qty === arr.qty && row.mfr === CERT_MAKE && row.model === MODEL && row.tilt === "24" && row.azi === arr.azi,
          `row ${i + 1} committed ${JSON.stringify(row)}; all rows ${summary}`);
      });
      check("the inverter keeps ITS OWN make and model",
        committed.invMfr === "Altenergy Power System" && /DS3-L \{240V\}/.test(String(committed.invModel ?? "")),
        JSON.stringify({ mfr: committed.invMfr, model: committed.invModel }));
      const steps: RecipeStep[] = r.steps ?? [];
      const qtySteps = steps.filter((s) => /^array\d+ModuleQuantity$/.test(String(s.field ?? "")) || s.field === "moduleQty");
      check("the recipe records ONE row's Qty, bound to array1ModuleQuantity (a replay adds rows 2..N from the arrays)",
        qtySteps.length >= 1 && qtySteps.every((s) => s.field === "array1ModuleQuantity"),
        JSON.stringify(qtySteps.map((s) => ({ field: s.field, note: s.note }))));
      check("the recipe records the row's make, model, tilt and azimuth (moduleMake / moduleModel / array1Tilt / array1Azimuth)",
        ["moduleMake", "moduleModel", "array1Tilt", "array1Azimuth"].every((f) => steps.some((s) => s.field === f)),
        JSON.stringify(steps.map((s) => s.field).filter(Boolean)));
      check("the recipe records no \"Add Array\" click", !steps.some((s) => isArrayAdderClick(s)),
        JSON.stringify(steps.filter((s) => s.action === "click").map((s) => s.note)));
      console.log(`  (section [${n}] took ${Math.round((Date.now() - T0) / 1000)} s)`);
    }
  } finally {
    await close();
    fs.rmSync(process.env.AUTOLEARN_RUN_DIR!, { recursive: true, force: true });
  }
  return failures;
}
