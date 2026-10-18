// A CONCEALED RECORDED CONTROL IS NOT ALWAYS A STALE SHADOW (#327 review).
//
// sectionDisambiguation.dom.smoke pins PGE's shape: the recorded id names an opacity:0 shadow
// "Model" holding only "Select...", the section rescue lands on the visible inverter Model,
// and the fingerprint redirect must NOT send the write back into the shadow. The first fix
// for that passed over EVERY concealed fingerprint target after a rescue — and concealed is
// also what a select2's real <select> looks like, what a styled Model select still carrying
// its model list looks like, and what a list still cascading in looks like. In each of those
// the rescue is the one that landed on a NEIGHBOUR, and main's redirect was what put the value
// back where it belongs. Every case below asserts which control holds the value and that the
// neighbour is untouched.
//   npx tsx portal-bot/src/adapters/sectionRedirectKept.dom.smoke.ts
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const IQ8 = "IQ8PLUS-72-2-US {240V}";
const shell = (body: string, script = ""): string => `<!doctype html><html><head><style>
  body { font: 14px sans-serif; padding: 16px; }
  fieldset { margin: 12px 0; }
  .concealed { opacity: 0; position: absolute; }
  /* select2's own rule for the native select it replaces */
  .select2-hidden-accessible { border: 0; clip: rect(0 0 0 0); height: 1px; width: 1px; margin: -1px; overflow: hidden; padding: 0; position: absolute; }
  .select2-selection { display: inline-block; min-width: 220px; border: 1px solid #aaa; padding: 3px 6px; cursor: pointer; }
  .select2-results { position: absolute; background: #fff; border: 1px solid #aaa; z-index: 9; list-style: none; margin: 0; padding: 0; }
  .select2-results li { padding: 3px 6px; cursor: pointer; }
</style></head><body>${body}
<script>
  // A minimal select2: the face opens a list of the native select's options (or, for an
  // AJAX select2, of options fetched on open); a pick sets the native select and the face.
  document.querySelectorAll(".select2-container").forEach(function (box) {
    var sel = document.getElementById(box.getAttribute("data-for"));
    var face = box.querySelector(".select2-selection");
    var sync = function () { var o = sel.options[sel.selectedIndex]; face.textContent = o ? o.text : ""; };
    sel.addEventListener("change", sync); sync();
    face.addEventListener("click", function () {
      var open = document.querySelector(".select2-results"); if (open) { open.remove(); return; }
      var show = function (items) {
        var ul = document.createElement("ul"); ul.className = "select2-results"; ul.setAttribute("role", "listbox");
        items.forEach(function (t) {
          var li = document.createElement("li"); li.className = "select2-results__option"; li.setAttribute("role", "option"); li.textContent = t;
          li.addEventListener("click", function () {
            var hit = Array.from(sel.options).find(function (o) { return o.text === t; });
            if (!hit) { hit = new Option(t, t); sel.add(hit); }
            sel.value = hit.value; sel.dispatchEvent(new Event("change", { bubbles: true })); ul.remove();
          });
          ul.appendChild(li);
        });
        box.appendChild(ul);
      };
      var ajax = box.getAttribute("data-ajax");
      if (ajax) setTimeout(function () { show(ajax.split("|")); }, 300);
      else show(Array.from(sel.options).map(function (o) { return o.text; }).filter(function (t) { return !/^Select/.test(t); }));
    });
  });
  ${script}
</script></body></html>`;

const select2 = (id: string, options: string[], ajax = ""): string =>
  `<div class="s2wrap"><select id="${id}" class="select2-hidden-accessible" tabindex="-1"><option value="">Select...</option>${options.map((o) => `<option>${o}</option>`).join("")}</select>`
  + `<span class="select2 select2-container" data-for="${id}"${ajax ? ` data-ajax="${ajax}"` : ""}><span class="select2-selection" role="combobox" aria-haspopup="listbox"></span></span></div>`;

// The neighbour the RESCUE lands on: a visible, labelled "Model" whose test hook carries every
// token of the step's field ("inverter", "model"), so the hook rescue takes it. The real
// control has no hook and is labelled first, so the recorded id AND the label fallback both
// resolve to it, concealed, and the rescue fires. Present in every inverter case.
const EXISTING = `<fieldset><legend>Existing Inverter</legend>
  <label for="ex-model">Model</label>
  <select id="ex-model" data-test-role="existing-inverter-model-select"><option>Select...</option><option>${IQ8}</option></select></fieldset>`;

