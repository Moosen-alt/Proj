import {
  EXTRACT_SEL,
  extractFieldsInPage,
  toExtractedField,
  equipmentMakeCandidates,
  isPayFee,
  isSensitiveLabel,
  type ExtractedField,
  type RawField,
  type LearnPlanner,
  type LearnPlanRequest,
} from "./adapters/autoLearnAdapter";
import { buildLocator } from "./adapters/loginFlow";
import { selectWithFallback } from "./comboboxFill";
import { redactStatusText } from "./safeAction";

// ---------------------------------------------------------------------------
// LLM-assisted gap-fill (hybrid staging).
//
// The hand-coded adapters fill the fields they were taught by fixed selectors, but a
// portal evolves and adds fields, so they silently skip whatever their selectors don't
// match (Estimated Commissioning Date, Smart Inverter Settings, Single Phase Voltage, …).
// After the hand-coded fills on each page, this runs the SAME LLM planner the auto-learn
// engine uses to fill ANY required field still empty — making staging universal without
// throwing away the adapter's known-good critical-field bindings.
//
// PROPER DATA, NOT GUESSING (hard guardrail): a planned fill is applied ONLY when it is
// grounded in real data —
//   • a select/radio/checkbox value that matches one of the field's OWN portal options
//     (the portal offered it; it can't be fabricated), or
//   • a fill the planner bound to a real project-field key that resolves to a value, or
//   • free text that traces back to an actual project-record value.
// Anything else is dropped and reported, so a field with no backing data is left BLANK for
// the human rather than filled with an invented value. Secrets (account/meter/SSN/password)
// are never touched here — those are bound deterministically by the adapter.
// ---------------------------------------------------------------------------

export interface GapFillOutcome {
  /** Field labels the LLM filled this page (non-PII labels only). */
  filled: string[];
  /** Every field label a fill was ATTEMPTED on, landed or not (#362): a fill that threw half-way
   *  may still have written to the page, so "what automation wrote here" is read from this. */
  attempted: string[];
  /** The control behind each attempted write, as the page named it when it was written (#362):
   *  its label, id and name, and whether the answer came from the project's data or was an AI pick
   *  (gapFillWriteKind). A pick's element also carries data-al-unrec (UNRECORDED_WRITE_ATTR), so a
   *  replay can tell whether that control is still in front of a stamped draft click. */
  attemptedControls: Array<{ label: string; id: string; name: string; kind: GapFillWriteKind }>;
  /** Planned fills rejected because they weren't grounded in real project data. */
  skippedUngrounded: string[];
  /** Required, empty fields the PROJECT GENUINELY LACKS — surfaced so the human can act. */
  reportedMissing: string[];
  /** Required fields left empty even though the project HOLDS a value for them. That is an
   *  engine defect (the planner never proposed it, or the fill did not stick), not the
   *  operator's data problem — kept separate so nobody is sent to re-type data already on
   *  file, which is what the single undifferentiated list was causing. */
  unfilledDespiteData: string[];
}

function emptyOutcome(): GapFillOutcome {
  return { filled: [], attempted: [], attemptedControls: [], skippedUngrounded: [], reportedMissing: [], unfilledDespiteData: [] };
}

