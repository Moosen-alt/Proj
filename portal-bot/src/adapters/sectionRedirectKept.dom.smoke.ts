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
//
// PR #372 (review round 4) took the section-Model keep back out: "same label, same section"
// did not identify one field (cloned blocks, sub-headings, widgets whose list arrives late),
// and each attempt to narrow it was broken by a new layout. So replay behaves as main here,
// sectionDisambiguation stays red, and #380 carries the keep. These checks pin main's
// redirect so that work cannot write a neighbour; #380 adds its MUST LAND cases.
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
  /* bootstrap-select's own rules: the native select is a 0.5px opacity:0 sliver at left:50% */
  .bootstrap-select { position: relative; display: inline-block; width: 220px; }
  .bootstrap-select > select { position: absolute; bottom: 0; left: 50%; display: block; width: .5px; height: 100%; padding: 0; opacity: 0; border: none; z-index: 0; }
  .bootstrap-select .dropdown-toggle { width: 100%; text-align: left; }
  .bootstrap-select .dropdown-menu { position: absolute; background: #fff; border: 1px solid #aaa; z-index: 9; list-style: none; margin: 0; padding: 0; min-width: 220px; }
  .k-combobox { display: inline-block; border: 1px solid #aaa; }
  .k-animation-container { position: absolute; background: #fff; border: 1px solid #aaa; z-index: 9; }
  .k-list { list-style: none; margin: 0; padding: 0; } .k-item { padding: 3px 6px; cursor: pointer; }
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
  // A minimal bootstrap-select: the native select is a 0.5px opacity:0 sliver, the button shows
  // the pick, the menu carries a live-search box (role=combobox) and is rebuilt from the
  // native options on every open (or fetched on open, data-ajax).
  document.querySelectorAll(".bootstrap-select").forEach(function (box) {
    var sel = box.querySelector("select");
    var btn = box.querySelector(".dropdown-toggle");
    var face = box.querySelector(".filter-option-inner-inner");
    var menu = box.querySelector(".dropdown-menu");
    var inner = menu.querySelector("ul.inner");
    var sync = function () { var o = sel.options[sel.selectedIndex]; face.textContent = o ? o.text : "Nothing selected"; };
    sel.addEventListener("change", sync); sync();
    var render = function () {
      inner.innerHTML = "";
      Array.from(sel.options).forEach(function (o, i) {
        if (!o.value) return;
        var li = document.createElement("li"); var a = document.createElement("a"); a.setAttribute("role", "option");
        var sp = document.createElement("span"); sp.className = "text"; sp.textContent = o.text; a.appendChild(sp); li.appendChild(a);
        a.addEventListener("click", function () { sel.selectedIndex = i; sel.dispatchEvent(new Event("change", { bubbles: true })); menu.style.display = "none"; });
        inner.appendChild(li);
      });
    };
    btn.addEventListener("click", function () {
      if (menu.style.display === "block") { menu.style.display = "none"; return; }
      menu.style.display = "block";
      var ajax = box.getAttribute("data-ajax");
      if (ajax) setTimeout(function () {
        ajax.split("|").forEach(function (t) { if (!Array.from(sel.options).some(function (o) { return o.text === t; })) sel.add(new Option(t, t)); });
        render();
      }, 300);
      else render();
    });
  });
  // A minimal Kendo ComboBox on a <select>: Kendo moves the select INSIDE its own wrapper,
  // display:none, beside a visible role=combobox input; the list is a popup outside it.
  document.querySelectorAll(".k-combobox").forEach(function (box) {
    var sel = box.querySelector("select");
    var input = box.querySelector("input.k-input");
    var sync = function () { var o = sel.options[sel.selectedIndex]; input.value = o && o.value ? o.text : ""; };
    sel.addEventListener("change", sync); sync();
    var open = function () {
      var old = document.querySelector(".k-animation-container"); if (old) { old.remove(); return; }
      var pop = document.createElement("div"); pop.className = "k-animation-container";
      var ul = document.createElement("ul"); ul.className = "k-list"; ul.setAttribute("role", "listbox");
      Array.from(sel.options).forEach(function (o, i) {
        if (!o.value) return;
        var li = document.createElement("li"); li.className = "k-item"; li.setAttribute("role", "option"); li.textContent = o.text;
        li.addEventListener("click", function () { sel.selectedIndex = i; sel.dispatchEvent(new Event("change", { bubbles: true })); pop.remove(); });
        ul.appendChild(li);
      });
      pop.appendChild(ul); document.body.appendChild(pop);
    };
    box.querySelector(".k-select").addEventListener("click", open);
    input.addEventListener("click", open);
  });
  ${script}
</script></body></html>`;

// `options` entries are text, or "value=text" for a code-valued option. `bare` drops the
// per-field wrapper div, so the select2 shares its parent with its neighbours.
const opt = (o: string): string => { const m = /^([^=]+)=(.*)$/.exec(o); return m ? `<option value="${m[1]}">${m[2]}</option>` : `<option>${o}</option>`; };
const select2 = (id: string, options: string[], ajax = "", bare = false, selected = ""): string => {
  const inner = `<select id="${id}" class="select2-hidden-accessible" tabindex="-1"><option value="">Select...</option>${options.map(opt).join("")}${selected ? `<option selected>${selected}</option>` : ""}</select>`
    + `<span class="select2 select2-container" data-for="${id}"${ajax ? ` data-ajax="${ajax}"` : ""}><span class="select2-selection" role="combobox" aria-haspopup="listbox"></span></span>`;
  return bare ? inner : `<div class="s2wrap">${inner}</div>`;
};
// bootstrap-select's own markup and rules: the select is a 0.5px opacity:0 sliver at left:50%.
const bootstrapSelect = (id: string, options: string[], ajax = ""): string =>
  `<div class="dropdown bootstrap-select"${ajax ? ` data-ajax="${ajax}"` : ""}><select id="${id}" class="selectpicker" data-live-search="true" tabindex="-98"><option value="">Nothing selected</option>${options.map(opt).join("")}</select>`
  + `<button type="button" class="btn dropdown-toggle" role="combobox" aria-haspopup="listbox"><div class="filter-option"><div class="filter-option-inner"><div class="filter-option-inner-inner"></div></div></div></button>`
  + `<div class="dropdown-menu" style="display:none"><div class="bs-searchbox"><input type="search" class="form-control" role="combobox" aria-label="Search" autocomplete="off"></div><div class="inner" role="listbox"><ul class="dropdown-menu inner"></ul></div></div></div>`;
// A Kendo ComboBox built on a <select>.
const kendoCombo = (id: string, options: string[]): string =>
  `<span class="k-widget k-combobox"><span class="k-dropdown-wrap"><input class="k-input" role="combobox" aria-expanded="false" autocomplete="off">`
  + `<span class="k-select"><span class="k-icon k-i-arrow-60-down">select</span></span></span>`
  + `<select id="${id}" data-role="combobox" style="display:none"><option value="">Select...</option>${options.map(opt).join("")}</select></span>`;
const CASCADE = (id: string, reset = false): string => `document.getElementById("inv-make").addEventListener("change", function () {
     var s = document.getElementById("${id}");
     ${reset ? "while (s.options.length > 1) s.remove(1); s.selectedIndex = 0; s.dispatchEvent(new Event(\"change\"));" : ""}
     setTimeout(function () { s.add(new Option(${JSON.stringify("IQ8PLUS-72-2-US {240V}")}, ${JSON.stringify("IQ8PLUS-72-2-US {240V}")})); }, 1500);
   });`;
const MAKE = `<label for="inv-make">Manufacturer</label>
    <select id="inv-make"><option>Select...</option><option>Enphase Energy, Inc.</option></select>`;
// "Existing Model" in the SAME fieldset: its label contains "Model", so the section rescue
// takes it (visible beats concealed) — and it is not the recorded question.
const EXISTING_SAME = `<label for="ex-model">Existing Model</label>
    <select id="ex-model"><option>Select...</option><option>IQ8PLUS-72-2-US {240V}</option></select>`;
// PGE's spec block (sectionDisambiguation's page): the recorded id is an opacity:0 EMPTY shadow
// "Model" beside the real one, and the PV array's Model in its own panel.
const PGE = (before = "", after = ""): string => `<div class="panel">
    <h3 class="panel-title">Inverter Clone System</h3>
    <label for="inv-make">Manufacturer</label>
    <select id="inv-make"><option>Enphase Energy, Inc.</option></select>
    ${before}
    <label for="pcInputBase34">Model</label>
    <select id="pcInputBase34" class="concealed"><option>Select...</option></select>
    <label for="inv-model-real">Model</label>
    <select id="inv-model-real"><option>Select...</option><option>IQ8PLUS-72-2-US {240V}</option></select>
    ${after}
  </div>
  <div class="panel">
    <h3 class="panel-title">PV ArrayDelete Array</h3>
    <label for="mod-model">Model</label>
    <select id="mod-model"><option>Select...</option><option>Q.PEAK DUO BLK ML-G10 400</option></select>
  </div>`;

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

  // ROUND 3: shapes where the page reads "empty, no face of its own" and is wrong. In each the
  // rescue lands on a neighbour that does NOT carry exactly the recorded label in exactly the
  // recorded section, so main's redirect is kept.
  // A select2 with no per-field wrapper, sharing its fieldset with Manufacturer and "Existing
  // Model" (the face probe stops at the fieldset and reads ""), its list cascading in at 1.5 s.
  bareCascade: shell(`<fieldset><legend>Inverter</legend>${MAKE}
    <label for="inv-model">Model</label>${select2("inv-model", [], "", true)}${EXISTING_SAME}</fieldset>`, CASCADE("inv-model")),
  // The same, the list RESET on the Manufacturer change (a saved model cleared) and refilled.
  bareReset: shell(`<fieldset><legend>Inverter</legend>${MAKE}
    <label for="inv-model">Model</label>${select2("inv-model", ["IQ8M-72-2-US {240V}"], "", true)}${EXISTING_SAME}</fieldset>`, CASCADE("inv-model", true)),
  // An unwrapped ajax select2, alone in its fieldset and with a SAVED DIFFERENT model.
  bareAjax: shell(`<fieldset><legend>Inverter</legend>
    <label for="inv-model">Model</label>${select2("inv-model", [], `${IQ8}|IQ8M-72-2-US {240V}`, true)}${EXISTING_SAME}</fieldset>`),
  bareAjaxSaved: shell(`<fieldset><legend>Inverter</legend>
    <label for="inv-model">Model</label>${select2("inv-model", [], `${IQ8}|IQ8M-72-2-US {240V}`, true, "IQ8M-72-2-US {240V}")}${EXISTING_SAME}</fieldset>`),
  // bootstrap-select with live search (its search box is a role=combobox input), ajax and cascade.
  bsAjax: shell(`<fieldset><legend>Inverter</legend>
    <label for="inv-model">Model</label>${bootstrapSelect("inv-model", [], `${IQ8}|IQ8M-72-2-US {240V}`)}${EXISTING_SAME}</fieldset>`),
  bsCascade: shell(`<fieldset><legend>Inverter</legend>${MAKE}
    <label for="inv-model">Model</label>${bootstrapSelect("inv-model", [])}${EXISTING_SAME}</fieldset>`, CASCADE("inv-model")),
  // A Kendo ComboBox on a <select>: its own wrapper holds the role=combobox input, so the face
  // probe reads "" in any layout.
  kendoCascade: shell(`<fieldset><legend>Inverter</legend>${MAKE}
    <label for="inv-model">Model</label>${kendoCombo("inv-model", [])}${EXISTING_SAME}</fieldset>`, CASCADE("inv-model")),
  // Code-valued options: <option value="TX">Texas</option> with the answer "TX", beside a
  // visible "Mailing State" in the same fieldset — concealed native and unwrapped select2.
  ownerStateCode: shell(`<fieldset><legend>Property Owner</legend>
    <label for="own-state">State</label><select id="own-state" class="concealed"><option value="">Select...</option><option value="CA">California</option><option value="TX">Texas</option></select>
    <label for="mail-state">Mailing State</label><select id="mail-state"><option value="">Select...</option><option value="CA">California</option><option value="TX">Texas</option></select></fieldset>`),
  ownerStateS2: shell(`<fieldset><legend>Property Owner</legend>
    <label for="own-state">State</label>${select2("own-state", ["CA=California", "TX=Texas"], "", true)}
    <label for="mail-state">Mailing State</label><select id="mail-state"><option value="">Select...</option><option value="CA">California</option><option value="TX">Texas</option></select></fieldset>`),
  // The code-valued State with a TWIN: the owner's address and mailing address share one
  // "Property Owner" panel, both labelled "State". The rescue's choice carries the recorded
  // label in the recorded section, so only the option VALUE says the concealed select is not
  // an empty shadow.
  ownerStateTwin: shell(`<fieldset><legend>Property Owner</legend>
    <label for="own-state">State</label><select id="own-state" class="concealed"><option value="">Select...</option><option value="CA">California</option><option value="TX">Texas</option></select>
    <div><label for="mail-state">State</label><select id="mail-state"><option value="">Select...</option><option value="CA">California</option><option value="TX">Texas</option></select></div></fieldset>`),
  // An unwrapped select2 Utility whose option is value="PGE", answered "PGE", sharing its
  // fieldset with the "Utility Account Number" box and a "Service Type" select (so the face
  // probe stops at the fieldset and reads ""). Round 2 skipped it after ~137 s.
  utilityCode: shell(`<fieldset><legend>Utility</legend>
    <label for="utility">Utility</label>${select2("utility", ["PGE=Pacific Gas & Electric", "SMUD=Sacramento Municipal Utility District"], "", true)}
    <label for="acctno">Utility Account Number</label><input id="acctno">
    <label for="svc">Service Type</label><select id="svc"><option>Select...</option><option>Residential</option></select></fieldset>`),
  // MUST EXCLUDE: PGE's empty shadow, with a neighbour the rescue takes that is NOT the
  // recorded question. (1) an "Existing Inverter" fieldset after the panels whose Model has a
  // test hook naming every token of "inverterModel"; (2) a visible "Existing Model" AHEAD of the
  // real Model in the same panel, after the shadow (resolveBySection ties the labels and takes
  // the first).
  pgeHookedExisting: shell(PGE() + `<fieldset><legend>Existing Inverter</legend><label for="ex-model">Model</label>
    <select id="ex-model" data-test-role="existing-inverter-model-select"><option>Select...</option><option>${IQ8}</option></select></fieldset>`),
  pgeExistingAhead: shell(PGE().replace('<label for="inv-model-real">', `${EXISTING_SAME}\n    <label for="inv-model-real">`)),
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

type Run = { read: (id: string) => Promise<string>; ms: number; data: { driftWarnings?: string[]; skipped?: string[]; fieldsVerified?: string[] } };
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
  const t0 = Date.now();
  const res = await adapter.fillApplication({} as never);
  const ms = Date.now() - t0;
  const data = ((res as unknown as { data?: Run["data"] }).data ?? {});
  const read = async (id: string): Promise<string> => page.locator(`#${id}`).evaluate((el: Element) => {
    if (el.tagName === "SELECT") { const s = el as HTMLSelectElement; return s.options[s.selectedIndex]?.text ?? ""; }
    return (el as HTMLInputElement).value;
  }).catch(() => "(unreadable)") as Promise<string>;
  console.log(`   [${key}] ${ms}ms skipped=${JSON.stringify(data.skipped ?? [])} verified=${JSON.stringify(data.fieldsVerified ?? [])} drift=${JSON.stringify((data.driftWarnings ?? []).slice(0, 2))}`);
  return { read, data, ms };
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

// ---- round 3 ----
const MAKE_STEP = { action: "select", phase: "fill", field: "inverterMake", note: "Manufacturer", selector: { css: "#inv-make" } } as unknown as RecipeStep;
const reportedModel = (r: Run): boolean =>
  !(r.data.fieldsVerified ?? []).includes("Model")
  && /Model/.test([...(r.data.skipped ?? []), ...(r.data.driftWarnings ?? [])].join(" | "));

// A list that cascades in (or is reset and refilled): main lands it in the real Model.
for (const key of ["bareCascade", "bareReset", "bsCascade"]) {
  const r = await run(key, [MAKE_STEP, step("inverterModel", "Model", "inv-model", "Inverter")], { inverterMake: "Enphase Energy, Inc.", inverterModel: IQ8 });
  const real = await r.read("inv-model"), other = await r.read("ex-model");
  check(`${key}: the cascading Model gets the model, "Existing Model" the rescue chose stays "Select..."`, () => {
    assert.equal(other, "Select...", `"Existing Model" holds ${JSON.stringify(other)} — written into the wrong control`);
    assert.equal(real, IQ8, `the inverter Model reads ${JSON.stringify(real)}`);
  });
}
// A list main cannot see yet (ajax, Kendo): the neighbour is never written, and an unlanded
// Model is never reported verified.
for (const key of ["bareAjax", "bareAjaxSaved", "bsAjax", "kendoCascade"]) {
  const steps = key === "kendoCascade" ? [MAKE_STEP, step("inverterModel", "Model", "inv-model", "Inverter")] : [step("inverterModel", "Model", "inv-model", "Inverter")];
  const r = await run(key, steps, { inverterMake: "Enphase Energy, Inc.", inverterModel: IQ8 });
  const real = await r.read("inv-model"), other = await r.read("ex-model");
  check(`${key}: "Existing Model" is not written, and the Model is either landed or reported, never verified unlanded`, () => {
    assert.equal(other, "Select...", `"Existing Model" holds ${JSON.stringify(other)} — written into the wrong control`);
    if (real !== IQ8) assert.ok(reportedModel(r), `the Model reads ${JSON.stringify(real)} and is reported verified, or not reported at all`);
  });
}
for (const key of ["ownerStateCode", "ownerStateS2", "ownerStateTwin"]) {
  const r = await run(key, [step("ownerState", "State", "own-state", "Property Owner")], { ownerState: "TX" });
  const own = await r.read("own-state"), mail = await r.read("mail-state");
  check(`${key}: the owner State gets Texas for "TX" (a code-valued option answers), Mailing State stays blank`, () => {
    assert.equal(mail, "Select...", `Mailing State holds ${JSON.stringify(mail)} — written into the wrong control`);
    assert.equal(own, "Texas", `the owner State reads ${JSON.stringify(own)}`);
  });
}
{
  const r = await run("utilityCode", [step("utility", "Utility", "utility", "Utility")], { utility: "PGE" });
  const sel = await r.read("utility"), box = await r.read("acctno");
  check("utilityCode: a select2 Utility with value=\"PGE\" is verified in seconds, the account box stays empty, nothing skipped", () => {
    assert.equal(box, "", `the account-number box holds ${JSON.stringify(box)}`);
    assert.equal(sel, "Pacific Gas & Electric", `the Utility reads ${JSON.stringify(sel)}`);
    assert.ok(!(r.data.skipped ?? []).some((x) => /Utility/.test(x)), `skipped=${JSON.stringify(r.data.skipped)}`);
    assert.ok(r.ms < 30_000, `took ${r.ms} ms — a false failure path ran first`);
  });
}
// MUST EXCLUDE: beside PGE's empty shadow, a rescue that took a neighbour which is not the
// recorded question must not write it. Main skips the step visibly; so must this.
for (const key of ["pgeHookedExisting", "pgeExistingAhead"]) {
  const r = await run(key, [step("inverterModel", "Model", "pcInputBase34", "Inverter Clone System")], { inverterModel: IQ8 });
  const other = await r.read("ex-model"), arr = await r.read("mod-model");
  check(`MUST EXCLUDE ${key}: the neighbour the rescue took stays "Select...", "Model" is not verified, and it is reported`, () => {
    assert.equal(other, "Select...", `the neighbour holds ${JSON.stringify(other)} — written into the wrong control`);
    assert.equal(arr, "Select...", `the PV array's Model holds ${JSON.stringify(arr)}`);
    assert.ok(reportedModel(r), `verified=${JSON.stringify(r.data.fieldsVerified)} skipped=${JSON.stringify(r.data.skipped)}`);
  });
}
await browser.close();
server.close();
if (failures) { console.error(`\n${failures} section-redirect check(s) FAILED.`); process.exit(1); }
console.log("\nAll section-redirect checks passed (real Chromium).");
process.exit(0);
