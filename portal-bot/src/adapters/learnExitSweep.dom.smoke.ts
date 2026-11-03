// A LEARN THAT LEFT A MIDDLE PAGE INCOMPLETE MUST SAY SO (issue #534), IN REAL CHROMIUM.
//
// Live (PacifiCorp NEM, a two-array job): the learn walked ten pages, ended "trusted" and promoted
// the shared recipe to complete. Its verifiers read only the final page. Page 9, Generation System
// Information, had been left with the inverter MODEL blank (required) and System Rating reading
// "Needs to be recalculated". The run's own events said so as it happened: equipment_fill_not_held
// for the inverter model, never followed by a fill that held, and compute_settled settled:false
// after Calculate. Nothing carried either fact to the trust gate. The required-field sweep could
// not see the model either: PowerClerk's filtered select is a readonly input[role=combobox] with
// no `required`, no aria-required and no asterisk. Its only marker is the portal's own validation
// line under it, "This field is required."
//
// The fixture is that shape: a four-step PowerClerk-style wizard at one URL (customer -> generation
// system -> service -> review). The MIDDLE step's inverter Model is a combobox with no required
// marker, and the portal refuses the project's model for the chosen manufacturer (the pick reverts
// to "Please select..."). Calculate leaves the rating "Needs to be recalculated" and shows "This
// field is required." under the model. The walk reaches review either way.
//
//   MUST CATCH (bad portal) — the learn result names, for the middle page:
//     1. the model as a required field left blank/unheld (requiredFieldMisses);
//     2. the rating still to be recalculated when the walk left it (the page's trustEvidence
//        computePending);
//     3. the validation error still showing when the walk left it (the page's trustEvidence
//        validationErrors — read by the ONE field-validation reader, which matches PowerClerk's
//        data-test-role="validation-error" container);
//   and none of them is about the final page (it is the MIDDLE page that was incomplete); and the
//   middle page is on record as READ (pageExitReads), so a clean result could not be an unread one.
//   MUST CATCH (wrong portal: the pick lands on ANOTHER model, not a blank — what a stale selector
//   reaching the neighbouring control reads like): the model is still a required miss. Only a
//   read-back holding the project's own value clears an unheld equipment fill.
//   MUST PASS (clean portal: the model is accepted, Calculate computes): all of them are empty, so
//   a complete fill can still be trusted (the gate's over-correction guard).
//
// The backend half (these signals block the trust gate; the trusted message stops saying "the
// earlier pages were not re-read") is backend/test/learnTrustBlanks.test.ts.
//
// Run: npx tsx portal-bot/src/adapters/learnExitSweep.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import type { ProjectRecord } from "../../../shared/src/types";
import { AutoLearnAdapter, type LearnPlanner, type LearnResult } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// A Vue-filtered-select as PowerClerk renders it: a readonly, visually-hidden input[role=combobox]
// plus an aria-hidden display box. The option popper is TELEPORTED to <body> (PowerClerk's
// data-test-popper-id), so the widget itself holds only the selected text. No required marker.
const combo = (id: string, label: string, role: string): string => `
  <div data-test-role="${role}">
    <div class="position-relative wrapper">
      <input id="${id}" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="${id}-list"
             aria-label="${label}" readonly tabindex="0" class="visually-hidden" value=""
             style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">
      <div aria-hidden="true"><div class="form-select" id="${id}-box" style="border:1px solid #999;padding:4px;min-width:16em">
        <div class="selected-display" id="${id}-disp">Please select...</div>
      </div></div>
    </div>
  </div>`;

const STEP1 = `
  <h2>Customer Information</h2>
  <div class="form-group"><label for="first">First Name</label><input id="first" type="text"></div>
  <div class="form-group"><label for="last">Last Name</label><input id="last" type="text"></div>
  <div class="form-group"><label for="email">Email</label><input id="email" type="text"></div>
  <div class="form-group"><label for="phone">Phone</label><input id="phone" type="text"></div>
  <div class="form-group"><label for="addr">Service Address</label><input id="addr" type="text"></div>
  <button id="next" type="button">Next</button>`;

