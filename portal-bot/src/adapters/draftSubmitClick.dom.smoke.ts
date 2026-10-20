// A REPLAY CLICKS A KNOWN DRAFT-CREATING SUBMIT ITSELF, AND PROVES IT ONLY MADE A DRAFT (#330).
//
// Owner ruling 2026-10-16 ("Yes to PSE"): PSE's PowerClerk Part 1 Submit only creates a draft
// ("Your draft application NEM-… has been created. Please continue to Interconnection Application -
// Part 2 …"). Once that page has been seen after a click of the recipe's last step, the backend
// heals it and stamps it in a server-owned record (portalDraft.ts); a replay of exactly those steps
// is passed that stamp (draftSubmitStamp) and may then click the step itself (draftSubmitGate.ts).
//
// Real Chromium through the real stage path (stageWithRecipe → runAdapter → RecipeAdapter with the
// network backstop installed) against a synthetic Part 1 page on 127.0.0.1 (never a real portal).
// Every non-GET the SERVER receives is counted.
//
//   MUST-PASS     draft: the stamped Submit is clicked once (1 POST), the page reads as draft-created,
//                 the run reports draftCreatedByReplay (number + next form), finalSubmitClicked false,
//                 no record number captured. With PORTAL_ALLOW_FINAL_SUBMIT unset and no approval.
//   MUST-PASS     draftApproved: the switch on, autoSubmit on and a named approval for the run change
//                 nothing — still one POST, still a draft, still finalSubmitClicked false.
//   MUST-EXCLUDE  (0 POSTs each) neverHealed: no stamp for the run — with the switch on, autoSubmit,
//                 an approval AND the old stamp field forged onto the step itself (what a recipe save
//                 could write); otherTenant: stamped for another host; stampMoved: the run's stamp
//                 names another step; flagged: stamped AND isFinalSubmit with no approval (the
//                 final-submit gate refuses; this path never takes it).
//   MUST-STOP     receipt: the page after the click reads as a FILING → one POST, paused
//                 draft_submit_unexpected, draftSubmitUnexpected.verdict "filed", finalSubmitClicked
//                 false, NO record number captured, no draft reported.
//   MUST-STOP     error: an error page after the click → paused draft_submit_unexpected, "not_a_draft".
//   MUST-EXCLUDE  A REQUIRED FIELD LEFT BLANK BESIDE A HELD UPLOAD (#327) — 0 POSTs each, the blank
//                 field NAMED. The run uploads to a required file slot; the portal takes the file,
//                 lists it and clears the box (a browser never restores a file input's value), so
//                 the required-blank sweep sees the slot empty and the held-upload read-back drops
//                 it. A "This field is required." the sweep hands to that slot is dropped with it,
//                 and the draft is then created with a required field blank:
//                   heldLeftOfPhone: the complaint is UNDER Customer phone; the held slot ends to its
//                     left on the complaint's own line (the beside rule zeroed the slot's distance);
//                   heldBesideUtility: the same with a bootstrap-select "Utility", whose native select
//                     is a 0.5 px, opacity-0 sliver at left:50% of its 300 px widget;
//                   heldAboveMeter: a FULL-WIDTH held slot above "Meter location [select] This field is
//                     required." (main gave that complaint to the wide slot above, by under a pixel);
//                   heldOwnComplaint: the complaint sits under the held slot itself and no other empty
//                     control is near — the held read-back discharges the empty BOX, never the portal's
//                     complaint, which is reported unattributed;
//                   heldDupAttachment: two uploaded slots captioned "Attachment *" (one sweep entry),
//                     the complaint handed to the SECOND — its hand-off rides on the shared entry;
//                   heldPlanSiteLine / heldDocumentsRow: the runner-up is the optional "Site photo",
//                     also uploaded — read back as held, so the complaint is reported unattributed,
//                     never as Site photo;
//                   heldGridTiedRow: "Is the system grid-tied? *" in the held slot's row — a radio
//                     group is never discharged as a held upload.
//   MUST-EXCLUDE  A SELECT2 UTILITY LEFT BLANK (#327) — 0 POSTs, Utility named: Bootstrap 4
//                 (select2Bs4Utility) and django-crispy-forms (select2CrispyUtility), a filled
//                 Service address above. The 1 x 1 sliver's widget box is the whole form-group,
//                 which ends past the complaint; it may only ever bring the sliver nearer.
//
// Run: npx tsx portal-bot/src/adapters/draftSubmitClick.dom.smoke.ts
import "../smokeArtifactDirs";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { stageWithRecipe } from "../index";
import type { DraftCreatingStamp } from "../draftSubmitGate";
import { draftTenantKey } from "../draftSubmitGate";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
process.env.AUTOLEARN_SAVE_SETTLE_MS = "1";
process.env.PORTAL_HEADLESS = "true";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const posts: Array<{ mode: string; path: string }> = [];
const NAV = `<header><a href="/home">Program Home</a> <a href="/logout">Sign Out</a></header>`;
const page = (title: string, body: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${NAV}<main>${body}</main></body></html>`;
const PART1 = (mode: string): string => page("Interconnection Application Part 1", `
  <h1>Interconnection Application Part 1 (Preliminary Validation)</h1>
  <form method="post" action="/m/${mode}/p1/submit" novalidate>
    <div><label for="appDate">Application Date</label><input id="appDate" name="appDate" type="text"></div>
    <div><label for="appType">Application Type</label><select id="appType" name="appType"><option value="">Select…</option><option>New Solar</option></select></div>
    ${heldBlock(mode)}
    <button type="submit" id="btnSubmit">Submit</button>
  </form>`);
const DRAFT_PAGE = page("Application", `<div class="alert alert-success">Your draft application NEM-90017 has been created. Please continue to Interconnection Application - Part 2 to complete your interconnection application and submit to PSE.</div><a href="/home">Return to Program Home</a>`);
const RECEIPT = page("Application Received", `<h1>Application Received</h1><p>Thank you. Your application has been submitted.</p><p>Record Number: NEM-90017</p>`);
// THE HELD-UPLOAD PAGES (#327). Absolute positions inside one positioned block, so the geometry
// does not depend on the fonts a machine has. The slot is required by its asterisk (no
// `required` attribute: the browser's own validation would then refuse the POST and hide whether
// the run clicked; the form is `novalidate` too, for the cases with `required` radios); once the
// portal takes the file it lists it and clears the box, which is what makes the slot read
// empty-but-held.
const ERR = `color:#c00;position:absolute;font:14px/17px sans-serif;white-space:nowrap`;
const HELD_SCRIPT = `<script>
  document.querySelectorAll('input[type=file]').forEach(function (slot) {
    slot.addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) return;
      var row = document.createElement('div');
      row.textContent = 'Uploaded: ' + f.name;
      document.getElementById('heldList').appendChild(row);
      this.value = '';
    });
  });
</script>`;
const HELD_LAYOUT: Record<string, string> = {
  // Customer phone at left 300; its complaint 16 px under it, aligned with it; the held slot ends at
  // 292 on the complaint's line.
  heldLeftOfPhone: `
    <label for="custPhone" style="position:absolute;left:300px;top:0">Customer phone</label>
    <input id="custPhone" name="custPhone" type="text" style="position:absolute;left:300px;top:20px;width:185px;height:21px;box-sizing:border-box">
    <label for="heldSlot" style="position:absolute;left:200px;top:32px;font-size:11px">Plan set *</label>
    <input id="heldSlot" name="heldSlot" type="file" style="position:absolute;left:200px;top:52px;width:92px;height:26px;box-sizing:border-box">
    <span style="${ERR};left:300px;top:57px">This field is required.</span>`,
  // A bootstrap-select "Utility" 300 px wide: the face is a button, the native select a 0.5 px,
  // opacity-0 sliver at left:50%. The complaint sits under the widget's left edge; the held slot ends
  // at 292 on the complaint's line.
  heldBesideUtility: `
    <label for="utilitySel" style="position:absolute;left:300px;top:0">Utility</label>
    <div class="btn-group bootstrap-select" style="position:absolute;left:300px;top:20px;width:300px;height:34px">
      <button type="button" class="btn dropdown-toggle" title="Nothing selected" style="width:300px;height:34px;text-align:left">Nothing selected</button>
      <select id="utilitySel" name="utilitySel" class="selectpicker" tabindex="-98" style="position:absolute;bottom:0;left:50%;display:block;width:0.5px;height:100%;padding:0;opacity:0;border:none">
        <option value="">Nothing selected</option><option value="u1">Sample Light Co</option>
      </select>
    </div>
    <label for="heldSlot" style="position:absolute;left:170px;top:34px;font-size:11px">Plan set *</label>
    <input id="heldSlot" name="heldSlot" type="file" style="position:absolute;left:170px;top:54px;width:122px;height:26px;box-sizing:border-box">
    <span style="${ERR};left:300px;top:58px">This field is required.</span>`,
  // A full-width (960 px) Bootstrap .form-control-file slot, then "Meter location [select] This field
  // is required." on the line under it.
  heldAboveMeter: `
    <label for="heldSlot" style="position:absolute;left:8px;top:0">Plan set *</label>
    <input id="heldSlot" name="heldSlot" type="file" class="form-control-file" style="position:absolute;left:8px;top:20px;width:960px;height:30px;box-sizing:border-box">
    <label for="meterLoc" style="position:absolute;left:8px;top:54px">Meter location</label>
    <select id="meterLoc" name="meterLoc" style="position:absolute;left:120px;top:54px;width:190px;height:19px"><option value="">Please select...</option><option>Garage wall</option></select>
    <span style="${ERR};left:314px;top:54px">This field is required.</span>`,
  // The complaint under the held slot itself; nothing else on the page is empty.
  heldOwnComplaint: `
    <label for="heldSlot" style="position:absolute;left:8px;top:0">Plan set *</label>
    <input id="heldSlot" name="heldSlot" type="file" style="position:absolute;left:8px;top:20px;width:300px;height:26px;box-sizing:border-box">
    <span style="${ERR};left:8px;top:50px">This field is required.</span>`,
  // TWO SLOTS SHARING A CAPTION (#327, should-fix 6). Both "Attachment *", both uploaded; Customer
  // phone blank, its complaint on the SECOND slot's line and nearer that slot. The sweep reports
  // one "Attachment" entry (the first slot's asterisk); the second slot's hand-off must ride on it.
  heldDupAttachment: `
    <label for="heldSlot" style="position:absolute;left:8px;top:0">Attachment *</label>
    <input id="heldSlot" name="heldSlot" type="file" style="position:absolute;left:8px;top:20px;width:150px;height:26px;box-sizing:border-box">
    <label for="custPhone" style="position:absolute;left:300px;top:0">Customer phone</label>
    <input id="custPhone" name="custPhone" type="text" style="position:absolute;left:300px;top:20px;width:185px;height:21px;box-sizing:border-box">
    <label for="heldSlot2" style="position:absolute;left:200px;top:46px;font-size:11px">Attachment *</label>
    <input id="heldSlot2" name="heldSlot2" type="file" style="position:absolute;left:200px;top:60px;width:92px;height:26px;box-sizing:border-box">
    <span style="${ERR};left:300px;top:72px">This field is required.</span>`,
  // A HELD RUNNER-UP (#327, should-fix 7). "Plan set *" and the optional "Site photo", both
  // uploaded; the complaint sits on their line just after Plan set, with Site photo the runner-up.
  heldPlanSiteLine: `
    <label for="heldSlot" style="position:absolute;left:8px;top:0">Plan set *</label>
    <input id="heldSlot" name="heldSlot" type="file" style="position:absolute;left:8px;top:20px;width:150px;height:26px;box-sizing:border-box">
    <span style="${ERR};left:164px;top:25px">This field is required.</span>
    <label for="siteSlot" style="position:absolute;left:400px;top:0">Site photo</label>
    <input id="siteSlot" name="siteSlot" type="file" style="position:absolute;left:400px;top:20px;width:150px;height:26px;box-sizing:border-box">`,
  // ...and a documents row: both uploaded, a stale complaint left under Plan set.
  heldDocumentsRow: `
    <div style="display:flex;gap:24px">
      <div style="width:260px"><label for="heldSlot">Plan set *</label><br><input id="heldSlot" name="heldSlot" type="file">
        <div style="color:#c00">This field is required.</div></div>
      <div style="width:260px"><label for="siteSlot">Site photo</label><br><input id="siteSlot" name="siteSlot" type="file"></div>
    </div>`,
  // A RADIO GROUP IN THE HELD SLOT'S ROW (#327, should-fix 8). The group is named by the row's text,
  // which carries "Plan set", so it read as the held upload and was discharged with it.
  heldGridTiedRow: `
    <div style="display:flex;gap:12px;align-items:center">
      <label for="heldSlot">Plan set *</label><input id="heldSlot" name="heldSlot" type="file">
      <span>Is the system grid-tied? *</span>
      <label><input type="radio" name="gridTied" value="yes"> Yes</label>
      <label><input type="radio" name="gridTied" value="no"> No</label>
    </div>`,
  // A HELD UPLOAD DISCHARGES ONLY A FILE BOX (#327 round 4, should-fix 5). A required text box
  // whose caption carries the slot's name — "Plan set revision *" in the slot's row, the same box
  // under the slot, a box captioned exactly "Plan set *" — is a blank, not the held upload.
  heldRevisionInRow: `
    <div style="display:flex;gap:12px;align-items:center">
      <label for="heldSlot">Plan set *</label><input id="heldSlot" name="heldSlot" type="file">
      <label for="planRev">Plan set revision *</label><input id="planRev" name="planRev" type="text">
    </div>`,
  heldRevisionBelow: `
    <label for="heldSlot" style="position:absolute;left:8px;top:0">Plan set *</label>
    <input id="heldSlot" name="heldSlot" type="file" style="position:absolute;left:8px;top:20px;width:300px;height:26px;box-sizing:border-box">
    <label for="planRev" style="position:absolute;left:8px;top:54px">Plan set revision *</label>
    <input id="planRev" name="planRev" type="text" style="position:absolute;left:8px;top:74px;width:185px;height:21px;box-sizing:border-box">`,
  heldSameNameBox: `
    <label for="heldSlot" style="position:absolute;left:8px;top:0">Plan set *</label>
    <input id="heldSlot" name="heldSlot" type="file" style="position:absolute;left:8px;top:20px;width:300px;height:26px;box-sizing:border-box">
    <label for="planNote" style="position:absolute;left:8px;top:54px">Plan set *</label>
    <input id="planNote" name="planNote" type="text" style="position:absolute;left:8px;top:74px;width:185px;height:21px;box-sizing:border-box">`,
  // A RADIO GROUP THE SWEEP CANNOT NAME, its complaint on the held slot's line (#327 round 4,
  // should-fix 6): unmarked, then with `required` radios (the form is novalidate, so the browser
  // does not refuse the POST for the run).
  heldRadioOnLine: `
    <label for="heldSlot" style="position:absolute;left:8px;top:0">Plan set *</label>
    <input id="heldSlot" name="heldSlot" type="file" style="position:absolute;left:8px;top:20px;width:150px;height:26px;box-sizing:border-box">
    <span style="${ERR};left:164px;top:25px">This field is required.</span>
    <div style="position:absolute;left:400px;top:0">Battery storage?<br><label><input type="radio" name="bat" value="y"> Yes</label> <label><input type="radio" name="bat" value="n"> No</label></div>`,
  heldRequiredRadioOnLine: `
    <label for="heldSlot" style="position:absolute;left:8px;top:0">Plan set *</label>
    <input id="heldSlot" name="heldSlot" type="file" style="position:absolute;left:8px;top:20px;width:150px;height:26px;box-sizing:border-box">
    <span style="${ERR};left:164px;top:25px">This field is required.</span>
    <div style="position:absolute;left:400px;top:0">Battery storage?<br><label><input type="radio" name="bat" value="y" required> Yes</label> <label><input type="radio" name="bat" value="n" required> No</label></div>`,
};
// A SELECT2 UTILITY (#327, blocking 2): select2 4 keeps the native <select> as a 1 x 1 clipped
// sliver (select2-hidden-accessible) and draws its face as a SIBLING, so the sliver's nearest box is
// the whole form-group: label, face, complaint and help text. Bootstrap 4's own metrics (16 px root,
// line-height 1.5, 80 % feedback and help text, .25rem margins), inlined; no asterisk and no
// `required`; a filled "Service address" above. Main named Utility; 9807442c judged the sliver by
// that box alone, which ends 42.4 px (40.4 in the crispy wrapper) below the complaint's top — past
// the -40 bound — and the complaint went to Service address and was dropped.
const BS4 = `<style>
  .bs4{font:16px/1.5 sans-serif;width:600px} .bs4 *,.bs4 *::before,.bs4 *::after{box-sizing:border-box}
  .bs4 .form-group{margin-bottom:1rem} .bs4 label{display:inline-block;margin-bottom:.5rem}
  .bs4 .form-control{display:block;width:100%;height:calc(1.5em + .75rem + 2px);padding:.375rem .75rem;font-size:1rem;line-height:1.5;border:1px solid #ced4da}
  .bs4 .invalid-feedback{display:none;width:100%;margin-top:.25rem;font-size:80%;color:#dc3545} .bs4 .d-block{display:block!important}
  .bs4 small{font-size:80%} .bs4 .form-text{display:block;margin-top:.25rem}
  .bs4 .select2-container{display:inline-block;margin:0;position:relative;vertical-align:middle}
  .bs4 .select2-selection--single{display:block;height:calc(1.5em + .75rem + 2px);border:1px solid #ced4da;padding:.375rem .75rem}
  .select2-hidden-accessible{border:0!important;clip:rect(0 0 0 0)!important;clip-path:inset(50%)!important;height:1px!important;overflow:hidden!important;padding:0!important;position:absolute!important;width:1px!important;white-space:nowrap!important}
</style>`;
const S2_SELECT = `<select id="utilitySel" name="utilitySel" class="form-control select2-hidden-accessible is-invalid" tabindex="-1" aria-hidden="true"><option value=""></option><option value="u1">Sample Light Co</option></select>`;
const S2_FACE = `<span class="select2 select2-container select2-container--bootstrap4" dir="ltr" style="width:100%"><span class="selection"><span class="select2-selection select2-selection--single" role="combobox" tabindex="0" aria-labelledby="select2-utilitySel-container"><span class="select2-selection__rendered" id="select2-utilitySel-container" role="textbox" aria-readonly="true"><span class="select2-selection__placeholder">Select a utility</span></span><span class="select2-selection__arrow" role="presentation"><b role="presentation"></b></span></span></span><span class="dropdown-wrapper" aria-hidden="true"></span></span>`;
const S2_ADDRESS = `<div class="form-group"><label for="svcAddr">Service address</label><input id="svcAddr" name="svcAddr" class="form-control" value="5010 Fixture Ave"></div>`;
const S2_HELP = `<small class="form-text text-muted">The utility that serves the meter.</small>`;
const SELECT2_LAYOUT: Record<string, string> = {
  // Bootstrap 4: label, select, face, .invalid-feedback, one .form-text line.
  select2Bs4Utility: `${S2_ADDRESS}<div class="form-group"><label for="utilitySel">Utility</label>${S2_SELECT}${S2_FACE}<div class="invalid-feedback d-block">This field is required.</div>${S2_HELP}</div>`,
  // django-crispy-forms: the error (a <strong> in a span) then the help, in a bare wrapper div.
  // The filled Service address sits within 90 px of the complaint (its group's bottom margin
  // dropped), so a filled neighbour in reach can claim it: the 0-POST check, not only the naming
  // check, guards the sliver's widget box (#327 round 4 nit).
  select2CrispyUtility: `${S2_ADDRESS.replace('class="form-group"', 'class="form-group" style="margin-bottom:0"')}<div id="div_id_utilitySel" class="form-group"><label for="utilitySel">Utility</label><div>${S2_SELECT}${S2_FACE}<span id="error_1_id_utilitySel" class="invalid-feedback d-block"><strong>This field is required.</strong></span>${S2_HELP}</div></div>`,
};
// A FILLED select2 Utility with no per-field wrapper, a direct child of its fieldset (or a card),
// beside a blank the sweep cannot see — an unmarked Yes/No, an unticked checkbox, an empty Kendo
// DropDownList (its <select> is display:none) — with "This field is required." at the foot, 137 px
// below Utility's own rect. Judged by its widget box (the fieldset), 6eed71c9 handed the complaint
// to the filled Utility and dropped it: the draft was created. Main stops it as unattributed.
const S2_FILLED_SELECT = S2_SELECT.replace(' is-invalid', "").replace('<option value="u1">', '<option value="u1" selected>');
const S2_FILLED_FACE = S2_FACE.replace('<span class="select2-selection__placeholder">Select a utility</span>', "Sample Light Co");
const S2_NOTE = `<p style="height:60px;margin:8px 0">Battery details are asked on the next page.</p>`;
const S2_FOOT = `<div class="invalid-feedback d-block">This field is required.</div>`;
const KENDO_DDL = `<span class="k-widget k-dropdown" style="display:inline-block;width:240px;border:1px solid #ccc"><span class="k-dropdown-wrap"><span class="k-input">Select a rate</span><span class="k-select"><span class="k-icon k-i-arrow-60-down"></span></span></span><select id="rateSel" name="rateSel" data-role="dropdownlist" style="display:none"><option value=""></option><option value="r7">Schedule 7</option></select></span>`;
SELECT2_LAYOUT.s2FieldsetRadio = `<fieldset style="border:1px solid #ccc;padding:0 8px 4px"><legend>Utility information</legend><label for="utilitySel">Utility</label>${S2_FILLED_SELECT}${S2_FILLED_FACE}${S2_NOTE}<div>Battery storage? <label><input type="radio" name="bat" value="y"> Yes</label> <label><input type="radio" name="bat" value="n"> No</label></div>${S2_FOOT}</fieldset>`;
SELECT2_LAYOUT.s2FieldsetCheckbox = `<fieldset style="border:1px solid #ccc;padding:0 8px 4px"><legend>Utility information</legend><label for="utilitySel">Utility</label>${S2_FILLED_SELECT}${S2_FILLED_FACE}${S2_NOTE}<div><label><input type="checkbox" name="agree"> I agree to the interconnection terms</label></div>${S2_FOOT}</fieldset>`;
SELECT2_LAYOUT.s2CardKendo = `<div class="card"><div class="card-body" style="border:1px solid #ccc;padding:8px"><label for="utilitySel">Utility</label>${S2_FILLED_SELECT}${S2_FILLED_FACE}${S2_NOTE}<div><label>Rate schedule</label> ${KENDO_DDL}</div>${S2_FOOT}</div></div>`;
const heldBlock = (mode: string): string => HELD_LAYOUT[mode]
  ? `<div style="position:relative;height:120px;margin:12px 0">${HELD_LAYOUT[mode]}</div><div id="heldList" style="margin:8px 0"></div>${HELD_SCRIPT}`
  : SELECT2_LAYOUT[mode] ? `${BS4}<div class="bs4">${SELECT2_LAYOUT[mode]}</div>` : "";
const ERROR = page("Error", `<h1>Error</h1><p>An error has occurred. Please try again later.</p>`);

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);
  const mode = parts[0] === "m" ? parts[1] || "" : "";
  const rest = parts.slice(2).join("/");
  const send = (html: string): void => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); };
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    posts.push({ mode, path: url.pathname });
    if (rest === "p1/submit") { send(mode === "receipt" ? RECEIPT : mode === "error" ? ERROR : DRAFT_PAGE); return; }
    send(page("OK", "<p>ok</p>"));
    return;
  }
  if (rest === "part1") { send(PART1(mode)); return; }
  send(page("Program Home", "<h1>Program Home</h1>"));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const TENANT = draftTenantKey(base);

