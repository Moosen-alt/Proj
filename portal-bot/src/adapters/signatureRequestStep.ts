// ---------------------------------------------------------------------------------------------
// THE SIGNATURE-REQUEST STEP (#308): PSE PowerClerk Part 2 step 4, "Project Agreements and
// Signature".
//
// The page (owner's live walkthrough, #305): four REQUIRED consents (Schedule 150, Schedule 152,
// PSE reviews/approves and may revise, meter location/clearance responsibility), then
// "Application for Signature (Individual)" with a signature-type choice:
//   - eSign: Preview Document is required first; "Request Signatures" then sends a DocuSign email
//     from NoReply@powerclerk.com to the PSE account holder; the status reads
//     "Not yet previewed" -> requested -> signed;
//   - Sign and Upload: preview, sign outside, Browse/upload. A person's choice, never the run's.
//
// What the run does here, deterministically (no planner call: nothing on this page is a judgement):
//   1. ticks every REQUIRED consent that speaks of no money (a consent that mentions a charge or a
//      fee is left for a person, named), and records each consent's text as a review note: what the
//      homeowner is agreeing to;
//   2. selects eSign (owner ruling 2026-09-27: the homeowner signs via DocuSign) and never Sign and
//      Upload;
//   3. clicks Preview Document and records what it produced (a document window, a download, or the
//      status moving) as review evidence. The document itself is the utility's, carrying the
//      account and meter numbers (rule 2), so only its name, size and hash are kept;
//   4. stops in front of Request Signatures: the default, the review state "awaiting signature
//      request". Only with a named person's approval of exactly this run, and only when
//      signatureRequestGate says every condition holds, it clicks Request Signatures ONCE and reads
//      the status back ("requested"); the track then waits on the homeowner's signature (#310).
//
// Request Signatures files nothing, so hard rule 1's gate (mayClickFinalSubmit) is neither asked nor
// changed. It is recorded as a stopForReview marker carrying outwardAction "request_signatures",
// never as a click and never isFinalSubmit, so no replay can click it.
// ---------------------------------------------------------------------------------------------
import { createHash } from "node:crypto";
import { PORTAL_SAFETY_GLOBAL, PORTAL_SAFETY_IN_PAGE_SOURCE } from "../../../shared/src/portalSafety";
import {
  signatureRequestRefusals, signatureStatusSaysRequested,
  type SignatureRequestApproval, type SignatureRequestPageState,
} from "../../../shared/src/signatureRequestGate";
import type { RecipeSelector, RecipeStep } from "../../../shared/src/types";

export interface SignatureStepControl { i: number; id: string; name: string; label: string; tag: string; type: string }
export interface SignatureConsent extends SignatureStepControl { text: string; checked: boolean; required: boolean; money: boolean }
export interface SignatureTypeChoice extends SignatureStepControl { kind: "radio" | "option"; value: string; selected: boolean }

/** The step-4 page as read in the browser. Controls carry data-al-sr-i so they can be found again. */
export interface SignatureStepRead {
  request: SignatureStepControl[];
  preview: SignatureStepControl[];
  consents: SignatureConsent[];
  eSign: SignatureTypeChoice | null;
  signAndUpload: SignatureTypeChoice | null;
  status: string;
}

export type SignatureStepState =
  /** The default stop: everything staged, Request Signatures left for a person (or an approved run). */
  | "awaiting_signature_request"
  /** An approved run clicked Request Signatures and the status reads requested: waiting on the homeowner. */
  | "awaiting_customer_signature"
  /** An approved run clicked it and the status did NOT confirm: a person checks the portal before anything is clicked again. */
  | "signature_request_unconfirmed";

export interface SignatureStepOutcome {
  state: SignatureStepState;
  /** One sentence for the hand-off message. */
  why: string;
  /** Every consent's text (what the homeowner agrees to), scrubbed and capped — a review note, not a stop. */
  consentTexts: string[];
  consentsTicked: number;
  /** Required consents the run did NOT tick, and why. */
  consentsLeft: string[];
  signatureType: SignatureRequestPageState["signatureType"];
  preview: { kind: "window" | "download" | "status" | "none"; where?: string; filename?: string; bytes?: number; sha256?: string };
  statusBefore: string;
  statusAfter: string;
  /** Who approved the request in this run, when the run held an approval. */
  approvedBy: string | null;
  /** Why the gate refused, when the run held an approval it could not use (that approval is spent). */
  refusals: string[];
  requestClicked: boolean;
}

