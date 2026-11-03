// ---------------------------------------------------------------------------
// THE INSTALLER HANDOFF, SENT BY THE SERVER (#491, closeout of #485).
//
// When every required filing is issued / approved, triggerHandoffIfReady (repository.ts) moves
// the project to handoff_ready and writes the installer checklist as a `handoff` note. Before this
// module that was where it stopped: the Next step said "send the installer the handoff packet" and
// a person had to notice, copy the packet and email it. The last hand-off before install waited on
// someone looking.
//
// Now the transition emails the submitting client's updates inbox (business email as fallback, the
// clientNotifier rule) the packet: what was approved with its reference numbers, the issued permit
// and the utility's approval letter attached when they are on file (handoffDocuments.ts), and the
// installer checklist — final inspection, then permission to operate.
//
// WHICH TEXT. The checklist below is the ONE copy: the `handoff` note the transition writes and
// this email both render installerHandoffChecklist. The dashboard's "Copy handoff packet"
// (repository.getProjectHandoffPacket) is the OPERATIONS packet — PM notes, blockers, the raw
// timeline — and is internal: clientUpdates.ts keeps pm_note out of every client channel, and
// this does too.
//
// ONCE PER HANDOFF. The automatic send happens on the transition only, and only when this handoff
// has no packet on record yet (installerHandoffRecords): a repeat "PTO granted" read cannot reach
// it (the writer returns early on a handed-off project and the trigger fires only on a
// transition). A project that left handoff_ready on a late correction and came back is a new
// handoff, and its installer hears about it again. The row is inserted synchronously
// before the first await, so two triggers in one process cannot both pass the check. A person can
// always send it again from the project page (POST /api/projects/:id/handoff-packet/send).
//
// SAFETY. Rule 2: no account or meter number, no credential in the body or the attachment list —
// the body carries the project's address, the agencies and the agencies' own reference numbers,
// and is then scrubbed with the project's own secret values (redactSecretValues), failing closed
// when they cannot be read; attachments are the issued documents only, under names we make. Rule
// 6: the recipient is the project's own client, read from the project row, and the communication
// row carries the project's org.
// ---------------------------------------------------------------------------
import type { AppDb } from "./db";
import type { ProjectRecord } from "../../shared/src/types";
import { addAuditLog } from "./audit";
import { addCommunication, undeliveredCommunications } from "./crm";
import {
  clientUpdatesSilenced, ensureStatusShareToken, formatProjectAddress, sendEmail, smtpConfigured, statusShareUrl,
} from "./clientNotifier";
import { BRAND, clientEmailSubject, clientFacingPermitType, clientPermitStructure, recordClientUpdateNote, type ClientUpdate } from "./clientUpdates";
import { mapEmailText, renderEmail, renderEmailText, type EmailContent } from "./emailLayout";
import { INSTALLER_HANDOFF_SENDER, installerHandoffAttachments } from "./handoffDocuments";
import { isNemApprovalOutcome, trackKind } from "./permitMonitor";
import { projectSecretValuesById } from "./projectSecrets";
import { redactSecretValues } from "../../shared/src/portalSafety";
import { text } from "./json";
import { logger } from "./logger";
import { nowIso } from "./time";

type Row = Record<string, unknown>;

/** The installer checklist — the ONE copy (see the header). The `handoff` note and the email
 *  both render it. Moved here from repository.ts unchanged. */
