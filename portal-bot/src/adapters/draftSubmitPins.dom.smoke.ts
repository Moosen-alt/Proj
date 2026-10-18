// THE HELM'S ROUND-3 SHAPES FOR THE STAMPED DRAFT CLICK (#362, review of 4081f12).
//
// draftSubmitFilled.dom.smoke.ts pins the design; this pins each way round it the Helm reproduced,
// and each false stop, one synthetic Part 1 page per mode. The same rules hold (owner rulings
// 2026-10-17 "Stop for me" and 2026-10-18 "Data is enough"): an answer automation PICKED with no
// project data behind it stops the stamped draft-creating Submit like a review stop (0 POSTs, the
// stamp kept, no incident); an answer straight from the project's data goes ahead; a control whose
// question reads as submitting is never written, wherever its question sits.
//
//   BLOCKING 1 — a pick survives its control being re-created or removed (MUST-STOP)
//     remountName      "advance: Continue" re-mounts the picked select under a new id, same name
//     revisitVolatile  Next, then a goto back to Part 1, which the server renders under new ids
//     remountPc        a PowerClerk-style pcInputBaseN id with no name, renumbered on re-mount
//     volatileId       a synchronous re-render under a new id, the gap-fill inside the draft click
//     dialogRemoved    an in-page dialog copies its answer to a hidden input and is removed on Save
//   BLOCKING 2 — data only when the answer that LANDS is the project's value
//     MUST-STOP  notesSelect (No "traced" into the design notes), wrongRadio (the No radio through
//                gridTied=Yes), fuzzySelect ("Yes" landing on "Yes, grid-tied with battery backup"),
//                looseTrace (a terms box "on" through a company name), typedYes (unbound "YES"),
//                unboundText ("200" inside "1200 Elm St"), modules2 (a -405/M module for -410/M, two rows)
//     MUST-PASS  boundRadioNo (the No radio through gridTied=No), unboundCopy (an exact project value)
//   BLOCKING 3 — the ready-to-submit question, wherever it sits, is never written (READY never
//                touched, no request carries it)
//     boundTableTh, boundSectionLegend, boundSelectAbove, selectLabelledBy, rnoidPart1 (on Part 1, the
//     planner binding its Yes to a project field); radioSpanEarlier, selectLabelledByEarly,
//     rnoidEarly2, miamiEarlier (on an earlier page); misroute and reassertBound (a re-assert whose
//     recorded label resolves to the ready select)
//   SHOULD-FIX
//     SF2  spaPlain (a single-document "Proceed to Part 1" carries view 1's literal) and revisitRe
//          (a re-assert pick, then a revisit) MUST-STOP; advRerender (an advance-worded reveal that
//          re-renders Part 1's own value) MUST-PASS
//     SF4  radioBlankStall: a counted radio-group blank is never re-run from another page's select
//     SF5  readyCheckbox: a required "I am ready to submit" box is a blank — a review stop, no incident
//     SF6  finishGap, finishRe, millGap, millRe, roofFinishGap: permit MUST-PASS, "finish" is not submit
//     SF7  overwritePick and contactAfterGap MUST-PASS (the recording overwrites the pick); notLanded
//          MUST-STOP (the recorded step that would have overwritten it does not land)
//     SF8  sharedLabel (Part 1's own Email step wins over an earlier page's) and reloadOwn (a same-URL
//          reload) MUST-PASS
//     SF9  earlierPick: an unbound pick on an EARLIER page, then a real navigation to Part 1
//
// Real Chromium through stageWithRecipe (the network backstop and the LLM gap-fill enabled), synthetic
// pages on 127.0.0.1 (never a real portal; every name, company and address is fictional), a stub
// planner. Every non-GET the server receives is counted, and every change event is beaconed back.
//
// Run: npx tsx portal-bot/src/adapters/draftSubmitPins.dom.smoke.ts [--only <mode>]
import "../smokeArtifactDirs";
import http from "node:http";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { stageWithRecipe } from "../index";
import type { DraftCreatingStamp } from "../draftSubmitGate";
import { draftTenantKey } from "../draftSubmitGate";
import type { LearnPlanRequest, LearnPlanResponse } from "./autoLearnAdapter";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
process.env.AUTOLEARN_SAVE_SETTLE_MS = "1";
process.env.PORTAL_HEADLESS = "true";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// Is an AI pick on an EARLIER page of the application also a reason to stop (the owner's open card)?
// false = "Submit page only" (today); flip with the owner's "Whole application".
const WHOLE_APPLICATION = false;

const AGREE = "Do you agree to the terms of the Interconnection Agreement?";
const READY = "Are you ready to submit your application?";
const GRID = "Is the system grid-tied?";
type Fill = LearnPlanResponse["fills"][number];
type Field = LearnPlanRequest["fields"][number];
interface Mode {
  /** Extra controls inside Part 1's form (visit = how many times Part 1 was served). */
  part1?: (visit: number, saved: Record<string, string>) => string;
  /** A script after Part 1's form. */
  script?: string;
  /** Part 1's own recorded steps after its Application Date. */
  steps?: (base: string) => RecipeStep[];
  /** An earlier page: its extra controls and its recorded steps (before its Next). */
  early?: { html: string; steps?: RecipeStep[] };
  /** The whole Part 1 document instead of the standard one (a single-document app). */
  doc?: (base: string) => string;
  /** The planner's answer for a field it is offered, or null. Defaults to defaultPlan. */
  plan?: (f: Field) => Omit<Fill, "selectorIndex"> | null;
  gap?: Record<string, string>;
  /** No stamp and no Submit step: a permit run that ends at its review stop. */
  permit?: boolean;
}

