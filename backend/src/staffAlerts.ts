// ---------------------------------------------------------------------------
// STAFF ALERTS + THE MORNING "NEEDS YOU TODAY" EMAIL (#487).
//
// Clients hear about their jobs (clientNotifier.ts) and the ops watchdog shouts when the server is
// sick (scripts/ops/watchdog.ts), but nothing told the TEAM that a job had stopped on them: a
// staging run paused for MFA or a blank required field, a run that failed or was interrupted, a
// final-submit click the portal never confirmed, a correction matched from email, a filing whose
// status moved. On a shared server those jobs sit until somebody happens to open the dashboard.
//
// WHAT IS SENT
//   alerts   one short message per TRANSITION into a needs-a-person state, never per poll:
//              run      a stage run ended paused_for_human / failed / interrupted /
//                       submitted_unconfirmed (ref = run id; a run ends once)
//              correction  a correction notice was matched (ref = correction id)
//              status   a permit/NEM tracking target's outcome changed (ref = target id)
//              unmatched_email  a correction email matched no job (ref = the message's signature;
//                       no project, so the org is the inbox source's) (#522)
//              stage_held  the stage gate refused a filing before any browser opened: boxes its
//                       recipe types that the job has no value for, or a per-job question nobody
//                       answered (#445). No run row exists, so the run alert never fired (#551).
//                       ref = project + track, state = the gap keys, so a retry of the same
//                       refusal sends nothing and a changed set of gaps sends once more.
//            The dedupe is the newest staff_notifications row for (org, kind, ref): the same
//            state there means this transition was already handled, so a re-entered writer or a
//            re-poll sends nothing — the same idea as shouldNotifyClient, kept in the table so it
//            also survives a restart.
//   digest   once a day at STAFF_DIGEST_HOUR (server local time; unset = no digest): every open job whose next step
//            is the team's (decideNextStep's who === "me"), most urgent first, each with a link.
//
// HOW (staffAlertConfig.ts): the product's own SMTP settings + STAFF_ALERT_TO, and an optional
// STAFF_ALERT_WEBHOOK_URL in the watchdog's webhook shape (ntfy-style phone push). Unset = off.
// Every alert and digest is RECORDED (staff_notifications, migration v55) whether it went out,
// failed, or was off — "what did we fail to send" is a query, not a log search.
//
// SAFETY
//   Rule 2: the content is the project ADDRESS, the TRACK and a REASON only. No homeowner name, no
//   account/meter numbers, no credentials, no permit/application numbers, no raw portal text: the
//   status alert names the outcome in our own words (never the portal's label), and the one free
//   text that rides along — a run's own one-line reason — is scrubbed (scrubStaffText): first line
//   only, the project's known secrets redacted with the planner's redactSecretValues, URLs and
//   email addresses dropped, any bare run of 7+ digits masked, capped.
//   Rule 6: an alert goes only to its project's org's recipients; the digest of an org lists only
//   that org's projects. The default org's inbox is never another org's fallback.
//   No portal behaviour changes: everything here runs AFTER the writers commit, never throws into
//   them, and sends fire-and-forget.
// ---------------------------------------------------------------------------
import type { AppDb } from "./db";
import { DEFAULT_ORG_ID } from "./db";
import { id } from "./ids";
import { logger } from "./logger";
import { BRAND } from "./clientUpdates";
import { formatProjectAddress, sendEmail } from "./clientNotifier";
import { projectSecretValuesById } from "./projectSecrets";
import { redactSecretValues } from "../../shared/src/portalSafety";
import { configuredStaffOrgs, staffAlertChannels, staffDigestHour, type StaffAlertChannels } from "./staffAlertConfig";

export type StaffAlertKind = "run" | "correction" | "status" | "digest" | "unmatched_email" | "stage_held";

/** Stage-run endings that need a person. awaiting_human_submit (staged cleanly, waiting for
 *  review) is deliberately absent: it is the expected end of a run and the digest carries it. */
