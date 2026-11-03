// EMAIL PREVIEW (#589): every email template, rendered from SYNTHETIC data, written as files.
//
//   npx tsx scripts/email-preview.ts [--out <folder>] [--contact <footer address>]
//
// Writes <name>.html (what an inbox renders) and <name>.txt (the plain-text twin, which is also
// what the communication / staff alert row stores) for every template, plus index.html linking
// them all, and prints the paths. --out defaults to a fresh temp folder.
//
// IT NEVER SENDS ANYTHING. No transport is created: the builders are called directly and their
// output written to disk. SMTP_* and the staff alert channels are deleted from this process's env
// before anything is imported, and the backend modules load inside a throwaway working folder with
// a throwaway database path (they resolve data folders off the working directory at import —
// backend/test/_isolate.ts), so a preview run cannot touch a real install's data.
//
// THE DATA IS INVENTED: "123 Example Way", "Avery Example", "Sunny Example Solar", example.com
// addresses, made-up reference numbers. No customer data is read.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const outDir = path.resolve(argValue("out") ?? fs.mkdtempSync(path.join(os.tmpdir(), "keelix-email-preview-")));
const contact = argValue("contact") ?? "filings@keelixautomation.com";

// ── isolation, BEFORE any backend import ─────────────────────────────────────────────────────
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "keelix-email-preview-sandbox-"));
for (const k of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM", "SMTP_FROM_NAME", "SMTP_SECURE",
  "STAFF_ALERT_TO", "STAFF_ALERT_WEBHOOK_URL", "WATCHDOG_ALERT_TO", "WATCHDOG_WEBHOOK_URL", "EMAIL_IMAP_HOST", "BRAND_NAME"]) delete process.env[k];
process.env.AUTOPILOT_DB_PATH = path.join(sandbox, "preview.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(sandbox, "project-documents");
process.env.PAGE_IMAGE_CACHE_DIR = path.join(sandbox, "page-images");
process.env.BACKUP_DIR = path.join(sandbox, "backups");
process.env.PORTAL_PROFILES_DIR = path.join(sandbox, "portal-profiles");
process.env.AUTOPILOT_STATE_DIR = path.join(sandbox, "state");
process.env.AUTOPILOT_LOG_FILE = "";
process.env.PUBLIC_BASE_URL = "https://app.keelix.example";
process.env.FILING_CONTACT_EMAIL = contact;
process.chdir(sandbox);
process.on("exit", () => {
  try { process.chdir(os.tmpdir()); } catch { /* ignore */ }
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* a leftover temp folder is harmless */ }
});

const layout = await import("../backend/src/emailLayout");
const updates = await import("../backend/src/clientUpdates");
const notifier = await import("../backend/src/clientNotifier");
const requests = await import("../backend/src/clientRequestLinks");
const intake = await import("../backend/src/emailIntake");
const handoff = await import("../backend/src/installerHandoff");
const staff = await import("../backend/src/staffAlerts");
const mailer = await import("./ops/mailer");
type AppDb = import("../backend/src/db").AppDb;
type ProjectRecord = import("../shared/src/types").ProjectRecord;
type ClientUpdate = import("../backend/src/clientUpdates").ClientUpdate;

// ── synthetic data ───────────────────────────────────────────────────────────────────────────
const project = {
  id: "preview-project-0001",
  projectAddress: "123 Example Way",
  city: "Portland",
  state: "OR",
  homeownerName: "Avery Example",
  ahj: "City of Example",
  utility: "Example Electric",
  systemSizeDcKw: 7.2,
  interconnectionMethod: "Load-side breaker",
} as unknown as ProjectRecord;
const company = "Sunny Example Solar";
const address = notifier.formatProjectAddress(project);
const statusLink = "https://app.keelix.example/status?token=example-status-token";
// clientUpdateFor asks the database only for the OTHER filings of the job; none here.
const noOtherFilings = { query: () => [], get: () => undefined, run: () => undefined } as unknown as AppDb;

const files: Array<{ name: string; title: string; subject: string; html: string; text: string }> = [];
function add(name: string, title: string, mail: { subject: string; html: string; text: string }): void {
  files.push({ name, title, ...mail });
}

