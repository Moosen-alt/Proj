// ---------------------------------------------------------------------------
// THE CLIENT'S TIMELINE OF ONE JOB (#497): filed → issued / approved → installed → final → PTO.
//
// The status pages showed what each filing reads today and a history of changes, but no single
// line of where the job is from filing to PTO, with dates, and how long the agency's current step
// has taken against how long it usually takes. A client asking "where are we?" read three cards
// and still phoned. This is that line, built on the server from records we already keep:
//
//   · filed / issued / approved: submittalTracks.trackProgress — the tracks panel's own status
//     and isTrackDone's verdict, never a second copy of "is it filed, is it done";
//   · installed / final passed / PTO requested / PTO granted: project_milestones (migration v59),
//     written only by recordProjectMilestone below;
//   · the usual days: clientFilingUpdate.usualReviewDays — the measured median of real filings
//     (permit_timeline_samples, rolled up in the KB) when there are at least three, else nothing.
//
// WHAT IT NEVER CARRIES: record numbers, portal text, correction text, notes. Every label and
// detail line below is a fixed template; the dates are ours and the day counts are arithmetic on
// them. The Applications card keeps the numbers, behind its own checks.
//
// TENANCY: every reader takes a project the caller already authorized (a status token resolved to
// one project, a client token's own projects, a staff route under /api/projects/:id). Nothing here
// lists projects.
// ---------------------------------------------------------------------------
import type { AppDb } from "./db";
import type {
  ClientTimeline, ClientTimelineStep, ClientTimelineStepKey, ProjectMilestoneKey, ProjectMilestoneRecord, ProjectRecord,
  SubmittalTrackStatus,
} from "../../shared/src/types";
import { addAuditLog } from "./audit";
import { usualReviewDays } from "./clientFilingUpdate";
import { clientUpdatesSilenced, notifyClientOfStatusChange } from "./clientNotifier";
import { isClientMilestoneEvent } from "./clientUpdates";
import { HttpError } from "./httpError";
import { text } from "./json";
import { logger } from "./logger";
import { projectForTrack } from "./permitProcess";
import { getProjectDetail } from "./repository";
import { trackProgress, type TrackProgress } from "./submittalTracks";
import { nowIso } from "./time";

/** The closeout milestones, in the order a job reaches them. */
export const PROJECT_MILESTONES: ReadonlyArray<{ key: ProjectMilestoneKey; label: string }> = [
  { key: "installed", label: "Installed" },
  { key: "final_passed", label: "Final inspection passed" },
  { key: "pto_requested", label: "Permission to operate requested" },
  { key: "pto_granted", label: "Permission to operate granted" },
];

export function isProjectMilestoneKey(value: string): value is ProjectMilestoneKey {
  return PROJECT_MILESTONES.some((m) => m.key === value);
}

/** The audit action that marks a milestone as already announced to the client — the no-resend
 *  record, claimed before the send (the same pattern as the filing update's marker). */
export const MILESTONE_ANNOUNCED_ACTION = "client.milestone_announced";

const DAY_MS = 86_400_000;

function wholeDays(fromIso: string | null, toIso: string | null): number | null {
  if (!fromIso || !toIso) return null;
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return Math.floor((to - from) / DAY_MS);
}

const earliest = (dates: Array<string | null>): string | null =>
  dates.filter((d): d is string => Boolean(d)).sort()[0] ?? null;
const latest = (dates: Array<string | null>): string | null =>
  dates.filter((d): d is string => Boolean(d)).sort().pop() ?? null;

/** A track has gone in once the panel reads it anywhere past staged. */
const FILED: ReadonlySet<SubmittalTrackStatus> = new Set(["submitted", "in_review", "correction", "ready_for_issue", "issued"]);

/** The project's recorded closeout milestones, keyed. Read-only. */
function recordedMilestones(db: AppDb, projectId: string): Map<string, { at: string; recordedBy: string }> {
  const rows = db.query<{ milestone?: string; reached_at?: string; recorded_by?: string }>(
    "SELECT milestone, reached_at, recorded_by FROM project_milestones WHERE project_id = ?", [projectId],
  );
  return new Map(rows.map((r) => [text(r.milestone), { at: text(r.reached_at), recordedBy: text(r.recorded_by) }]));
}

/** Staff view: every closeout milestone, recorded or not. */
export function projectMilestones(db: AppDb, projectId: string): ProjectMilestoneRecord[] {
  const recorded = recordedMilestones(db, projectId);
  return PROJECT_MILESTONES.map((m) => ({
    key: m.key,
    label: m.label,
    at: recorded.get(m.key)?.at || null,
    recordedBy: recorded.get(m.key)?.recordedBy || "",
    clientFacing: isClientMilestoneEvent(m.key),
  }));
}

