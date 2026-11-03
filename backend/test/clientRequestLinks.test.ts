// THE INTAKE LINK AND THE SECURE LOGIN LINK, EMAILED BY THE SERVER (#488).
//
// When the automatic chain stops on something only the client can supply, the server makes the
// request and emails the client's inbox the link — ONCE per open ask, plus at most one reminder.
//
//   MUST PASS    — a NEM job waiting on the bill gets one intake email; a job whose client has no
//                  login for the utility portal gets one login-link email; the Next step names who
//                  it went to and when; the reminder goes once, on time, and not for a draft.
//   MUST NOT     — a second chain run sends again; an opted-out client is emailed; an email carries
//                  an account / meter number or a password; the stored copy of a SENT login email
//                  carries the one-time token; a met need keeps reading as an open ask.
//
// Synthetic data only. No network: delivery goes through the injected sender or stays a draft.
//   npx tsx backend/test/clientRequestLinks.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "client-request-links-"));
process.env.AUTOPILOT_DB_PATH = path.join(scratch, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";
process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "client-request-links-test-key-not-a-real-secret";
delete process.env.SMTP_HOST;
delete process.env.SMTP_FROM;
delete process.env.CLIENT_NOTIFICATIONS;
delete process.env.CLIENT_REQUEST_AUTO_SEND;
delete process.env.CLIENT_REQUEST_REMINDER_DAYS;
delete process.env.PUBLIC_BASE_URL;
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const { createClient, updateClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const { setPortalQuestionSource } = await import("../src/intakeRequests");
const { createPortalCredential } = await import("../src/portalCredentials");
const { WAITING_ON_BILL_ISSUE_TYPE } = await import("../src/qc");
const { computeNextStep } = await import("../src/nextStep");
const {
  autoSendClientRequests, remindClientRequests, intakeEmail, credentialEmail, maskCredentialLinks, intakeNeedsFor,
} = await import("../src/clientRequestLinks");
const { getProjectDetail } = await import("../src/repository");

let failures = 0;
const run = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const db = await openDatabase();

// Synthetic values a leak would be visible by. Not real numbers.
const ACCOUNT = "7700112233";
const METER = "M88001122";
const PORTAL = "https://interconnect.example-utility.test/apply/";
const noPortal = () => "";
const withPortal = () => PORTAL;

// The question bank is deterministic per test: none unless a test says so.
let bankQuestions: Array<{ key: string; label: string; options: string[] }> = [];
setPortalQuestionSource(() => bankQuestions);

const outbox: Array<{ to: string; subject: string; body: string }> = [];
const send = async (to: string, subject: string, body: string): Promise<void> => { outbox.push({ to, subject, body }); };

function makeClient(name: string, inbox: string) {
  const c = createClient(db, { companyName: name, ccbLicenseNumber: "999001", businessEmail: `office@${inbox}` });
  updateClient(db, c.id, { updatesInbox: `updates@${inbox}` } as never);
  return c;
}

let seq = 0;
function makeProject(clientId: string, extra: Record<string, unknown> = {}): string {
  seq++;
  const detail = createProject(db, {
    clientId, owner: `Synthetic Owner ${seq}`, street: `${100 + seq} Test Ln`, city: "Salem", state: "OR",
    ahj: "Salem", utility: "PGE", dcKw: "7", acKw: "5", interconnectionMethod: "Net metering", ...extra,
  });
  db.run("UPDATE projects SET status = 'ready_to_stage' WHERE id = ?", [detail.project.id]);
  return detail.project.id;
}

/** The QC wait on the bill, as QC files it (asserted present, filed here only if QC did not). */
function ensureBillWait(projectId: string): void {
  const n = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM human_review_items WHERE project_id = ? AND status = 'pending' AND issue_type = ?", [projectId, WAITING_ON_BILL_ISSUE_TYPE]);
  if (Number(n?.n ?? 0) > 0) return;
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO human_review_items (id, project_id, issue_type, field_name, status, created_at, updated_at) VALUES (?, ?, ?, 'accountNumber', 'pending', ?, ?)",
    [`hri-${projectId}`, projectId, WAITING_ON_BILL_ISSUE_TYPE, now, now],
  );
}

const sendsFor = (projectId: string) => db.query<{ kind: string; delivery_status: string; closed_at: string; reminder_at: string; sent_at: string }>(
  "SELECT * FROM client_request_sends WHERE project_id = ? ORDER BY sent_at", [projectId],
);
const commsFor = (projectId: string) => db.query<{ subject: string; body: string; delivery_status: string; recipient: string; org_id: string }>(
  "SELECT * FROM communications WHERE project_id = ? ORDER BY created_at", [projectId],
);

// ---------------------------------------------------------------------------------------------
const draftClient = makeClient("Draft Path Solar LLC", "draft.test");
const draftProject = makeProject(draftClient.id);
ensureBillWait(draftProject);

await run("a NEM job waiting on the bill is held on the client (QC's own named wait)", async () => {
  const needs = await intakeNeedsFor(db, getProjectDetail(db, draftProject).project);
  assert.deepEqual(needs.bill.length > 0, true, `no bill wait read: ${JSON.stringify(needs)}`);
});

await run("no SMTP, no PUBLIC_BASE_URL → one DRAFT intake email to the client's updates inbox, recorded as an ask", async () => {
  const out = await autoSendClientRequests(db, draftProject, { nemPortalUrl: noPortal });
  assert.deepEqual(out.sent, [{ kind: "intake", status: "draft" }], JSON.stringify(out));
  const comms = commsFor(draftProject).filter((c) => /Information needed/.test(c.subject));
  assert.equal(comms.length, 1, "one communication row");
  assert.equal(comms[0].delivery_status, "draft");
  assert.equal(comms[0].recipient, "updates@draft.test", "the updates inbox wins over the business email");
  assert.match(comms[0].body, /utility bill/i, "the bill is named as the thing needed");
  const asks = sendsFor(draftProject);
  assert.equal(asks.length, 1);
  assert.equal(asks[0].closed_at, "");
});

await run("MUST NOT: a second chain run sends nothing while the ask is open", async () => {
  const out = await autoSendClientRequests(db, draftProject, { nemPortalUrl: noPortal });
  assert.deepEqual(out.sent, [], JSON.stringify(out));
  assert.equal(sendsFor(draftProject).length, 1);
  assert.equal(commsFor(draftProject).filter((c) => /Information needed/.test(c.subject)).length, 1);
});

await run("the Next step names who it went to and when", () => {
  const step = computeNextStep(db, draftProject);
  const asks = step.clientAsks ?? [];
  assert.equal(asks.length, 1, `clientAsks on the answer: ${JSON.stringify(asks)}`);
  assert.equal(asks[0].recipient, "updates@draft.test");
  assert.equal(asks[0].deliveryStatus, "draft");
  assert.ok(asks[0].sentAt.length >= 10);
});

await run("MUST NOT: a draft nobody received is never reminded", async () => {
  const later = new Date(Date.now() + 10 * 86_400_000);
  const r = await remindClientRequests(db, { now: later, send });
  assert.equal(r.reminded, 0);
});

await run("a met need closes the ask: the bill arrived → the banner stops saying sent", async () => {
  db.run("UPDATE human_review_items SET status = 'resolved' WHERE project_id = ? AND issue_type = ?", [draftProject, WAITING_ON_BILL_ISSUE_TYPE]);
  const out = await autoSendClientRequests(db, draftProject, { nemPortalUrl: noPortal });
  assert.equal(out.sent.length, 0);
  assert.ok(out.closed >= 1, JSON.stringify(out));
  assert.notEqual(sendsFor(draftProject)[0].closed_at, "");
  assert.equal((computeNextStep(db, draftProject).clientAsks ?? []).length, 0);
});

// ---------------------------------------------------------------------------------------------
process.env.PUBLIC_BASE_URL = "https://keelix.example.test";
const sentClient = makeClient("Sent Path Solar LLC", "sent.test");
const sentProject = makeProject(sentClient.id, { account: ACCOUNT, meter: METER });
await run("fixture: the project carries the synthetic account / meter the scrub must keep out", () => {
  const p = getProjectDetail(db, sentProject).project;
  assert.equal(p.accountNumber, ACCOUNT);
  assert.equal(p.meterNumber, METER);
});

await run("a portal question nobody answered → the intake LINK is sent, and carries no account / meter number", async () => {
  // A hostile label: the scrub must hold even when the question text quotes the account.
  bankQuestions = [{ key: "ownershipModel", label: `Who owns the system on account ${ACCOUNT}?`, options: ["Customer-Owned", "Lease"] }];
  outbox.length = 0;
  const out = await autoSendClientRequests(db, sentProject, { nemPortalUrl: noPortal, send });
  bankQuestions = [];
  assert.deepEqual(out.sent, [{ kind: "intake", status: "sent" }], JSON.stringify(out));
  assert.equal(outbox.length, 1);
  const mail = outbox[0];
  assert.equal(mail.to, "updates@sent.test");
  assert.match(mail.body, /https:\/\/keelix\.example\.test\/intake\?token=[0-9a-f-]{36}/, "the absolute intake link");
  for (const text of [mail.subject, mail.body]) {
    assert.ok(!text.replace(/\D/g, "").includes(ACCOUNT), `account digits leaked: ${text}`);
    assert.ok(!text.includes(METER) && !text.includes("88001122"), `meter number leaked: ${text}`);
  }
  assert.doesNotMatch(mail.body, /reply with/i, "never asks the client to reply with a value");
  const comm = commsFor(sentProject).find((c) => /Information needed/.test(c.subject));
  assert.equal(comm?.delivery_status, "sent");
});

await run("the reminder: none before N days, one after, never a second", async () => {
  const sentAt = Date.parse(sendsFor(sentProject).find((a) => a.kind === "intake")!.sent_at);
  bankQuestions = [{ key: "ownershipModel", label: "Who owns the system?", options: ["Customer-Owned", "Lease"] }];
  outbox.length = 0;
  const early = await remindClientRequests(db, { now: new Date(sentAt + 1.5 * 86_400_000), send });
  assert.equal(early.reminded, 0, "no reminder at 1.5 days (default 2)");
  const due = await remindClientRequests(db, { now: new Date(sentAt + 2 * 86_400_000 + 60_000), send });
  assert.equal(due.reminded, 1, "one reminder just after 2 days");
  assert.equal(outbox.length, 1);
  assert.match(outbox[0].subject, /Reminder/);
  assert.match(outbox[0].body, /\/intake\?token=/, "the same link again");
  const again = await remindClientRequests(db, { now: new Date(sentAt + 9 * 86_400_000), send });
  assert.equal(again.reminded, 0, "at most one reminder");
  bankQuestions = [];
});

await run("CLIENT_REQUEST_REMINDER_DAYS moves the reminder", async () => {
  const c = makeClient("Reminder Days Solar LLC", "days.test");
  const p = makeProject(c.id);
  ensureBillWait(p);
  await autoSendClientRequests(db, p, { nemPortalUrl: noPortal, send });
  const sentAt = Date.parse(sendsFor(p)[0].sent_at);
  process.env.CLIENT_REQUEST_REMINDER_DAYS = "5";
  try {
    const at3 = await remindClientRequests(db, { now: new Date(sentAt + 3 * 86_400_000), send });
    assert.equal(at3.reminded, 0, "not at 3 days when set to 5");
    const at5 = await remindClientRequests(db, { now: new Date(sentAt + 5 * 86_400_000 + 60_000), send });
    assert.equal(at5.reminded, 1, "at 5 days");
  } finally { delete process.env.CLIENT_REQUEST_REMINDER_DAYS; }
});

// ---------------------------------------------------------------------------------------------
await run("MUST NOT: an opted-out client is not emailed", async () => {
  const c = makeClient("Opted Out Solar LLC", "optout.test");
  updateClient(db, c.id, { requestLinksAutoSend: "off" } as never);
  const p = makeProject(c.id);
  ensureBillWait(p);
  outbox.length = 0;
  const out = await autoSendClientRequests(db, p, { nemPortalUrl: withPortal, send });
  assert.deepEqual(out.sent, []);
  assert.equal(out.skipped, "client opted out");
  assert.equal(outbox.length, 0);
  assert.equal(sendsFor(p).length, 0);
});

await run("MUST NOT: an archived job, or one stopped at qc_failed, is not emailed", async () => {
  const c = makeClient("Not Held Solar LLC", "notheld.test");
  const archived = makeProject(c.id);
  ensureBillWait(archived);
  db.run("UPDATE projects SET archived_at = ? WHERE id = ?", [new Date().toISOString(), archived]);
  const failed = makeProject(c.id);
  ensureBillWait(failed);
  db.run("UPDATE projects SET status = 'qc_failed' WHERE id = ?", [failed]);
  outbox.length = 0;
  for (const p of [archived, failed]) {
    const out = await autoSendClientRequests(db, p, { nemPortalUrl: withPortal, send });
    assert.deepEqual(out.sent, [], `${p}: ${JSON.stringify(out)}`);
  }
  assert.equal(outbox.length, 0);
});

// ---------------------------------------------------------------------------------------------
const credClient = makeClient("Login Ask Solar LLC", "login.test");
const credProject = makeProject(credClient.id, { account: ACCOUNT, meter: METER });

await run("no login for the utility portal → one ONE-TIME login link; the stored copy masks the token", async () => {
  outbox.length = 0;
  const out = await autoSendClientRequests(db, credProject, { nemPortalUrl: withPortal, send });
  assert.deepEqual(out.sent.filter((x) => x.kind === "credentials"), [{ kind: "credentials", status: "sent" }], JSON.stringify(out));
  const logins = outbox.filter((m) => /Portal login needed/.test(m.subject));
  assert.equal(logins.length, 1, "one login email");
  const mail = logins[0];
  const token = /\/credentials\?token=([A-Za-z0-9]+)/.exec(mail.body)?.[1] ?? "";
  assert.ok(token.length >= 32, "the client receives the working one-time link");
  assert.match(mail.body, /never send a password by email/i);
  assert.ok(!mail.body.replace(/\D/g, "").includes(ACCOUNT), "no account number");
  const comm = commsFor(credProject).find((c) => /Portal login needed/.test(c.subject))!;
  assert.ok(!comm.body.includes(token), "the stored communication carries the token");
  assert.match(comm.body, /\[hidden/);
  const audit = db.query<{ action: string; details: string }>("SELECT action, details FROM audit_logs WHERE project_id = ? AND actor_name = 'client-request-links'", [credProject]);
  assert.ok(audit.some((a) => a.action === "client.credentials_link_sent" && a.details.includes("u***@login.test")), `audited with a masked recipient: ${JSON.stringify(audit)}`);
  assert.ok(!JSON.stringify(audit).includes(token), "the audit trail carries the token");
  assert.ok(!JSON.stringify(audit).includes("updates@login.test"), "the audit trail carries the unmasked recipient");
});

await run("MUST NOT: a second job for the same client and portal asks again", async () => {
  const second = makeProject(credClient.id);
  outbox.length = 0;
  const out = await autoSendClientRequests(db, second, { nemPortalUrl: withPortal, send });
  assert.deepEqual(out.sent.filter((s) => s.kind === "credentials"), []);
  assert.equal(outbox.filter((m) => /Portal login/.test(m.subject)).length, 0);
  assert.equal((computeNextStep(db, second).clientAsks ?? []).filter((a) => a.kind === "credentials").length, 1,
    "the other job's Next step shows the open login ask for its client");
});

await run("MUST NOT: a client that already holds a fitting login is asked; storing one closes the ask", async () => {
  createPortalCredential(db, credClient.id, { portalType: "PGE interconnection", portalUrl: PORTAL, username: "synthetic-user", password: "synthetic-not-real" });
  const out = await autoSendClientRequests(db, credProject, { nemPortalUrl: withPortal, send });
  assert.deepEqual(out.sent.filter((s) => s.kind === "credentials"), []);
  const open = db.query("SELECT * FROM client_request_sends WHERE client_id = ? AND kind = 'credentials' AND closed_at = ''", [credClient.id]);
  assert.equal(open.length, 0, "the login ask closed");
});

await run("MUST NOT: a permit-platform URL is never asked for on the NEM track (rule 5)", async () => {
  const c = makeClient("Rule Five Solar LLC", "rule5.test");
  const p = makeProject(c.id);
  outbox.length = 0;
  const out = await autoSendClientRequests(db, p, { nemPortalUrl: () => "https://aca-oregon.accela.com/oregon/", send });
  assert.deepEqual(out.sent.filter((s) => s.kind === "credentials"), [], JSON.stringify(out));
});

await run("content scrub: the email builders never carry the project's account / meter values", () => {
  const project = { ...getProjectDetail(db, credProject).project, accountNumber: ACCOUNT, meterNumber: METER };
  const a = intakeEmail(project, "Co", { bill: ["account number"], questions: [`Meter ${METER} location?`], fields: ["jobValue"] }, "https://x.test/intake?token=t");
  const b = credentialEmail(project, `Co ${ACCOUNT}`, { label: "PGE portal", url: PORTAL }, "https://x.test/credentials?token=abc", "2026-11-05T00:00:00Z");
  for (const t of [a.subject, a.body, b.subject, b.body]) {
    assert.ok(!t.replace(/\D/g, "").includes(ACCOUNT), `account leaked: ${t}`);
    assert.ok(!t.includes(METER), `meter leaked: ${t}`);
  }
  assert.equal(maskCredentialLinks("go: https://x.test/credentials?token=abcDEF123 now"), "go: https://x.test/credentials?token=[hidden — one-time link, already sent] now");
});

await run("CLIENT_NOTIFICATIONS=off silences it too", async () => {
  const c = makeClient("Kill Switch Solar LLC", "kill.test");
  const p = makeProject(c.id);
  ensureBillWait(p);
  process.env.CLIENT_NOTIFICATIONS = "off";
  try {
    const out = await autoSendClientRequests(db, p, { nemPortalUrl: withPortal, send });
    assert.deepEqual(out.sent, []);
  } finally { delete process.env.CLIENT_NOTIFICATIONS; }
});

// ── #551: a filing whose recipe types a missing intake field holds the job on the client ─────────
const recipes = await import("../src/portalRecipes");
const { intakeFieldsInGaps } = await import("../src/clientRequestLinks");

await run("intakeFieldsInGaps: project field gaps the form answers; the contract on either key; never a client field, a question or a document", () => {
  const gap = (kind: "field" | "question" | "document", key: string, where: "project" | "client" | "documents" | "portal_questions" = "project") =>
    ({ kind, key, label: key, fieldName: key, where, secret: false });
  assert.deepEqual(intakeFieldsInGaps([gap("field", "contractAmount"), gap("field", "jobValue"), gap("field", "homeownerPhone"), gap("field", "homeownerEmail")]).sort(),
    ["homeownerEmail", "homeownerPhone", "jobValue"]);
  assert.deepEqual(intakeFieldsInGaps([gap("field", "homeownerEmail", "client"), gap("question", "homeownerEmail", "portal_questions"),
    gap("document", "meter_photo", "documents"), gap("field", "inverterModel"), gap("field", "ccbLicenseNumber", "client")]), []);
});
const { updateProject } = await import("../src/repository");

await run("MUST NOT (unchanged): contract / email / phone missing with no recipe that types them sends nothing", async () => {
  db.run("DELETE FROM portal_recipes");
  const c = makeClient("No Recipe Solar LLC", "norecipe.test");
  const p = makeProject(c.id, { account: ACCOUNT, meter: METER }); // the bill is in: nothing else holds it
  const needs = await intakeNeedsFor(db, getProjectDetail(db, p).project);
  assert.ok(needs.fields.includes("homeownerEmail"), `fixture: the email must be missing (${JSON.stringify(needs.fields)})`);
  assert.deepEqual(needs.heldFields, [], JSON.stringify(needs));
  const out = await autoSendClientRequests(db, p, { nemPortalUrl: noPortal, send });
  assert.deepEqual(out.sent, [], JSON.stringify(out));
});

await run("a NEM recipe that types the homeowner email → held on the client → ONE intake link email; filling them closes the ask", async () => {
  db.run("DELETE FROM portal_recipes");
  const r = recipes.startPortalRecording(db, {
    scopeType: "utility", state: "OR", utility: "PGE", portalUrl: "https://pge.powerclerk.example/apply", portalPlatform: "powerclerk", createdBy: "test",
  });
  const fill = (label: string, field: string) => ({ action: "fill", selector: { label }, field, note: label });
  recipes.savePortalRecipeSteps(db, r.id, [
    fill("Customer Name", "homeownerName"), fill("Owner Email", "homeownerEmail"), fill("Owner Phone", "homeownerPhone"),
    { action: "stopForReview", selector: {} },
  ] as never, { status: "complete", notes: "Auto-learned and verified (high confidence)." });
  const c = makeClient("Recipe Hold Solar LLC", "recipehold.test");
  const p = makeProject(c.id, { account: ACCOUNT, meter: METER });
  const needs = await intakeNeedsFor(db, getProjectDetail(db, p).project);
  assert.equal(needs.bill.length + needs.questions.length, 0, `fixture: nothing else may hold it (${JSON.stringify(needs)})`);
  assert.deepEqual(needs.heldFields, ["homeownerEmail"], JSON.stringify(needs));
  outbox.length = 0;
  process.env.PUBLIC_BASE_URL = "https://keelix.example";
  try {
    const out = await autoSendClientRequests(db, p, { nemPortalUrl: noPortal, send });
    assert.deepEqual(out.sent, [{ kind: "intake", status: "sent" }], JSON.stringify(out));
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].to, "updates@recipehold.test");
    assert.match(outbox[0].body, /homeowner's email address/);
    assert.match(outbox[0].body, /homeowner's phone number/, "the missing phone still rides along");
    assert.match(outbox[0].body, /contract \/ installed cost/, "the missing contract cost still rides along");
    assert.match(outbox[0].body, /https:\/\/keelix\.example\/intake\?token=/, "the link is in the email");
    // Once, not per chain run.
    const again = await autoSendClientRequests(db, p, { nemPortalUrl: noPortal, send });
    assert.deepEqual(again.sent, [], JSON.stringify(again));
    // Filled (the installer answered the form): the ask closes on the next pass.
    updateProject(db, p, { homeownerEmail: "owner@example.test", homeownerPhone: "+1 555 0100" } as never);
    const after = await intakeNeedsFor(db, getProjectDetail(db, p).project);
    assert.deepEqual(after.heldFields, [], JSON.stringify(after));
    const closed = await autoSendClientRequests(db, p, { nemPortalUrl: noPortal, send });
    assert.equal(closed.closed, 1, JSON.stringify(closed));
    assert.equal(sendsFor(p).filter((a) => a.closed_at === "").length, 0, "the ask still reads open");
  } finally {
    delete process.env.PUBLIC_BASE_URL;
    db.run("DELETE FROM portal_recipes");
  }
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nclientRequestLinks: all checks passed");
process.exit(0);