export interface SignatureStepOptions {
  steps: RecipeStep[];
  /** This run's named approval of the signature request, or null (the default stop). */
  approval: SignatureRequestApproval | null;
  runId: string;
  /** Masks every secret the run knows (account / meter) in any text kept from the page. */
  scrub?: (text: string) => string;
  /** How long to wait for Preview Document / Request Signatures to answer. */
  settleMs?: number;
  debugEvent?: (evt: Record<string, unknown>) => void;
}

// Read in the page: plain JS, no named inner functions (tsx's __name helper does not exist there).
// The request control is decided by the shared predicate (window.__portalSafety.isSignatureRequestControl)
// so the learner, the recorders and the replay refuse exactly the same controls.
const READ_IN_PAGE = `(() => {
  var ps = globalThis[${JSON.stringify(PORTAL_SAFETY_GLOBAL)}];
  if (!ps || typeof ps.isSignatureRequestControl !== "function") return null;
  var squash = function (s) { return String(s || "").replace(/\\s+/g, " ").trim(); };
  var visible = function (el) {
    var r = el.getBoundingClientRect(); var cs = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && cs.display !== "none" && cs.visibility !== "hidden";
  };
  var labelOf = function (el) {
    var bits = [];
    if (el.labels) for (var k = 0; k < el.labels.length; k++) bits.push(el.labels[k].textContent || "");
    if (!squash(bits.join(" "))) bits.push(el.getAttribute("aria-label") || "");
    if (!squash(bits.join(" ")) && el.closest && el.closest("label")) bits.push(el.closest("label").textContent || "");
    return squash(bits.join(" "));
  };
  var textAround = function (el) {
    var own = labelOf(el);
    if (own.length >= 12) return own;
    var n = el.parentElement;
    for (var d = 0; n && d < 4; d++, n = n.parentElement) {
      var t = squash(n.innerText || n.textContent || "");
      if (t.length >= 12) return t.slice(0, 600);
    }
    return own;
  };
  var n = 0;
  var mark = function (el, role) { var i = n++; el.setAttribute("data-al-sr", role); el.setAttribute("data-al-sr-i", String(i)); return i; };
  var ctl = function (el, role, label) {
    return { i: mark(el, role), id: el.id || "", name: el.getAttribute("name") || "", label: label, tag: el.tagName.toLowerCase(), type: String(el.getAttribute("type") || "").toLowerCase() };
  };
  document.querySelectorAll("[data-al-sr]").forEach(function (el) { el.removeAttribute("data-al-sr"); el.removeAttribute("data-al-sr-i"); });
  var out = { request: [], preview: [], consents: [], eSign: null, signAndUpload: null, status: "" };
  var ESIGN = /^\\s*(e-?\\s*sign(ature)?|electronic(ally)?\\s+sign(ature)?|docusign)\\b/i;
  var UPLOAD = /\\bsign\\s*(and|&)\\s*upload\\b|\\bwet\\s+sign|\\bupload\\b/i;
  var PREVIEW = /^\\s*preview(\\s+(the\\s+)?(document|application|form|pdf|agreement))?\\s*$/i;
  var clickables = document.querySelectorAll("button, a, input[type=button], input[type=submit], [role=button]");
  for (var c = 0; c < clickables.length; c++) {
    var el = clickables[c];
    if (!visible(el)) continue;
    var label = squash(el.innerText || el.value || el.getAttribute("aria-label") || el.textContent || "");
    if (!label || label.length > 60) continue;
    if (ps.isSignatureRequestControl(label)) out.request.push(ctl(el, "request", label));
    else if (PREVIEW.test(label)) out.preview.push(ctl(el, "preview", label));
  }
  if (!out.request.length) return out;
  var boxes = document.querySelectorAll("input[type=checkbox]");
  for (var b = 0; b < boxes.length; b++) {
    var box = boxes[b];
    if (!visible(box) || box.disabled) continue;
    var text = textAround(box);
    var lab = labelOf(box);
    var required = box.required || box.getAttribute("aria-required") === "true" || /\\*/.test(lab)
      || !!(box.closest && box.closest(".required, [class*=required], [data-required=true]"));
    if (/\\boptional\\b/i.test(text)) required = false;
    var row = ctl(box, "consent", lab || text.slice(0, 80));
    row.text = text; row.checked = box.checked === true; row.required = !!required;
    row.money = typeof ps.isPaymentWordedText === "function" ? ps.isPaymentWordedText(text) : /\\$\\s?\\d|\\bfees?\\b|\\bcharges?\\b/i.test(text);
    out.consents.push(row);
  }
  var radios = document.querySelectorAll("input[type=radio]");
  for (var r = 0; r < radios.length; r++) {
    var rd = radios[r];
    var rl = labelOf(rd) || squash(rd.value);
    var kindOf = UPLOAD.test(rl) ? "upload" : ESIGN.test(rl) ? "esign" : "";
    if (!kindOf || rd.disabled) continue;
    var ch = ctl(rd, kindOf, rl);
    ch.kind = "radio"; ch.value = rd.value || ""; ch.selected = rd.checked === true;
    if (kindOf === "esign" && !out.eSign) out.eSign = ch;
    if (kindOf === "upload" && !out.signAndUpload) out.signAndUpload = ch;
  }
  if (!out.eSign) {
    var sels = document.querySelectorAll("select");
    for (var s = 0; s < sels.length && !out.eSign; s++) {
      var sel = sels[s];
      if (!visible(sel) || sel.disabled) continue;
      for (var o = 0; o < sel.options.length; o++) {
        var opt = sel.options[o]; var ol = squash(opt.textContent || opt.value);
        var k2 = UPLOAD.test(ol) ? "upload" : ESIGN.test(ol) ? "esign" : "";
        if (!k2) continue;
        var row2 = { i: -1, id: sel.id || "", name: sel.getAttribute("name") || "", label: ol, tag: "select", type: "", kind: "option", value: opt.value, selected: opt.selected === true };
        if (k2 === "esign" && !out.eSign) { row2.i = mark(sel, "esign-select"); out.eSign = row2; }
        if (k2 === "upload" && !out.signAndUpload) out.signAndUpload = row2;
      }
    }
  }
  // The signature status: the nearest "Status" line above the request control.
  var anchor = document.querySelector("[data-al-sr=request]");
  for (var up = anchor ? anchor.parentElement : null, depth = 0; up && depth < 8 && !out.status; up = up.parentElement, depth++) {
    var lines = String(up.innerText || "").split(/\\n+/);
    for (var li = 0; li < lines.length; li++) {
      var m = lines[li].match(/\\bstatus\\b\\s*[:\\-–—]?\\s*(.*)$/i);
      if (!m) continue;
      var val = squash(m[1] || lines[li + 1] || "");
      if (val) { out.status = val.slice(0, 80); break; }
    }
  }
  return out;
})()`;

