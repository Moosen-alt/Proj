// ---------------------------------------------------------------------------
// A SUBMIT THAT MAKES A DRAFT IS NOT THE FILING (#302).
//
// Some utilities split one interconnection application into two forms. PSE's PowerClerk
// tenant (live, 2026-10-10): "Interconnection Application Part 1 (Preliminary Validation)"
// asks for an application date and type, and its Submit only CREATES the record:
//
//     Your draft application NEM-44131 has been created. Please continue to
//     Interconnection Application - Part 2 to complete your interconnection application
//     and submit to PSE.
//
// The record then lists status "Application Draft / Unsubmitted", with Part 2 under Current
// Forms as a New Form [Begin]. The filing is Part 2's own submit, five steps later. The learner
// had recorded Part 1's Submit as THE final submit, so the run stopped in front of a step that
// files nothing, and Part 2 was never staged (operator ruling 2026-09-26: a stop on a legitimate
// intermediate step is a bug; the review stop belongs before the step that actually files).
//
// Nothing about the Part 1 page itself says its Submit only makes a draft; the page AFTER the
// click does. So this module reads that page, and the record page the run comes back to, and
// nothing else. It is an engine reading, not a PSE patch: any portal that answers a submit with
// "your draft ... has been created ... continue to <form> to complete ... and submit" has filed
// nothing yet.
//
// Every reader here can only make FEWER things count as a filing. None of them clicks, and the
// final-submit gate (shared/src/portalSafety.ts mayClickFinalSubmit) never reads them.
// ---------------------------------------------------------------------------
import { classifySubmissionText } from "../../shared/src/portalSafety";
import { CORRECTION_ACTIONABLE, CORRECTION_REFUSE, type ProjectFormRow } from "./adapters/correctionForm";
import type { LedgerEntry } from "./adapters/submissionLedger";

export interface DraftCreatedRead {
  /** The page says a draft (or an unsubmitted record) exists and the filing is still ahead. */
  draft: boolean;
  /** The number the portal gave the draft ("NEM-44131"), or "" when the page names none. */
  applicationNumber: string;
  /** The form the page says to continue to ("Interconnection Application - Part 2"), or "". */
  nextForm: string;
  /** The words that decided it, for the run log. Portal wording only, capped. */
  evidence: string;
  /** "created": the page said a draft was just created (the tell that heals a recipe step).
   *  "status": only a record status reads Application Draft / Unsubmitted — enough to say this
   *  is not a filing, never enough to rewrite what a recipe step does. "" when not a draft. */
  strength: "created" | "status" | "";
}

const NOT_A_DRAFT: DraftCreatedRead = { draft: false, applicationNumber: "", nextForm: "", evidence: "", strength: "" };

// A record number on a draft page: letters, an optional hyphen, digits ("NEM-44131", "APP-111681").
const DRAFT_NUMBER = String.raw`([A-Z]{1,8}-?\d{3,10})`;

// "Your draft application NEM-44131 has been created." The number is optional; so is "your".
const DRAFT_CREATED = new RegExp(
  String.raw`\b(?:your\s+)?draft\s+(?:interconnection\s+)?(?:application|project|request|record|submission)\b(?:\s+(?:no\.?|number|#)?\s*[:#]?\s*${DRAFT_NUMBER})?\s+(?:has\s+been|was|is\s+now)\s+(?:created|saved|started|generated)\b`,
  "i",
);

// "Your application NEM-44131 has been created" — no "draft", so it only counts beside a
// "continue to <form> to complete ... submit" sentence that says the filing is still ahead.
const RECORD_CREATED = new RegExp(
  String.raw`\b(?:application|project|request|record)\s+(?:(?:no\.?|number|#)\s*[:#]?\s*)?${DRAFT_NUMBER}?\s*(?:has\s+been|was)\s+created\b`,
  "i",
);