// The backend's stamp for the run: the Submit is step index 4 of recipeFor(...).
const stamp = (tenantKey = TENANT, stepIndex = 4): DraftCreatingStamp => ({ stepIndex, tenantKey, label: "Submit", healedAt: "2026-10-16T00:00:00.000Z" });
const submitStep = (over: Partial<RecipeStep> = {}): RecipeStep => ({
  action: "click", selector: { css: "#btnSubmit", text: "Submit" }, note: "final submit | creates a draft, not the filing (#302)", ...over,
} as RecipeStep);
// The held-upload cases upload into the required slot before the review stop, which moves the
// Submit to step index 5.
const UPLOAD_STEP = { action: "upload", selector: { css: "#heldSlot" }, docType: "plan_set", viaFileChooser: false, note: "upload plan_set: Plan set" } as RecipeStep;
const HELD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "draft-held-"));
const PLAN_SET = path.join(HELD_DIR, "plan-set.pdf");
fs.writeFileSync(PLAN_SET, "%PDF-1.4\n%%EOF\n");
const SITE_PHOTO = path.join(HELD_DIR, "site-photo.pdf");
fs.writeFileSync(SITE_PHOTO, "%PDF-1.4\n%%EOF\n");
const ATTACHMENT_2 = path.join(HELD_DIR, "attachment-two.pdf");
fs.writeFileSync(ATTACHMENT_2, "%PDF-1.4\n%%EOF\n");
const SITE_STEP = { action: "upload", selector: { css: "#siteSlot" }, docType: "site_photo", viaFileChooser: false, note: "upload site_photo: Site photo" } as RecipeStep;
const ATTACH_STEPS = [
  { action: "upload", selector: { css: "#heldSlot" }, docType: "plan_set", viaFileChooser: false, note: "upload plan_set: Attachment" } as RecipeStep,
  { action: "upload", selector: { css: "#heldSlot2" }, docType: "other_attachment", viaFileChooser: false, note: "upload other_attachment: Attachment" } as RecipeStep,
];
const recipeFor = (mode: string, last: RecipeStep, before: RecipeStep[] = []): PortalRecipe => ({
  id: `draft-submit-${mode}`, scopeType: "utility", profileKey: "wa||twopart", state: "WA", ahj: "", utility: "Two-Part Utility",
  portalPlatform: "fixture", portalUrl: `${base}/m/${mode}/part1`, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
  steps: [
    { action: "goto", value: `${base}/m/${mode}/part1`, note: "open Part 1" } as RecipeStep,
    { action: "fill", selector: { css: "#appDate", label: "Application Date" }, value: "10/16/2026", note: "Application Date" } as RecipeStep,
    { action: "select", selector: { css: "#appType", label: "Application Type" }, value: "New Solar", note: "Application Type" } as RecipeStep,
    ...before,
    { action: "stopForReview" } as RecipeStep,
    last,
  ],
} as PortalRecipe);

