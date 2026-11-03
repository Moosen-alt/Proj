// A RUN THAT GOT PAST THE STAGE GATE NEVER LATER REPORTS "REQUIRED FIELD BLANK" FOR A FIELD THE GATE
// CHECKED (#445). The gate (backend recipeStageGaps, after bindRecipeForReplay) reads the recipe's bound
// steps and the job's value dictionary and refuses before a browser opens; this pins that its
// reading and the REAL replay's agree, on a replica page shaped like PacifiCorp's PowerClerk customer
// and equipment pages (labels with "*", required controls, an optional notes box, a literal select).
//
//   A  MUST-PASS  every bound value present → the gate names nothing → the real RecipeAdapter fills
//                 the page and the required-control sweep (the instrument the replay's own "required
//                 field blank" stop reads) finds NOTHING blank among the controls the gate checked.
//   B  MUST-NAME  a blank preparer phone → the gate names "Preparer Phone"; the same replay without
//                 the gate leaves exactly that required box blank. The gate refuses what the run
//                 would report, no more and no less.
//   C  MUST-PASS  a model with only a certified name → the gate passes, and the replay files the
//                 certified name (not a blank).
//   D  MUST-PASS  a blank OPTIONAL notes box and an unbound literal never count, and the run leaves
//                 no required control blank.
//
// Synthetic page and data only; nothing leaves 127.0.0.1.
//   npx tsx portal-bot/src/adapters/stageGapsReplica.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";
import { sweepEmptyRequiredControls } from "../requiredControlSweep";
import { bindRecipeForReplay } from "../../../backend/src/recipeReplayBinding";
import { recipeStageGaps } from "../../../backend/src/recipeStageGaps";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
let passes = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { passes++; console.log(`  ok   - ${label}`); }
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const PAGE = `<!doctype html><html><head><title>Customer Information</title><style>body{font:14px sans-serif;padding:16px} label{display:block;margin-top:8px}</style></head><body>
  <h3>Customer Information</h3>
  <label for="first">Account Holder First Name *</label><input id="first" required aria-required="true" />
  <label for="last">Account Holder Last Name *</label><input id="last" required aria-required="true" />
  <label for="acct">Account Number (please use this format: xxxxxxxx xxx x) *</label><input id="acct" required aria-required="true" />
  <label for="meter">Meter Number *</label><input id="meter" required aria-required="true" />
  <label for="phone">Preparer Phone *</label><input id="phone" required aria-required="true" />
  <h3>Inverter</h3>
  <label for="invmake">Inverter Manufacturer *</label>
  <select id="invmake" required aria-required="true"><option value="">Select...</option><option>Enphase Energy Inc.</option><option>Tesla</option></select>
  <label for="invmodel">Inverter Model *</label>
  <select id="invmodel" required aria-required="true"><option value="">Select...</option><option>IQ8M-72-2-US {240V}</option><option>IQ8A-72-2-US {240V}</option></select>
  <label for="mount">System Mounting Method *</label>
  <select id="mount" required aria-required="true"><option value="">Select...</option><option>Roof Mounting</option><option>Ground Mounting</option></select>
  <label for="notes">Notes to the utility</label><textarea id="notes"></textarea>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

const step = (action: "fill" | "select", css: string, label: string, field: string | null, extra: Partial<RecipeStep> = {}): RecipeStep =>
  ({ action, phase: "fill", selector: { css, label }, note: label, ...(field ? { field } : {}), ...extra } as RecipeStep);
const STEPS: RecipeStep[] = [
  step("fill", "#first", "Account Holder First Name", "ubAccountHolderFirstName"),
  step("fill", "#last", "Account Holder Last Name", "ubAccountHolderLastName"),
  step("fill", "#acct", "Account Number (please use this format: xxxxxxxx xxx x)", "accountNumber", { sensitive: true }),
  step("fill", "#meter", "Meter Number", "meterNumber", { sensitive: true }),
  step("fill", "#phone", "Preparer Phone", "installerPhone"),
  step("select", "#invmake", "Inverter Manufacturer", "inverterManufacturer"),
  step("select", "#invmodel", "Inverter Model", "inverterModel"),
  step("select", "#mount", "System Mounting Method", null, { value: "Roof Mounting" }),
  step("fill", "#notes", "Notes to the utility", "workDescription", { optional: true }),
];
const recipe = {
  id: "gaps1", scopeType: "utility", profileKey: "or|unknown|pacificorp", state: "OR", ahj: "", utility: "PacifiCorp",
  portalPlatform: "powerclerk", portalUrl: url, status: "complete", version: 1, steps: STEPS,
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe;

const VALUES: Record<string, string> = {
  ubAccountHolderFirstName: "Pat", ubAccountHolderLastName: "Example", accountNumber: "9000000000400", meterNumber: "77665544",
  installerPhone: "(503) 555-0100", inverterManufacturer: "Enphase Energy Inc.", inverterModel: "IQ8M-72-2-US {240V}", workDescription: "",
};
// The controls the gate reads: every non-optional bound step, by the label the sweep reads.
const GATE_CHECKED = STEPS.filter((s) => s.field && !s.optional).map((s) => String(s.selector?.label));

/** The gate's reading, exactly as prepareSubmission makes it: bind, then ask recipeStageGaps. */
const gate = (values: Record<string, string>) => {
  const b = bindRecipeForReplay({ steps: STEPS, portalUrl: url, project: { state: "OR", ahj: "", parserSnapshot: {} }, fieldValues: values, track: "nem", borrowed: null, agency: null });
  return recipeStageGaps(b.steps, { ...values, ...b.fieldValues }, {});
};

const browser = await chromium.launch();
/** The REAL replay on the replica, then the required-control sweep the replay's own stop reads. */
const replay = async (values: Record<string, string>) => {
  const context = await browser.newContext();
  await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const page = await context.newPage();
  await page.goto(url);
  const a = new RecipeAdapter(recipe, values, {}, { autoSubmit: false });
  (a as unknown as { page: unknown }).page = page;
  const result = await a.fillApplication({} as never);
  const blanks = (await sweepEmptyRequiredControls(page)).empty.map((e) => e.name.replace(/\s*\*\s*$/, "").trim());
  const reported = ((result.data as { requiredStillEmpty?: string[] } | undefined)?.requiredStillEmpty ?? []).map(String);
  const model = await page.locator("#invmodel").inputValue().catch(() => "");
  await context.close();
  return { blanks, reported, model };
};
const gateChecked = (names: string[]) => names.filter((n) => GATE_CHECKED.some((g) => n.toLowerCase().includes(g.toLowerCase().slice(0, 18))));

try {
  console.log("\nA. every bound value present");
  const a = gate(VALUES);
  check("the gate names nothing", a.length === 0, JSON.stringify(a));
  const ra = await replay(VALUES);
  check("the replay leaves no required control the gate checked blank", gateChecked([...ra.blanks, ...ra.reported]).length === 0, JSON.stringify(ra));
  check("...and no required control blank at all", ra.blanks.length === 0, JSON.stringify(ra.blanks));

  console.log("\nB. a blank preparer phone");
  const blankPhone = { ...VALUES, installerPhone: "" };
  const b = gate(blankPhone);
  check("the gate names exactly that box, by its label and field", b.length === 1 && b[0].label === "Preparer Phone" && b[0].key === "installerPhone", JSON.stringify(b));
  const rb = await replay(blankPhone);
  check("the same replay without the gate leaves exactly that required box blank", rb.blanks.length === 1 && /preparer phone/i.test(rb.blanks[0]), JSON.stringify(rb.blanks));

  console.log("\nC. a model with only its certified name");
  const certified = { ...VALUES, inverterModel: "IQ8M-72-2-US", inverterModelCertified: "IQ8M-72-2-US {240V}" };
  const c = gate(certified);
  check("the gate passes", c.length === 0, JSON.stringify(c));
  const rc = await replay(certified);
  check("the replay files the certified name, not a blank", rc.model === "IQ8M-72-2-US {240V}" && rc.blanks.length === 0, JSON.stringify(rc));

  console.log("\nD. an optional box and a literal");
  check("a blank optional notes box and the literal mounting select never count", gate({ ...VALUES, workDescription: "" }).length === 0);
  check("...and the run left the literal answered (no required blank)", !ra.blanks.some((n) => /mounting/i.test(n)), JSON.stringify(ra.blanks));
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
