// THE PAGE THE BENCHMARK CALLED CLEAN.
//
// The first live replay benchmark scored PacifiCorp `replayed_clean` — "every recorded step
// ran and nothing was left blank" — and the screenshot it saved of that very page shows the
// portal refusing the filing in red: an empty required PV-array model select reading
// "This field is required.", and an empty required "Total System Export (kW) *". Two blanks,
// both stated on screen, both invisible to the sweep whose entire job is to find them.
//
// The shapes below are that page, reduced. They are not PacifiCorp-specific: a quantity
// beside a model select is the ordinary form of every equipment row, and a caption rendered
// outside a <label> is the ordinary form of half the forms on the web.
//
// The negative cases carry equal weight. A sweep that cries blank on a correctly filled page
// teaches the operator to click past the warning, and then it protects nobody.
//   npx tsx portal-bot/src/requiredSweep.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import { sweepEmptyRequiredControls } from "./requiredControlSweep";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const shell = (body: string): string =>
  `<!doctype html><html><head><style>
     body{font:14px sans-serif;padding:20px} .row{display:flex;gap:8px;align-items:center}
     .err{color:#c00;display:block} .form-group{margin:18px 0}
   </style></head><body>${body}</body></html>`;

// Bootstrap 4 + select2 4 markup for the select2 pages (#327). Metrics as Bootstrap ships them.
const bs4 = (body: string, width = 600): string =>
  `<!doctype html><html><head><style>
     html{font-size:16px} body{margin:0;padding:20px;font:16px/1.5 sans-serif} *,*::before,*::after{box-sizing:border-box}
     form{width:${width}px} .form-group{margin-bottom:1rem} label{display:inline-block;margin-bottom:.5rem}
     .form-control{display:block;width:100%;height:calc(1.5em + .75rem + 2px);padding:.375rem .75rem;font-size:1rem;line-height:1.5;border:1px solid #ced4da}
     .invalid-feedback{display:none;width:100%;margin-top:.25rem;font-size:80%;color:#dc3545} .d-block{display:block!important}
     small{font-size:80%} .form-text{display:block;margin-top:.25rem}
     .select2-container{display:inline-block;margin:0;position:relative;vertical-align:middle}
     .select2-selection--single{display:block;height:calc(1.5em + .75rem + 2px);border:1px solid #ced4da;padding:.375rem .75rem}
     .select2-hidden-accessible{border:0!important;clip:rect(0 0 0 0)!important;clip-path:inset(50%)!important;height:1px!important;overflow:hidden!important;padding:0!important;position:absolute!important;width:1px!important;white-space:nowrap!important}
   </style></head><body><form>${body}</form></body></html>`;
const S2_SELECT = (cls = ""): string => `<select id="s2u" name="s2u" class="${cls}select2-hidden-accessible is-invalid" tabindex="-1" aria-hidden="true"><option value=""></option><option value="u1">Sample Light Co</option></select>`;
const S2_FACE = (style = "width:100%"): string => `<span class="select2 select2-container select2-container--bootstrap4" dir="ltr" style="${style}"><span class="selection"><span class="select2-selection select2-selection--single" role="combobox" tabindex="0" aria-labelledby="select2-s2u-container"><span class="select2-selection__rendered" id="select2-s2u-container" role="textbox" aria-readonly="true"><span class="select2-selection__placeholder">Select a utility</span></span><span class="select2-selection__arrow" role="presentation"><b role="presentation"></b></span></span></span><span class="dropdown-wrapper" aria-hidden="true"></span></span>`;
const S2_ADDRESS = `<div class="form-group"><label for="s2a">Service address</label><input id="s2a" name="s2a" class="form-control" value="5010 Fixture Ave"></div>`;
const S2_HELP = `<small class="form-text text-muted">The utility that serves the meter.</small>`;