let seq = 0;
interface Outcome { r: Record<string, unknown>; posts: string[] }
async function stage(mode: string, last: RecipeStep, opts: { env?: string; stamp?: DraftCreatingStamp | null; autoSubmit?: boolean; approve?: boolean; before?: RecipeStep[]; docs?: Record<string, string> } = {}): Promise<Outcome> {
  const prev = process.env.PORTAL_ALLOW_FINAL_SUBMIT;
  if (opts.env === undefined) delete process.env.PORTAL_ALLOW_FINAL_SUBMIT; else process.env.PORTAL_ALLOW_FINAL_SUBMIT = opts.env;
  const before = posts.length;
  try {
    const runId = `run-${mode}-${++seq}`;
    const r = await stageWithRecipe(recipeFor(mode, last, opts.before ?? []), { id: `p-${mode}` } as ProjectRecord, {}, opts.docs ?? {}, [], {
      headless: true, runId, draftSubmitStamp: opts.stamp === undefined ? stamp() : opts.stamp,
      autoSubmit: opts.autoSubmit === true, runApproval: opts.approve ? { approver: "A. Operator", runId } : null,
    });
    await new Promise((res) => setTimeout(res, 300));
    return { r, posts: posts.slice(before).map((p) => p.path) };
  } finally {
    if (prev === undefined) delete process.env.PORTAL_ALLOW_FINAL_SUBMIT; else process.env.PORTAL_ALLOW_FINAL_SUBMIT = prev;
  }
}
const msgOf = (r: Record<string, unknown>): string => {
  const steps = Array.isArray(r.steps) ? (r.steps as Array<{ message?: unknown }>) : [];
  return [String(r.message ?? ""), ...steps.map((s) => String(s?.message ?? ""))].filter(Boolean).join(" | ");
};
const brief = (o: Outcome): string => `posts=${JSON.stringify(o.posts)} ok=${String(o.r.ok)} clicked=${String(o.r.finalSubmitClicked)} pause=${String(o.r.pauseReason)} permit=${String(o.r.capturedPermitNumber)} draft=${JSON.stringify(o.r.draftCreatedByReplay ?? null)} incident=${JSON.stringify(o.r.draftSubmitUnexpected ?? null)} msg=${msgOf(o.r).slice(0, 500)}`;
const submits = (o: Outcome): number => o.posts.filter((p) => /\/p1\/submit$/.test(p)).length;
const draftOf = (o: Outcome) => (o.r.draftCreatedByReplay ?? null) as { applicationNumber?: string; nextForm?: string; tenantKey?: string; clickedLabel?: string } | null;
const incidentOf = (o: Outcome) => (o.r.draftSubmitUnexpected ?? null) as { verdict?: string } | null;

