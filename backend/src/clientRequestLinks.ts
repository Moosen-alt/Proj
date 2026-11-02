// ---------------------------------------------------------------------------
// THE INTAKE LINK AND THE SECURE LOGIN LINK, EMAILED BY THE SERVER (#488, owner request #485).
//
// Both links already existed (intakeRequests.ts, credentialRequests.ts) and neither ever left the
// building on its own: when a NEM job sat waiting on the customer's bill or a portal question, or
// the client had no login for the utility's portal, a person minted the link and emailed it by
// hand. Each job lost a hand-off and often a day.
//
// WHEN. At the end of the automatic chain (autoStageSteps.processStageStep), when the project
// stopped where only the client can move it:
//   · INTAKE — the NEM application is waiting on the customer's utility bill (QC's own named wait,
//     a pending review item of WAITING_ON_BILL_ISSUE_TYPE), or the portal asks a per-job question
//     nobody has answered (unansweredPortalQuestions — a staging blocker). The link then also asks
//     the usual intake fields still missing (contract value, homeowner email/phone): they ride
//     along, but on their own they are callouts that hold nothing, so they never trigger a send.
//   · CREDENTIALS — the NEM track files on a known utility portal and the client has no stored
//     login whose URL fits it (the same host + jurisdiction-segment rule staging chooses logins by,
//     selectCredentialUrlsFor). A client with a stored login that carries no URL is NOT asked:
//     we cannot tell which portal it is for, and asking for a login they gave us is worse than
//     a person noticing.
// Only from qc_passed / ready_to_stage: a qc_failed job is held on staff first, and a person's
// repair re-runs the chain, which sends then.
//
// ONCE. One client_request_sends row per open ask (migration v54). While it is open, a re-run of
// the chain sends nothing. It closes when the need goes away; a need that comes back later is a
// new ask. At most ONE reminder, CLIENT_REQUEST_REMINDER_DAYS (default 2) after a send that
// actually left — a draft nobody received is not reminded. A credential ask is never sent while
// any unexpired request for that portal is already out (an operator may have sent one by hand).
//
// WHAT THE EMAIL CARRIES (rule 2). The link and a plain list of what is needed — labels only,
// never a value. Never a password, account or meter number: the bill line says we read those off
// the bill; the login line says to type it on our one-time page and never send it by email. Both
// bodies are passed through redactSecretValues with the project's own account/meter values as a
// last guard. The credential link keeps its one-time / 72h design; the stored copy of a SENT
// credential email masks the token (a draft keeps it, because a person must send that by hand).
// Logs and audit rows carry a masked recipient and no URL.
//
// WHO (rule 6). The recipient is the project's own client row (updates inbox, else business
// email — the clientNotifier rule) and the communication is stamped with the project's org.
//
// DELIVERY. SMTP_HOST + SMTP_FROM set → sent; otherwise recorded as a DRAFT communication exactly
// like clientNotifier. PUBLIC_BASE_URL unset → draft too: a link to localhost is not a link.
//
// SWITCHES. Per client: clients.request_links_auto_send = 'off'. Global: CLIENT_REQUEST_AUTO_SEND
// =off, and CLIENT_NOTIFICATIONS=off (the client-mail kill switch) silences this too.
// ---------------------------------------------------------------------------
import { randomUUID } from "node:crypto";
import type { AppDb, SqlParam } from "./db";
import type { ProjectRecord } from "../../shared/src/types";
import { redactSecretValues } from "../../shared/src/portalSafety";
import { addAuditLog } from "./audit";
import { BRAND } from "./clientUpdates";
import { formatProjectAddress, sendEmail, smtpConfigured } from "./clientNotifier";
import { addCommunication } from "./crm";
import { createCredentialRequest } from "./credentialRequests";
import { createIntakeRequest, missingIntakeFields, unansweredPortalQuestions, type IntakeField } from "./intakeRequests";
import { logger } from "./logger";
import { selectCredentialUrlsFor } from "./portalCredentials";
import { trackSafeUrl } from "./portalChannel";
import { WAITING_ON_BILL_ISSUE_TYPE } from "./qc";
import { getProjectDetail } from "./repository";
import { getSubmittalTracks, requiredTracks, trackHasFiling } from "./submittalTracks";

const ACTOR = "client-request-links";
/** Where the chain may have stopped for an ask to go out (see WHEN above). */
const HELD_STATUSES = new Set(["qc_passed", "ready_to_stage"]);
const INTAKE_LINK_DAYS = 30;