const step = (s: Record<string, unknown>): RecipeStep => s as unknown as RecipeStep;
const opts = (vals: string[], pick = ""): string => `<option value="">Select…</option>${vals.map((v) => `<option${pick === v ? " selected" : ""}>${v}</option>`).join("")}`;
const sel = (id: string, label: string, vals: string[], extra = "", pick = ""): string => `<div><label for="${id}">${label}</label><select id="${id}" name="${id}" ${extra}>${opts(vals, pick)}</select></div>`;
const radios = (name: string, extra = "", pick = ""): string => ["Yes", "No"].map((v) => `<input type="radio" id="${name}${v[0]}" name="${name}" value="${v}" ${extra}${pick === v ? " checked" : ""}><label for="${name}${v[0]}">${v}</label>`).join("");
const idless = (name: string, extra = ""): string => ["Yes", "No"].map((v) => `<label><input type="radio" name="${name}" value="${v}" ${extra}> ${v}</label>`).join("");
const installerBox = `<div><label for="installer">Installer Company</label><input id="installer" name="installer" type="text" required></div>`;
const reveal = `<button type="button" id="btnMore" onclick="document.getElementById('secB').style.display='block'">Show more</button><div id="secB" style="display:none"><label for="sysSize">System Size (kW)</label><input id="sysSize" name="sysSize" type="text"></div>`;
const sysSize = step({ action: "fill", selector: { css: "#sysSize", label: "System Size (kW)" }, value: "7.6", note: "System Size (kW)" });
const clickMore = (note = "Show more"): RecipeStep => step({ action: "click", selector: { css: "#btnMore", text: "Show more" }, note });
const nextToPart2 = (base: string, mode: string): RecipeStep[] => [
  step({ action: "click", selector: { css: "#btnNext", text: "Next" }, note: "advance: Next" }),
  step({ action: "goto", value: `${base}/m/${mode}/part1`, note: "open Part 1 again" }),
];
const nextBtn = (mode: string): string => `<button type="submit" id="btnNext" formmethod="get" formaction="/m/${mode}/part2">Next</button>`;
const earlySel = (id: string, label: string, value: string): RecipeStep => step({ action: "select", selector: { css: `#${id}`, label, fallbacks: [{ label }] }, value, note: label });
const earlyFill = (id: string, label: string, value: string): RecipeStep => step({ action: "fill", selector: { css: `#${id}`, label, fallbacks: [{ label }] }, value, note: label });
const remountScript = (oldId: string, newId: string, name: string | null): string => `<script>
  function remount() {
    var old = document.getElementById('${oldId}'); var v = old ? old.value : '';
    var box = document.getElementById('agreeBox');
    box.innerHTML = '<label for="${newId}">${AGREE}</label><select id="${newId}"${name ? ` name="${name}"` : ""} required>${opts(["Yes", "No"]).replace(/'/g, "\\'")}</select>';
    document.getElementById('${newId}').value = v;
    document.getElementById('secB').style.display = 'block';
  }</script>`;

// THE STUB PLANNER, by default: a Yes/No select or a "Yes" radio gets Yes (bound to a project field
// on a mode named bound*), the installer box gets the project's installer.
const defaultPlan = (mode: string) => (f: Field): Omit<Fill, "selectorIndex"> | null => {
  const bound = /^bound|^rnoidPart1|^selectLabelledBy$/.test(mode) ? { field: "agreesToTerms" } : {};
  if (f.fieldType === "select" && (f.options ?? []).includes("Yes")) return { value: "Yes", ...bound };
  if (f.fieldType === "radio" && /^yes$/i.test(String(f.label ?? "").trim())) return { value: "Yes", ...bound };
  if (/installer company/i.test(String(f.label ?? ""))) return { value: "Acme Solar", field: "installerCompany" };
  return null;
};
const labelIs = (f: Field, re: RegExp): boolean => re.test(String(f.label ?? ""));

