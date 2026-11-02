// ---------------------------------------------------------------------------
// "WE FILED IT" — the client hears the day their review clock starts (#490).
//
// Clients heard from us only when something came back (issued / ready for issue / NEM approved /
// correction). The day a permit or NEM application went in, nothing was sent, so the client did
// not know their clock had started and phoned to ask. This module is the ONE door every filing
// recorder calls; the words live in clientUpdates.ts (CLIENT_FILED_EVENT) and the delivery is the
// existing notifier's (note first, then email or a draft when SMTP is unset), so a filing reads
// the same on the status page as in the inbox.
//
// Kept out of clientNotifier.ts on purpose: that module is the delivery path several features
// share; this is one event's rules (who, once, what it may say).
// ---------------------------------------------------------------------------
import type { AppDb } from "./db";
import type { ProjectRecord } from "../../shared/src/types";
import { redactSecretValues } from "../../shared/src/portalSafety";
import { addAuditLog } from "./audit";
import { clientUpdatesSilenced, notifyClientOfStatusChange } from "./clientNotifier";
import { CLIENT_FILED_EVENT } from "./clientUpdates";
import { text } from "./json";
import { knowledgeProfileKey } from "./knowledgeBase";
import { logger } from "./logger";
import { trackKind } from "./permitMonitor";
import { projectForTrack } from "./permitProcess";
import { projectSecretValues } from "./projectSecrets";

/**
 * The record number a client may be sent, or "" (RULE 2). The number is the one value in the
 * update that came from outside our templates — typed by an operator or read off a completion
 * page — so it is held to the shape of a record number, and refused when it carries one of the
 * project's account/meter values (separators ignored: redactSecretValues). A refused number is
 * DROPPED, never sent as "[redacted]": the sentence reads whole without it, and the client asks
 * nobody what we hid.
 */
export function clientSafeRecordNumber(value: unknown, secrets: readonly string[]): string {
  const v = text(value).trim();
  // A record number, not prose: Accela "519-26-004490-STR", PowerClerk "APP-111681", EnerGov
  // "BLD2026-01234". Scraped page text ("Thank you, your application…") is not one.
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._/#-]{1,39}$/.test(v) || /\s{2,}/.test(v) || v.split(/\s+/).length > 3) return "";
  return redactSecretValues(v, secrets) === v ? v : "";
}

/** The fewest measured filings a review time rests on before a client is quoted it. One fast
 *  filing is an anecdote, and a client books a crew around this sentence. */
const MIN_REVIEW_SAMPLES_TO_QUOTE = 3;

/**
 * The usual filing-to-issued (permit) or filing-to-approved (NEM) time for this agency, in days,
 * or null. Read from the SAME profile key the turnaround samples are written to
 * (timelineSamples.recordTimelineSample: the utility's state|—|utility row for NEM, the
 * state|agency|utility row for a permit) — so it is only ever a MEASURED median
 * (average_timeline_days is derived from samples alone), never a seeded or fuzzy-matched guess.
 */
export function usualReviewDays(db: AppDb, input: { nem: boolean; state: string; agency: string; utility: string }): number | null {
  if (input.nem ? !input.utility.trim() : !input.agency.trim()) return null;
  const key = input.nem
    ? knowledgeProfileKey({ state: input.state, ahj: "", utility: input.utility })
    : knowledgeProfileKey({ state: input.state, ahj: input.agency, utility: input.utility });
  const row = db.get<{ average_timeline_days?: number | null; timeline_sample_count?: number | null }>(
    "SELECT average_timeline_days, timeline_sample_count FROM permit_utility_knowledge WHERE profile_key = ?", [key],
  );
  const days = row?.average_timeline_days == null ? NaN : Number(row.average_timeline_days);
  if (!Number.isFinite(days) || days <= 0) return null;
  return Number(row?.timeline_sample_count ?? 0) >= MIN_REVIEW_SAMPLES_TO_QUOTE ? days : null;
}

/** The audit action that marks a track's filing as already announced — the no-resend record. */
export const FILING_ANNOUNCED_ACTION = "client.filing_announced";

/**
 * TELL THE CLIENT WE FILED (#490). Called by every door that records a CONFIRMED filing — the
 * gated auto-submit when the portal accepted it, captureConfirmation (the hand-over read and the
 * dashboard's capture form both land there) and the track card's "mark submitted". Never by the
 * monitor, and never for a submit the portal did not confirm.
 *
 * ONCE PER TRACK. The same filing is legitimately recorded more than once — the live database
 * holds one run captured twice five minutes apart, and an operator often marks the track
 * submitted after the capture already did — and each of those is the same news. The marker is an
 * audit row claimed SYNCHRONOUSLY, before the first await, so two doors recording the same filing
 * in one tick cannot both send.
 *
 * Fire-and-forget: never throws, so a mail problem cannot roll back or fail the filing record.
 */
export function notifyClientOfFiling(
  db: AppDb,
  project: ProjectRecord,
  filing: { track: string; applicationNumber?: string; permitNumber?: string; via: "auto_submit" | "capture" | "mark_submitted" },
): Promise<void> {
  try {
    if (clientUpdatesSilenced(db, project)) return Promise.resolve();
    const secrets = projectSecretValues(project);
    const track = text(filing.track).trim().toLowerCase() || "permit";
    const already = db.query<{ details?: string }>(
      "SELECT details FROM audit_logs WHERE project_id = ? AND action = ?", [project.id, FILING_ANNOUNCED_ACTION],
    ).some((row) => {
      try { return String((JSON.parse(String(row.details || "{}")) as { track?: unknown }).track || "") === track; } catch { return false; }
    });
    if (already) return Promise.resolve();
    addAuditLog(db, project.id, "system", "client-notifier", FILING_ANNOUNCED_ACTION, { track, via: filing.via });

    const nem = trackKind("", track) === "nem";
    // The agency that received THIS track's filing: the utility for NEM; for a permit the track's
    // issuer (projectForTrack — the same view staging staged it with), else the project's AHJ.
    let agency = text(project.utility);
    if (!nem) {
      try { agency = text(projectForTrack(project, track).ahj) || text(project.ahj); } catch { agency = text(project.ahj); }
    }
    const reviewDays = usualReviewDays(db, { nem, state: text(project.state), agency, utility: text(project.utility) });
    return notifyClientOfStatusChange(db, project, {
      outcome: CLIENT_FILED_EVENT,
      statusLabel: "Filed",
      targetType: nem ? "nem" : "permit",
      permitType: track,
      applicationNumber: clientSafeRecordNumber(filing.applicationNumber, secrets),
      permitNumber: clientSafeRecordNumber(filing.permitNumber, secrets),
      agency,
      reviewDays,
    });
  } catch (err) {
    logger.warn("notify", `client filing update failed: ${err instanceof Error ? err.message : String(err)}`);
    return Promise.resolve();
  }
}