// "Please continue to Interconnection Application - Part 2 to complete your interconnection
// application and submit to PSE." The form name is what the run opens next.
const CONTINUE_TO_FORM =
  /\bcontinue\s+(?:on\s+)?(?:to|with)\s+(?:the\s+)?["“']?(.{3,90}?)["”']?\s+to\s+(?:complete|finish)\b[^.]{0,160}?\bsubmit/i;

// PowerClerk's record status: "Application Draft", "Unsubmitted Draft Application started", or a
// bare "Status: Unsubmitted". A bare "unsubmitted" anywhere else ("you have unsubmitted
// changes") is not a status and does not count.
const DRAFT_STATUS = /\bapplication\s+draft\b|\bunsubmitted\s+draft\b|\bstatus\s*[:\-–—]?\s*(?:unsubmitted|draft)\b/i;

// A page that STILL ASKS for the submit (the review page a slow portal has not left four seconds
// after the click, a form page whose header shows the record's status) is not the page the click
// produced. A status word on it says nothing about what the click did; only the "created" wording
// decides there. Only the review page's own asks count ("review your application", "before
// submitting"): a record page's help text ("has not yet been submitted", "to submit your
// application, complete the forms", "click Submit to file") describes a draft and must not veto it.
// (classifySubmissionText's own still-asks test includes the word "draft", so it cannot be reused here.)
const PAGE_STILL_ASKS = /\bbefore\s+(?:you\s+)?(?:submit|submitting|filing)\b|\breview\s+(?:all\s+)?(?:your|the)\s+(?:application|information|submission|details|entries)\b/i;

const squash = (s: string): string => String(s || "").replace(/\s+/g, " ").trim();
const cleanFormName = (s: string): string => squash(s).replace(/^["“'\s]+|["”'.,;:\s]+$/g, "").slice(0, 90);

/**
 * Does the page in front of us (the one a submit click just produced) say a DRAFT was created and
 * the filing is still ahead? A page that also says the application was submitted/filed is not a
 * draft: both at once is a page this reader cannot settle, so it leaves it to the existing
 * confirmation readers, unchanged.
 */
export function readDraftCreated(bodyText: string | null | undefined): DraftCreatedRead {
  const text = squash(String(bodyText ?? ""));
  if (!text) return NOT_A_DRAFT;
  const created = text.match(DRAFT_CREATED);
  const recordCreated = text.match(RECORD_CREATED);
  const cont = text.match(CONTINUE_TO_FORM);
  const status = text.match(DRAFT_STATUS);
  const createdTell = created ?? (recordCreated && cont ? recordCreated : null);
  const tell = createdTell ?? status;
  if (!tell) return NOT_A_DRAFT;
  if (!createdTell && PAGE_STILL_ASKS.test(text)) return NOT_A_DRAFT;
  // A sentence that says the application WAS submitted wins over every draft tell (positive
  // filing evidence, the same phrases classifySubmissionText accepts on). Record-number-only
  // "evidence" does not count here: a draft page carries the draft's own number.
  const filed = classifySubmissionText(text);
  if (filed.verdict === "accepted" && /submitted|received|filed|accepted|thank\s+you|complete|successful|confirmed/i.test(String(filed.evidence ?? ""))) {
    return NOT_A_DRAFT;
  }
  const applicationNumber = String((created?.[1] ?? recordCreated?.[1] ?? "")).toUpperCase();
  const nextForm = cont ? cleanFormName(cont[1]) : "";
  const evidence = squash([tell[0], cont ? cont[0] : ""].filter(Boolean).join(" … ")).slice(0, 240);
  return { draft: true, applicationNumber, nextForm, evidence, strength: created || (recordCreated && cont) ? "created" : "status" };
}

/** Does a record's own text (a list row, a record page) read as an UNSUBMITTED DRAFT? */
export function readsAsUnsubmittedDraft(text: string | null | undefined): boolean {
  return DRAFT_STATUS.test(squash(String(text ?? "")));
}

// ---------------------------------------------------------------------------
// OPENING THE DRAFT'S NEXT FORM — by name, never by position (the correctionForm lesson: the
// row beside the one we want can be a Cancellation Form with a byte-identical Begin button).
// ---------------------------------------------------------------------------

export interface DraftFormChoice { row: ProjectFormRow; why: string }
export interface DraftFormRefusal { refused: true; why: string; offered: string[] }

export function isDraftFormRefusal(r: DraftFormChoice | DraftFormRefusal): r is DraftFormRefusal {
  return (r as DraftFormRefusal).refused === true;
}

const formKey = (s: string): string => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Which row of the draft's form list continues it. With the form the draft page named, that
 * form and only that form (equal name, or one name containing the other). Without one, the
 * single openable form the record offers. Anything cancellation-shaped is out before scoring,
 * a "View" row is a receipt, and two candidates is a refusal, never a guess.
 */
export function chooseDraftForm(rows: ProjectFormRow[], nextForm: string): DraftFormChoice | DraftFormRefusal {
  const all = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.name === "string" && r.name.trim());
  const offered = all.map((r) => `${r.name}${r.action ? ` [${r.action}]` : ""}`);
  const openable = all
    .filter((r) => CORRECTION_ACTIONABLE.test(r.action || ""))
    .filter((r) => !/previously\s+submitted/i.test(r.section || ""));
  const safe = openable.filter((r) => !CORRECTION_REFUSE.test(r.name));
  if (!safe.length) {
    return { refused: true, why: openable.length ? "the only openable form(s) would cancel or withdraw the application" : "no form on this record can be opened", offered };
  }
  const want = formKey(nextForm);
  let hits: ProjectFormRow[];
  if (want) {
    const exact = safe.filter((r) => formKey(r.name) === want);
    hits = exact.length ? exact : safe.filter((r) => formKey(r.name).includes(want) || want.includes(formKey(r.name)));
    if (!hits.length) return { refused: true, why: `the form the draft page named ("${nextForm}") is not offered on this record`, offered };
  } else {
    hits = safe;
  }
  if (hits.length > 1) {
    return { refused: true, why: `${hits.length} forms could continue this draft (${hits.map((h) => h.name).join(" | ")}) — refusing rather than guessing between them`, offered };
  }
  return { row: hits[0], why: want ? `"${hits[0].name}" is the form the draft page said to continue to` : `"${hits[0].name}" is the only form this draft offers` };
}

// ---------------------------------------------------------------------------
// FINDING THE PROJECT'S EXISTING DRAFT in the account's application list (owner ruling,
// 2026-10-10: a re-stage opens the EXISTING draft and never mints a second application number).
// By the number the run recorded when it has one; otherwise by an unsubmitted-draft row that
// carries this project's street address. Exactly one, or nothing is opened.
// ---------------------------------------------------------------------------

export type SiteDraftFind =
  | { found: true; entry: LedgerEntry; why: string }
  | { found: false; ambiguous: boolean; why: string };

const DIRECTIONAL = /^(?:n|s|e|w|ne|nw|se|sw|north|south|east|west|northeast|northwest|southeast|southwest)$/;
const SUFFIXES: Record<string, string> = {
  st: "st", street: "st", ave: "ave", av: "ave", avenue: "ave", rd: "rd", road: "rd", dr: "dr", drive: "dr", ln: "ln", lane: "ln",
  ct: "ct", court: "ct", cir: "cir", circle: "cir", blvd: "blvd", boulevard: "blvd", way: "way", pl: "pl", place: "pl", ter: "ter",
  terrace: "ter", trl: "trl", trail: "trl", pkwy: "pkwy", parkway: "pkwy", hwy: "hwy", highway: "hwy", loop: "loop", sq: "sq",
  square: "sq", aly: "aly", alley: "aly", cv: "cv", cove: "cv", pt: "pt", point: "pt", run: "run", row: "row", walk: "walk", path: "path",
};
const UNIT_WORD = /^(?:unit|apt|apartment|ste|suite|bldg|building|lot|space|spc|trlr|rm|room|fl|floor|no|num|number)$/;
const STATE = /^(?:al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|dc)$/;
const ZIP = /^\d{5}$/;
const zip5 = (s: string): string => { const m = String(s || "").match(/\b(\d{5})(?:-\d{4})?\b/); return m ? m[1] : ""; };

/** The parts of a site a list row can be held against. "1234 N Example St Unit B, Lynden, WA 98264"
 *  → house "1234", words ["example"], suffix "st", unit "b", city "lynden", zip "98264". Ordinals
 *  are street words ("1st" ≠ "3rd"); directionals are not (the row may abbreviate them); the suffix
 *  is kept apart, canonical, and compared only when both sides carry one. The street line is the
 *  first comma segment of the address, so a suffix-less street ("1234 Broadway, Lynden, WA 98264")
 *  never absorbs its city, state and ZIP into the words; without a comma, the words stop at a
 *  state code, a ZIP, a unit word or the given city. A unit is read after a unit word or a "#";
 *  a single letter right after the suffix ("1234 Main St B") counts only on the project's own
 *  address (`strict` off): on a list row a bare letter or number after the street is an initial,
 *  a date, a size or a fee column, not a unit. `after` is what the row says past the street line. */
export interface SiteKey { house: string; words: string[]; suffix: string; unit: string; city: string; zip: string; after: string[] }
export function siteKey(site: { street?: string; city?: string; zip?: string }, strict = false): SiteKey | null {
  const raw = String(site.street ?? "");
  const city = formKey(String(site.city ?? "")).split(" ")[0] || "";
  const line = raw.includes(",") ? raw.slice(0, raw.indexOf(",")) : raw;
  const toks = formKey(line.replace(/#/g, " unit ")).split(" ").filter(Boolean);
  const houseAt = toks.findIndex((w) => /^\d+[a-z]?$/.test(w));
  if (houseAt < 0) return null;
  const words: string[] = []; let suffix = ""; let unit = ""; let i = houseAt + 1;
  for (; i < toks.length; i++) {
    const w = toks[i];
    if (UNIT_WORD.test(w)) { unit = toks[i + 1] ?? ""; i += 2; break; }
    if (ZIP.test(w) || STATE.test(w) || (city && w === city)) break;
    if (SUFFIXES[w] && words.length) {
      suffix = SUFFIXES[w]; i += 1;
      const n = toks[i] ?? "";
      if (UNIT_WORD.test(n)) { unit = toks[i + 1] ?? ""; i += 2; }
      else if (!strict && /^[a-z]$/.test(n) && !DIRECTIONAL.test(n)) { unit = n; i += 1; }
      break;
    }
    if (DIRECTIONAL.test(w)) continue;
    words.push(w);
  }
  const after = toks.slice(i).concat(formKey(raw.slice(line.length)).split(" ").filter(Boolean));
  // A unit named after the city or ZIP ("… Lynden 98264 Unit B", "…, Apt 4"): still this site's unit.
  if (!unit) { const k = after.findIndex((w) => UNIT_WORD.test(w)); if (k >= 0) unit = after[k + 1] ?? ""; }
  const zip = zip5(String(site.zip ?? "")) || zip5(after.join(" ")) || "";
  const cityOut = city || (after.find((w) => /^[a-z]{3,}$/.test(w) && !STATE.test(w)) ?? "");
  return words.length ? { house: toks[houseAt], words, suffix, unit, city: cityOut, zip, after } : null;
}

/** Words a list row carries after an address that are never a city: statuses, actions, programs. */
const ROW_NOISE = /^(?:application|applications|draft|unsubmitted|submitted|complete|completed|started|select|edit|view|open|continue|begin|delete|resume|withdraw|interconnection|net|metering|nem|solar|pv|residential|commercial|program|status|modified|created|updated|last|date|customer|account|acct|meter|id|no|num|number|total|kw|kwh|the|and|for|of)$/;
const NOT_A_ZIP_AFTER = /^(?:account|acct|customer|meter|id|no|num|number|unit|apt|suite|ste|lot|space|spc|bldg|rm|fl)$/;

export type RowFit = "confirmed" | "unconfirmed" | "ambiguous" | "other";
/** How a list row fits the project's site. "other": a different house (a street word missing, a
 *  suffix or ZIP that disagrees, both sides naming different units). "confirmed": the same street
 *  line and the row names the project's city or ZIP. "unconfirmed": the same street line and the
 *  row names no city or ZIP. "ambiguous": the same street line but only one side names a unit, or
 *  the row names a city word that is not the project's — it may or may not be this site, so it is
 *  never claimed and always shown to a person.
 *  Only the address part of the row (from the house number on) is read: the record number's own
 *  digits ("NEM-90017") and the columns before it are not a ZIP or a unit. */
export function rowFit(row: string, key: SiteKey): { fit: RowFit; why: string } {
  const r = formKey(String(row || "").replace(/#/g, " unit "));
  const has = (t: string, s = r) => new RegExp(`(^| )${t}( |$)`).test(s);
  if (!has(key.house) || !key.words.every((w) => has(w))) return { fit: "other", why: "another street" };
  const addressPart = r.slice(r.search(new RegExp(`(^| )${key.house}( |$)`))).trim();
  const rowKey = siteKey({ street: addressPart, city: key.city }, true);
  if (!rowKey || !key.words.every((w) => rowKey.words.includes(w))) return { fit: "other", why: "another street" };
  if (key.suffix && rowKey.suffix && key.suffix !== rowKey.suffix) return { fit: "other", why: `the row's street is a ${rowKey.suffix}, not a ${key.suffix}` };
  const toks = addressPart.split(" ");
  const zips = toks.filter((w, k) => k > 0 && ZIP.test(w) && w !== rowKey.unit && !NOT_A_ZIP_AFTER.test(toks[k - 1]));
  if (key.zip && zips.length && !zips.includes(key.zip)) return { fit: "other", why: `the row's ZIP ${zips[0]} is not ${key.zip}` };
  if (key.unit && rowKey.unit && key.unit !== rowKey.unit) return { fit: "other", why: `the row is unit ${rowKey.unit}, not ${key.unit}` };
  if (Boolean(key.unit) !== Boolean(rowKey.unit)) return { fit: "ambiguous", why: key.unit ? `the project is unit ${key.unit} and the row names no unit` : `the row names unit ${rowKey.unit} and the project names none` };
  if (key.zip && zips.includes(key.zip)) return { fit: "confirmed", why: `the row carries ZIP ${key.zip}` };
  if (key.city && has(key.city, addressPart)) return { fit: "confirmed", why: `the row names ${key.city}` };
  const cityLike = rowKey.after.find((w) => /^[a-z]{3,}$/.test(w) && !STATE.test(w) && !DIRECTIONAL.test(w) && !ROW_NOISE.test(w) && !SUFFIXES[w] && !UNIT_WORD.test(w));
  if (key.city && cityLike) return { fit: "ambiguous", why: `the row says "${cityLike}" after the street, not ${key.city}` };
  return { fit: "unconfirmed", why: "the row names no city or ZIP" };
}

export interface SiteToMatch {
  applicationNumber?: string;
  street?: string;
  city?: string;
  zip?: string;
  /** Another project of this client has the same house number and street words (the backend
   *  knows): a row that names no city or ZIP can then be either house, and is never claimed. */
  siblingAtSameStreet?: boolean;
}

/** A listed record's own status words, when it carries any that are not a draft's ("Not Submitted"
 *  is a draft's). */
const FILED_STATUS = /(?<!\bnot\s)(?<!\bnot\s\s)\b(?:submitted|under\s+review|in\s+review|approved|accepted|received|completed?|withdrawn|cancell?ed|closed|rejected|denied|issued|active)\b/i;

export function findSiteDraft(entries: LedgerEntry[], site: SiteToMatch): SiteDraftFind {
  const list = Array.isArray(entries) ? entries : [];
  const number = String(site.applicationNumber ?? "").trim().toUpperCase();
  if (number) {
    const hits = list.filter((e) => String(e.id || "").trim().toUpperCase() === number);
    if (hits.length === 1) {
      const row = String(hits[0].row || "");
      // A recorded draft whose row now carries a filed status was completed by hand: nothing to continue.
      if (!readsAsUnsubmittedDraft(row) && FILED_STATUS.test(row)) {
        return { found: false, ambiguous: false, why: `the recorded draft ${number} no longer reads as an unsubmitted draft (its row says "${squash(row).slice(0, 120)}")` };
      }
      return { found: true, entry: hits[0], why: `the recorded draft ${number} is listed` };
    }
    return { found: false, ambiguous: hits.length > 1, why: hits.length > 1 ? `${hits.length} rows carry ${number}` : `the recorded draft ${number} is not on this list` };
  }
  const key = siteKey(site);
  if (!key) return { found: false, ambiguous: false, why: "the project has no street address to match a draft by" };
  const where = (e: LedgerEntry) => `${e.id} ("${squash(e.row || "").slice(0, 100)}")`;
  // Every row on this street line (house number and street words), whatever its status or city: a
  // second record there, filed or not, is the portal's own proof that the line holds more than one
  // application, and a draft whose row names no city or ZIP could then be either one.
  const fitted = list.map((e) => ({ e, ...rowFit(e.row || "", key) }));
  const onLine = fitted.filter((x) => x.why !== "another street");
  const drafts = onLine.filter((x) => x.fit !== "other" && readsAsUnsubmittedDraft(x.e.row));
  if (!drafts.length) return { found: false, ambiguous: false, why: "no unsubmitted draft is listed for this street address" };
  if (drafts.length > 1) return { found: false, ambiguous: true, why: `${drafts.length} unsubmitted drafts are listed for this street address (${drafts.map((x) => where(x.e)).join(", ")}) — a person opens the right one` };
  const one = drafts[0];
  if (one.fit === "ambiguous") return { found: false, ambiguous: true, why: `${where(one.e)} is an unsubmitted draft at this house number and street, but ${one.why} — a person opens the right one` };
  if (one.fit === "confirmed") return { found: true, entry: one.e, why: `${one.e.id} is the one unsubmitted draft listed for this site (${squash(one.e.row || "").slice(0, 100)}; ${one.why})` };
  const others = onLine.filter((x) => x !== one);
  if (site.siblingAtSameStreet || others.length) {
    const proof = others.length ? `the list also carries ${others.map((x) => x.e.id).join(", ")} on that line` : "this client has more than one project on that street line";
    return { found: false, ambiguous: true, why: `${where(one.e)} is an unsubmitted draft whose row names no city or ZIP, and ${proof} — a person opens the right one` };
  }
  return { found: true, entry: one.e, why: `${one.e.id} is the one unsubmitted draft listed for this street address (${squash(one.e.row || "").slice(0, 100)}; the row names no city or ZIP)` };
}

// ---------------------------------------------------------------------------
// PSE's red Part 1 notice: a change to an existing system must be filed as a MODIFICATION on the
// original record when one exists. A person decides that; the run says so at review and goes on.
// ---------------------------------------------------------------------------

const MODIFICATION_NOTICE = /[^.!?]*\bmodification\b[^.!?]{0,120}\boriginal\s+(?:record|application|project|interconnection)\b[^.!?]*[.!?]?/i;

/** The notice sentence, digits masked, or "" when the page carries none. */
export function modificationOnOriginalNotice(bodyText: string | null | undefined): string {
  const m = squash(String(bodyText ?? "")).match(MODIFICATION_NOTICE);
  if (!m) return "";
  return squash(m[0]).replace(/\d{4,}/g, "####").slice(0, 280);
}