export const RUN_STATES_THAT_ALERT = ["paused_for_human", "failed", "interrupted", "submitted_unconfirmed"] as const;

/** Tracking outcomes that are NOT news for staff. "waiting" is the agency holding the ball;
 *  correction_flagged has its own alert (the correction), so a status alert would double it. */
const STATUS_OUTCOMES_SILENT = new Set(["waiting", "no_change", "correction_flagged", ""]);

/** Our own words for each outcome — never the portal's label, which is scraped text. */
const OUTCOME_PHRASE: Record<string, string> = {
  reviewed_by_ahj: "plan review is done",
  ready_for_issue: "ready for issue (a fee or pickup is likely due)",
  issued: "permit issued (book the install / hand off)",
  nem_approved: "interconnection approved (PTO path open)",
  needs_human_review: "a status reading needs a person to confirm it on the portal",
};

/** Is this tracking change one staff hear about? Change-only, like shouldNotifyClient. */
export function shouldAlertStaffOnStatus(outcome: string, previousOutcome: string | null | undefined): boolean {
  if (STATUS_OUTCOMES_SILENT.has(outcome)) return false;
  return outcome !== (previousOutcome || "");
}

/**
 * Make a free-text reason safe for an alert (rule 2). First line only, then: the project's own
 * secrets redacted (separators ignored, the planner's predicate), the value after a password /
 * secret / token / key word dropped, URLs and email addresses dropped, any bare run of 7+ digits masked (an account or meter number this project does not
 * know about yet), capped at 200 characters.
 */
export function scrubStaffText(raw: string, secrets: Iterable<string>): string {
  let s = String(raw ?? "").split(/\r?\n/)[0].replace(/\s+/g, " ").trim();
  s = redactSecretValues(s, secrets);
  // A credential this project does not hold as a field (a portal login echoed in an error): the
  // value after a password/secret/token/key word goes, whatever it looks like.
  s = s.replace(/\b(pass(?:word|wd|code)|pwd|secret|token|api[\s_-]?key)\b(\s*(?:is|was|[:=]))?\s*("[^"]*"|'[^']*'|\S+)/gi, "$1 [redacted]");
  s = s.replace(/\bhttps?:\/\/\S+/gi, "[link]");
  s = s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]");
  s = s.replace(/\d{7,}/g, "[number]");
  return s.length > 200 ? `${s.slice(0, 197)}...` : s;
}

function trackLabel(track: string): string {
  const t = String(track || "").trim().toLowerCase();
  if (!t || t === "permit") return "Permit";
  if (t === "nem" || t === "interconnection") return "NEM / interconnection";
  return `${t.charAt(0).toUpperCase()}${t.slice(1)} permit`;
}

export function projectLink(projectId: string): string {
  const base = (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4173}`).replace(/\/+$/, "");
  return `${base}/#/project/${encodeURIComponent(projectId)}`;
}

interface ProjectFacts { orgId: string; address: string; archived: boolean }
function projectFacts(db: AppDb, projectId: string): ProjectFacts | null {
  const row = db.get<{ org_id?: string; project_address?: string; city?: string; state?: string; archived_at?: string }>(
    "SELECT org_id, project_address, city, state, archived_at FROM projects WHERE id = ?", [projectId],
  );
  if (!row) return null;
  return {
    orgId: String(row.org_id || DEFAULT_ORG_ID),
    address: formatProjectAddress({ projectAddress: row.project_address || "", city: row.city || "", state: row.state || "" }) || projectId,
    archived: Boolean(String(row.archived_at || "").trim()),
  };
}

// ── delivery ────────────────────────────────────────────────────────────────────────────────

/** The webhook POST, in exactly the watchdog's shape (scripts/ops/mailer.ts postWebhook — the
 *  backend cannot import scripts/, which the server image does not ship; staffAlerts.test.ts pins
 *  the two against each other). */
