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
  const tell = created ?? (recordCreated && cont ? recordCreated : null) ?? status;
  if (!tell) return NOT_A_DRAFT;
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

/** "1234 N Example St" → ["1234", "example"]: the house number and the street's first real word. */
function streetTokens(street: string): string[] {
  const words = formKey(street).split(" ").filter(Boolean);
  const house = words.find((w) => /^\d+[a-z]?$/.test(w));
  const DIRECTIONAL = /^(n|s|e|w|ne|nw|se|sw|north|south|east|west)$/;
  const name = words.find((w) => w !== house && !/^\d/.test(w) && !DIRECTIONAL.test(w));
  return house && name ? [house, name] : [];
}

export function findSiteDraft(entries: LedgerEntry[], site: { applicationNumber?: string; street?: string }): SiteDraftFind {
  const list = Array.isArray(entries) ? entries : [];
  const number = String(site.applicationNumber ?? "").trim().toUpperCase();
  if (number) {
    const hits = list.filter((e) => String(e.id || "").trim().toUpperCase() === number);
    if (hits.length === 1) return { found: true, entry: hits[0], why: `the recorded draft ${number} is listed` };
    return { found: false, ambiguous: hits.length > 1, why: hits.length > 1 ? `${hits.length} rows carry ${number}` : `the recorded draft ${number} is not on this list` };
  }
  const tokens = streetTokens(String(site.street ?? ""));
  if (!tokens.length) return { found: false, ambiguous: false, why: "the project has no street address to match a draft by" };
  const hits = list.filter((e) => {
    const row = formKey(e.row || "");
    return readsAsUnsubmittedDraft(e.row) && tokens.every((t) => new RegExp(`(^| )${t}( |$)`).test(row));
  });
  if (hits.length === 1) return { found: true, entry: hits[0], why: `${hits[0].id} is the one unsubmitted draft listed for this street address` };
  if (hits.length > 1) return { found: false, ambiguous: true, why: `${hits.length} unsubmitted drafts are listed for this street address (${hits.map((h) => h.id).join(", ")})` };
  return { found: false, ambiguous: false, why: "no unsubmitted draft is listed for this street address" };
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
