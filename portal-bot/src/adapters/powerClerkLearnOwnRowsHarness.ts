// THE OWN-ROWS HARNESS (#535), shared by powerClerkLearnOwnRows.dom.smoke.ts (the backend's certified
// inverter name is known) and powerClerkLearnOwnRowsNoCert.dom.smoke.ts (it is not: the CEC table is
// unsynced). Two files keep each well inside the DOM runner's 600 s budget. Not a smoke itself (not
// discovered by the runners). The shape and the live run it models are in the first smoke's header.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import type { ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";
import { startRowFixture, type Committed } from "./powerClerkRowFixture";

const CERT_MODULE = "Q.TRON BLK M-G2+ 440";
const MODULE_440 = "440W (Model Q.TRON BLK M-G2+ 440)";
const INVERTER_IQ8 = "0.29 kW (Model IQ8PLUS-72-2-US {240V})";
const ARRAYS = [{ qty: "4", azi: "270" }, { qty: "4", azi: "90" }];

// The project's equipment as the backend hands it to the learner (autoLearn.ts): the plan set's
// wording for the module and inverter, the backend's certified names (portalRecipes
// certifiedModelFields), the system totals, and one array{N}* group per roof plane.
const equipmentFor = (inverterCertified: boolean): Record<string, string> => {
  const e: Record<string, string> = {
    inverterMake: "Enphase", inverterModel: "IQ8+ Microinverter", inverterQty: "8",
    ...(inverterCertified ? { inverterModelCertified: "IQ8PLUS-72-2-US {240V}" } : {}),
    moduleMake: "Q CELLS", moduleModel: "Q.TRON BLK M-G2+", moduleModelCertified: CERT_MODULE,
    moduleQty: "8", totalModuleQuantity: "8", tilt: "23", azimuth: "270", tracking: "Fixed",
  };
  ARRAYS.forEach((a, i) => {
    e[`array${i + 1}ModuleQuantity`] = a.qty;
    e[`array${i + 1}Tilt`] = "23";
    e[`array${i + 1}Azimuth`] = a.azi;
  });
  return e;
};

// The planner as the live one behaved: it fills the row's Qty with the system's module total
// (bound to totalModuleQuantity) and names Next. Everything else is the equipment pass's.
const planner: LearnPlanner = async (req) => {
  if (/\/review/.test(req.url)) return { fills: [], atReview: true };
  const fills: Array<{ selectorIndex: number; value: string; field?: string }> = [];
  const rowQty = req.fields.findIndex((f) => f.fieldType === "text" && /pv ?array/i.test(`${f.section ?? ""} ${f.label ?? ""}`)
    && /\bqty\b|quantity/i.test(String(f.label ?? "")));
  const label = rowQty >= 0 ? String(req.fields[rowQty].label ?? "") : "";
  if (rowQty >= 0 && !req.alreadyFilledLabels.includes(label)) fills.push({ selectorIndex: rowQty, value: "8", field: "totalModuleQuantity" });
  const next = req.fields.findIndex((f) => f.fieldType === "button" && /^next$/i.test(String(f.label ?? "").trim()));
  return { fills, atReview: false, ...(next >= 0 ? { advanceSelectorIndex: next } : {}) };
};

/** Learn the two-array job once; returns the number of failed checks. `inverterCertified`: the
 *  backend resolved the inverter's certified string (else only the plan-set name, which the list
 *  does not carry, so the inverter model is honestly left for a person and only the rows are judged). */
