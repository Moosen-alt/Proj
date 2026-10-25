// THE CAPTURED POWERCLERK ARRAY-ROW MARKUP, AS A FIXTURE (issue #347) — shared by
// powerClerkRowHooks.dom.smoke.ts (six arrays to review), powerClerkRowHooksStop.dom.smoke.ts
// (rows the portal will not keep: the stop, its capture and its message), and the #348 review's
// shapes: powerClerkRowHiddenFace / powerClerkRowModelRewrite / powerClerkRowMicroinverter
// .dom.smoke.ts (a neighbour's text or control is never the row's). One copy of the markup, so
// the smokes cannot drift apart. Not a smoke itself (not discovered by the runners).
//
// Source: data/learn-runs/2026-09-28_16-05-17_pacificorp_0upf, page p009 (equipment only, no
// customer data; the learner's own data-al-* marks stripped): the delete button inside the
// legend, the row's own Clone, Add Array / Calculate outside the rows, per-render pcInputBase…
// ids (row 1's Qty is #pcInputBase56 at learn time, as captured), a fresh row that renders only
// Qty until its Qty saves, the make/model filtered selects (a hidden labelled input + a visible
// face + a teleported listbox), the model's cascade from the make, Tilt / Azimuth / Tracking after
// the model saves, a debounced per-field autosave, and a review page.
//
// VARIANTS (the #348 review's shapes), chosen by the URL's query. With no flag the page is the
// captured markup, behaving exactly as before.
import http from "node:http";
import type { Browser, BrowserContext } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

export type RowVariant = {
  /** ?rewrite=1 — the portal keeps "0" for every row's azimuth. */
  rewriteAzimuth?: boolean;
  /** ?rewriteModel=1 — the portal saves 430W when 440W is picked, and re-renders. */
  rewriteModel?: boolean;
  /** ?emptyValue=1 — a row's hidden combobox inputs never carry a value (only the face shows it). */
  emptyComboValue?: boolean;
  /** ?hideModelFace=1 — a row's Model face is display:none once the row holds a model, until opened. */
  hideSetModelFace?: boolean;
  /** ?modelLabel=1 — a visible <label class="control-label">Model</label> inside the model's hook div. */
  modelLabel?: boolean;
  /** ?micro=1 — a per-row microinverter Manufacturer / Model (Enphase / QT2) BEFORE the module's,
   *  whose make list also carries the module makes; once Qty saves, the whole row renders. */
  rowMicro?: boolean;
  /** ?noHooks=1 — no data-test-role on the row's controls (the ROW_FIELD_HOOKS roles). */
  noRowHooks?: boolean;
  /** ?moduleFace=unknown — the module make/model faces use classes the face walk does not know. */
  moduleFaceUnknown?: boolean;
};

export const variantOf = (url: string): RowVariant => {
  const q = new URL(url, "http://fixture.invalid").searchParams;
  return {
    rewriteAzimuth: q.get("rewrite") === "1",
    rewriteModel: q.get("rewriteModel") === "1",
    emptyComboValue: q.get("emptyValue") === "1",
    hideSetModelFace: q.get("hideModelFace") === "1",
    modelLabel: q.get("modelLabel") === "1",
    rowMicro: q.get("micro") === "1",
    noRowHooks: q.get("noHooks") === "1",
    moduleFaceUnknown: q.get("moduleFace") === "unknown",
  };
};

const flag = (on: boolean | undefined): string => (on ? "true" : "false");

