// ---------------------------------------------------------------------------------------------
// MAY THE NETWORK BACKSTOP LET ONE "NEXT" OFF A HUMAN-VERIFIED INFORMATION PAGE? (#344, owner
// ruling 2026-10-15: option B).
//
// Hard rule 1's network backstop holds every state-changing request from a page the shared
// terminal reading (portalSafety terminalPageInPage) calls review (rule 4b). Portland DevHub's
// "Permitting Information" page says "A Permit Tech will review your submission", so its Next —
// a multipart form POST to the same path every SmartGuide step posts to — is held, and the run
// stops before anything is entered. The owner ruled against narrowing the text reading (#349: every
// narrowing filed a real summary page somewhere). Instead a NAMED PERSON marks that EXACT page once
// ("This is an information page — OK to advance"), and afterwards the backstop lets exactly ONE
// request through, inside 4(b) only, when ALL of these hold — and an unknown always refuses:
//
//   - the page, read fresh by the backstop itself at the click (portalSafety
//     infoPageIdentityInPage), is byte-for-byte the verified page: origin, path, query, title,
//     headings, forms, controls, frames and the whole text (one tenant toggle masked, nothing else);
//   - the steps that led there are EXACTLY the verified prefix (a different tile to the same page
//     is a different page), and they are only the entry click(s) and gotos — nothing typed, checked,
//     selected, uploaded or answered, no form page seen, no draft or signature resume, no earlier
//     progress of this project on this portal;
//   - the page has none of a review page's shape (any fillable control, a summary <dl>/<th>, a
//     submit- / final- / pay-worded control, a file input, a frame, the project's own values, a
//     draft or application-number notice, a GET / cross-origin / targeted form);
//   - the request is exactly what the verified control sends: method, action URL, media type and
//     every [name, sha256(value)] of the body in order; one request, from that page's main frame,
//     within 20 s, and the backstop's other rules (payment, filing URL, windows, the sticky lock 4a)
//     still apply before it.
//
// The contract follows signatureRequestGate.ts / portalSafety.finalSubmitRefusals: PURE (node:crypto
// only — no DOM, network or database), a plain boolean (mayPassInfoPage) and its reasons from a
// separately named function (infoPagePassRefusals). ONE predicate: the backstop's openInfoPagePass
// is its only caller; the backend's verify route runs the same shape half (infoPageShapeRefusals)
// and request half (infoPageRequestRefusals) before a person's verification is written.
//
// THREAT MODEL: a benign portal that changes. A hostile page script that poisons the DOM prototypes
// the identity read uses could lie to it (main's 4b reading has the same exposure); the request
// binding (exact action URL, media, ordered body) still decides what can be SENT.
// ---------------------------------------------------------------------------------------------

import { createHash } from "node:crypto";
import type { VerifiedInfoPage } from "./types";
import {
  INFO_PAGE_IDENTITY_VERSION,
  isFilingOrPaymentRequest,
  isFinalSubmitControl,
  isInterstitialForwardLabel,
  isPayFee,
  isPayRequestUrl,
  isReviewPageText,
  isSubmitIntent,
} from "./portalSafety";

export { INFO_PAGE_IDENTITY_VERSION };

// ---------------------------------------------------------------------------------------------
// What the page reading returns (raw; hashed in Node at once — raw values are never stored)
// ---------------------------------------------------------------------------------------------

/** One element of a form, as the identity reads it: [tag, type, name, hiddenValue | null]. */
export type InfoPageFormElement = [string, string, string, string | null];

export interface InfoPageIdentityMaterial {
  version: number;
  page: { origin: string; path: string; query: Array<[string, string]> };
  title: string;
  structure: {
    /** [level, collapsed textContent] of every h1-h6 and [role=heading]. */
    headings: Array<[string, string]>;
    forms: Array<{ id: string; name: string; method: string; enctype: string; action: string; target: string; elements: InfoPageFormElement[] }>;
    /** [tag, type, name, formIndex] of every fillable control, visible or not. */
    fillable: Array<[string, string, string, number]>;
    /** [tag, type, name, formIndex, href origin+path+sorted query KEYS] of every clickable. */
    clickables: Array<[string, string, string, number, string]>;
    /** [tag, src origin+path, width, height, sameOrigin] of every iframe/frame/object/embed. */
    frames: Array<[string, string, number, number, boolean]>;
  };
  facts: {
    fileInputsInForm: number;
    customFormElements: number;
    /** A <dl>/<dd>/<th> anywhere outside a header / footer / nav landmark. */
    summaryOutsideChrome: number;
    /** A <dl>/<dd>/<th> inside the control's own form. */
    summaryInForm: number;
    /** The label of every button / submit-capable input / [role=button] on the page. */
    controlLabels: string[];
    /** Names of the hidden inputs of the control's form. */
    hiddenNames: string[];
    /** How many elements the one tenant mask covered (0 or 1). */
    masked: number;
    /** <base target> of the document ("" when none). */
    baseTarget: string;
  };
  /** The body's textContent (script/style/noscript/template skipped, the one toggle masked),
   *  whitespace-collapsed. */
  text: string;
  control: { tag: string; type: string; name: string; value: string; label: string; formIndex: number; submitterIndex: number; method: string; action: string; enctype: string; target: string };
  /** What this control sends, built per the HTML entry-list rules (tree order). */
  request: { method: string; url: string; media: string; body: Array<[string, string]> };
}

