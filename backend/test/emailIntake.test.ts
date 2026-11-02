// EMAIL-IN INTAKE (#489): a job emailed to intake+<client tag>@… becomes a parsed project.
//
//   MUST PASS    — a known sender's plan set + bill to their client's tag creates ONE project under
//                  that client and org, with both files in their slots, the chain queued, and a
//                  reply to the From address carrying the status link and what is missing; the same
//                  address again within the window ATTACHES instead; a refused file is reported and
//                  the others still land; the unsorted list is per org and a row outside it is a 404.
//   MUST NOT     — a message re-read by the next poll makes a second project; an unknown sender, an
//                  unknown or missing tag, a DMARC fail (or, with EMAIL_INTAKE_REQUIRE_AUTH on, no
//                  passing result in the topmost Authentication-Results) or a plan set licensed to another client is
//                  filed on any client; mail to any other address is touched; the reply or the stored
//                  communication carries the account or meter number; the email body reaches the
//                  model; a low-confidence field is written to the project.
//
// Synthetic data only: example.test domains, made-up numbers. No network: the model read and the
// mail send are injected.
//   npx tsx backend/test/emailIntake.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "email-intake-"));
process.env.AUTOPILOT_DB_PATH = path.join(scratch, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";
process.env.EMAIL_INTAKE_ADDRESS = "intake@keelix.example.test";
process.env.PUBLIC_BASE_URL = "https://keelix.example.test";
delete process.env.SMTP_HOST;
delete process.env.SMTP_FROM;
delete process.env.CLIENT_NOTIFICATIONS;
delete process.env.EMAIL_INTAKE_AUTO_REPLY;
delete process.env.EMAIL_INTAKE_REQUIRE_AUTH;
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase, DEFAULT_ORG_ID } = await import("../src/db");
const { createClient, updateClient } = await import("../src/clients");
const {
  processIntakeMessages, listEmailIntake, emailIntakeFile, dismissEmailIntake, mboxMessages, payloadFromExtraction,
  intakeTagFrom, senderIsKnown, intakeReplyEmail, PARSER_PROJECT_FIELDS,
} = await import("../src/emailIntake");
const { REPO } = await import("./_isolate");
const { writeMboxMessage } = await import("../src/mbox");
const { PDFDocument, StandardFonts } = await import("pdf-lib");
const { default: MailComposer } = await import("nodemailer/lib/mail-composer/index.js");

