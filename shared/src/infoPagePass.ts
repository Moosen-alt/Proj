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
// WHAT INVALIDATES IT (proposal §4, approved 2026-10-16): before the click, a page at a verified
// page's origin + path that reads differently (signature, control, request, the steps before it) is
// held exactly as on main and each such pass is an incident (infoPageDriftedEntries); after the
// click, the page it led to must show POSITIVE evidence of an unfiled application form
// (infoPageAfterClickRefusals — two empty plain fields in one form outside the page's chrome, the
// shared terminal and receipt / error readings say no, no frame, no filing-worded control and no
// number that was not on the information page), or the run stops. Either incident withdraws the
// pass (the backend deletes it) and nothing is recorded as filed.
//
// PROOF OF PROGRESS (round 3 — a STRUCTURAL check that reads no wording): a page that passed the
// after-click reading must then take THIS JOB'S OWN DATA before the run may leave it. The backstop
// holds every state-changing request but the run's own writes until the learner records a fill /
// select / check bound to one of the job's own values there (infoPageProofStepRefusals — not a
// policy default, a company constant, a literal, a secret or a trivial value). A run that leaves the
// page, ends, stops or finds "nothing fillable" first is the same incident: the pass is withdrawn,
// and every project that used it is told the verified page may have filed. The content readings
// above stay as an extra layer.
//
// ROUND 4: the proof is WHAT THE PAGE HOLDS — a bound job key counts only when its control, read back
// just before the run leaves the page, holds the job's own value for that key (infoPageProofNorm)
// outside the page's chrome (the after-click reading's own container rule); this job's own values
// exclude everything the company or the defaults supply (infoPageJobValues). And a verification
// EXPIRES (INFO_PAGE_PASS_MAX_AGE_DAYS / INFO_PAGE_PASS_MAX_PROJECTS, below): a page whose Next starts
// filing server-side while still leading to a fresh application form is indistinguishable from the
// normal flow to every reader the bot has, so nothing detects it — the expiry and once per project
// are what bound it.
//
// The contract follows signatureRequestGate.ts / portalSafety.finalSubmitRefusals: PURE (node:crypto
// only — no DOM, network or database), a plain boolean (mayPassInfoPage) and its reasons from a
// separately named function (infoPagePassRefusals). ONE predicate: the backstop's openInfoPagePass
// is its only caller; the backend's verify route runs the same shape half (infoPageShapeRefusals)
// and request half (infoPageRequestRefusals) before a person's verification is written. The pass
// itself is a server-owned record only a person's verify creates (backend/src/infoPages.ts); the
// bot receives it only as input, never from recipe steps or any other data.
//
// THREAT MODEL: a benign portal that changes. A hostile page script that poisons the DOM prototypes
// the identity read uses could lie to it (main's 4b reading has the same exposure); the request
// binding (exact action URL, media, ordered body) still decides what can be SENT.
// ---------------------------------------------------------------------------------------------

import { createHash } from "node:crypto";
import type { VerifiedInfoPage } from "./types";
import {
  INFO_PAGE_IDENTITY_VERSION,
  classifySubmissionText,
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
  /** The text asks for an amount due / charged NOW (read in Node, raw). */
  amountDueNow: boolean;
  /** Helm's review of #349: the NAMES of hidden inputs (any form) whose value a plain sha256 would
   *  not protect — a secret-like name or a digit-run value (infoPageHiddenSecretNames). Never a value.
   *  Missing (a digest from before this field) refuses. */
  hiddenSecretLike: string[];
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

/** An AMOUNT due or charged NOW, in one sentence ("A $350 fee is due now", "will be charged to the
 *  card on file now"): a page that asks for money before anything was entered is never an
 *  information page (rule 1: automation never pays). DevHub's "how to pay your intake fees" names
 *  no amount and no "now", so it stays a warning there. */
export const infoPageTextAsksAmountNow = (text: string): boolean => String(text ?? "").split(/[.!?\n]+/).some((s) =>
  /\$\s*\d/.test(s) && /\b(due|charged?|payable|owed|pay|paid)\b/i.test(s) && /\b(now|today|immediately)\b/i.test(s));

/**
 * HIDDEN VALUES A PLAIN HASH DOES NOT PROTECT (Helm's review of #349). The digest keeps each hidden
 * input's value as an unkeyed sha256 (the request body, per value, in the shared pass table; the
 * structure hash over every form). A short or low-entropy value — `acctNo=4821` — is brute-forced
 * back from its hash in moments, so a page that carries one is NEVER verified (fail closed: refused
 * by infoPageShapeRefusals, so no candidate is kept and nothing is stored):
 *   - a SECRET-LIKE NAME, read word by word (camelCase, `_`, `$`, `-`, `.` split, adjacent words
 *     joined: "acctNo", "ctl00$Main$txtMeterNumber", "ESIID", "sa_id"): account / acct, meter,
 *     password / passcode / pwd / pin, SSN / social, tax id / EIN / TIN, routing / IBAN, card / CVV,
 *     ESI / ESIID, SA id (SAID), date of birth;
 *   - a DIGIT-RUN VALUE: four or more digits with at most two letters, whatever the separators
 *     ("4821", "7734-009-155", "AC 48213"), up to 40 characters (a longer value is a token, not a
 *     number a person types).
 * A CSRF token, a view state or a step name is neither. Names only are returned, never a value.
 */
const SECRET_NAME_WORDS = new Set([
  "acct", "account", "accountno", "accountnum", "accountnumber", "acctno", "acctnum",
  "meter", "meterno", "meternum", "meternumber", "meterid",
  "password", "passwd", "passcode", "passphrase", "pwd", "pin", "pincode",
  "ssn", "social", "socialsecurity", "taxid", "ein", "tin", "routing", "routingnumber", "iban",
  "card", "cardno", "cardnumber", "cvv", "cvc",
  "esi", "esiid", "said", "dob", "birthdate", "dateofbirth",
]);
const nameWords = (name: string): string[] => String(name ?? "")
  .replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/([A-Za-z])(\d)/g, "$1 $2").replace(/(\d)([A-Za-z])/g, "$1 $2")
  .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** The name reads as a customer secret, word by word (and each pair of adjacent words joined). */