export type InfoPageIdentityReading = { ok: true; material: InfoPageIdentityMaterial } | { ok: false; why: string };

// ---------------------------------------------------------------------------------------------
// The digest (what is compared and stored)
// ---------------------------------------------------------------------------------------------

/** The request the verified control sends: [name, sha256(value)] in order; the URL as a hash. */
export interface InfoPageExpectedRequest {
  method: string;
  /** origin + path of the action. */
  where: string;
  actionUrlSha: string;
  media: string;
  body: Array<[string, string]>;
}

/** The request the backstop saw (and held, or admitted). body null = unreadable. */
export interface InfoPageObservedRequest {
  method: string;
  where: string;
  actionUrlSha: string;
  media: string;
  body: Array<[string, string]> | null;
  hasFilenamePart: boolean;
}

/** The page's shape facts, without any value: what infoPageShapeRefusals judges, at the click and
 *  again at verify (stored in the candidate's digest_json). */
export interface InfoPageShape {
  controlTag: string;
  controlType: string;
  controlName: string;
  controlLabel: string;
  method: string;
  /** origin + path of the action, and its query KEYS. */
  actionWhere: string;
  actionQueryKeys: string[];
  pageOrigin: string;
  target: string;
  media: string;
  fileInputsInForm: number;
  customFormElements: number;
  fillableCount: number;
  frames: Array<{ tag: string; width: number; height: number; sameOrigin: boolean }>;
  summaryOutsideChrome: number;
  summaryInForm: number;
  controlLabels: string[];
  bodyNames: string[];
  hiddenNames: string[];
  masked: number;
  baseTarget: string;
  /** The text carries a draft / in-progress / application-number notice (read in Node, raw). */
  draftNotice: boolean;
}

export interface InfoPageComponents {
  pageSha: string;
  titleSha: string;
  structureSha: string;
  textSha: string;
  controlSha: string;
  requestSha: string;
}

export interface InfoPageDigest {
  version: number;
  identitySha256: string;
  components: InfoPageComponents;
  origin: string;
  path: string;
  queryKeys: string[];
  control: { tag: string; type: string; name: string; label: string; submitterIndex: number };
  expected: InfoPageExpectedRequest;
  shape: InfoPageShape;
  summary: { forms: number; fillable: number; frames: number; hiddenNames: string[]; headings: number };
}

/** One step of the path that led to the page: [action, note, goto origin+path+sorted query keys]. */
export type InfoPagePrefixStep = [string, string, string];

// ---------------------------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------------------------

export const sha256Hex = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

/** Canonical JSON: object keys sorted, arrays in order. */
const canon = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
};

const collapse = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();

/** origin + path of a URL ("" when unparseable). Never a query (it can carry a customer's data). */
export const infoPageWhereOf = (url: string): string => {
  try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return ""; }
};

/** A URL without its fragment (what a browser sends). */
const sansFragment = (url: string): string => {
  try { const u = new URL(url); u.hash = ""; return u.toString(); } catch { return String(url ?? "").split("#")[0]; }
};

export const infoPageActionUrlSha = (url: string): string => sha256Hex(sansFragment(url));

/** origin + path + sorted query KEYS: a goto's or link's place, without any value. */
export const infoPagePlaceKey = (url: string): string => {
  try {
    const u = new URL(url);
    const keys = Array.from(new Set(Array.from(u.searchParams.keys()))).sort();
    return `${u.origin}${u.pathname}${keys.length ? `?${keys.join("&")}` : ""}`;
  } catch { return ""; }
};

/** A draft in progress, or an application / record number, in the page's text: a page that names
 *  somebody's draft is never an information page (critique [4]: d1m opened and saved a draft). */