const STEP2 = `
  <h2>Generation System Information</h2>
  <fieldset><legend>Inverter <button type="button" id="clonesys">Clone System</button></legend>
    <div class="row">
      <div class="input-group"><span class="input-group-text">Qty</span>
        <input id="invQty" type="text" placeholder="Qty" aria-label="Qty" data-test-role="inverter-quantity"></div>
      <span class="lbl">Manufacturer</span>${combo("invMfr", "Manufacturer", "inverter-manufacturer-select")}
      <span class="lbl">Model</span>${combo("invModel", "Model", "inverter-model-select")}
    </div>
    <div id="validationerror1-validation-error" data-test-role="validation-error" class="element-validation-feedback row" style="display:none;color:#b00">
      <div class="col-12">This field is required.</div></div>
  </fieldset>
  <fieldset><legend>PV Array <button type="button">Delete Array</button></legend>
    <div class="row">
      <div class="input-group"><span class="input-group-text">Qty</span>
        <input id="modQty" type="text" placeholder="Qty" aria-label="Qty" data-test-role="pv-array-quantity"></div>
      <span class="lbl">Manufacturer</span>${combo("modMfr", "Manufacturer", "pv-array-manufacturer-select")}
      <span class="lbl">Model</span>${combo("modModel", "Model", "pv-array-model-select")}
    </div>
  </fieldset>
  <div><button id="calc" type="button">Calculate</button></div>
  <div class="row"><div class="col-6 fw-bold">System Rating:</div>
    <div class="col-6"><span id="rating" data-test-role="needs-calculated-message">0.00 kW</span></div></div>
  <button id="next" type="button">Next</button>`;

const STEP3 = `
  <h2>Electrical Service</h2>
  <div class="form-group"><label for="amps">Main Service Panel Rating (Amps)</label><input id="amps" type="text"></div>
  <div class="form-group"><label for="notes">Comments regarding system</label><textarea id="notes"></textarea></div>
  <button id="next" type="button">Next</button>`;

const STEP4 = `
  <h2>Review</h2>
  <p>Please review your application before submitting.</p>
  <button id="submit" type="button">Submit Application</button>`;