export const isSecretLikeFieldName = (name: string): boolean => {
  const w = nameWords(name);
  return w.some((x, i) => SECRET_NAME_WORDS.has(x) || (i + 1 < w.length && SECRET_NAME_WORDS.has(`${x}${w[i + 1]}`)) || (i + 2 < w.length && SECRET_NAME_WORDS.has(`${x}${w[i + 1]}${w[i + 2]}`)));
};
/** The value is a number a person would type (4+ digits, at most 2 letters, at most 40 characters). */
export const isDigitRunValue = (value: string): boolean => {
  const v = String(value ?? "").trim();
  if (!v || v.length > 40) return false;
  return (v.match(/\d/g) ?? []).length >= 4 && (v.match(/[A-Za-z]/g) ?? []).length <= 2;
};
/** The NAMES of hidden inputs (every form, and the control's own request body) whose value a plain
 *  hash would not protect. */
export function infoPageHiddenSecretNames(m: InfoPageIdentityMaterial): string[] {
  const out = new Set<string>();
  for (const f of Array.isArray(m?.structure?.forms) ? m.structure.forms : []) {
    for (const [, , name, v] of Array.isArray(f.elements) ? f.elements : []) {
      if (v === null || v === undefined) continue; // not a hidden input (only those carry a value here)
      if (isSecretLikeFieldName(name) || isDigitRunValue(v)) out.add(String(name || "(unnamed)"));
    }
  }
  const hidden = new Set(Array.isArray(m?.facts?.hiddenNames) ? m.facts.hiddenNames : []);
  for (const [n, v] of Array.isArray(m?.request?.body) ? m.request.body : []) {
    if (hidden.has(n) && (isSecretLikeFieldName(n) || isDigitRunValue(v))) out.add(n);
  }
  return Array.from(out);
}

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
    amountDueNow: infoPageTextAsksAmountNow(m.text),
    hiddenSecretLike: infoPageHiddenSecretNames(m),
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
  if (s.amountDueNow !== false) out.push("the page asks for an amount due or charged now — automation never pays");
  if (isFilingOrPaymentRequest("POST", s.actionWhere) || isPayRequestUrl(s.actionWhere)) out.push("the form's action reads as a filing or a payment");
  // Helm's review of #349: a hidden value an unkeyed hash would not protect is never bound (and a
  // digest read before this was checked says nothing — refused).
  if (!Array.isArray(s.hiddenSecretLike)) out.push("the page's hidden inputs were not checked for secret-like or number values");
  else if (s.hiddenSecretLike.length) out.push(`the page carries hidden input(s) whose value looks like an account, meter or other number or a secret (${s.hiddenSecretLike.slice(0, 4).join(", ")}) — its hash could be read back, so it is never verified`);
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
  /** The backend says this project already made progress on this portal (critique [1]; round 2:
   *  an earlier admitted pass, a learn that did not end held untouched, a run that reached review,
   *  paused or was interrupted, a tracked number, a draft or a filing). */
  priorProgress: boolean;
  /** The project's own values (street, name, parcel, kW) — refused when on the page. */
  projectValues: string[];
  /** #366: the backend handed this attempt NO reading at all (its fail-closed stand-in: no project
   *  row, a read that threw, a retry after an admission, or no backend). Refuses the pass AND the
   *  card — unlike priorProgress, which is a real reading that refuses only the pass. Absent = false. */
  passUnavailable?: boolean;
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

/** The refusal a run gets when the backend says this project already made progress on this portal
 *  (backend/src/infoPages.ts infoPagePriorProgress). Named so the learner can tell a page HELD AT A
 *  VERIFIED PAGE only because of it — a person may then allow the pass once more for the project. */
export const INFO_PAGE_PRIOR_PROGRESS_REFUSAL = "this project already made progress on this portal (an earlier run passed a verified information page, may have entered data, reached review, paused, was interrupted, or recorded a number, a draft or a filing)";

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
    ["priorProgress", INFO_PAGE_PRIOR_PROGRESS_REFUSAL],
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
  if (run.passUnavailable === true) out.push(INFO_PAGE_PASS_UNAVAILABLE_REFUSAL);
  return out;
}

/** #366: the refusal for an attempt the backend handed no reading (InfoPageRunState.passUnavailable).
 *  Never in the candidate class: an unknown records no card and claims no history. */
export const INFO_PAGE_PASS_UNAVAILABLE_REFUSAL = "the information-page pass was not available on this attempt (the backend gave no reading)";

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

/** The refusal every NON-matching read begins with: the class that opens a candidate watch. */
export const INFO_PAGE_NO_MATCH = "no verified information page matches";
export const isMatchClassRefusal = (r: string): boolean => r.startsWith(INFO_PAGE_NO_MATCH);

/** DOES A REFUSED READ OPEN A CANDIDATE WATCH? (#366) Only when no verified page matched (a
 *  match-class refusal is there) and every other refusal is the project's HISTORY on this portal.
 *  A candidate is evidence for a person, never authority: the pass itself still refuses on that
 *  history until a named person allows it once more, and "allow once more" needs a verified page,
 *  which needs a card. Anything from inside THIS run (a write, a form page, a lock, a stopping
 *  abort, a draft or signature, the page's shape or its request) still records nothing. */
