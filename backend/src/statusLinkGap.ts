// WHY A TRACKED FILING CANNOT READ ITS OWN STATUS, IN ONE LINE A PERSON CAN ACT ON (#413).
//
// A sweep that reads nothing records nothing (permitMonitor.shouldSkipEmptyRead) — rightly, since an
// empty read is not a status — and until now it said so only in a log line and an audit row. The
// card stayed blank. The Helm's NEM readiness audit of main 00daa23b found every PGE card on the
// install in that state (PGE recipes demoted, no profile), and the owner's Lincoln County project
// 7ddfbe48 sat for weeks with three cards that never moved because none had a status link.
//
// So the sweep stores this line on the target (permit_check_targets.read_gap) whenever it gathered
// nothing, clears it when it reads a status, and the card shows it. ONE wording table, pure, so the
// card's words are pinned by a test and cannot drift from the sweep's own facts. It never decides
// anything: the read has already happened (or not) when this is asked.
import type { TrackKind } from "./permitMonitor";

/** How the signed-in read ended, from the reason the scraper reported (portal-bot statusFinder /
 *  checkStatusWithAdapter word these). `not_tried` = no signed-in read ran. */
export type SignedInOutcome = "not_tried" | "wall" | "mfa" | "not_found" | "failed" | "throttled";

export function signedInOutcome(ran: boolean, reason: string): SignedInOutcome {
  if (!ran) return "not_tried";
  const r = String(reason ?? "");
  if (/\bMFA\b|CAPTCHA/i.test(r)) return "mfa";
  if (/sign-in wall|sign-in page|sign-in failed|sign in|log ?in page|login page/i.test(r)) return "wall";
  if (/not on "|not on the|no matching row|not in the|held no status|is not on/i.test(r)) return "not_found";
  return "failed";
}

export interface ReadGapFacts {
  track: TrackKind;
  /** The utility (NEM) or jurisdiction (permit) the filing is with, as the project names it. */
  entityName: string;
  /** The project's client — whose portal login the read would use (rule 6). */
  clientName: string;
  hasNumber: boolean;
  /** "used": a learned recipe drove a signed-in read; "refused": one exists but rule 5 / the entity
   *  check refused it for this filing; "none": nothing learned for this portal. */
  recipe: "none" | "refused" | "used";
  /** A legacy platform profile drove a signed-in read. */
  profileUsed: boolean;
  /** The host the signed-in read used ("" when none ran). */
  portalHost: string;
  signedIn: SignedInOutcome;
  hasCredential: boolean;
  /** The public read: "none" (no link to read), "no_status" (read, nothing readable), "wall" (a sign-in page). */
  publicLink: "none" | "no_status" | "wall";
}

const ON = (host: string) => (host ? ` on ${host}` : "");

/** The one actionable line, or "" when the facts describe no gap. */
export function statusReadGap(f: ReadGapFacts): string {
  const entity = f.entityName.trim() || (f.track === "nem" ? "this utility" : "this jurisdiction");
  const client = f.clientName.trim() || "this client";
  const host = f.portalHost.trim();
  if (!f.hasNumber) {
    return "No application or permit number on this filing yet. Add it (Edit) so the monitor can look the filing up.";
  }
  if (f.signedIn === "mfa") {
    return `Login wall: ${host || "the portal"} asked for MFA or a CAPTCHA, which the monitor never answers. Record the status by hand, or sign in once yourself to refresh the session.`;
  }
  if (f.signedIn === "wall") {
    return `Login wall: ${host || "the portal"} showed its sign-in page. ${f.hasCredential ? "Refresh" : "Link"} a portal login for ${client}${ON(host)}, or record the status by hand.`;
  }
  if (f.signedIn === "throttled") {
    return "The account's record list was already searched for this filing's link in the last day; the monitor tries again tomorrow. Paste the record link (Edit, Public status URL) to read it sooner.";
  }
  if (f.signedIn === "not_found") {
    return `Signed in${ON(host)}, but this filing is not in the account's record list. Paste the record link (Edit, Public status URL), or record the status by hand.`;
  }
  if (f.signedIn === "failed") {
    return `The signed-in read${ON(host)} failed this check. Record the status by hand if it has changed; the monitor tries again on the next check.`;
  }
  if (f.publicLink === "wall") {
    return f.track === "nem"
      ? `Login wall: the status link opens a sign-in page, and no portal recipe is learned for ${entity} to sign in with. Record the status by hand until the portal is learned.`
      : "Login wall: the status link opens a sign-in page. Paste the public record link (Edit, Public status URL), or record the status by hand.";
  }
  if (f.publicLink === "no_status") {
    return "The status link held no readable status. Check the link (Edit), or record the status by hand.";
  }
  const refused = f.recipe === "refused" ? " (the portal on record is not this filing's portal)" : "";
  return f.track === "nem"
    ? `No portal recipe learned for ${entity} yet${refused}, and its record pages need a login, so the monitor cannot read this filing. Record the status by hand until the portal is learned.`
    : `No status link and no learned portal for ${entity}${refused}. Paste the record link (Edit, Public status URL), link a portal login for ${client}, or record the status by hand.`;
}

/** At most one record-list lookup for a missing link per target per day (#413: go gently on live
 *  portals). True = a lookup ran less than a day before `now`. */
export const LINK_LOOKUP_MIN_HOURS = 24;
export function linkLookupRanRecently(lastLookupAt: string | null | undefined, now: Date = new Date()): boolean {
  const at = Date.parse(String(lastLookupAt ?? ""));
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at < LINK_LOOKUP_MIN_HOURS * 3600_000;
}