export const page = (v: RowVariant = {}): string => `<!doctype html><html><head><meta charset="utf-8">
<style>
  body{font:14px sans-serif} fieldset{border:1px solid #bbb;margin:8px 0;padding:8px}
  .visually-hidden{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
  .form-select,.fs-face{display:inline-block;min-width:16em;border:1px solid #888;padding:3px;cursor:pointer}
  [role=listbox]{border:1px solid #444;background:#fff;list-style:none;margin:0;padding:2px}
  [role=option]{padding:2px 4px;cursor:pointer}
</style></head><body>
  <h2>Generation System Information</h2>
  <div id="section"></div>
  <button id="next" type="button">Next</button>
  <div id="poppers"></div>
  <script>
    var REWRITE_AZIMUTH = ${flag(v.rewriteAzimuth)}; // the portal keeps "0" for every row's azimuth
    var REWRITE_MODEL = ${flag(v.rewriteModel)}, EMPTY_VALUE = ${flag(v.emptyComboValue)}, HIDE_MODEL_FACE = ${flag(v.hideSetModelFace)};
    var MODEL_LABEL = ${flag(v.modelLabel)}, MICRO = ${flag(v.rowMicro)}, NO_HOOKS = ${flag(v.noRowHooks)}, MODULE_FACE_UNKNOWN = ${flag(v.moduleFaceUnknown)};
    var MODULE_MAKES = ["Hanwha Q CELLS", "Znshine PV-Tech", "REC Solar"];
    var INV_MAKES = ["Altenergy Power System", "Enphase Energy Inc."];
    var MICRO_MAKES = ["Enphase Energy Inc.", "Altenergy Power System"].concat(MODULE_MAKES); // also carries the module makes
    var MICRO_MAKE = ${JSON.stringify(MICRO_MAKE)}, MICRO_MODEL = ${JSON.stringify(MICRO_MODEL)};
    var PICKED_440 = "440W (Model ZXM7-UHLDD108-440/N)", SAVED_430 = "430W (Model ZXM7-UHLDD108-430/N)";
    function newRow() { return MICRO ? { microMfr: MICRO_MAKE, microModel: MICRO_MODEL } : {}; }
    function hook(role) { return NO_HOOKS ? '' : ' data-test-role="' + role + '"'; }
    var MODELS = {
      "Znshine PV-Tech": ["430W (Model ZXM7-UHLDD108-430/N)", "440W (Model ZXM7-UHLDD108-440/N)"],
      "Hanwha Q CELLS": ["Q.PEAK DUO BLK ML-G10+ 400"],
      "REC Solar": ["REC400AA"],
      "Altenergy Power System": ["0.8 kW (Model DS3-L {240V} [SI1])", "0.8 kW (Model DS3-LV {120V} [SI1])"],
      "Enphase Energy Inc.": ["0.96 kW (Model QT2 {240V})"]
    };
    var server = { rows: [newRow()], invMfr: "", invModel: "" };
    var idn = 53; // per-render ids, renumbered from the top: row 1's Qty is #pcInputBase56 on a learn page
    var lists = 0;
    function nid() { return 'pcInputBase' + (idn++); }
    // The captured filtered-select: a hidden, readonly, labelled combobox input; an aria-hidden
    // visible face; the options in a listbox TELEPORTED to the page's popper container.
    function combo(role, label, current, key) {
      var id = nid(), list = 'filtered-select-options-list' + (++lists);
      var ul = document.createElement('ul');
      ul.id = list; ul.setAttribute('role', 'listbox'); ul.hidden = true;
      ul.setAttribute('data-for', id); ul.setAttribute('data-k', key);
      document.getElementById('poppers').appendChild(ul);
      // The variants touch only a ROW's comboboxes (module make/model, the per-row micro's), never
      // the system inverter's.
      var rowKey = key !== 'invMfr' && key !== 'invModel';
      var unknownFace = MODULE_FACE_UNKNOWN && (key === 'mfr' || key === 'model');
      return '<div data-test-popper-id="filtered-select-options-popper' + lists + '"' + (rowKey ? hook(role) : ' data-test-role="' + role + '"') + ' display-label="false">'
        + (MODEL_LABEL && key === 'model' ? '<label class="control-label">Model</label>' : '')
        + '<div class="position-relative wrapper">'
        + '<input id="' + id + '" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="' + list + '" aria-invalid="false" aria-label="' + label + '" readonly tabindex="0" class="visually-hidden" data-k="' + key + '" value="' + (rowKey && EMPTY_VALUE ? '' : (current || '')) + '">'
        + '<div aria-hidden="true"' + (HIDE_MODEL_FACE && key === 'model' && current ? ' style="display:none"' : '') + '><div class="' + (unknownFace ? 'fs-face' : 'form-select') + '" data-test-role="filteredSelectField" disabled="false">'
        + '<div class="' + (unknownFace ? 'fs-text' : 'selected-display text-nowrap text-truncate') + '" data-test-role="selected-item-text">' + (current || 'Please select...') + '</div>'
        + '</div></div></div></div>';
    }
    function render() {
      idn = 53; lists = 0;
      document.getElementById('poppers').innerHTML = '';
      var q0 = nid();
      var h = '<fieldset data-test-role="inverter-div"><legend class="h6">Inverter <button no-interact type="button">Clone System</button></legend>'
        + '<div class="input-group"><span class="input-group-text">Qty</span><input id="' + q0 + '" placeholder="Qty" data-test-role="inverter-quantity" aria-label="Qty" value="2"></div>'
        + combo('inverter-manufacturer-select', 'Manufacturer', server.invMfr, 'invMfr')
        + combo('inverter-model-select', 'Model', server.invModel, 'invModel')
        + '</fieldset>';
      for (var i = 0; i < server.rows.length; i++) {
        var r = server.rows[i];
        h += '<fieldset class="mt-2 mb-3" data-test-role="pv-array-div" id="pvSystemPvModule' + (i + 1) + '" data-row="' + i + '">'
          + '<legend class="h6 mb-0"><span><div class="mb-2"><span>PV Array</span><button no-interact class="btn-link btn" data-test-role="delete-array" type="button">Delete Array</button></div></span></legend>'
          + '<div class="mb-2"><div class="row gx-3"><div class="col-2 mb-0"><div class="input-group"><span class="input-group-text">Qty</span>';
        var q = nid();
        h += '<input class="form-control" type="text" id="' + q + '" placeholder="Qty" tabindex="0"' + hook('pv-array-quantity') + ' aria-label="Qty" inputmode="numeric" data-k="qty" value="' + (r.qty || '') + '"></div></div>';
        // A FRESH ROW RENDERS ONLY ITS QTY; the rest arrives in sequence, each from server state.
        // (MICRO: once Qty saves the whole row renders, the per-row micro's make/model FIRST.)
        if (r.qty) {
          if (MICRO) {
            h += '<div class="col-2 mb-0">' + combo('pv-array-micro-manufacturer-select', 'Manufacturer', r.microMfr, 'microMfr')
              + combo('pv-array-micro-model-select', 'Model', r.microModel, 'microModel') + '</div>';
          }
          h += '<div class="col-3 mb-0">' + combo('pv-array-manufacturer-select', 'Manufacturer', r.mfr, 'mfr') + '</div>';
          if (r.mfr || MICRO) h += '<div class="col-4">' + combo('pv-array-model-select', 'Model', r.model, 'model') + '</div>';
          h += '<div class="col-auto"><button no-interact class="btn-link btn" type="button"><div class="ms-1">Clone</div></button></div>';
        }
        h += '</div></div>';
        if (r.model || (MICRO && r.qty)) {
          var t = nid(), az = nid(), tr = nid();
          h += '<div class="row gx-3 mb-2">'
            + '<div class="col-1"><label for="' + t + '" class="d-inline" data-test-role="input-label">Tilt</label><input class="form-control" type="text" id="' + t + '"' + hook('tilt-input') + ' inputmode="numeric" no-interact data-k="tilt" value="' + (r.tilt || '') + '"></div>'
            + '<div class="col-1"><label for="' + az + '" class="d-inline" data-test-role="input-label">Azimuth</label><input class="form-control" type="text" id="' + az + '"' + hook('azimuth-input') + ' inputmode="numeric" no-interact data-k="azi" value="' + (r.azi || '') + '"></div>'
            + '<div class="col-3"><label for="' + tr + '" class="d-inline" data-test-role="input-label">Tracking</label><select class="form-select" id="' + tr + '"' + hook('tracking-select') + ' no-interact data-k="track">'
            + '<option value="Fixed"' + ((r.track || 'Fixed') === 'Fixed' ? ' selected' : '') + '>Fixed</option><option value="SingleAxis">Single Axis</option><option value="DualAxis">Dual Axis</option></select></div>'
            + '</div>';
        }
        h += '</fieldset>';
      }
      h += '<button no-interact class="btn-secondary btn" data-test-role="add-array-btn" type="button">Add Array</button> '
        + '<button no-interact data-test-role="calculate-btn" class="btn-secondary btn" type="button">Calculate</button>';
      document.getElementById('section').innerHTML = h;
      wire();
    }
    var pending = [];
    function flush() { while (pending.length) { var j = pending.shift(); clearTimeout(j.t); j.run(); } }
    function rowOf(el) { var c = el.closest('[data-test-role="pv-array-div"]'); return c ? server.rows[Number(c.getAttribute('data-row'))] : null; }
    // PER-FIELD AUTOSAVE, DEBOUNCED (nothing on the wire for ~900 ms), re-rendering the section when
    // a save unlocks the row's next controls.
    function save(key, val, row) {
      var job = { run: function () {
        if (key === 'invMfr') { server.invMfr = val; if (server.invModel && MODELS[val] && MODELS[val].indexOf(server.invModel) < 0) server.invModel = ''; return; }
        if (key === 'invModel') { server.invModel = val; return; }
        if (!row) return;
        if (key === 'azi' && val && REWRITE_AZIMUTH) { row.azi = '0'; render(); return; }
        if (key === 'model' && val && REWRITE_MODEL) { row.model = val === PICKED_440 ? SAVED_430 : val; render(); return; }
        var unlock = (key === 'qty' && val && !row.qty) || (key === 'mfr' && val && !row.mfr) || (key === 'model' && val && !row.model);
        row[key] = val;
        if (unlock) render();
      } };
      job.t = setTimeout(function () { pending.splice(pending.indexOf(job), 1); job.run(); }, 900);
      pending.push(job);
    }
    function openList(input) {
      var ul = document.getElementById(input.getAttribute('aria-controls'));
      if (!ul) return;
      var key = input.getAttribute('data-k');
      // The micro's models follow the make its row SHOWS now (its input; else what was saved).
      var fs = input.closest('fieldset'), mi = fs && fs.querySelector('[data-k="microMfr"]');
      var microMake = (mi && mi.value) || (rowOf(input) || {}).microMfr;
      var opts = key === 'invMfr' ? INV_MAKES : key === 'mfr' ? MODULE_MAKES
        : key === 'microMfr' ? MICRO_MAKES
        : key === 'invModel' ? (MODELS[server.invMfr] || [])
        : key === 'microModel' ? (MODELS[microMake] || [])
        : (MODELS[(rowOf(input) || {}).mfr] || []);
      // Opening the widget shows its face again (HIDE_MODEL_FACE hides it after a re-render).
      var faceWrap = input.parentElement.querySelector('[aria-hidden="true"]');
      if (faceWrap && faceWrap.style.display === 'none') faceWrap.style.display = '';
      ul.innerHTML = '';
      for (var i = 0; i < opts.length; i++) {
        (function (text) {
          var li = document.createElement('li');
          li.setAttribute('role', 'option');
          li.textContent = text;
          li.addEventListener('mousedown', function (e) { e.preventDefault(); pick(input, text); });
          ul.appendChild(li);
        })(opts[i]);
      }
      ul.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }
    function pick(input, text) {
      var k = input.getAttribute('data-k');
      if (!(EMPTY_VALUE && k !== 'invMfr' && k !== 'invModel')) input.value = text;
      var face = input.parentElement.querySelector('[data-test-role="selected-item-text"]');
      if (face) face.textContent = text;
      var ul = document.getElementById(input.getAttribute('aria-controls'));
      if (ul) ul.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      save(input.getAttribute('data-k'), text, rowOf(input));
    }
    function wire() {
      var els = document.querySelectorAll('#section input, #section select');
      for (var i = 0; i < els.length; i++) {
        (function (el) {
          if (el.getAttribute('role') === 'combobox') {
            el.addEventListener('click', function () { openList(el); });
            el.addEventListener('focus', function () { openList(el); });
            var face = el.parentElement.querySelector('[data-test-role="filteredSelectField"]');
            if (face) face.addEventListener('click', function () { openList(el); });
            return;
          }
          if (!el.getAttribute('data-k')) return;
          el.addEventListener('blur', function () {
            var v = el.tagName === 'SELECT' ? el.options[el.selectedIndex].value : el.value;
            save(el.getAttribute('data-k'), v, rowOf(el));
          });
        })(els[i]);
      }
      var add = document.querySelector('[data-test-role="add-array-btn"]');
      add.addEventListener('click', function () { flush(); server.rows.push(newRow()); render(); });
    }
    document.getElementById('next').addEventListener('click', function () {
      flush();
      sessionStorage.setItem('srv', JSON.stringify(server));
      location.href = '/review';
    });
    window.__server = server;
    render();
  </script>
</body></html>`;