export const opensInfoPageCandidateWatch = (refusals: ReadonlyArray<string>): boolean =>
  refusals.some(isMatchClassRefusal) && refusals.every((r) => isMatchClassRefusal(r) || r === INFO_PAGE_PRIOR_PROGRESS_REFUSAL);

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
  // The identity hash already covers the address; the entry's own origin / path / query keys must
  // say the same (a record moved to another host or tenant path is never this page's).
  const same = entries.filter((e) => e && e.identityVersion === digest.version && e.identitySha256 === digest.identitySha256
    && e.origin === digest.origin && e.path === digest.path && JSON.stringify(e.queryKeys ?? []) === JSON.stringify(digest.queryKeys));
  const samePage = same.filter((e) => e.controlName === digest.control.name && collapse(e.controlLabel) === digest.control.label
    && e.request.method === digest.expected.method && e.request.where === digest.expected.where
    && e.request.actionSha256 === digest.expected.actionUrlSha && e.request.media === digest.expected.media
    && sameBody(e.request.body, digest.expected.body));
  // THE STEPS THAT LED HERE are part of what the person verified (critique [0]): a different tile to
  // the same page is a different page.
  const exact = samePage.filter((e) => Array.isArray(e.prefix) && samePrefix(e.prefix, prefix));
  if (exact.length === 1) return { entry: exact[0], refusals: [] };
  if (exact.length > 1) return { entry: null, refusals: [`${INFO_PAGE_NO_MATCH}: more than one verified entry claims this page`] };
  if (samePage.length) {
    return { entry: null, refusals: [`${INFO_PAGE_NO_MATCH}: the page matches a verified page (${String(samePage[0].verifiedAt).slice(0, 10)}), but the run reached it by different steps`] };
  }
  const near = entries.find((e) => e && e.origin === digest.origin && e.path === digest.path && e.controlName === digest.control.name);
  if (!near) return { entry: null, refusals: [`${INFO_PAGE_NO_MATCH}: no person has verified this page`] };
  const drifted = (Object.keys(COMPONENT_WORDS) as Array<keyof InfoPageComponents>)
    .filter((k) => !near.components || near.components[k] !== digest.components[k]).map((k) => COMPONENT_WORDS[k]);
  const version = near.identityVersion !== digest.version ? ` (identity version ${near.identityVersion} vs ${digest.version})` : "";
  return { entry: null, refusals: [`${INFO_PAGE_NO_MATCH}: the ${drifted.join(", ") || "identity"} differ(s) from a verified page (${String(near.verifiedAt).slice(0, 10)})${version}`] };
}

/**
 * WHICH VERIFIED PAGES THIS READ INVALIDATES (proposal §4, before the click): every entry at the
 * same origin + path (the portal tenant is in the path, or is the host) that this page did NOT
 * match exactly — a changed signature, a different forward control or request, or different steps
 * before it — and that was not already passed on this run. Asked by the backstop only when the page
 * is held exactly as on main and recorded as a fresh candidate (a candidate watch opened); the run
 * reports each as an incident and the backend withdraws it. Names what differs (never a person).
 */
export function infoPageDriftedEntries(
  digest: InfoPageDigest,
  entries: ReadonlyArray<VerifiedInfoPage>,
  prefix: ReadonlyArray<InfoPagePrefixStep>,
  admittedEntryIds: ReadonlyArray<string>,
): Array<{ entryId: string; why: string[]; where: string }> {
  const out: Array<{ entryId: string; why: string[]; where: string }> = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.origin !== digest.origin || e.path !== digest.path) continue;
    if (admittedEntryIds.includes(e.id)) continue;
    const why: string[] = [];
    if (e.identityVersion !== digest.version) why.push(`the identity was read at version ${digest.version}, the page was verified at ${e.identityVersion}`);
    const drifted = (Object.keys(COMPONENT_WORDS) as Array<keyof InfoPageComponents>)
      .filter((k) => !e.components || e.components[k] !== digest.components[k]).map((k) => COMPONENT_WORDS[k]);
    if (drifted.length || e.identitySha256 !== digest.identitySha256) why.push(`the page's ${drifted.join(", ") || "identity"} changed`);
    if (e.controlName !== digest.control.name || collapse(e.controlLabel) !== digest.control.label) why.push("the forward control is a different one");
    if (e.request.method !== digest.expected.method || e.request.where !== digest.expected.where || e.request.actionSha256 !== digest.expected.actionUrlSha
      || e.request.media !== digest.expected.media || !sameBody(e.request.body, digest.expected.body)) why.push("the control would send a different request");
    if (!Array.isArray(e.prefix) || !samePrefix(e.prefix, prefix)) why.push("the run reached the page by different steps");
    if (why.length) out.push({ entryId: e.id, why, where: `${digest.origin}${digest.path}` });
  }
  return out;
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
// After the click (proposal §4): the page the verified click led to must read as NOT FILED
// ---------------------------------------------------------------------------------------------

/** What portalSafety's infoPageAfterClickInPage read on the page the verified click led to. */
export interface InfoPageAfterClickReading {
  /** The page has a body with text. */
  readable: boolean;
  /** VISIBLE, enabled fillable controls anywhere (input / select / textarea / contenteditable) —
   *  diagnostics only: a header search box or a feedback box is one (round 2). */
  fillable: number;
  /** The shared terminal reading (terminalPageInPage().terminal): null = unknown. */
  terminal: boolean | null;
  /** The page's text with the step navigator cut (what the shared readings judge). */
  text: string;
  /** THE POSITIVE EVIDENCE: the most EMPTY plain fields in ONE same-origin POST form, outside every
   *  header / nav / footer / banner / search / dialog landmark AND (round 3) every element whose id,
   *  class or role names a header, nav, footer, menu, toolbar, search or lookup, search / feedback /
   *  sign-in boxes not counted (see portalSafety infoPageAfterClickInPage). */
  formFields: number;
  /** Visible iframe / frame / object / embed: what the reading cannot see into. */
  frames: number;
  /** Every visible button's label. */
  controlLabels: string[];
}

/** The information page's own text, kept at the click (its number-shaped tokens): a token on the
 *  page AFTER the click that was not on the information page is a new record number. */
export interface InfoPageAfterClickBaseline {
  tokens: string[];
  /** Q4: the acknowledgement wording the information page itself carried (infoPageAfterClickAckWording):
   *  the same words on the page after are not new. Absent = nothing excused. */
  ack?: string[];
}

/** How many empty plain fields one form must offer to be the application form (round 2). */
export const INFO_PAGE_AFTER_CLICK_MIN_FIELDS = 2;