const PAGES: Record<string, string> = {
  // A select2 "Utility" beside a visible "Utility Account Number" box. The section rescue takes
  // the box (its label contains "Utility"); the redirect must put the pick back in the select2.
  utility: shell(`<fieldset><legend>Utility</legend>
    <div><label for="utility">Utility</label>${select2("utility", ["Pacific Gas & Electric", "Sacramento Municipal Utility District"])}</div>
    <div><label for="acctno">Utility Account Number</label><input id="acctno"></div></fieldset>`),

  // The inverter Model is a styled select (concealed, unlabelled) that DOES carry the model
  // list; the rescue lands on the "Existing Inverter" Model.
  existingInverter: shell(`<fieldset><legend>Inverter</legend><label for="inv-model">Model</label>
    <select id="inv-model" class="concealed"><option>Select...</option><option>${IQ8}</option></select></fieldset>${EXISTING}`),

  // Same, with the neighbour an "Existing Model" select inside the SAME fieldset.
  existingModel: shell(`<fieldset><legend>Inverter</legend><label for="inv-model">Model</label>
    <select id="inv-model" class="concealed"><option>Select...</option><option>${IQ8}</option></select>
    <label for="ex-model">Existing Model</label>
    <select id="ex-model" data-test-role="inverter-existing-model-select"><option>Select...</option><option>${IQ8}</option></select></fieldset>`),

  // The model list of a select2 Model arrives 1.5 s after the Manufacturer pick.
  cascade: shell(`<fieldset><legend>Inverter</legend>
    <label for="inv-make">Manufacturer</label>
    <select id="inv-make"><option>Select...</option><option>Enphase Energy, Inc.</option></select>
    <label for="inv-model">Model</label>${select2("inv-model", [])}</fieldset>${EXISTING}`,
  `document.getElementById("inv-make").addEventListener("change", function () {
     setTimeout(function () { var s = document.getElementById("inv-model"); s.add(new Option(${JSON.stringify(IQ8)})); }, 1500);
   });`),

  // A make listed by its certified name: the answer "APsystems", the option "Altenergy Power
  // System". The inverter's concealed Manufacturer shares its panel with the Model, so it has
  // no face of its own — the alias is what says it is not an empty shadow.
  alias: shell(`<fieldset><legend>Inverter</legend><label for="inv-make">Manufacturer</label>
    <select id="inv-make" class="concealed"><option>Select...</option><option>Altenergy Power System</option><option>Enphase Energy, Inc.</option></select>
    <label for="inv-model2">Model</label><select id="inv-model2"><option>Select...</option></select></fieldset>
    <fieldset><legend>Existing Inverter</legend><label for="ex-make">Manufacturer</label>
    <select id="ex-make" data-test-role="existing-inverter-manufacturer-select"><option>Select...</option><option>Altenergy Power System</option></select></fieldset>`),

  // An AJAX select2 Model: its native select holds only the placeholder until it is opened.
  // Main redirects there and leaves it visibly blank for review; the neighbour stays untouched.
  ajax: shell(`<fieldset><legend>Inverter</legend><label for="inv-model">Model</label>${select2("inv-model", [], `${IQ8}|IQ8M-72-2-US {240V}`)}</fieldset>${EXISTING}`),
};

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(PAGES[(req.url || "").replace(/^\/|\?.*$/g, "")] ?? "<html></html>");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const step = (field: string, note: string, id: string, section: string): RecipeStep => ({
  action: "select", phase: "fill", field, note,
  selector: { css: `#${id}`, fallbacks: [{ label: note, nth: 0 }] },
  fingerprint: { id, ariaLabel: note, section },
} as unknown as RecipeStep);

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

