// A WIDGET'S FACE IS EVIDENCE ONLY WHEN IT IS STRICT EVIDENCE (#327 review).
//
// A Telerik-style dropdown keeps its answer's KEY in a concealed <input> and its TEXT on a
// visible face, so the replay's read-back of a landed pick has to read the face
// (widgetDropdownReplay.dom.smoke). The first version of that read-back trusted any face that
// overlapped the answer in either direction, which turned four kinds of MISS into "held":
// a placeholder that happens to contain the answer ("Select Yes or No"), a neighbouring option
// ("Solar" for "Solar + Storage"), a face that changed over a key that did not, and the face of
// the NEIGHBOURING widget a mis-aimed click opened. Each MUST BE FAILED case below is one of
// those; each MUST BE VERIFIED case is a real landed pick the strict rule must still accept.
//   npx tsx portal-bot/src/adapters/widgetFaceReadback.dom.smoke.ts
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

type Widget = {
  id: string;
  options: Array<[string, string]>;
  key?: string;
  face?: string;
  /** after a pick: revert the face to a placeholder, restore a saved option, or move only the face */
  after?: { revertFace?: string; restore?: [string, string]; faceOnly?: boolean };
  /** extra markup inside the face (sr-only prefix) */
  facePrefix?: string;
  /** a second hidden input carrying the option text (key + text widgets) */
  textInput?: boolean;
  /** no face of its own: the input sits bare in the row */
  bare?: boolean;
  /** the face is a plain span, not dressed as a dropdown */
  plainFace?: boolean;
  /** no arrow-icon span on the face */
  noIcon?: boolean;
  /** the key input sits BESIDE the widget, not inside it */
  inputOutside?: boolean;
  /** the key input is a role=combobox input the widget never writes */
  comboInput?: boolean;
  /** a pick EMPTIES the key input (the face still shows the option) */
  emptyKey?: boolean;
  /** classes the own-face walk does not know as a dropdown (a Telerik-style RadComboBox) */
  unknownFace?: boolean;
};

const widget = (w: Widget): string => {
  const opts = w.options.map(([k, t]) => `${k}:${t}`).join("|");
  const after = w.after?.revertFace ? `revert:${w.after.revertFace}` : w.after?.restore ? `restore:${w.after.restore.join(":")}` : w.after?.faceOnly ? "faceonly" : w.emptyKey ? "emptykey" : "";
  const input = `<input id="${w.id}" name="${w.id}" style="display:none" type="text" value="${w.key ?? ""}"${w.comboInput ? ` role="combobox" data-nowrite="1"` : ""}>`
    + (w.textInput ? `<input id="${w.id}_text" name="${w.id}_text" style="display:none" type="text" value="${w.face ?? ""}">` : "");
  if (w.bare) return input;
  const faceCls = w.plainFace ? "plain-face" : w.unknownFace ? "rc-face" : "t-dropdown-wrap t-state-default";
  return `<div class="t-widget ${w.unknownFace ? "rc-box" : "t-dropdown t-header"}" tabindex="0" data-for="${w.id}" data-options="${opts}" data-after="${after}">`
    + `<div class="${faceCls}">${w.facePrefix ?? ""}<span class="t-input">${w.face ?? "Please select..."}</span>`
    + `${w.noIcon ? "" : `<span class="t-select"><span class="t-icon t-arrow-down">select</span></span>`}</div>${w.inputOutside ? "" : input}</div>${w.inputOutside ? input : ""}`;
};

// POWERCLERK'S FILTERED SELECT (#327 round 4): a visually-hidden role=combobox input labelled
// like the step (its aria-label is the step's note, or the identity check skips the step and the
// pin passes for nothing), its face a sibling form-select. `write` false is the #348 fixture's
// emptyValue shape: the widget never writes the input, only the face shows the pick.
type PcWidget = { id: string; options: string[]; face?: string; write?: boolean; restoreFace?: string; icon?: boolean };
const pcWidget = (w: PcWidget): string => `<div class="position-relative wrapper pc" data-for="${w.id}" data-options="${w.options.join("|")}"`
  + ` data-write="${w.write ? "1" : ""}" data-restore="${w.restoreFace ?? ""}">`
  + `<input id="${w.id}" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-label="Pick" readonly tabindex="0" class="visually-hidden" value="${w.write && w.face ? w.face : ""}">`
  + `<div aria-hidden="true"><div class="form-select" data-test-role="filteredSelectField"><div class="selected-display text-nowrap text-truncate" data-test-role="selected-item-text">${w.face ?? "Please select..."}</div>`
  + `${w.icon ? `<span class="material-icons">expand_more</span>` : ""}</div></div></div>`;