const INTAKE_FIELD_NEEDS: Record<IntakeField, string> = {
  jobValue: "The contract / installed cost of the system",
  homeownerEmail: "The homeowner's email address",
  homeownerPhone: "The homeowner's phone number",
};

export type Sender = (to: string, subject: string, body: string) => Promise<void>;

export interface ClientRequestOptions {
  now?: Date;
  /** Test seam: deliver through this instead of SMTP (and treat delivery as configured). */
  send?: Sender;
  /** Test seam: the NEM track's portal URL for this project ("" when none is known). */
  nemPortalUrl?: (db: AppDb, project: ProjectRecord) => string;
}

export function clientRequestAutoSendEnabled(): boolean {
  if (/^(0|false|off)$/i.test(String(process.env.CLIENT_NOTIFICATIONS ?? "").trim())) return false;
  return !/^(0|false|off)$/i.test(String(process.env.CLIENT_REQUEST_AUTO_SEND ?? "").trim());
}

/** CLIENT_REQUEST_REMINDER_DAYS, default 2; 0 turns the reminder off. */
export function clientRequestReminderDays(): number {
  const raw = String(process.env.CLIENT_REQUEST_REMINDER_DAYS ?? "").trim();
  if (raw === "") return 2;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 2;
}

/** a***@example.com — the only form a recipient takes in a log line or an audit row. */
export function maskRecipient(to: string): string {
  return String(to ?? "").replace(/(.).+(@.*)/, "$1***$2");
}

/** The stored copy of a sent credential email: the token is replaced, the rest stays readable. */
export function maskCredentialLinks(text: string): string {
  return String(text ?? "").replace(/(\/credentials\?token=)[A-Za-z0-9_-]+/g, "$1[hidden — one-time link, already sent]");
}