function normalize(v: string): string {
  return (v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// DOES THIS ANSWER ACTUALLY COME FROM THAT PROJECT VALUE?
//
// The planner naming a project field was being treated as proof the planner's ANSWER was
// that field's value. It is not: an outside review demonstrated `999` accepted against a
// systemSizeKw of `8`, because the only test was that systemSizeKw held something non-empty.
//
// So the binding has to be checked, not trusted — while still allowing the REFORMATTINGS the
// old fall-through existed for: a date written the portal's way, an account number with its
// dashes stripped (Ameren wants 16-0001 as 160001), a size the portal wants in watts when the
// project records kilowatts. Anything that is not a recognisable rendering of the project's
// own value is a guess, and a guess on a live application is the failure this whole helper
// was written to prevent.
function tracesTo(value: string, projectValue: string): boolean {
  const nv = normalize(value);
  const npv = normalize(projectValue);
  if (!nv || !npv) return false;
  // Same text, or one is a fuller rendering of the other ("roof" -> "Roof Mounted",
  // "No" -> "No, I do not have storage").
  if (nv === npv || nv.includes(npv) || npv.includes(nv)) return true;
  // Same digits, different punctuation: 16-0001 -> 160001, (555) 123-4567 -> 5551234567.
  const dv = value.replace(/\D/g, "");
  const dpv = projectValue.replace(/\D/g, "");
  if (dv.length >= 4 && dv === dpv) return true;
  // Same quantity, different unit scale: 8 kW recorded, 8000 W wanted (or the reverse).
  const numV = Number(String(value).replace(/[^0-9.]/g, ""));
  const numP = Number(String(projectValue).replace(/[^0-9.]/g, ""));
  if (Number.isFinite(numV) && Number.isFinite(numP) && numV > 0 && numP > 0) {
    for (const factor of [1, 1000, 0.001, 100, 0.01]) {
      if (Math.abs(numV - numP * factor) < Math.max(numP * factor, numV) * 0.005) return true;
    }
  }
  // Same day, written differently: 2026-09-10 -> 09/10/2026.
  const dateV = new Date(value);
  const dateP = new Date(projectValue);
  if (!Number.isNaN(dateV.getTime()) && !Number.isNaN(dateP.getTime())
    && dateV.toISOString().slice(0, 10) === dateP.toISOString().slice(0, 10)) return true;
  return false;
}

// Is `value` grounded in real data for this field — i.e. NOT a guess? Exported for tests.
export function isGrounded(
  field: ExtractedField,
  value: string,
  mappedKey: string | undefined,
  projectFields: Record<string, string>,
): boolean {
  const v = (value ?? "").trim();
  if (!v) return false;

  // Checkbox/radio: the planner is choosing WHICH portal-provided control to toggle, so a
  // boolean-ish value is grounded by the control's own existence on the page — UNLESS it
  // named a project field, in which case the project's answer decides. "Yes" against a
  // hasBattery of "No" declares storage the customer does not own.
  if (field.fieldType === "checkbox" || field.fieldType === "radio") {
    if (!/^(true|false|yes|no|on|off|1|0)$/i.test(v)) return false;
    const bound = mappedKey ? projectFields[mappedKey] : "";
    // TICKING A RADIO CHOOSES ITS OPTION (#362): "Yes" on the No radio with gridTied=Yes ticked No,
    // and "Yes" on the No radio with gridTied=No was refused. The ticked option's own label is the
    // answer, so that is what the project's value is compared with.
    if (bound && field.fieldType === "radio" && /^(true|yes|on|1)$/i.test(v)) {
      return tracesTo(field.label, bound) || boolAgrees(field.label, bound);
    }
    if (bound) return tracesTo(v, bound) || boolAgrees(v, bound);
    return true;
  }

  // Select: the value must be one of the field's OWN options (the portal's fixed list) — and
  // option membership proves the answer is ALLOWED by the form, never that it is TRUE for
  // this project. When the planner named a project field, that field decides.
  if (field.fieldType === "select") {
    const opts = (field.options ?? []).map(normalize).filter(Boolean);
    const bound = mappedKey ? projectFields[mappedKey] : "";
    if (opts.length > 0) {
      const nv = normalize(v);
      const offered = opts.some((o) => o === nv || o.includes(nv) || nv.includes(o));
      if (!offered) return false;
      return bound ? (tracesTo(v, bound) || boolAgrees(v, bound)) : true;
    }
    // Custom combobox with no captured options → require a real project-field binding, and
    // require the answer to actually be that field's value.
    return Boolean(bound) && tracesTo(v, bound);
  }

  // Free text/other: a planner binding is a CLAIM about where the answer came from — check it.
  if (mappedKey && projectFields[mappedKey]) return tracesTo(v, projectFields[mappedKey]);
  const nv = normalize(v);
  if (nv.length < 2) return false;
  for (const pv of Object.values(projectFields)) {
    const npv = normalize(pv);
    if (npv.length >= 2 && (npv.includes(nv) || nv.includes(npv))) return true;
  }
  return false;
}

// DOES THE PROJECT ALREADY HOLD A VALUE FOR THIS PORTAL FIELD? Exported for tests.
//
// WHICH WAY THIS FAILS MATTERS MORE THAN HOW OFTEN. Answering "yes" when the project does
// NOT have the data suppresses the add-data prompt, and the operator never learns a required
// field is empty — worse than the false alarm the two-list split was written to fix. A bare
// substring test fails exactly that way: the portal label "Account Holder Name" contains the
// project key "account", so a genuinely missing name would be waved through as the engine's
// problem and silently dropped.
//
// So matching is by whole TOKEN and EVERY word of the key must appear in the label:
// accountNumber matches "Account Number", not "Account Holder Name". When in doubt this
// returns false, which routes the field to reportedMissing — the prompt a person can act on.
export function projectHasValueForLabel(label: string, projectFields: Record<string, string>): boolean {
  const tokens = (value: string): string[] =>
    value.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  const labelTokens = new Set(tokens(label));
  if (!labelTokens.size) return false;
  return Object.entries(projectFields).some(([key, value]) => {
    if (value == null || String(value).trim() === "") return false;
    // camelCase keys carry their own word boundaries: accountNumber -> account, number.
    const keyTokens = tokens(key.replace(/([a-z0-9])([A-Z])/g, "$1 $2"));
    if (!keyTokens.length) return false;
    return keyTokens.every((t) => labelTokens.has(t));
  });
}

/** "Yes"/"true"/"1" and "No"/"false"/"0" agreeing across spellings. */
function boolAgrees(a: string, b: string): boolean {
  const truth = (s: string): boolean | null => {
    const t = s.trim().toLowerCase();
    if (/^(true|yes|on|1|y)$/.test(t)) return true;
    if (/^(false|no|off|0|n|none)$/.test(t)) return false;
    return null;
  };
  const ta = truth(a); const tb = truth(b);
  return ta !== null && tb !== null && ta === tb;
}

// NEVER AN ANSWER THAT READS AS SUBMITTING (#362). "Are you ready to submit your Net Metering
// application?" is a control whose Yes turns the page's Submit into a filing: the gap-fill prompt
// says a required Yes/No MUST be answered, and a planner obeying it filed with no approval. So a
// control is never offered to the planner, and never written, when its label, its group's question
// (a radio's own label is only "Yes"), any of its questions (ExtractedField.questions), or any of a
// select's options reads as submit intent — "Yes" lands on "Yes, submit my application now" by
// containment — and an answer that itself reads as submitting is never typed. Left blank, it is a
// required field a person answers.
//
// FIELD TEXT IS NOT A BUTTON. portalSafety's isSubmitIntent judges a CLICK: a bare "Finish" or
// "Submit" button commits. On a field it over-reads — "Estimated Finish Date", a "Mill Finish"
// option, "Submit Date" are ordinary data — so a field's text counts only in a READINESS shape:
// ready / want / agree to submit, submit (your|the|this) application or request, submit now,
// finalize, re-submit, confirm or complete the submission, sign and file. Exported for tests.
const SUBMIT_FIELD_TEXT =
  /\b(ready|want|wish|like|agree|intend|elect|choose)\s+to\s+(re-?)?(submit|file|send)\b|\b(re-?)?(submit|file|send|finali[sz]e)\s+(now\b|(my|the|your|this|our|an?)?\s*(net\s+metering\s+|interconnection\s+|final\s+)?(\([^)]*\)\s*)?(application|request|submission|form|filing)\b)|\bfinali[sz]e\b|\bre-?submit\b|\b(confirm|complete)\s+(the\s+|my\s+|your\s+)?submission\b|\bsign\s*(and|&)\s*(file|submit)\b|^\s*(yes\s*[,–—-]?\s*)?(submit|file)\s*(now)?\s*[.!]?\s*$/i;
export function isSubmitIntentField(text: string | null | undefined): boolean {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return !!t && SUBMIT_FIELD_TEXT.test(t);
}
export function gapFillMayAnswer(
  field: { label?: string | null; groupPrompt?: string | null; options?: string[] | null; questions?: string[] | null } | string | null | undefined,
  value?: string | null,
): boolean {
  const f = typeof field === "string" || field == null ? { label: field ?? "" } : field;
  if (isSubmitIntentField(f.label) || isSubmitIntentField(f.groupPrompt)) return false;
  if ((f.questions ?? []).some((q) => isSubmitIntentField(q))) return false;
  if ((f.options ?? []).some((o) => isSubmitIntentField(o))) return false;
  if (value != null && isSubmitIntentField(value)) return false;
  return true;
}

/** The attribute an AI pick leaves on the element it wrote (its value: the label). */
export const UNRECORDED_WRITE_ATTR = "data-al-unrec";

export type GapFillWriteKind = "data" | "pick";
const BOOLISH = /^(true|false|yes|no|on|off|1|0|y|n|none)$/i;
const words = (v: string): string[] => String(v ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** Does `hay` hold every word of `needle`, in order and contiguous? ("Roof Mounted" holds "Roof".) */
function holdsWholeWords(hay: string, needle: string): boolean {
  const h = words(hay); const n = words(needle);
  if (!n.length || n.length > h.length) return false;
  for (let i = 0; i + n.length <= h.length; i++) if (n.every((w, k) => h[i + k] === w)) return true;
  return false;
}
function sameDay(a: string, b: string): boolean {
  if (!/\d/.test(a) || !/\d/.test(b)) return false;
  const da = new Date(a); const db = new Date(b);
  return !Number.isNaN(da.getTime()) && !Number.isNaN(db.getTime()) && da.toISOString().slice(0, 10) === db.toISOString().slice(0, 10);
}
/** THE PROJECT'S VALUE, RENDERED — never close to it. Equal after normalisation, the same day
 *  written another way, the same digits in another punctuation (a phone, an account format: no
 *  letters on either side), or the project's whole value as whole words inside a fuller answer. */
function isRenderingOf(answer: string, projectValue: string): boolean {
  const a = String(answer ?? "").trim(); const p = String(projectValue ?? "").trim();
  if (!a || !p) return false;
  if (normalize(a) === normalize(p)) return true;
  if (sameDay(a, p)) return true;
  if (!/[a-z]/i.test(a) && !/[a-z]/i.test(p)) {
    const da = a.replace(/\D/g, ""); const dp = p.replace(/\D/g, "");
    if (da.length >= 4 && da === dp) return true;
  }
  return normalize(p).length >= 4 && !BOOLISH.test(p) && holdsWholeWords(a, p);
}

// DATA OR PICK (#362, owner ruling 2026-10-18 "Data is enough"). Data only when the answer that
// LANDS is the project's value (Helm review of 4081f12, Blocking 2):
//   - a select: the option it lands on is the bound value rendered (isRenderingOf; a yes/no value
//     only by equality — "Yes" is not "Yes, grid-tied with battery backup"), a make alias of it,
//     or the `${key}Certified` value. Several options holding the value is a pick.
//   - a radio: the ticked option's own label is the bound value (boolAgrees or equality).
//   - a checkbox: the toggle agrees with the bound value (boolAgrees).
//   - text: the bound value rendered; with no binding, a rendering of a project value at least four
//     characters long that is not a bare yes/no.
// Never digit closeness (405 vs 410), a letter substring (IQ8M vs IQ8PLUS, a model prefix), or a
// word inside a long project value (the design-notes digest). Anything else is a pick: an answer
// the portal ALLOWS, which says nothing about whether it is TRUE for this project. Only a pick stops
// the stamped draft click. `landed` is the option text the select now shows (read back after the
// write), when known. Exported for tests.
export function gapFillWriteKind(
  field: { fieldType?: string; label?: string; options?: string[] },
  value: string,
  mappedKey: string | undefined,
  projectFields: Record<string, string>,
  landed?: string | null,
): GapFillWriteKind {
  const bound = mappedKey ? String(projectFields[mappedKey] ?? "").trim() : "";
  const v = String(value ?? "").trim();
  if (field.fieldType === "checkbox") return bound && boolAgrees(v, bound) ? "data" : "pick";
  if (field.fieldType === "radio") {
    if (!/^(true|yes|on|1)$/i.test(v)) return "pick";
    const own = String(field.label ?? "").trim();
    return bound && (boolAgrees(own, bound) || normalize(own) === normalize(bound)) ? "data" : "pick";
  }
  if (field.fieldType === "select") {
    if (!bound) return "pick";
    const at = String(landed ?? v).trim();
    const certified = mappedKey ? String(projectFields[`${mappedKey}Certified`] ?? "").trim() : "";
    const candidates = [bound, ...(certified ? [certified] : []), ...equipmentMakeCandidates(bound)];
    const lands = (o: string): boolean => BOOLISH.test(bound)
      ? normalize(o) === normalize(bound) || boolAgrees(o, bound)
      : candidates.some((c) => isRenderingOf(o, c));
    if (!lands(at)) return "pick";
    // An exact option is unambiguous; a fuller rendering is data only when it is the only one.
    if (candidates.some((c) => normalize(at) === normalize(c))) return "data";
    const holding = (field.options ?? []).filter((o) => lands(o));
    return holding.length <= 1 ? "data" : "pick";
  }
  if (bound) return isRenderingOf(v, bound) ? "data" : "pick";
  const values = Object.values(projectFields).map((x) => String(x ?? "").trim())
    .filter((x) => normalize(x).length >= 4 && !BOOLISH.test(x));
  return values.some((x) => isRenderingOf(v, x)) ? "data" : "pick";
}

/** The #id the extractor saw for this field, when it saw one. */
function extractedIdOf(field: ExtractedField): string {
  const fromCss = (css: string | undefined): string => {
    const m = /^#([A-Za-z_][\w:.-]*)$/.exec(String(css ?? "").trim());
    return m ? m[1] : "";
  };
  return fromCss(field.selector?.css) || (field.selector?.fallbacks ?? []).map((fb) => fromCss(fb.css)).find(Boolean) || "";
}
const cssStr = (v: string): string => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
/** Is this field's label only its id / name (nothing a person reads)? */
function labelIsOnlyIdent(field: ExtractedField): boolean {
  const l = String(field.label ?? "").trim();
  return !l || l === field.fingerprint?.id || l === field.fingerprint?.name || l === field.group;
}

/** THE CONTROL THE EXTRACTOR SAW, AND ONLY IT (#362, Helm review of 4081f12, Blocking 3). A label
 *  locator is a substring match ("Yes" lands on the first Yes of the page, "Net Metering" on "Are
 *  you ready to submit your Net Metering…"), and an id can repeat (Miami's radio pairs share one).
 *  So: `[id=…]` only when exactly one element carries it; an id-less radio / checkbox by its group
 *  name and its own exact label, the one member that reads so; otherwise main's locator, which
 *  claimForWrite then checks is the control the extractor saw. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function locateExtracted(page: any, field: ExtractedField): Promise<any | null> {
  const frame = field.selector?.frame;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scope: any = frame ? (typeof page.frameLocator === "function" ? page.frameLocator(`iframe[name="${cssStr(frame)}"]`) : null) : page;
  if (scope && typeof scope.locator === "function") {
    const id = extractedIdOf(field);
    if (id) {
      const byId = scope.locator(`[id="${cssStr(id)}"]`);
      const n = typeof byId?.count === "function" ? await byId.count().catch(() => 0) : 0;
      if (n === 1) return byId.first();
    }
    const nm = field.group || field.fingerprint?.name || "";
    if ((field.fieldType === "radio" || field.fieldType === "checkbox") && nm) {
      const grp = scope.locator(`input[type="${field.fieldType}"][name="${cssStr(nm)}"]`);
      if (typeof grp?.evaluateAll === "function") {
        const raws = await grp.evaluateAll(extractFieldsInPage).catch(() => null) as RawField[] | null;
        const n = await grp.count().catch(() => -1);
        if (Array.isArray(raws) && raws.length === n) {
          const want = normalize(field.label);
          const hits = raws.map((r, i) => (normalize(r.label) === want ? i : -1)).filter((i) => i >= 0);
          return hits.length === 1 ? grp.nth(hits[0]) : null;
        }
      }
    }
  }
  return buildLocator(page, field.selector);
}

/** MAY THIS ELEMENT BE WRITTEN, RIGHT NOW? (#362) The guard runs on the element actually about to
 *  be written, immediately before the write, with the extractor's own reading of it (the same
 *  extractFieldsInPage, run on that one element): its id must be the extracted one when there was
 *  one, its label the extracted label (unless that label was only an id / name — main's
 *  behaviour), and none of its label, questions or options may read as submit intent. null =
 *  refused, or unreadable. A locator that cannot be evaluated (a test double) passes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function claimForWrite(loc: any, field: ExtractedField): Promise<{ id: string; name: string } | null> {
  if (typeof loc?.evaluateAll !== "function") return { id: extractedIdOf(field), name: field.group || field.fingerprint?.name || "" };
  const raws = await loc.evaluateAll(extractFieldsInPage).catch(() => null) as RawField[] | null;
  if (!Array.isArray(raws) || raws.length !== 1) return null;
  const raw = raws[0];
  const want = extractedIdOf(field);
  if (want && raw.id !== want) return null;
  if (raw.fieldType !== field.fieldType) return null;
  if (!labelIsOnlyIdent(field) && normalize(raw.label) !== normalize(field.label)) return null;
  if (!gapFillMayAnswer({ label: raw.label, groupPrompt: raw.groupPrompt, options: raw.options, questions: raw.questions })) return null;
  return { id: raw.id || "", name: raw.name || "" };
}

/** What the control now shows after the write: a select's chosen option text. "" when unread. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function landedText(loc: any, field: ExtractedField, value: string): Promise<string | null> {
  if (field.fieldType !== "select") return value;
  if (typeof loc?.evaluate !== "function") return value;
  const t = await loc.evaluate((el: Element) => {
    const s = el as HTMLSelectElement;
    if (s.tagName === "SELECT") return (s.options[s.selectedIndex]?.textContent || "").trim();
    return ((el as HTMLInputElement).value || el.textContent || "").trim();
  }, undefined, { timeout: 1500 }).catch(() => null);
  return typeof t === "string" ? t : null;
}

// Best-effort: neutralize the transparent loading scrims / onboarding popovers that
// intercept clicks so the gap-fill's fills actually land. Portal-agnostic — covers
// PowerClerk's Vue scrim + "new feature" popover and Accela's ExtJS .x-mask. Never throws.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function neutralizeOverlays(page: any): Promise<void> {
  if (!page || typeof page.evaluate !== "function") return;
  try {
    await page.evaluate(() => {
      const sel = [
        "div.position-absolute.opacity-50.bg-black",
        ".modal-backdrop",
        ".popover.new-feature-popper",
        ".new-feature-popper",
        "[class*='loading-overlay']",
        "[class*='spinner-overlay']",
        ".x-mask",
        ".x-mask-loading",
        "#divGlobalCover",
        "[id*='loadingMask']",
        "[id*='LoadingMask']",
        ".blockUI",
        ".ui-widget-overlay",
      ].join(", ");
      document.querySelectorAll(sel).forEach((el) => el.remove());
      if (!document.getElementById("__gapfill_scrim_bypass")) {
        const style = document.createElement("style");
        style.id = "__gapfill_scrim_bypass";
        style.textContent = sel + " { pointer-events: none !important; }";
        document.head.appendChild(style);
      }
    });
  } catch { /* mock page or no DOM — non-fatal */ }
}