// A Bootstrap button dropdown with NO backing input of its own, already showing "Yes".
const GEN_NO_INPUT = `<div class="t-widget btn-group dropdown" tabindex="0" data-for="" data-options="1:Yes|0:No" data-after=""><button type="button" class="btn dropdown-toggle t-input" data-gen="1">Yes</button></div>`;

const page = (rows: string): string => `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font: 14px sans-serif; padding: 16px; }
  .visually-hidden { position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important; margin: -1px !important; overflow: hidden !important; clip: rect(0, 0, 0, 0) !important; white-space: nowrap !important; border: 0 !important; }
  .form-select, .rc-face { display: inline-block; min-width: 180px; border: 1px solid #999; padding: 3px 6px; cursor: pointer; }
  ul[role=listbox] { position: absolute; background: #fff; border: 1px solid #999; z-index: 99; list-style: none; padding: 0; margin: 0; }
  .row { margin: 12px 0; display: flex; gap: 12px; align-items: center; }
  .fld { display: flex; gap: 6px; align-items: center; }
  .t-dropdown-wrap, .plain-face { display: inline-block; min-width: 180px; border: 1px solid #999; padding: 3px 6px; cursor: pointer; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); border: 0; }
  .t-animation-container { position: absolute; background: #fff; border: 1px solid #999; z-index: 99; }
</style></head><body>${rows}
<script>
  document.querySelectorAll(".t-widget").forEach(function (w) {
    var input = document.getElementById(w.getAttribute("data-for")) || null;
    var nowrite = !input || input.getAttribute("data-nowrite") === "1";
    var textInput = document.getElementById(w.getAttribute("data-for") + "_text");
    var faceText = w.querySelector(".t-input");
    var opts = w.getAttribute("data-options").split("|").map(function (p) { var i = p.indexOf(":"); return [p.slice(0, i), p.slice(i + 1)]; });
    var after = w.getAttribute("data-after") || "";
    w.addEventListener("click", function () {
      var open = document.querySelector(".t-animation-container"); if (open) { open.remove(); return; }
      w.setAttribute("data-opened", "1");
      var box = document.createElement("div"); box.className = "t-animation-container";
      var ul = document.createElement("ul"); ul.className = "t-list t-reset";
      opts.forEach(function (o) {
        var li = document.createElement("li"); li.className = "t-item"; li.textContent = o[1];
        li.addEventListener("click", function () {
          if (after !== "faceonly" && !nowrite) input.value = after === "emptykey" ? "" : o[0];
          if (textInput) textInput.value = o[1];
          faceText.textContent = o[1];
          box.remove();
          if (after.indexOf("revert:") === 0) setTimeout(function () { faceText.textContent = after.slice(7); }, 50);
          if (after.indexOf("restore:") === 0) setTimeout(function () { var p = after.slice(8).split(":"); input.value = p[0]; faceText.textContent = p[1]; }, 50);
        });
        ul.appendChild(li);
      });
      box.appendChild(ul); document.body.appendChild(box);
    });
  });
  document.querySelectorAll(".pc").forEach(function (w) {
    var input = document.getElementById(w.getAttribute("data-for"));
    var faceText = w.querySelector("[data-test-role=selected-item-text]");
    var opts = w.getAttribute("data-options").split("|");
    var write = w.getAttribute("data-write") === "1", restore = w.getAttribute("data-restore") || "";
    var openList = function () {
      if (document.getElementById(input.id + "_list")) return;
      w.setAttribute("data-opened", "1");
      var ul = document.createElement("ul"); ul.id = input.id + "_list"; ul.setAttribute("role", "listbox");
      opts.forEach(function (t) {
        var li = document.createElement("li"); li.setAttribute("role", "option"); li.textContent = t;
        li.addEventListener("mousedown", function (e) {
          e.preventDefault();
          if (write) input.value = t;
          faceText.textContent = t;
          ul.remove(); input.setAttribute("aria-expanded", "false");
          if (restore) setTimeout(function () { faceText.textContent = restore; }, 50);
        });
        ul.appendChild(li);
      });
      document.body.appendChild(ul); input.setAttribute("aria-expanded", "true");
    };
    input.addEventListener("click", openList); input.addEventListener("focus", openList);
    w.querySelector("[data-test-role=filteredSelectField]").addEventListener("click", openList);
  });
</script></body></html>`;