const DRAFT_NOTICE = /\b(in\s+progress|draft|saved\s+application|resume\s+(your\s+)?application)\b|\b(application|record|request|permit)\s*(no\.?|number|#)\s*:?\s*(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{3,}/i;
export const infoPageTextHasDraftNotice = (text: string): boolean => DRAFT_NOTICE.test(String(text ?? ""));

/**
 * THE DIGEST: six component hashes and one identity hash over them, plus what is kept in clear
 * (origin, path, query KEYS, the control's tag/type/name/label, form field NAMES). Raw hidden
 * values, body values and the page text never leave this function.
 */
export function digestInfoPageIdentity(m: InfoPageIdentityMaterial): InfoPageDigest {
  const queryKeys = Array.from(new Set(m.page.query.map(([k]) => k))).sort();
  const pageSha = sha256Hex(canon([m.page.origin, m.page.path, m.page.query]));
  const titleSha = sha256Hex(canon(collapse(m.title)));
  // Hidden values are hashed before the structure is (never kept raw).
  const structure = {
    ...m.structure,
    forms: m.structure.forms.map((f) => ({ ...f, elements: f.elements.map(([t, ty, n, v]) => [t, ty, n, v === null ? null : sha256Hex(v)]) })),
  };
  const structureSha = sha256Hex(canon([structure, m.facts]));
  const textSha = sha256Hex(collapse(m.text));
  const controlSha = sha256Hex(canon(m.control));
  const body: Array<[string, string]> = m.request.body.map(([n, v]) => [n, sha256Hex(v)]);
  const actionUrlSha = infoPageActionUrlSha(m.request.url);
  const requestSha = sha256Hex(canon([m.request.method, actionUrlSha, m.request.media, body]));
  const identitySha256 = sha256Hex(canon([m.version, pageSha, titleSha, structureSha, textSha, controlSha, requestSha]));
  let actionQueryKeys: string[] = [];
  try { actionQueryKeys = Array.from(new Set(Array.from(new URL(m.request.url).searchParams.keys()))).sort(); } catch { actionQueryKeys = []; }
  const shape: InfoPageShape = {
    controlTag: m.control.tag,
    controlType: m.control.type,
    controlName: m.control.name,
    controlLabel: collapse(m.control.label),
    method: String(m.request.method || "").toLowerCase(),
    actionWhere: infoPageWhereOf(m.request.url),
    actionQueryKeys,
    pageOrigin: m.page.origin,
    target: m.control.target,
    media: m.request.media,
    fileInputsInForm: m.facts.fileInputsInForm,
    customFormElements: m.facts.customFormElements,
    fillableCount: m.structure.fillable.length,
    frames: m.structure.frames.map(([tag, , width, height, sameOrigin]) => ({ tag, width, height, sameOrigin })),
    summaryOutsideChrome: m.facts.summaryOutsideChrome,
    summaryInForm: m.facts.summaryInForm,
    controlLabels: m.facts.controlLabels.map(collapse),
    bodyNames: m.request.body.map(([n]) => n),
    hiddenNames: m.facts.hiddenNames,
    masked: m.facts.masked,
    baseTarget: m.facts.baseTarget,
    draftNotice: infoPageTextHasDraftNotice(m.text),
  };
  return {
    version: m.version,
    identitySha256,
    components: { pageSha, titleSha, structureSha, textSha, controlSha, requestSha },
    origin: m.page.origin,
    path: m.page.path,
    queryKeys,
    control: { tag: m.control.tag, type: m.control.type, name: m.control.name, label: collapse(m.control.label), submitterIndex: m.control.submitterIndex },
    expected: { method: String(m.request.method || "").toUpperCase(), where: infoPageWhereOf(m.request.url), actionUrlSha, media: m.request.media, body },
    shape,
    summary: { forms: m.structure.forms.length, fillable: m.structure.fillable.length, frames: m.structure.frames.length, hiddenNames: m.facts.hiddenNames, headings: m.structure.headings.length },
  };
}

// ---------------------------------------------------------------------------------------------
// The shape half (also the backend verify route's check)
// ---------------------------------------------------------------------------------------------

const STANDARD_MEDIA = new Set(["multipart/form-data", "application/x-www-form-urlencoded"]);

/** Every reason this page can never be an information page a person may verify. Empty only when
 *  every structural condition holds. Read at the click AND at verify. */
export function infoPageShapeRefusals(shape: InfoPageShape | null | undefined): string[] {
  if (!shape) return ["the page's shape was not read"];
  const out: string[] = [];
  const s = shape;
  const label = collapse(s.controlLabel);
  if (!s.controlName) out.push("the forward control has no name, so its request cannot be told apart");
  if (!((s.controlTag === "button" && s.controlType === "submit") || (s.controlTag === "input" && s.controlType === "submit"))) {
    out.push(`the forward control is not a submit button (${s.controlTag}${s.controlType ? `[type=${s.controlType}]` : ""})`);
  }
  if (!isInterstitialForwardLabel(label)) out.push(`"${label.slice(0, 40)}" is not a plain forward control (Next / Continue / Proceed …)`);
  if (/^\s*save\s+and\b/i.test(label)) out.push(`"${label.slice(0, 40)}" saves as it goes — never an information page's way forward`);
  if (isSubmitIntent(label) || isFinalSubmitControl(label) || isPayFee(label)) out.push(`"${label.slice(0, 40)}" is submit-, filing- or pay-worded`);
  if (s.method !== "post") out.push(`the form is sent by ${s.method.toUpperCase() || "an unknown method"}, not POST`);
  if (!/^https?:\/\//i.test(s.actionWhere)) out.push("the form's action is not an http(s) URL");
  else {
    let actionOrigin = "";
    try { actionOrigin = new URL(s.actionWhere).origin; } catch { actionOrigin = ""; }
    if (!actionOrigin || actionOrigin !== s.pageOrigin) out.push("the form posts to another origin");
  }
  const target = String(s.target || "").trim().toLowerCase();
  if (target && target !== "_self") out.push(`the form posts into another window or frame (target="${target.slice(0, 20)}")`);
  const baseTarget = String(s.baseTarget || "").trim().toLowerCase();
  if (!target && baseTarget && baseTarget !== "_self") out.push(`the page's <base> sends forms elsewhere (target="${baseTarget.slice(0, 20)}")`);
  if (!STANDARD_MEDIA.has(s.media)) out.push(`the form is encoded as ${s.media || "an unknown type"} (only multipart and urlencoded are bound)`);
  if (s.fileInputsInForm > 0) out.push("the form carries a file input");
  if (s.customFormElements > 0) out.push("the page carries a form-associated custom element");
  if (s.fillableCount > 0) out.push(`the page carries ${s.fillableCount} fillable control(s) — an information page has none`);
  const shownFrames = s.frames.filter((f) => f.width > 1 || f.height > 1 || f.sameOrigin);
  if (shownFrames.length) out.push(`the page composes ${shownFrames.length} frame(s) (a rendered or same-origin iframe/frame/object/embed) the identity cannot see into`);
  if (s.summaryOutsideChrome > 0 || s.summaryInForm > 0) out.push("the page shows a summary (<dl> / <th> table) — the shape of a review page");
  const filingLabel = s.controlLabels.find((l) => isFinalSubmitControl(l) || isSubmitIntent(l) || isPayFee(l));
  if (filingLabel) out.push(`the page offers "${collapse(filingLabel).slice(0, 40)}", a submit-, filing- or pay-worded control`);
  const allowed = new Set([...s.hiddenNames, s.controlName]);
  const extra = s.bodyNames.filter((n) => !allowed.has(n));
  if (extra.length) out.push(`the request carries field(s) beyond the hidden inputs and the control (${extra.slice(0, 5).join(", ")})`);
  if (s.masked > 1) out.push("more than one control qualifies for the tenant mask");
  if (s.draftNotice) out.push("the page names a draft, an application in progress or an application / record number");
  if (isFilingOrPaymentRequest("POST", s.actionWhere) || isPayRequestUrl(s.actionWhere)) out.push("the form's action reads as a filing or a payment");
  return out;
}

/** The project's own values on the page (critique [4]): a page that echoes the customer's street,
 *  name, parcel or system size before anything was entered is a summary, never an information
 *  page. Read at the click (the learner's project) and at verify (the candidate's project row). */
export function infoPageProjectValueRefusals(text: string, values: ReadonlyArray<string | null | undefined>): string[] {
  const t = collapse(text).toLowerCase();
  if (!t) return [];
  const out: string[] = [];
  for (const raw of values) {
    const v = collapse(raw).toLowerCase();
    if (v.length < 4) continue;
    const kw = /^(\d+(?:\.\d+)?)\s*kw$/.exec(v);
    const esc = (kw ? kw[1] : v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const re = kw ? new RegExp(`(?<![\\d.])${esc}\\s*kw\\b`, "i") : new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`, "i");
    if (re.test(t)) { out.push("the page shows this project's own values (address, name, parcel or system size) — a summary, not an information page"); break; }
  }
  return out;
}

/** What the person verifying must look at twice — NEVER a refusal and never a mitigation (every
 *  class also fires on DevHub's own text). Shown on the card. */
export function infoPageVerifyWarnings(shape: InfoPageShape | null | undefined, text: string): string[] {
  const out: string[] = [];
  const t = String(text ?? "");
  if (/\b(pay|payment|fees?|charged?|card)\b/i.test(t)) out.push("The text mentions payment or fees — make sure nothing is paid by pressing the control.");
  if (/\b(submit\w*|send|sent|file|filed|filing)\b/i.test(t)) out.push("The text mentions submitting, sending or filing — make sure pressing the control files nothing.");
  if (isReviewPageText(t)) out.push("The text uses review wording — this is why the backstop held the page. Confirm it describes a FUTURE review, not this page.");
  if (shape && shape.hiddenNames.length) out.push(`The form carries hidden input(s): ${shape.hiddenNames.slice(0, 6).join(", ")}.`);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Run state, backstop state, the match
// ---------------------------------------------------------------------------------------------

export interface InfoPageRunStep {
  action: string;
  note?: string;
  /** goto steps: the URL. */
  value?: string;
  /** An "advance:" step an earlier info-page pass of THIS run admitted (tracked by the adapter). */
  admitted?: boolean;
}

export interface InfoPageRunState {
  priorSteps: InfoPageRunStep[];
  formPageSeen: boolean;
  continuedDraft: boolean;
  draftResume: boolean;
  signatureCheck: boolean;
  signatureStep: boolean;
  signatureDone: boolean;
  writes: number;
  gapFills: number;
  /** The backend says this project already reached review / recorded an application number /
   *  found an existing draft on this portal origin (critique [1]). */
  priorProgress: boolean;
  /** The project's own values (street, name, parcel, kW) — refused when on the page. */
  projectValues: string[];
}

export interface InfoPageBackstopState {
  installed: boolean;
  disposed: boolean;
  locked: boolean;
  windowsOpen: boolean;
  approvedSlotOpen: boolean;
  approvedEverOpened: boolean;
  stoppingAbort: boolean;
  everWrote: boolean;
  admissions: number;
  admittedEntryIds: string[];
  /** Does the reading 4(b) consults for this page's navigation say terminal? Only then would the
   *  backstop hold the click — only then is a pass (or a candidate) asked for. */
  wideTerminal: boolean | null;
}

export interface InfoPagePassContext {
  backstop: InfoPageBackstopState | null | undefined;
  run: InfoPageRunState | null | undefined;
  identity: { ok: boolean; why?: string; digest?: InfoPageDigest; projectValueHits?: string[] } | null | undefined;
  entries: ReadonlyArray<VerifiedInfoPage> | null | undefined;
}

/** The prefix of a run, as stored with a candidate and a pass. */
export function infoPagePrefixOf(steps: ReadonlyArray<InfoPageRunStep>): InfoPagePrefixStep[] {
  return steps.map((s) => {
    const action = String(s.action ?? "");
    const note = collapse(s.note);
    const place = action === "goto" ? infoPagePlaceKey(String(s.value ?? "")) : s.admitted ? "admitted" : "";
    return [action, note, place];
  });
}

/** Run-state: every prior step is an entry click, a goto / wait, or an advance an earlier pass of
 *  this run admitted; every flag false. A LITERAL list under test: a new note prefix widens it. */
export function infoPageRunStateRefusals(run: InfoPageRunState | null | undefined): string[] {
  if (!run) return ["the run's state was not given"];
  const out: string[] = [];
  if (!Array.isArray(run.priorSteps)) out.push("the run's steps were not given");
  else {
    run.priorSteps.forEach((s, i) => {
      const action = String(s?.action ?? "");
      const note = collapse(s?.note);
      const ok = action === "goto" || action === "waitFor"
        || (action === "click" && /^(application entry|permit type):/.test(note))
        || (action === "click" && /^advance:/.test(note) && s?.admitted === true);
      if (!ok) out.push(`step ${i + 1} (${action}${note ? ` "${note.slice(0, 40)}"` : ""}) is not an entry click — the run did something before this page`);
    });
  }
  const flags: Array<[keyof InfoPageRunState, string]> = [
    ["formPageSeen", "a page with a fillable control was already seen on this run"],
    ["continuedDraft", "the run opened an existing draft"],
    ["draftResume", "the run resumes a draft on record"],
    ["signatureCheck", "the run read a record's signature to resume"],
    ["signatureStep", "the run reached a signature step"],
    ["signatureDone", "the run signed something"],
    ["priorProgress", "this project already reached review, recorded an application number or found a draft on this portal"],
  ];
  for (const [k, why] of flags) {
    const v = run[k];
    if (typeof v !== "boolean") out.push(`the run did not say whether ${String(k)}`);
    else if (v) out.push(why);
  }
  if (typeof run.writes !== "number" || !Number.isFinite(run.writes)) out.push("the run did not count its writes");
  else if (run.writes > 0) out.push(`the run already wrote ${run.writes} value(s)`);
  if (typeof run.gapFills !== "number" || !Number.isFinite(run.gapFills)) out.push("the run did not count its gap fills");
  else if (run.gapFills > 0) out.push(`the run already filled ${run.gapFills} gap(s)`);
  if (!Array.isArray(run.projectValues)) out.push("the run did not give the project's values");
  return out;
}

/** The backstop's own state (read by the backstop itself, never by a caller). */
export const MAX_INFO_PAGE_ADMISSIONS = 3;
export function infoPageBackstopRefusals(bs: InfoPageBackstopState | null | undefined): string[] {
  if (!bs) return ["no network backstop is installed on this run"];
  const out: string[] = [];
  if (!bs.installed || bs.disposed) out.push("the network backstop is not live");
  if (bs.locked) out.push("the run already locked the review page (4a)");
  if (bs.windowsOpen) out.push("a dismisser / Enter window is open");
  if (bs.approvedSlotOpen || bs.approvedEverOpened) out.push("an approved final-submit slot was opened on this run");
  if (bs.stoppingAbort) out.push("the backstop already stopped a request on this run");
  if (bs.everWrote) out.push("the run already wrote a value through the backstop's own-write window");
  if (bs.admissions >= MAX_INFO_PAGE_ADMISSIONS) out.push(`the run already passed ${bs.admissions} information page(s)`);
  if (bs.wideTerminal !== true) out.push("the backstop does not read this page as terminal — its forward click is not held, so no pass is asked for");
  return out;
}

/** The refusal every NON-matching read begins with: the only class that opens a candidate watch. */
export const INFO_PAGE_NO_MATCH = "no verified information page matches";
export const isMatchClassRefusal = (r: string): boolean => r.startsWith(INFO_PAGE_NO_MATCH);

const sameBody = (a: ReadonlyArray<[string, string]> | null | undefined, b: ReadonlyArray<[string, string]> | null | undefined): boolean =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every(([n, v], i) => b[i][0] === n && b[i][1] === v);

const samePrefix = (a: ReadonlyArray<InfoPagePrefixStep>, b: ReadonlyArray<InfoPagePrefixStep>): boolean =>
  a.length === b.length && a.every((s, i) => s[0] === b[i][0] && s[1] === b[i][1] && s[2] === b[i][2]);

const COMPONENT_WORDS: Record<keyof InfoPageComponents, string> = {
  pageSha: "address (origin, path or query)", titleSha: "title", structureSha: "structure (headings, forms, controls, frames)",
  textSha: "text", controlSha: "forward control", requestSha: "request",
};

/** The match: exactly one entry with the same identity, version, control and request, whose
 *  prefix equals the run's. Otherwise "no verified information page matches", with the drifted
 *  components named against the closest entry at the same origin + path + control name — the
 *  date, never the person (critique [5]). */
export function infoPageMatchRefusals(
  digest: InfoPageDigest,
  entries: ReadonlyArray<VerifiedInfoPage>,
  prefix: ReadonlyArray<InfoPagePrefixStep>,
): { entry: VerifiedInfoPage | null; refusals: string[] } {
  const same = entries.filter((e) => e && e.identityVersion === digest.version && e.identitySha256 === digest.identitySha256);
  const exact = same.filter((e) => e.controlName === digest.control.name && collapse(e.controlLabel) === digest.control.label
    && e.request.method === digest.expected.method && e.request.where === digest.expected.where
    && e.request.actionSha256 === digest.expected.actionUrlSha && e.request.media === digest.expected.media
    && sameBody(e.request.body, digest.expected.body));
  if (exact.length === 1) {
    if (!Array.isArray(exact[0].prefix) || !samePrefix(exact[0].prefix, prefix)) {
      return { entry: null, refusals: [`${INFO_PAGE_NO_MATCH}: the page matches a verified page (${String(exact[0].verifiedAt).slice(0, 10)}), but the run reached it by different steps`] };
    }
    return { entry: exact[0], refusals: [] };
  }
  if (exact.length > 1) return { entry: null, refusals: [`${INFO_PAGE_NO_MATCH}: more than one verified entry claims this page`] };
  const near = entries.find((e) => e && e.origin === digest.origin && e.path === digest.path && e.controlName === digest.control.name);
  if (!near) return { entry: null, refusals: [`${INFO_PAGE_NO_MATCH}: no person has verified this page`] };
  const drifted = (Object.keys(COMPONENT_WORDS) as Array<keyof InfoPageComponents>)
    .filter((k) => !near.components || near.components[k] !== digest.components[k]).map((k) => COMPONENT_WORDS[k]);
  const version = near.identityVersion !== digest.version ? ` (identity version ${near.identityVersion} vs ${digest.version})` : "";
  return { entry: null, refusals: [`${INFO_PAGE_NO_MATCH}: the ${drifted.join(", ") || "identity"} differ(s) from a verified page (${String(near.verifiedAt).slice(0, 10)})${version}`] };
}

/** EVERY reason the backstop may NOT admit this page's forward request. Empty only when all hold. */
export function infoPagePassRefusals(ctx: InfoPagePassContext | null | undefined): string[] {
  if (!ctx) return ["no context"];
  const out: string[] = [];
  out.push(...infoPageBackstopRefusals(ctx.backstop));
  out.push(...infoPageRunStateRefusals(ctx.run));
  const id = ctx.identity;
  if (!id || id.ok !== true || !id.digest) {
    out.push(`the page could not be read as one identity${id && id.why ? `: ${id.why}` : ""}`);
    return out;
  }
  if (id.digest.version !== INFO_PAGE_IDENTITY_VERSION) out.push(`the page was read with identity version ${id.digest.version}, not ${INFO_PAGE_IDENTITY_VERSION}`);
  out.push(...infoPageShapeRefusals(id.digest.shape));
  if (!Array.isArray(id.projectValueHits)) out.push("the page was not checked for the project's own values");
  else out.push(...id.projectValueHits);
  const entries = Array.isArray(ctx.entries) ? ctx.entries : [];
  const prefix = infoPagePrefixOf(ctx.run && Array.isArray(ctx.run.priorSteps) ? ctx.run.priorSteps : []);
  const admitted = ctx.backstop && Array.isArray(ctx.backstop.admittedEntryIds) ? ctx.backstop.admittedEntryIds : [];
  const m = infoPageMatchRefusals(id.digest, entries, prefix);
  out.push(...m.refusals);
  if (m.entry && admitted.includes(m.entry.id)) out.push("this verified page was already passed once on this run");
  return out;
}

/** THE decision: may the backstop admit this page's one forward request? */
export function mayPassInfoPage(ctx: InfoPagePassContext | null | undefined): boolean {
  return infoPagePassRefusals(ctx).length === 0;
}

/** The matching entry, when (and only when) the predicate passes. */
export function infoPagePassEntry(ctx: InfoPagePassContext): VerifiedInfoPage | null {
  if (!mayPassInfoPage(ctx) || !ctx.identity?.digest) return null;
  const prefix = infoPagePrefixOf(ctx.run?.priorSteps ?? []);
  return infoPageMatchRefusals(ctx.identity.digest, ctx.entries ?? [], prefix).entry;
}

// ---------------------------------------------------------------------------------------------
// The request half
// ---------------------------------------------------------------------------------------------

/** The media type of a content-type header, lower-cased, parameters dropped. */
export const mediaTypeOf = (contentType: string | null | undefined): string => String(contentType ?? "").split(";")[0].trim().toLowerCase();

/**
 * A form body as [name, value] in order: multipart/form-data (with its boundary, Chromium's %22 /
 * %0D%0A quoting of names) or application/x-www-form-urlencoded. null when unreadable, malformed,
 * or any other media type (text/plain is ambiguous and never bound — critique [11]).
 */
export function parseFormBodyFields(contentType: string | null | undefined, body: Buffer | string | null | undefined): { fields: Array<[string, string]>; hasFilenamePart: boolean } | null {
  if (body === null || body === undefined) return null;
  const media = mediaTypeOf(contentType);
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  if (media === "application/x-www-form-urlencoded") {
    const text = buf.toString("utf8");
    if (text === "") return { fields: [], hasFilenamePart: false };
    const fields: Array<[string, string]> = [];
    for (const pair of text.split("&")) {
      if (pair === "") continue;
      const eq = pair.indexOf("=");
      const dec = (s: string): string | null => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return null; } };
      const n = dec(eq < 0 ? pair : pair.slice(0, eq));
      const v = dec(eq < 0 ? "" : pair.slice(eq + 1));
      if (n === null || v === null) return null;
      fields.push([n, v]);
    }
    return { fields, hasFilenamePart: false };
  }
  if (media === "multipart/form-data") {
    const m = /;\s*boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(String(contentType ?? ""));
    const boundary = m ? (m[1] ?? m[2]) : "";
    if (!boundary) return null;
    const text = buf.toString("latin1");
    const delim = `--${boundary}`;
    if (!text.startsWith(delim)) return null;
    const parts = text.split(delim);
    // parts[0] is "" (the body starts with the delimiter); the last is "--\r\n" (or "--").
    const last = parts[parts.length - 1];
    if (!/^--(\r\n)?$/.test(last)) return null;
    const fields: Array<[string, string]> = [];
    let hasFilenamePart = false;
    for (const part of parts.slice(1, -1)) {
      if (!part.startsWith("\r\n")) return null;
      const sep = part.indexOf("\r\n\r\n");
      if (sep < 0) return null;
      const head = part.slice(2, sep);
      if (!part.endsWith("\r\n")) return null;
      const valueLatin1 = part.slice(sep + 4, part.length - 2);
      const disp = head.split("\r\n").find((h) => /^content-disposition\s*:/i.test(h));
      if (!disp) return null;
      const nm = /;\s*name="((?:[^"\\]|\\.)*)"/i.exec(disp);
      if (!nm) return null;
      if (/;\s*filename\*?=/i.test(disp)) hasFilenamePart = true;
      const rawName = Buffer.from(nm[1], "latin1").toString("utf8");
      const name = rawName.replace(/%22/g, "\"").replace(/%0D/gi, "\r").replace(/%0A/gi, "\n");
      fields.push([name, Buffer.from(valueLatin1, "latin1").toString("utf8")]);
    }
    return { fields, hasFilenamePart };
  }
  return null;
}

/** What the backstop saw, as the digest compares it. */
export function infoPageObservedRequest(method: string, url: string, contentType: string | null | undefined, body: Buffer | string | null | undefined): InfoPageObservedRequest {
  const parsed = parseFormBodyFields(contentType, body);
  return {
    method: String(method || "").toUpperCase(),
    where: infoPageWhereOf(url),
    actionUrlSha: infoPageActionUrlSha(url),
    media: mediaTypeOf(contentType),
    body: parsed ? parsed.fields.map(([n, v]) => [n, sha256Hex(v)] as [string, string]) : null,
    hasFilenamePart: parsed ? parsed.hasFilenamePart : false,
  };
}

/** Every reason the observed request is not exactly the verified control's. */
export function infoPageRequestRefusals(expected: InfoPageExpectedRequest | null | undefined, observed: InfoPageObservedRequest | null | undefined): string[] {
  if (!expected) return ["no expected request"];
  if (!observed) return ["the request was not observed"];
  const out: string[] = [];
  if (observed.method !== "POST" || expected.method !== "POST") out.push(`the request is ${observed.method || "?"}, not POST`);
  if (observed.actionUrlSha !== expected.actionUrlSha || observed.where !== expected.where) out.push("the request goes to a different URL than the verified control's action");
  if (observed.media !== expected.media) out.push(`the request is ${observed.media || "unknown"}, not ${expected.media}`);
  if (!STANDARD_MEDIA.has(observed.media)) out.push("the request's media type is not bound (multipart / urlencoded only)");
  if (observed.body === null) out.push("the request body could not be read");
  else if (!sameBody(observed.body, expected.body)) out.push("the request body differs from what the verified control sends (a field added, removed, reordered or changed)");
  if (observed.hasFilenamePart) out.push("the request carries a file part");
  return out;
}

// ---------------------------------------------------------------------------------------------
// Evidence (project-scoped; values dropped, text scrubbed) and the pass row
// ---------------------------------------------------------------------------------------------

export interface InfoPageEvidence {
  title: string;
  headings: Array<[string, string]>;
  forms: Array<{ method: string; enctype: string; actionWhere: string; fields: Array<[string, string, string]> }>;
  frames: Array<[string, string]>;
  controlLabels: string[];
  text: string;
}

/** The evidence a person reads on the card: no value of any field, the text through `scrub`
 *  (the learner's secret scrub + redactStatusText), capped at 20 000 chars. */
export function infoPageEvidence(m: InfoPageIdentityMaterial, scrub: (s: string) => string = (s) => s): InfoPageEvidence {
  const cap = (s: string, n: number): string => s.length > n ? `${s.slice(0, n)}…` : s;
  return {
    title: cap(scrub(collapse(m.title)), 200),
    headings: m.structure.headings.slice(0, 40).map(([l, t]) => [l, cap(scrub(collapse(t)), 200)]),
    forms: m.structure.forms.map((f) => ({ method: f.method, enctype: f.enctype, actionWhere: infoPageWhereOf(f.action), fields: f.elements.slice(0, 60).map(([t, ty, n]) => [t, ty, n] as [string, string, string]) })),
    frames: m.structure.frames.map(([t, src]) => [t, src] as [string, string]),
    controlLabels: m.facts.controlLabels.slice(0, 60).map((l) => cap(scrub(collapse(l)), 80)),
    text: cap(scrub(collapse(m.text)), 20_000),
  };
}

/** The shared pass row, built ONLY from a candidate ROW the bot wrote (never from a request body).
 *  Hashes, names and structure only. */
export function verifiedInfoPageFromCandidate(c: { identityVersion: number; identitySha256: string; digest: InfoPageDigest; prefix: InfoPagePrefixStep[] }): Omit<VerifiedInfoPage, "id" | "verifiedAt"> {
  const d = c.digest;
  return {
    identityVersion: c.identityVersion,
    identitySha256: c.identitySha256,
    origin: d.origin,
    path: d.path,
    queryKeys: d.queryKeys,
    components: { ...d.components },
    controlTag: d.control.tag,
    controlType: d.control.type,
    controlName: d.control.name,
    controlLabel: d.control.label,
    request: { method: d.expected.method, where: d.expected.where, actionSha256: d.expected.actionUrlSha, media: d.expected.media, body: d.expected.body.map(([n, v]) => [n, v] as [string, string]) },
    prefix: c.prefix.map((s) => [s[0], s[1], s[2]] as InfoPagePrefixStep),
  };
}
