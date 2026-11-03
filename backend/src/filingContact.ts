// THE FILING SERVICE'S OWN CONTACT EMAIL (#520) — one server setting.
//
// FILING_CONTACT_EMAIL is the address agency and utility mail about a filing should ALSO reach (the
// tracking inbox). It fills only a form's SEPARATE applicant / agent / additional-contact email slot
// (shared/src/filingContactEmail — the one slot predicate); the contractor's own box keeps the
// client's email, and a homeowner's box (PowerClerk's Applicant on NEM) is never touched.
//
// A LEAF (env only). Unset, or not shaped like an email address: "" — every reader then behaves
// exactly as before the setting existed.
import { looksLikeEmail } from "../../shared/src/emailAddress";

export function filingContactEmailSetting(env: NodeJS.ProcessEnv = process.env): string {
  const raw = String(env.FILING_CONTACT_EMAIL ?? "").trim();
  return looksLikeEmail(raw) ? raw : "";
}