const PAGES: Record<string, string> = {};
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(PAGES[(req.url || "").replace(/^\/|\?.*$/g, "")] ?? "<html></html>");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

type Outcome = { skipped: string[]; verified: string[]; key: string; opened: string[] };
const run = async (name: string, rows: string, id: string, answer: string, readId = id): Promise<Outcome> => {
  PAGES[name] = page(rows);
  const p = await context.newPage();
  const url = `http://127.0.0.1:${port}/${name}`;
  await p.goto(url);
  const steps = [{ action: "select", phase: "fill", field: "pick", note: "Pick", selector: { css: `#${id}` } }] as unknown as RecipeStep[];
  const recipe = {
    id: `wf-${name}`, scopeType: "ahj", profileKey: "fl|example|x", state: "FL", ahj: "Example", utility: "",
    portalPlatform: "ibuild", portalUrl: url, status: "complete", version: 1, steps,
    createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "structural",
  } as unknown as PortalRecipe;
  const adapter = new RecipeAdapter(recipe, { pick: answer }, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = p;
  const res = await adapter.fillApplication({} as never);
  const data = (res.data ?? {}) as { skipped?: string[]; fieldsVerified?: string[] };
  const key = await p.locator(`#${readId}`).inputValue().catch(() => "(unreadable)");
  const opened = await p.locator("[data-opened='1']").evaluateAll((els: Element[]) => els.map((e) => e.getAttribute("data-for") || (e.querySelector("[data-gen]") ? "gen" : ""))).catch(() => []) as string[];
  await p.close();
  const out = { skipped: data.skipped ?? [], verified: data.fieldsVerified ?? [], key, opened };
  console.log(`   [${name}] key=${JSON.stringify(key)} opened=${JSON.stringify(opened)} skipped=${JSON.stringify(out.skipped)} verified=${JSON.stringify(out.verified)}`);
  return out;
};
// `setup` asserts the scenario really happened (the key a pick wrote, the widget a click
// opened), so a case cannot pass because the bot never got as far as the read-back.
type Setup = { key?: string; opened?: string };
const assertSetup = (o: Outcome, setup: Setup): void => {
  if (setup.key !== undefined) assert.equal(o.key, setup.key, `the backing key reads ${JSON.stringify(o.key)}, not ${JSON.stringify(setup.key)} — the scenario did not happen as built`);
  if (setup.opened !== undefined) assert.ok(o.opened.includes(setup.opened), `the click did not open #${setup.opened} (opened: ${JSON.stringify(o.opened)})`);
};
const failed = (name: string, o: Outcome, setup: Setup = {}): void => check(`MUST BE FAILED: ${name}`, () => {
  assertSetup(o, setup);
  assert.ok(o.skipped.includes("Pick") && !o.verified.includes("Pick"), `the miss was read as held: skipped=${JSON.stringify(o.skipped)} verified=${JSON.stringify(o.verified)}`);
});
const verified = (name: string, o: Outcome, setup: Setup = {}): void => check(`MUST BE VERIFIED: ${name}`, () => {
  assertSetup(o, setup);
  assert.ok(o.verified.includes("Pick") && !o.skipped.includes("Pick"), `a landed pick was called FAILED: skipped=${JSON.stringify(o.skipped)} verified=${JSON.stringify(o.verified)}`);
});
const YN: Array<[string, string]> = [["1", "Yes"], ["0", "No"]];
const SOLAR: Array<[string, string]> = [["1", "Solar"], ["2", "Solar + Storage"]];

// ---- MUST BE FAILED ---------------------------------------------------------------------
failed("the answer No, the face reverted to 'Select an option...'",
  await run("phNo", widget({ id: "k", options: YN, after: { revertFace: "Select an option..." }, noIcon: true }), "k", "No"), { key: "0" });
failed("the answer Yes, the face reverted to 'Select Yes or No'",
  await run("phYes", widget({ id: "k", options: YN, after: { revertFace: "Select Yes or No" }, noIcon: true }), "k", "Yes"), { key: "1" });
failed("'Solar + Storage' picked, a re-render restored the saved 'Solar'",
  await run("solarUp", widget({ id: "k", options: SOLAR, key: "1", face: "Solar", after: { restore: ["1", "Solar"] }, noIcon: true }), "k", "Solar + Storage"));
failed("'Solar' picked, a re-render restored the saved 'Solar + Storage'",
  await run("solarDown", widget({ id: "k", options: SOLAR, key: "2", face: "Solar + Storage", after: { restore: ["2", "Solar + Storage"] }, noIcon: true }), "k", "Solar"));
failed("the face moved to the answer but the key stayed on the old option",
  await run("staleKey", widget({ id: "k", options: SOLAR, key: "1", face: "Solar", after: { faceOnly: true }, noIcon: true }), "k", "Solar + Storage"));
// The Battery input has no face of its own; the click walk opens the Generator widget beside it.
// The key that never moved ("0") is what refuses these two; the face's owner (below) is pinned
// on its own by genWrappedAlready.
failed("a Battery pick that opened the Generator widget beside it (Battery has no face)",
  await run("genBare", `<div class="row"><span>Battery</span>${widget({ id: "bat", options: YN, key: "0", bare: true })}`
    + `<span>Generator</span>${widget({ id: "gen", options: YN, noIcon: true })}</div>`, "bat", "Yes"), { key: "0", opened: "gen" });
failed("a Battery pick that opened the Generator widget beside it (Battery's face is a plain span)",
  await run("genFace", `<div class="row"><span>Battery</span><span class="value">No</span>${widget({ id: "bat", options: YN, key: "0", bare: true })}`
    + `<span>Generator</span>${widget({ id: "gen", options: YN, noIcon: true })}</div>`, "bat", "Yes"), { key: "0", opened: "gen" });

// ROUND 3. The Generator's key input sits BESIDE its widget (not inside), and the Generator
// already reads "Yes": a Battery pick that opens the Generator must not be confirmed by the
// Generator's face. Ownership is the nearest concealed input; ambiguous is nobody's.
const GEN_YES = widget({ id: "gen", options: YN, key: "1", face: "Yes", noIcon: true, inputOutside: true });
failed("Generator first, key beside its face, already 'Yes'; Battery bare",
  await run("genOutBare", `<div class="row"><span>Generator</span>${GEN_YES}<span>Battery</span>${widget({ id: "bat", options: YN, key: "0", bare: true })}</div>`, "bat", "Yes"), { key: "0", opened: "gen" });
failed("Generator first, key beside its face, already 'Yes'; Battery's face a plain span",
  await run("genOutPlain", `<div class="row"><span>Generator</span>${GEN_YES}<span>Battery</span>${widget({ id: "bat", options: YN, key: "0", face: "No", plainFace: true, noIcon: true, inputOutside: true })}</div>`, "bat", "Yes"), { key: "0", opened: "gen" });
failed("Generator first, both faces dressed, keys beside them, Generator already 'Yes'",
  await run("genOutDressed", `<div class="row"><span>Generator</span>${GEN_YES}<span>Battery</span>${widget({ id: "bat", options: YN, key: "0", face: "No", noIcon: true, inputOutside: true })}</div>`, "bat", "Yes"), { key: "0", opened: "gen" });
// Isolates the face-owner rule: per-field wrappers, the Generator's face already showing the
// answer BEFORE the step, Battery bare. Its key never moves, and "already held" would read the
// Generator's "Yes" as Battery's own face without the owner rule.
failed("a wrapped Generator face already showing the answer before a Battery pick",
  await run("genWrappedAlready", `<div class="row"><div class="fld">${widget({ id: "bat", options: YN, key: "0", bare: true })}</div>`
    + `<div class="fld">${widget({ id: "gen", options: YN, key: "1", face: "Yes", noIcon: true })}</div></div>`, "bat", "Yes"), { key: "0", opened: "gen" });
// Isolates EQUALITY: a fresh widget, "Solar + Storage" picked, a re-render moves key AND face to
// "Solar". The key moved, the face is not a placeholder, it is this widget's own: only "equals
// the option clicked" (not "contains") refuses it.
failed("fresh: 'Solar + Storage' picked, a re-render moved key and face to 'Solar'",
  await run("solarFresh", widget({ id: "k", options: SOLAR, after: { restore: ["1", "Solar"] }, noIcon: true }), "k", "Solar + Storage"), { key: "1" });
// Isolates the PLACEHOLDER test: "None" picked, the face back on "-- None --" with the key written.
failed("'None' picked, the face back on '-- None --'",
  await run("noneBack", widget({ id: "k", options: [["0", "None"], ["1", "Battery"]], after: { revertFace: "-- None --" }, noIcon: true }), "k", "None"), { key: "0" });
// The clicked option must answer the step: "Schedule 7" has no option, and the trailing-token
// pass clicks "Rule 21 - 7 kW or less". The face faithfully shows that wrong pick.
failed("'Schedule 7' answered by a trailing-token click on 'Rule 21 - 7 kW or less'",
  await run("schedule7", widget({ id: "k", options: [["21", "Rule 21 - 7 kW or less"], ["10", "Schedule 10"]], noIcon: true }), "k", "Schedule 7"), { key: "21" });
// The same wrong click on a role=combobox backing input the widget never writes: its own value
// stays "", so nothing was posted. Held JOINTLY: the clicked-option rule and the empty-key rule
// each refuse it, so reverting either one alone keeps this case passing (each is pinned on its
// own elsewhere: schedule7, and keyEmptied below).
failed("a role=combobox backing input that stays empty after a wrong trailing-token pick",
  await run("comboEmpty", widget({ id: "k", options: [["21", "Rule 21 - 7 kW or less"], ["10", "Schedule 10"]], noIcon: true, comboInput: true }), "k", "Schedule 7"), { key: "" });
// Symbols tell these options apart: a restore to the saved "≤ 10 kW", and a face-only move over
// a key left on it, must not verify "> 10 kW".
const KW: Array<[string, string]> = [["1", "≤ 10 kW"], ["2", "> 10 kW"]];
failed("'> 10 kW' picked, a re-render restored the saved '≤ 10 kW'",
  await run("kwRestore", widget({ id: "k", options: KW, key: "1", face: "≤ 10 kW", after: { restore: ["1", "≤ 10 kW"] }, noIcon: true }), "k", "> 10 kW"), { key: "1" });
failed("'> 10 kW' on the face, the key left on '≤ 10 kW'",
  await run("kwFaceOnly", widget({ id: "k", options: KW, key: "1", face: "≤ 10 kW", after: { faceOnly: true }, noIcon: true }), "k", "> 10 kW"), { key: "1" });

// ---- MUST BE VERIFIED -------------------------------------------------------------------
verified("a fresh pick on Telerik markup whose arrow icon reads 'select'",
  await run("telerik", widget({ id: "k", options: [["1", "ADDITION AND REMODELING"], ["5", "STAND-ALONE"]] }), "k", "STAND-ALONE"), { key: "5" });
verified("a containment pick ('... Company' for 'Pacific Gas & Electric')",
  await run("contains", widget({ id: "k", options: [["7", "Pacific Gas & Electric Company"], ["8", "PacifiCorp"]] }), "k", "Pacific Gas & Electric"), { key: "7" });
verified("a re-run over a draft already on the answer (the key does not move)",
  await run("rerun", widget({ id: "k", options: [["1", "ADDITION AND REMODELING"], ["5", "STAND-ALONE"]], key: "5", face: "STAND-ALONE" }), "k", "STAND-ALONE"), { key: "5" });
verified("a widget posting its key and its text in two hidden inputs of its own",
  await run("twoInputs", widget({ id: "k", options: [["1", "ADDITION AND REMODELING"], ["5", "STAND-ALONE"]], textInput: true }), "k", "STAND-ALONE"), { key: "5" });
verified("a face carrying a screen-reader-only 'Selected:' prefix",
  await run("srOnly", widget({ id: "k", options: [["1", "ADDITION AND REMODELING"], ["5", "STAND-ALONE"]], facePrefix: `<span class="sr-only">Selected:</span>` }), "k", "STAND-ALONE"), { key: "5" });
// Battery FIRST, both dressed, keys beside their faces: the Battery pick lands and its own face
// (the nearest) confirms it.
verified("Battery first, keys beside both faces: the Battery pick lands",
  await run("batFirst", `<div class="row"><span>Battery</span>${widget({ id: "bat", options: YN, key: "0", face: "No", noIcon: true, inputOutside: true })}<span>Generator</span>${GEN_YES}</div>`, "bat", "Yes"), { key: "1", opened: "bat" });

// ---- ROUND 4 ------------------------------------------------------------------------------
// SHOULD-FIX 2: an input the widget never writes (PowerClerk's emptyValue select) or a key that is
// the option's text held a correct pick; a containment that changes a number does not.
verified("PowerClerk empty-value: 'Enphase Energy' picked for 'Enphase Energy Inc.'",
  await run("pcEnphase", pcWidget({ id: "k", options: ["Enphase Energy", "SolarEdge Technologies"] }), "k", "Enphase Energy Inc."), { key: "", opened: "k" });
verified("PowerClerk empty-value: 'IQ8PLUS-72-2-US' picked for 'IQ8PLUS 72 2 US'",
  await run("pcIq8", pcWidget({ id: "k", options: ["IQ8PLUS-72-2-US", "IQ8M-72-2-US"] }), "k", "IQ8PLUS 72 2 US"), { key: "", opened: "k" });
verified("PowerClerk empty-value: '7.6' picked for '7.60 kW'",
  await run("pc76", pcWidget({ id: "k", options: ["7.6", "11.4"] }), "k", "7.60 kW"), { key: "", opened: "k" });
verified("PowerClerk empty-value: an exact pick on a face carrying an 'expand_more' icon",
  await run("pcIcon", pcWidget({ id: "k", options: ["SolarEdge Technologies", "Enphase Energy"], icon: true }), "k", "SolarEdge Technologies"), { key: "", opened: "k" });
verified("a Telerik-style widget whose key IS the option's text, its face unknown to the walk",
  await run("keyIsText", widget({ id: "k", options: [["ADDITION", "ADDITION"], ["STAND-ALONE", "STAND-ALONE"]], unknownFace: true }), "k", "STAND-ALONE STRUCTURE"), { key: "STAND-ALONE" });
failed("PowerClerk empty-value: 'Schedule 1' picked for 'Schedule 10'",
  await run("pcSchedule", pcWidget({ id: "k", options: ["Schedule 1", "Schedule 7"] }), "k", "Schedule 10"), { key: "", opened: "k" });
failed("PowerClerk empty-value: '> 10 kW' picked, the face restored to '≤ 10 kW'",
  await run("pcKwRestore", pcWidget({ id: "k", options: ["≤ 10 kW", "> 10 kW"], face: "≤ 10 kW", restoreFace: "≤ 10 kW" }), "k", "> 10 kW"), { key: "", opened: "k" });
failed("a key the pick EMPTIED (the face shows the option)",
  await run("keyEmptied", widget({ id: "k", options: [["1", "ADDITION"], ["5", "STAND-ALONE"]], key: "1", face: "ADDITION", emptyKey: true, noIcon: true }), "k", "STAND-ALONE"), { key: "" });
failed("a bare role=combobox input beside a Telerik neighbour that shows the shorter option",
  await run("bareBesideTelerik", `<div class="row"><span>Pick</span><input id="k" role="combobox" aria-label="Pick" class="visually-hidden" value="">`
    + `${widget({ id: "nb", options: [["1", "Enphase Energy"], ["2", "SolarEdge"]], noIcon: true })}</div>`, "k", "Enphase Energy Inc."), { key: "", opened: "nb" });

// SHOULD-FIX 3: "/" and "." between digits and a leading minus tell options apart.
failed("'1/0 AWG' picked, a re-render restored the saved '10 AWG'",
  await run("awgRestore", widget({ id: "k", options: [["1", "1/0 AWG"], ["2", "10 AWG"]], key: "2", face: "10 AWG", after: { restore: ["2", "10 AWG"] }, noIcon: true }), "k", "1/0 AWG"), { key: "2" });
failed("'-5°' picked, a re-render restored the saved '5°'",
  await run("tiltRestore", widget({ id: "k", options: [["1", "-5°"], ["2", "5°"]], key: "2", face: "5°", after: { restore: ["2", "5°"] }, noIcon: true }), "k", "-5°"), { key: "2" });
failed("'7.6 kW' picked, a re-render restored the saved '76 kW'",
  await run("kw76Restore", widget({ id: "k", options: [["1", "7.6 kW"], ["2", "76 kW"]], key: "2", face: "76 kW", after: { restore: ["2", "76 kW"] }, noIcon: true }), "k", "7.6 kW"), { key: "2" });
failed("PowerClerk empty-value: '1/0 AWG' picked, the face restored to '10 AWG'",
  await run("pcAwgRestore", pcWidget({ id: "k", options: ["1/0 AWG", "10 AWG"], face: "10 AWG", restoreFace: "10 AWG" }), "k", "1/0 AWG"), { key: "", opened: "k" });
verified("a fresh '1/0 AWG' pick",
  await run("awgFresh", widget({ id: "k", options: [["1", "1/0 AWG"], ["2", "10 AWG"]], noIcon: true }), "k", "1/0 AWG"), { key: "1" });
verified("a fresh '-5°' pick",
  await run("tiltFresh", widget({ id: "k", options: [["1", "-5°"], ["2", "5°"]], noIcon: true }), "k", "-5°"), { key: "1" });
verified("PowerClerk empty-value: the certified 'Enphase Energy Inc' picked for 'Enphase Energy Inc.'",
  await run("pcEnphaseInc", pcWidget({ id: "k", options: ["Enphase Energy Inc", "SolarEdge Technologies"] }), "k", "Enphase Energy Inc."), { key: "", opened: "k" });

// SHOULD-FIX 4: when the key did not move, a face counts only right beside its input. Each
// Battery step opens the Generator (already "Yes") and Battery's key stays "0".
failed("captioned row: a bare Battery key, then a Bootstrap 'Generator' dropdown with no input",
  await run("genNoInputBare", `<div class="row"><span>Battery</span>${widget({ id: "bat", options: YN, key: "0", bare: true })}<span>Generator</span>${GEN_NO_INPUT}</div>`, "bat", "Yes"), { key: "0", opened: "gen" });
failed("captioned row: Battery's face a plain span 'No', then the input-less Generator",
  await run("genNoInputPlain", `<div class="row"><span>Battery</span><span class="value">No</span>${widget({ id: "bat", options: YN, key: "0", bare: true })}<span>Generator</span>${GEN_NO_INPUT}</div>`, "bat", "Yes"), { key: "0", opened: "gen" });
failed("captioned row: the input-less Generator first, then a dressed Battery still 'No'",
  await run("genNoInputDressed", `<div class="row"><span>Generator</span>${GEN_NO_INPUT}<span>Battery</span>${widget({ id: "bat", options: YN, key: "0", face: "No", noIcon: true, inputOutside: true })}</div>`, "bat", "Yes"), { key: "0", opened: "gen" });
failed("captions in a table header: Battery's key cell, then the input-less Generator's cell",
  await run("genNoInputTable", `<table><thead><tr><th>Battery</th><th>Generator</th></tr></thead><tbody><tr><td>${widget({ id: "bat", options: YN, key: "0", bare: true })}</td><td>${GEN_NO_INPUT}</td></tr></tbody></table>`, "bat", "Yes"), { key: "0", opened: "gen" });
verified("a re-run in a captioned row: Battery's key beside its own face, already 'Yes'",
  await run("rerunCaptioned", `<div class="row"><span>Battery</span>${widget({ id: "bat", options: YN, key: "1", face: "Yes", noIcon: true, inputOutside: true })}<span>Generator</span>${GEN_YES}</div>`, "bat", "Yes"), { key: "1", opened: "bat" });

// ---- MUST EXCLUDE (F5): only a concealed backing INPUT may be confirmed by a face ---------
// A select2-style native select the pick does not change (the portal reverts it), beside a face
// that shows the answer: the native select's own option decides, and it is the wrong one.
{
  PAGES.nativeRevert = `<!doctype html><html><body style="font:14px sans-serif;padding:16px">
    <div class="wrap"><select id="ns" style="position:absolute;width:1px;height:1px;clip:rect(0 0 0 0);overflow:hidden;opacity:0">
      <option value="">Select...</option><option value="1">Solar</option><option value="2">Wind</option></select>
    <span class="dropdown-toggle" id="nsface" style="display:inline-block;min-width:180px;border:1px solid #999;padding:3px">Select...</span></div>
    <script>
      var s = document.getElementById("ns"), f = document.getElementById("nsface");
      s.addEventListener("change", function () { f.textContent = s.options[s.selectedIndex].text; setTimeout(function () { s.value = "1"; }, 30); });
    </script></body></html>`;
  const p = await context.newPage();
  const url = `http://127.0.0.1:${port}/nativeRevert`;
  await p.goto(url);
  const steps = [{ action: "select", phase: "fill", field: "pick", note: "Pick", selector: { css: "#ns" } }] as unknown as RecipeStep[];
  const recipe = {
    id: "wf-native", scopeType: "ahj", profileKey: "fl|example|x", state: "FL", ahj: "Example", utility: "",
    portalPlatform: "ibuild", portalUrl: url, status: "complete", version: 1, steps,
    createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "structural",
  } as unknown as PortalRecipe;
  const adapter = new RecipeAdapter(recipe, { pick: "Wind" }, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = p;
  const res = await adapter.fillApplication({} as never);
  const data = (res.data ?? {}) as { skipped?: string[]; fieldsVerified?: string[] };
  console.log(`   [nativeRevert] skipped=${JSON.stringify(data.skipped ?? [])} verified=${JSON.stringify(data.fieldsVerified ?? [])}`);
  check("MUST EXCLUDE: a native select left on the wrong option is a miss, whatever the face beside it shows", () => {
    assert.ok((data.skipped ?? []).includes("Pick"), `skipped=${JSON.stringify(data.skipped)} verified=${JSON.stringify(data.fieldsVerified)}`);
  });
  await p.close();
}

// ---- MUST EXCLUDE (round 1, F5 second half): a VISIBLE input left on the wrong option beside a
// face showing the answer is a miss: only a concealed backing input may be confirmed by a face.
// It ends on a THIRD option (round 4 nit), so its key moved: only "a visible input is never
// confirmed by a face" refuses it, not the moved-key rule.
{
  PAGES.visibleRevert = `<!doctype html><html><body style="font:14px sans-serif;padding:16px">
    <div class="wrap"><input id="vi" readonly value="Solar" style="width:160px">
    <span class="dropdown-toggle" id="viface" style="display:inline-block;min-width:180px;border:1px solid #999;padding:3px">Solar</span></div>
    <script>
      var i = document.getElementById("vi"), f = document.getElementById("viface");
      var openList = function () {
        if (document.getElementById("vilist")) return;
        var ul = document.createElement("ul"); ul.id = "vilist"; ul.setAttribute("role", "listbox");
        ["Solar", "Wind", "Hydro"].forEach(function (t) {
          var li = document.createElement("li"); li.setAttribute("role", "option"); li.textContent = t;
          li.addEventListener("click", function () { f.textContent = t; i.value = t; ul.remove(); setTimeout(function () { i.value = "Hydro"; }, 30); });
          ul.appendChild(li);
        });
        document.body.appendChild(ul);
      };
      i.addEventListener("click", openList); f.addEventListener("click", openList);
    </script></body></html>`;
  const p = await context.newPage();
  const url = `http://127.0.0.1:${port}/visibleRevert`;
  await p.goto(url);
  const steps = [{ action: "select", phase: "fill", field: "pick", note: "Pick", selector: { css: "#vi" } }] as unknown as RecipeStep[];
  const recipe = {
    id: "wf-visible", scopeType: "ahj", profileKey: "fl|example|x", state: "FL", ahj: "Example", utility: "",
    portalPlatform: "ibuild", portalUrl: url, status: "complete", version: 1, steps,
    createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "structural",
  } as unknown as PortalRecipe;
  const adapter = new RecipeAdapter(recipe, { pick: "Wind" }, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = p;
  const res = await adapter.fillApplication({} as never);
  const data = (res.data ?? {}) as { skipped?: string[]; fieldsVerified?: string[] };
  const shown = await p.locator("#vi").inputValue().catch(() => "");
  const face = await p.locator("#viface").textContent().catch(() => "");
  console.log(`   [visibleRevert] input=${JSON.stringify(shown)} face=${JSON.stringify(face)} skipped=${JSON.stringify(data.skipped ?? [])} verified=${JSON.stringify(data.fieldsVerified ?? [])}`);
  check("MUST EXCLUDE: a visible input left on the wrong option is a miss, whatever the face beside it shows", () => {
    assert.equal(shown, "Hydro", `the input reads ${JSON.stringify(shown)} — the scenario did not happen as built`);
    assert.ok(!(data.fieldsVerified ?? []).includes("Pick"), `verified=${JSON.stringify(data.fieldsVerified)} skipped=${JSON.stringify(data.skipped)}`);
  });
  await p.close();
}

await browser.close();
server.close();
if (failures) { console.error(`\nwidgetFaceReadback.dom.smoke: ${failures} FAILURE(S)`); process.exit(1); }
console.log("\nwidgetFaceReadback.dom.smoke: PASS");
process.exit(0);