export function installerHandoffChecklist(project: ProjectRecord): string[] {
  const size = project.systemSizeDcKw ? `${project.systemSizeDcKw} kW DC` : "system";
  return [
    `PERMIT ISSUED — ${project.ahj || "AHJ"}: Download permit card and post at job site before work begins.`,
    `NEM APPROVED — ${project.utility || "Utility"}: Save the approval confirmation email/letter.`,
    `INSTALLATION: Install per the approved plans. Do not deviate from stamped set without re-permit.`,
    `RAPID SHUTDOWN: Label all rapid shutdown devices per approved plans before inspection.`,
    `FINAL INSPECTION: Schedule with ${project.ahj || "AHJ"}. Inspector will verify install matches approved plans.`,
    `AFTER INSPECTION PASSES: Send a copy of the signed final inspection card to ${project.utility || "the utility"} to trigger Permission to Operate (PTO).`,
    `PTO: Utility will issue PTO once inspection record is received. Timeline varies by utility.`,
    `SYSTEM SIZE: ${size} — verify AC output at inverter matches NEM application.`,
    project.interconnectionMethod ? `INTERCONNECTION: ${project.interconnectionMethod}` : "",
    `HOMEOWNER: Notify ${project.homeownerName || "homeowner"} that the system can be energized only after PTO is received.`,
  ].filter(Boolean);
}

/** The `handoff` note the transition writes (triggerHandoffIfReady). */
export function installerHandoffNoteBody(project: ProjectRecord): string {
  return [
    "✓ PERMIT ISSUED + NEM APPROVED — your submission scope is complete.",
    "",
    "Installer handoff checklist:",
    ...installerHandoffChecklist(project).map((line, i) => `${i + 1}. ${line}`),
    "",
    "No further action required from this platform unless a correction is received after final inspection.",
  ].join("\n");
}

/** The newest handoff email on record for each project's CURRENT handoff — what the Next step
 *  reads back and what the one-send check asks. "Current" is since the latest transition (the
 *  newest `handoff` note): a project that left handoff_ready on a late correction and came back
 *  is a new handoff, and its packet is news again; a repeat reading on a handed-off project is not
 *  a transition and changes nothing here. */
export interface InstallerHandoffRecord {
  deliveryStatus: string;
  at: string;
  recipient: string;
  detail: string;
}

export function installerHandoffRecords(db: AppDb, projectIds: string[]): Map<string, InstallerHandoffRecord> {
  const out = new Map<string, InstallerHandoffRecord>();
  if (!projectIds.length) return out;
  const ph = projectIds.map(() => "?").join(",");
  const since = new Map(db.query<Row>(
    `SELECT project_id, MAX(created_at) AS t FROM project_notes WHERE project_id IN (${ph}) AND note_type = 'handoff' GROUP BY project_id`,
    projectIds,
  ).map((r) => [text(r.project_id), text(r.t)] as const));
  const rows = db.query<Row>(
    `SELECT project_id, delivery_status, delivery_detail, occurred_at, created_at, recipient FROM communications
      WHERE project_id IN (${ph}) AND logged_by = ? AND direction = 'outbound' AND channel = 'email'
      ORDER BY occurred_at DESC, rowid DESC`,
    [...projectIds, INSTALLER_HANDOFF_SENDER],
  );
  for (const r of rows) {
    const pid = text(r.project_id);
    if (out.has(pid)) continue;
    // created_at, not occurred_at: a send re-stamps occurred_at, the row was made when it was made.
    if (text(r.created_at) < (since.get(pid) ?? "")) continue;
    out.set(pid, { deliveryStatus: text(r.delivery_status), at: text(r.occurred_at), recipient: text(r.recipient), detail: text(r.delivery_detail) });
  }
  return out;
}

/** The client's per-client opt-out (clients.handoff_auto_send = 'off'): staff send it by hand. */
export function clientHandoffAutoSendOff(db: AppDb, clientId: string | null | undefined): boolean {
  if (!clientId) return false;
  const row = db.get<{ handoff_auto_send?: string }>("SELECT handoff_auto_send FROM clients WHERE id = ?", [clientId]);
  return /^(0|false|off|no)$/i.test(text(row?.handoff_auto_send).trim());
}

