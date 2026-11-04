// #436 — THE STAGED DRAFT'S REFERENCE: ONE QUESTION, ONE PREDICATE (the reader and the row's writer).
//
// PR2 and PR3 read the draft id and the review link from the server's OWN row (design §1: "the server
// copies the digest and draft ID from its own row"). So the row must hold the portal's id and link
// EXACTLY — never a masked look-alike. A display redaction (redactCaptureText masks every 5+ digit
// run) turned PowerClerk's ProjectId=204411 into "**4411", which binds nothing. Here the reference is
// checked BY SHAPE and kept as is, or REFUSED (never masked):
//   - the link is a plain http(s) URL, no user:password, at most STAGED_LINK_MAX characters (refused
//     over it, never truncated: a cut link is as wrong as a masked one);
//   - the link is in its kept form (cleanRecordLink: the record's own parameters, no session
//     material), and the id is id-shaped and is the id the link itself carries (draftReferenceFromUrl),
//     so the row is self-consistent;
//   - RULE 2: neither carries one of the project's own secrets (account / meter numbers, separators
//     ignored — redactSecretValues, the one matcher), nor an email address. Checked on the link as
//     written AND percent-decoded once.
// A refused reference is stored as "" (both), and the row is unapprovable with the reason.
import { redactSecretValues } from "../../shared/src/portalSafety";
import { draftReferenceFromUrl } from "./adapters/submissionLedger";

/** A review link longer than this is refused, never cut. */
export const STAGED_LINK_MAX = 1000;
/** The id's shape: letters and digits, with . _ ~ : - between them (PowerClerk "204411" or
 *  "QS6TY7QARSY7", Accela "26CAP-00000-00ABC"), at most 80 characters. */
export const STAGED_DRAFT_ID_SHAPE = /^[A-Za-z0-9](?:[A-Za-z0-9._~:-]{0,78}[A-Za-z0-9])?$/;
const EMAIL = /[^\s@/?#&=]+@[^\s@/?#&=]+\.[A-Za-z]{2,}/;

export interface StagedDraftReference {
  /** The id as the portal gave it, or "" when refused. */
  draftId: string;
  /** The review link as the portal gave it, or "" when refused. */
  reviewLink: string;
  /** "" = kept; otherwise why the reference was refused (no value of it in the reason). */
  refused: string;
}

/** THE ONE ANSWER: may this draft id and review link be kept, exactly as they are? */
export function stagedDraftReference(rawDraftId: unknown, rawLink: unknown, secrets: readonly string[]): StagedDraftReference {
  const refuse = (why: string): StagedDraftReference => ({ draftId: "", reviewLink: "", refused: why });
  const draftId = String(rawDraftId ?? "").trim();
  const link = String(rawLink ?? "").trim();
  if (!link) return refuse("the review page's link is empty");
  if (link.length > STAGED_LINK_MAX) return refuse(`the review page's link is longer than ${STAGED_LINK_MAX} characters`);
  let u: URL;
  try { u = new URL(link); } catch { return refuse("the review page's link does not parse"); }
  if (!/^https?:$/.test(u.protocol)) return refuse("the review page's link is not an http(s) link");
  if (u.username || u.password) return refuse("the review page's link carries a user name or password");
  // Decoded once, a query's "+" read as the space it stands for ("8814+402+937").
  let decoded = link;
  try { decoded = decodeURIComponent(link.replace(/\+/g, " ")); } catch { decoded = link.replace(/\+/g, " "); }
  const real = (secrets ?? []).map((x) => String(x ?? "").trim()).filter((x) => x.length >= 4);
  const carries = (t: string): boolean => redactSecretValues(t, real, () => "\u0000") !== t;
  if (carries(link) || carries(decoded) || carries(draftId)) {
    return refuse("the review page's link carries one of the project's own account or meter numbers, so neither it nor its draft id is kept");
  }
  if (EMAIL.test(decoded)) return refuse("the review page's link carries an email address, so it is not kept");
  if (!draftId) return refuse("the review page's link carries no draft id");
  if (!STAGED_DRAFT_ID_SHAPE.test(draftId)) return refuse("the draft id is not id-shaped");
  const own = draftReferenceFromUrl(link);
  // The link in its kept form only (cleanRecordLink: no session material), so the row holds what a GET may reopen.
  if (own.link !== link) return refuse("the review page's link is not in its kept form (it carries more than the record's own parameters)");
  if (own.id !== draftId) return refuse("the draft id is not the one the review page's link carries");
  return { draftId, reviewLink: link, refused: "" };
}