const PAGES: Record<string, string> = {
  // ---- the live miss, shape 1: a complaint in a row that holds TWO controls ----------
  arrayRow: shell(`
    <div class="form-group">
      <div class="row">
        <span>Qty</span><input name="qty" value="18" />
        <select name="module"><option>Please select...</option><option>REC400AA</option></select>
      </div>
      <span class="err">This field is required.</span>
    </div>`),

  // ---- the live miss, shape 2: an asterisk rendered OUTSIDE a <label for> ------------
  captionAsterisk: shell(`
    <div class="form-group">
      <div>Total System Export (kW) *</div>
      <input name="export" value="" />
    </div>`),

  // ---- both together, as the portal actually served them -----------------------------
  pacificorp: shell(`
    <div class="form-group">
      <div class="row">
        <span>Qty</span><input name="qty" value="18" />
        <select name="module"><option>Please select...</option></select>
      </div>
      <span class="err">This field is required.</span>
    </div>
    <div class="form-group"><div>Total System Export (kW) *</div><input name="export" value="" /></div>
    <div class="form-group"><div>Does The Generation System Size Exceed The Limit?</div><span>false</span></div>`),

  // ---- NEGATIVE: the same page, correctly filled. Must be silent. --------------------
  filled: shell(`
    <div class="form-group">
      <div class="row">
        <span>Qty</span><input name="qty" value="18" />
        <select name="module"><option>Please select...</option><option selected>REC400AA</option></select>
      </div>
    </div>
    <div class="form-group"><div>Total System Export (kW) *</div><input name="export" value="6.4" /></div>`),

  // ---- NEGATIVE: the bug the old single-control bound was defending against ----------
  // One complaint, a page full of filled fields. It must claim the ONE field it sits under,
  // not every control on the page.
  oneComplaintManyFields: shell(`
    <div class="form-group"><label for="a">Applicant *</label><input id="a" value="Avery Sample" /></div>
    <div class="form-group"><label for="b">Street *</label><input id="b" value="5010 Fixture Ave" /></div>
    <div class="form-group"><label for="c">City *</label><input id="c" value="Coos Bay" /></div>
    <div class="form-group"><label for="d">Meter number *</label><input id="d" value="" />
      <span class="err">This field is required.</span></div>`),

  // ---- NEGATIVE: INSTRUCTIONS ARE NOT ERRORS -----------------------------------------
  // "Please select all that apply" is the caption above a checkbox group, not a complaint.
  // Checkboxes are excluded from the controls list, so this is exactly the shape that lands
  // in the unattributable bucket — and reporting it would demote a correct run AND stop
  // replay clicking on, because pageIsPassThrough shares this sweep.
  instructions: shell(`
    <div class="form-group"><p>Please select all that apply to this installation:</p>
      <label><input type="checkbox" checked /> Battery storage</label>
      <label><input type="checkbox" /> Generator</label>
    </div>
    <div class="form-group"><label for="q">System size (kW) *</label><input id="q" value="7.2" /></div>`),

  // ---- NEGATIVE: A LEGEND IS NOT A COMPLAINT -----------------------------------------
  // Ameren's live run reported this sentence as a blank required field. Nearly every form
  // carries one, it matches "is required" exactly as a validation message does, and it
  // refers to no field at all — a fabricated gap on a page that may have been complete.
  legend: shell(`
    <p class="err">All Information indicated with a red * (asterisk) is required.</p>
    <div class="form-group"><label for="e">Email *</label><input id="e" value="permit@example.com" /></div>
    <div class="form-group"><label for="p">Phone *</label><input id="p" value="(503) 555-0142" /></div>`),

  // ...but a real complaint on the SAME page is still caught, so the exclusion is not a mute.
  legendPlusRealComplaint: shell(`
    <p class="err">All fields marked with an asterisk are required.</p>
    <div class="form-group"><label for="e2">Email *</label><input id="e2" value="permit@example.com" /></div>
    <div class="form-group"><label for="p2">Meter number *</label><input id="p2" value="" />
      <span class="err">This field is required.</span></div>`),

  // ---- NEGATIVE: THE OTHER LEGEND WORDING, which cost a live run ---------------------
  // Oregon ePermitting's "Licensed Professional List" page carries only "* indicates a
  // required field". The first legend guard covered "indicated with" and not "indicates a",
  // so the sweep called it a blank, pageIsPassThrough refused to click through a page that
  // needed nothing but Continue, and the whole Coos Bay flow stopped there.
  legendIndicates: shell(`
    <p><span>*</span> indicates a required field.</p>
    <div class="form-group"><label for="lp">Licensed Professional</label>
      <input id="lp" value="TML INTERNATIONAL" /></div>`),

  // ---- NEGATIVE: AN ADVISORY NOTE IS PROSE ABOUT THE PROCESS -------------------------
  // Oregon ePermitting's attachment page: "Please note: Plan review is required for some
  // services." It matched `is required`, was counted as a blank required field, and — because
  // pageIsPassThrough shares this sweep — also stopped replay clicking through the page.
  advisory: shell(`
    <p>Please note: Plan review is required for some services.</p>
    <div class="form-group"><label for="d">Description</label>
      <textarea id="d">Solar PV plan set</textarea></div>`),

  // ---- A COMPLAINT BESIDE ITS FIELD BELONGS TO THAT FIELD (#327) ---------------------
  // requiredBlank.dom.smoke's page as the container's fonts laid it out: the optional notes
  // box wrapped onto the line just above, ending where the complaint's line starts, and the
  // complaint sits right after the empty Manufacturer select. Pinned with absolute positions
  // so the geometry no longer depends on which fonts a machine has.
  besideOwnField: shell(`
    <label for="bn" style="position:absolute;left:8px;top:40px">Additional notes</label>
    <input id="bn" style="position:absolute;left:8px;top:80px;width:185px;height:21px;box-sizing:border-box" />
    <label for="bm" style="position:absolute;left:8px;top:101px">Inverter Manufacturer</label>
    <select id="bm" style="position:absolute;left:154px;top:101px;width:168px;height:19px"><option value="">Please select...</option></select>
    <span class="err" style="position:absolute;left:325px;top:101px;display:inline">This field is required.</span>`),

  // ...and its mirror: a complaint UNDER its field, sharing a line with another empty control
  // further RIGHT, still belongs to the field above it.
  underWithNeighbourRight: shell(`
    <label for="ua" style="position:absolute;left:8px;top:20px">Meter number</label>
    <input id="ua" style="position:absolute;left:8px;top:60px;width:185px;height:21px;box-sizing:border-box" />
    <span class="err" style="position:absolute;left:8px;top:111px;display:inline">This field is required.</span>
    <label for="uc" style="position:absolute;left:200px;top:90px">Fax</label>
    <input id="uc" style="position:absolute;left:200px;top:111px;width:185px;height:21px;box-sizing:border-box" />`),

  // ---- A FIELD THAT HOLDS THE COMPLAINT UNDER ITSELF OUTRANKS A NEIGHBOUR'S "BESIDE" (#327) --
  // The beside rule above must not hand a complaint UNDER its own field to an empty control
  // that ends just left of it on the complaint's line. On the PSE Part 1 page that control was
  // an upload slot the run had filled, the held-upload read-back discharged it, and the draft
  // was created with Customer phone blank. All absolute, so the geometry is the pin.
  //
  // mirrorLeft: the complaint 16 px under Customer phone, aligned; the slot ends at 292.
  mirrorLeft: shell(`
    <label for="mp" style="position:absolute;left:300px;top:20px">Customer phone</label>
    <input id="mp" style="position:absolute;left:300px;top:40px;width:185px;height:21px;box-sizing:border-box" />
    <label for="ms" style="position:absolute;left:200px;top:52px;font-size:11px">Plan set</label>
    <input id="ms" type="file" style="position:absolute;left:200px;top:72px;width:92px;height:26px;box-sizing:border-box" />
    <span class="err" style="position:absolute;left:300px;top:77px;display:inline">This field is required.</span>`),

  // indent40: the complaint INDENTED 40 px under its field (a plain |dleft| <= 12 test misses
  // it), with an empty box ending just left of it on its line.
  indent40: shell(`
    <label for="ip" style="position:absolute;left:300px;top:20px">Customer phone</label>
    <input id="ip" style="position:absolute;left:300px;top:40px;width:185px;height:21px;box-sizing:border-box" />
    <label for="ir" style="position:absolute;left:240px;top:58px;font-size:11px">Reference</label>
    <input id="ir" style="position:absolute;left:240px;top:72px;width:96px;height:24px;box-sizing:border-box" />
    <span class="err" style="position:absolute;left:340px;top:75px;display:inline">This field is required.</span>`),

  // twoComplaints: two columns, both empty and both flagged. The left one is a tall textarea, so
  // the RIGHT field's complaint sits beside it on its line; the beside rule handed that complaint
  // to the textarea (already reported for its own) and lost Customer email.
  twoComplaints: shell(`
    <label for="ta" style="position:absolute;left:150px;top:0">Project description *</label>
    <textarea id="ta" style="position:absolute;left:150px;top:20px;width:140px;height:80px;box-sizing:border-box"></textarea>
    <span class="err" style="position:absolute;left:150px;top:104px;display:inline">This field is required.</span>
    <label for="te" style="position:absolute;left:300px;top:0">Customer email</label>
    <input id="te" style="position:absolute;left:300px;top:20px;width:140px;height:21px;box-sizing:border-box" />
    <span class="err" style="position:absolute;left:300px;top:61px;display:inline">This field is required.</span>`),

  // bootstrapSelect: a 300 px bootstrap-select "Utility" — the face is a button, the native
  // select a 0.5 px opacity-0 sliver at left:50% — flagged under its left edge, with an empty
  // box ending just left of the complaint on its line.
  bootstrapSelect: shell(`
    <label for="bu" style="position:absolute;left:300px;top:20px">Utility</label>
    <div class="btn-group bootstrap-select" style="position:absolute;left:300px;top:40px;width:300px;height:34px">
      <button type="button" class="btn dropdown-toggle" title="Nothing selected" style="width:300px;height:34px;text-align:left">Nothing selected</button>
      <select id="bu" class="selectpicker" tabindex="-98" style="position:absolute;bottom:0;left:50%;display:block;width:0.5px;height:100%;padding:0;opacity:0;border:none">
        <option value="">Nothing selected</option><option value="u1">Sample Light Co</option>
      </select>
    </div>
    <label for="br" style="position:absolute;left:170px;top:54px;font-size:11px">Reference</label>
    <input id="br" style="position:absolute;left:170px;top:74px;width:122px;height:26px;box-sizing:border-box" />
    <span class="err" style="position:absolute;left:300px;top:78px;display:inline">This field is required.</span>`),

  // fullWidthAbove: a FULL-WIDTH (960 px) empty notes box right above "Meter location [select]
  // This field is required." The aligned-above bound is capped at 48 px so this box does not
  // cancel the beside complaint; uncapped (width / 3) it would, and main's misattribution to the
  // box above — by one pixel here — comes back.
  fullWidthAbove: shell(`
    <label for="fn" style="position:absolute;left:8px;top:0">Additional notes</label>
    <textarea id="fn" style="position:absolute;left:8px;top:20px;width:960px;height:30px;box-sizing:border-box"></textarea>
    <label for="fm" style="position:absolute;left:8px;top:54px">Meter location</label>
    <select id="fm" style="position:absolute;left:120px;top:54px;width:190px;height:19px"><option value="">Please select...</option></select>
    <span class="err" style="position:absolute;left:314px;top:54px;display:inline">This field is required.</span>`),

  // handedRunnerUp: a complaint truly under an empty upload slot. The entry carries the
  // runner-up empty control and the unattributed fallback, so a caller that discharges the slot
  // as a held upload (recipeAdapter.sweepRequired) can keep the complaint.
  handedRunnerUp: shell(`
    <label for="hs" style="position:absolute;left:8px;top:20px">Plan set</label>
    <input id="hs" type="file" style="position:absolute;left:8px;top:40px;width:200px;height:26px;box-sizing:border-box" />
    <span class="err" style="position:absolute;left:8px;top:70px;display:inline">This field is required.</span>
    <label for="hp" style="position:absolute;left:300px;top:20px">Customer phone</label>
    <input id="hp" style="position:absolute;left:300px;top:40px;width:185px;height:21px;box-sizing:border-box" />`),

  // ---- A SELECT2 SLIVER'S WIDGET BOX MAY ONLY BRING IT NEARER (#327) --------------------
  // select2 keeps the native <select> as a 1 x 1 clipped sliver and draws its face as a SIBLING,
  // so the sliver's nearest box is the whole form-group (or row, or fieldset): label above,
  // complaint and help text below. Judged by that box alone (9807442c) the complaint fell out of
  // reach and went to a filled neighbour, or nowhere. Bootstrap 4's own metrics, inlined (bs4).
  //
  // help2: two help lines under "This field is required.", a filled Service address above.
  s2Help2: bs4(`${S2_ADDRESS}<div class="form-group"><label for="s2u">Utility</label>${S2_SELECT("form-control ")}${S2_FACE()}
    <div class="invalid-feedback d-block">This field is required.</div>${S2_HELP}${S2_HELP}</div>`),
  // captionIn / captionOut: a 450 px inline caption, so the row (the box) starts 450 px left of the
  // face, past the 420 px column bound; the complaint inside the row, and just outside it.
  s2CaptionIn: bs4(`${S2_ADDRESS}<div class="form-group"><label for="s2u" style="width:450px">Utility</label>${S2_SELECT()}${S2_FACE("width:300px")}
    <div class="invalid-feedback d-block" style="margin-left:450px">This field is required.</div></div>`, 900),
  s2CaptionOut: bs4(`${S2_ADDRESS}<div class="form-group" style="margin-bottom:0"><label for="s2u" style="width:450px">Utility</label>${S2_SELECT()}${S2_FACE("width:300px")}</div>
    <div class="invalid-feedback d-block" style="margin-left:450px">This field is required.</div>`, 900),
  // floatFieldset: the face floated in a wrapper that collapses to 0 px, so the box climbs to the
  // radio fieldset round it (radios are not "controls" here); a filled field within 90 px above.
  s2FloatFieldset: bs4(`${S2_ADDRESS}<fieldset style="border:1px solid #ccc;padding:0 8px 4px;margin:0">
      <legend style="font-size:1rem;margin:0"><label for="s2u" style="margin:0">Utility</label></legend>
      <div>${S2_SELECT("form-control ")}${S2_FACE("float:left;width:300px")}</div>
      <div class="invalid-feedback d-block" style="clear:both">This field is required.</div>
      <div>Battery storage? <label><input type="radio" name="bat" value="y" checked> Yes</label> <label><input type="radio" name="bat" value="n"> No</label></div>
    </fieldset>`),

  // ---- a complaint no control can own must still be reported -------------------------
  orphanComplaint: shell(`
    <div class="err">Please select at least one option before continuing.</div>
    <div style="height:600px"></div>
    <div class="form-group"><label for="z">Notes</label><input id="z" value="ok" /></div>`),
};

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGES[(req.url || "").replace(/^\/|\?.*$/g, "")] ?? shell("none"));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
// tsx/esbuild wraps named functions with __name(); without this every page.evaluate throws
// and the .catch turns a crash into "found nothing" — which is this sweep's failure mode.
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();