/** What was approved, one line per finished filing, with the agency's own reference. */
function approvalLines(db: AppDb, project: ProjectRecord): { lines: string[]; permitCount: number } {
  const structure = clientPermitStructure(project);
  const rows = db.query<Row>(
    `SELECT target_type, permit_type, jurisdiction, portal_name, application_number, permit_number, latest_outcome
       FROM permit_check_targets WHERE project_id = ? AND active = 1 ORDER BY created_at ASC, rowid ASC`,
    [project.id],
  );
  const lines: string[] = [];
  let permitCount = 0;
  for (const r of rows) {
    const outcome = text(r.latest_outcome);
    const nem = trackKind(text(r.target_type), text(r.permit_type)) === "nem";
    const ref = text(r.permit_number) || text(r.application_number);
    if (nem) {
      if (!isNemApprovalOutcome(outcome)) continue;
      lines.push(`Interconnection — ${project.utility || text(r.jurisdiction) || "the utility"}: approved${ref ? `, application ${ref}` : ""}.`);
    } else {
      if (outcome !== "issued" && outcome !== "approved") continue;
      permitCount += 1;
      const kind = clientFacingPermitType(text(r.permit_type), structure).toLowerCase();
      const name = kind === "electrical" ? "Electrical permit"
        : kind === "building" || kind === "structural" ? "Building permit"
          : kind === "combo" ? "Combination building & electrical permit"
            : kind === "mpu" ? "Panel-upgrade permit" : "Permit";
      lines.push(`${name} — ${text(r.jurisdiction) || project.ahj || "the jurisdiction"}: ${outcome === "issued" ? "issued" : "approved"}${ref ? `, permit ${ref}` : ""}.`);
    }
  }
  return { lines, permitCount };
}

/** The client portal note: the same three lines every client update carries (clientUpdates.ts). */
function handoffClientUpdate(project: ProjectRecord, permitCount: number): ClientUpdate {
  const ahj = project.ahj || "the jurisdiction";
  const utility = project.utility || "the utility";
  return {
    subject: "Ready for install — handoff packet",
    headline: `${ahj} has issued ${permitCount > 1 ? "the permits" : "the permit"} and ${utility} has approved the interconnection, so the job is ready for install.`,
    meaning: "Our filing work on it is complete. The handoff packet — the approvals with their reference numbers, the issued documents we have on file and the steps to permission to operate — goes to your updates inbox by email.",
    action: "Schedule the install. After the final inspection passes, the utility issues permission to operate; the system stays off until then.",
  };
}

/**
 * The handoff email (pure: the preview and the tests render it without a database). The text twin
 * is the body the communication row stores; both parts render from the SCRUBBED content (rule 2),
 * and the text is scrubbed once more whole, as it always was. `rawSubject` / `rawBody` are the
 * unscrubbed text, for the audit's "was anything scrubbed" flag only — never sent or stored.
 */
export function installerHandoffEmail(input: {
  project: ProjectRecord;
  company: string;
  address: string;
  link: string;
  approved: string[];
  attachmentLabels: string[];
  update: ClientUpdate;
  secrets: string[];
}): { subject: string; body: string; html: string; rawSubject: string; rawBody: string } {
  const { project, update } = input;
  const hasIssuedPermit = input.attachmentLabels.includes("Issued permit");
  const rawSubject = clientEmailSubject(update.subject, text(project.homeownerName), input.address || project.id);
  const content: EmailContent = {
    audience: "client",
    preheader: update.headline,
    eyebrow: "Installer handoff",
    headline: update.subject,
    greeting: `Hi ${input.company || "there"},`,
    intro: [
      `Closeout for your solar project at ${input.address || "the project site"}:`,
      update.headline,
      // The portal note's meaning line says the packet "goes to your updates inbox by email";
      // inside that very email it points at what follows instead.
      "Our filing work on it is complete. Below are the approvals with their reference numbers, the issued documents we have on file and the steps to permission to operate.",
    ],
    sections: [
      { heading: "Approved", items: input.approved.length ? input.approved : ["The permit and the interconnection (see the status page for each filing)."] },
      {
        heading: "Documents",
        items: input.attachmentLabels.length
          ? input.attachmentLabels.map((label) => `${label} (attached)`)
          : ["None on file with us yet. The issued permit and the utility's approval are on each agency's record; we will send them once we have them."],
      },
      {
        paragraphs: [hasIssuedPermit
          ? "Conditions of approval are printed on the issued permit — read them before work starts."
          : `Conditions of approval are printed on the issued permit — download it from ${project.ahj || "the jurisdiction"}'s record and read them before work starts.`],
      },
      { heading: "Installer handoff checklist", items: installerHandoffChecklist(project), ordered: true },
    ],
    nextStep: update.action,
    action: { label: "View live status", textLabel: "Live status page (no login needed)", url: input.link },
    signoff: [`— ${BRAND} (automated update; reply to reach the team)`],
  };
  const scrub = (s: string): string => redactSecretValues(s, input.secrets);
  const rendered = renderEmail(mapEmailText(content, scrub));
  return {
    subject: scrub(rawSubject),
    body: scrub(rendered.text),
    html: rendered.html,
    rawSubject,
    rawBody: renderEmailText(content),
  };
}

