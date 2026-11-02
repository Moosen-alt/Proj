// THE INSTALLER HANDOFF PACKET, SENT BY THE SERVER (#491).
//
// When the permit is issued and the interconnection approved, the project moves to handoff_ready
// and the server emails the submitting client the handoff packet — instead of the Next step asking
// a person to copy it into an email. Driven through the real write paths (createProject,
// createPermitCheckTarget, recordPermitStatusCheck); the one stand-in is a local SMTP listener on
// 127.0.0.1 that records what nodemailer hands it. No network leaves the machine.
//
//   ONE SEND     — the transition sends; a repeat "PTO granted" / "issued" read does not.
//   RECORD       — a communications row (draft with SMTP unset, sent with it) and one client_update
//                  note; the Next step reads "Handed off <date>" once sent.
//   SCRUB        — the project's account and meter numbers never reach the subject or body, even
//                  typed into a field that flows there; only issued documents are attached, under
//                  names we make; a row pointing outside the document store is never attached.
//   RESEND       — the operator's door sends again; a draft re-sent from the backlog keeps its docs.
//   OPT-OUT      — a client set to "staff send it by hand" gets nothing automatic.
//
//   npx tsx backend/test/installerHandoff.test.ts
import "./_isolate"; // FIRST: runs in a temp cwd
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "installer-handoff-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
for (const k of ["BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "AHJ_FORM_RESEARCH", "FEE_RESEARCH", "PORTAL_URL_RESEARCH", "RUN_TRIAGE"]) process.env[k] = "off";
process.env.PUBLIC_BASE_URL = "https://status.example.test";
delete process.env.CLIENT_NOTIFICATIONS;
delete process.env.SMTP_HOST;
delete process.env.SMTP_FROM;
delete process.env.SMTP_USER;
delete process.env.ANTHROPIC_API_KEY;

// ── a local SMTP listener: records each message's envelope recipient and raw DATA ──────────────
interface Mail { to: string; data: string }
const mails: Mail[] = [];
const smtp = net.createServer((sock) => {
  let buf = "";
  let inData = false;
  let to = "";
  let data = "";
  sock.write("220 test ESMTP\r\n");
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    for (;;) {
      if (inData) {
        const end = buf.indexOf("\r\n.\r\n");
        if (end < 0) return;
        data += buf.slice(0, end);
        buf = buf.slice(end + 5);
        inData = false;
        mails.push({ to, data });
        sock.write("250 queued\r\n");
        continue;
      }
      const nl = buf.indexOf("\r\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === "EHLO" || cmd === "HELO") sock.write("250-test\r\n250 OK\r\n");
      else if (cmd === "MAIL") sock.write("250 OK\r\n");
      else if (cmd === "RCPT") { to = (line.match(/<([^>]*)>/) ?? [])[1] ?? ""; sock.write("250 OK\r\n"); }
      else if (cmd === "DATA") { inData = true; data = ""; sock.write("354 go\r\n"); }
      else if (cmd === "QUIT") { sock.write("221 bye\r\n"); sock.end(); return; }
      else sock.write("250 OK\r\n");
    }
  });
  sock.on("error", () => { /* client hung up */ });
});
await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", () => resolve()));
const smtpPort = (smtp.address() as net.AddressInfo).port;
const smtpOn = (): void => {
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = String(smtpPort);
  process.env.SMTP_FROM = "keelix@example.test";
};
const smtpOff = (): void => { delete process.env.SMTP_HOST; delete process.env.SMTP_FROM; };
// The status-change notifier emails the same inbox ("Permit issued", "Interconnection approved");
// only the handoff packets are counted here.
const packets = (): Mail[] => mails.filter((m) => /Installer handoff checklist:/.test(m.data));

const { openDatabase } = await import("../src/db");
const { createClient, updateClient } = await import("../src/clients");
const { saveProjectDocument } = await import("../src/projectDocuments");
const R = await import("../src/repository");
const { computeNextStep } = await import("../src/nextStep");
const { sendInstallerHandoff } = await import("../src/installerHandoff");
const { INSTALLER_HANDOFF_SENDER } = await import("../src/handoffDocuments");
const { resendCommunication } = await import("../src/clientNotifier");
const { undeliveredCommunications } = await import("../src/crm");

const db = await openDatabase();
type Row = Record<string, unknown>;

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));

const ISSUED = "Permit issued. Download permit card from the portal.";
const NEM_APPROVED = "Interconnection application approved. Permission to operate granted.";
const ACCOUNT = "8812345670";
const METER = "M99887766";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

const handoffRows = (pid: string): Row[] => db.query<Row>(
  "SELECT * FROM communications WHERE project_id = ? AND logged_by = ? ORDER BY created_at ASC, rowid ASC", [pid, INSTALLER_HANDOFF_SENDER]);