export async function postStaffWebhook(url: string, format: "json" | "text", subject: string, body: string): Promise<void> {
  const asText = format === "text";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: asText ? { "Content-Type": "text/plain; charset=utf-8", Title: subject.replace(/[^\x20-\x7e]/g, "") } : { "Content-Type": "application/json" },
      body: asText ? body : JSON.stringify({ subject, text: body }),
      signal: ctrl.signal,
    });
    if (res.status >= 300) throw Object.assign(new Error(`HTTP ${res.status}`), { code: `HTTP_${res.status}` });
  } finally {
    clearTimeout(timer);
  }
}

/** Error CODE only — a mail server's or webhook's free text never lands in the table. */
function errorCode(err: unknown): string {
  const e = err as { code?: string; responseCode?: number; name?: string };
  return String(e?.code || (e?.responseCode ? `SMTP_${e.responseCode}` : e?.name === "AbortError" ? "TIMEOUT" : "ERROR"));
}

async function deliverToChannels(channels: StaffAlertChannels, subject: string, body: string): Promise<{ status: string; detail: string }> {
  const results: Array<{ channel: string; ok: boolean; detail: string }> = [];
  if (channels.emails.length) {
    try {
      await sendEmail(channels.emails.join(", "), subject, body);
      results.push({ channel: "email", ok: true, detail: "sent" });
    } catch (err) {
      results.push({ channel: "email", ok: false, detail: errorCode(err) });
    }
  }
  for (const [i, url] of channels.webhooks.entries()) {
    try {
      await postStaffWebhook(url, channels.webhookFormat, subject, body);
      results.push({ channel: channels.webhooks.length > 1 ? `webhook${i + 1}` : "webhook", ok: true, detail: "sent" });
    } catch (err) {
      results.push({ channel: channels.webhooks.length > 1 ? `webhook${i + 1}` : "webhook", ok: false, detail: errorCode(err) });
    }
  }
  const ok = results.filter((r) => r.ok).length;
  const status = ok === results.length ? "sent" : ok ? "partial" : "failed";
  return { status, detail: results.map((r) => `${r.channel}: ${r.detail}`).join("; ") };
}

// ── record + dedupe ─────────────────────────────────────────────────────────────────────────

interface StaffMessage {
  orgId: string;
  projectId: string | null;
  kind: StaffAlertKind;
  ref: string;
  state: string;
  subject: string;
  body: string;
}

/**
 * Claim this transition: null when the newest row for (org, kind, ref) already holds this state
 * (handled — a re-poll, a re-entered writer), else the new row's id. Synchronous on purpose:
 * better-sqlite3 runs it atomically on this process's one connection, so two writers racing on
 * the same transition cannot both claim it.
 */