export const reviewPage = `<!doctype html><html><body>
  <h1>Review and Submit</h1>
  <p>Please review your application before submitting.</p>
  <div id="out"></div>
  <button type="button" id="submitapp">Submit Application</button>
  <script>
    var s = JSON.parse(sessionStorage.getItem('srv') || '{"rows":[]}');
    window.__server = s;
    var h = '<p>Inverter: ' + (s.invMfr || '') + ' — ' + (s.invModel || '') + '</p><table>';
    for (var i = 0; i < s.rows.length; i++) {
      var r = s.rows[i];
      h += '<tr><td>PV Array ' + (i + 1) + '</td><td>' + (r.qty || '') + '</td><td>' + (r.mfr || '') + '</td><td>' + (r.model || '') + '</td><td>' + (r.tilt || '') + '</td><td>' + (r.azi || '') + '</td><td>' + (r.track || '') + '</td></tr>';
    }
    document.getElementById('out').innerHTML = h + '</table>';
    document.getElementById('submitapp').addEventListener('click', function () { window.__filed = true; });
  </script>
</body></html>`;

// The recipe as the PacifiCorp learn recorded it: the inverter first (top-down), then ONE row —
// Qty by its test-role-humanised label "pv array quantity" (the row's own label is "Qty") with
// the volatile id and the test-role css as fallbacks; the module make/model by volatile ids with
// bare-label fallbacks ranked against the learn page; Tilt / Azimuth by their label-for labels.
export const recipe = (url: string): PortalRecipe => ({
  id: "pc347", scopeType: "utility", profileKey: "or||pacific-power", state: "OR", ahj: "", utility: "Pacific Power",
  portalPlatform: "powerclerk", portalUrl: url, status: "complete", version: 1,
  steps: [
    { action: "select", phase: "fill", selector: { css: "#pcInputBase54", fallbacks: [{ label: "Manufacturer", nth: 0 }] }, field: "inverterMake", note: "Manufacturer" },
    { action: "select", phase: "fill", selector: { css: "#pcInputBase55", fallbacks: [{ label: "Model", nth: 0 }] }, field: "inverterModel", note: "Model" },
    { action: "fill", phase: "fill", selector: { label: "pv array quantity", fallbacks: [{ css: "#pcInputBase56" }, { css: '[data-test-role="pv-array-quantity"]' }] }, field: "array1ModuleQuantity", note: "pv array quantity" },
    { action: "select", phase: "fill", selector: { css: "#pcInputBase57", fallbacks: [{ label: "Manufacturer", nth: 1 }] }, field: "moduleMake", note: "Manufacturer" },
    { action: "select", phase: "fill", selector: { css: "#pcInputBase58", fallbacks: [{ label: "Model", nth: 1 }] }, field: "moduleModel", note: "Model" },
    { action: "fill", phase: "fill", selector: { label: "Tilt", fallbacks: [{ css: "#pcInputBase59" }, { css: '[data-test-role="tilt-input"]' }] }, field: "array1Tilt", note: "Tilt" },
    { action: "fill", phase: "fill", selector: { label: "Azimuth", fallbacks: [{ css: "#pcInputBase60" }, { css: '[data-test-role="azimuth-input"]' }] }, field: "array1Azimuth", note: "Azimuth" },
    { action: "click", phase: "advance", selector: { role: "button", name: "Next", exact: true }, note: "advance: Next" },
    { action: "stopForReview", phase: "review", note: "review" },
  ] as RecipeStep[],
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe);

// The project's arrays (synthetic project; the numbers are the plan set's geometry), with the
// PLAN SET's make wording — the portal lists the certified "Znshine PV-Tech".
export const ARRAYS = [
  { qty: "9", azi: "172" }, { qty: "6", azi: "82" }, { qty: "4", azi: "82" },
  { qty: "7", azi: "262" }, { qty: "10", azi: "262" }, { qty: "3", azi: "262" },
];
export const CERT_MAKE = "Znshine PV-Tech";
export const MODEL = "440W (Model ZXM7-UHLDD108-440/N)";
export const fieldsFor = (arrays: typeof ARRAYS): Record<string, string> => {
  const f: Record<string, string> = {
    totalModuleQuantity: String(arrays.reduce((s, a) => s + Number(a.qty), 0)),
    moduleMake: "ZNShine Solar", moduleModel: "ZXM7-UHLDD108-440/N", moduleModelCertified: MODEL,
    inverterMake: "Altenergy Power System", inverterModel: "0.8 kW (Model DS3-L {240V} [SI1])",
  };
  arrays.forEach((a, i) => {
    f[`array${i + 1}ModuleQuantity`] = a.qty;
    f[`array${i + 1}Tilt`] = "24";
    f[`array${i + 1}Azimuth`] = a.azi;
  });
  return f;
};

export type Committed = { rows: Array<Record<string, string>>; invMfr?: string; invModel?: string };

/** Serve the fixture, open a browser context, and return a runner that drives the REAL replay
 *  path (RecipeAdapter.fillApplication) on `pathname` with `fields`. */
export async function startRowFixture(chromium: { launch: () => Promise<Browser> }): Promise<{
  run: (pathname: string, fields: Record<string, string>, recipeFor?: (url: string) => PortalRecipe) => Promise<{ r: Awaited<ReturnType<RecipeAdapter["fillApplication"]>>; committed: Committed; filed: boolean; url: string }>;
  close: () => Promise<void>;
  /** The fixture's origin and browser context, for a smoke that drives something other than a replay. */
  base: string;
  context: BrowserContext;
}> {
  const server = http.createServer((q, r) => {
    const url = String(q.url ?? "");
    r.writeHead(200, { "Content-Type": "text/html" });
    r.end(url.startsWith("/review") ? reviewPage : page(variantOf(url)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  const context: BrowserContext = await browser.newContext();
  await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const run = async (pathname: string, fields: Record<string, string>, recipeFor: (url: string) => PortalRecipe = recipe) => {
    const p = await context.newPage();
    await p.goto(`${base}${pathname}`);
    const a = new RecipeAdapter(recipeFor(`${base}${pathname}`), fields, {}, { autoSubmit: false });
    (a as unknown as { page: unknown }).page = p;
    const r = await a.fillApplication({} as never);
    await p.waitForTimeout(1500); // let the last debounced autosaves land
    const committed = await p.evaluate(() => (window as unknown as { __server: Committed }).__server);
    const filed = await p.evaluate(() => (window as unknown as { __filed?: boolean }).__filed === true);
    return { r, committed, filed, url: p.url() };
  };
  return { run, close: async () => { await browser.close(); server.close(); }, base, context };
}

// ---- Shared by the #348 review's variant smokes (two arrays each). ----
export const TWO_ARRAYS = ARRAYS.slice(0, 2);
/** The per-row microinverter's own make/model (?micro=1), as every row starts. */
export const MICRO_MAKE = "Enphase Energy Inc.";
export const MICRO_MODEL = "0.96 kW (Model QT2 {240V})";
export type RowRun = Awaited<ReturnType<Awaited<ReturnType<typeof startRowFixture>>["run"]>>;
/** Did the run stage at review (the replay's own answer, or the page it ended on)? */
export const reachedReview = (w: RowRun): boolean => w.r.ok === true || w.url.endsWith("/review");
/** One line: the outcome, what each row committed, and the message's head. */
export const outline = (w: RowRun): string => {
  const rows = (w.committed.rows ?? []).map((r) => r.microMfr !== undefined
    ? [r.qty, r.microMfr, r.microModel, r.mfr || "-", r.model || "-", r.tilt, r.azi]
    : [r.qty, r.mfr || "-", r.model || "-", r.tilt, r.azi]);
  return `ok=${w.r.ok} url=${w.url.replace(/^https?:\/\/[^/]+/, "")} rows=${JSON.stringify(rows)} message=${String(w.r.message ?? "").slice(0, 400)}`;
};