const MODES: Record<string, Mode> = {
  // ---- BLOCKING 1 ------------------------------------------------------------------------
  remountName: {
    part1: () => `<div id="agreeBox">${sel("agree", AGREE, ["Yes", "No"], 'required')}</div><button type="button" id="btnCont" onclick="remount()">Continue</button><div id="secB" style="display:none"><label for="sysSize">System Size (kW)</label><input id="sysSize" name="sysSize" type="text"></div>`,
    script: remountScript("agree", "agree-2", "agree"),
    steps: () => [step({ action: "click", selector: { css: "#btnCont", text: "Continue" }, note: "advance: Continue" }), sysSize],
  },
  revisitVolatile: {
    part1: (visit, saved) => sel(`agree-v${visit}`, AGREE, ["Yes", "No"], "required", saved.agree ?? "") + nextBtn("revisitVolatile"),
    steps: (base) => nextToPart2(base, "revisitVolatile"),
  },
  remountPc: {
    part1: () => `<div id="agreeBox"><label for="pcInputBase7">${AGREE}</label><select id="pcInputBase7" required>${opts(["Yes", "No"])}</select></div><button type="button" id="btnCont" onclick="remount()">Continue</button><div id="secB" style="display:none"><label for="sysSize">System Size (kW)</label><input id="sysSize" name="sysSize" type="text"></div>`,
    script: remountScript("pcInputBase7", "pcInputBase9", null),
    steps: () => [step({ action: "click", selector: { css: "#btnCont", text: "Continue" }, note: "advance: Continue" }), sysSize],
  },
  volatileId: {
    part1: () => `<div id="agreeBox">${sel("agree", AGREE, ["Yes", "No"], "required")}</div>`,
    script: `<script>var n = 0; document.getElementById('agreeBox').addEventListener('change', function (e) {
      var old = e.target; if (old.tagName !== 'SELECT') return; var v = old.value; n++;
      var c = old.cloneNode(true); c.id = 'agree-x' + n; c.removeAttribute('name'); c.value = v;
      document.querySelector('label[for="' + old.id + '"]').setAttribute('for', c.id); old.replaceWith(c); });</script>`,
  },
  dialogRemoved: {
    part1: () => `<button type="button" id="btnOpen" onclick="openDlg()">Add details</button><div id="dlgHost"></div><input type="hidden" name="agreeSaved" id="agreeSaved">`,
    script: `<script>function openDlg() { document.getElementById('dlgHost').innerHTML = '<div id="dlg" role="dialog">' +
      '<label for="agree">${AGREE}</label><select id="agree" name="agree" required>${opts(["Yes", "No"]).replace(/'/g, "\\'")}</select>' +
      '<button type="button" id="dlgSave" onclick="saveDlg()">Save</button></div>'; }
      function saveDlg() { document.getElementById('agreeSaved').value = document.getElementById('agree').value; document.getElementById('dlg').remove(); }</script>`,
    // The Application Date is typed after the dialog opens, so the gap-fill runs before its Save.
    steps: () => [step({ action: "click", selector: { css: "#btnOpen", text: "Add details" }, note: "details: Add details" }),
      step({ action: "fill", selector: { css: "#appDate", label: "Application Date" }, value: "10/17/2026", note: "Application Date" }),
      step({ action: "click", selector: { css: "#dlgSave", text: "Save" }, note: "advance: Save" })],
  },
  // ---- BLOCKING 2 ------------------------------------------------------------------------
  notesSelect: {
    part1: () => sel("ground", "Is the system ground-mounted?", ["Yes", "No"], "required"),
    plan: (f) => (labelIs(f, /ground-mounted/) ? { value: "No", field: "designNotes" } : null),
    gap: { designNotes: "Roof mount facing north, 12 modules" },
  },
  wrongRadio: {
    part1: () => `<fieldset><legend>${GRID}</legend>${radios("gridTied", "required")}</fieldset>`,
    plan: (f) => (f.fieldType === "radio" && labelIs(f, /^no$/i) ? { value: "Yes", field: "gridTied" } : null),
    gap: { gridTied: "Yes" },
  },
  fuzzySelect: {
    part1: () => sel("gridSel", GRID, ["Yes, grid-tied with battery backup", "No"], "required"),
    plan: (f) => (labelIs(f, /grid-tied/) ? { value: "Yes", field: "gridTied" } : null),
    gap: { gridTied: "Yes" },
  },
  looseTrace: {
    part1: () => `<div><input type="checkbox" id="terms" name="terms" required><label for="terms">I agree to the interconnection terms</label></div>`,
    plan: (f) => (labelIs(f, /interconnection terms/) ? { value: "on", field: "installerCompanyName" } : null),
    gap: { installerCompanyName: "Acme Solar Solutions" },
  },
  typedYes: {
    part1: () => `<div><label for="batt">Battery included?</label><input id="batt" name="batt" type="text" required></div>`,
    plan: (f) => (labelIs(f, /battery included/i) ? { value: "YES" } : null),
    gap: { hasBattery: "Yes" },
  },
  unboundText: {
    part1: () => `<div><label for="panel">Main Panel Rating (A)</label><input id="panel" name="panel" type="text" required></div>`,
    plan: (f) => (labelIs(f, /main panel/i) ? { value: "200" } : null),
    gap: { siteAddress: "1200 Elm St" },
  },
  modules2: {
    part1: () => ["1", "2"].map((n) => sel(`module${n}`, `Module Model (Array ${n})`, ["ZXM7-SH108-405/M", "ZXM7-SH108-415/M"], "required")).join(""),
    plan: (f) => (labelIs(f, /module model/i) ? { value: "ZXM7-SH108-405/M", field: "moduleModel" } : null),
    gap: { moduleModel: "ZXM7-SH108-410/M" },
  },
  boundRadioNo: {
    part1: () => `<fieldset><legend>${GRID}</legend>${radios("gridTied", "required")}</fieldset>`,
    plan: (f) => (f.fieldType === "radio" && labelIs(f, /^no$/i) ? { value: "Yes", field: "gridTied" } : null),
    gap: { gridTied: "No" },
  },
  unboundCopy: {
    part1: () => installerBox,
    plan: (f) => (labelIs(f, /installer company/i) ? { value: "Acme Solar" } : null),
    gap: { installerCompany: "Acme Solar" },
  },
  // ---- BLOCKING 3 ------------------------------------------------------------------------
  boundTableTh: { part1: () => `<table><tr><th>${READY}</th><td>${radios("readyR", "required")}</td></tr></table>${installerBox}` },
  boundSectionLegend: { part1: () => `<fieldset><legend>Application</legend><div class="form-group"><div class="control-label">${READY}</div>${radios("readyR", "required")}</div></fieldset>${installerBox}` },
  boundSelectAbove: { part1: () => `<div><p><strong>${READY}</strong></p><select id="readyS" name="readyS" required>${opts(["Yes", "No"])}</select></div>${installerBox}` },
  selectLabelledBy: { part1: () => `<div id="q1">${READY}</div><select id="readyS" name="readyS" aria-labelledby="q1" required>${opts(["Yes", "No"])}</select>${installerBox}` },
  selectLabelledByEarly: { early: { html: `<div id="q1">${READY}</div><select id="readyS" name="readyS" aria-labelledby="q1">${opts(["Yes", "No"])}</select>${installerBox}` } },
  radioSpanEarlier: { early: { html: `<div class="row"><span>${READY}</span>${radios("readyR")}</div>${installerBox}` } },
  rnoidEarly2: { early: { html: `<div class="row"><span>${READY}</span>${idless("readyR")}</div><div class="row"><span>${GRID}</span>${idless("gridTied")}</div>${installerBox}` } },
  rnoidPart1: { part1: () => `<div class="row"><span>${READY}</span>${idless("readyR")}</div><div class="row"><span>${GRID}</span>${idless("gridTied", "required")}</div>`, gap: { agreesToTerms: "Yes" } },
  miamiEarlier: {
    early: { html: `<div class="row"><span>${READY}</span><input type="radio" name="readyR" id="rdo" value="Yes"><label for="Yes">Yes</label><input type="radio" name="readyR" id="rdo" value="No"><label for="No">No</label></div>${installerBox}` },
  },
  misroute: {
    early: { html: sel("nmpEarly", "Net Metering Program", ["Yes", "No"]), steps: [earlySel("nmpEarly", "Net Metering Program", "Yes")] },
    part1: () => `${sel("ready", "Are you ready to submit your Net Metering Program application?", ["Yes", "No"])}${sel("nmp2", "Net Metering Program", ["Yes", "No"], "required")}`,
    plan: () => null,
  },
  reassertBound: {
    part1: () => `${sel("ready", "Are you ready to submit your Net Metering application?", ["Yes", "No"])}<div id="nmBox">${sel("nm", "Net Metering", ["Yes", "No"], "required")}</div>`,
    script: `<script>var done = false; document.getElementById('nmBox').addEventListener('change', function () { if (done) return; done = true;
      setTimeout(function () { document.getElementById('nmBox').innerHTML = '<label for="nm-2">Net Metering</label><select id="nm-2" name="nm" required>${opts(["Yes", "No"]).replace(/'/g, "\\'")}</select>'; }, 150); });</script>`,
    steps: () => [step({ action: "select", selector: { css: "#nm", label: "Net Metering", fallbacks: [{ label: "Net Metering" }] }, value: "Yes", note: "Net Metering" })],
    plan: () => null,
  },
  // ---- SHOULD-FIX ------------------------------------------------------------------------
  spaPlain: {
    doc: (base) => `<!doctype html><html><head><meta charset="utf-8"><title>Utility Portal</title></head><body>${BEACON("spaPlain")}<h1>Utility Interconnection Portal</h1><div id="app">
      ${sel("nmp1", "Net Metering Program", ["Yes", "No"])}<button type="button" id="btnProceed" onclick="go()">Proceed to Part 1</button></div>
      <script>function go() { document.getElementById('app').innerHTML = '<form method="post" action="${base.replace(/^https?:\/\/[^/]+/, "")}/m/spaPlain/p1/submit">' +
        '<div><label for="appDate">Application Date</label><input id="appDate" name="appDate" type="text"></div>' +
        '<div><label for="nmp2">Net Metering Program</label><select id="nmp2" name="nmp" required>${opts(["Yes", "No"]).replace(/'/g, "\\'")}</select></div>' +
        '<button type="submit" id="btnSubmit">Submit</button></form>'; }</script></body></html>`,
    steps: () => [earlySel("nmp1", "Net Metering Program", "Yes"), step({ action: "click", selector: { css: "#btnProceed", text: "Proceed to Part 1" }, note: "Proceed to Part 1" })],
    plan: () => null,
  },
  revisitRe: {
    early: { html: sel("pcmEarly", "Preferred Contact Method", ["Email", "Phone"]), steps: [earlySel("pcmEarly", "Preferred Contact Method", "Email")] },
    part1: (_v, saved) => sel("pcm", "Preferred Contact Method", ["Email", "Phone"], "required", saved.pcm ?? "") + nextBtn("revisitRe"),
    steps: (base) => nextToPart2(base, "revisitRe"),
    plan: () => null,
  },
  advRerender: {
    part1: () => `<button type="button" id="btnNext" onclick="document.getElementById('secB').style.display='block'; setTimeout(function () { document.getElementById('appDate').value = ''; }, 100);">Next</button><div id="secB" style="display:none"><label for="sysSize">System Size (kW)</label><input id="sysSize" name="sysSize" type="text"></div>`,
    steps: () => [step({ action: "click", selector: { css: "#btnNext", text: "Next" }, note: "advance: Next" }), sysSize],
  },
  radioBlankStall: {
    early: { html: sel("gridEarly", "Grid tied", ["Yes", "No"]), steps: [earlySel("gridEarly", "Grid tied", "Yes")] },
    part1: () => `<div class="form-group"><div>Grid tied *</div>${radios("gridTied", "required")}</div>`,
    plan: () => null,
  },
  readyCheckbox: {
    part1: () => `<div><input type="checkbox" id="rdy" name="rdy" required><label for="rdy">I am ready to submit</label></div>`,
    plan: () => null,
  },
  finishGap: {
    permit: true,
    part1: () => `<div><label for="finish">Estimated Finish Date</label><input id="finish" name="finish" type="text" required></div>`,
    plan: (f) => (labelIs(f, /finish date/i) ? { value: "12/01/2026", field: "estimatedFinishDate" } : null),
    gap: { estimatedFinishDate: "12/01/2026" },
  },
  finishRe: {
    permit: true,
    early: { html: `<div><label for="finishEarly">Estimated Finish Date</label><input id="finishEarly" type="text"></div>`, steps: [earlyFill("finishEarly", "Estimated Finish Date", "12/01/2026")] },
    part1: () => `<div><label for="finish">Estimated Finish Date</label><input id="finish" name="finish" type="text" required></div>`,
    plan: () => null,
  },
  millGap: {
    permit: true,
    part1: () => sel("rail", "Rail finish", ["Mill Finish", "Black"], "required"),
    plan: (f) => (labelIs(f, /rail finish/i) ? { value: "Mill Finish", field: "railFinish" } : null),
    gap: { railFinish: "Mill Finish" },
  },
  millRe: {
    permit: true,
    early: { html: sel("railEarly", "Rail finish", ["Mill Finish", "Black"]), steps: [earlySel("railEarly", "Rail finish", "Mill Finish")] },
    part1: () => sel("rail", "Rail finish", ["Mill Finish", "Black"], "required"),
    plan: () => null,
  },
  roofFinishGap: {
    permit: true,
    part1: () => sel("roof", "Roof finish", ["Composition Shingle", "Tile", "Metal"], "required"),
    plan: (f) => (labelIs(f, /roof finish/i) ? { value: "Composition Shingle", field: "roofType" } : null),
    gap: { roofType: "Composition Shingle" },
  },
  overwritePick: {
    part1: () => sel("agree", AGREE, ["Yes", "No"], "required") + reveal,
    steps: () => [clickMore(), step({ action: "select", selector: { css: "#agree", label: AGREE }, value: "No", note: "terms" })],
  },
  contactAfterGap: {
    part1: () => `<div><label for="cemail">Contact Email</label><input id="cemail" name="cemail" type="email" required></div>${reveal}`,
    steps: () => [clickMore(), step({ action: "fill", selector: { css: "#cemail", label: "Contact Email" }, value: "office@acme.example", note: "contact: Contact Email" })],
    plan: (f) => (labelIs(f, /contact email/i) ? { value: "someone@example.test" } : null),
  },
  notLanded: {
    part1: () => sel("agree", AGREE, ["Yes", "No"], "required") + reveal,
    steps: () => [clickMore(), step({ action: "select", selector: { css: "#agreeGone", label: "Terms (old)" }, value: "No", note: "terms" })],
  },
  sharedLabel: {
    early: { html: `<div><label for="emailEarly">Email</label><input id="emailEarly" type="email"></div>`, steps: [earlyFill("emailEarly", "Email", "early@acme.example")] },
    part1: () => `<div><label for="email">Email</label><input id="email" name="email" type="email" required></div>`,
    script: `<script>var b = false; document.getElementById('email').addEventListener('change', function () { if (b) return; b = true; var el = this; setTimeout(function () { el.value = ''; }, 150); });</script>`,
    steps: () => [earlyFill("email", "Email", "part1@acme.example")],
  },
  reloadOwn: {
    part1: () => `<button type="button" id="btnSave" onclick="location.reload()">Save</button>`,
    steps: () => [step({ action: "click", selector: { css: "#btnSave", text: "Save" }, note: "Save" })],
  },
  earlierPick: {
    early: { html: sel("agreeEarly", AGREE, ["Yes", "No"]) },
  },
};