// Client status notices — the real wording (clientUpdates.clientUpdateFor).
const notices: Array<[string, string, string, Record<string, string>]> = [
  ["client-permit-issued", "Client: permit issued", "issued", { targetType: "permit", permitType: "electrical", permitNumber: "EX-ELEC-0001" }],
  ["client-permit-ready-for-issue", "Client: permit ready for issue", "ready_for_issue", { targetType: "permit", permitType: "building", permitNumber: "EX-BLD-0002" }],
  ["client-nem-approved", "Client: interconnection approved", "nem_approved", { targetType: "nem", applicationNumber: "EX-NEM-0003" }],
  ["client-correction-requested", "Client: correction requested", "correction_flagged", { targetType: "permit", permitType: "building", permitNumber: "EX-BLD-0002" }],
  ["client-permit-filed", "Client: permit application filed", "filed", { targetType: "permit", permitType: "building", applicationNumber: "EX-BLD-0002" }],
  ["client-nem-filed", "Client: interconnection application filed", "filed", { targetType: "nem", applicationNumber: "EX-NEM-0003" }],
  ["client-final-passed", "Client: final inspection passed", "final_passed", { targetType: "permit" }],
  ["client-pto-requested", "Client: permission to operate requested", "pto_requested", { targetType: "nem" }],
  ["client-pto-granted", "Client: permission to operate granted", "pto_granted", { targetType: "nem" }],
];
for (const [name, title, outcome, ctx] of notices) {
  const update = updates.clientUpdateFor(noOtherFilings, project, outcome, ctx as never) as ClientUpdate;
  const { subject, body, html } = notifier.clientUpdateNotice(update, {
    company, homeownerName: String(project.homeownerName), address, fallbackRef: project.id, statusLine: outcome, link: statusLink,
  });
  add(name, title, { subject, html, text: body });
}

// The asks only the client can answer (clientRequestLinks).
const needs = { bill: ["account number", "meter number"], questions: ["Is there a second meter on the property?"], fields: ["jobValue", "homeownerEmail"] as never[], heldFields: [] };
const intakeLink = "https://app.keelix.example/intake?token=00000000-0000-4000-8000-000000000000";
for (const [name, title, reminder] of [["client-intake-request", "Client: information needed", false], ["client-intake-reminder", "Client: information reminder", true]] as const) {
  const m = requests.intakeEmail(project, company, needs, intakeLink, reminder);
  add(name, title, { subject: m.subject, html: m.html, text: m.body });
}
const portal = { label: "Example Electric's interconnection portal", url: "https://interconnect.example-electric.example/apply" };
const credLink = "https://app.keelix.example/credentials?token=ExampleOneTimeToken";
for (const [name, title, reminder] of [["client-login-request", "Client: portal login needed", false], ["client-login-reminder", "Client: portal login reminder", true]] as const) {
  const m = requests.credentialEmail(project, company, portal, credLink, "2026-11-06T17:00:00.000Z", reminder);
  add(name, title, { subject: m.subject, html: m.html, text: m.body });
}

// The email-intake reply (emailIntake).
for (const [name, title, attached] of [["client-intake-reply-new", "Client: email intake reply (new project)", false], ["client-intake-reply-attached", "Client: email intake reply (files added)", true]] as const) {
  const m = intake.intakeReplyEmail({
    project, attached, link: statusLink,
    missing: attached ? [] : ["The customer's utility bill (PDF or photo)", "Permitting jurisdiction (AHJ)"],
    unsure: attached ? [] : ["System size (DC kW)"],
    refused: attached ? [] : [{ name: "site-plan.dwg", size: 1, refused: "A CAD drawing — please send it as a PDF." } as never],
    secrets: [],
  });
  add(name, title, { subject: m.subject, html: m.html, text: m.body });
}

// The installer handoff (installerHandoff).
{
  const update: ClientUpdate = {
    subject: "Ready for install — handoff packet",
    headline: "City of Example has issued the permit and Example Electric has approved the interconnection, so the job is ready for install.",
    meaning: "",
    action: "Schedule the install. After the final inspection passes, the utility issues permission to operate; the system stays off until then.",
  };
  const m = handoff.installerHandoffEmail({
    project, company, address, link: statusLink,
    approved: ["Building permit — City of Example: issued, permit EX-BLD-0002.", "Interconnection — Example Electric: approved, application EX-NEM-0003."],
    attachmentLabels: ["Issued permit", "Utility approval letter"],
    update, secrets: [],
  });
  add("client-installer-handoff", "Client: installer handoff packet", { subject: m.subject, html: m.html, text: m.body });
}