/**
 * NUMBER-SHAPED TOKENS in a text, upper-cased, de-duplicated — what a confirmation, request,
 * receipt or reference number looks like WITHOUT a label (round 2: "Request 26-104233-000-00-PR",
 * "Intake request #A-26-0042", "Your reference is SR-2026-104455" all passed
 * classifySubmissionText, whose record-number reading needs a "confirmation / record / application
 * … number" label). Deliberately broad, and only ever compared against the information page's own
 * tokens (a token on both pages — a footer phone number — is not new): a run of letters, digits and
 * hyphens that has a hyphen and 4+ digits, or letters and 3+ digits in 5+ characters, or 6+ digits
 * alone; or anything after a "#" with 3+ digits. A new date or phone number reads as one too: a false
 * stop, the safe direction.
 */
export function infoPageNumberTokens(text: string | null | undefined): string[] {
  const out = new Set<string>();
  const t = String(text ?? "");
  for (const m of t.matchAll(/(#\s*)?([A-Za-z0-9]+(?:[-‐‑–][A-Za-z0-9]+)*)/g)) {
    const hashed = !!m[1];
    const tok = m[2].replace(/[‐‑–]/g, "-").toUpperCase();
    const digits = (tok.match(/\d/g) ?? []).length;
    const letters = /[A-Z]/.test(tok);
    const hyphen = tok.includes("-");
    if ((hashed && digits >= 3) || (hyphen && digits >= 4) || (letters && digits >= 3 && tok.length >= 5) || (!letters && !hyphen && digits >= 6)) out.add(tok);
  }
  for (const tok of infoPageLabeledCodes(t)) out.add(tok);
  return Array.from(out);
}

/**
 * ROUND 3 — A SHORT CODE AFTER A RECORD WORD is a record number too (round 2's verifier: "Your
 * request number 4471 was sent", "Confirmation: KXQ-PLM-ZRT" carried no token the shape rule above
 * knows). After confirmation / reference / request / record / application / permit / case / ticket
 * (also receipt / tracking / submission / intake), with a connector — ":", "#", "No.", "number",
 * "ID", "code", or "is" — a code of 2+ digits, or an UPPER-CASE letters code of 4+ characters
 * (case-sensitive: "Type", "Tech", "only" never count); with no connector, a code of 3+ digits
 * ("request 4471"). Compared, like every token, against the information page's own text: a code on
 * both pages is not new. "project" is deliberately NOT a record word — a form page's "Project
 * Information" heading is the genuine next step. A false token is a false stop, the safe direction.
 */
const RECORD_WORD = /\b(confirmation|reference|ref|request|record|application|permit|case|ticket|receipt|tracking|submission|intake)s?\b/gi;
export function infoPageLabeledCodes(text: string | null | undefined): string[] {
  const t = String(text ?? "").replace(/[‐‑–]/g, "-");
  const out = new Set<string>();
  RECORD_WORD.lastIndex = 0;
  for (let m = RECORD_WORD.exec(t); m; m = RECORD_WORD.exec(t)) {
    const rest = t.slice(m.index + m[0].length, m.index + m[0].length + 60);
    const c = /^(\s*(?:number|num|nbr|no|id|code)\b\.?)?(\s*[:#])?(\s+is\b)?\s*([A-Za-z0-9][A-Za-z0-9-]{1,23})/i.exec(rest);
    if (!c) continue;
    const connector = !!(c[1] || c[2] || c[3]);
    const code = c[4].replace(/-+$/, "");
    const digits = (code.match(/\d/g) ?? []).length;
    const letters = (code.match(/[A-Za-z]/g) ?? []).length;
    const upperCode = !/[a-z]/.test(code) && letters >= 3 && code.length >= 4;
    const ok = connector ? (digits >= 2 || upperCode) : (digits >= 3 && /^[A-Za-z0-9-]+$/.test(code));
    if (ok) out.add(code.toUpperCase());
  }
  return Array.from(out);
}

/**
 * ROUND 3 — WORDING THAT SAYS SOMETHING WAS SENT OR RECEIVED, asked ONLY of the page after a
 * verified click (round 2's verifier: "Your solar permit request was sent to the City",
 * "Confirmation: KXQ-PLM-ZRT", "We've got your permit request" all read unknown).
 *
 * NOT added to portalSafety.classifySubmissionText, deliberately: that shared reading answers "is
 * this POSITIVELY filed?" for the doors that RECORD a filing on "accepted" (replay's outcome after an
 * approved final submit, draftCreated's filed-or-draft reading). Loose wording there would record a
 * filing on "a verification code was sent to your email" — the unsafe direction. This door asks the
 * opposite question — "MIGHT this be filed?" — where a loose match only stops the run and withdraws
 * the pass. Two questions, two predicates; this one is only ever a refusal.
 */
const AFTER_CLICK_SENT_WORDING: RegExp[] = [
  /\b(?:was|were|has\s+been|have\s+been)\s+(?:sent|forwarded|routed|delivered|transmitted)\s+(?:to|for)\b/i,
  /\b(?:has|have)\s+been\s+(?:sent|received|submitted|filed|forwarded|delivered)\b/i,
  /\b(?:was|were)\s+(?:received|submitted|filed)\b/i,
  /\bwe(?:'ve|’ve|\s+have)\s+(?:got|received)\s+your\b/i,
];
const CONFIRMATION_LABEL = /\bconfirmation\s*(?:number|no\.?|#|code|id)?\s*[:#]\s*/gi;
export function infoPageAfterClickSentWording(text: string | null | undefined): string | null {
  const t = String(text ?? "").replace(/\s+/g, " ");
  for (const re of AFTER_CLICK_SENT_WORDING) {
    const m = re.exec(t);
    if (m) return m[0];
  }
  // "Confirmation: <CODE>" — the code case-sensitive (an "Email confirmation:" label followed by the
  // next label's word is not a receipt).
  CONFIRMATION_LABEL.lastIndex = 0;
  for (let m = CONFIRMATION_LABEL.exec(t); m; m = CONFIRMATION_LABEL.exec(t)) {
    const code = /^[A-Z0-9][A-Z0-9-]{2,}(?![A-Za-z0-9])/.exec(t.slice(m.index + m[0].length));
    if (code) return `${m[0]}${code[0]}`;
  }
  return null;
}

/**
 * Q4 — AN ACKNOWLEDGEMENT IS NEVER THE NEXT INTERVIEW STEP (an uncertain page only VETOES). The
 * sent-wording list above names how a portal says it FILED; a portal that filed on the verified
 * click can say so in a thousand other ways ("You're all set", "Thanks! Request complete", "Success.
 * Request accepted. Status: In queue.") and still show a small form ("Start another request", "Tell
 * us more", a contact form) — which then took this job's data and a second request. So this door
 * reads the page for the VOCABULARY of an acknowledgement, by concept, not by phrase: gratitude,
 * completion / success, acceptance / receipt / queue / status, a follow-up promise, "another"
 * request, a confirmation / receipt / tracking record. Any hit refuses (the run stops, the pass is
 * withdrawn). A hit that the information page's OWN text also carried (its prose, the shared chrome)
 * is not new and does not count (baseline.ack, kept at the admission). A false hit is a false stop,
 * the safe direction; a page that only reads "unknown" never votes progress on its own — the form,
 * no number, no filing control and no acknowledgement must ALL hold.
 */
const AFTER_CLICK_ACK_WORDING: RegExp[] = [
  // gratitude
  /\bthank(?:s|\s+you)\b/gi,
  // completion / success
  /\ball\s+(?:set|done|finished)\b/gi,
  /\b(?:you|we)(?:'|’)?(?:re|\s+are)\s+(?:all\s+)?(?:set|done|finished)\b/gi,
  /\bsuccess(?:ful(?:ly)?)?\b/gi,
  /\b(?:request|application|submission|registration|intake|permit)\s+(?:is\s+|was\s+|has\s+been\s+|now\s+)*(?:complete|completed|finished|done|accepted|received|submitted|filed|sent|queued|created|recorded|logged|registered|confirmed)\b/gi,
  /\b(?:complete|completed|done|finished|submitted|received|accepted|sent|filed)\s*!/gi,
  // acceptance / receipt / queue / status
  /\baccepted\b(?!\s+(?:file|format|document|payment|method|type|form)s?\b)/gi,
  /\breceived\b/gi,
  /\bgot\s+(?:it|your)\b/gi,
  /\bon\s+(?:its|it(?:'|’)s)\s+way\b/gi,
  /\b(?:in\s+(?:the\s+|our\s+)?queue|queued)\b/gi,
  /\bstatus\s*(?:is\s*)?[:\-–—]/gi,
  /\b(?:in|under|pending|awaiting)\s+(?:review|approval|intake|processing)\b/gi,
  /\b(?:is|now)\s+(?:pending|being\s+(?:reviewed|processed))\b/gi,
  // a follow-up promise
  /\bwill\s+(?:be\s+in\s+touch|contact\s+you|e-?mail\s+you|call\s+you|text\s+you|reach\s+out|get\s+back\s+to\s+you|follow\s+up|notify\s+you|be\s+notified|hear\s+from)\b/gi,
  /\b(?:you(?:'|’)ll|you\s+will)\s+(?:receive|get|hear)\b/gi,
  /\bwithin\s+(?:\d+|one|two|three|four|five|ten)\s+(?:business\s+|working\s+|calendar\s+)?(?:days?|hours?|weeks?)\b/gi,
  // another request
  /\banother\s+(?:[a-z]+\s+){0,2}(?:request|application|permit|submission|project)\b/gi,
  /\b(?:start|begin|submit|file|create|make)\s+(?:a\s+)?new\s+(?:[a-z]+\s+){0,2}(?:request|application|permit|submission|project)\b/gi,
  // a confirmation / receipt / tracking record
  /\bconfirmed\b/gi,
  /\b(?:your|this\s+is\s+your|here\s+is\s+your)\s+confirmation\b/gi,
  /\bconfirmation\s+(?:number|no\b|#|code|id\b|page|e-?mail\s+(?:was|has|will))/gi,
  /\breceipt\b/gi,
  /\b(?:tracking|reference|ticket|case)\s*(?:number|no\.?|id|#|code)\b/gi,
];
/** Every acknowledgement hit in a text, lower-cased with whitespace collapsed (the comparable form). */
export function infoPageAfterClickAckWording(text: string | null | undefined): string[] {
  // Invisible characters (zero-width, soft hyphen, bidi marks) never split a word apart.
  const t = String(text ?? "").replace(/[\u00AD\u200B-\u200F\u2060\uFEFF]/g, "").replace(/\s+/g, " ");
  const out = new Set<string>();
  for (const re of AFTER_CLICK_ACK_WORDING) {
    re.lastIndex = 0;
    for (let m = re.exec(t); m; m = re.exec(t)) out.add(m[0].toLowerCase().replace(/’/g, "'"));
  }
  return Array.from(out);
}

/** The label is a filing-, submit- or pay-worded control: the SAME triple the information page's own
 *  shape refuses (infoPageShapeRefusals), asked of every visible control on the page after it. */
const isFilingWordedLabel = (l: string): boolean => isFinalSubmitControl(l) || isSubmitIntent(l) || isPayFee(l);

/**
 * EVERY REASON THE PAGE AFTER A VERIFIED INFORMATION PAGE'S CLICK IS NOT AN UNFILED APPLICATION
 * FORM. Empty only on POSITIVE evidence (round 2 — the absence of a known filed phrase was not
 * enough: a receipt beside a search box passed):
 *   - the page reads, and the shared terminal reading says it is NOT the review / terminal page
 *     (portalSafety terminalPageInPage: what 4(b) and replay's click gate read);
 *   - the shared receipt / error reading finds nothing either way (portalSafety
 *     classifySubmissionText: what every submit outcome reads), and (round 3) no wording says
 *     something was sent or received (infoPageAfterClickSentWording — this door only);
 *   - ONE form offers at least INFO_PAGE_AFTER_CLICK_MIN_FIELDS empty plain fields outside the
 *     page's chrome (search / feedback / sign-in boxes never count);
 *   - no frame, and no visible filing-, submit- or pay-worded control;
 *   - no number-shaped token that was not on the information page itself (infoPageNumberTokens) —
 *     and the information page's own tokens must have been kept (no baseline refuses).
 * Anything unread, unknown or ambiguous refuses. Any refusal is an incident: the run stops, the pass
 * is withdrawn and nothing is recorded as filed. Digits in quoted evidence are masked.
 */
export function infoPageAfterClickRefusals(r: InfoPageAfterClickReading | null | undefined, baseline: InfoPageAfterClickBaseline | null | undefined): string[] {
  if (!r || typeof r !== "object") return ["the page after the click could not be read"];
  const out: string[] = [];
  const mask = (x: string | null): string => String(x ?? "").replace(/\d/g, "#").slice(0, 80);
  if (r.readable !== true) out.push("the page after the click could not be read (no text)");
  if (r.terminal === true) out.push("the page after the click reads as the review / terminal page");
  else if (r.terminal !== false) out.push("the page after the click could not be judged review or not");
  const outcome = classifySubmissionText(r.text);
  if (outcome.verdict === "accepted") out.push(`the page after the click reads as filed ("${mask(outcome.evidence)}")`);
  else if (outcome.verdict === "rejected") out.push(`the page after the click reads as an error ("${mask(outcome.evidence)}")`);
  else if (outcome.evidence) out.push(`the page after the click reads both as filed and as an error (${mask(outcome.evidence)})`);
  const sent = infoPageAfterClickSentWording(r.text);
  if (sent) out.push(`the page after the click says something was sent or received ("${mask(sent)}")`);
  // Q4: any acknowledgement vocabulary the information page did not itself carry refuses.
  const ownAck = new Set(baseline && Array.isArray(baseline.ack) ? baseline.ack.map((x) => String(x).toLowerCase()) : []);
  const ack = infoPageAfterClickAckWording(r.text).filter((x) => !ownAck.has(x));
  if (ack.length) out.push(`the page after the click reads as an acknowledgement, not the next step ("${mask(ack[0])}")`);
  if (!(typeof r.formFields === "number" && Number.isFinite(r.formFields) && r.formFields >= INFO_PAGE_AFTER_CLICK_MIN_FIELDS)) {
    out.push(`the page after the click shows no application form (fewer than ${INFO_PAGE_AFTER_CLICK_MIN_FIELDS} empty plain fields in one form outside the page's header, navigation, footer and search; search, feedback and sign-in boxes do not count)`);
  }
  if (!(typeof r.frames === "number" && Number.isFinite(r.frames))) out.push("the page after the click was not read for frames");
  else if (r.frames > 0) out.push(`the page after the click composes ${r.frames} frame(s) the reading cannot see into`);
  if (!Array.isArray(r.controlLabels)) out.push("the page after the click was not read for its controls");
  else {
    const filing = r.controlLabels.find((l) => isFilingWordedLabel(collapse(l)));
    if (filing) out.push(`the page after the click offers "${mask(collapse(filing)).slice(0, 40)}", a submit-, filing- or pay-worded control`);
  }
  if (!baseline || !Array.isArray(baseline.tokens)) out.push("the information page's own text was not kept, so a new record number cannot be told apart");
  else {
    const before = new Set(baseline.tokens.map((x) => String(x).toUpperCase()));
    const fresh = infoPageNumberTokens(r.text).filter((x) => !before.has(x));
    if (fresh.length) out.push(`the page after the click shows a number that was not on the information page ("${mask(fresh[0])}") — a confirmation, request or receipt number`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// PROOF OF PROGRESS (round 3): the page after the click must take THIS JOB'S OWN DATA
// ---------------------------------------------------------------------------------------------

/** A step the run recorded on the page a verified click led to, as the proof reads it. `value` is
 *  what was entered (kept in the learner's memory only, never on the step). Round 4: `held` is what
 *  the control HOLDS when it is read back after the fill, its blur and the page's settle (portalSafety
 *  infoPageProofControlInPage, read again just before the run leaves the page); `chrome` whether
 *  that control sits in the page's header / nav / footer / menu / toolbar / search / lookup (the
 *  after-click reading's own container rule, infoPageFieldChromeInPage). Unread = undefined =
 *  refused. */
export interface InfoPageProofStep {
  action: string;
  field?: string;
  note?: string;
  value?: string;
  sensitive?: boolean;
  gapFill?: boolean;
  /** Every rendering of what the control holds (a select: its chosen option's text and value). */
  held?: string | ReadonlyArray<string>;
  chrome?: boolean;
}

/** THE ONE NORMALIZER of a proof value (round 4): case, whitespace and punctuation dropped
 *  ("(503) 555-0199" = "5035550199"; "101 Solar Way" = "101 SOLAR WAY."), accents folded. Used for
 *  the job's own values (infoPageJobValues) and the value a control holds (infoPageProofStepRefusals)
 *  alike — one question, one predicate.
 *  ROUND 5 — DIGIT GROUPS NEVER MERGE ACROSS A DECIMAL POINT OR A COMMA (infoPageProofNumber): a
 *  digits-only mask that turns the job's 6.5 into 65 holds another number, never the job's value.
 *  A number compares AS A NUMBER: "6.5" = "6.50", "6.0" = "6", "6.5" ≠ "65", "3.2" ≠ "32",
 *  "1.0" ≠ "10". US thousands grouping (a comma followed by exactly three digits, repeated, before
 *  any decimal point) is one number: "1,200" = "1200", "12,500.75" = "12500.75". Any other comma
 *  between digits is KEPT ("1,20" ≠ "120", "3,2" ≠ "32", "3,2" ≠ "3.2": a European decimal is never
 *  guessed — at worst a false stop). Spaces, hyphens, slashes and parentheses between digits still
 *  merge (a phone's formatting, a mask's grouping). */
export function infoPageProofNorm(v: unknown): string {
  return String(v ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/(\d+(?:[.,]\d+)+)|[^a-z0-9]/g, (_m, num?: string) => (num ? infoPageProofNumber(num) : ""));
}

/** ROUND 5: one run of digits joined by decimal points / commas, as the proof compares it (see
 *  infoPageProofNorm): US thousands grouping collapses; a plain decimal loses its fraction's trailing
 *  zeros and its integer part's leading zeros (6.50 → 6.5, 06.5 → 6.5, 6.0 → 6); anything else keeps
 *  its separators, so its digit groups never merge. */
function infoPageProofNumber(t: string): string {
  const n = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(t) ? t.replace(/,/g, "") : t;
  const m = /^(\d+)\.(\d+)$/.exec(n);
  if (!m) return n;
  const int = m[1].replace(/^0+(?=\d)/, "");
  const frac = m[2].replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

/** The incident's reason when no such step was recorded before the run left the page or ended. */
export const INFO_PAGE_NO_PROGRESS = "the run entered none of this job's own data on the page the verified click led to";

// A recorded answer that is the run's own policy, a deterministic pass or a signature — never the
// job's data, whatever it binds to.
const NOT_JOB_DATA_NOTE = /^(policy default|[a-z][a-z ]{0,30} default|e-signature|signature|gap[- ]?fill|application entry|permit type|choice tile|record type|accela|address version|other-specify|section email|contact\(|attachment|compute totals)\b/i;
// An answer any page could take: empty, zero, a yes / no / on / off token.
const TRIVIAL_VALUE = /^(?:|0+(?:\.0+)?|yes|no|y|n|true|false|on|off|none|n\/?a|null|undefined|-+|checked|unchecked)$/i;

/** This job's own values: key → the value the backend resolved for THIS project (infoPageJobValues). */
export type InfoPageJobValues = Readonly<Record<string, string>>;

/**
 * EVERY REASON ONE RECORDED STEP IS NOT PROOF OF PROGRESS. Empty only for a fill / select / check
 * BOUND to one of this job's own values (`jobValues`: key → this project's own value — backend
 * autoLearn's infoPageJobValues: not a policy default, not the company's constant, never a secret),
 * not a policy / deterministic / signature step, not a gap fill, whose entered value is not empty or
 * trivial — and (round 4) whose control, READ BACK after the fill, its blur and the page's settle,
 * HOLDS exactly the job's own value for that key (infoPageProofNorm: case, whitespace and
 * punctuation aside) and does not sit in the page's chrome (a header / nav / footer / menu / toolbar /
 * search / lookup: the after-click reading's own container rule). A literal (no binding) is never
 * proof: any page takes a literal. A planner that binds a job key but types other text, a control
 * that clears or rewrites what was typed, and an unread control are never proof.
 */
export function infoPageProofStepRefusals(step: InfoPageProofStep | null | undefined, jobValues: InfoPageJobValues | null | undefined): string[] {
  if (!step || typeof step !== "object") return ["no step"];
  const out: string[] = [];
  const action = String(step.action ?? "");
  if (!/^(fill|select|check)$/.test(action)) out.push(`a "${action}" step is not a fill, select or check`);
  const field = String(step.field ?? "").trim();
  const known = !!jobValues && typeof jobValues === "object" && !Array.isArray(jobValues);
  const own = known && field && Object.prototype.hasOwnProperty.call(jobValues, field) ? infoPageProofNorm(jobValues![field]) : "";
  if (!field) out.push("the value is a literal, not bound to a project value");
  else if (!known) out.push("this job's own values were not given");
  else if (!own) out.push(`"${field.slice(0, 40)}" is not one of this job's own values (a policy default, a company constant or an unknown key)`);
  if (step.sensitive === true) out.push("a secret is never the proof");
  if (step.gapFill === true) out.push("a gap fill is a guess, never the proof");
  const note = collapse(step.note);
  if (NOT_JOB_DATA_NOTE.test(note)) out.push(`a "${note.slice(0, 30)}" step is the run's own policy, never the job's data`);
  const value = collapse(step.value);
  if (TRIVIAL_VALUE.test(value) || (value.match(/[A-Za-z0-9]/g) ?? []).length < 2) out.push("the value entered is empty or trivial");
  // ROUND 4 — THE VALUE THE CONTROL HOLDS, not the binding the planner claimed.
  const held = typeof step.held === "string" ? [step.held] : Array.isArray(step.held) ? (step.held as ReadonlyArray<unknown>).map((h) => String(h ?? "")) : null;
  if (!held) out.push("what the control holds after the fill was not read");
  else if (own && !held.some((h) => infoPageProofNorm(h) === own)) out.push(`the control does not hold this job's own value for "${field.slice(0, 40)}" (it holds ${held.some((h) => h.trim()) ? "other text" : "nothing"}: the planner typed something else, or the page cleared or rewrote it)`);
  if (step.chrome !== false) out.push(step.chrome === true
    ? "the control sits in the page's header, navigation, footer, menu, toolbar, search or lookup — never form evidence, never the proof"
    : "whether the control sits in the page's chrome was not read");
  return out;
}

/** THE PROOF: one step recorded on the page the verified click led to passes infoPageProofStepRefusals.
 *  Empty = proved; anything unread refuses. */
export function infoPageProofOfProgressRefusals(steps: ReadonlyArray<InfoPageProofStep> | null | undefined, jobValues: InfoPageJobValues | null | undefined): string[] {
  if (!jobValues || typeof jobValues !== "object" || Array.isArray(jobValues)) return [`${INFO_PAGE_NO_PROGRESS} (this job's own values were not given)`];
  if (!Array.isArray(steps)) return [`${INFO_PAGE_NO_PROGRESS} (the run's steps were not given)`];
  if (steps.some((s) => infoPageProofStepRefusals(s, jobValues).length === 0)) return [];
  return [`${INFO_PAGE_NO_PROGRESS} (no fill, select or check bound to a project value that the page kept)`];
}

// A key that NAMES the company, the tenant or an internal id is never this job's data, whatever it
// resolves to (round 4: clientId — read from the parser snapshot, so a blank project resolves it to
// "" — was counted as one of this job's own values).
const COMPANY_KEY = /^(?:id|uuid)$|^(?:client|company|org|organi[sz]ation|tenant|installer|contractor|business|licen[cs]e|insurance|bond|ccb)(?=$|[A-Z_:\-\d])/;
const UUID_SHAPED = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/**
 * THIS JOB'S OWN VALUES (round 4: key → value): the keys whose value for this project is non-empty,
 * not trivial, and NOT anything the company or the defaults supply. A key is OUT when:
 *   - it is a secret (`isSecret`), or its name names the company / tenant / an internal id
 *     (clientId, installer*, contractor*, licence…);
 *   - its value equals what a blank project of the same company, portal and track resolves for the
 *     same key (the backend resolves both through portalRecipes.resolveRecipeFieldValues) — a policy
 *     default ("0" stories, behind-the-meter), a company constant;
 *   - its value (infoPageProofNorm) equals ANY value the blank project resolves under ANY key — a
 *     company constant or default copied into the parser snapshot under another name ("503", the
 *     installer's area code, as the homeowner's; the AHJ's name as the city);
 *   - its value equals any of `companyValues` (the client record's own fields, its id, the org's id);
 *   - its value is UUID-shaped (an internal id is never what an application asks for), empty or
 *     trivial (fewer than 2 letters / digits, 0, yes / no…).
 * Unknown (no values or no blank resolution) = none: every admitted pass then ends as an incident.
 */
export function infoPageJobValues(
  values: Record<string, unknown> | null | undefined,
  blankValues: Record<string, unknown> | null | undefined,
  isSecret: (k: string) => boolean = () => false,
  companyValues: ReadonlyArray<unknown> = [],
): Record<string, string> {
  if (!values || typeof values !== "object" || !blankValues || typeof blankValues !== "object") return {};
  const str = (v: unknown): string => collapse(v === null || v === undefined || typeof v === "object" ? "" : String(v));
  const supplied = new Set<string>();
  for (const v of Object.values(blankValues)) { const n = infoPageProofNorm(str(v)); if (n) supplied.add(n); }
  for (const v of Array.isArray(companyValues) ? companyValues : []) { const n = infoPageProofNorm(str(v)); if (n) supplied.add(n); }
  const out: Record<string, string> = {};
  for (const k of Object.keys(values).sort()) {
    const val = str(values[k]);
    if (!val || isSecret(k) || COMPANY_KEY.test(k)) continue;
    if (val === str(blankValues[k])) continue;
    const n = infoPageProofNorm(val);
    if (n.length < 2 || TRIVIAL_VALUE.test(val) || UUID_SHAPED.test(val.trim()) || supplied.has(n)) continue;
    out[k] = val;
  }
  return out;
}

/** The keys of infoPageJobValues (sorted). */
export function infoPageJobValueKeys(values: Record<string, unknown> | null | undefined, blankValues: Record<string, unknown> | null | undefined, isSecret: (k: string) => boolean = () => false, companyValues: ReadonlyArray<unknown> = []): string[] {
  return Object.keys(infoPageJobValues(values, blankValues, isSecret, companyValues)).sort();
}

// ---------------------------------------------------------------------------------------------
// ROUND 4 — THE EXPIRY OF A VERIFICATION (owner-adjustable defaults, in this ONE place)
// ---------------------------------------------------------------------------------------------
// A verified page whose Next starts filing server-side while still leading to a fresh application
// form is indistinguishable from the normal flow to every reader the bot has (the after-click
// readings, the proof of progress): nothing detects it. So a verification is AUTHORITY ONLY FOR A
// WHILE: for INFO_PAGE_PASS_MAX_AGE_DAYS after a person verified it, and for at most
// INFO_PAGE_PASS_MAX_PROJECTS distinct projects (counted from the use ledger). After either, the pass
// is no longer live: the next run is held at the page exactly as on main, and the card says
// "verification expired — a person re-verifies" (the existing verify action on the fresh candidate).
/** Days a person's verification stays authority (owner-adjustable default). */
export const INFO_PAGE_PASS_MAX_AGE_DAYS = 30;
/** Distinct projects one verification may admit (owner-adjustable default). */
export const INFO_PAGE_PASS_MAX_PROJECTS = 10;
/** The phrase the card and the run message carry. */
export const INFO_PAGE_PASS_EXPIRED = "verification expired — a person re-verifies";
/** ROUND 5 — CLOCK SKEW: a verification time further in the future than this is unreadable (expired). */
export const INFO_PAGE_PASS_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * WHY THIS VERIFICATION IS NO LONGER AUTHORITY (empty = within both limits). `projectsUsed` is the
 * number of distinct projects the use ledger shows it admitted; `nowMs` the clock. An unreadable
 * verification time or count is expired: an unknown never reassures — and (round 5) so is a
 * verification time more than INFO_PAGE_PASS_CLOCK_SKEW_MS in the FUTURE (a skewed clock or a forged
 * time would otherwise never age). The wording names the limit reached, never the count (the count
 * spans tenants).
 */
export function infoPagePassExpiryRefusals(verifiedAt: string | null | undefined, projectsUsed: number | null | undefined, nowMs: number = Date.now()): string[] {
  const out: string[] = [];
  const at = Date.parse(String(verifiedAt ?? ""));
  if (!Number.isFinite(at)) out.push(`${INFO_PAGE_PASS_EXPIRED} (when it was verified could not be read)`);
  else if (at - nowMs > INFO_PAGE_PASS_CLOCK_SKEW_MS) out.push(`${INFO_PAGE_PASS_EXPIRED} (it reads as verified in the future: the clock cannot be trusted)`);
  else if (nowMs - at > INFO_PAGE_PASS_MAX_AGE_DAYS * 86_400_000) out.push(`${INFO_PAGE_PASS_EXPIRED} (a verification is authority for ${INFO_PAGE_PASS_MAX_AGE_DAYS} days; this one is older)`);
  const n = Number(projectsUsed);
  if (projectsUsed === null || projectsUsed === undefined || !Number.isFinite(n) || n < 0) out.push(`${INFO_PAGE_PASS_EXPIRED} (how many projects used it could not be read)`);
  else if (n >= INFO_PAGE_PASS_MAX_PROJECTS) out.push(`${INFO_PAGE_PASS_EXPIRED} (a verification admits at most ${INFO_PAGE_PASS_MAX_PROJECTS} projects; this one reached that limit)`);
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