// ---- the server ----------------------------------------------------------------------------
const posts: Array<{ mode: string; path: string; body: string }> = [];
const gets: Array<{ mode: string; path: string; query: string }> = [];
const touchedLog: Array<{ mode: string; id: string; name: string; v: string }> = [];
const saved: Record<string, Record<string, string>> = {};
const visits: Record<string, number> = {};
const NAV = `<header><a href="/home">Program Home</a> <a href="/logout">Sign Out</a></header>`;
const BEACON = (mode: string): string => `<script>document.addEventListener('change', function (e) { var t = e.target; if (!t || !t.tagName) return;
  fetch('/m/${mode}/touched?id=' + encodeURIComponent(t.id || '') + '&n=' + encodeURIComponent(t.name || '') + '&v=' + encodeURIComponent(t.type === 'checkbox' ? String(t.checked) : t.value)); }, true);</script>`;
const page = (mode: string, title: string, body: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${BEACON(mode)}${NAV}<main>${body}</main></body></html>`;
const PART1 = (mode: string): string => {
  const m = MODES[mode];
  const visit = (visits[mode] = (visits[mode] ?? 0) + 1);
  const v = saved[mode] ?? {};
  return page(mode, "Interconnection Application Part 1", `
  <h1>Interconnection Application Part 1 (Preliminary Validation)</h1>
  <form method="post" action="/m/${mode}/p1/submit">
    <div><label for="appDate">Application Date</label><input id="appDate" name="appDate" type="text" value="${v.appDate ?? ""}"${mode === "advRerender" || mode === "reloadOwn" ? " required" : ""}></div>
    ${m.part1 ? m.part1(visit, v) : ""}
    ${m.permit ? "" : `<button type="submit" id="btnSubmit">Submit</button>`}
  </form>${m.script ?? ""}`);
};
const EARLY = (mode: string): string => page(mode, "Installer", `
  <h1>Installer Information</h1>
  <form method="get" action="/m/${mode}/part1">
    ${MODES[mode].early?.html ?? ""}
    <div><label for="contactName">Contact Name</label><input id="contactName" name="contactName" type="text"></div>
    <button type="submit" id="btnNext">Next</button>
  </form>`);
const DRAFT_PAGE = page("", "Application", `<div class="alert alert-success">Your draft application NEM-90017 has been created. Please continue to Interconnection Application - Part 2 to complete your interconnection application and submit to PSE.</div><a href="/home">Return to Program Home</a>`);

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);
  const mode = parts[0] === "m" ? parts[1] || "" : "";
  const rest = parts.slice(2).join("/");
  const send = (html: string): void => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); };
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    let body = "";
    req.on("data", (c) => { body += String(c); });
    req.on("end", () => { posts.push({ mode, path: url.pathname, body }); send(rest === "p1/submit" ? DRAFT_PAGE : page(mode, "OK", "<p>ok</p>")); });
    return;
  }
  if (rest === "touched") {
    touchedLog.push({ mode, id: url.searchParams.get("id") ?? "", name: url.searchParams.get("n") ?? "", v: url.searchParams.get("v") ?? "" });
    send("ok"); return;
  }
  gets.push({ mode, path: url.pathname, query: url.search });
  // A GET navigation's answers are what the portal "saved" (a volatile agree-vN id saves as agree).
  if (url.searchParams.size) {
    const kept = Object.fromEntries(Array.from(url.searchParams.entries()).map(([k, val]) => [/^agree-v\d+$/.test(k) ? "agree" : k, val]));
    saved[mode] = { ...(saved[mode] ?? {}), ...kept };
  }
  if (rest === "part1") { send(MODES[mode]?.doc ? MODES[mode].doc!(base) : PART1(mode)); return; }
  if (rest === "part2") { send(page(mode, "Part 1 continued", "<h1>System Details</h1><p>Nothing to enter here.</p>")); return; }
  if (rest === "early") { send(EARLY(mode)); return; }
  send(page(mode, "Program Home", "<h1>Program Home</h1>"));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const TENANT = draftTenantKey(base);

const offered: Array<{ mode: string; type: string; label: string; group: string }> = [];
const planner = async (req: LearnPlanRequest): Promise<LearnPlanResponse> => {
  const mode = /\/m\/([^/]+)\//.exec(String(req.url ?? ""))?.[1] ?? "";
  const plan = MODES[mode]?.plan ?? defaultPlan(mode);
  const fills: LearnPlanResponse["fills"] = [];
  req.fields.forEach((f, i) => {
    offered.push({ mode, type: f.fieldType, label: String(f.label ?? ""), group: String(f.groupPrompt ?? "") });
    const a = plan(f);
    if (a) fills.push({ selectorIndex: i, ...a } as Fill);
  });
  return { fills, atReview: false };
};
const GAP_FIELDS = { installerCompany: "Acme Solar", agreesToTerms: "Yes" };

const recipeFor = (mode: string): PortalRecipe => {
  const m = MODES[mode];
  const lead: RecipeStep[] = m.early
    ? [step({ action: "goto", value: `${base}/m/${mode}/early`, note: "open the first page" }), ...(m.early.steps ?? []),
      step({ action: "fill", selector: { css: "#contactName", label: "Contact Name" }, value: "Pat Example", note: "Contact Name" }),
      step({ action: "click", selector: { css: "#btnNext", text: "Next" }, note: "advance: Next" })]
    : [step({ action: "goto", value: `${base}/m/${mode}/part1`, note: "open Part 1" })];
  const own: RecipeStep[] = m.doc ? [] : [step({ action: "fill", selector: { css: "#appDate", label: "Application Date" }, value: "10/16/2026", note: "Application Date" })];
  const tail: RecipeStep[] = m.permit ? [step({ action: "stopForReview" })]
    : [step({ action: "stopForReview" }), step({ action: "click", selector: { css: "#btnSubmit", text: "Submit" }, note: "final submit | creates a draft, not the filing (#302)" })];
  const steps = [...lead, ...own, ...(m.steps ? m.steps(base) : []), ...tail];
  return {
    id: `draft-pins-${mode}`, scopeType: m.permit ? "ahj" : "utility", profileKey: "wa||twopart", state: "WA", ahj: m.permit ? "Fixture City" : "", utility: m.permit ? "" : "Two-Part Utility",
    portalPlatform: "fixture", portalUrl: String(steps[0].value), status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
    steps,
  } as PortalRecipe;
};

interface Outcome { mode: string; r: Record<string, unknown>; posts: typeof posts; gets: typeof gets; touched: typeof touchedLog; ms: number }
let seq = 0;
async function stage(mode: string): Promise<Outcome> {
  const recipe = recipeFor(mode);
  const stamp: DraftCreatingStamp = { stepIndex: recipe.steps.length - 1, tenantKey: TENANT, label: "Submit", healedAt: "2026-10-16T00:00:00.000Z" };
  const marks = [posts.length, gets.length, touchedLog.length];
  const t0 = Date.now();
  const r = await stageWithRecipe(recipe, { id: `p-${mode}` } as ProjectRecord, {}, {}, [], {
    headless: true, runId: `run-${mode}-${++seq}`, ...(MODES[mode].permit ? {} : { draftSubmitStamp: stamp }), autoSubmit: false, runApproval: null,
    gapFillPlanner: planner, gapFillFields: { ...GAP_FIELDS, ...(MODES[mode].gap ?? {}) },
  });
  const ms = Date.now() - t0;
  await new Promise((res) => setTimeout(res, 300));
  return { mode, r, posts: posts.slice(marks[0]), gets: gets.slice(marks[1]), touched: touchedLog.slice(marks[2]), ms };
}

// ---- reading an outcome --------------------------------------------------------------------
const stepsOf = (r: Record<string, unknown>) => (Array.isArray(r.steps) ? (r.steps as Array<{ message?: unknown; pauseReason?: unknown; data?: Record<string, unknown> }>) : []);
const msgOf = (r: Record<string, unknown>): string => {
  const notes = [r.agingNotes, ...stepsOf(r).map((s) => s?.data?.agingNotes)].flatMap((n) => (Array.isArray(n) ? n.map(String) : []));
  return [String(r.message ?? ""), ...stepsOf(r).map((s) => String(s?.message ?? "")), ...notes].filter(Boolean).join(" | ");
};
/** The first line the run card shows (backend pausedRunSentence reads the pausing step's message). */
const cardLine = (r: Record<string, unknown>): string => String(stepsOf(r).find((s) => s?.pauseReason === r.pauseReason)?.message ?? "").split("\n")[0];
const brief = (o: Outcome): string => `ms=${o.ms} posts=${JSON.stringify(o.posts.map((p) => `${p.path}?${p.body.slice(0, 120)}`))} gets=${JSON.stringify(o.gets.map((g) => g.path + g.query))} touched=${JSON.stringify(o.touched.map((t) => `${t.id || t.name}=${t.v}`))} ok=${String(o.r.ok)} pause=${String(o.r.pauseReason)} draft=${JSON.stringify(o.r.draftCreatedByReplay ?? null)} incident=${JSON.stringify(o.r.draftSubmitUnexpected ?? null)} offered=${JSON.stringify(offered.filter((f) => f.mode === o.mode).map((f) => `${f.type}:${f.label}|${f.group}`))} card=${cardLine(o.r).slice(0, 260)} msg=${msgOf(o.r).slice(-700)}`;
const notAnIncident = (o: Outcome): boolean => o.r.pauseReason !== "draft_submit_unexpected" && !o.r.draftSubmitUnexpected && !o.r.draftCreatedByReplay && o.r.finalSubmitClicked === false;
const drafted = (o: Outcome): boolean => o.posts.length === 1 && /\/p1\/submit$/.test(o.posts[0].path) && (o.r.draftCreatedByReplay as { applicationNumber?: string } | null)?.applicationNumber === "NEM-90017" && o.r.finalSubmitClicked === false;
/** A review stop: no request of any kind, no draft, no incident, paused before review. */
const stopped = (o: Outcome): boolean => o.posts.length === 0 && notAnIncident(o) && o.r.pauseReason === "stopped_before_review";
/** ...for picks: the run card LEADS with what was not clicked and names the pick. */
const stoppedForPick = (o: Outcome, words: string): boolean => stopped(o) && /^NOT CLICKED "Submit": automation picked \d+ answer\(s\)/.test(cardLine(o.r)) && cardLine(o.r).slice(0, 216).includes(words);
const wrote = (o: Outcome, idOrName: RegExp, v?: string): boolean => o.touched.some((t) => (idOrName.test(t.id) || idOrName.test(t.name)) && (v === undefined || t.v === v));
const carried = (o: Outcome, key: string): boolean => o.gets.some((g) => new RegExp(`[?&]${key}=Yes`).test(g.query)) || o.posts.some((p) => new RegExp(`(^|&)${key}=Yes`).test(p.body));
const readyKept = (o: Outcome, key: string): boolean => !wrote(o, new RegExp(`^${key}`)) && !carried(o, key);

const only = (() => { const i = process.argv.indexOf("--only"); return i > 0 ? String(process.argv[i + 1] ?? "") : ""; })();
const run = async (mode: string, fn: (o: Outcome) => void): Promise<void> => {
  if (only && !mode.includes(only)) return;
  fn(await stage(mode));
};

try {
  // BLOCKING 1
  for (const [mode, what] of [
    ["remountName", 'an "advance: Continue" that re-mounts the picked select as agree-2 (same name)'],
    ["revisitVolatile", "a revisit of Part 1 rendered under new ids"],
    ["remountPc", "a pcInputBaseN select with no name, renumbered on re-mount"],
    ["volatileId", "a synchronous re-render under a new id"],
    ["dialogRemoved", "a dialog that copies its answer to a hidden input and is removed on Save"],
  ] as const) {
    await run(mode, (o) => check(`${mode}: ${what} — the pick still stops the click (0 POSTs, a named review stop)`, stoppedForPick(o, "Do you agree"), brief(o)));
  }
  // BLOCKING 2
  await run("notesSelect", (o) => check('notesSelect: a "No" bound to the design notes is a pick — 0 POSTs, a review stop', stopped(o) && !drafted(o), brief(o)));
  await run("wrongRadio", (o) => check("wrongRadio: the No radio is never ticked through gridTied=Yes, and nothing is clicked", stopped(o) && !wrote(o, /^gridTiedN$/), brief(o)));
  await run("fuzzySelect", (o) => check('fuzzySelect: "Yes" landing on "Yes, grid-tied with battery backup" is a pick — 0 POSTs, a named stop', stoppedForPick(o, GRID), brief(o)));
  await run("looseTrace", (o) => check('looseTrace: a terms box ticked "on" through a company name is no data — 0 POSTs, a review stop', stopped(o), brief(o)));
  await run("typedYes", (o) => check('typedYes: an unbound "YES" typed into a box is no data — 0 POSTs, a review stop', stopped(o), brief(o)));
  await run("unboundText", (o) => check('unboundText: "200" from "1200 Elm St" is no data — 0 POSTs, a review stop', stopped(o), brief(o)));
  await run("modules2", (o) => check("modules2: a -405/M module chosen for the project's -410/M, in two rows, is a pick — 0 POSTs, a review stop", stopped(o) && !o.posts.some((p) => p.body.includes("405")), brief(o)));
  await run("boundRadioNo", (o) => check("boundRadioNo: the No radio through gridTied=No is data — one click, the draft carries gridTied=No", drafted(o) && o.posts[0].body.includes("gridTied=No"), brief(o)));
  await run("unboundCopy", (o) => check("unboundCopy: an unbound exact copy of a project value is data — one click, the draft", drafted(o) && o.posts[0].body.includes("installer=Acme+Solar"), brief(o)));
  // BLOCKING 3
  for (const mode of ["boundTableTh", "boundSectionLegend", "boundSelectAbove", "selectLabelledBy"] as const) {
    const key = mode === "boundSelectAbove" || mode === "selectLabelledBy" ? "readyS" : "readyR";
    await run(mode, (o) => check(`${mode}: the ready-to-submit question is never answered on Part 1 (bound planner) — never touched, nothing carries it, 0 POSTs`, readyKept(o, key) && o.posts.length === 0 && notAnIncident(o), brief(o)));
  }
  for (const mode of ["radioSpanEarlier", "selectLabelledByEarly", "rnoidEarly2", "miamiEarlier"] as const) {
    const key = mode === "selectLabelledByEarly" ? "readyS" : "readyR";
    await run(mode, (o) => check(`${mode}: the ready-to-submit question on an EARLIER page is never answered — never touched, no request carries it`, readyKept(o, key) && notAnIncident(o) && !o.posts.some((p) => new RegExp(`${key}=`).test(p.body)), brief(o)));
  }
  await run("rnoidPart1", (o) => {
    check("rnoidPart1: an id-less grid-tied Yes is written to ITS group, never to the ready group's Yes", readyKept(o, "readyR"), brief(o));
    check("rnoidPart1: ...and the stop names the grid-tied question, not the ready one (0 POSTs)", stoppedForPick(o, GRID) && !cardLine(o.r).includes("ready to submit"), brief(o));
  });
  await run("misroute", (o) => check("misroute: an earlier page's \"Net Metering Program\" is never re-asserted into the ready select its label locator resolves to — never touched, 0 POSTs", !wrote(o, /^ready$/) && o.posts.length === 0 && notAnIncident(o), brief(o)));
  await run("reassertBound", (o) => check('reassertBound: Part 1\'s own "Net Metering" step, its select re-rendered under a new id, is never re-asserted into the ready select — never touched, 0 POSTs', !wrote(o, /^ready$/) && o.posts.length === 0 && notAnIncident(o), brief(o)));
  // SF2
  await run("spaPlain", (o) => check('spaPlain: a single-document "Proceed to Part 1" — view 1\'s recorded value re-asserted into Part 1 is a pick (0 POSTs, a named stop)', stoppedForPick(o, "Net Metering Program"), brief(o)));
  await run("revisitRe", (o) => check("revisitRe: a carried-over re-assert, then a revisit of Part 1 — still a pick (0 POSTs, a named stop)", stoppedForPick(o, "Preferred Contact Method"), brief(o)));
  await run("advRerender", (o) => check("advRerender: an advance-worded reveal that re-renders Part 1's own value — re-asserted from its own step, one click, the draft", drafted(o) && o.posts[0].body.includes("appDate=10%2F16%2F2026"), brief(o)));
  // SF4
  await run("radioBlankStall", (o) => check("radioBlankStall: a counted radio-group blank is never re-run from another page's select — a quick review stop, 0 POSTs", stopped(o) && o.ms < 120_000 && !wrote(o, /^gridTied/), brief(o)));
  // SF5
  await run("readyCheckbox", (o) => check('readyCheckbox: a required "I am ready to submit" box is a blank — a review stop, never ticked, no incident, 0 POSTs', stopped(o) && !wrote(o, /^rdy$/) && /ready to submit/i.test(msgOf(o.r)), brief(o)));
  // SF6 (permit runs: no stamp, they end at review)
  for (const [mode, id, v] of [
    ["finishGap", "finish", "12/01/2026"], ["finishRe", "finish", "12/01/2026"], ["millGap", "rail", "Mill Finish"], ["millRe", "rail", "Mill Finish"], ["roofFinishGap", "roof", "Composition Shingle"],
  ] as const) {
    await run(mode, (o) => check(`${mode}: "finish" is not submit intent — the permit run writes ${id}=${v} and reaches review`, wrote(o, new RegExp(`^${id}$`), v) && o.r.ok === true && o.posts.length === 0, brief(o)));
  }
  // SF7
  await run("overwritePick", (o) => check("overwritePick: a gap-fill pick the next recorded step overwrites with its own answer — one click, the draft carries the recorded No", drafted(o) && o.posts[0].body.includes("agree=No"), brief(o)));
  await run("contactAfterGap", (o) => check("contactAfterGap: a contact box the recording fills after the gap-fill — one click, the draft carries the recorded email", drafted(o) && o.posts[0].body.includes("cemail=office%40acme.example"), brief(o)));
  await run("notLanded", (o) => check("notLanded: the recorded step that would overwrite the pick does not land — the pick stops the click (0 POSTs, a named stop)", stoppedForPick(o, "Do you agree"), brief(o)));
  // SF8
  await run("sharedLabel", (o) => check("sharedLabel: Part 1's own Email step wins its re-rendered blank over an earlier page's Email — one click, the draft carries Part 1's", drafted(o) && o.posts[0].body.includes("email=part1%40acme.example"), brief(o)));
  await run("reloadOwn", (o) => check("reloadOwn: a same-URL reload after Save, Part 1's own value re-asserted — one click, the draft", drafted(o) && o.posts[0].body.includes("appDate=10%2F16%2F2026"), brief(o)));
  // SF9
  await run("earlierPick", (o) => check(WHOLE_APPLICATION
    ? "earlierPick: an unbound pick on an EARLIER page stops the stamped click (owner: whole application)"
    : "earlierPick: an unbound pick on an EARLIER page, then a real navigation to Part 1 — one click, the draft (owner card open: Submit page only)",
  WHOLE_APPLICATION ? stoppedForPick(o, "Do you agree") : drafted(o), brief(o)));
} finally {
  server.close();
}
if (failures) { console.error(`\n${failures} draft-submit pin check(s) FAILED.`); process.exit(1); }
console.log("\nAll draft-submit pin checks passed (real Chromium).");
process.exit(0);