type Run = { read: (id: string) => Promise<string>; data: { driftWarnings?: string[]; skipped?: string[] } };
const run = async (key: string, steps: RecipeStep[], values: Record<string, string>): Promise<Run> => {
  const page = await context.newPage();
  const url = `http://127.0.0.1:${port}/${key}`;
  await page.goto(url);
  const recipe = {
    id: `sr-${key}`, scopeType: "utility", profileKey: "ca||pacific gas and electric", state: "CA", ahj: "",
    utility: "Pacific Gas & Electric", portalPlatform: "powerclerk", portalUrl: url, status: "complete", version: 1,
    steps, createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
  } as unknown as PortalRecipe;
  const adapter = new RecipeAdapter(recipe, values, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = page;
  const res = await adapter.fillApplication({} as never);
  const data = ((res as unknown as { data?: Run["data"] }).data ?? {});
  const read = async (id: string): Promise<string> => page.locator(`#${id}`).evaluate((el: Element) => {
    if (el.tagName === "SELECT") { const s = el as HTMLSelectElement; return s.options[s.selectedIndex]?.text ?? ""; }
    return (el as HTMLInputElement).value;
  }).catch(() => "(unreadable)") as Promise<string>;
  console.log(`   [${key}] skipped=${JSON.stringify(data.skipped ?? [])} drift=${JSON.stringify((data.driftWarnings ?? []).slice(0, 2))}`);
  return { read, data };
};

{
  const r = await run("utility", [step("utility", "Utility", "utility", "Utility")], { utility: "Pacific Gas & Electric" });
  const sel = await r.read("utility"), box = await r.read("acctno");
  check("a select2 Utility gets the pick, not the 'Utility Account Number' box the rescue chose", () => {
    assert.equal(sel, "Pacific Gas & Electric", `select2 Utility reads ${JSON.stringify(sel)}`);
    assert.equal(box, "", `the account-number box holds ${JSON.stringify(box)}`);
  });
}
for (const key of ["existingInverter", "existingModel"]) {
  const r = await run(key, [step("inverterModel", "Model", "inv-model", "Inverter")], { inverterModel: IQ8 });
  const real = await r.read("inv-model"), other = await r.read("ex-model");
  check(`${key}: the inverter Model that carries the model list gets it, the neighbour the rescue chose stays "Select..."`, () => {
    assert.equal(real, IQ8, `inverter Model reads ${JSON.stringify(real)}`);
    assert.equal(other, "Select...", `the neighbour holds ${JSON.stringify(other)}`);
  });
}
{
  const r = await run("cascade", [
    { action: "select", phase: "fill", field: "inverterMake", note: "Manufacturer", selector: { css: "#inv-make" } } as unknown as RecipeStep,
    step("inverterModel", "Model", "inv-model", "Inverter"),
  ], { inverterMake: "Enphase Energy, Inc.", inverterModel: IQ8 });
  const real = await r.read("inv-model"), other = await r.read("ex-model");
  check("a select2 Model whose list cascades in 1.5 s after the Manufacturer gets the model, the neighbour stays untouched", () => {
    assert.equal(real, IQ8, `inverter Model reads ${JSON.stringify(real)}`);
    assert.equal(other, "Select...", `the neighbour holds ${JSON.stringify(other)}`);
  });
}
{
  const r = await run("alias", [step("inverterManufacturer", "Manufacturer", "inv-make", "Inverter")], { inverterManufacturer: "APsystems" });
  const real = await r.read("inv-make"), other = await r.read("ex-make");
  check("an aliased make (APsystems = Altenergy Power System) lands in the inverter's own Manufacturer, not the Existing one", () => {
    assert.equal(real, "Altenergy Power System", `inverter Manufacturer reads ${JSON.stringify(real)}`);
    assert.equal(other, "Select...", `the Existing Inverter Manufacturer holds ${JSON.stringify(other)}`);
  });
}
{
  const r = await run("ajax", [step("inverterModel", "Model", "inv-model", "Inverter")], { inverterModel: IQ8 });
  const other = await r.read("ex-model");
  check("an AJAX select2 Model: the neighbour the rescue chose is NOT written, and the step is not reported landed", () => {
    assert.equal(other, "Select...", `the neighbour holds ${JSON.stringify(other)} — written into the wrong control and reported ok`);
    const reported = [...(r.data.skipped ?? []), ...(r.data.driftWarnings ?? [])].join(" | ");
    assert.match(reported, /Model/, `nothing reports the Model step: ${reported}`);
  });
}

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} section-redirect check(s) FAILED.`); process.exit(1); }
console.log("\nAll section-redirect checks passed (real Chromium).");
process.exit(0);
