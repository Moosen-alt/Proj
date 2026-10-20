// THE STAMPED DRAFT CLICK ONLY HAPPENS ON THE PAGE THE STAMP SAW (#362).
//
// Owner rulings 2026-10-17 ("Stop for me") and 2026-10-18 ("Data is enough, the whole idea is to
// keep it pretty autonomous"): before the stamped draft-creating Submit (#330/#354, the CLAUDE.md
// rule 1 carve-out), an extra answer straight from this project's data goes ahead, but if automation
// PICKED an answer the recorded steps never give with no project data behind it, it fills it and
// STOPS like a review stop — the answers stay on the page, a person checks them and clicks Submit,
// the stamp is kept, and it is not an incident. Found re-checking PR #353: a stub
// planner doing what the gap-fill prompt says (acknowledgments AGREE, a required Yes/No MUST be
// answered) got one POST each with the draft created — and, on a page where the dropdown's Yes turns
// the Submit into a filing, one FILING POST with no approval.
//
// The record is keyed to the CONTROLS automation picked and their QUESTIONS, not to "leaving the
// page" (Helm reviews of 85424af5 and 4081f12): a pick stops the click while it was made in this
// document and view (an advance that only reveals more of the same page, an in-page opener, a
// re-mount under a new id), or while a control with its id or name that does not readably ask
// something else, or an answered control asking its question, is in front (a revisit: by its id or
// name, or under new ids when Part 1 asks the same question the extractor's way). draftSubmitPins
// pins the re-mount, renumbered-id, removed-dialog, revisit and reused-id shapes.
//
// Real Chromium through the real stage path (stageWithRecipe → runAdapter → RecipeAdapter with the
// network backstop and the LLM gap-fill enabled) against synthetic Part 1 pages on 127.0.0.1 (never a
// real portal; every person, company and address is fictional). Every non-GET the SERVER receives is
// counted. The planner is a stub that answers every control it is offered (a Yes/No select or radio
// with Yes, a text box from the project), as the gap-fill prompt asks; on a "bound…" page it names
// the project field behind its Yes.
//
//   MUST-STOP (0 POSTs, a review stop — no draft, no incident — that names what was picked)
//     filled          an unrecorded required select ("Do you agree to the terms…") the stub answers Yes
//                     with no project field behind it (an AI pick)
//     unboundRadio    a required Yes/No radio group ("Is the system grid-tied?") picked the same way
//     inPage          the gap-fill answers it before an in-page click that reveals a control
//     nextReveal      …before a type=button "advance: Next" that only shows section B in place
//     continueReveal  …before a human-captured "Continue" (no advance: prefix) that does the same
//     nextInPage      …before a "Next" that changes nothing
//     opener          …before an "advance: Select from Account" that reveals an inline box
//     revisit         …then Next to Part 2 and a recorded goto back to Part 1, the answer saved
//     reassertEmail   an earlier page's recorded "Email" re-asserted into Part 1's own Email blank
//     substring       the gap-fill's "Net Metering" answer lands on its own select, never on the
//                     "…ready to submit your Net Metering…" select a label locator would resolve
//   MUST-EXCLUDE (never written, so the stamped Submit is not clicked)
//     submitIntent    "Are you ready to submit your Net Metering (kWh) application?" is never offered
//     reassertReady   an earlier page's recorded "Net Metering" = Yes is never re-asserted into it
//     radioLegend / radioGroup / radioAria   the same question as a Yes/No radio group, its question in a
//                     fieldset legend, a form-group label, an aria radiogroup: no member is offered
//   MUST-PASS (one click, the draft, as on main)
//     earlierPage     the gap-fill filled a box on an EARLIER page, nothing on Part 1
//     gotoEarlier     the same, left by a recorded goto to Part 1
//     clean           gap-fill enabled with nothing to answer
//     arrays1         a one-array project on the same repeater page
//     arrays2         a two-array project on a one-array recording: the unrecorded Add Array + row 2
//                     come from the project's arrays (data)
//     upload          an unrecorded upload slot (a single-line diagram) attached from the project's files
//     contact         a contact dialog (iframe) prefilled with another identity, corrected to the
//                     project's contact before its Continue — no typed value in any message
//     boundSelect     the "filled" select answered Yes through a bound project field
//     boundRadio      the "unboundRadio" group answered Yes through a bound project field
//     rerender        Part 1's OWN recorded field blanked by a re-render, re-asserted from its own step
//     radioEarlier    the ready-to-submit radio group on an EARLIER page is never answered either
//
// Run: npx tsx portal-bot/src/adapters/draftSubmitFilled.dom.smoke.ts
import "../smokeArtifactDirs";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
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

