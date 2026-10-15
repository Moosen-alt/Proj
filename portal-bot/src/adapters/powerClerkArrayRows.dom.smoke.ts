// SIX ROOF PLANES, SIX ROWS — EACH ROW HOLDS ITS OWN ARRAY (issue #339).
//
// Live PacifiCorp PowerClerk NEM replay, 2026-10-14 (a project with six PV arrays: 9 @ 172°,
// 6 @ 82°, 4 @ 82°, 7 @ 262°, 10 @ 262°, 3 @ 262°, all at 24°). The replay added the rows, but
// every pass wrote into ROW 1 — first roof #5's values, later roof #2's quantity beside roof
// #1's azimuth — while rows 2–6 stayed on an empty Qty and "Please select…". The read-back
// only looked for placeholders, so a row 1 holding another array's numbers passed it.
//
// Why: each pass re-targeted the recorded controls by shifting a PAGE-WIDE nth. On this tenant
// a fresh row renders ONLY its Qty; the row's Manufacturer appears after its Qty is committed,
// its Model ~600 ms after a manufacturer is chosen, and Tilt / Azimuth / Tracking after the
// model. So the shifted nth for a row's later controls does not exist yet, and the write falls
// back to a match that does — row 1, or the inverter's identically-labelled Manufacturer.
//
// This fixture models exactly that: per-render volatile ids (pcInputBase…, renumbered on every
// server render), bare "Manufacturer"/"Model" labels shared with the inverter above the rows,
// commit-on-blur autosave that is DEBOUNCED (nothing is on the wire for ~900 ms after a blur,
// so "wait until the page is quiet" returns before the row's next controls render), a server
// re-render after a row's Qty and Model save, the ~600 ms model cascade, and "Add Array"
// flushing the save queue and re-rendering the section from committed state. It asserts the
// COMMITTED (server) state, because a value the portal never saved is a value the application
// does not have.
//
//   MUST PASS  — the six-array project ends with six rows, each holding ITS OWN qty / make /
//                model / tilt / azimuth; the inverter keeps its own make and model.
//   MUST PASS  — a row the portal keeps rewriting (it stores another array's azimuth) is
//                repaired once and then STOPS the run, naming the row and its expected values.
//
//   npx tsx portal-bot/src/adapters/powerClerkArrayRows.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// Variants (review 1 of #343): `adder` "inside" (the section's own Add Array + Clone System, as
// PacifiCorp lays it out), "toolbar" (Add Array in a toolbar OUTSIDE the section), or "none" (no
// way to add a row); `rowInverter` renders a per-row microinverter Manufacturer/Model BEFORE the
// module's inside each row.
const page = (stickyRow: number, adder: "inside" | "toolbar" | "none" = "inside", rowInverter = false): string => `<!doctype html><html><head><meta charset="utf-8">
<style>body{font:14px sans-serif} .pv-array{border:1px solid #bbb;margin:8px 0;padding:8px} label{margin:0 4px 0 12px} input,select{min-width:9em}</style>
</head><body>
  <h2>Generation System Information</h2>
  <div id="section"></div>
  ${adder === "toolbar" ? '<div class="toolbar"><button id="toolbaradd" type="button">Add Array</button></div>' : ""}
  <script>
    var MAKES = ["Altenergy Power System", "Znshine PV-Tech", "Tesla"];
    var MODELS = {
      "Altenergy Power System": ["0.8 kW (Model DS3-L {240V} [SI1])", "0.8 kW (Model DS3-LV {120V} [SI1])"],
      "Znshine PV-Tech": ["440W (Model ZXM7-UHLDD108-440/N)", "430W (Model ZXM7-UHLDD108-430/N)"]
    };
    var STICKY = ${stickyRow}; // 1-based row whose azimuth the portal keeps rewriting; 0 = none
    var ADDER = "${adder}";
    var ROWINV = ${rowInverter ? "true" : "false"};
    var server = { rows: [{}], invMfr: "", invModel: "" };
    var idn = 50; // PowerClerk's per-render ids: renumbered from the top on every server render
    function nid() { return 'pcInputBase' + (idn++); }
    function lab(id, text) { return '<label for="' + id + '">' + text + '</label>'; }
    function sel(id, options, current, key) {
      var h = '<select id="' + id + '" data-k="' + key + '"><option>Please select...</option>';
      for (var i = 0; i < options.length; i++) {
        h += '<option' + (options[i] === current ? ' selected' : '') + '>' + options[i] + '</option>';
      }
      return h + '</select>';
    }
    function render() {
      idn = 50;
      var a = nid(), b = nid();
      var h = '<div class="inverter"><h3>Inverter</h3>'
        + lab(a, 'Manufacturer') + sel(a, MAKES, server.invMfr, 'invMfr')
        + lab(b, 'Model') + sel(b, server.invMfr ? MODELS[server.invMfr] || [] : [], server.invModel, 'invModel')
        + '</div>';
      for (var i = 0; i < server.rows.length; i++) {
        var r = server.rows[i];
        h += '<div class="pv-array" data-row="' + i + '"><div class="pv-head">PV Array <a href="#" class="del">Delete Array</a></div>';
        var q = nid();
        h += lab(q, 'Qty') + '<input id="' + q + '" data-k="qty" value="' + (r.qty || '') + '">';
        // A FRESH ROW RENDERS ONLY ITS QTY. The rest arrives in sequence, each from server state.
        if (r.qty && ROWINV) {
          // A per-row MICROINVERTER pair, before the module's, with the same bare labels.
          var ri = nid(), rm = nid();
          h += lab(ri, 'Manufacturer') + sel(ri, MAKES, r.rinvMfr, 'rinvMfr')
            + lab(rm, 'Model') + sel(rm, MODELS['Altenergy Power System'], r.rinvModel, 'rinvModel');
        }
        if (r.qty) { var m = nid(); h += lab(m, 'Manufacturer') + sel(m, MAKES, r.mfr, 'mfr'); }
        if (r.mfr) { var md = nid(); h += lab(md, 'Model') + sel(md, MODELS[r.mfr] || [], r.model, 'model'); }
        if (r.model) {
          var t = nid(), az = nid(), tr = nid();
          h += lab(t, 'Tilt') + '<input id="' + t + '" data-k="tilt" value="' + (r.tilt || '') + '">'
            + lab(az, 'Azimuth') + '<input id="' + az + '" data-k="azi" value="' + (r.azi || '') + '">'
            + lab(tr, 'Tracking') + sel(tr, ['Fixed', 'Single-Axis', 'Dual-Axis'], r.track || 'Fixed', 'track');
        }
        h += '</div>';
      }
      // Section-level controls INSIDE the section, below the rows, as PowerClerk lays them out.
      if (ADDER === 'inside') h += '<button id="addarray" type="button">Add Array</button><button id="clonesys" type="button">Clone System</button>';
      document.getElementById('section').innerHTML = h;
      wire();
    }
    function rowOf(el) { var c = el.closest('.pv-array'); return c ? server.rows[Number(c.getAttribute('data-row'))] : null; }
    function valueOf(el) {
      if (el.tagName === 'SELECT') return el.selectedIndex > 0 ? el.options[el.selectedIndex].textContent : '';
      return el.value;
    }
    // PER-FIELD AUTOSAVE, DEBOUNCED. A blur queues the save; nothing is on the wire during the
    // debounce, so a "wait until the page is quiet" returns BEFORE the save lands and the row's
    // next controls render. The save itself then re-renders the section (fresh ids) when it
    // unlocks the row's next controls. "Add Array" flushes the queue first, as a request queue
    // would, then re-renders from committed state.
    var pending = [];
    function flush() { while (pending.length) { var j = pending.shift(); clearTimeout(j.t); j.run(); } }
    function commit(el) {
      var key = el.getAttribute('data-k');
      var val = valueOf(el);
      var row = rowOf(el);
      var job = { run: function () {
        if (key === 'invMfr') { server.invMfr = val; return; }
        if (key === 'invModel') { server.invModel = val; return; }
        if (!row) return;
        var idx = server.rows.indexOf(row) + 1;
        var hadQty = !!row.qty, hadModel = !!row.model;
        if (key === 'azi' && idx === STICKY && val) {
          // THE PORTAL KEEPS ANOTHER ARRAY'S VALUE: it stores row 1's azimuth and shows it.
          row.azi = server.rows[0].azi || '172';
          render();
          return;
        }
        row[key] = val;
        if ((key === 'qty' && val && !hadQty) || (key === 'model' && val && !hadModel)) render();
      } };
      job.t = setTimeout(function () { pending.splice(pending.indexOf(job), 1); job.run(); }, 900);
      pending.push(job);
    }
    function wire() {
      var els = document.querySelectorAll('#section input, #section select');
      for (var i = 0; i < els.length; i++) {
        (function (el) {
          el.addEventListener('blur', function () { commit(el); }); // per-field autosave, on blur only
          var key = el.getAttribute('data-k');
          if (key === 'mfr' || key === 'invMfr') {
            el.addEventListener('change', function () {
              var make = valueOf(el);
              // THE CASCADE: the model list loads ~600 ms after the manufacturer changes.
              setTimeout(function () {
                var opts = MODELS[make] || [];
                if (key === 'invMfr') {
                  var im = document.querySelector('[data-k="invModel"]');
                  if (im) { var h = '<option>Please select...</option>'; for (var k = 0; k < opts.length; k++) h += '<option>' + opts[k] + '</option>'; im.innerHTML = h; }
                  return;
                }
                var c = el.closest('.pv-array');
                if (!c) return;
                var existing = c.querySelector('[data-k="model"]');
                if (existing) {
                  var h2 = '<option>Please select...</option>'; for (var j = 0; j < opts.length; j++) h2 += '<option>' + opts[j] + '</option>';
                  existing.innerHTML = h2;
                  return;
                }
                var id = nid();
                el.insertAdjacentHTML('afterend', lab(id, 'Model') + sel(id, opts, '', 'model'));
                var added = c.querySelector('[data-k="model"]');
                if (added) added.addEventListener('blur', function () { commit(added); });
              }, 600);
            });
          }
        })(els[i]);
      }
      var add = document.getElementById('addarray');
      if (add) add.addEventListener('click', addRow);
      var cs = document.getElementById('clonesys');
      if (cs) cs.addEventListener('click', function () {
        window.__clonedSystem = (window.__clonedSystem || 0) + 1;
      });
    }
    function addRow() {
      // The ADD waits for queued saves, posts; the server gains an empty row; the section
      // re-renders from COMMITTED state.
      flush();
      server.rows.push({});
      render();
    }
    window.__server = server;
    var tb = document.getElementById('toolbaradd');
    if (tb) tb.addEventListener('click', addRow);
    render();
  </script>
</body></html>`;