/** The fixed client line for a filing step that has not gone in yet. */
function preparingDetail(tracks: TrackProgress[]): string {
  return tracks.some((t) => t.status === "staged") ? "Prepared — final submission in progress" : "Being prepared";
}

/** The fixed client line for an agency step under review. Correction and fee wording match the
 *  Applications card's (clientPortal.publicCheckLabel), so one job never reads two ways. */
function reviewDetail(open: TrackProgress[], doneCount: number, total: number, noun: string): string {
  if (open.some((t) => t.status === "correction")) return "Correction requested — we are on it";
  if (open.some((t) => t.status === "ready_for_issue")) return "Approved — fee or pickup due before issue";
  if (total > 1 && doneCount > 0) return `${doneCount} of ${total} ${noun} issued`;
  return "";
}

/**
 * THE TIMELINE, for one job. Read-only. `now` is injectable for tests.
 *
 * Which steps a job has: the permit steps when it files a permit (every job does —
 * requiredTracks), the interconnection and PTO steps when it has a utility. Within one chain each
 * step waits on the one before it; the permit chain and the interconnection run side by side, so
 * both can be "current" at once. A step is never current once a LATER step of its chain is done
 * (a milestone recorded out of order does not light up the steps before it).
 */
export function buildClientTimeline(db: AppDb, project: ProjectRecord, now: Date = new Date()): ClientTimeline {
  const progress = trackProgress(db, project);
  const permits = progress.filter((t) => t.type !== "nem");
  const nem = progress.find((t) => t.type === "nem") ?? null;
  const recorded = recordedMilestones(db, project.id);
  const nowIsoString = now.toISOString();
  const state = text(project.state);
  const utility = text(project.utility);

  // LABELS NAME THE STEP, NEVER ITS OUTCOME ("Interconnection review", not "Interconnection
  // approved"): every step is listed from the first day, and a page that prints "Interconnection
  // approved" beside a hollow dot has still printed the claim (readingProvenance.test pins that the
  // status page never words an unconfirmed approval). The outcome word is `doneDetail`, shown only
  // once the step is done.
  type Draft = { key: ClientTimelineStepKey; label: string; done: boolean; at: string | null; start: string | null;
    ready: boolean; detail: string; doneDetail: string; typical: number | null };
  const steps: Draft[] = [];

  // --- the permit chain -------------------------------------------------------------------
  const permitFiled = permits.length > 0 && permits.every((t) => FILED.has(t.status));
  const permitFirstFiledAt = earliest(permits.map((t) => t.filedAt));
  const permitsDone = permits.filter((t) => t.status === "issued");
  const permitIssued = permits.length > 0 && permitsDone.length === permits.length;
  const permitOpen = permits.filter((t) => t.status !== "issued");
  const filedCount = permits.filter((t) => FILED.has(t.status)).length;
  steps.push({
    key: "permit_filed",
    label: permits.length > 1 ? "Permit applications" : "Permit application",
    doneDetail: "Filed",
    done: permitFiled,
    // The step completed when its LAST filing went in; the review clock below starts at the first.
    at: permitFiled ? latest(permits.map((t) => t.filedAt)) : null,
    start: null,
    ready: true,
    detail: permitFiled ? "" : filedCount > 0 ? `${filedCount} of ${permits.length} filed` : preparingDetail(permits),
    typical: null,
  });
  // The usual days for the permit still open, at the agency that issues IT (a split-issuer job
  // files its electrical permit with another office) — the same agency the filing update quoted.
  let permitTypical: number | null = null;
  if (!permitIssued && permitOpen.length) {
    let agency = text(project.ahj);
    try { agency = text(projectForTrack(project, permitOpen[0].type).ahj) || agency; } catch { /* the project's AHJ */ }
    permitTypical = usualReviewDays(db, { nem: false, state, agency, utility });
  }
  steps.push({
    key: "permit_issued",
    label: "Permit review",
    doneDetail: permits.length > 1 ? "All permits issued" : "Issued",
    done: permitIssued,
    at: permitIssued ? latest(permitsDone.map((t) => t.doneAt)) : null,
    start: permitFirstFiledAt,
    ready: filedCount > 0,
    detail: permitIssued ? "" : reviewDetail(permitOpen, permitsDone.length, permits.length, "permits"),
    typical: permitTypical,
  });

  // --- the interconnection ----------------------------------------------------------------
  if (nem) {
    const nemFiled = FILED.has(nem.status);
    const nemApproved = nem.status === "issued";
    steps.push({
      key: "nem_filed",
      label: "Interconnection application",
      doneDetail: "Filed",
      done: nemFiled,
      at: nemFiled ? nem.filedAt : null,
      start: null,
      ready: true,
      detail: nemFiled ? "" : preparingDetail([nem]),
      typical: null,
    });
    steps.push({
      key: "nem_approved",
      label: "Interconnection review",
      doneDetail: "Approved",
      done: nemApproved,
      at: nemApproved ? nem.doneAt : null,
      start: nem.filedAt,
      ready: nemFiled,
      detail: nemApproved ? "" : nem.status === "correction" ? "Correction requested — we are on it"
        : nem.status === "ready_for_issue" ? "Approved — fee due" : "",
      typical: nemFiled && !nemApproved ? usualReviewDays(db, { nem: true, state, agency: utility, utility }) : null,
    });
  }

  // --- the closeout -----------------------------------------------------------------------
  const milestone = (key: ProjectMilestoneKey) => recorded.get(key)?.at || null;
  const installedAt = milestone("installed");
  steps.push({
    key: "installed", label: "Installation", doneDetail: "Installed", done: Boolean(installedAt), at: installedAt,
    // The install is scheduled once the permit side is cleared.
    start: null, ready: permitIssued, detail: "", typical: null,
  });
  const finalAt = milestone("final_passed");
  steps.push({
    key: "final_passed", label: "Final inspection", doneDetail: "Passed", done: Boolean(finalAt), at: finalAt,
    start: installedAt, ready: Boolean(installedAt), detail: "", typical: null,
  });
  if (nem) {
    const requestedAt = milestone("pto_requested");
    const grantedAt = milestone("pto_granted");
    steps.push({
      key: "pto_requested", label: "Permission to operate request", doneDetail: "Requested", done: Boolean(requestedAt), at: requestedAt,
      // The utility's completion paperwork carries the final's sign-off, so the request follows it.
      start: finalAt, ready: Boolean(finalAt), detail: "", typical: null,
    });
    steps.push({
      key: "pto_granted", label: "Permission to operate", doneDetail: "Granted", done: Boolean(grantedAt), at: grantedAt,
      start: requestedAt, ready: Boolean(requestedAt), detail: "", typical: null,
    });
  }

  // Which chain a step belongs to, for "a later step of its chain is done".
  const CHAIN: Record<ClientTimelineStepKey, string[]> = {
    permit_filed: ["permit_issued", "installed", "final_passed", "pto_requested", "pto_granted"],
    permit_issued: ["installed", "final_passed", "pto_requested", "pto_granted"],
    nem_filed: ["nem_approved", "pto_requested", "pto_granted"],
    nem_approved: ["pto_requested", "pto_granted"],
    installed: ["final_passed", "pto_requested", "pto_granted"],
    final_passed: ["pto_requested", "pto_granted"],
    pto_requested: ["pto_granted"],
    pto_granted: [],
  };
  const doneKeys = new Set(steps.filter((s) => s.done).map((s) => s.key));

  return {
    steps: steps.map((s): ClientTimelineStep => {
      const current = !s.done && s.ready && !CHAIN[s.key].some((k) => doneKeys.has(k as ClientTimelineStepKey));
      return {
        key: s.key,
        label: s.label,
        state: s.done ? "done" : current ? "current" : "upcoming",
        at: s.done ? s.at : null,
        // A not-yet-current step's detail is still useful when it says how far its filings got.
        detail: s.done ? s.doneDetail : s.detail,
        tookDays: s.done ? wholeDays(s.start, s.at) : null,
        daysSoFar: current ? wholeDays(s.start, nowIsoString) : null,
        typicalDays: current && s.typical != null ? Math.max(1, Math.round(s.typical)) : null,
      };
    }),
  };
}