export async function runOwnRows(inverterCertified: boolean): Promise<number> {
  let failures = 0;
  const check = (label: string, ok: boolean, detail = ""): void => {
    if (ok) console.log(`  ok   - ${label}`);
    else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
  };
  process.env.AUTOLEARN_RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pc-learn-own-rows-smoke-"));
  const { base, context, close } = await startRowFixture(chromium);
  try {
    console.log(`\n[535] the learn on a two-array job (4 + 4 modules), a planner that types the system total, ${inverterCertified ? "the inverter's certified name known" : "NO certified inverter name"}`);
    const p = await context.newPage();
    await p.goto(`${base}/?ownRows=1`);
    const a = new AutoLearnAdapter("PacifiCorp PowerClerk (own rows smoke)", planner, { equipment: equipmentFor(inverterCertified), maxPages: 4 });
    (a as unknown as { page: unknown }).page = p;
    const r = await a.learn({} as never, {} as ProjectRecord);
    await p.waitForTimeout(1500); // let the last debounced autosaves land
    const committed = await p.evaluate(() => (window as unknown as { __server: Committed }).__server);
    await p.close();
    const rows = committed.rows ?? [];
    const summary = JSON.stringify(rows.map((x) => [x.qty, x.mfr, x.model, x.tilt, x.azi]));
    check("two rows, one per array", rows.length === 2, `rows=${summary} message=${String(r.message ?? "").slice(0, 300)}`);
    ARRAYS.forEach((arr, i) => {
      const row = rows[i] ?? {};
      check(`row ${i + 1} holds ITS OWN Qty ${arr.qty} (never the system total 8)`, row.qty === arr.qty, `row ${i + 1} committed ${JSON.stringify(row)}`);
      check(`row ${i + 1} holds the job's certified module model (${MODULE_440})`, row.model === MODULE_440, `row ${i + 1} committed ${JSON.stringify(row)}`);
      check(`row ${i + 1} holds tilt 23 and ITS OWN azimuth ${arr.azi}`, row.tilt === "23" && row.azi === arr.azi, `row ${i + 1} committed ${JSON.stringify(row)}`);
    });
    check("every row holds the same module model", new Set(rows.map((x) => x.model)).size === 1, summary);
    const steps: RecipeStep[] = r.steps ?? [];
    if (inverterCertified) {
      check(`the inverter model is chosen (${INVERTER_IQ8})`,
        committed.invMfr === "Enphase Energy Inc." && committed.invModel === INVERTER_IQ8,
        JSON.stringify({ mfr: committed.invMfr, model: committed.invModel }));
      check("the recipe binds the inverter model by key (inverterModel)", steps.some((s) => s.field === "inverterModel"),
        JSON.stringify(steps.map((s) => s.field).filter(Boolean)));
    } else {
      check("with no certified name, no inverter model is guessed", !committed.invModel,
        JSON.stringify({ mfr: committed.invMfr, model: committed.invModel }));
    }
    const rowQtySteps = steps.filter((s) => (s.action === "fill" || s.action === "select") && /^(qty|pv array quantity)$/i.test(String(s.note ?? "").trim()));
    check("the recipe binds the row's Qty to array1ModuleQuantity, and to nothing else",
      rowQtySteps.length === 1 && rowQtySteps[0].field === "array1ModuleQuantity",
      JSON.stringify(rowQtySteps.map((s) => ({ field: s.field, value: s.value, note: s.note }))));
    check("the recipe keeps no step that types a system total (totalModuleQuantity / moduleQty / moduleQuantity)",
      !steps.some((s) => /^(totalModuleQuantity|moduleQty|moduleQuantity)$/.test(String(s.field ?? ""))),
      JSON.stringify(steps.map((s) => s.field).filter(Boolean)));
    check("the recipe binds the module model by key (moduleModel), once",
      steps.filter((s) => s.field === "moduleModel").length === 1,
      JSON.stringify(steps.map((s) => s.field).filter(Boolean)));
    if (failures) {
      console.error(`  run message: ${String(r.message ?? "").slice(0, 600)}`);
      console.error(`  steps: ${JSON.stringify(steps.map((s) => ({ a: s.action, f: s.field, v: s.value, n: s.note })))}`);
    }
  } finally {
    await close();
    if (process.env.KEEP_RUN_DIR !== "1") fs.rmSync(process.env.AUTOLEARN_RUN_DIR!, { recursive: true, force: true });
    else console.log(`  run dir kept: ${process.env.AUTOLEARN_RUN_DIR}`);
  }
  return failures;
}