function claim(db: AppDb, msg: StaffMessage, recipient: string, offStatus: string | null): string | null {
  const last = db.get<{ state?: string }>(
    "SELECT state FROM staff_notifications WHERE org_id = ? AND kind = ? AND ref = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    [msg.orgId, msg.kind, msg.ref],
  );
  if (last && String(last.state ?? "") === msg.state) return null;
  const rowId = id();
  db.run(
    `INSERT INTO staff_notifications (id, org_id, project_id, kind, ref, state, subject, body, recipient, delivery_status, delivery_detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [rowId, msg.orgId, msg.projectId, msg.kind, msg.ref, msg.state, msg.subject, msg.body, recipient,
      offStatus ?? "pending", offStatus ? "No staff alert channel is configured for this org (STAFF_ALERT_TO with SMTP, or STAFF_ALERT_WEBHOOK_URL)." : "",
      new Date().toISOString()],
  );
  return rowId;
}

/** Record, then send. Never throws: a delivery problem must never reach the writer that called. */
async function recordAndSend(db: AppDb, msg: StaffMessage): Promise<void> {
  try {
    const channels = staffAlertChannels(msg.orgId);
    const recipient = [...channels.emails, ...(channels.webhooks.length ? ["webhook"] : [])].join(", ");
    const on = channels.emails.length > 0 || channels.webhooks.length > 0;
    // OFF IS RECORDED TOO, once per transition: the table then answers "what would the team have
    // been told" for the weeks before somebody configured it, and turning alerts on later does not
    // replay a backlog of stale transitions.
    const rowId = claim(db, msg, recipient, on ? null : "off");
    if (!rowId || !on) return;
    const { status, detail } = await deliverToChannels(channels, msg.subject, msg.body);
    db.run(
      "UPDATE staff_notifications SET delivery_status = ?, delivery_detail = ?, sent_at = ? WHERE id = ?",
      [status, detail, status === "failed" ? null : new Date().toISOString(), rowId],
    );
    if (status === "sent") logger.info("staff-alert", `${msg.kind} alert sent (${msg.state})`, { projectId: msg.projectId });
    else logger.warn("staff-alert", `${msg.kind} alert NOT fully delivered (${status}): ${detail}`, { projectId: msg.projectId });
  } catch (err) {
    logger.warn("staff-alert", `staff alert failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Rows that did not reach every channel — failed, partial, or never tried because alerts were off. */
export function undeliveredStaffNotifications(db: AppDb, orgId: string | null): Array<{ id: string; kind: string; state: string; subject: string; deliveryStatus: string; deliveryDetail: string; createdAt: string }> {
  const rows = db.query<{ id: string; kind: string; state: string; subject: string; delivery_status: string; delivery_detail: string; created_at: string }>(
    `SELECT id, kind, state, subject, delivery_status, delivery_detail, created_at FROM staff_notifications
      WHERE delivery_status IN ('failed', 'partial', 'off')${orgId === null ? "" : " AND org_id = ?"}
      ORDER BY created_at`,
    orgId === null ? [] : [orgId],
  );
  return rows.map((r) => ({ id: r.id, kind: r.kind, state: r.state, subject: r.subject, deliveryStatus: r.delivery_status, deliveryDetail: r.delivery_detail, createdAt: r.created_at }));
}

function alertMessage(facts: ProjectFacts, projectId: string, track: string, what: string, why: string): { subject: string; body: string } {
  const subject = `${BRAND} — needs you: ${trackLabel(track)} ${what} — ${facts.address}`;
  const body = [
    facts.address,
    `Track: ${trackLabel(track)}`,
    `What happened: ${what}`,
    ...(why ? [`Why: ${why}`] : []),
    `Open the project: ${projectLink(projectId)}`,
  ].join("\n");
  return { subject, body };
}

// ── the three triggers ──────────────────────────────────────────────────────────────────────

const RUN_WHAT: Record<string, string> = {
  paused_for_human: "run paused for a person",
  failed: "run failed, nothing staged",
  interrupted: "run interrupted",
  submitted_unconfirmed: "submit clicked, portal did not confirm",
};
const RUN_FIXED_WHY: Record<string, string> = {
  interrupted: "the run's process went away; the portal may already hold a draft. Check the portal before staging this track again.",
  submitted_unconfirmed: "automation clicked the final submit and the portal did not confirm the filing. Verify on the portal before anything is staged or clicked again.",
};

/** A stage run ended. `reason` is the run's own one-line reason (its error_message); it is
 *  scrubbed before it goes anywhere. Returns the send so a test can await it; callers `void` it. */
export function alertStaffOnRunOutcome(
  db: AppDb,
  input: { projectId: string; runId: string; track: string; runStatus: string; reason: string },
): Promise<void> {
  try {
    if (!(RUN_STATES_THAT_ALERT as readonly string[]).includes(input.runStatus)) return Promise.resolve();
    const facts = projectFacts(db, input.projectId);
    if (!facts || facts.archived) return Promise.resolve();
    // Fail closed on secrets: an unreadable project row means no free text at all.
    const secrets = projectSecretValuesById(db, input.projectId);
    const why = RUN_FIXED_WHY[input.runStatus] ?? (secrets ? scrubStaffText(input.reason, secrets) : "");
    const { subject, body } = alertMessage(facts, input.projectId, input.track, RUN_WHAT[input.runStatus], why);
    return recordAndSend(db, { orgId: facts.orgId, projectId: input.projectId, kind: "run", ref: input.runId, state: input.runStatus, subject, body });
  } catch (err) {
    logger.warn("staff-alert", `run alert skipped: ${err instanceof Error ? err.message : String(err)}`);
    return Promise.resolve();
  }
}

/** A correction notice was matched (email or portal reading) and recorded. */
export function alertStaffOnCorrection(db: AppDb, input: { projectId: string; correctionId: string; track: string }): Promise<void> {
  try {
    const facts = projectFacts(db, input.projectId);
    if (!facts || facts.archived) return Promise.resolve();
    const { subject, body } = alertMessage(facts, input.projectId, input.track, "correction notice received",
      "the agency asked for changes. Triage it and draft the reply.");
    return recordAndSend(db, { orgId: facts.orgId, projectId: input.projectId, kind: "correction", ref: input.correctionId, state: "matched", subject, body });
  } catch (err) {
    logger.warn("staff-alert", `correction alert skipped: ${err instanceof Error ? err.message : String(err)}`);
    return Promise.resolve();
  }
}

const UNMATCHED_KIND: Record<string, string> = {
  permit_correction: "permit correction",
  nem_correction: "interconnection (NEM) correction",
  missing_info_request: "request for more information",
};

/** The sender's DOMAIN only ("portlandoregon.gov") — never the mailbox or display name. */
export function senderDomain(from: string): string {
  const all = String(from || "").match(/@([a-z0-9.-]+\.[a-z]{2,})/gi);
  return all?.length ? all[all.length - 1].slice(1).toLowerCase().replace(/\.+$/, "") : "unknown sender";
}

/**
 * A correction email from the tracking inbox matched no job (#522) — it used to be counted and
 * dropped. RULE 2 / no-homeowner-data: the alert carries the sender's domain, the date and the kind,
 * in our own words — never the subject, the body, an address or a record number. The team finds the
 * message in the inbox by sender and date. RULE 6: the org is the inbox SOURCE's (the tracker's
 * scope), never a guess. Deduped per message signature, so the next poll's re-read sends nothing.
 */
export function alertStaffOnUnmatchedCorrectionEmail(
  db: AppDb,
  input: { orgId: string; signature: string; from: string; receivedAt: string | null; bucket: string },
): Promise<void> {
  try {
    const domain = senderDomain(input.from);
    const day = String(input.receivedAt || "").slice(0, 10) || "unknown date";
    const kind = UNMATCHED_KIND[input.bucket] ?? "correction";
    const base = (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4173}`).replace(/\/+$/, "");
    const subject = `${BRAND} — needs you: a ${kind} email matched no job (${domain})`;
    const body = [
      `A ${kind} email came into the tracking inbox and could not be matched to any job.`,
      `From: ${domain}`,
      `Received: ${day}`,
      "Why: it named no address, record number, account or meter that a job holds.",
      "Next: find it in the tracking inbox by sender and date, open the job, and add the record or application number to its tracking so the next email matches on its own.",
      `Open ${BRAND}: ${base}/`,
    ].join("\n");
    return recordAndSend(db, { orgId: input.orgId || DEFAULT_ORG_ID, projectId: null, kind: "unmatched_email", ref: input.signature, state: "unmatched", subject, body });
  } catch (err) {
    logger.warn("staff-alert", `unmatched email alert skipped: ${err instanceof Error ? err.message : String(err)}`);
    return Promise.resolve();
  }
}

/** One gap the stage gate named — the shape of RecipeStageGap this needs: our own words for the
 *  field (fieldName), never the portal's recorded label, and never a value (there is none). */
export interface StageHeldGap { kind: string; key: string; fieldName: string; where?: string }

const STAGE_GAP_WHERE: Record<string, string> = {
  project: "project", client: "client record", documents: "documents", portal_questions: "portal questions",
};

/**
 * The stage gate refused a filing (#445) — before any browser opened, so no run row and no run
 * alert. RULE 2: each gap is named by its fieldName (our words: "Homeowner email", "CCB / contractor
 * licence number", a secret's fixed label), never by the step's recorded portal text, and carries no
 * value. Deduped per project + track on the sorted gap keys. Callers `void` it.
 */
export function alertStaffOnStageHeld(
  db: AppDb,
  input: { projectId: string; track: string; gaps: StageHeldGap[] },
): Promise<void> {
  try {
    const gaps = (input.gaps ?? []).filter((g) => g && g.key);
    if (!gaps.length) return Promise.resolve();
    const facts = projectFacts(db, input.projectId);
    if (!facts || facts.archived) return Promise.resolve();
    const state = [...new Set(gaps.map((g) => `${g.kind}:${g.key}`))].sort().join(",");
    const secrets = projectSecretValuesById(db, input.projectId) ?? [];
    const names = [...new Set(gaps.map((g) => {
      const where = STAGE_GAP_WHERE[String(g.where ?? "")];
      return `${String(g.fieldName || g.key)}${where ? ` (${where})` : ""}`;
    }))];
    const why = scrubStaffText(`nothing was opened. Missing: ${names.join("; ")}. Fill ${names.length === 1 ? "it" : "them"}, or send the intake link, then stage again.`, secrets);
    const { subject, body } = alertMessage(facts, input.projectId, input.track, "staging held, details missing", why);
    const track = String(input.track || "permit");
    return recordAndSend(db, { orgId: facts.orgId, projectId: input.projectId, kind: "stage_held", ref: `${input.projectId}:${track}`, state, subject, body });
  } catch (err) {
    logger.warn("staff-alert", `stage-held alert skipped: ${err instanceof Error ? err.message : String(err)}`);
    return Promise.resolve();
  }
}

/** A tracking target's outcome changed. `outcome` is what was WRITTEN (a refused reading arrives
 *  as needs_human_review), never what the page said. */
export function alertStaffOnStatusChange(
  db: AppDb,
  input: { projectId: string; targetId: string; track: string; outcome: string; previousOutcome: string },
): Promise<void> {
  try {
    if (!shouldAlertStaffOnStatus(input.outcome, input.previousOutcome)) return Promise.resolve();
    const facts = projectFacts(db, input.projectId);
    if (!facts || facts.archived) return Promise.resolve();
    const phrase = OUTCOME_PHRASE[input.outcome] ?? input.outcome.replace(/_/g, " ");
    const { subject, body } = alertMessage(facts, input.projectId, input.track, "status changed", phrase);
    // ref: the target (a project has one per filing). No target (an email with no filing to bind
    // to) dedupes per project + track.
    const ref = input.targetId || `${input.projectId}:${input.track || "permit"}`;
    return recordAndSend(db, { orgId: facts.orgId, projectId: input.projectId, kind: "status", ref, state: input.outcome, subject, body });
  } catch (err) {
    logger.warn("staff-alert", `status alert skipped: ${err instanceof Error ? err.message : String(err)}`);
    return Promise.resolve();
  }
}

// ── the morning digest ──────────────────────────────────────────────────────────────────────

const URGENCY_ORDER: Record<string, number> = { overdue: 0, today: 1, waiting: 2, done: 3 };
const URGENCY_HEADING: Record<string, string> = { overdue: "OVERDUE", today: "TODAY", waiting: "WHEN YOU CAN" };

/** The server's local calendar date, YYYY-MM-DD — the digest's dedupe ref. */
export function localDateKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * The digest for ONE org: its open (unarchived) projects whose next step is the team's, most
 * urgent first. Built from the project list's own next-step answer (getProjectList runs
 * loadNextStepFacts + decideNextStep per row — the same rule table the dashboard shows), scoped
 * by org at the query, so another org's job cannot appear.
 */
export async function buildStaffDigest(db: AppDb, orgId: string, now: Date = new Date()): Promise<{ subject: string; body: string; count: number }> {
  // Dynamic: repository imports this module (the jobQueue/repository circular-import guard).
  const { getProjectList } = await import("./repository");
  const items: Array<{ id: string; address: string; urgency: string; headline: string }> = [];
  for (let offset = 0; ; offset += 500) {
    const page = getProjectList(db, { orgId, includeArchived: false, limit: 500, offset, sort: "created_desc" });
    for (const p of page.projects) {
      const step = p.nextStep;
      if (!step || step.who !== "me" || step.urgency === "done") continue;
      const secrets = projectSecretValuesById(db, p.id);
      items.push({
        id: p.id,
        address: formatProjectAddress(p) || p.id,
        urgency: step.urgency,
        headline: secrets ? scrubStaffText(step.headline, secrets) : "",
      });
    }
    if (page.projects.length < 500) break;
  }
  items.sort((a, b) => (URGENCY_ORDER[a.urgency] ?? 9) - (URGENCY_ORDER[b.urgency] ?? 9) || a.address.localeCompare(b.address));
  const date = localDateKey(now);
  const subject = items.length
    ? `${BRAND} — ${items.length} job${items.length === 1 ? "" : "s"} need${items.length === 1 ? "s" : ""} you today (${date})`
    : `${BRAND} — nothing needs you today (${date})`;
  const lines: string[] = [items.length ? `${items.length} job(s) whose next step is ours, most urgent first.` : "No open job is waiting on the team this morning."];
  let heading = "";
  for (const it of items) {
    const h = URGENCY_HEADING[it.urgency] ?? it.urgency.toUpperCase();
    if (h !== heading) { lines.push("", h); heading = h; }
    lines.push(`- ${it.address}: ${it.headline || "open the project"}`, `  ${projectLink(it.id)}`);
  }
  return { subject, body: lines.join("\n"), count: items.length };
}

/**
 * Send today's digest to every configured org whose digest is due: the hour has come (server local
 * time) and today's row is not there yet. Idempotent per org per day through the same claim the
 * alerts use (kind digest, ref = local date). Never throws.
 */
export async function sendStaffDigestsIfDue(db: AppDb, now: Date = new Date()): Promise<string[]> {
  const sent: string[] = [];
  try {
    const hour = staffDigestHour();
    if (hour === null || now.getHours() < hour) return sent;
    const date = localDateKey(now);
    for (const orgId of configuredStaffOrgs()) {
      // Cheap pre-check before building: the digest reads every project of the org.
      const done = db.get("SELECT 1 FROM staff_notifications WHERE org_id = ? AND kind = 'digest' AND ref = ? LIMIT 1", [orgId, date]);
      if (done) continue;
      const { subject, body } = await buildStaffDigest(db, orgId, now);
      await recordAndSend(db, { orgId, projectId: null, kind: "digest", ref: date, state: "digest", subject, body });
      sent.push(orgId);
    }
  } catch (err) {
    logger.warn("staff-alert", `morning digest failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return sent;
}

/** Check every 5 minutes whether the morning digest is due. Mirrors the other schedulers
 *  (setInterval + unref, BACKGROUND_WORKERS=off means off). */
export function startStaffDigestScheduler(db: AppDb): void {
  if (process.env.BACKGROUND_WORKERS === "off") return;
  const hour = staffDigestHour();
  if (hour === null || !configuredStaffOrgs().length) {
    logger.info("staff-alert", `Morning digest off (${hour === null ? "STAFF_DIGEST_HOUR is off" : "no staff alert channel configured"}).`);
    return;
  }
  logger.info("staff-alert", `Morning digest on: ${String(hour).padStart(2, "0")}:00 server time.`);
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try { await sendStaffDigestsIfDue(db); } finally { running = false; }
  };
  setTimeout(() => void tick(), 60_000).unref();
  setInterval(() => void tick(), 5 * 60_000).unref();
}