let failures = 0;
const run = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.stack || err.message : String(err)}`); }
};

const db = await openDatabase();
const ORG_B = "org-intake-b";
db.run("INSERT INTO orgs (id, name, edition, created_at) VALUES (?, ?, 'full', ?)", [ORG_B, ORG_B, new Date().toISOString()]);

const ACCOUNT = "4455667788";
const METER = "Z99887766";

const acme = createClient(db, { companyName: "Acme Synthetic Solar", businessEmail: "office@acme.example.test", intakeTag: "Acme" });
updateClient(db, acme.id, { updatesInbox: "updates@acme.example.test", intakeSenders: "pm@acme-partner.example.test, @acme.example.test" });
const rival = createClient(db, { companyName: "Rival Synthetic Solar", businessEmail: "office@rival.example.test", intakeTag: "rival" });
const orgBClient = createClient(db, { companyName: "Org B Synthetic Solar", businessEmail: "office@orgb.example.test", intakeTag: "bee" }, ORG_B);

async function pdf(lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  lines.forEach((line, i) => page.drawText(line, { x: 40, y: 740 - i * 18, size: 11, font }));
  return Buffer.from(await doc.save());
}

const PLAN = await pdf(["PV-1 COVER SHEET", "SOLAR PHOTOVOLTAIC SYSTEM", "Address: 101 Synthetic Way, Salem, OR 97301", "Owner: Pat Example", "Module model Q.PEAK 400", "Inverter model IQ8PLUS"]);
const BILL = await pdf(["Your bill", "Account number " + ACCOUNT, "Meter number " + METER, "Billing period Oct 2026", "Amount due $12.34"]);
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

let msgSeq = 0;
async function message(opts: {
  from?: string; to?: string; cc?: string; subject?: string; text?: string; replyTo?: string; headers?: Record<string, string>;
  attachments?: Array<{ filename: string; content: Buffer; cid?: string; contentDisposition?: "inline" | "attachment" }>;
}): Promise<Buffer> {
  msgSeq++;
  const mail = new MailComposer({
    from: opts.from ?? "office@acme.example.test",
    to: opts.to ?? "intake+acme@keelix.example.test",
    ...(opts.cc ? { cc: opts.cc } : {}),
    ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    subject: opts.subject ?? `New job ${msgSeq}`,
    text: opts.text ?? "Plan set and bill attached.",
    messageId: `<synthetic-${msgSeq}@acme.example.test>`,
    headers: opts.headers ?? {},
    attachments: opts.attachments ?? [],
  });
  return mail.compile().build();
}

// The injected model read: proves which TEXT reached it, and answers like the parser's extraction.
const seen: Array<{ planText: string; utilityBillText: string; structuralLetterText: string }> = [];
let extractionOverride: ((t: { planText: string }) => Record<string, unknown>) | null = null;
const extract = async (t: { planText: string; utilityBillText: string; structuralLetterText: string }) => {
  seen.push(t);
  const street = /Address: ([^,]+), ([^,]+), ([A-Z]{2}) (\d{5})/.exec(t.planText);
  const base = {
    provider: "claude" as const,
    fields: {
      ...(street ? {
        street: { value: street[1], confidence: 0.95 }, city: { value: street[2], confidence: 0.95 },
        state: { value: street[3], confidence: 0.95 }, zip: { value: street[4], confidence: 0.95 },
      } : {}),
      owner: { value: "Pat Example", confidence: 0.9 },
      utility: { value: "PGE", confidence: 0.9 },
      account: { value: /Account number (\d+)/.exec(t.utilityBillText)?.[1] ?? "", confidence: 0.4 },
      meter: { value: /Meter number (\w+)/.exec(t.utilityBillText)?.[1] ?? "", confidence: 0.95 },
      dcKw: { value: 7.2, confidence: 0.9 },
      contractorCompany: { value: "Acme Synthetic Solar", confidence: 0.9 },
    },
    lowConfidenceFields: ["account"],
    notes: "",
  };
  return (extractionOverride ? { ...base, ...extractionOverride(t) } : base) as never;
};

const outbox: Array<{ to: string; subject: string; body: string }> = [];
const send = async (to: string, subject: string, body: string) => { outbox.push({ to, subject, body }); };
const opts = { extract, send };

const projectsFor = (clientId: string) => db.query<Record<string, unknown>>("SELECT * FROM projects WHERE client_id = ?", [clientId]);
// The intake's own files (the chain the intake queues may add its own generated documents).
const docsFor = (projectId: string) => db.query<Record<string, unknown>>("SELECT doc_type, original_filename, source FROM project_documents WHERE project_id = ? AND source = 'email_intake' ORDER BY original_filename", [projectId]);

let firstRaw: Buffer;
let projectId = "";

await run("a known sender's plan set + bill to the client's tag creates one project under that client and org", async () => {
  firstRaw = await message({
    replyTo: "someone-else@elsewhere.example.test",
    text: `Hi team, account ${ACCOUNT} for reference. Thanks!`,
    attachments: [
      { filename: "Example Plan Set.pdf", content: PLAN },
      { filename: "bill.pdf", content: BILL },
      { filename: "logo.png", content: PNG_1PX, cid: "logo@sig", contentDisposition: "inline" },
    ],
  });
  const r = await processIntakeMessages(db, [firstRaw], opts);
  assert.equal(r.created, 1, JSON.stringify(r));
  const projects = projectsFor(acme.id);
  assert.equal(projects.length, 1);
  projectId = String(projects[0].id);
  assert.equal(projects[0].org_id, DEFAULT_ORG_ID);
  assert.match(String(projects[0].project_address), /101 Synthetic Way/);
  assert.equal(projects[0].meter_number, METER);
  const docs = docsFor(projectId);
  assert.deepEqual(docs.map((d) => [d.doc_type, d.original_filename, d.source]), [
    ["plan_set", "Example Plan Set.pdf", "email_intake"],
    ["utility_bill", "bill.pdf", "email_intake"],
  ], "the inline signature logo is not an attachment");
  const jobs = db.query("SELECT id FROM job_queue WHERE job_type = 'stage_step' AND project_id = ?", [projectId]);
  assert.ok(jobs.length >= 1, "the local chain is queued");
});

await run("the model saw the plan set and bill text, never the email body", () => {
  assert.equal(seen.length, 1);
  assert.match(seen[0].planText, /101 Synthetic Way/);
  assert.match(seen[0].utilityBillText, /Billing period/);
  assert.ok(!JSON.stringify(seen).includes("Hi team"), "the email body reached the model");
});

await run("a low-confidence field is not written; the contractor block is never project data", () => {
  const p = projectsFor(acme.id)[0];
  assert.equal(p.account_number, "", "the low-confidence account number was written");
  assert.ok(!String(p.parser_json).includes("contractorCompany"));
  const { payload, unsure } = payloadFromExtraction({
    fields: {
      utility: { value: "x", confidence: 0.2 }, ahj: { value: "y", confidence: 0.9 }, contractorCcb: { value: "1", confidence: 1 },
      client_id: { value: rival.id, confidence: 1 }, clientId: { value: rival.id, confidence: 1 }, structureDescription: { value: "garage", confidence: 1 },
    } as never,
    lowConfidenceFields: ["utility"],
  });
  assert.deepEqual(payload, { ahj: "y" }, "a key outside the Parser page's own list reached the project");
  assert.deepEqual(unsure, ["utility"]);
});

await run("the saved-field allowlist is the Parser page's own (LLM_SNAPSHOT_KEYS + LLM_FIELD_TARGETS)", () => {
  const html = fs.readFileSync(path.join(REPO, "frontend", "parser.html"), "utf8");
  const block = (start: string, end: string) => {
    const a = html.indexOf(start);
    assert.ok(a >= 0, `${start} not found in parser.html`);
    return html.slice(a, html.indexOf(end, a)).replace(/\/\/.*$/gm, "");
  };
  const snapshot = [...block("const LLM_SNAPSHOT_KEYS = new Set([", "]);").matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
  const targets = [...block("const LLM_FIELD_TARGETS = {", "};").matchAll(/([A-Za-z0-9_]+):\s*\[/g)].map((m) => m[1]);
  const page = new Set([...snapshot, ...targets]);
  assert.ok(page.size > 50, `read only ${page.size} keys from parser.html`);
  const missing = [...page].filter((k) => !PARSER_PROJECT_FIELDS.has(k));
  const extra = [...PARSER_PROJECT_FIELDS].filter((k) => !page.has(k));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
});

await run("the reply goes to the From address with the status link and what is missing, never the account or meter", () => {
  assert.equal(outbox.length, 1);
  const mail = outbox[0];
  assert.equal(mail.to, "office@acme.example.test", "replied to Reply-To instead of From");
  assert.match(mail.body, /Live status page \(no login needed\): https:\/\/keelix\.example\.test\/status\?token=/);
  assert.match(mail.body, /Permitting jurisdiction \(AHJ\)/, "the missing AHJ is named");
  assert.match(mail.body, /Utility account number/, "the unsure account is named by its label");
  for (const secret of [ACCOUNT, METER]) {
    assert.ok(!mail.body.includes(secret) && !mail.subject.includes(secret), `the reply carries ${secret}`);
  }
  const comm = db.get<Record<string, unknown>>("SELECT * FROM communications WHERE project_id = ? AND logged_by LIKE 'email intake%'", [projectId]);
  assert.equal(comm?.delivery_status, "sent");
  assert.ok(!String(comm?.body).includes(METER));
});

await run("the same message re-read by the next poll makes nothing new", async () => {
  const r = await processIntakeMessages(db, [firstRaw], opts);
  assert.equal(r.skippedDuplicates, 1);
  assert.equal(r.created + r.attached + r.unsorted, 0);
  assert.equal(projectsFor(acme.id).length, 1);
  assert.equal(outbox.length, 1);
});

await run("the same address again within the window attaches to that project; a file already on it is not added twice", async () => {
  const raw = await message({
    from: "pm@acme-partner.example.test",
    attachments: [{ filename: "Example Plan Set.pdf", content: PLAN }, { filename: "meter.jpg", content: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]) }],
  });
  const r = await processIntakeMessages(db, [raw], opts);
  assert.equal(r.attached, 1, JSON.stringify(r));
  assert.equal(projectsFor(acme.id).length, 1);
  assert.deepEqual(docsFor(projectId).map((d) => d.doc_type), ["plan_set", "utility_bill", "meter_photo"]);
  assert.match(outbox[outbox.length - 1].body, /added the files to the project we already have/);
  assert.equal(outbox[outbox.length - 1].to, "pm@acme-partner.example.test");
});

await run("a refused file is reported and the others still land", async () => {
  const raw = await message({
    from: "someone@acme.example.test", // the @domain entry allows it
    attachments: [
      { filename: "plans.dwg", content: Buffer.from("AC1027 synthetic dwg body") },
      { filename: "notes.zip", content: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]) },
      { filename: "Plan Set 202.pdf", content: await pdf(["SOLAR PHOTOVOLTAIC", "Address: 202 Synthetic Way, Salem, OR 97301"]) },
    ],
  });
  const r = await processIntakeMessages(db, [raw], opts);
  assert.equal(r.created, 1, JSON.stringify(r));
  const item = r.items[0];
  assert.deepEqual(item.files.map((f) => [f.name, f.docType ?? null, Boolean(f.refused)]), [
    ["plans.dwg", null, true], ["notes.zip", null, true], ["Plan Set 202.pdf", "plan_set", false],
  ]);
  const body = outbox[outbox.length - 1].body;
  assert.match(body, /plans\.dwg: A CAD drawing/);
  assert.match(body, /notes\.zip: a ZIP archive, not a PDF or a photo/);
  assert.match(body, /The customer's utility bill/, "the missing bill is named");
});

await run("an unknown sender lands unsorted with its files kept, on no client's project, and gets no reply", async () => {
  const before = outbox.length;
  const raw = await message({ from: "stranger@elsewhere.example.test", attachments: [{ filename: "plan.pdf", content: PLAN }] });
  const r = await processIntakeMessages(db, [raw], opts);
  assert.equal(r.unsorted, 1);
  assert.equal(r.items[0].reason, "unknown_sender");
  assert.equal(r.items[0].clientId, acme.id);
  assert.equal(outbox.length, before, "an unknown sender was replied to");
  assert.equal(projectsFor(acme.id).length, 2);
  const file = emailIntakeFile(db, r.items[0].id, 0, DEFAULT_ORG_ID);
  assert.deepEqual(fs.readFileSync(file.path), PLAN);
});

await run("no tag, an unknown tag, a DMARC fail and a plan set licensed to another client are all unsorted", async () => {
  const cases: Array<[Promise<Buffer>, string]> = [
    [message({ to: "intake@keelix.example.test", attachments: [{ filename: "p.pdf", content: PLAN }] }), "no_tag"],
    [message({ to: "intake+nobody@keelix.example.test", attachments: [{ filename: "p.pdf", content: PLAN }] }), "unknown_tag"],
    [message({ headers: { "Authentication-Results": "mx.example.test; spf=pass; dmarc=fail (p=reject) header.from=acme.example.test" }, attachments: [{ filename: "p.pdf", content: PLAN }] }), "sender_not_authenticated"],
  ];
  for (const [p, reason] of cases) {
    const r = await processIntakeMessages(db, [await p], opts);
    assert.equal(r.items[0]?.reason, reason, JSON.stringify(r));
  }
  extractionOverride = () => ({ clientResolution: { decision: "auto_assign", clientId: rival.id, requiresConfirmation: false, candidates: [], installer: {}, explanation: "" } });
  try {
    const r = await processIntakeMessages(db, [await message({ attachments: [{ filename: "p.pdf", content: await pdf(["Address: 303 Synthetic Way, Salem, OR 97301"]) }] })], opts);
    assert.equal(r.items[0]?.reason, "plan_set_names_another_client");
  } finally { extractionOverride = null; }
  assert.equal(projectsFor(rival.id).length, 0);
  assert.equal(projectsFor(acme.id).length, 2);
});

await run("EMAIL_INTAKE_REQUIRE_AUTH=1 (#510): no header or a forged pass under the provider's own header is unsorted; the provider's dmarc=pass files", async () => {
  const A_R = "Authentication-Results";
  const plan = (n: number) => pdf([`Address: ${n} Synthetic Way, Salem, OR 97301`]);
  process.env.EMAIL_INTAKE_REQUIRE_AUTH = "1";
  try {
    const before = outbox.length;
    const refused: Array<Promise<Buffer>> = [
      // No header at all: the default accepts this on the sender match; the switch does not.
      message({ attachments: [{ filename: "p.pdf", content: await plan(401) }] }),
      // The provider ran nothing useful (none) and the sender wrote its own "pass" lower down. MailComposer
      // keeps an array header's order, so the provider's line is on top, as a real delivery has it.
      message({ headers: { [A_R]: ["mx.example.test; none", "mx.example.test; dmarc=pass header.from=acme.example.test"] } as never, attachments: [{ filename: "p.pdf", content: await plan(402) }] }),
      // A pass, but for a domain that is not the From's.
      message({ headers: { [A_R]: "mx.example.test; dmarc=pass header.from=elsewhere.example.test" }, attachments: [{ filename: "p.pdf", content: await plan(403) }] }),
      // SPF alone is not enough; both must pass and align.
      message({ headers: { [A_R]: "mx.example.test; spf=pass smtp.mailfrom=bounce@acme.example.test; dkim=fail header.d=acme.example.test" }, attachments: [{ filename: "p.pdf", content: await plan(404) }] }),
    ];
    for (const p of refused) {
      const r = await processIntakeMessages(db, [await p], opts);
      assert.equal(r.created + r.attached, 0, JSON.stringify(r));
      assert.equal(r.items[0]?.reason, "sender_not_authenticated", JSON.stringify(r));
    }
    assert.equal(outbox.length, before, "an unauthenticated sender was replied to");
    assert.equal(projectsFor(acme.id).length, 2);

    const passed = await processIntakeMessages(db, [await message({ headers: { [A_R]: "mx.example.test; spf=pass smtp.mailfrom=office@acme.example.test; dkim=pass header.d=acme.example.test; dmarc=pass (p=reject) header.from=acme.example.test" }, attachments: [{ filename: "p.pdf", content: await plan(405) }] })], opts);
    assert.equal(passed.created, 1, JSON.stringify(passed));
    const aligned = await processIntakeMessages(db, [await message({ headers: { [A_R]: "mx.example.test; spf=pass smtp.mailfrom=bounce@mail.acme.example.test; dkim=pass header.d=acme.example.test" }, attachments: [{ filename: "p.pdf", content: await plan(406) }] })], opts);
    assert.equal(aligned.created, 1, `aligned SPF + DKIM without a DMARC line: ${JSON.stringify(aligned)}`);
  } finally { delete process.env.EMAIL_INTAKE_REQUIRE_AUTH; }
  // Switch off again: no header files on the sender match alone, as before #510.
  const off = await processIntakeMessages(db, [await message({ attachments: [{ filename: "p.pdf", content: await plan(407) }] })], opts);
  assert.equal(off.created, 1, JSON.stringify(off));
  assert.equal(projectsFor(acme.id).length, 5);
});

await run("an address the documents do not give is unsorted, not a blank project", async () => {
  const r = await processIntakeMessages(db, [await message({ attachments: [{ filename: "scan.pdf", content: await pdf(["no address on this page"]) }] })], opts);
  assert.equal(r.items[0]?.reason, "address_unreadable");
});

await run("a message with nothing attached is recorded once and never listed", async () => {
  const raw = await message({ attachments: [] });
  const r = await processIntakeMessages(db, [raw], opts);
  assert.equal(r.unsorted, 0);
  assert.equal((await processIntakeMessages(db, [raw], opts)).skippedDuplicates, 1);
});

await run("mail to any other address is never touched", async () => {
  const raw = await message({ to: "permits+acme@keelix.example.test", attachments: [{ filename: "p.pdf", content: PLAN }] });
  const r = await processIntakeMessages(db, [raw], opts);
  assert.equal(r.scanned, 0);
  assert.equal(intakeTagFrom(["permits+acme@keelix.example.test", "intake@other.example.test"]), null);
  assert.equal(intakeTagFrom(["Intake+ACME@Keelix.Example.Test"]), "acme");
});

await run("a per-org source matches only its own org's clients; the central inbox files under the client's org", async () => {
  const raw = await message({ from: "office@orgb.example.test", to: "intake+bee@keelix.example.test", attachments: [{ filename: "p.pdf", content: await pdf(["Address: 404 Synthetic Way, Salem, OR 97301"]) }] });
  const scoped = await processIntakeMessages(db, [raw], { ...opts, sourceOrgId: DEFAULT_ORG_ID, restrictToOrg: true });
  assert.equal(scoped.items[0]?.reason, "unknown_tag");
  const raw2 = await message({ from: "office@orgb.example.test", to: "intake+bee@keelix.example.test", attachments: [{ filename: "p.pdf", content: await pdf(["Address: 404 Synthetic Way, Salem, OR 97301"]) }] });
  const central = await processIntakeMessages(db, [raw2], opts);
  assert.equal(central.created, 1, JSON.stringify(central));
  assert.equal(projectsFor(orgBClient.id)[0]?.org_id, ORG_B);
});

await run("the unsorted list is per org; a row outside it is a 404; dismiss clears its files", async () => {
  const mine = listEmailIntake(db, DEFAULT_ORG_ID);
  const theirs = listEmailIntake(db, ORG_B);
  assert.ok(mine.unsorted.length >= 5);
  assert.equal(theirs.unsorted.length, 0);
  assert.equal(theirs.recent.length, 1);
  assert.ok(!JSON.stringify(mine.unsorted).includes("stored"), "a server path reached the list");
  const target = mine.unsorted.find((i) => i.reason === "unknown_sender")!;
  assert.throws(() => emailIntakeFile(db, target.id, 0, ORG_B), (e: { status?: number }) => e.status === 404);
  assert.throws(() => dismissEmailIntake(db, target.id, ORG_B, "x"), (e: { status?: number }) => e.status === 404);
  const { path: stored } = emailIntakeFile(db, target.id, 0, DEFAULT_ORG_ID);
  assert.equal(dismissEmailIntake(db, target.id, DEFAULT_ORG_ID, "tester").status, "dismissed");
  assert.ok(!fs.existsSync(stored));
  assert.ok(!listEmailIntake(db, DEFAULT_ORG_ID).unsorted.some((i) => i.id === target.id));
});

await run("an MBOX round trip keeps each message whole (the writer's From-escape undone)", async () => {
  const raw = (await message({ text: "line one\nFrom the field: two\n", attachments: [] })).toString("utf8");
  const chunks: string[] = [];
  const sink = { write: (s: string) => { chunks.push(s); return true; } } as unknown as NodeJS.WritableStream;
  writeMboxMessage(sink, raw, "imap@local");
  writeMboxMessage(sink, raw.replace("synthetic-", "other-"), "imap@local");
  const back = mboxMessages(chunks.join(""));
  assert.equal(back.length, 2);
  assert.match(back[0].toString("utf8"), /\nFrom the field: two/);
});

await run("intake tag: normalised, validated, one client per tag in an org; senders match exactly or by @domain", () => {
  assert.equal(acme.intakeTag, "acme");
  assert.throws(() => createClient(db, { companyName: "Bad Tag Co", intakeTag: "a b" }), /letters, digits/);
  assert.throws(() => createClient(db, { companyName: "Dup Tag Co", intakeTag: "ACME" }), /already used/);
  assert.ok(createClient(db, { companyName: "Same Tag Other Org", intakeTag: "acme" }, ORG_B).id);
  const c = { contact_email: "", business_email: "office@acme.example.test", updates_inbox: "", billing_contact_email: "", intake_senders: "@acme.example.test" };
  assert.ok(senderIsKnown(c, "Anyone@ACME.example.test"));
  assert.ok(!senderIsKnown(c, "anyone@notacme.example.test"));
  assert.ok(!senderIsKnown(c, "acme.example.test"));
});

await run("the reply's subject and body pass the project's own account and meter through the redactor", () => {
  const mail = intakeReplyEmail({
    project: { projectAddress: `${ACCOUNT} Synthetic Way`, city: "", state: "", accountNumber: ACCOUNT, meterNumber: METER } as never,
    attached: false, link: "https://keelix.example.test/status?token=t", missing: [], unsure: [], refused: [], secrets: [],
  });
  assert.ok(!mail.subject.includes(ACCOUNT) && !mail.body.includes(ACCOUNT));
  const other = intakeReplyEmail({
    project: { projectAddress: "1 Synthetic Way", city: "", state: "" } as never,
    attached: false, link: "https://keelix.example.test/status?token=t", missing: [], unsure: [], refused: [{ name: `acct-${ACCOUNT}.pdf`, size: 1, refused: "x" }], secrets: [ACCOUNT],
  });
  assert.ok(!other.body.includes(ACCOUNT), "a secret from the read (not on the project) was echoed in a file name");
});

console.log(failures ? `\n${failures} failure(s)` : "\nemailIntake: all checks passed");
process.exit(failures ? 1 : 0);