/**
 * The date a person typed, as the instant we store. A bare date (the dashboard's date input) is
 * stored at NOON UTC, so it reads as the same calendar day in every US time zone the client pages
 * render in; midnight UTC showed the day before. A date in the future is refused: a milestone is
 * something that happened.
 */
export function milestoneInstant(value: unknown, now: Date = new Date()): string {
  const raw = text(value).trim();
  if (!raw) return now.toISOString();
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? Date.parse(`${raw}T12:00:00.000Z`) : Date.parse(raw);
  if (!Number.isFinite(ms)) throw new HttpError(400, "The date is not a date (use YYYY-MM-DD).");
  // A day of slack: a person west of UTC recording "today" late in their evening is already
  // "tomorrow" in UTC, and noon of their today can sit hours ahead of the server's now.
  if (ms > now.getTime() + DAY_MS) throw new HttpError(400, "A milestone cannot be recorded in the future.");
  return new Date(ms).toISOString();
}

/**
 * RECORD ONE CLOSEOUT MILESTONE — the one door (#497). A person on the project page today; the
 * finals and PTO automation (#495, #496) calls this same function when it lands, so the timeline,
 * the client update and the audit trail cannot diverge between the two.
 *
 * Re-recording moves the date (a typo fixed) and announces nothing again. The client hears about
 * a client-facing milestone (CLIENT_MILESTONE_EVENTS) ONCE, ever: the marker is an audit row
 * claimed synchronously before the send, so two clicks in one tick cannot both send, and clearing
 * and re-recording a milestone does not re-send it.
 *
 * Returns the delivery promise separately so the route answers without waiting on SMTP; the
 * delivery never throws (notifyClientOfStatusChange).
 */