const handoffNotes = (pid: string): Row[] => db.query<Row>(
  "SELECT * FROM project_notes WHERE project_id = ? AND note_type = 'client_update' AND body LIKE '%ready for install%'", [pid]);
const statusOf = (pid: string): string => String(db.get<Row>("SELECT status FROM projects WHERE id = ?", [pid])?.status ?? "");

let n = 0;
/** A Portland job (NEM + one combination permit) for a client with a shared updates inbox. */
const makeJob = (opts: { autoSend?: string; nemNumber?: string } = {}): { pid: string; permitTarget: string; nemTarget: string; inbox: string } => {
  n += 1;
  const inbox = `permits${n}@installer${n}.test`;
  const client = createClient(db, {
    companyName: `Handoff Solar ${n}`, ccbLicenseNumber: `55${n}000`,
    businessEmail: `office${n}@installer${n}.test`, businessPhone: "5035550100",
  });
  updateClient(db, client.id, { updatesInbox: inbox, ...(opts.autoSend !== undefined ? { handoffAutoSend: opts.autoSend } : {}) });
  const pid = R.createProject(db, {
    clientId: client.id, owner: `Handoff Owner ${n}`, street: `${100 + n} Closeout Way`, city: "Portland",
    state: "OR", zip: "97201", ahj: "Portland", utility: "PGE", dcKw: "8.6", acKw: "6.5", permitPath: "prescriptive",
  } as never).project.id;
  db.run("UPDATE projects SET account_number = ?, meter_number = ? WHERE id = ?", [ACCOUNT, METER, pid]);
  R.createPermitCheckTarget(db, pid, { jurisdiction: "Portland", applicationNumber: `COMBO-${n}`, permitType: "combo" } as never);
  const detail = R.createPermitCheckTarget(db, pid, { jurisdiction: "PGE", applicationNumber: opts.nemNumber ?? `NEM-${n}`, permitType: "nem", targetType: "nem" } as never);
  const byNumber = Object.fromEntries(detail.permitCheckTargets.map((t) => [t.applicationNumber, t.id]));
  return { pid, permitTarget: byNumber[`COMBO-${n}`], nemTarget: byNumber[opts.nemNumber ?? `NEM-${n}`], inbox };
};
const read = async (pid: string, targetId: string, text: string): Promise<void> => {
  await R.recordPermitStatusCheck(db, pid, { targetId, source: "manual", rawStatusText: text });
  await settle(5);
};
const handOff = async (job: { pid: string; permitTarget: string; nemTarget: string }): Promise<void> => {
  await read(job.pid, job.permitTarget, ISSUED);
  await read(job.pid, job.nemTarget, NEM_APPROVED);
};