try {
  {
    const o = await stage("draft", submitStep());
    const d = draftOf(o);
    check("draft: the stamped Submit is clicked ONCE and the page reads as the draft it made", submits(o) === 1 && d?.applicationNumber === "NEM-90017" && d?.nextForm === "Interconnection Application - Part 2", brief(o));
    check("draft: nothing reads as filed — finalSubmitClicked false, no record number, the run staged ok", o.r.finalSubmitClicked === false && !o.r.capturedPermitNumber && !o.r.capturedConfirmationNumber && o.r.ok === true && !o.r.pauseReason, brief(o));
    check("draft: the draft carries the tenant it was made on and the label clicked", d?.tenantKey === TENANT && d?.clickedLabel === "Submit", brief(o));
  }
  {
    const o = await stage("draftApproved", submitStep(), { env: "1", autoSubmit: true, approve: true });
    check("draftApproved: the switch, autoSubmit and an approval change nothing — one click, a draft, never a filing", submits(o) === 1 && draftOf(o)?.applicationNumber === "NEM-90017" && o.r.finalSubmitClicked === false, brief(o));
  }
  {
    const forged = submitStep({ draftCreatingSubmit: { tenantKey: TENANT, label: "Submit", healedAt: "2026-10-16T00:00:00.000Z" } } as unknown as Partial<RecipeStep>);
    const o = await stage("neverHealed", forged, { env: "1", autoSubmit: true, approve: true, stamp: null });
    check("neverHealed: no stamp for the run, never clicked — switch on, autoSubmit, approval and a stamp field forged on the step (0 POSTs)", submits(o) === 0 && !draftOf(o) && o.r.finalSubmitClicked === false, brief(o));
  }
  {
    const o = await stage("otherTenant", submitStep(), { stamp: stamp("another-utility.powerclerk.example") });
    check("otherTenant: a stamp seen on another tenant is never clicked here (0 POSTs)", submits(o) === 0 && !draftOf(o), brief(o));
  }
  {
    const o = await stage("stampMoved", submitStep(), { stamp: stamp(TENANT, 2) });
    check("stampMoved: a stamp naming another step never clicks the Submit (0 POSTs)", submits(o) === 0 && !draftOf(o) && o.r.finalSubmitClicked === false, brief(o));
  }
  {
    const o = await stage("flagged", submitStep({ isFinalSubmit: true }));
    check("flagged: a stamped step still flagged isFinalSubmit goes only to the final-submit gate, which refuses (0 POSTs)", submits(o) === 0 && !draftOf(o) && o.r.finalSubmitClicked === false, brief(o));
  }
  {
    const o = await stage("receipt", submitStep());
    check("receipt: a filing page after the click stops the run as the incident", submits(o) === 1 && o.r.pauseReason === "draft_submit_unexpected" && incidentOf(o)?.verdict === "filed", brief(o));
    check("receipt: the track does not read as filed — finalSubmitClicked false, no record number, no draft", o.r.finalSubmitClicked === false && !o.r.capturedPermitNumber && !o.r.capturedConfirmationNumber && !draftOf(o) && o.r.ok === false, brief(o));
    check("receipt: the run says the portal may have filed and a person must check", /MAY HAVE FILED/.test(msgOf(o.r)), brief(o));
  }
  {
    const o = await stage("error", submitStep());
    check("error: an error page after the click stops the run as the incident (not a draft)", submits(o) === 1 && o.r.pauseReason === "draft_submit_unexpected" && incidentOf(o)?.verdict === "not_a_draft" && o.r.finalSubmitClicked === false && !draftOf(o), brief(o));
  }
  // A REQUIRED FIELD LEFT BLANK BESIDE A HELD UPLOAD (#327): never a draft, and the blank is named.
  const held = (mode: string, uploads: RecipeStep[] = [UPLOAD_STEP]) => stage(mode, submitStep(), {
    stamp: stamp(TENANT, 4 + uploads.length), before: uploads, docs: { plan_set: PLAN_SET, site_photo: SITE_PHOTO, other_attachment: ATTACHMENT_2 },
  });
  const notesOf = (o: Outcome): string[] => (Array.isArray(o.r.steps) ? (o.r.steps as Array<{ data?: { agingNotes?: unknown } }>) : [])
    .flatMap((st) => (Array.isArray(st?.data?.agingNotes) ? (st.data!.agingNotes as unknown[]).map(String) : []));
  const heldNote = (o: Outcome): string => notesOf(o).find((n) => /file box reads empty/.test(n)) ?? "";
  const refusalOf = (o: Outcome): string => notesOf(o).find((n) => /draft-creating submit left for a person/.test(n)) ?? "";
  for (const [mode, field, re] of [
    ["heldLeftOfPhone", "Customer phone", /still empty on the page: .*Customer phone/],
    ["heldBesideUtility", "Utility", /still empty on the page: .*\bUtility\b/],
    ["heldAboveMeter", "Meter location", /still empty on the page: .*Meter location/],
    ["heldOwnComplaint", "the portal's complaint (unattributed)", /still empty on the page: .*portal reports "This field is required\."/],
  ] as Array<[string, string, RegExp]>) {
    const o = await held(mode);
    check(`${mode}: the upload held (the page lists it, the box reads empty) — the fixture is the shape it claims`, /Plan set/.test(heldNote(o)), `${brief(o)} aging=${JSON.stringify(notesOf(o)).slice(0, 600)}`);
    check(`${mode}: ${field} is blank and the portal says so — the draft is NOT created (0 POSTs)`, submits(o) === 0 && !draftOf(o) && o.r.finalSubmitClicked === false, brief(o));
    check(`${mode}: the run names ${field} as the required field still empty`, re.test(refusalOf(o)), `refusal=${refusalOf(o)} | ${brief(o)}`);
  }
  // The held-upload follow-ups (#327 round 3): a shared caption, a held runner-up, a radio group in
  // the held slot's row. Each 0 POSTs and the right blank named; `never` must not be named.
  for (const [mode, uploads, slot, field, re, never] of [
    ["heldDupAttachment", ATTACH_STEPS, /Attachment/, "Customer phone", /still empty on the page: .*Customer phone/, null],
    ["heldPlanSiteLine", [UPLOAD_STEP, SITE_STEP], /Plan set/, "the portal's complaint (unattributed)", /still empty on the page: .*portal reports "This field is required\."/, /Site photo/],
    ["heldDocumentsRow", [UPLOAD_STEP, SITE_STEP], /Plan set/, "the portal's complaint (unattributed)", /still empty on the page: .*portal reports "This field is required\."/, /Site photo/],
    ["heldGridTiedRow", [UPLOAD_STEP], /Plan set/, "the grid-tied radio group", /still empty on the page: .*grid-tied/, null],
  ] as Array<[string, RecipeStep[], RegExp, string, RegExp, RegExp | null]>) {
    const o = await held(mode, uploads);
    check(`${mode}: the upload held (the page lists it, the box reads empty) — the fixture is the shape it claims`, slot.test(heldNote(o)), `${brief(o)} aging=${JSON.stringify(notesOf(o)).slice(0, 600)}`);
    check(`${mode}: ${field} is blank and the portal says so — the draft is NOT created (0 POSTs)`, submits(o) === 0 && !draftOf(o) && o.r.finalSubmitClicked === false, brief(o));
    check(`${mode}: the run names ${field} as the required field still empty${never ? `, never ${never.source}` : ""}`, re.test(refusalOf(o)) && !(never && never.test(refusalOf(o))), `refusal=${refusalOf(o)} | ${brief(o)}`);
  }
  // A held upload discharges only a file box (#327 round 4, should-fix 5): 0 POSTs, the box named.
  for (const [mode, field, re] of [
    ["heldRevisionInRow", "Plan set revision", /still empty on the page: .*Plan set revision/],
    ["heldRevisionBelow", "Plan set revision", /still empty on the page: .*Plan set revision/],
    ["heldSameNameBox", "the text box captioned \"Plan set *\"", /still empty on the page: .*Plan set/],
  ] as Array<[string, string, RegExp]>) {
    const o = await held(mode);
    check(`${mode}: ${field} is blank beside the held upload — the draft is NOT created (0 POSTs)`, submits(o) === 0 && !draftOf(o) && o.r.finalSubmitClicked === false, brief(o));
    check(`${mode}: the run names ${field} as the required field still empty`, re.test(refusalOf(o)), `refusal=${refusalOf(o)} | ${brief(o)}`);
  }
  // A radio group the sweep cannot name, its complaint on the held slot's line (#327 round 4,
  // should-fix 6): the complaint is reported unattributed, never as the held Plan set.
  for (const mode of ["heldRadioOnLine", "heldRequiredRadioOnLine"]) {
    const o = await held(mode);
    check(`${mode}: the upload held — the fixture is the shape it claims`, /Plan set/.test(heldNote(o)), `${brief(o)} aging=${JSON.stringify(notesOf(o)).slice(0, 600)}`);
    check(`${mode}: an unanswered radio group flagged on the held slot's line — the draft is NOT created (0 POSTs), the run stops before review`, submits(o) === 0 && !draftOf(o) && o.r.finalSubmitClicked === false && o.r.pauseReason === "stopped_before_review", brief(o));
    check(`${mode}: the run names the portal's complaint (unattributed), never Plan set`, /still empty on the page: .*portal reports "This field is required\."/.test(refusalOf(o)) && !/Plan set/.test(refusalOf(o)), `refusal=${refusalOf(o)} | ${brief(o)}`);
  }
  // A SELECT2 UTILITY LEFT BLANK (#327, blocking 2): no upload; the sliver's widget box (the whole
  // form-group) must never push its complaint out of reach. 0 POSTs, Utility named.
  for (const mode of ["select2Bs4Utility", "select2CrispyUtility"]) {
    const o = await stage(mode, submitStep());
    check(`${mode}: Utility (select2, blank, flagged under its face) — the draft is NOT created (0 POSTs)`, submits(o) === 0 && !draftOf(o) && o.r.finalSubmitClicked === false, brief(o));
    check(`${mode}: the run names Utility as the required field still empty`, /still empty on the page: .*\bUtility\b/.test(refusalOf(o)), `refusal=${refusalOf(o)} | ${brief(o)}`);
  }
  // A FILLED select2 never absorbs a complaint for a blank the sweep cannot see (#327 round 4).
  for (const mode of ["s2FieldsetRadio", "s2FieldsetCheckbox", "s2CardKendo"]) {
    const o = await stage(mode, submitStep());
    check(`${mode}: a blank beside a filled select2 Utility, flagged at the foot — the draft is NOT created (0 POSTs)`, submits(o) === 0 && !draftOf(o) && o.r.finalSubmitClicked === false, brief(o));
    check(`${mode}: the run names the portal's complaint (unattributed), never Utility`, /still empty on the page: .*portal reports "This field is required\."/.test(refusalOf(o)) && !/\bUtility\b/.test(refusalOf(o)), `refusal=${refusalOf(o)} | ${brief(o)}`);
  }
} finally {
  server.close();
}
if (failures) { console.error(`\n${failures} draft-submit click check(s) FAILED.`); process.exit(1); }
console.log("\nAll draft-submit click checks passed (real Chromium).");
process.exit(0);
