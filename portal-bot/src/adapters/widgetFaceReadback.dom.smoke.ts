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
};

const widget = (w: Widget): string => {
  const opts = w.options.map(([k, t]) => `${k}:${t}`).join("|");
  const after = w.after?.revertFace ? `revert:${w.after.revertFace}` : w.after?.restore ? `restore:${w.after.restore.join(":")}` : w.after?.faceOnly ? "faceonly" : "";
  const input = `<input id="${w.id}" name="${w.id}" style="display:none" type="text" value="${w.key ?? ""}">`
    + (w.textInput ? `<input id="${w.id}_text" name="${w.id}_text" style="display:none" type="text" value="${w.face ?? ""}">` : "");
  if (w.bare) return input;
  const faceCls = w.plainFace ? "plain-face" : "t-dropdown-wrap t-state-default";
  return `<div class="t-widget t-dropdown t-header" tabindex="0" data-for="${w.id}" data-options="${opts}" data-after="${after}">`
    + `<div class="${faceCls}">${w.facePrefix ?? ""}<span class="t-input">${w.face ?? "Please select..."}</span>`
    + `${w.noIcon ? "" : `<span class="t-select"><span class="t-icon t-arrow-down">select</span></span>`}</div>${input}</div>`;
};

const page = (rows: string): string => `<!doctype html><html><head><style>
  body { font: 14px sans-serif; padding: 16px; }
  .row { margin: 12px 0; display: flex; gap: 12px; align-items: center; }
  .t-dropdown-wrap, .plain-face { display: inline-block; min-width: 180px; border: 1px solid #999; padding: 3px 6px; cursor: pointer; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); border: 0; }
  .t-animation-container { position: absolute; background: #fff; border: 1px solid #999; z-index: 99; }
</style></head><body>${rows}
<script>
  document.querySelectorAll(".t-widget").forEach(function (w) {
    var input = document.getElementById(w.getAttribute("data-for"));
    var textInput = document.getElementById(w.getAttribute("data-for") + "_text");
    var faceText = w.querySelector(".t-input");
    var opts = w.getAttribute("data-options").split("|").map(function (p) { var i = p.indexOf(":"); return [p.slice(0, i), p.slice(i + 1)]; });
    var after = w.getAttribute("data-after") || "";
    w.addEventListener("click", function () {
      var open = document.querySelector(".t-animation-container"); if (open) { open.remove(); return; }
      var box = document.createElement("div"); box.className = "t-animation-container";
      var ul = document.createElement("ul"); ul.className = "t-list t-reset";
      opts.forEach(function (o) {
        var li = document.createElement("li"); li.className = "t-item"; li.textContent = o[1];
        li.addEventListener("click", function () {
          if (after !== "faceonly") input.value = o[0];
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
</script></body></html>`;

const PAGES: Record<string, string> = {};
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(PAGES[(req.url || "").replace(/^\/|\?.*$/g, "")] ?? "<html></html>");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

type Outcome = { skipped: string[]; verified: string[]; key: string };
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
  await p.close();
  const out = { skipped: data.skipped ?? [], verified: data.fieldsVerified ?? [], key };
  console.log(`   [${name}] key=${JSON.stringify(key)} skipped=${JSON.stringify(out.skipped)} verified=${JSON.stringify(out.verified)}`);
  return out;
};
const failed = (name: string, o: Outcome): void => check(`MUST BE FAILED: ${name}`, () => {
  assert.ok(o.skipped.includes("Pick") && !o.verified.includes("Pick"), `the miss was read as held: skipped=${JSON.stringify(o.skipped)} verified=${JSON.stringify(o.verified)}`);
});
const verified = (name: string, o: Outcome): void => check(`MUST BE VERIFIED: ${name}`, () => {
  assert.ok(o.verified.includes("Pick") && !o.skipped.includes("Pick"), `a landed pick was called FAILED: skipped=${JSON.stringify(o.skipped)} verified=${JSON.stringify(o.verified)}`);
});
const YN: Array<[string, string]> = [["1", "Yes"], ["0", "No"]];
const SOLAR: Array<[string, string]> = [["1", "Solar"], ["2", "Solar + Storage"]];