try {
  // ═══ 1. SMTP UNSET: THE TRANSITION DRAFTS ONE PACKET ═══════════════════════════════════════
  smtpOff();
  // The account number typed in as the NEM application number — the leak path the scrub exists for.
  const a = makeJob({ nemNumber: "8812-345-670" });
  // On file: a utility bill (never attached) and the issued permit (attached).
  saveProjectDocument(db, a.pid, { docType: "utility_bill", filename: `bill-${ACCOUNT}.pdf`, contentType: "application/pdf", buffer: PDF });
  saveProjectDocument(db, a.pid, { docType: "issued_permit", filename: `Owner ${ACCOUNT} permit card.pdf`, contentType: "application/pdf", buffer: PDF });
  // A row claiming to be an issued permit whose file sits OUTSIDE the document store.
  const stray = path.join(tmpDir, "outside.pdf");
  fs.writeFileSync(stray, PDF);
  db.run(
    `INSERT INTO project_documents (id, project_id, doc_type, original_filename, stored_path, content_type, size_bytes, source, uploaded_by, uploaded_at)
     VALUES ('stray-doc', ?, 'utility_approval', 'outside.pdf', ?, 'application/pdf', ?, 'upload', '', ?)`,
    [a.pid, stray, PDF.length, new Date().toISOString()],
  );

  await read(a.pid, a.permitTarget, ISSUED);
  await check("1a. before the scope is complete, nothing is sent", () => {
    assert.notEqual(statusOf(a.pid), "handoff_ready");
    assert.equal(handoffRows(a.pid).length, 0);
  });
  await read(a.pid, a.nemTarget, NEM_APPROVED);
  await settle();
  const aRows = handoffRows(a.pid);
  await check("1b. THE HEADLINE: the transition to handoff_ready records ONE handoff email, as a draft (SMTP unset)", () => {
    assert.equal(statusOf(a.pid), "handoff_ready");
    assert.equal(aRows.length, 1, JSON.stringify(aRows.map((r) => r.subject)));
    assert.equal(aRows[0].delivery_status, "draft");
    assert.match(String(aRows[0].delivery_detail), /not configured/i);
    assert.equal(aRows[0].recipient, a.inbox, "the client's updates inbox, not the business email");
    assert.equal(aRows[0].direction, "outbound");
    assert.equal(aRows[0].channel, "email");
  });
  await check("1c. one client_update note, written on the transition", () => {
    assert.equal(handoffNotes(a.pid).length, 1);
  });
  const body = String(aRows[0]?.body ?? "");
  const subject = String(aRows[0]?.subject ?? "");
  await check("1d. the packet says what was approved, with the agency's reference, and what happens next", () => {
    assert.match(subject, /Ready for install/);
    assert.match(body, /Approved:/);
    assert.match(body, /Permit — Portland: issued, permit COMBO-1\./, body);
    assert.match(body, /Interconnection — PGE: approved/);
    assert.match(body, /Installer handoff checklist:/);
    assert.match(body, /FINAL INSPECTION: Schedule with Portland/);
    assert.match(body, /Permission to Operate \(PTO\)/);
    assert.match(body, /Live status page \(no login needed\): https:\/\/status\.example\.test\/status\?token=/);
  });
  await check("1e. the checklist is the SAME text the handoff note carries — one copy, not two", () => {
    const note = String(db.get<Row>("SELECT body FROM project_notes WHERE project_id = ? AND note_type = 'handoff'", [a.pid])?.body ?? "");
    const lines = note.split("\n").filter((l) => /^\d+\. /.test(l));
    assert.ok(lines.length >= 8, note);
    for (const l of lines) assert.ok(body.includes(l), `missing from the email: ${l}`);
  });
  await check("1f. RULE 2: the account and meter numbers reach neither subject nor body — even typed into a reference field", () => {
    for (const text of [subject, body]) {
      assert.doesNotMatch(text.replace(/\D/g, " "), /8812\s*345\s*670/, text);
      assert.ok(!text.includes(METER), text);
      assert.ok(!text.includes("8812-345-670"), text);
    }
    assert.match(body, /\[redacted\]/, "the typed-in account number is redacted, not dropped silently");
  });
  await check("1g. only the issued permit is listed as attached; the bill and the outside-the-store row are not", () => {
    assert.match(body, /- Issued permit \(attached\)/);
    assert.doesNotMatch(body, /Utility approval/i, "the stray row outside the document store was listed");
    assert.doesNotMatch(body, /bill/i);
  });
  await check("1h. the Next step asks a person to send it (draft), naming the Send button", () => {
    const step = computeNextStep(db, a.pid);
    assert.equal(step.key, "handoff_ready");
    assert.equal(step.button?.id, "sendHandoffPacketBtn");
    assert.match(step.headline, /send the installer the handoff packet/);
    assert.ok(step.why.some((w) => /drafted but was not sent/.test(w.text)), JSON.stringify(step.why));
  });
  await check("1i. the draft counts in the backlog (scripts/undelivered.ts)", () => {
    assert.ok(undeliveredCommunications(db).some((c) => c.projectId === a.pid && c.loggedBy === INSTALLER_HANDOFF_SENDER));
  });
  await check("1j. the communication row carries the project's org (rule 6)", () => {
    const org = db.get<Row>("SELECT org_id FROM projects WHERE id = ?", [a.pid])?.org_id;
    assert.equal(aRows[0].org_id, org);
  });

  // ═══ 2. A REPEAT READ DOES NOT RESEND ══════════════════════════════════════════════════════
  await read(a.pid, a.nemTarget, NEM_APPROVED);
  await read(a.pid, a.nemTarget, "Permission to operate granted. PTO letter issued.");
  await read(a.pid, a.permitTarget, ISSUED);
  await settle();
  await check("2. repeat 'PTO granted' / 'issued' reads on a handed-off project send nothing more", () => {
    assert.equal(statusOf(a.pid), "handoff_ready");
    assert.equal(handoffRows(a.pid).length, 1);
    assert.equal(handoffNotes(a.pid).length, 1);
  });

  // ═══ 3. THE DRAFT, RE-SENT FROM THE BACKLOG, KEEPS ITS DOCUMENTS ════════════════════════════
  smtpOn();
  mails.length = 0;
  const comm = undeliveredCommunications(db).find((c) => c.projectId === a.pid && c.loggedBy === INSTALLER_HANDOFF_SENDER)!;
  const resent = await resendCommunication(db, comm);
  await check("3. a drafted packet re-sent once mail is set up goes WITH the issued permit, under our file name", () => {
    assert.equal(resent.delivered, true, resent.detail);
    assert.equal(packets().length, 1);
    assert.equal(packets()[0].to, a.inbox);
    assert.match(packets()[0].data, /filename="?issued-permit-1\.pdf/);
    assert.ok(!packets()[0].data.includes(ACCOUNT), "an original file name carrying the account number was forwarded");
    assert.doesNotMatch(packets()[0].data, /utility-bill|outside\.pdf|utility-approval/);
  });

  // ═══ 4. SMTP SET: THE TRANSITION SENDS, THE NEXT STEP SAYS HANDED OFF ═══════════════════════
  mails.length = 0;
  const b = makeJob();
  saveProjectDocument(db, b.pid, { docType: "utility_approval", filename: "pto.pdf", contentType: "application/pdf", buffer: PDF });
  await handOff(b);
  await settle(400);
  await check("4a. the transition SENDS the packet to the client's updates inbox, with the approval letter", () => {
    const rows = handoffRows(b.pid);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].delivery_status, "sent", String(rows[0].delivery_detail));
    assert.equal(packets().length, 1, `packets: ${packets().length}`);
    assert.equal(packets()[0].to, b.inbox);
    assert.match(packets()[0].data, /filename="?utility-approval-1\.pdf/);
  });
  await check("4b. the Next step reads 'Handed off <date>' and asks nobody for anything", () => {
    const step = computeNextStep(db, b.pid);
    assert.equal(step.key, "handoff_ready");
    assert.equal(step.who, "nobody");
    assert.equal(step.urgency, "done");
    assert.match(step.headline, new RegExp(`^Handed off \\d{4}-\\d{2}-\\d{2} — the installer handoff packet went to ${b.inbox.replace(/\./g, "\\.")}`));
    assert.equal(step.button?.id, "sendHandoffPacketBtn", "the re-send stays offered");
  });

  // ═══ 5. THE OPERATOR'S RESEND ══════════════════════════════════════════════════════════════
  mails.length = 0;
  const again = await sendInstallerHandoff(db, R.getProjectDetail(db, b.pid).project, { trigger: "manual", actor: "ops@keelix.test" });
  await check("5. a person's Send sends again: a second communication, no second client note", () => {
    assert.equal(again.deliveryStatus, "sent", again.detail);
    assert.equal(handoffRows(b.pid).length, 2);
    assert.equal(packets().length, 1);
    assert.equal(handoffNotes(b.pid).length, 1);
    const audit = db.get<Row>("SELECT actor_name FROM audit_logs WHERE project_id = ? AND action = 'installer_handoff.sent' ORDER BY created_at DESC, rowid DESC LIMIT 1", [b.pid]);
    assert.ok(audit, "no installer_handoff.sent audit row");
  });

  // ═══ 6. PER-CLIENT OPT-OUT ═════════════════════════════════════════════════════════════════
  mails.length = 0;
  const c = makeJob({ autoSend: "off" });
  await handOff(c);
  await settle(300);
  await check("6a. a client set to 'staff send it by hand' gets nothing automatic — no email, no note", () => {
    assert.equal(statusOf(c.pid), "handoff_ready");
    assert.equal(handoffRows(c.pid).length, 0);
    assert.equal(handoffNotes(c.pid).length, 0);
    assert.equal(packets().length, 0);
  });
  await check("6b. …and the Next step still asks a person to send it", () => {
    const step = computeNextStep(db, c.pid);
    assert.equal(step.who, "me");
    assert.equal(step.button?.id, "sendHandoffPacketBtn");
  });
  const manual = await sendInstallerHandoff(db, R.getProjectDetail(db, c.pid).project, { trigger: "manual" });
  await check("6c. the person's Send works for an opted-out client, and writes the client note then", () => {
    assert.equal(manual.deliveryStatus, "sent", manual.detail);
    assert.equal(handoffRows(c.pid).length, 1);
    assert.equal(handoffNotes(c.pid).length, 1);
  });

  // ═══ 7. REFUSALS ═══════════════════════════════════════════════════════════════════════════
  const d = makeJob();
  await read(d.pid, d.permitTarget, ISSUED);
  const early = await sendInstallerHandoff(db, R.getProjectDetail(db, d.pid).project, { trigger: "manual" });
  await check("7a. a project not at handoff_ready is refused (409), and nothing is recorded", () => {
    assert.equal(early.deliveryStatus, "skipped");
    assert.equal(early.refusedStatus ?? 409, 409);
    assert.equal(handoffRows(d.pid).length, 0);
  });
  process.env.CLIENT_NOTIFICATIONS = "off";
  mails.length = 0;
  await read(d.pid, d.nemTarget, NEM_APPROVED);
  await settle(300);
  await check("7b. CLIENT_NOTIFICATIONS=off: the transition still happens, the email does not", () => {
    assert.equal(statusOf(d.pid), "handoff_ready");
    assert.equal(handoffRows(d.pid).length, 0);
    assert.equal(packets().length, 0);
  });
  delete process.env.CLIENT_NOTIFICATIONS;
} finally {
  smtp.close();
  db.close();
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