function publicBase(): string {
  return String(process.env.PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
}

interface ClientRow { company_name?: string; business_email?: string; updates_inbox?: string; request_links_auto_send?: string }

function clientRow(db: AppDb, clientId: string): ClientRow | null {
  return db.get<ClientRow>(
    "SELECT company_name, business_email, updates_inbox, request_links_auto_send FROM clients WHERE id = ?",
    [clientId],
  );
}

function recipientOf(c: ClientRow | null): string {
  return String(c?.updates_inbox || "").trim() || String(c?.business_email || "").trim();
}

function optedOut(c: ClientRow | null): boolean {
  return /^(0|false|off|no)$/i.test(String(c?.request_links_auto_send ?? "").trim());
}

/** Is the NEM application still to be filed on this project? */
function nemOpen(db: AppDb, project: ProjectRecord): boolean {
  const required = requiredTracks(project);
  return required.includes("nem") && !trackHasFiling(db, project.id, "nem", required);
}

// ---------------------------------------------------------------------------
// What the client is being asked for.
// ---------------------------------------------------------------------------

export interface IntakeNeeds {
  /** The NEM application waits on the bill for these (labels: "account number", "meter number"). */
  bill: string[];
  /** Portal per-job questions nobody has answered (labels). */
  questions: string[];
  /** The usual intake fields still missing — ride along only. */
  fields: IntakeField[];
}

export async function intakeNeedsFor(db: AppDb, project: ProjectRecord): Promise<IntakeNeeds> {
  const bill = nemOpen(db, project)
    ? db.query<{ field_name: string }>(
        "SELECT DISTINCT field_name FROM human_review_items WHERE project_id = ? AND status = 'pending' AND issue_type = ?",
        [project.id, WAITING_ON_BILL_ISSUE_TYPE],
      ).map((r) => (r.field_name === "meterNumber" ? "meter number" : "account number"))
    : [];
  let questions: string[] = [];
  try { questions = (await unansweredPortalQuestions(db, project)).map((q) => q.label).filter(Boolean); } catch { questions = []; }
  let fields: IntakeField[] = [];
  try { fields = missingIntakeFields(db, project.id); } catch { fields = []; }
  return { bill: [...new Set(bill)].sort(), questions, fields };
}

/** Held on the client: something that actually stops a filing (bill wait, portal question). */
export function intakeHeld(n: IntakeNeeds): boolean {
  return n.bill.length > 0 || n.questions.length > 0;
}

function intakeNeedLabels(n: IntakeNeeds): string[] {
  return [
    ...(n.bill.length ? ["A copy of the homeowner's most recent utility bill (photo or PDF)"] : []),
    ...n.questions.map((q) => `Your answer to the utility/permit portal's question: "${q}"`),
    ...n.fields.map((f) => INTAKE_FIELD_NEEDS[f]),
  ];
}

/** The NEM track's portal, as the track card resolves it (rule 5: a utility-track URL only). */
function defaultNemPortalUrl(db: AppDb, project: ProjectRecord): string {
  try {
    const nem = getSubmittalTracks(db, project).find((t) => t.type === "nem");
    if (!nem || nem.channelKind !== "portal") return "";
    return String(nem.recipePortalUrl ?? "").trim();
  } catch { return ""; }
}

/** True when the client holds a stored login that fits this portal — or one we cannot place. */
function clientHasLoginFor(db: AppDb, clientId: string, portalUrl: string): boolean {
  const stored = db.query<{ portal_url: string | null }>("SELECT portal_url FROM portal_credentials WHERE client_id = ?", [clientId])
    .map((r) => String(r.portal_url ?? "").trim());
  if (stored.some((u) => !u)) return true; // a login with no URL might be this one: never ask twice
  return selectCredentialUrlsFor(portalUrl, stored).length > 0;
}

interface CredentialRequestRow { id: string; token: string; portals_json: string; status: string; expires_at: string | null }

function credentialRequestRows(db: AppDb, clientId: string): CredentialRequestRow[] {
  try {
    return db.query<CredentialRequestRow>(
      "SELECT id, token, portals_json, status, expires_at FROM credential_requests WHERE client_id = ?",
      [clientId],
    );
  } catch { return []; } // credential_requests is created on first use (credentialRequests.ts)
}

function requestLive(r: CredentialRequestRow | undefined, now: Date): boolean {
  return Boolean(r) && r!.status === "pending" && !(r!.expires_at && Date.parse(r!.expires_at) < now.getTime());
}

function requestCovers(r: CredentialRequestRow, portalUrl: string): boolean {
  try {
    const portals = JSON.parse(r.portals_json || "[]") as Array<{ portalUrl?: string }>;
    return portals.some((p) => selectCredentialUrlsFor(portalUrl, [String(p.portalUrl ?? "")]).length > 0);
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// The emails.
// ---------------------------------------------------------------------------

function subjectFor(project: ProjectRecord, what: string, reminder: boolean): string {
  const address = formatProjectAddress(project);
  return [BRAND, `${reminder ? "Reminder: " : ""}${what}`, project.homeownerName, address || project.id]
    .map((p) => String(p || "").trim())
    .filter(Boolean)
    .join(" — ");
}

function scrub(project: ProjectRecord, text: string): string {
  return redactSecretValues(text, [String(project.accountNumber ?? ""), String(project.meterNumber ?? "")]);
}

export function intakeEmail(
  project: ProjectRecord,
  company: string,
  needs: IntakeNeeds,
  link: string,
  reminder = false,
): { subject: string; body: string } {
  const address = formatProjectAddress(project) || "this job";
  const lines = intakeNeedLabels(needs);
  const body = [
    `Hi${company ? ` ${company}` : ""},`,
    "",
    reminder
      ? `A reminder: the filing for ${address} is still waiting on the following from you.`
      : `To keep the filing for ${address} moving, we need the following from you:`,
    "",
    ...lines.map((l) => `  - ${l}`),
    "",
    ...(link ? [`Answer here (secure link, no login needed): ${link}`, ""] : []),
    ...(needs.bill.length
      ? [
          "Please send the bill to your Keelix coordinator the way you send plan sets. We read the account and meter numbers from the bill itself, so please do not type them into an email.",
          "",
        ]
      : []),
    "Thank you,",
    BRAND,
  ].join("\n");
  return { subject: scrub(project, subjectFor(project, "Information needed to file", reminder)), body: scrub(project, body) };
}

export function credentialEmail(
  project: ProjectRecord,
  company: string,
  portal: { label: string; url: string },
  link: string,
  expiresAt: string,
  reminder = false,
): { subject: string; body: string } {
  const address = formatProjectAddress(project) || "this job";
  let host = portal.url;
  try { host = new URL(portal.url).hostname; } catch { /* keep the URL as given */ }
  const body = [
    `Hi${company ? ` ${company}` : ""},`,
    "",
    reminder
      ? `A reminder: we still need your company's login for ${portal.label} (${host}) to file the interconnection application for ${address}.`
      : `We file the interconnection application for ${address} on ${portal.label} (${host}) under your company's login, and we do not have one on file for that portal.`,
    "",
    `Please enter it on this one-time secure page: ${link}`,
    `The page works once and expires ${expiresAt.slice(0, 10)}.`,
    "",
    "Never send a password by email, text or chat — that page is the only place to type it. We will never ask you to reply with it.",
    "",
    "Thank you,",
    BRAND,
  ].join("\n");
  return { subject: scrub(project, subjectFor(project, "Portal login needed to file", reminder)), body: scrub(project, body) };
}

// ---------------------------------------------------------------------------
// Delivery + record.
// ---------------------------------------------------------------------------

async function deliver(
  db: AppDb,
  input: { project: ProjectRecord; orgId: string; to: string; subject: string; body: string; storedBody: string; kind: string; reminder: boolean },
  opts: ClientRequestOptions,
): Promise<{ status: "sent" | "draft" | "failed"; detail: string }> {
  let status: "sent" | "draft" | "failed" = "draft";
  let detail = "";
  if (!publicBase()) {
    detail = "PUBLIC_BASE_URL is not set, so the link would point at this machine; nothing was sent. Set it, then send this by hand.";
  } else if (!opts.send && !smtpConfigured()) {
    detail = "SMTP is not configured (SMTP_HOST / SMTP_FROM are unset), so no send was attempted.";
  } else {
    try {
      await (opts.send ?? sendEmail)(input.to, input.subject, input.body);
      status = "sent";
    } catch (err) {
      status = "failed";
      detail = err instanceof Error ? err.message : String(err);
    }
  }
  addCommunication(db, {
    projectId: input.project.id,
    direction: "outbound",
    channel: "email",
    subject: input.subject,
    // A person sends a draft by hand, so it keeps the working link; a sent one keeps the masked copy.
    body: status === "sent" ? input.storedBody : input.body,
    loggedBy: `${ACTOR} (automated)`,
    deliveryStatus: status,
    deliveryDetail: detail,
    recipient: input.to,
    ...(input.orgId ? { orgId: input.orgId } : {}),
  });
  addAuditLog(db, input.project.id, "system", ACTOR, `client.${input.kind}_link_${input.reminder ? "reminder_" : ""}${status}`, {
    to: maskRecipient(input.to), ...(detail ? { detail: detail.slice(0, 200) } : {}),
  });
  const msg = `${input.kind} link ${input.reminder ? "reminder " : ""}${status} for project ${input.project.id} (to ${maskRecipient(input.to)})`;
  if (status === "sent") logger.info("client-requests", msg);
  else logger.warn("client-requests", `${msg}: ${detail}`);
  return { status, detail };
}

interface SendRow {
  id: string;
  kind: string;
  request_id: string;
  project_id: string;
  client_id: string;
  portal_url: string;
  recipient: string;
  sent_at: string;
  delivery_status: string;
  reminder_at: string;
}

function openAsks(db: AppDb, where: string, params: SqlParam[]): SendRow[] {
  return db.query<SendRow>(`SELECT * FROM client_request_sends WHERE closed_at = '' AND ${where}`, params);
}

function closeAsk(db: AppDb, id: string, now: Date): void {
  db.run("UPDATE client_request_sends SET closed_at = ? WHERE id = ?", [now.toISOString(), id]);
}

function recordAsk(
  db: AppDb,
  row: { kind: string; requestId: string; projectId: string; clientId: string; portalUrl?: string; to: string; needs: string[]; status: string },
  now: Date,
): void {
  db.run(
    `INSERT INTO client_request_sends (id, kind, request_id, project_id, client_id, portal_url, recipient, needs_json, sent_at, delivery_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), row.kind, row.requestId, row.projectId, row.clientId, row.portalUrl ?? "", row.to, JSON.stringify(row.needs), now.toISOString(), row.status],
  );
}

// ---------------------------------------------------------------------------
// The two entry points.
// ---------------------------------------------------------------------------

export interface AutoSendOutcome {
  sent: Array<{ kind: "intake" | "credentials"; status: string }>;
  closed: number;
  skipped?: string;
}

/**
 * End of the automatic chain: close asks whose need went away, then make and email any new ask.
 * Never throws — a mail problem must never fail the chain that called it.
 */
export async function autoSendClientRequests(db: AppDb, projectId: string, opts: ClientRequestOptions = {}): Promise<AutoSendOutcome> {
  const out: AutoSendOutcome = { sent: [], closed: 0 };
  try {
    if (!clientRequestAutoSendEnabled()) return { ...out, skipped: "auto-send is off" };
    const now = opts.now ?? new Date();
    const row = db.get<{ status?: string; archived_at?: string; client_id?: string; org_id?: string }>(
      "SELECT status, archived_at, client_id, org_id FROM projects WHERE id = ?", [projectId],
    );
    if (!row) return { ...out, skipped: "no such project" };
    const clientId = String(row.client_id ?? "");
    const project = getProjectDetail(db, projectId).project;
    const live = !String(row.archived_at ?? "").trim() && HELD_STATUSES.has(String(row.status ?? ""));

    // CLOSE what no longer applies, whatever else happens below — the banner must not keep saying
    // "sent" for a bill that has arrived. An intake ask closes when the job is no longer held on it;
    // a login ask when its request is spent/expired or the client now holds a fitting login.
    const intakeNeeds = live && clientId ? await intakeNeedsFor(db, project) : null;
    for (const ask of openAsks(db, "project_id = ? AND kind = 'intake'", [projectId])) {
      if (!intakeNeeds || !intakeHeld(intakeNeeds)) { closeAsk(db, ask.id, now); out.closed++; }
    }
    if (clientId) out.closed += closeSpentCredentialAsks(db, clientId, now);

    if (!live) return { ...out, skipped: "not held at a client-facing stop" };
    if (!clientId) return { ...out, skipped: "no client" };
    const client = clientRow(db, clientId);
    if (optedOut(client)) return { ...out, skipped: "client opted out" };
    const to = recipientOf(client);
    if (!to) return { ...out, skipped: "client has no updates inbox or business email" };
    const company = String(client?.company_name ?? "");
    const orgId = String(row.org_id ?? "");

    // INTAKE.
    if (intakeNeeds && intakeHeld(intakeNeeds) && openAsks(db, "project_id = ? AND kind = 'intake'", [projectId]).length === 0) {
      let link = "";
      let requestId = "";
      if (intakeNeeds.fields.length || intakeNeeds.questions.length) {
        const req = await createIntakeRequest(db, projectId, {
          ...(intakeNeeds.fields.length ? { fields: intakeNeeds.fields } : {}),
          createdBy: ACTOR,
          expiresInDays: INTAKE_LINK_DAYS,
        });
        requestId = req.id;
        link = `${publicBase()}${req.path}`;
      }
      const mail = intakeEmail(project, company, intakeNeeds, link);
      const sent = await deliver(db, { project, orgId, to, ...mail, storedBody: mail.body, kind: "intake", reminder: false }, opts);
      recordAsk(db, { kind: "intake", requestId, projectId, clientId, to, needs: intakeNeedLabels(intakeNeeds), status: sent.status }, now);
      out.sent.push({ kind: "intake", status: sent.status });
    }

    // CREDENTIALS (the utility's portal, NEM track only).
    if (nemOpen(db, project)) {
      const portalUrl = trackSafeUrl("nem", (opts.nemPortalUrl ?? defaultNemPortalUrl)(db, project));
      const askedAlready = portalUrl
        && (openAsks(db, "client_id = ? AND kind = 'credentials'", [clientId]).some((a) => selectCredentialUrlsFor(portalUrl, [a.portal_url]).length > 0)
          || credentialRequestRows(db, clientId).some((r) => requestLive(r, now) && requestCovers(r, portalUrl)));
      if (/^https?:\/\//i.test(portalUrl) && !askedAlready && !clientHasLoginFor(db, clientId, portalUrl)) {
        const label = `${String(project.utility || "the utility").trim()}'s interconnection portal`;
        const req = createCredentialRequest(db, clientId, [{ portalType: label, portalUrl }], { createdBy: ACTOR });
        const link = `${publicBase()}/credentials?token=${req.token}`;
        const mail = credentialEmail(project, company, { label, url: portalUrl }, link, req.expiresAt);
        const sent = await deliver(db, { project, orgId, to, ...mail, storedBody: maskCredentialLinks(mail.body), kind: "credentials", reminder: false }, opts);
        recordAsk(db, { kind: "credentials", requestId: req.id, projectId, clientId, portalUrl, to, needs: [`A login for ${label}`], status: sent.status }, now);
        out.sent.push({ kind: "credentials", status: sent.status });
      }
    }
    return out;
  } catch (err) {
    logger.warn("client-requests", `automatic client request failed for project ${projectId}: ${err instanceof Error ? err.message : String(err)}`);
    return { ...out, skipped: "error" };
  }
}

function closeSpentCredentialAsks(db: AppDb, clientId: string, now: Date): number {
  let closed = 0;
  const requests = new Map(credentialRequestRows(db, clientId).map((r) => [r.id, r]));
  for (const ask of openAsks(db, "client_id = ? AND kind = 'credentials'", [clientId])) {
    if (!requestLive(requests.get(ask.request_id), now) || clientHasLoginFor(db, clientId, ask.portal_url)) {
      closeAsk(db, ask.id, now);
      closed++;
    }
  }
  return closed;
}

/**
 * The one reminder: for each open ask whose first email actually left, CLIENT_REQUEST_REMINDER_DAYS
 * ago or more, re-check the need and send the same link once more — or close the ask if it is met.
 * Called from the monitor scheduler's tick. Never throws.
 */
export async function remindClientRequests(db: AppDb, opts: ClientRequestOptions = {}): Promise<{ reminded: number; closed: number }> {
  const result = { reminded: 0, closed: 0 };
  try {
    if (!clientRequestAutoSendEnabled()) return result;
    const days = clientRequestReminderDays();
    if (days <= 0) return result;
    const now = opts.now ?? new Date();
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
    const due = openAsks(db, "reminder_at = '' AND delivery_status = 'sent' AND sent_at <= ?", [cutoff]);
    for (const ask of due) {
      try {
        const row = db.get<{ status?: string; archived_at?: string; org_id?: string }>(
          "SELECT status, archived_at, org_id FROM projects WHERE id = ?", [ask.project_id],
        );
        const client = clientRow(db, ask.client_id);
        const to = recipientOf(client);
        const stillLive = Boolean(row) && !String(row?.archived_at ?? "").trim();
        if (!stillLive) { closeAsk(db, ask.id, now); result.closed++; continue; }
        if (optedOut(client) || !to) continue; // switched off since: no reminder, ask left as it was
        const project = getProjectDetail(db, ask.project_id).project;
        const company = String(client?.company_name ?? "");
        const orgId = String(row?.org_id ?? "");
        let sent: { status: string } | null = null;
        if (ask.kind === "intake") {
          const needs = HELD_STATUSES.has(String(row?.status ?? "")) ? await intakeNeedsFor(db, project) : null;
          if (!needs || !intakeHeld(needs)) { closeAsk(db, ask.id, now); result.closed++; continue; }
          let link = "";
          if (needs.fields.length || needs.questions.length) {
            // Reuses the pending request (same token) and refreshes what it asks.
            const req = await createIntakeRequest(db, ask.project_id, {
              ...(needs.fields.length ? { fields: needs.fields } : {}), createdBy: ACTOR, expiresInDays: INTAKE_LINK_DAYS,
            });
            link = `${publicBase()}${req.path}`;
          }
          const mail = intakeEmail(project, company, needs, link, true);
          sent = await deliver(db, { project, orgId, to, ...mail, storedBody: mail.body, kind: "intake", reminder: true }, opts);
        } else {
          const req = credentialRequestRows(db, ask.client_id).find((r) => r.id === ask.request_id);
          if (!requestLive(req, now) || clientHasLoginFor(db, ask.client_id, ask.portal_url)) { closeAsk(db, ask.id, now); result.closed++; continue; }
          const label = `${String(project.utility || "the utility").trim()}'s interconnection portal`;
          const link = `${publicBase()}/credentials?token=${req!.token}`;
          const mail = credentialEmail(project, company, { label, url: ask.portal_url }, link, String(req!.expires_at ?? ""), true);
          sent = await deliver(db, { project, orgId, to, ...mail, storedBody: maskCredentialLinks(mail.body), kind: "credentials", reminder: true }, opts);
        }
        db.run("UPDATE client_request_sends SET reminder_at = ?, reminder_status = ? WHERE id = ?", [now.toISOString(), sent.status, ask.id]);
        result.reminded++;
      } catch (err) {
        logger.warn("client-requests", `reminder failed for ask ${ask.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    logger.warn("client-requests", `client request reminders failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result;
}