const server = http.createServer((q, r) => {
  const url = String(q.url ?? "");
  const sticky = /sticky=(\d+)/.exec(url);
  const adder = /adder=(toolbar|none)/.exec(url);
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(page(sticky ? Number(sticky[1]) : 0, adder ? adder[1] as "toolbar" | "none" : "inside", /rowinv=1/.test(url)));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

// The recipe as a learn records it on ONE row: volatile learn-time ids as primaries, bare
// labels ranked against the learn page as fallbacks (inverter Manufacturer/Model rank 0, the
// row's rank 1), and the inverter pair recorded INSIDE the array block (PacifiCorp's shape).
// `fingerprints` (review 1 of #343, Helm's probe): the learn-time element ids a learner also
// records — here Qty carries row 1's id and the module make carries the INVERTER Manufacturer's,
// because on a render-counter portal that is what those ids name mid-run.
const recipe = (url: string, opts: { fingerprints?: boolean } = {}): PortalRecipe => ({
  id: "pc339", scopeType: "utility", profileKey: "or||pacific-power", state: "OR", ahj: "", utility: "Pacific Power",
  portalPlatform: "powerclerk", portalUrl: url, status: "complete", version: 1,
  steps: [
    { action: "fill", phase: "fill", selector: { css: "#pcInputBase52", fallbacks: [{ label: "Qty", nth: 0 }] }, field: "array1ModuleQuantity", note: "PV Array Qty",
      ...(opts.fingerprints ? { fingerprint: { id: "pcInputBase52" } } : {}) },
    { action: "select", phase: "fill", selector: { css: "#pcInputBase50", fallbacks: [{ label: "Manufacturer", nth: 0 }] }, field: "inverterMake", note: "Manufacturer" },
    { action: "select", phase: "fill", selector: { css: "#pcInputBase51", fallbacks: [{ label: "Model", nth: 0 }] }, field: "inverterModel", note: "Model" },
    { action: "select", phase: "fill", selector: { css: "#pcInputBase53", fallbacks: [{ label: "Manufacturer", nth: 1 }] }, field: "moduleMake", note: "Manufacturer",
      ...(opts.fingerprints ? { fingerprint: { id: "pcInputBase50" } } : {}) },
    { action: "select", phase: "fill", selector: { css: "#pcInputBase54", fallbacks: [{ label: "Model", nth: 1 }] }, field: "moduleModel", note: "Model" },
    { action: "fill", phase: "fill", selector: { css: "#pcInputBase55", fallbacks: [{ label: "Tilt", nth: 0 }] }, field: "array1Tilt", note: "Tilt" },
    { action: "fill", phase: "fill", selector: { css: "#pcInputBase56", fallbacks: [{ label: "Azimuth", nth: 0 }] }, field: "array1Azimuth", note: "Azimuth" },
  ] as RecipeStep[],
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe);

// The live project's arrays (synthetic project; the numbers are the plan set's geometry).
const ARRAYS = [
  { qty: "9", azi: "172" }, { qty: "6", azi: "82" }, { qty: "4", azi: "82" },
  { qty: "7", azi: "262" }, { qty: "10", azi: "262" }, { qty: "3", azi: "262" },
];
const MAKE = "Znshine PV-Tech";
const MODEL = "440W (Model ZXM7-UHLDD108-440/N)";
const FIELDS: Record<string, string> = {
  totalModuleQuantity: "39",
  moduleMake: MAKE, moduleModel: MODEL,
  inverterMake: "Altenergy Power System", inverterModel: "0.8 kW (Model DS3-L {240V} [SI1])",
};
ARRAYS.forEach((a, i) => {
  FIELDS[`array${i + 1}ModuleQuantity`] = a.qty;
  FIELDS[`array${i + 1}Tilt`] = "24";
  FIELDS[`array${i + 1}Azimuth`] = a.azi;
});

type Committed = { rows: Array<Record<string, string>>; invMfr?: string; invModel?: string };
const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

const run = async (path: string, fields: Record<string, string> = FIELDS, recipeOpts: { fingerprints?: boolean } = {}) => {
  const p = await context.newPage();
  await p.goto(`${base}${path}`);
  const a = new RecipeAdapter(recipe(`${base}${path}`, recipeOpts), fields, {}, { autoSubmit: false });
  (a as unknown as { page: unknown }).page = p;
  const r = await a.fillApplication({} as never);
  // Let the last debounced autosaves land, as they would before a person looks at the page.
  await p.waitForTimeout(1500);
  const committed = await p.evaluate(() => (window as unknown as { __server: Committed }).__server);
  const cloned = await p.evaluate(() => (window as unknown as { __clonedSystem?: number }).__clonedSystem ?? 0);
  const data = (r as unknown as { data?: { driftWarnings?: string[]; requiredStillEmpty?: string[] } }).data ?? {};
  return { r, committed, cloned, warnings: (data.driftWarnings ?? []).join(" | "), blanks: (data.requiredStillEmpty ?? []).join(" | ") };
};

// ===========================================================================================
// 1) MUST PASS — six arrays, six rows, every row its own.
// ===========================================================================================
console.log("\n[1] six PV arrays on a PowerClerk section with the fresh-row cascade");
const w = await run("/");
const summary = JSON.stringify(w.committed.rows.map((r) => [r.qty, r.mfr ? "make" : "-", r.model ? "model" : "-", r.tilt, r.azi]));
check("one row per array: six rows", w.committed.rows.length === 6, `rows=${summary}`);
ARRAYS.forEach((a, i) => {
  const row = w.committed.rows[i] ?? {};
  check(`row ${i + 1} holds ITS OWN array: Qty ${a.qty}, ${MAKE}, ${MODEL.slice(0, 18)}…, tilt 24, azimuth ${a.azi}`,
    row.qty === a.qty && row.mfr === MAKE && row.model === MODEL && row.tilt === "24" && row.azi === a.azi,
    `row ${i + 1} committed ${JSON.stringify(row)}; all rows ${summary}`);
});
check("the inverter keeps ITS OWN make and model — no array pass wrote into it",
  w.committed.invMfr === "Altenergy Power System" && /DS3-L \{240V\}/.test(String(w.committed.invModel ?? "")),
  `inverter ${JSON.stringify({ mfr: w.committed.invMfr, model: w.committed.invModel })}`);
check("the whole system was never cloned", w.cloned === 0, `Clone System clicked ${w.cloned} time(s)`);
check("the run completes, with no row reported as not holding",
  w.r.ok === true && !/did not hold|do not hold/i.test(`${w.warnings} ${w.blanks}`),
  `ok=${w.r.ok} message=${String(w.r.message ?? "").slice(0, 240)} blanks=${w.blanks.slice(0, 240)}`);

// ===========================================================================================
// 2) MUST PASS — a row that will not hold its own value stops the run, named.
// ===========================================================================================
console.log("\n[2] the portal keeps another array's azimuth in row 3: repaired once, then the run STOPS");
// The first three arrays are enough to put a sticky row 3 between rows that hold.
const FIELDS3: Record<string, string> = { ...FIELDS, totalModuleQuantity: "19" };
for (const i of [4, 5, 6]) for (const k of ["ModuleQuantity", "Tilt", "Azimuth"]) delete FIELDS3[`array${i}${k}`];
const s = await run("/?sticky=3", FIELDS3);
const msg = String(s.r.message ?? "");
check("the run does NOT finish as if the rows were right", s.r.ok === false, `ok=${s.r.ok} message=${msg.slice(0, 240)}`);
check("the stop names row 3 and its expected azimuth (82)", /row 3\b/i.test(msg) && /82/.test(msg), msg.slice(0, 400));
check("...and does not blame the rows that hold", !/row (1|2|4|5|6)\b/i.test(msg), msg.slice(0, 400));
check("the repair was attempted once before stopping", /row 3/i.test(s.warnings) && /re-?fill|repair|re-running/i.test(s.warnings), s.warnings.slice(0, 400));

// Two arrays for the review-1 shapes: different orientations, and the same orientation (merge).
const TWO: Record<string, string> = {
  totalModuleQuantity: "15", moduleMake: MAKE, moduleModel: MODEL,
  inverterMake: "Altenergy Power System", inverterModel: "0.8 kW (Model DS3-L {240V} [SI1])",
  array1ModuleQuantity: "9", array1Tilt: "24", array1Azimuth: "172",
  array2ModuleQuantity: "6", array2Tilt: "24", array2Azimuth: "82",
};
const TWO_SAME: Record<string, string> = { ...TWO, array2Azimuth: "172" };
const inverterKept = (c: Committed): boolean =>
  c.invMfr === "Altenergy Power System" && /DS3-L \{240V\}/.test(String(c.invModel ?? ""));
const rowHolds = (row: Record<string, string> | undefined, qty: string, azi: string): boolean =>
  !!row && row.qty === qty && row.mfr === MAKE && row.model === MODEL && row.tilt === "24" && row.azi === azi;

// ===========================================================================================
// 3) REVIEW 1 (a) — a row step's learn-time FINGERPRINT id names the inverter's Manufacturer
//    (and the Qty's names row 1's Qty). A page-wide re-anchor by that id writes the module make
//    into the INVERTER and array 2's Qty into row 1 — owner observation 3 on #339. Inside a row,
//    a re-anchor may only land inside that row.
// ===========================================================================================
console.log("\n[3] a row step whose fingerprint id names the inverter's Manufacturer");
const fa = await run("/", TWO, { fingerprints: true });
check("the inverter keeps ITS OWN make and model", inverterKept(fa.committed),
  JSON.stringify({ mfr: fa.committed.invMfr, model: fa.committed.invModel }));
check("row 1 keeps ITS OWN Qty (9), not array 2's", fa.committed.rows[0]?.qty === "9", JSON.stringify(fa.committed.rows));
check("row 2 holds ITS OWN array (6 @ 82)", rowHolds(fa.committed.rows[1], "6", "82"), JSON.stringify(fa.committed.rows));

// ===========================================================================================
// 4) REVIEW 1 (b) — ONE row on the page, and nothing in the section to stop the row's climb:
//    the adder sits in a toolbar OUTSIDE the section, or there is no adder at all. "The row"
//    must still be the row, never the whole section with the inverter in it.
// ===========================================================================================
console.log("\n[4] one row on the page, the adder outside the section (and none at all)");
const tb = await run("/?adder=toolbar", TWO);
check("toolbar adder: the inverter keeps ITS OWN make and model", inverterKept(tb.committed),
  JSON.stringify({ mfr: tb.committed.invMfr, model: tb.committed.invModel }));
check("toolbar adder: both rows hold their own arrays",
  rowHolds(tb.committed.rows[0], "9", "172") && rowHolds(tb.committed.rows[1], "6", "82"), JSON.stringify(tb.committed.rows));
const na = await run("/?adder=none", TWO_SAME);
check("no adder: the inverter keeps ITS OWN make and model", inverterKept(na.committed),
  JSON.stringify({ mfr: na.committed.invMfr, model: na.committed.invModel }));
check("no adder: the same-orientation fallback files 9 + 6 = 15 into row 1, stated",
  rowHolds(na.committed.rows[0], "15", "172") && /holds arrays 1 \+ 2/.test(na.warnings),
  `rows=${JSON.stringify(na.committed.rows)} warnings=${na.warnings.slice(0, 300)}`);

// ===========================================================================================
// 5) REVIEW 1 (c) — a per-row MICROINVERTER Manufacturer/Model before the module's, inside each
//    row. "Manufacturer" is ambiguous in the row; it is never guessed at, and the run must not
//    finish as if row 1 held its module.
// ===========================================================================================
console.log("\n[5] a per-row inverter Manufacturer/Model before the module's");
const ri = await run("/?rowinv=1", TWO);
const riMsg = String(ri.r.message ?? "");
check("the run does NOT finish as if row 1 were right", ri.r.ok === false,
  `ok=${ri.r.ok} row1=${JSON.stringify(ri.committed.rows[0])} message=${riMsg.slice(0, 240)}`);
check("...and the stop says why: the label matches two controls on the row", /matches 2 controls on the row/i.test(riMsg), riMsg.slice(0, 400));
check("...and the TOP inverter keeps its own make and model", inverterKept(ri.committed),
  JSON.stringify({ mfr: ri.committed.invMfr, model: ri.committed.invModel }));

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} powerClerkArrayRows.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log("\nAll powerClerkArrayRows.dom.smoke checks passed.");
process.exit(0);