// Staff alerts (staffAlerts) — the content rules: address, track, reason in our own words.
const staffMails: Array<[string, string, ReturnType<typeof staff.staffAlertEmail>]> = [
  ["staff-run-failed", "Staff: run failed", staff.runAlertEmail({ address, projectId: project.id, track: "building", runStatus: "failed", why: 'Required field "Meter number" is blank on the application page.' })],
  ["staff-run-paused", "Staff: run paused", staff.runAlertEmail({ address, projectId: project.id, track: "nem", runStatus: "paused_for_human", why: "The portal asked for a verification code." })],
  ["staff-run-interrupted", "Staff: run interrupted", staff.runAlertEmail({ address, projectId: project.id, track: "electrical", runStatus: "interrupted", why: "the run's process went away; the portal may already hold a draft. Check the portal before staging this track again." })],
  ["staff-submit-unconfirmed", "Staff: submit not confirmed", staff.runAlertEmail({ address, projectId: project.id, track: "nem", runStatus: "submitted_unconfirmed", why: "automation clicked the final submit and the portal did not confirm the filing. Verify on the portal before anything is staged or clicked again." })],
  ["staff-corrections-requested", "Staff: corrections requested", staff.correctionAlertEmail({ address, projectId: project.id, track: "permit" })],
  ["staff-stage-held", "Staff: staging held", staff.stageHeldAlertEmail({ address, projectId: project.id, track: "building", why: "nothing was opened. Missing: Homeowner email (project). Fill it, or send the intake link, then stage again." })],
  ["staff-status-issued", "Staff: status changed (issued)", staff.statusAlertEmail({ address, projectId: project.id, track: "electrical", outcome: "issued" })],
  ["staff-unmatched-email", "Staff: unmatched correction email", staff.unmatchedEmailAlert({ domain: "example.gov", day: "2026-11-03", bucket: "permit_correction" })],
];
for (const [name, title, m] of staffMails) add(name, title, { subject: m.subject, html: m.html, text: m.body });
const day = new Date(2026, 10, 3, 7, 0, 0);
{
  const m = staff.staffDigestEmail([
    { id: "preview-project-0001", address, urgency: "overdue", headline: "Answer the correction notice" },
    { id: "preview-project-0002", address: "45 Sample Street, Salem, OR", urgency: "today", headline: "Stage the NEM application" },
    { id: "preview-project-0003", address: "9 Placeholder Lane, Eugene, OR", urgency: "waiting", headline: "Ask the client for the utility bill" },
  ], day);
  add("staff-morning-digest", "Staff: morning digest", { subject: m.subject, html: m.html, text: m.body });
  const empty = staff.staffDigestEmail([], day);
  add("staff-morning-digest-empty", "Staff: morning digest (nothing due)", { subject: empty.subject, html: empty.html, text: empty.body });
}

// Text-only senders: a re-sent stored message (sendEmail's fallback) and the ops mailer.
{
  const stored = [
    "Hi Sunny Example Solar,",
    "",
    "Update on your solar project at 123 Example Way, Portland, OR:",
    "",
    "City of Example has issued the electrical permit, reference EX-ELEC-0001.",
    "",
    "Live status page (no login needed): https://app.keelix.example/status?token=example-status-token",
    "",
    "— Keelix (automated update; reply to reach the team)",
  ].join("\n");
  add("fallback-resent-plain-text", "Any text-only email (a re-sent stored message)", {
    subject: "Keelix — Permit issued — Avery Example — 123 Example Way, Portland, OR",
    html: layout.wrapPlainText(stored, { subject: "Permit issued" }),
    text: stored,
  });
  const env = { SMTP_FROM: "filings@keelixautomation.example", FILING_CONTACT_EMAIL: contact } as NodeJS.ProcessEnv;
  const watchdog = mailer.opsMailOptions("ops@example.com", "[Solar Autopilot] PROBLEM: server", "PROBLEM: server\n  /health did not answer within 10 s (2 checks in a row).\n\nhttps://app.keelix.example/health", env);
  add("ops-watchdog-alert", "Ops: watchdog alert", { subject: watchdog.subject, html: watchdog.html, text: watchdog.text });
}

// ── write ────────────────────────────────────────────────────────────────────────────────────
fs.mkdirSync(outDir, { recursive: true });
const written: string[] = [];
for (const f of files) {
  const htmlPath = path.join(outDir, `${f.name}.html`);
  fs.writeFileSync(htmlPath, f.html);
  fs.writeFileSync(path.join(outDir, `${f.name}.txt`), `Subject: ${f.subject}\n\n${f.text}\n`);
  written.push(htmlPath);
}
const esc = layout.escapeHtml;
const index = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Keelix email preview</title></head>`
  + `<body style="font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;margin:24px;color:#091a1f;background:#ffffff;">`
  + `<h1 style="font-size:20px;">Keelix email preview</h1><p style="color:#415359;">Synthetic data only. Each template: the HTML an inbox renders, and its plain-text twin.</p><ul>`
  + files.map((f) => `<li style="margin:6px 0;"><a href="${esc(f.name)}.html">${esc(f.title)}</a> &middot; <a href="${esc(f.name)}.txt">text</a><br><span style="color:#415359;font-size:13px;">${esc(f.subject)}</span></li>`).join("")
  + `</ul></body></html>`;
const indexPath = path.join(outDir, "index.html");
fs.writeFileSync(indexPath, index);

console.log(`email-preview: ${files.length} templates rendered from synthetic data (nothing sent)`);
console.log(`  index      ${indexPath}`);
for (const p of written) console.log(`  ${p}`);