type Mode = "bad" | "clean" | "wrong";
const page = (mode: Mode): string => `<!doctype html><html><head><title>Edit Project</title></head>
<body style="font:14px sans-serif;padding:16px">
<div id="app"></div>
<script>
  var CLEAN = ${mode === "clean" ? "true" : "false"};
  var WRONG = ${mode === "wrong" ? "true" : "false"};
  var STEPS = [${[STEP1, STEP2, STEP3, STEP4].map((s) => JSON.stringify(s)).join(",")}];
  var OPTS = {
    invMfr: ['Altenergy Power System', 'Enphase Energy Inc.'],
    invModel: ['0.8 kW (Model DS3-L {240V} [SI1])', '0.96 kW (Model QT2 {240V})'],
    modMfr: ['Znshine PV-Tech (ZNSHINE SOLAR)', 'Hanwha Q CELLS'],
    modModel: ['440W (Model ZXM7-UHLDD108-440/N)', '425W (Model ZXM7-UHLDD108-425/N)']
  };
  var saved = {};
  function stale() { var r = document.getElementById('rating'); if (r) r.textContent = 'Needs to be recalculated'; }
  function closeList() { var b = document.getElementById('combo-popper'); if (b) b.remove(); }
  function commit(id, text) {
    var inp = document.getElementById(id);
    closeList();
    inp.setAttribute('aria-expanded', 'false');
    // THE BAD PORTAL REFUSES THE MODEL for the chosen manufacturer: the pick reverts at once, as
    // the live save round-trip handed the inverter model back empty.
    // THE WRONG PORTAL lands the pick on ANOTHER model (what a stale selector reaching the
    // neighbouring control reads like): not blank, and not the project's.
    if (WRONG && id === 'invModel') text = OPTS.invModel[1];
    else if (!CLEAN && id === 'invModel') { inp.value = ''; document.getElementById(id + '-disp').textContent = 'Please select...'; stale(); return; }
    inp.value = text;
    document.getElementById(id + '-disp').textContent = text;
    saved[id] = text;
    stale();
  }
  function open(id) {
    closeList();
    var inp = document.getElementById(id);
    inp.setAttribute('aria-expanded', 'true');
    var box = document.createElement('ul');
    box.id = 'combo-popper';
    box.setAttribute('role', 'listbox');
    box.style.cssText = 'position:absolute;left:20px;top:20px;background:#fff;border:1px solid #333;z-index:9;list-style:none;padding:4px';
    (OPTS[id] || []).forEach(function (text) {
      var li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.textContent = text;
      li.addEventListener('mousedown', function (e) { e.preventDefault(); commit(id, text); });
      box.appendChild(li);
    });
    document.body.appendChild(box); // teleported, as PowerClerk's popper is
  }
  function wireStep2() {
    ['invMfr', 'invModel', 'modMfr', 'modModel'].forEach(function (id) {
      var inp = document.getElementById(id);
      inp.addEventListener('click', function () { open(id); });
      inp.addEventListener('focus', function () { open(id); });
      document.getElementById(id + '-box').addEventListener('click', function () { open(id); });
      document.getElementById(id + '-disp').addEventListener('click', function () { open(id); });
    });
    ['invQty', 'modQty'].forEach(function (id) {
      document.getElementById(id).addEventListener('change', function () { saved[id] = this.value; stale(); });
    });
    document.getElementById('calc').addEventListener('click', function () {
      var model = document.getElementById('invModel');
      var complete = ['invMfr', 'invModel', 'modMfr', 'modModel'].every(function (k) { return !!document.getElementById(k).value; });
      if (complete) {
        document.getElementById('rating').textContent = '7.20 kW';
        model.setAttribute('aria-invalid', 'false');
        document.getElementById('validationerror1-validation-error').style.display = 'none';
      } else {
        // The portal does not compute an incomplete system; it marks what is missing.
        stale();
        if (!model.value) {
          model.setAttribute('aria-invalid', 'true');
          document.getElementById('validationerror1-validation-error').style.display = 'block';
        }
      }
    });
  }
  function show(i) {
    closeList();
    document.getElementById('app').innerHTML = STEPS[i];
    window.__step = i + 1;
    if (i === 1) wireStep2();
    var next = document.getElementById('next');
    if (next) next.addEventListener('click', function () { show(i + 1); });
  }
  window.__saved = saved;
  show(0);
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  const u = String(req.url || "");
  res.end(page(u.startsWith("/clean") ? "clean" : u.startsWith("/wrong") ? "wrong" : "bad"));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

// The planner the backend would build, scripted: it answers the plain text boxes by label, leaves
// the equipment to the learner's deterministic pass (as the live planner did), advances on Next,
// and calls review on the review step.
const ANSWERS: Record<string, string> = {
  "First Name": "Pat", "Last Name": "Example", Email: "pat@example.test", Phone: "555-0100",
  "Service Address": "1 Test St", "Main Service Panel Rating (Amps)": "200",
};
const planner: LearnPlanner = async (req) => {
  if (/please review your application/i.test(req.bodyText)) return { fills: [], atReview: true };
  const next = req.fields.findIndex((f) => f.fieldType === "button" && /^next$/i.test(String(f.label ?? "").trim()));
  const advanceSelectorIndex = next >= 0 ? next : undefined;
  const fills: Array<{ selectorIndex: number; value: string }> = [];
  req.fields.forEach((f, i) => {
    const v = ANSWERS[String(f.label ?? "").trim()];
    if (v && !req.alreadyFilledLabels.includes(String(f.label))) fills.push({ selectorIndex: i, value: v });
  });
  return { fills, advanceSelectorIndex, atReview: false };
};

const EQUIPMENT = {
  inverterMake: "AP Systems",          // alias -> "Altenergy Power System"
  inverterModel: "DS3-L",              // -> "0.8 kW (Model DS3-L {240V} [SI1])" (refused on the bad portal)
  inverterQty: "8",
  moduleMake: "Znshine",               // -> "Znshine PV-Tech (ZNSHINE SOLAR)"
  moduleModel: "ZXM7-UHLDD108-440/N",  // -> "440W (Model ZXM7-UHLDD108-440/N)"
  moduleQty: "8",
};

const browser = await chromium.launch();
const runDirs: string[] = [];
async function learnOn(url: string, tag: string): Promise<{ result: LearnResult; events: string; step: number }> {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), `exit-sweep-smoke-${tag}-`));
  runDirs.push(runDir);
  process.env.AUTOLEARN_RUN_DIR = runDir; // chosen at construction
  const adapter = new AutoLearnAdapter(`PowerClerk exit-sweep smoke (${tag})`, planner, { policyProfile: "none", equipment: EQUIPMENT, maxPages: 8 });
  const ctx = await browser.newContext();
  await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const p = await ctx.newPage();
  await p.goto(url);
  (adapter as unknown as { page: unknown }).page = p;
  const result = await adapter.learn({} as never, {} as ProjectRecord);
  const step = Number(await p.evaluate(() => (window as unknown as { __step?: number }).__step ?? 0).catch(() => 0));
  const dir = adapter.debug?.dir ?? "";
  const events = dir && fs.existsSync(path.join(dir, "events.jsonl")) ? fs.readFileSync(path.join(dir, "events.jsonl"), "utf8") : "";
  await ctx.close();
  return { result, events, step };
}

const T0 = Date.now();
const [bad, clean, wrong] = await Promise.all([learnOn(`${base}/`, "bad"), learnOn(`${base}/clean`, "clean"), learnOn(`${base}/wrong`, "wrong")]);
console.log(`  [${((Date.now() - T0) / 1000).toFixed(0)}s] all three learns finished`);

// The page-exit findings travel as the pages' trust evidence (one record per page that ended with
// something) plus which pages were read at all; flattened here to "page N: …" lines.
type Exit = { trustEvidence?: Array<{ page: number; validationErrors: string[]; requiredUnchecked: Array<{ label: string; acknowledgment: boolean }>; strayWrites: string[]; computePending?: string }>; pageExitReads?: { read: number[]; unread: number[] } };
const ev = (r: LearnResult) => (r as LearnResult & Exit).trustEvidence ?? [];
const reads = (r: LearnResult) => (r as LearnResult & Exit).pageExitReads;
const misses = (r: LearnResult): string[] => r.requiredFieldMisses ?? [];
const pending = (r: LearnResult): string[] => ev(r).filter((e) => e.computePending).map((e) => `page ${e.page}: ${e.computePending}`);
const invalid = (r: LearnResult): string[] => ev(r).flatMap((e) => e.validationErrors.map((v) => `page ${e.page}: ${v}`));
const blockingEvidence = (r: LearnResult): number => ev(r).reduce((n, e) => n + e.validationErrors.length + e.strayWrites.length + (e.computePending ? 1 : 0) + e.requiredUnchecked.filter((u) => !u.acknowledgment).length, 0);
const pageOf = (line: string): number => Number(/^page (\d+):/.exec(line)?.[1] ?? NaN);
const summary = (r: LearnResult): string =>
  `reachedReview=${r.reachedReview} pages=${r.pageCount} misses=${JSON.stringify(misses(r))} pending=${JSON.stringify(pending(r))} invalid=${JSON.stringify(invalid(r))} reads=${JSON.stringify(reads(r))}`;
console.log(`   bad:   ${summary(bad.result)}`);
console.log(`   clean: ${summary(clean.result)}`);
console.log(`   wrong: ${summary(wrong.result)}`);
const trail = (events: string): string => events.split("\n")
  .filter((l) => /"type":"(equipment_fill[a-z_]*|equipment_unheld_[a-z]*|equipment_not_held_at_exit|compute_settled|required_never_filled|fills_did_not_hold|page_exit_[a-z_]*|validation_error_after_fill|computed_total_stale_at_exit)"/.test(l))
  .map((l) => `      ${l.replace(/^\{"t":"[^"]*","ms":\d+,/, "{").slice(0, 220)}`).join("\n");
console.log(`   bad run trail:\n${trail(bad.events)}`);
// The middle page: where the Generation System step was walked (the page the model miss is on).
const middle = (r: LearnResult): number => Math.min(...invalid(r).concat(pending(r)).map(pageOf).filter(Number.isFinite));

// Precondition: the fixture reproduces the live shape — the walk reached review, and the model
// fill was seen not to hold (the very event the live run recorded and nothing read).
check("bad portal: the walk reaches the review step (so only these signals stand between it and trust)",
  bad.result.reachedReview === true && bad.step === 4, `reachedReview=${bad.result.reachedReview} step=${bad.step}`);
check("bad portal: the run records equipment_fill_not_held for the inverter model (the live event)",
  /"type":"equipment_fill_not_held"[^\n]*inverterModel/.test(bad.events), bad.events.split("\n").filter((l) => /equipment_fill/.test(l)).join("\n").slice(0, 600));

// 1. The unheld equipment value is a required field left blank.
check("bad portal: the inverter Model is a required field left blank (requiredFieldMisses)",
  misses(bad.result).some((m) => /\bModel\b/i.test(m) && /inverter/i.test(m)),
  `requiredFieldMisses=${JSON.stringify(misses(bad.result))} — an equipment value the portal refused, with no required marker, reaches no gate`);
// 2. The rating still to be recalculated when the walk left the middle page.
check("bad portal: the middle page was left with its rating still to be recalculated (trustEvidence computePending)",
  pending(bad.result).some((l) => /needs to be recalculated/i.test(l) && pageOf(l) < bad.result.pageCount),
  `pending=${JSON.stringify(pending(bad.result))} pageCount=${bad.result.pageCount}`);
// 3. The portal's own validation line, still showing on exit — read by the one validation reader.
check("bad portal: the middle page was left showing the model's validation error (trustEvidence validationErrors)",
  invalid(bad.result).some((l) => /Model/i.test(l) && /this field is required/i.test(l) && pageOf(l) < bad.result.pageCount),
  `validationErrors=${JSON.stringify(invalid(bad.result))}`);
check("bad portal: the middle page is on record as READ, and no page as unread",
  !!reads(bad.result) && reads(bad.result)!.read.includes(middle(bad.result)) && reads(bad.result)!.unread.length === 0,
  `pageExitReads=${JSON.stringify(reads(bad.result))} middle=${middle(bad.result)}`);
check("bad portal: the run's message tells the operator, not just the gate",
  /recalculated/i.test(bad.result.message) && /validation/i.test(bad.result.message),
  bad.result.message.slice(0, 500));

// MUST CATCH — a pick that landed on ANOTHER value is not a value the portal kept.
check("wrong portal: the walk reaches review", wrong.result.reachedReview === true && wrong.step === 4, `reachedReview=${wrong.result.reachedReview} step=${wrong.step}`);
check("wrong portal: the run records equipment_fill_not_held for the inverter model",
  /"type":"equipment_fill_not_held"[^\n]*inverterModel/.test(wrong.events), wrong.events.split("\n").filter((l) => /equipment_fill/.test(l)).join("\n").slice(0, 600));
check("wrong portal: the inverter Model holding ANOTHER model is still a required field not kept (requiredFieldMisses)",
  misses(wrong.result).some((m) => /\bModel\b/i.test(m) && /inverter/i.test(m)),
  `requiredFieldMisses=${JSON.stringify(misses(wrong.result))} — a non-blank read-back that is not the project's value cleared the miss`);

// MUST PASS — a complete fill is not refused.
check("clean portal: the walk reaches review", clean.result.reachedReview === true && clean.step === 4, `reachedReview=${clean.result.reachedReview} step=${clean.step}`);
check("clean portal: no required field reported blank", misses(clean.result).length === 0, JSON.stringify(misses(clean.result)));
check("clean portal: no page left with a rating to recalculate", pending(clean.result).length === 0, JSON.stringify(pending(clean.result)));
check("clean portal: no page left showing a validation error", invalid(clean.result).length === 0, JSON.stringify(invalid(clean.result)));
check("clean portal: nothing on any page the gate would block on", blockingEvidence(clean.result) === 0, JSON.stringify(ev(clean.result)));
check("clean portal: every form page was READ (pages 1-3; the review step has no form field), none unread",
  !!reads(clean.result) && reads(clean.result)!.unread.length === 0 && reads(clean.result)!.read.length >= 3,
  `pageExitReads=${JSON.stringify(reads(clean.result))} pageCount=${clean.result.pageCount}`);

await browser.close();
server.close();
for (const d of runDirs) fs.rmSync(d, { recursive: true, force: true });
console.log(failures === 0 ? "learnExitSweep.dom.smoke: PASS" : `learnExitSweep.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
