// THE FILING SERVICE'S OWN EMAIL GOES IN A SEPARATE SLOT, NEVER IN SOMEONE ELSE'S (#520).
//
// Owner request 2026-11-02: most AHJs give the filing a second email slot (an applicant / agent /
// correspondence / additional contact email) besides the contractor's own, and agency and utility
// mail about the filing should reach the filing service's tracking inbox there as well as the
// installer. Owner ruling 2026-11-02 20:32 UTC ("we still need the ho to get the nem email
// though"): the address is ADDITIVE ONLY.
//
// ONE predicate, asked by the learn-time planner pass (backend autoLearn.buildPortalPlanner) and the
// replay binder (backend recipeReplayBinding R12), so learn and replay cannot disagree about which
// box takes it:
//
//   - the CONTRACTOR's own email box keeps the client's email (installerEmail): the licensed
//     contractor stays on record;
//   - a form with ONE company email slot keeps the client's email in it — no silent swap;
//   - a box that names a SEPARATE contact (additional / alternate / secondary contact,
//     notification, cc) takes the filing contact's email on either track;
//   - an applicant / agent / correspondence email takes it on a PERMIT form only, and only when the
//     same form also has the contractor's own email box (otherwise that slot IS the contractor's);
//   - a second address of the COMPANY's own contact ("Secondary Email" in a contractor dialog) takes
//     it; a second address in an owner's / customer's block is the homeowner's and is left alone;
//   - an owner / homeowner / customer / account-holder box NEVER takes it, and on a utility
//     interconnection (NEM) the "Applicant" IS the customer: PowerClerk's Applicant email is the
//     homeowner's, where the utility sends the e-signature and the NEM mail. Never replaced.

import { contactSectionRole, type ContactTrack } from "./contactRoles";

/** The recipe key the filing service's own contact email binds to (resolveRecipeFieldValues). */
export const FILING_CONTACT_EMAIL_KEY = "filingContactEmail";

export interface EmailBoxOnForm {
  /** The box's own label ("Applicant Email", "Email", "Alternate Contact Email"). */
  label: string;
  /** Its enclosing section heading / wizard step, when known. */
  section?: string;
  /** The box sits in ONE contact's dialog (an Accela Add New / Edit contact dialog). Its plain email
   *  box is that contact's own (contactRoles: one contact, one identity — the learner's and the
   *  replay's dialog guards make every identity box hold the section's identity), so only a SECOND
   *  address or a separate-contact box there can take the filing contact's email. */
  inContactBlock?: boolean;
}

/** What ONE email box is, from its own words and its section's. */
export type EmailSlotKind =
  | "company"         // the contractor / installer's own email
  | "owner"           // the homeowner / customer / account holder's
  | "separateContact" // a box naming a distinct extra contact (additional / alternate contact, notification, cc)
  | "companySecond"   // a second address of the company's own contact (Secondary Email in its block)
  | "agentRole"       // applicant / agent / correspondence / representative email (permit track)
  | null;             // says nothing — left to the existing rules

function norm(text: string | null | undefined): string {
  return String(text ?? "").replace(/\s+/g, " ").replace(/[*:]+/g, " ").trim().toLowerCase();
}

const EMAIL = /\be-?mail\b/;
const OWNER_WORDS = /\b(?:property owners?|home ?owners?|owners?|customers?|account holders?|site contact)\b/;
// A box that names ANOTHER contact than the block's own: "Additional Contact Email", "Alternate
// Contact E-mail", "Notification Email", "Email notifications to", "CC Email".
const SEPARATE_CONTACT = /\b(?:additional|alternate|alt|secondary|other|second)\s+contacts?\b|\bnotifications?\b|\bnotify\b|\bcc\b|\bcopy to\b/;
// A second ADDRESS of the block's own contact: "Secondary Email", "Alternate E-mail", "Email 2".
const SECOND_ADDRESS = /\b(?:secondary|alternate|alt|other|second|2nd|additional)\b|\be-?mail\s*#?\s*2\b/;
const COMPANY_WORDS = /\b(?:contractors?|installers?|business|company|licensed professionals?|preparer)\b/;
const AGENT_WORDS = /\b(?:applicants?|agents?|correspondence|representatives?|submitter|permit contact|primary contact|point of contact|contact person)\b|^contact e-?mail\b/;
const SEPARATE_SECTION = /\b(?:additional|alternate|secondary|other)\s+contacts?\b|\bnotifications?\b/;