const sweep = async (key: string) => {
  await page.goto(`http://127.0.0.1:${port}/${key}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(60);
  return (await sweepEmptyRequiredControls(page)).empty;
};

// ---------------------------------------------------------------------------
// The two live misses.
// ---------------------------------------------------------------------------
const row = await sweep("arrayRow");
check("THE LIVE MISS: an empty select in a two-control row, flagged by the portal, is caught",
  row.length > 0, `sweep returned nothing; the portal said "This field is required."`);
check("...and it names the SELECT, not the filled quantity beside it",
  row.length > 0 && !row.some((r) => /^qty$/i.test(r.name)) && !!row.length,
  JSON.stringify(row));

const cap = await sweep("captionAsterisk");
check("THE LIVE MISS: a required asterisk outside a <label for> is honoured",
  cap.length === 1, JSON.stringify(cap));
check("...and the field is named from the caption a human reads",
  cap.some((r) => /total system export/i.test(r.name)), JSON.stringify(cap));

const pc = await sweep("pacificorp");
check("the page the benchmark called CLEAN reports both blanks",
  pc.length >= 2, `${pc.length} found: ${JSON.stringify(pc)}`);
console.log(`   would have reported: ${JSON.stringify(pc.map((r) => `${r.name} [${r.why}]`))}`);

// ---------------------------------------------------------------------------
// The expensive direction: false alarms train people to ignore the alarm.
// ---------------------------------------------------------------------------
const ok = await sweep("filled");
check("a correctly filled page reports NOTHING", ok.length === 0, JSON.stringify(ok));

const many = await sweep("oneComplaintManyFields");
check("one complaint claims ONE field, not the whole page",
  many.length === 1, `${many.length} reported: ${JSON.stringify(many)}`);
check("...and it is the field the message sits under",
  many.some((r) => /meter/i.test(r.name)), JSON.stringify(many));

const beside = await sweep("besideOwnField");
check("a complaint BESIDE its empty select is that select's, not the empty box on the line above (#327)",
  beside.some((r) => /inverter manufacturer/i.test(r.name)) && !beside.some((r) => /additional notes/i.test(r.name)),
  JSON.stringify(beside));
const under = await sweep("underWithNeighbourRight");
check("...and a complaint UNDER its field is not handed to an empty control further right on its line",
  under.some((r) => /meter number/i.test(r.name)) && !under.some((r) => /fax/i.test(r.name)),
  JSON.stringify(under));

const nameIs = (rows: Array<{ name: string }>, re: RegExp): boolean => rows.some((r) => re.test(r.name));
const mirror = await sweep("mirrorLeft");
check("a complaint UNDER Customer phone is Customer phone's, not the empty slot ending left of it on the complaint's line (#327)",
  nameIs(mirror, /customer phone/i) && !nameIs(mirror, /plan set/i), JSON.stringify(mirror));
const indent = await sweep("indent40");
check("...and so is a complaint indented 40 px under its field",
  nameIs(indent, /customer phone/i) && !nameIs(indent, /reference/i), JSON.stringify(indent));
const two = await sweep("twoComplaints");
check("two columns, two complaints: BOTH empty fields are named, the right one from its own complaint",
  nameIs(two, /project description/i) && two.some((r) => /customer email/i.test(r.name) && r.why === "complaint") && two.length === 2,
  JSON.stringify(two));
const boot = await sweep("bootstrapSelect");
check("a 300 px bootstrap-select (0.5 px opacity-0 native select at left:50%) flagged under its widget is named, not the box left of the complaint",
  nameIs(boot, /^utility$/i) && !nameIs(boot, /reference/i), JSON.stringify(boot));
const wide = await sweep("fullWidthAbove");
check("a full-width empty box above does not cancel a complaint BESIDE its select (the 48 px cap)",
  nameIs(wide, /meter location/i) && !nameIs(wide, /additional notes/i), JSON.stringify(wide));
const runner = await sweep("handedRunnerUp");
{
  const slot = runner.find((r) => /plan set/i.test(r.name));
  check("a complaint handed to a control carries the runner-up EMPTY control and the unattributed fallback",
    slot?.why === "complaint" && slot.handed?.length === 1 && slot.handed[0].next === "Customer phone"
      && /^portal reports "This field is required\." \(field could not/.test(slot.handed[0].unattributed),
    JSON.stringify(runner));
}

for (const [key, what] of [
  ["s2Help2", "two help lines under the complaint"],
  ["s2CaptionIn", "a 450 px inline caption, the complaint inside the row"],
  ["s2CaptionOut", "a 450 px inline caption, the complaint just outside the row"],
  ["s2FloatFieldset", "a collapsed float wrapper inside a radio fieldset, a filled field within 90 px"],
] as Array<[string, string]>) {
  const got = await sweep(key);
  check(`a blank select2 Utility (1 x 1 sliver, face a sibling) is named from its complaint: ${what} (#327)`,
    got.some((r) => r.name === "Utility" && r.why === "complaint"), JSON.stringify(got));
}

const instr = await sweep("instructions");
check("INSTRUCTIONAL 'please select all that apply' is not treated as a complaint",
  instr.length === 0, `false blanks manufactured: ${JSON.stringify(instr)}`);

const legend = await sweep("legend");
check("THE LIVE FALSE POSITIVE: a form's asterisk LEGEND is not a blank field",
  legend.length === 0, `fabricated ${legend.length} gap(s): ${JSON.stringify(legend)}`);

const both = await sweep("legendPlusRealComplaint");
check("...and a real complaint on the same page is still caught",
  both.some((r) => /meter/i.test(r.name)), JSON.stringify(both));
check("...without the legend adding a second, phantom entry",
  both.length === 1, JSON.stringify(both));

const legend2 = await sweep("legendIndicates");
check("THE LIVE FALSE POSITIVE: '* indicates a required field' is a legend, not a blank",
  legend2.length === 0, `fabricated ${legend2.length}: ${JSON.stringify(legend2)}`);

const advisory = await sweep("advisory");
check("THE LIVE FALSE POSITIVE: 'Please note: ... is required' is prose, not a blank",
  advisory.length === 0, `fabricated ${advisory.length}: ${JSON.stringify(advisory)}`);

const orphan = await sweep("orphanComplaint");
check("a complaint no field can own is still reported, not dropped",
  orphan.some((r) => r.why === "unattributed-complaint"), JSON.stringify(orphan));

// ---------------------------------------------------------------------------
// THE DENOMINATOR. "Nothing was left blank" is the same sentence whether the page had
// twenty required fields and we filled all twenty, or whether the sweep saw nothing at
// all and said so. Those are opposite facts. requiredSeen is what tells them apart, and
// it is exactly the kind of value that can quietly go empty forever without one failing
// test — a silent [] reads as a perfect score.
// ---------------------------------------------------------------------------
const seenOn = async (name: string): Promise<string[]> => {
  await page.goto(`http://127.0.0.1:${port}/${name}`);
  return (await sweepEmptyRequiredControls(page)).requiredSeen;
};

const filledSeen = await seenOn("filled");
console.log(`   filled page: 0 blank, ${filledSeen.length} required seen -> ${JSON.stringify(filledSeen)}`);
check("a CLEAN page still reports the required fields it satisfied",
  filledSeen.length > 0,
  "requiredSeen came back empty on a page with a required field — a clean score with no denominator is unfalsifiable");
check("...and names the field the portal actually marked required",
  filledSeen.some((n) => /Total System Export/i.test(n)), JSON.stringify(filledSeen));

const blankSeen = await seenOn("pacificorp");
check("a page with blanks counts them IN the required set, not beside it",
  blankSeen.length >= 2, `${blankSeen.length} required seen on a page with two required controls: ${JSON.stringify(blankSeen)}`);

// The legend page is the sharpest case for the whole idea. It reports ZERO blanks -- and
// it should, both its asterisked fields are filled. Without a denominator that is
// indistinguishable from a sweep that found nothing. With one it reads "two required
// fields, both satisfied", which is the sentence the operator actually needs.
const legendSeen = await seenOn("legend");
check("a satisfied page proves it LOOKED: two asterisked fields, zero blank",
  legendSeen.length === 2, `expected Email and Phone counted as required-and-satisfied, got ${JSON.stringify(legendSeen)}`);
check("...and the LEGEND SENTENCE itself is not counted as a required field",
  !legendSeen.some((n) => /asterisk|all information|is required/i.test(n)), JSON.stringify(legendSeen));

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} required-sweep check(s) FAILED.`); process.exit(1); }
console.log("\nAll required-sweep checks passed.");
process.exit(0);