/** Read the step-4 page. null when the page offers no Request Signatures control (not this step). */
export async function readSignatureRequestStep(page: unknown): Promise<SignatureStepRead | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = page as any;
  if (!p || typeof p.evaluate !== "function") return null;
  await p.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE).catch(() => null);
  const read = (await p.evaluate(READ_IN_PAGE).catch(() => null)) as SignatureStepRead | null;
  return read && Array.isArray(read.request) && read.request.length ? read : null;
}

const selectorFor = (c: SignatureStepControl): RecipeSelector => {
  const labelFb = c.label ? [{ label: c.label }] : [];
  if (c.id && /^[A-Za-z][\w-]*$/.test(c.id)) return { css: `#${c.id}`, ...(labelFb.length ? { fallbacks: labelFb } : {}) };
  if (c.name) return { css: `[name="${c.name.replace(/"/g, '\\"')}"]`, ...(labelFb.length ? { fallbacks: labelFb } : {}) };
  return c.label ? { label: c.label } : { text: c.label };
};

const squash = (s: string): string => String(s || "").replace(/\s+/g, " ").trim();
const originPath = (u: string): string => { try { const x = new URL(u); return `${x.origin}${x.pathname}`; } catch { return ""; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Stage step 4 and stop in front of Request Signatures, or, in a run a named person approved and
 * only when the gate allows it, click Request Signatures once. Never selects Sign and Upload,
 * never clicks its Browse, never pays, never submits.
 */
export async function stageSignatureRequestStep(page: unknown, first: SignatureStepRead, opts: SignatureStepOptions): Promise<SignatureStepOutcome> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = page as any;
  const scrub = opts.scrub ?? ((t: string) => t);
  const settleMs = opts.settleMs ?? 8000;
  const at = (i: number) => p.locator(`[data-al-sr-i="${i}"]`).first();
  const ev = (e: Record<string, unknown>) => { try { opts.debugEvent?.(e); } catch { /* debug never changes the outcome */ } };
  let read = first;

  // 1) THE CONSENTS. Required, money-free, unticked: ticked, blurred (PowerClerk autosaves per field on
  //    blur) and read back. Every consent's words are kept as a review note.
  const consentTexts = read.consents.map((c) => scrub(squash(c.text)).slice(0, 300)).filter(Boolean);
  const consentsLeft: string[] = [];
  let consentsTicked = 0;
  for (const c of read.consents) {
    if (c.checked) continue;
    const short = scrub(squash(c.text)).slice(0, 80);
    if (!c.required) continue; // optional (a production meter, aggregation): a person's choice
    if (c.money) { consentsLeft.push(`"${short}" speaks of a charge or fee — a person decides it`); continue; }
    const loc = at(c.i);
    const ok = await loc.check({ timeout: 5000 }).then(() => true)
      .catch(() => loc.check({ timeout: 5000, force: true }).then(() => true).catch(() => false));
    await loc.evaluate((el: HTMLElement) => { el.dispatchEvent(new Event("change", { bubbles: true })); el.blur(); }).catch(() => null);
    const held = await loc.isChecked({ timeout: 2000 }).catch(() => false);
    if (!ok || !held) { consentsLeft.push(`"${short}" could not be ticked`); continue; }
    consentsTicked++;
    opts.steps.push({ action: "check", phase: "fill", selector: selectorFor(c), note: `consent: ${short}` });
  }
  ev({ type: "signature_step_consents", ticked: consentsTicked, left: consentsLeft.length, total: read.consents.length });

  // 2) eSign, NEVER Sign and Upload. A page with no signature-type choice and a Request Signatures
  //    control is an eSign page already.
  if (read.eSign && !read.eSign.selected) {
    const loc = at(read.eSign.i);
    if (read.eSign.kind === "radio") {
      await loc.check({ timeout: 5000 }).catch(() => loc.check({ timeout: 5000, force: true }).catch(() => null));
      opts.steps.push({ action: "check", phase: "fill", selector: selectorFor(read.eSign), note: "signature type: eSign (never Sign and Upload)" });
    } else {
      await loc.selectOption({ value: read.eSign.value }, { timeout: 5000 }).catch(() => null);
      opts.steps.push({ action: "select", phase: "fill", selector: selectorFor(read.eSign), value: read.eSign.label, note: "signature type: eSign (never Sign and Upload)" });
    }
    await loc.evaluate((el: HTMLElement) => { el.dispatchEvent(new Event("change", { bubbles: true })); el.blur(); }).catch(() => null);
    await sleep(400);
  }
  read = (await readSignatureRequestStep(p)) ?? read;
  const signatureType: SignatureRequestPageState["signatureType"] = read.signAndUpload?.selected
    ? "sign_and_upload"
    : (read.eSign ? (read.eSign.selected ? "esign" : "") : (read.signAndUpload ? "" : "esign"));
  const statusBefore = scrub(read.status);

  // 3) PREVIEW DOCUMENT. What it produced is the evidence: a document window (closed again), a
  //    download (named, sized, hashed, discarded), or the page's own status moving.
  const preview: SignatureStepOutcome["preview"] = { kind: "none" };
  const already = signatureStatusSaysRequested(statusBefore);
  if (read.preview.length === 1 && signatureType === "esign" && !already) {
    const loc = at(read.preview[0].i);
    const context = typeof p.context === "function" ? p.context() : null;
    const popupP = context ? context.waitForEvent("page", { timeout: settleMs }).catch(() => null) : Promise.resolve(null);
    const downloadP = p.waitForEvent("download", { timeout: settleMs }).catch(() => null);
    const clicked = await loc.click({ timeout: 8000 }).then(() => true).catch(() => false);
    if (clicked) {
      opts.steps.push({ action: "click", phase: "fill", selector: selectorFor(read.preview[0]), note: "preview document: opens the signature document for review (sends nothing)" });
      const got = await Promise.race([
        popupP.then((w: unknown) => (w ? { w } : null)),
        downloadP.then((d: unknown) => (d ? { d } : null)),
        sleep(settleMs).then(() => null),
      ]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = (got as any)?.w; const d = (got as any)?.d;
      if (w) {
        await w.waitForLoadState?.("domcontentloaded", { timeout: settleMs }).catch(() => null);
        preview.kind = "window";
        preview.where = originPath(String(w.url?.() ?? ""));
        await w.close?.().catch(() => null);
      } else if (d) {
        preview.kind = "download";
        preview.filename = scrub(String(d.suggestedFilename?.() ?? "")).slice(0, 120);
        const path = await d.path?.().catch(() => null);
        if (path) {
          const { readFile } = await import("node:fs/promises");
          const buf = await readFile(path).catch(() => null);
          if (buf) { preview.bytes = buf.length; preview.sha256 = createHash("sha256").update(buf).digest("hex"); }
        }
        await d.delete?.().catch(() => null);
      }
      await p.bringToFront?.().catch(() => null);
      await p.waitForLoadState?.("domcontentloaded", { timeout: 5000 }).catch(() => null);
      await sleep(500);
    }
  }
  read = (await readSignatureRequestStep(p)) ?? read;
  let statusAfter = scrub(read.status);
  if (preview.kind === "none" && statusAfter && statusAfter !== statusBefore && /\bpreview/i.test(statusAfter)) preview.kind = "status";
  const previewed = preview.kind !== "none";
  ev({ type: "signature_step_preview", kind: preview.kind, statusBefore, statusAfter });

  // 4) THE STOP, recorded as such: never a click, never final, never replayed.
  const requestCtl = read.request[0];
  const stopStep: RecipeStep = {
    action: "stopForReview", phase: "review", selector: selectorFor(requestCtl), isFinalSubmit: false, outwardAction: "request_signatures",
    note: `${requestCtl.label}: emails the homeowner a DocuSign request — not the filing; never replayed; clicked only in a run a named person approved`,
  };
  opts.steps.push(stopStep);
  const base = { consentTexts, consentsTicked, consentsLeft, signatureType, preview, statusBefore };
  const consentsComplete = read.consents.every((c) => !c.required || c.checked);

  if (already || signatureStatusSaysRequested(statusAfter)) {
    return { ...base, statusAfter, state: "awaiting_customer_signature", why: `the signature status already reads "${statusAfter || statusBefore}": the request went before this run, so nothing was clicked`, approvedBy: opts.approval?.approver ?? null, refusals: opts.approval ? ["the signature request was already sent"] : [], requestClicked: false };
  }
  if (!opts.approval) {
    return { ...base, statusAfter, state: "awaiting_signature_request", why: "stopped in front of Request Signatures: a person clicks it (it emails the homeowner a DocuSign request), or approves a run that does", approvedBy: null, refusals: [], requestClicked: false };
  }
  const refusals = signatureRequestRefusals({
    runApproval: opts.approval, runId: opts.runId,
    page: { requestControls: read.request.length, previewed, signatureType, consentsComplete, status: statusAfter },
  });
  if (refusals.length) {
    ev({ type: "signature_request_refused", reasons: refusals });
    return { ...base, statusAfter, state: "awaiting_signature_request", why: `approved by ${opts.approval.approver}, but Request Signatures was NOT clicked: ${refusals.join("; ")}. The approval is spent; a person clicks it, or approves a new run`, approvedBy: opts.approval.approver, refusals, requestClicked: false };
  }

  // 5) THE APPROVED CLICK — once. Whatever the page says next, it is never clicked again in this run.
  const clicked = await at(requestCtl.i).click({ timeout: 10000 }).then(() => true).catch(() => false);
  if (clicked) {
    await p.waitForLoadState?.("networkidle", { timeout: settleMs }).catch(() => null);
    for (let t = 0; t < 6; t++) {
      const again = await readSignatureRequestStep(p);
      statusAfter = scrub(again?.status ?? (await p.locator("body").innerText().catch(() => "")).match(/\bstatus\b\s*[:\-–—]?\s*([^\n]{2,60})/i)?.[1] ?? "");
      if (signatureStatusSaysRequested(statusAfter)) break;
      await sleep(500);
    }
  }
  stopStep.note = `${requestCtl.label}: ${clicked ? `CLICKED in the run ${opts.approval.approver} approved` : "the approved click did NOT go through"} — not the filing; never replayed`;
  ev({ type: "signature_request_clicked", clicked, statusAfter, approvedBy: opts.approval.approver });
  if (clicked && signatureStatusSaysRequested(statusAfter)) {
    return { ...base, statusAfter, state: "awaiting_customer_signature", why: `Request Signatures clicked in the run ${opts.approval.approver} approved; the status reads "${statusAfter}". The homeowner signs through DocuSign; the application is still unsubmitted`, approvedBy: opts.approval.approver, refusals: [], requestClicked: true };
  }
  return { ...base, statusAfter, state: "signature_request_unconfirmed", why: clicked
    ? `Request Signatures was clicked in the run ${opts.approval.approver} approved, but the status does not read requested ("${statusAfter || "unreadable"}"). Check the portal before anyone clicks it again`
    : `the approved click on Request Signatures did not go through; nothing was sent that the run could see. Check the portal before anyone clicks it`,
  approvedBy: opts.approval.approver, refusals: [], requestClicked: clicked };
}
