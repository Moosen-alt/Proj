// CORRECTION EMAILS THAT USED TO BE MISSED (#522). Through the REAL runEmailTracker on a scratch DB:
//
//   1. an AHJ information request that never says "correction" ("please upload the signed owner
//      form") opens a correction — status correction_received, the correction staff alert, the
//      client's "Correction requested" update — where it used to read needs_human_review;
//   2. a receipt whose only ask is conditional ("if additional information is needed…") still opens
//      nothing;
//   3. Portland's "Checksheet issued" letter is a correction, not a reported plan-review approval;
//   4. a correction email that matches NO job reaches the team as one staff alert (org-scoped, no
//      email text), and the next poll's re-read of the same message sends nothing more.
// Plus the pure ask predicate (emailAsksForInformation) on its edge shapes.
//   npx tsx backend/test/correctionEmails.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "correction-emails-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
for (const k of ["BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
process.env.CLIENT_NOTIFICATIONS = "1"; // drafted, never sent: no SMTP is configured
for (const k of ["SMTP_HOST", "SMTP_FROM", "ANTHROPIC_API_KEY", "STAFF_ALERT_TO", "STAFF_ALERT_WEBHOOK_URL"]) delete process.env[k];

const { openDatabase, DEFAULT_ORG_ID } = await import("../src/db");
const R = await import("../src/repository");
const { createClient } = await import("../src/clients");
const { emailAsksForInformation } = await import("../src/knowledgeBase");
const { senderDomain } = await import("../src/staffAlerts");

const db = await openDatabase();
let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const clientId = createClient(db, { companyName: "Probe Solar", businessEmail: "ops@probe.test", updatesInbox: "ops@probe.test" } as never).id;
let seq = 0;
const mkProject = (owner: string, street: string): string => {
  const pid = R.createProject(db, {
    owner, state: "OR", dcKw: "8.4", acKw: "7.7", permitPath: "prescriptive",
    street, city: "Coos Bay", zip: "97420", ahj: "City of Coos Bay", utility: "Pacific Power",
  } as never).project.id;
  db.run("UPDATE projects SET client_id = ?, status = 'submitted' WHERE id = ?", [clientId, pid]);
  return pid;
};
const mkPermitTarget = (pid: string, app: string): void => {
  R.createPermitCheckTarget(db, pid, { targetType: "permit", permitType: "building", jurisdiction: "City of Coos Bay", portalName: "X", portalUrl: "", applicationNumber: app } as never);
};
const status = (pid: string): string => String(db.get<{ status: string }>("SELECT status FROM projects WHERE id = ?", [pid])!.status);
const corrections = (pid: string) => db.query<{ id: string }>("SELECT id FROM corrections WHERE project_id = ?", [pid]);
const clientNotes = (pid: string): string[] => db.query<{ body: string }>("SELECT body FROM project_notes WHERE project_id = ? AND note_type = 'client_update'", [pid]).map((n) => n.body);
const staffRows = (kind: string) => db.query<{ org_id: string; project_id: string | null; ref: string; subject: string; body: string; delivery_status: string }>(
  "SELECT org_id, project_id, ref, subject, body, delivery_status FROM staff_notifications WHERE kind = ? ORDER BY rowid", [kind]);

/** One mbox file per delivery, read by its own tracking source — the scheduler's shape. */
const deliver = async (from: string, subject: string, body: string, file?: string) => {
  const target = file ?? path.join(tmp, `m${++seq}.mbox`);
  if (!file) fs.writeFileSync(target, `From x@y Mon Nov  2 10:0${seq % 10}:00 2026\nFrom: ${from}\nSubject: ${subject}\nDate: Mon, 2 Nov 2026 10:0${seq % 10}:00 -0800\n\n${body}\n`);
  const label = path.basename(target);
  const configured = R.configureEmailTrackingSource(db, { filePath: target, label });
  const source = configured.sources.find((s) => s.label === label)!;
  const run = await R.runEmailTracker(db, { sourceId: source.id });
  await sleep(250); // the client update and the staff alert are fire-and-forget
  return { run, file: target };
};

// ---------------------------------------------------------------------------------------------
// 0. The ask predicate.
// ---------------------------------------------------------------------------------------------
await check("emailAsksForInformation: a direct ask counts; a conditional or negated one does not", () => {
  for (const yes of [
    "Please upload the signed owner authorization form.",
    "Building permit 25-001234 - information needed",
    "We cannot process the application until it is provided.",
    "Your application has been placed on hold.",
    "Please upload it no later than Friday.",
    "Please resubmit the site plan; if you have questions, call us.",
    "Your application is incomplete.",
  ]) assert.equal(emailAsksForInformation(yes), true, yes);
  for (const no of [
    "If additional information is needed, we will contact you.",
    "No documents are missing from your submittal.",
    "Your application has been received and is under review.",
    "Should more information be required, the reviewer may reach out.",
    "",
  ]) assert.equal(emailAsksForInformation(no), false, no);
});

await check("senderDomain: the domain only, never the mailbox or display name", () => {
  assert.equal(senderDomain('"Permit Desk" <permits@CityOfSalem.net>'), "cityofsalem.net");
  assert.equal(senderDomain("noreply@portlandoregon.gov"), "portlandoregon.gov");
  assert.equal(senderDomain(""), "unknown sender");
});

// ---------------------------------------------------------------------------------------------
// 1. An information request that never says "correction" opens a correction.
// ---------------------------------------------------------------------------------------------
await check("a matched permit information request opens a correction, alerts staff and tells the client", async () => {
  const pid = mkProject("Info Probe", "12 Harbor View Rd");
  mkPermitTarget(pid, "25-001234");
  const { run } = await deliver(
    "permits@coosbay.example.gov",
    "Building permit 25-001234 - information needed",
    "Building permit 25-001234 for 12 Harbor View Rd, Coos Bay, OR 97420. Please upload the signed owner authorization form. We cannot process the application until it is provided.",
  );
  assert.equal(run.projectMatches, 1, JSON.stringify(run));
  assert.equal(run.matches[0].emailBucket, "missing_info_request", `bucket ${run.matches[0].emailBucket}`);
  assert.equal(corrections(pid).length, 1, "no correction was opened");
  assert.equal(status(pid), "correction_received");
  assert.equal(staffRows("correction").filter((r) => r.project_id === pid).length, 1, "no correction staff alert");
  assert.ok(clientNotes(pid).some((b) => /correction/i.test(b)), `client note: ${clientNotes(pid).join(" | ")}`);
});

// ---------------------------------------------------------------------------------------------
// 2. A receipt with a conditional ask opens nothing.
// ---------------------------------------------------------------------------------------------
await check("a receipt that only says 'if additional information is needed' opens no correction", async () => {
  const pid = mkProject("Receipt Probe", "34 Harbor View Rd");
  mkPermitTarget(pid, "25-005678");
  const { run } = await deliver(
    "permits@coosbay.example.gov",
    "Building permit 25-005678 received",
    "Your building permit application 25-005678 for 34 Harbor View Rd, Coos Bay, OR 97420 was received. If additional information is needed, we will contact you. Missing items may delay review.",
  );
  assert.equal(run.projectMatches, 1, JSON.stringify(run));
  assert.equal(corrections(pid).length, 0, `bucket ${run.matches[0].emailBucket} opened a correction`);
  assert.notEqual(status(pid), "correction_received");
  assert.ok(!clientNotes(pid).some((b) => /correction/i.test(b)), "the client was told of a correction");
});

// ---------------------------------------------------------------------------------------------
// 3. Portland's checksheet letter.
// ---------------------------------------------------------------------------------------------
await check("a Portland 'Checksheet issued' email is a correction, not a reported approval", async () => {
  const pid = mkProject("Checksheet Probe", "56 Harbor View Rd");
  mkPermitTarget(pid, "25-123456-RS");
  const { run } = await deliver(
    "noreply@portlandoregon.example.gov",
    "Checksheet issued for permit 25-123456-RS",
    "A checksheet has been issued for your residential solar permit 25-123456-RS at 56 Harbor View Rd, Coos Bay, OR 97420. Please log in to DevHub to respond.",
  );
  assert.equal(run.projectMatches, 1, JSON.stringify(run));
  assert.equal(run.matches[0].emailBucket, "permit_correction", `bucket ${run.matches[0].emailBucket}`);
  assert.equal(corrections(pid).length, 1, "no correction was opened");
  assert.equal(status(pid), "correction_received");
  const unconfirmed = db.query("SELECT id FROM human_review_items WHERE project_id = ? AND field_name = 'permit_status_unconfirmed'", [pid]);
  assert.equal(unconfirmed.length, 0, "the checksheet was queued as a reported approval");
});

// ---------------------------------------------------------------------------------------------
// 4. A correction email that matches no job.
// ---------------------------------------------------------------------------------------------
await check("an unmatched correction email reaches staff once, org-scoped, with no email text", async () => {
  const before = staffRows("unmatched_email").length;
  const first = await deliver(
    '"Plan Review" <plans@springfield.example.gov>',
    "Plan review comments - Jane Nobody, permit 99-887766",
    "Plan review comments for the solar permit of Jane Nobody at 9 Nowhere Ln, Springfield. Please revise the one-line diagram and resubmit. Account 1234567890.",
  );
  assert.equal(first.run.projectMatches, 0, JSON.stringify(first.run));
  assert.equal(first.run.unmatchedMessages, 1);
  const rows = staffRows("unmatched_email");
  assert.equal(rows.length, before + 1, "no unmatched-email alert was recorded");
  const alert = rows[rows.length - 1];
  assert.equal(alert.org_id, DEFAULT_ORG_ID);
  assert.equal(alert.project_id, null);
  assert.equal(alert.delivery_status, "off", "no channel is configured, so it is recorded off");
  assert.match(alert.body, /springfield\.example\.gov/);
  for (const leak of ["Jane", "Nobody", "Nowhere", "99-887766", "1234567890", "plans@", "one-line"]) {
    assert.ok(!alert.subject.includes(leak) && !alert.body.includes(leak), `the alert carries "${leak}"`);
  }
  // The scheduler re-reads the inbox every tick: the same message must not alert again.
  await deliver("", "", "", first.file);
  assert.equal(staffRows("unmatched_email").length, before + 1, "the re-read alerted again");
});

await check("an unmatched email that is not a correction (a plain status update) alerts nobody", async () => {
  const before = staffRows("unmatched_email").length;
  const { run } = await deliver(
    "permits@springfield.example.gov",
    "Permit application received",
    "Your solar permit application for 7 Elsewhere Ct, Springfield was received and is under review.",
  );
  assert.equal(run.projectMatches, 0);
  assert.equal(staffRows("unmatched_email").length, before, "a status update alerted staff");
});

if (failures) {
  console.error(`FAIL - correctionEmails: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("correctionEmails: all checks passed");
process.exit(0);