/** How long ONE candidate's value read may take. A control that is on the page answers at once. */
const GAP_READ_TIMEOUT_MS = 1500;

/** Is this candidate an EMPTY control the gap-fill could fill? null = the recorded selector finds
 *  nothing on the page (or the read fails) — not a candidate at all: nothing can be typed into a
 *  control that is not there.
 *
 *  A WAIT FOR A CONTROL THAT NEVER APPEARS IS NOT A READ (runs-finish item 5). This called
 *  inputValue() / isChecked() with Playwright's DEFAULT timeout (30 s — production sets none), so
 *  every candidate whose selector resolves to nothing — a radio / checkbox the extractor names by
 *  its neighbouring text, which getByLabel can never find — waited the whole 30 s. Live run
 *  191e45c8: "save new contact" spent 60,063 ms in gap-fill (two such controls) and filled nothing.
 *  Now: count() first (immediate), then a bounded read. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function isFieldEmpty(loc: any, fieldType: ExtractedField["fieldType"]): Promise<boolean | null> {
  try {
    if (typeof loc.count === "function" && (await loc.count().catch(() => 0)) === 0) return null;
    if (fieldType === "checkbox" || fieldType === "radio") {
      const checked = await loc.isChecked({ timeout: GAP_READ_TIMEOUT_MS }).catch(() => null);
      return checked === null ? null : !checked;
    }
    const v = await loc.inputValue({ timeout: GAP_READ_TIMEOUT_MS }).catch(() => null);
    return v === null ? null : !String(v ?? "").trim();
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function applyGrounded(page: any, loc: any, field: ExtractedField, value: string): Promise<boolean> {
  try {
    if (field.fieldType === "select") {
      await selectWithFallback(page, loc, value);
    } else if (field.fieldType === "checkbox" || field.fieldType === "radio") {
      const on = /^(true|yes|on|1)$/i.test(value);
      if (on) await loc.check({ timeout: 6000 });
      else if (typeof loc.uncheck === "function") await loc.uncheck({ timeout: 6000 }).catch(() => {});
    } else {
      await loc.fill(value, { timeout: 6000 });
      // Blur to COMMIT the value into the portal's JS model (PowerClerk's Vue autosaves on blur).
      if (typeof loc.blur === "function") await loc.blur().catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

// Fill the gaps on the CURRENT page: extract every fillable control, ask the planner what to
// put in the still-empty ones, and apply ONLY the grounded fills. Never clicks Next/submit
// and never touches sensitive/file/pay controls — purely a same-page fill pass. Best-effort:
// any failure returns what was filled so far and never throws (staging must not crash here).
export async function gapFillCurrentPage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  planner: LearnPlanner,
  projectFields: Record<string, string>,
  alreadyFilled: string[] = [],
): Promise<GapFillOutcome> {
  const out = emptyOutcome();
  if (!page || typeof page.$$eval !== "function") return out;
  try {
    await neutralizeOverlays(page);
    const raws: RawField[] = await page.$$eval(EXTRACT_SEL, extractFieldsInPage).catch(() => [] as RawField[]);
    const candidates = raws
      .map(toExtractedField)
      .filter((f) =>
        f.fieldType !== "button" &&
        f.fieldType !== "file" &&
        !isSensitiveLabel(f.label) &&
        !isPayFee(f.label));
    if (candidates.length === 0) return out;
    // NOTHING REQUIRED ON THE PAGE, NOTHING TO DO. The LLM call below is spent only on a REQUIRED
    // empty control, so a page with no required control at all is answered here — before a single
    // value is read.
    if (!candidates.some((f) => f.required)) return out;

    // Keep only the still-empty controls (don't overwrite the adapter's deterministic fills).
    const empties: Array<{ field: ExtractedField; loc: unknown }> = [];
    for (const field of candidates) {
      // THE CONTROL THE EXTRACTOR SAW (#362): see locateExtracted.
      const loc = await locateExtracted(page, field);
      if (!loc) continue;
      if ((await isFieldEmpty(loc, field.fieldType)) === true) empties.push({ field, loc });
    }
    if (empties.length === 0) return out;
    // Only spend an LLM call when a REQUIRED field is still empty. Portal pages always
    // carry empty optionals (address line 2, alt-billing email, ...), so gating on "any
    // empty field" invoked the full planner on EVERY page of a recipe replay - making
    // replay nearly as slow (and as expensive) as the original learn. When a required
    // gap does exist, the optionals ride along in the same request.
    if (!empties.some((e) => e.field.required)) return out;
    // A submit-intent control is never offered (gapFillMayAnswer); it stays in `empties`, so a
    // required one left blank is still reported below for a person to answer.
    const offered = empties.filter((e) => gapFillMayAnswer(e.field));

    const url = typeof page.url === "function" ? String(page.url() ?? "") : "";
    const pageTitle = typeof page.title === "function" ? String((await page.title().catch(() => "")) ?? "") : "";
    const rawBody = await page.locator("body").innerText().catch(() => "");
    const bodyText = (redactStatusText(String(rawBody)) ?? "").slice(0, 2000);

    const req: LearnPlanRequest = {
      url,
      pageTitle,
      fields: offered.map((e) => e.field),
      bodyText,
      alreadyFilledLabels: alreadyFilled,
      isDashboard: false,
    };

    let plan;
    try {
      plan = offered.some((e) => e.field.required) ? await planner(req) : { fills: [] };
    } catch {
      return out; // planner/LLM unavailable — leave the page as the adapter left it.
    }

    for (const fill of plan.fills ?? []) {
      const slot = offered[fill.selectorIndex];
      if (!slot) continue;
      const { field, loc } = slot;
      if (isPayFee(field.label) || isSensitiveLabel(field.label)) continue;
      if (!gapFillMayAnswer(field, fill.value)) continue;
      if (!isGrounded(field, fill.value, fill.field, projectFields)) {
        out.skippedUngrounded.push(field.label || field.fieldType);
        continue;
      }
      // A radio / checkbox is named by its QUESTION too: "Yes" alone tells a person nothing.
      const own = field.label || field.fieldType;
      const choice = field.fieldType === "radio" || field.fieldType === "checkbox";
      const question = field.groupPrompt || (field.questions ?? []).find((q) => q && q !== own) || "";
      const shown = choice && question ? `${question.slice(0, 80)}: ${own}` : own;
      // The guard, on the element about to be written, immediately before the write.
      const claimed = await claimForWrite(loc, field);
      if (!claimed) continue;
      out.attempted.push(shown);
      const entry: GapFillOutcome["attemptedControls"][number] = { label: shown, id: claimed.id, name: claimed.name, kind: "pick" };
      out.attemptedControls.push(entry);   // a pick until what landed says otherwise
      let applied = false;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        applied = await applyGrounded(page, loc as any, field, fill.value);
      } finally {
        // WHAT LANDED decides data or pick (gapFillWriteKind); unread = pick. A pick's element is
        // stamped so a replay can find it again.
        const landed = await landedText(loc, field, fill.value);
        entry.kind = landed == null ? "pick" : gapFillWriteKind(field, fill.value, fill.field, projectFields, landed);
        if (entry.kind === "pick" && typeof (loc as { evaluate?: unknown })?.evaluate === "function") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (loc as any).evaluate((el: Element, a: { attr: string; label: string }) => { el.setAttribute(a.attr, a.label); }, { attr: UNRECORDED_WRITE_ATTR, label: shown }, { timeout: 1500 }).catch(() => null);
        }
      }
      if (applied) out.filled.push(field.label || field.fieldType);
    }

    // A REQUIRED FIELD LEFT EMPTY IS NOT PROOF THE PROJECT LACKS THE DATA.
    //
    // This swept every still-empty required field into reportedMissing with no test for
    // whether the project actually holds a value, and autopilot then told the operator
    // those fields "had no project data — add them to the project and re-stage". So an
    // operator was sent to type in data the project already carried, for a field the
    // planner simply did not propose or whose fill did not stick. Measured 2026-09-22 at
    // ~80 false interruptions per 100 projects — the third-largest avoidable cost in the
    // product, and the only one that sends someone to do work that is already done.
    //
    // Three outcomes now, and they are different facts:
    //   · genuinely absent from the project  → reportedMissing (the operator CAN fix it)
    //   · the project HAS a value            → unfilledDespiteData (the ENGINE's problem;
    //                                          never ask a person to re-enter it)
    //   · a value was proposed but refused as ungrounded → skippedUngrounded, as before.
    // WHICH WAY THIS HEURISTIC FAILS MATTERS MORE THAN HOW OFTEN.
    //
    // Saying "the project has this" when it does not SUPPRESSES the add-data prompt, and the
    // operator never learns a required field is empty — worse than the false alarm this
    // whole change set out to fix. A bare substring test fails exactly that way: the portal
    // label "Account Holder Name" contains the project key "account", so a genuinely missing
    // name would be waved through as the engine's problem.
    //
    // So the match is by whole TOKEN, not substring, and a one- or two-token key must be a
    // token of the label rather than merely appear inside one of its words. When in doubt
    // this returns false, which routes the field to reportedMissing — the prompt an operator
    // can act on.
    const projectHasValueFor = (field: { label?: string; fieldType?: string }): boolean =>
      projectHasValueForLabel(`${field.label || ""} ${field.fieldType || ""}`, projectFields);
    for (const { field } of empties) {
      if (!field.required) continue;
      // A submit-intent group left blank is reported under its QUESTION, not its option word "Yes".
      const lbl = (!gapFillMayAnswer(field) && field.groupPrompt) || field.label || field.fieldType;
      if (out.filled.includes(lbl)) continue;
      if (projectHasValueFor(field)) {
        if (!out.unfilledDespiteData.includes(lbl)) out.unfilledDespiteData.push(lbl);
        continue;
      }
      if (!out.reportedMissing.includes(lbl)) out.reportedMissing.push(lbl);
    }
    return out;
  } catch {
    return out;
  }
}