// No "Net Metering (kWh)" in it: PR #353's kWh standing answer would answer it on a merged tree.
const AGREE = "Do you agree to the terms of the Interconnection Agreement?";
const READY = "Are you ready to submit your Net Metering (kWh) application?";
const posts: Array<{ mode: string; path: string; body: string }> = [];
const gets: Array<{ mode: string; path: string; query: string }> = [];
const saved: Record<string, Record<string, string>> = {};
const NAV = `<header><a href="/home">Program Home</a> <a href="/logout">Sign Out</a></header>`;
const page = (title: string, body: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${NAV}<main>${body}</main></body></html>`;
const yesNo = (mode: string, id: string, label: string, opts: { beacon?: boolean } = {}): string => {
  const pick = saved[mode]?.[id] ?? "";
  const opt = (v: string): string => `<option${pick === v ? " selected" : ""}>${v}</option>`;
  const beacon = opts.beacon ? ` onchange="fetch('/m/${mode}/touched?id=${id}')"` : "";
  return `<div><label for="${id}">${label}</label><select id="${id}" name="${id}" required${beacon}><option value="">Select…</option>${opt("Yes")}${opt("No")}</select></div>`;
};
const installerBox = `<div><label for="installer">Installer Company</label><input id="installer" name="installer" type="text" required></div>`;
// required=false on an EARLIER page, so the browser lets it advance with the question left blank
// (the stub planner would still answer it if it were offered: it is offered optional fields too).
const readyRadios = (shape: "legend" | "group" | "aria", required = true): string => (shape === "legend"
  ? `<fieldset><legend>${READY}</legend><input type="radio" id="rY" name="readyR" value="Yes" required><label for="rY">Yes</label><input type="radio" id="rN" name="readyR" value="No"><label for="rN">No</label></fieldset>`
  : shape === "group"
    ? `<div class="form-group"><label class="control-label">${READY}</label><input type="radio" id="rY" name="readyR" value="Yes" required><label for="rY">Yes</label><input type="radio" id="rN" name="readyR" value="No"><label for="rN">No</label></div>`
    : `<div role="radiogroup" aria-labelledby="rq"><span id="rq">${READY}</span><label><input type="radio" name="readyR" value="Yes" required> Yes</label><label><input type="radio" name="readyR" value="No"> No</label></div>`).replace(required ? /$^/ : / required/g, "");
const GRID_RADIOS = `<fieldset><legend>Is the system grid-tied?</legend><input type="radio" id="gY" name="gridTied" value="Yes" required><label for="gY">Yes</label><input type="radio" id="gN" name="gridTied" value="No"><label for="gN">No</label></fieldset>`;
const reveal = (btnId: string, text: string): string => `<button type="button" id="${btnId}" onclick="document.getElementById('secB').style.display='block'">${text}</button><div id="secB" style="display:none"><label for="sysSize">System Size (kW)</label><input id="sysSize" name="sysSize" type="text"></div>`;
const ARRAYS = `<div id="arrays"></div><button id="addArray" type="button">Add Array</button>
  <script>
    var n = 0;
    function addRow() {
      n++;
      var d = document.createElement('div');
      d.className = 'arrayrow';
      d.innerHTML = '<a class="del">Delete Array</a>' +
        '<label for="qty' + n + '">Qty</label><input class="qty" id="qty' + n + '" name="qty' + n + '">' +
        '<label for="tilt' + n + '">Tilt</label><input class="tilt" id="tilt' + n + '" name="tilt' + n + '">' +
        '<label for="azi' + n + '">Azimuth</label><input class="azi" id="azi' + n + '" name="azi' + n + '">';
      document.getElementById('arrays').appendChild(d);
    }
    addRow();
    document.getElementById('addArray').addEventListener('click', addRow);
  </script>`;
const CONTACT_OPENER = `<button type="button" id="btnAcct" onclick="openDlg()">Select from Account</button><div id="contactSaved"></div>
  <script>
    function openDlg() { var f = document.createElement('iframe'); f.name = 'dlg'; f.id = 'dlg'; f.src = location.pathname.replace(/part1$/, 'dialog'); f.style.width = '600px'; f.style.height = '300px'; document.body.appendChild(f); }
    function closeDlg() { var f = document.getElementById('dlg'); if (f) f.remove(); document.getElementById('contactSaved').textContent = 'Contractor contact saved.'; }
  </script>`;
// The dialog prefills the ACCOUNT's contact (a homeowner), the section is the contractor's.
const DIALOG = page("Contact", `<h2>Contractor Contact Information</h2>
  <div><label for="dEmail">Email</label><input id="dEmail" type="email" value="pat.homeowner@example.test"></div>
  <div><label for="dBiz">Name of Business</label><input id="dBiz" type="text" value=""></div>
  <button type="button" id="btnContinue" onclick="parent.closeDlg()">Continue</button>`);

// The unrecorded controls each mode puts on the Part 1 page.
const extra = (mode: string): string => {
  switch (mode) {
    case "filled": case "boundSelect": return yesNo(mode, "agree", AGREE);
    case "unboundRadio": case "boundRadio": return GRID_RADIOS;
    case "inPage": return `${yesNo(mode, "agree", AGREE)}<button type="button" id="btnMore" onclick="document.getElementById('more').style.display='block'">Show contact preferences</button><div id="more" style="display:none"><label for="pref">Preferred contact</label><input id="pref" name="pref" type="text"></div>`;
    case "submitIntent": return `${yesNo(mode, "ready", READY)}${installerBox}`;
    case "nextReveal": return `${yesNo(mode, "agree", AGREE)}${reveal("btnNext", "Next")}`;
    case "continueReveal": return `${yesNo(mode, "agree", AGREE)}${reveal("btnCont", "Continue")}`;
    case "nextInPage": return `${yesNo(mode, "agree", AGREE)}<button type="button" id="btnNext">Next</button>`;
    case "opener": return `${yesNo(mode, "agree", AGREE)}<button type="button" id="btnAcct" onclick="document.getElementById('acct').style.display='block'">Select from Account</button><div id="acct" style="display:none"><label for="pref">Preferred contact</label><input id="pref" name="pref" type="text"></div>`;
    case "revisit": return `${yesNo(mode, "agree", AGREE)}<button type="submit" id="btnNext" formmethod="get" formaction="/m/${mode}/part2">Next</button>`;
    case "arrays1": case "arrays2": return ARRAYS;
    // A select literal, so the re-assert's write LANDS (a beacon proves it).
    case "reassertEmail": return `<div><label for="email">Email</label><select id="email" name="email" required onchange="fetch('/m/${mode}/touched?id=email')"><option value="">Select…</option><option>office@acme.example</option><option>other@acme.example</option></select></div>`;
    case "reassertReady": return yesNo(mode, "ready", READY, { beacon: true });
    case "radioLegend": return `${readyRadios("legend")}${installerBox}`;
    case "radioGroup": return `${readyRadios("group")}${installerBox}`;
    case "radioAria": return `${readyRadios("aria")}${installerBox}`;
    case "upload": return `<div><label for="sld">Single-Line Diagram (SLD)</label><input id="sld" name="sld" type="file"></div>`;
    case "contact": return CONTACT_OPENER;
    case "substring": return `${yesNo(mode, "ready", READY, { beacon: true })}${yesNo(mode, "nm", "Net Metering")}`;
    default: return "";
  }
};
const PART1 = (mode: string): string => {
  const v = saved[mode] ?? {};
  const required = mode === "rerender" ? " required" : "";
  // rerender: the portal blanks the date ONCE, a moment after it is entered (a re-render).
  const blankOnce = mode === "rerender" ? `<script>var blanked = false; document.getElementById('appDate').addEventListener('change', function () { if (blanked) return; blanked = true; var el = this; setTimeout(function () { el.value = ''; }, 150); });</script>` : "";
  return page("Interconnection Application Part 1", `
  <h1>Interconnection Application Part 1 (Preliminary Validation)</h1>
  <form method="post" action="/m/${mode}/p1/submit" enctype="${mode === "upload" ? "multipart/form-data" : "application/x-www-form-urlencoded"}">
    <div><label for="appDate">Application Date</label><input id="appDate" name="appDate" type="text" value="${v.appDate ?? ""}"${required}></div>
    <div><label for="appType">Application Type</label><select id="appType" name="appType"><option value="">Select…</option><option${v.appType === "New Solar" ? " selected" : ""}>New Solar</option></select></div>
    ${extra(mode)}
    <button type="submit" id="btnSubmit">Submit</button>
  </form>${blankOnce}`);
};
// An EARLIER page, before Part 1 (method=get: its answers ride the query to Part 1).
const EARLY = (mode: string): string => {
  const extras = mode === "reassertEmail" ? `<div><label for="contactEmail">Email</label><select id="contactEmail" name="contactEmail"><option value="">Select…</option><option>office@acme.example</option><option>other@acme.example</option></select></div>`
    : mode === "reassertReady" ? `<div><label for="netMetering">Net Metering</label><select id="netMetering" name="netMetering"><option value="">Select…</option><option>Yes</option><option>No</option></select></div>`
    : mode === "radioEarlier" ? `${readyRadios("legend", false)}${installerBox}`
    : installerBox;
  const leave = mode === "gotoEarlier" ? `<button type="button" id="btnSave">Save</button>` : `<button type="submit" id="btnNext">Next</button>`;
  return page("Installer", `
  <h1>Installer Information</h1>
  <form method="get" action="/m/${mode}/part1">
    ${extras}
    <div><label for="contactName">Contact Name</label><input id="contactName" name="contactName" type="text"></div>
    ${leave}
  </form>`);
};
const PART2 = page("Part 1 continued", `<h1>System Details</h1><p>Nothing to enter here.</p>`);
const DRAFT_PAGE = page("Application", `<div class="alert alert-success">Your draft application NEM-90017 has been created. Please continue to Interconnection Application - Part 2 to complete your interconnection application and submit to PSE.</div><a href="/home">Return to Program Home</a>`);

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);
  const mode = parts[0] === "m" ? parts[1] || "" : "";
  const rest = parts.slice(2).join("/");
  const send = (html: string): void => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); };
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    let body = "";
    req.on("data", (c) => { body += String(c); });
    req.on("end", () => {
      posts.push({ mode, path: url.pathname, body });
      send(rest === "p1/submit" ? DRAFT_PAGE : page("OK", "<p>ok</p>"));
    });
    return;
  }
  gets.push({ mode, path: url.pathname, query: url.search });
  // A GET navigation's answers are what the portal "saved" for this application.
  if (url.searchParams.size) saved[mode] = { ...(saved[mode] ?? {}), ...Object.fromEntries(url.searchParams.entries()) };
  if (rest === "touched") { send("ok"); return; }
  if (rest === "part1") { send(PART1(mode)); return; }
  if (rest === "part2") { send(PART2); return; }
  if (rest === "early") { send(EARLY(mode)); return; }
  if (rest === "dialog") { send(DIALOG); return; }
  send(page("Program Home", "<h1>Program Home</h1>"));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const TENANT = draftTenantKey(base);
const sldDir = fs.mkdtempSync(path.join(os.tmpdir(), "draft-filled-sld-"));
const SLD = path.join(sldDir, "single-line-diagram.pdf");
fs.writeFileSync(SLD, "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

// THE STUB PLANNER: answers every control it is offered, the way the gap-fill prompt asks (a required
// Yes/No MUST be answered, an acknowledgment AGREES). Every field it was offered is kept.
const offered: Array<{ type: string; label: string; group: string }> = [];
const planner = async (req: LearnPlanRequest): Promise<LearnPlanResponse> => {
  const fills: LearnPlanResponse["fills"] = [];
  const bound = /\/m\/bound/.test(String(req.url ?? ""));
  req.fields.forEach((f, i) => {
    offered.push({ type: f.fieldType, label: String(f.label ?? ""), group: String(f.groupPrompt ?? "") });
    if (f.fieldType === "select" && (f.options ?? []).includes("Yes")) fills.push({ selectorIndex: i, value: "Yes", ...(bound ? { field: "agreesToTerms" } : {}) });
    else if (f.fieldType === "radio" && /^yes$/i.test(String(f.label ?? "").trim())) fills.push({ selectorIndex: i, value: "Yes", ...(bound ? { field: "gridTied" } : {}) });
    else if (/installer company/i.test(String(f.label ?? ""))) fills.push({ selectorIndex: i, value: "Acme Solar", field: "installerCompany" });
  });
  return { fills, atReview: false };
};
const GAP_FIELDS = { installerCompany: "Acme Solar", agreesToTerms: "Yes", gridTied: "Yes" };

const step = (s: Record<string, unknown>): RecipeStep => s as unknown as RecipeStep;
const submitStep = step({ action: "click", selector: { css: "#btnSubmit", text: "Submit" }, note: "final submit | creates a draft, not the filing (#302)" });
const part1Steps = (mode: string): RecipeStep[] => {
  const own: RecipeStep[] = [
    step({ action: "fill", selector: { css: "#appDate", label: "Application Date" }, value: "10/16/2026", note: "Application Date" }),
    step({ action: "select", selector: { css: "#appType", label: "Application Type" }, value: "New Solar", note: "Application Type" }),
  ];
  const sysSize = step({ action: "fill", selector: { css: "#sysSize", label: "System Size (kW)" }, value: "7.6", note: "System Size (kW)" });
  switch (mode) {
    case "inPage": own.push(step({ action: "click", selector: { css: "#btnMore", text: "Show contact preferences" }, note: "contact preferences: Show contact preferences" })); break;
    case "nextReveal": own.push(step({ action: "click", selector: { css: "#btnNext", text: "Next" }, note: "advance: Next" }), sysSize); break;
    case "continueReveal": own.push(step({ action: "click", selector: { css: "#btnCont", text: "Continue" }, note: "Continue" }), sysSize); break;
    case "nextInPage": own.push(step({ action: "click", selector: { css: "#btnNext", text: "Next" }, note: "Next" })); break;
    case "opener": own.push(step({ action: "click", selector: { css: "#btnAcct", text: "Select from Account" }, note: "advance: Select from Account" })); break;
    case "revisit": own.push(
      step({ action: "click", selector: { css: "#btnNext", text: "Next" }, note: "advance: Next" }),
      step({ action: "goto", value: `${base}/m/${mode}/part1`, note: "open Part 1 again" }),
    ); break;
    case "arrays1": case "arrays2": own.push(
      step({ action: "fill", phase: "fill", selector: { css: ".qty" }, field: "array1ModuleQuantity", note: "Qty" }),
      step({ action: "fill", phase: "fill", selector: { css: ".tilt" }, field: "array1Tilt", note: "Tilt" }),
      step({ action: "fill", phase: "fill", selector: { css: ".azi" }, field: "array1Azimuth", note: "Azimuth" }),
    ); break;
    case "contact": own.push(
      step({ action: "click", selector: { css: "#btnAcct", text: "Select from Account" }, note: "contact(contractor): Select from Account" }),
      step({ action: "click", selector: { frame: "dlg", css: "#btnContinue", text: "Continue" }, note: "contact(contractor): Continue" }),
    ); break;
    default: break;
  }
  return [...own, step({ action: "stopForReview" }), submitStep];
};
const EARLY_MODES = new Set(["earlierPage", "gotoEarlier", "reassertEmail", "reassertReady", "radioEarlier"]);
const earlySteps = (mode: string): RecipeStep[] => {
  const out: RecipeStep[] = [step({ action: "goto", value: `${base}/m/${mode}/early`, note: "open the first page" })];
  if (mode === "reassertEmail") out.push(step({ action: "select", selector: { css: "#contactEmail", label: "Email", fallbacks: [{ label: "Email" }] }, value: "office@acme.example", note: "Email" }));
  if (mode === "reassertReady") out.push(step({ action: "select", selector: { css: "#netMetering", label: "Net Metering", fallbacks: [{ label: "Net Metering" }] }, value: "Yes", note: "Net Metering" }));
  out.push(step({ action: "fill", selector: { css: "#contactName", label: "Contact Name" }, value: "Pat Example", note: "Contact Name" }));
  if (mode === "gotoEarlier") {
    out.push(step({ action: "click", selector: { css: "#btnSave", text: "Save" }, note: "installer: Save" }));
    out.push(step({ action: "goto", value: `${base}/m/${mode}/part1`, note: "open Part 1" }));
  } else {
    out.push(step({ action: "click", selector: { css: "#btnNext", text: "Next" }, note: "advance: Next" }));
  }
  return out;
};
const recipeFor = (mode: string): PortalRecipe => {
  const steps: RecipeStep[] = EARLY_MODES.has(mode)
    ? [...earlySteps(mode), ...part1Steps(mode)]
    : [step({ action: "goto", value: `${base}/m/${mode}/part1`, note: "open Part 1" }), ...part1Steps(mode)];
  return {
    id: `draft-filled-${mode}`, scopeType: "utility", profileKey: "wa||twopart", state: "WA", ahj: "", utility: "Two-Part Utility",
    portalPlatform: "fixture", portalUrl: String(steps[0].value), status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
    steps,
  } as PortalRecipe;
};
const FIELD_VALUES: Record<string, Record<string, string>> = {
  arrays1: { array1ModuleQuantity: "10", array1Tilt: "22", array1Azimuth: "180" },
  arrays2: { array1ModuleQuantity: "10", array1Tilt: "22", array1Azimuth: "180", array2ModuleQuantity: "6", array2Tilt: "17", array2Azimuth: "90" },
  contact: { installerEmail: "office@acme.example", installerCompanyName: "Acme Solar LLC", homeownerEmail: "pat.homeowner@example.test" },
};

let seq = 0;
interface Outcome { r: Record<string, unknown>; posts: Array<{ path: string; body: string }>; gets: Array<{ path: string; query: string }>; offered: typeof offered }
async function stage(mode: string): Promise<Outcome> {
  const recipe = recipeFor(mode);
  const stamp: DraftCreatingStamp = { stepIndex: recipe.steps.length - 1, tenantKey: TENANT, label: "Submit", healedAt: "2026-10-16T00:00:00.000Z" };
  const before = posts.length;
  const getsBefore = gets.length;
  const offeredBefore = offered.length;
  const runId = `run-${mode}-${++seq}`;
  const r = await stageWithRecipe(recipe, { id: `p-${mode}` } as ProjectRecord, FIELD_VALUES[mode] ?? {}, mode === "upload" ? { sld: SLD } : {}, [], {
    headless: true, runId, draftSubmitStamp: stamp, autoSubmit: false, runApproval: null,
    gapFillPlanner: planner, gapFillFields: GAP_FIELDS,
  });
  await new Promise((res) => setTimeout(res, 300));
  return { r, posts: posts.slice(before), gets: gets.slice(getsBefore), offered: offered.slice(offeredBefore) };
}
const msgOf = (r: Record<string, unknown>): string => {
  const steps = Array.isArray(r.steps) ? (r.steps as Array<{ message?: unknown; data?: { agingNotes?: unknown } }>) : [];
  const notes = [r.agingNotes, ...steps.map((s) => s?.data?.agingNotes)].flatMap((n) => (Array.isArray(n) ? n.map(String) : []));
  return [String(r.message ?? ""), ...steps.map((s) => String(s?.message ?? "")), ...notes].filter(Boolean).join(" | ");
};
const gapFilled = (r: Record<string, unknown>): string[] => {
  const steps = Array.isArray(r.steps) ? (r.steps as Array<{ data?: { gapFill?: { filled?: string[] } } }>) : [];
  const own = (r.gapFill as { filled?: string[] } | undefined)?.filled ?? [];
  return [...own, ...steps.flatMap((s) => s?.data?.gapFill?.filled ?? [])];
};
const brief = (o: Outcome): string => `posts=${JSON.stringify(o.posts.map((p) => p.path))} gets=${JSON.stringify(o.gets.map((g) => g.path + g.query))} ok=${String(o.r.ok)} clicked=${String(o.r.finalSubmitClicked)} pause=${String(o.r.pauseReason)} draft=${JSON.stringify(o.r.draftCreatedByReplay ?? null)} incident=${JSON.stringify(o.r.draftSubmitUnexpected ?? null)} gapFilled=${JSON.stringify(gapFilled(o.r))} offered=${JSON.stringify(o.offered)} handoff=${handoffOf(o.r).slice(0, 300)} msg=${msgOf(o.r).slice(-900)}`;
const submits = (o: Outcome): number => o.posts.filter((p) => /\/p1\/submit$/.test(p.path)).length;
const notAnIncident = (o: Outcome): boolean => o.r.pauseReason !== "draft_submit_unexpected" && !o.r.draftSubmitUnexpected && !o.r.draftCreatedByReplay && o.r.finalSubmitClicked === false;
const drafted = (o: Outcome): boolean => submits(o) === 1 && (o.r.draftCreatedByReplay as { applicationNumber?: string } | null)?.applicationNumber === "NEM-90017" && o.r.finalSubmitClicked === false;
const named = (o: Outcome, words: string): boolean => msgOf(o.r).includes(words) && /recorded steps never fill/.test(msgOf(o.r)) && leads(o);
// THE RUN CARD LEADS WITH IT (SF1): the pausing step's first line, which the backend shows.
const cardLine = (r: Record<string, unknown>): string => {
  const steps = Array.isArray(r.steps) ? (r.steps as Array<{ message?: unknown; pauseReason?: unknown }>) : [];
  return String(steps.find((s) => s?.pauseReason === r.pauseReason)?.message ?? "").split("\n")[0];
};
const leads = (o: Outcome): boolean => /^NOT CLICKED "Submit": automation picked \d+ answer\(s\) with no project data behind them/.test(cardLine(o.r)) && o.r.pauseReason === "stopped_before_review";
// SHOWN TO THE PERSON: the stop's own message (reviewHandoffNotes), not only the run log.
const handoffOf = (r: Record<string, unknown>): string => {
  const steps = Array.isArray(r.steps) ? (r.steps as Array<{ data?: { reviewHandoffNotes?: unknown } }>) : [];
  return [r.reviewHandoffNotes, ...steps.map((s) => s?.data?.reviewHandoffNotes)].flatMap((n) => (Array.isArray(n) ? n.map(String) : [])).join(" ");
};
const told = (o: Outcome, words: string): boolean => /AUTOMATION PICKED ANSWERS/.test(handoffOf(o.r)) && handoffOf(o.r).includes(words) && msgOf(o.r).includes("AUTOMATION PICKED ANSWERS");
const touched = (o: Outcome, id: string): boolean => o.gets.some((g) => /\/touched$/.test(g.path) && g.query.includes(`id=${id}`));
const noRadioOffered = (o: Outcome): boolean => !o.offered.some((f) => f.type === "radio") && o.offered.some((f) => /installer company/i.test(f.label));

try {
  {
    const o = await stage("filled");
    check("filled: the gap-fill answered the unrecorded select, and the stamped Submit was NOT clicked (0 POSTs)", submits(o) === 0 && o.posts.length === 0, brief(o));
    check("filled: the stop is a review stop, not an incident: no draft, no incident, nothing clicked", notAnIncident(o), brief(o));
    check("filled: the stop names the control automation filled", named(o, AGREE.slice(0, 40)), brief(o));
    check("filled: one control picked is counted and named once (\"picked 1 answer(s)\")", /automation picked 1 answer\(s\)/.test(cardLine(o.r)) && /automation picked 1 answer\(s\)/.test(msgOf(o.r)), brief(o));
    check("filled: the person is told in the stop message which answer automation added", told(o, AGREE.slice(0, 40)), brief(o));
    check("filled: the answer stays on the page for a person (the gap-fill reports it filled)", gapFilled(o.r).some((l) => l.includes(AGREE.slice(0, 40))), brief(o));
  }
  for (const [mode, what] of [
    ["inPage", "an in-page click that reveals a control"],
    ["nextReveal", 'a type=button "advance: Next" that only reveals section B'],
    ["continueReveal", 'a human-captured "Continue" that only reveals section B'],
    ["nextInPage", 'a "Next" that changes nothing'],
    ["opener", 'an "advance: Select from Account" that reveals an inline box'],
    ["revisit", "Next to Part 2 and a recorded goto back to Part 1 (the answer saved)"],
  ] as const) {
    const o = await stage(mode);
    check(`${mode}: ${what} after the gap-fill does not clear what it wrote — 0 POSTs, a named review stop`, submits(o) === 0 && o.posts.length === 0 && notAnIncident(o) && named(o, AGREE.slice(0, 40)), brief(o));
  }
  {
    const o = await stage("unboundRadio");
    check("unboundRadio: a required Yes/No radio group the stub picked with no project field — 0 POSTs, a named review stop", o.posts.length === 0 && notAnIncident(o) && named(o, "gap-fill: Is the system grid-tied?: Yes"), brief(o));
    const b = await stage("boundRadio");
    check("boundRadio: the same group answered through a bound project field (data) — one click, the draft", drafted(b), brief(b));
    const s2 = await stage("boundSelect");
    check("boundSelect: the \"filled\" select answered through a bound project field (data) — one click, the draft", drafted(s2), brief(s2));
  }
  {
    const o = await stage("arrays2");
    check("arrays2: a two-array project on a one-array recording (Add Array + row 2 from the project's arrays) — one click, the draft", drafted(o), brief(o));
    check("arrays2: ...and row 2 landed (the draft carries both arrays' quantities)", o.posts.some((p) => /(^|&)qty1=10(&|$)/.test(p.body) && /(^|&)qty2=6(&|$)/.test(p.body)), brief(o));
    const o1 = await stage("arrays1");
    check("arrays1: a one-array project on the same repeater page clicks once and reads as the draft", drafted(o1), brief(o1));
  }
  {
    const o = await stage("reassertEmail");
    check('reassertEmail: an earlier page\'s recorded "Email" re-asserted into Part 1\'s Email blank — 0 POSTs, a stop naming the live control', o.posts.length === 0 && notAnIncident(o) && named(o, 're-assert into "Email"') && touched(o, "email"), brief(o));
    const r = await stage("reassertReady");
    check('reassertReady: an earlier page\'s recorded "Net Metering" = Yes is never re-asserted into the ready-to-submit select (never touched, 0 POSTs)', submits(r) === 0 && notAnIncident(r) && !touched(r, "ready"), brief(r));
    const rr = await stage("rerender");
    check("rerender: Part 1's OWN recorded field blanked by a re-render is re-asserted and the click still goes (one click, the draft)", drafted(rr), brief(rr));
  }
  {
    const o = await stage("submitIntent");
    // The page's other required gap (Installer Company) makes the planner call real.
    check("submitIntent: a control reading as submit intent is never offered to the gap-fill planner", o.offered.some((f) => /installer company/i.test(f.label)) && !o.offered.some((f) => f.label.includes("ready to submit")), brief(o));
    check("submitIntent: never answered, so the stamped Submit is not clicked (0 POSTs) and nothing reads as filed", o.posts.length === 0 && notAnIncident(o) && !gapFilled(o.r).some((l) => /ready to submit/i.test(l)), brief(o));
  }
  for (const mode of ["radioLegend", "radioGroup", "radioAria"] as const) {
    const o = await stage(mode);
    check(`${mode}: the ready-to-submit question as a Yes/No radio group — no member offered to the planner, 0 POSTs`, noRadioOffered(o) && o.posts.length === 0 && notAnIncident(o), brief(o));
  }
  {
    const o = await stage("radioEarlier");
    const toPart1 = o.gets.filter((g) => /\/part1$/.test(g.path));
    check("radioEarlier: the ready-to-submit radio group on an EARLIER page is never offered or answered", noRadioOffered(o) && toPart1.length > 0 && !toPart1.some((g) => /readyR=/.test(g.query)), brief(o));
    check("radioEarlier: nothing extra on Part 1, so the stamped Submit is clicked once and reads as the draft", drafted(o), brief(o));
  }
  {
    const o = await stage("upload");
    check("upload: an unrecorded upload slot attached from the project's files (data) — one click, the draft", drafted(o) && o.posts.some((p) => p.body.includes("single-line-diagram.pdf")), brief(o));
  }
  {
    const o = await stage("contact");
    const m = msgOf(o.r);
    check("contact: a contact dialog corrected to the project's contact (data) — one click, the draft", drafted(o), brief(o));
    check("contact: no message carries a typed or prefilled value", !m.includes("office@acme.example") && !m.includes("pat.homeowner@example.test") && !m.includes("Acme Solar LLC"), brief(o));
  }
  {
    const o = await stage("substring");
    check('substring: the gap-fill\'s "Net Metering" answer lands on its own select, never on "…ready to submit your Net Metering…"', !touched(o, "ready") && gapFilled(o.r).includes("Net Metering"), brief(o));
    check("substring: the stop names the control actually written, and nothing is clicked (0 POSTs)", o.posts.length === 0 && notAnIncident(o) && named(o, "gap-fill: Net Metering") && !/gap-fill: Are you ready/.test(msgOf(o.r)), brief(o));
  }
  {
    const o = await stage("earlierPage");
    check("earlierPage: the gap-fill filled a box on the EARLIER page (the planner was asked there)", gapFilled(o.r).some((l) => /installer company/i.test(l)), brief(o));
    check("earlierPage: nothing extra on the Part 1 page, so the stamped Submit is clicked once and reads as the draft (as on main)", drafted(o), brief(o));
  }
  {
    const o = await stage("gotoEarlier");
    check("gotoEarlier: a gap-fill on an earlier page, then a recorded goto to Part 1 — one click, the draft", gapFilled(o.r).some((l) => /installer company/i.test(l)) && drafted(o), brief(o));
  }
  {
    const o = await stage("clean");
    check("clean: gap-fill enabled with nothing to answer — one click, the draft (as on main)", drafted(o) && o.r.ok === true, brief(o));
  }
} finally {
  server.close();
  fs.rmSync(sldDir, { recursive: true, force: true });
}
if (failures) { console.error(`\n${failures} draft-submit filled-page check(s) FAILED.`); process.exit(1); }
console.log("\nAll draft-submit filled-page checks passed (real Chromium).");
process.exit(0);