// ---- MUST BE FAILED ---------------------------------------------------------------------
failed("the answer No, the face reverted to 'Select an option...'",
  await run("phNo", widget({ id: "k", options: YN, after: { revertFace: "Select an option..." }, noIcon: true }), "k", "No"));
failed("the answer Yes, the face reverted to 'Select Yes or No'",
  await run("phYes", widget({ id: "k", options: YN, after: { revertFace: "Select Yes or No" }, noIcon: true }), "k", "Yes"));
failed("'Solar + Storage' picked, a re-render restored the saved 'Solar'",
  await run("solarUp", widget({ id: "k", options: SOLAR, key: "1", face: "Solar", after: { restore: ["1", "Solar"] }, noIcon: true }), "k", "Solar + Storage"));
failed("'Solar' picked, a re-render restored the saved 'Solar + Storage'",
  await run("solarDown", widget({ id: "k", options: SOLAR, key: "2", face: "Solar + Storage", after: { restore: ["2", "Solar + Storage"] }, noIcon: true }), "k", "Solar"));
failed("the face moved to the answer but the key stayed on the old option",
  await run("staleKey", widget({ id: "k", options: SOLAR, key: "1", face: "Solar", after: { faceOnly: true }, noIcon: true }), "k", "Solar + Storage"));
// The Battery input has no face of its own; the click walk opens the Generator widget beside it.
failed("a Battery pick that opened the Generator widget beside it (Battery has no face)",
  await run("genBare", `<div class="row"><span>Battery</span>${widget({ id: "bat", options: YN, key: "0", bare: true })}`
    + `<span>Generator</span>${widget({ id: "gen", options: YN, noIcon: true })}</div>`, "bat", "Yes"));
failed("a Battery pick that opened the Generator widget beside it (Battery's face is a plain span)",
  await run("genFace", `<div class="row"><span>Battery</span><span class="value">No</span>${widget({ id: "bat", options: YN, key: "0", bare: true })}`
    + `<span>Generator</span>${widget({ id: "gen", options: YN, noIcon: true })}</div>`, "bat", "Yes"));

// ---- MUST BE VERIFIED -------------------------------------------------------------------
verified("a fresh pick on Telerik markup whose arrow icon reads 'select'",
  await run("telerik", widget({ id: "k", options: [["1", "ADDITION AND REMODELING"], ["5", "STAND-ALONE"]] }), "k", "STAND-ALONE"));
verified("a containment pick ('... Company' for 'Pacific Gas & Electric')",
  await run("contains", widget({ id: "k", options: [["7", "Pacific Gas & Electric Company"], ["8", "PacifiCorp"]] }), "k", "Pacific Gas & Electric"));
verified("a re-run over a draft already on the answer (the key does not move)",
  await run("rerun", widget({ id: "k", options: [["1", "ADDITION AND REMODELING"], ["5", "STAND-ALONE"]], key: "5", face: "STAND-ALONE" }), "k", "STAND-ALONE"));
verified("a widget posting its key and its text in two hidden inputs of its own",
  await run("twoInputs", widget({ id: "k", options: [["1", "ADDITION AND REMODELING"], ["5", "STAND-ALONE"]], textInput: true }), "k", "STAND-ALONE"));
verified("a face carrying a screen-reader-only 'Selected:' prefix",
  await run("srOnly", widget({ id: "k", options: [["1", "ADDITION AND REMODELING"], ["5", "STAND-ALONE"]], facePrefix: `<span class="sr-only">Selected:</span>` }), "k", "STAND-ALONE"));

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

await browser.close();
server.close();
if (failures) { console.error(`\nwidgetFaceReadback.dom.smoke: ${failures} FAILURE(S)`); process.exit(1); }
console.log("\nwidgetFaceReadback.dom.smoke: PASS");
process.exit(0);