export interface InstallerHandoffResult {
  /** sent | draft | failed when an email was recorded; skipped when nothing was. */
  deliveryStatus: "sent" | "draft" | "failed" | "skipped";
  /** Why nothing was recorded, or why the send failed. */
  detail: string;
  recipient: string;
  attachments: string[];
  /** For the route: the HTTP status a refused manual send answers with. */
  refusedStatus?: number;
}

const skip = (detail: string, refusedStatus = 409): InstallerHandoffResult =>
  ({ deliveryStatus: "skipped", detail, recipient: "", attachments: [], refusedStatus });

/**
 * Send (or draft) the installer handoff packet for a handed-off project. Never throws.
 *   trigger "automatic": the transition. Honours the per-client opt-out and sends only when this
 *     project has no handoff email on record yet.
 *   trigger "manual": a person pressed Send on the project page. Sends again whatever is on record.
 * Both honour clientUpdatesSilenced (CLIENT_NOTIFICATIONS=off, no client, archived) and refuse a
 *  project not at handoff_ready.
 */
export async function sendInstallerHandoff(
  db: AppDb,
  project: ProjectRecord,
  opts: { trigger: "automatic" | "manual"; actor?: string },
): Promise<InstallerHandoffResult> {
  try {
    // Read fresh: callers hold a record captured before the transition.
    const row = db.get<Row>("SELECT status, archived_at, client_id, org_id FROM projects WHERE id = ?", [project.id]);
    if (!row) return skip("Project not found.", 404);
    if (text(row.status) !== "handoff_ready") {
      return skip("The handoff packet goes out once the permit is issued and the interconnection approved — this project is not there yet.");
    }
    const clientId = text(row.client_id);
    // THE ONE "may this project talk to its client" answer every client update asks (#490):
    // CLIENT_NOTIFICATIONS=off, no submitting client, or an archived project.
    if (clientUpdatesSilenced(db, { id: project.id, clientId: clientId || null })) {
      return skip(/^(0|false|off)$/i.test(String(process.env.CLIENT_NOTIFICATIONS ?? "").trim())
        ? "Client emails are switched off on this server (CLIENT_NOTIFICATIONS=off)."
        : !clientId ? "This project has no submitting client to send the packet to." : "This project is archived.");
    }

    const prior = installerHandoffRecords(db, [project.id]).get(project.id);
    if (opts.trigger === "automatic") {
      if (prior) return skip("A handoff packet is already on record for this handoff.");
      if (clientHandoffAutoSendOff(db, clientId)) {
        addAuditLog(db, project.id, "system", "installer-handoff", "installer_handoff.auto_send_off", {});
        return skip("This client's handoff packets are sent by hand (automatic send is off).");
      }
    }

    const client = db.get<Row>("SELECT company_name, business_email, updates_inbox FROM clients WHERE id = ?", [clientId]);
    const to = text(client?.updates_inbox).trim() || text(client?.business_email).trim();
    if (!to) {
      addAuditLog(db, project.id, "system", "installer-handoff", "installer_handoff.no_recipient", { trigger: opts.trigger });
      return skip("The client has neither an updates inbox nor a business email — add one on the client record.");
    }
    // Rule 2, failing closed: no secret list, no packet.
    const secrets = projectSecretValuesById(db, project.id);
    if (!secrets) {
      addAuditLog(db, project.id, "system", "installer-handoff", "installer_handoff.refused_unscrubbed", { trigger: opts.trigger });
      return skip("The project's record could not be read to scrub account and meter numbers, so nothing was sent.", 500);
    }

    const { lines: approved, permitCount } = approvalLines(db, project);
    const attachments = installerHandoffAttachments(db, project.id);
    const address = formatProjectAddress(project);
    const link = statusShareUrl(ensureStatusShareToken(db, project.id));
    const update = handoffClientUpdate(project, permitCount);
    const { subject, body, html, rawSubject, rawBody } = installerHandoffEmail({
      project,
      company: text(client?.company_name),
      address,
      link,
      approved,
      attachmentLabels: attachments.map((a) => a.label),
      update,
      secrets,
    });

    // The client portal hears it once per handoff — a re-send is the same event.
    if (!prior) {
      try {
        recordClientUpdateNote(db, project.id, update);
      } catch (err) {
        logger.warn("handoff", `could not record the client note: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Recorded BEFORE the first await: this row is the one-send marker (see the header).
    const configured = smtpConfigured();
    const comm = addCommunication(db, {
      projectId: project.id,
      orgId: text(row.org_id) || undefined,
      direction: "outbound",
      channel: "email",
      subject,
      body,
      loggedBy: INSTALLER_HANDOFF_SENDER,
      deliveryStatus: configured ? "pending" : "draft",
      deliveryDetail: configured ? "" : "SMTP is not configured (SMTP_HOST / SMTP_FROM are unset), so no send was attempted.",
      recipient: to,
    });
    let deliveryStatus: "sent" | "draft" | "failed" = "draft";
    let detail = configured ? "" : "SMTP is not configured (SMTP_HOST / SMTP_FROM are unset), so no send was attempted.";
    if (configured) {
      try {
        await sendEmail(to, subject, body, attachments, { html });
        deliveryStatus = "sent";
      } catch (err) {
        deliveryStatus = "failed";
        detail = err instanceof Error ? err.message : String(err);
        logger.warn("handoff", `installer handoff send failed (${to}): ${detail}`);
      }
      db.run("UPDATE communications SET delivery_status = ?, delivery_detail = ?, occurred_at = ? WHERE id = ?",
        [deliveryStatus, detail, nowIso(), comm.id]);
    }
    addAuditLog(db, project.id, opts.trigger === "manual" ? "human" : "system", opts.actor || "installer-handoff",
      deliveryStatus === "sent" ? "installer_handoff.sent" : deliveryStatus === "draft" ? "installer_handoff.drafted" : "installer_handoff.failed", {
        trigger: opts.trigger,
        attachments: attachments.length,
        scrubbed: subject !== rawSubject || body !== rawBody,
        to: to.replace(/(.).+(@.*)/, "$1***$2"),
      });
    if (deliveryStatus !== "sent") {
      const stranded = undeliveredCommunications(db).length;
      logger.warn("handoff", `installer handoff NOT delivered (${deliveryStatus}) for project ${project.id}: ${detail} — ${stranded} message(s) now waiting. Run: npx tsx scripts/undelivered.ts`);
    }
    return { deliveryStatus, detail, recipient: to, attachments: attachments.map((a) => a.label) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn("handoff", `installer handoff failed: ${detail}`);
    return skip(`The handoff packet could not be built: ${detail}`, 500);
  }
}