/** Which kind of email slot ONE box is. null when the box is not an email box or says nothing. */
export function emailSlotKind(box: EmailBoxOnForm, opts: { track: ContactTrack }): EmailSlotKind {
  const label = norm(box.label);
  const section = norm(box.section);
  if (!EMAIL.test(label)) return null;
  const nem = opts.track === "nem";
  const sectionRole = section ? contactSectionRole(section, { track: opts.track }) : null;
  // The box's OWN words first.
  if (OWNER_WORDS.test(label)) return "owner";
  // On a utility interconnection the applicant is the customer (contactRoles.contactSectionRole).
  if (nem && /\bapplicants?\b/.test(label) && !COMPANY_WORDS.test(label)) return "owner";
  if (SEPARATE_CONTACT.test(label)) return sectionRole === "owner" ? "owner" : "separateContact";
  if (SECOND_ADDRESS.test(label)) {
    // The block's own second address: the company's takes the filing contact; the owner's, or a
    // block nobody can name, is left exactly as the existing rules have it.
    if (sectionRole === "company" && !(nem && /\bapplicants?\b/.test(section))) return "companySecond";
    return sectionRole === "owner" ? "owner" : null;
  }
  if (COMPANY_WORDS.test(label)) return "company";
  if (!nem && AGENT_WORDS.test(label)) return box.inContactBlock ? "company" : "agentRole";
  // Then its section's. A section naming an owner at all ("Owner/Applicant", which
  // contactSectionRole declines to guess) is never the filing contact's.
  if (sectionRole === "owner") return "owner";
  if (OWNER_WORDS.test(section)) return null;
  if (SEPARATE_SECTION.test(section)) return "separateContact";
  if (COMPANY_WORDS.test(section) || /\binspection contacts?\b/.test(section)) return "company";
  if (!nem && AGENT_WORDS.test(section)) return box.inContactBlock ? "company" : "agentRole";
  if (sectionRole === "company") return nem || box.inContactBlock ? "company" : "agentRole";
  return null;
}

/** For each box of ONE form (every page of one application), whether it takes the filing contact's
 *  email (true) or is left to the existing rules (false). `enabled` false (no filing contact email
 *  configured) answers false for every box: today's behaviour exactly. */
export function planFilingContactEmails(boxes: EmailBoxOnForm[], opts: { track: ContactTrack; enabled: boolean }): boolean[] {
  const kinds = boxes.map((b) => emailSlotKind(b, opts));
  if (!opts.enabled) return kinds.map(() => false);
  const hasCompanyBox = kinds.includes("company");
  // Two agent-role boxes and no contractor box: the first is the contractor's one slot, so the
  // filing contact takes the others. With a contractor box, every agent-role box is a separate one.
  const firstAgent = kinds.indexOf("agentRole");
  return kinds.map((k, i) => {
    if (k === "separateContact" || k === "companySecond") return true;
    if (k === "agentRole") return opts.track === "permit" && (hasCompanyBox || i !== firstAgent);
    return false;
  });
}

/** True for a box that must NEVER take the filing contact's email: the homeowner / customer's, which
 *  on a utility interconnection includes the Applicant (the utility's e-signature goes there). */
export function isOwnerEmailSlot(box: EmailBoxOnForm, opts: { track: ContactTrack }): boolean {
  return emailSlotKind(box, opts) === "owner";
}

/** "nem" for a utility interconnection track, "permit" for every permit track — the reading of
 *  "applicant" the contact predicates use (contactRoles.ContactTrack). */
export function contactTrackOf(track: string | null | undefined): ContactTrack {
  return String(track ?? "").trim().toLowerCase() === "nem" ? "nem" : "permit";
}