export function recordProjectMilestone(
  db: AppDb,
  projectId: string,
  input: { milestone: string; at?: unknown; recordedBy: string; source?: "operator" | "automation"; now?: Date },
): { milestones: ProjectMilestoneRecord[]; announced: Promise<void> | null } {
  const milestone = text(input.milestone).trim();
  if (!isProjectMilestoneKey(milestone)) throw new HttpError(400, `Unknown milestone: ${milestone || "(blank)"}.`);
  const exists = db.get<{ id?: string }>("SELECT id FROM projects WHERE id = ?", [projectId]);
  if (!exists?.id) throw new HttpError(404, "Project not found.");
  const at = milestoneInstant(input.at, input.now);
  const by = text(input.recordedBy).trim() || "operator";
  const source = input.source === "automation" ? "automation" : "operator";
  const previous = db.get<{ reached_at?: string }>(
    "SELECT reached_at FROM project_milestones WHERE project_id = ? AND milestone = ?", [projectId, milestone],
  );
  db.run(
    `INSERT INTO project_milestones (project_id, milestone, reached_at, recorded_by, source, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, milestone) DO UPDATE SET
       reached_at = excluded.reached_at, recorded_by = excluded.recorded_by,
       source = excluded.source, recorded_at = excluded.recorded_at`,
    [projectId, milestone, at, by, source, nowIso()],
  );
  addAuditLog(db, projectId, source === "automation" ? "system" : "human", by, "project.milestone_recorded", {
    milestone, at, previous: text(previous?.reached_at) || null,
  });
  return { milestones: projectMilestones(db, projectId), announced: announceMilestone(db, projectId, milestone) };
}

/** Clear a milestone recorded by mistake. What the client was already told stays told. */
export function clearProjectMilestone(db: AppDb, projectId: string, milestoneKey: string, clearedBy: string): ProjectMilestoneRecord[] {
  const milestone = text(milestoneKey).trim();
  if (!isProjectMilestoneKey(milestone)) throw new HttpError(400, `Unknown milestone: ${milestone || "(blank)"}.`);
  const exists = db.get<{ id?: string }>("SELECT id FROM projects WHERE id = ?", [projectId]);
  if (!exists?.id) throw new HttpError(404, "Project not found.");
  const previous = db.get<{ reached_at?: string }>(
    "SELECT reached_at FROM project_milestones WHERE project_id = ? AND milestone = ?", [projectId, milestone],
  );
  if (previous) {
    db.run("DELETE FROM project_milestones WHERE project_id = ? AND milestone = ?", [projectId, milestone]);
    addAuditLog(db, projectId, "human", text(clearedBy).trim() || "operator", "project.milestone_cleared", {
      milestone, at: text(previous.reached_at),
    });
  }
  return projectMilestones(db, projectId);
}

/** Send the client update for a client-facing milestone, once. null when nothing is sent. */
function announceMilestone(db: AppDb, projectId: string, milestone: ProjectMilestoneKey): Promise<void> | null {
  try {
    if (!isClientMilestoneEvent(milestone)) return null;
    const project = getProjectDetail(db, projectId).project;
    if (clientUpdatesSilenced(db, project)) return null;
    const already = db.query<{ details?: string }>(
      "SELECT details FROM audit_logs WHERE project_id = ? AND action = ?", [projectId, MILESTONE_ANNOUNCED_ACTION],
    ).some((row) => {
      try { return String((JSON.parse(String(row.details || "{}")) as { milestone?: unknown }).milestone || "") === milestone; } catch { return false; }
    });
    if (already) return null;
    addAuditLog(db, projectId, "system", "client-notifier", MILESTONE_ANNOUNCED_ACTION, { milestone });
    return notifyClientOfStatusChange(db, project, {
      outcome: milestone,
      statusLabel: PROJECT_MILESTONES.find((m) => m.key === milestone)?.label || milestone,
      // The final is the permit side's step; the PTO steps are the utility's.
      targetType: milestone === "final_passed" ? "permit" : "nem",
    });
  } catch (err) {
    logger.warn("notify", `client milestone update failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
