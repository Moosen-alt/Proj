// EVERY EMAIL KEELIX SENDS HAS ONE LAYOUT (#589). Owner ask 2026-11-03: every email must look
// professional; the first real staff alert read "Keelix — needs you: …" over "Track: … / What
// happened: …" lines, from a bare address with no layout. Pins, with NO SMTP connection anywhere
// (messages are compiled with nodemailer's MailComposer, which opens no socket):
//
//   1. BOTH PARTS   every template — the client notice for each outcome, the intake and login asks
//                   and their reminders, the intake reply, the installer handoff, every staff alert,
//                   the digest, a text-only send and the ops mailer — gives an HTML part (doctype,
//                   KEELIX / AUTOMATION wordmark, footer, no <style>/<img>/<svg>) and a text twin
//                   carrying the same content (every URL in both) and no layout chrome.
//   2. ESCAPING     <script>, quotes and & injected into EVERY field of the layout content, one
//                   field at a time, and into each builder's inputs, never reach the HTML raw.
//   3. LINKS        a non-http(s) action / item / text URL is never an href (no <a> at all); an
//                   http(s) URL carrying quotes or brackets is percent-encoded in the href.
//   4. FROM         SMTP_FROM_NAME is the display name ("Keelix Filings" when unset), SMTP_FROM stays
//                   the bare address (the envelope sender), an older "Name <addr>" SMTP_FROM still
//                   works; sendEmail's message is multipart (text + html), and a caller that passes
//                   only text still gets the layout. The ops mailer uses the same From. .env.example
//                   documents SMTP_FROM bare and SMTP_FROM_NAME.
//   5. RULE 2       the HTML part is scrubbed like the text: an account number typed into a field
//                   that flows into a client email reaches neither part.
//   6. TEXT SHAPE   the lines the readers parse survive: the client notice's "Live status page (no
//                   login needed): <url>" line (refreshStatusLink), the handoff's closing signoff.
//
// KILLS (each run by hand; each turns this file red):
//   (a) emailLayout.escapeHtml → `return String(value ?? "")`            → 2 fails.
//   (b) emailLayout.safeHttpUrl → accept any scheme (return raw)         → 3 fails.
//   (c) emailLayout.mailFrom → drop `cleanDisplayName(rawName) ||`       → 4 fails.
//   (d) clientNotifier.buildMailOptions → drop the `html:` line          → 4 fails (and 1).
//   (e) clientRequestLinks.renderScrubbed → render `content`, not the mapEmailText(...) copy → 5 fails.
//
//   npx tsx backend/test/emailLayout.test.ts
import { REPO } from "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

for (const k of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM", "SMTP_FROM_NAME", "SMTP_SECURE", "FILING_CONTACT_EMAIL", "BRAND_NAME"]) delete process.env[k];
process.env.PUBLIC_BASE_URL = "https://app.keelix.example.test";

const layout = await import("../src/emailLayout");
const updates = await import("../src/clientUpdates");
const notifier = await import("../src/clientNotifier");
const requests = await import("../src/clientRequestLinks");
const intake = await import("../src/emailIntake");
const handoff = await import("../src/installerHandoff");
const staff = await import("../src/staffAlerts");
const mailer = await import("../../scripts/ops/mailer");
const { default: MailComposer } = await import("nodemailer/lib/mail-composer/index.js");
type AppDb = import("../src/db").AppDb;
type ProjectRecord = import("../../shared/src/types").ProjectRecord;
type ClientUpdate = import("../src/clientUpdates").ClientUpdate;
type EmailContent = import("../src/emailLayout").EmailContent;

let failures = 0;
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL - ${name}\n    ${err instanceof Error ? err.message.split("\n").join("\n    ") : String(err)}`);
  }
}

// ── synthetic data ───────────────────────────────────────────────────────────────────────────
const ACCOUNT = "4455667788";
const project = {
  id: "proj-layout-1", projectAddress: "123 Example Way", city: "Portland", state: "OR", homeownerName: "Avery Example",
  ahj: "City of Example", utility: "Example Electric", systemSizeDcKw: 7.2, interconnectionMethod: "Load-side breaker",
  accountNumber: ACCOUNT, meterNumber: "",
} as unknown as ProjectRecord;
const address = notifier.formatProjectAddress(project);
const LINK = "https://app.keelix.example.test/status?token=tok-123";
const none = { query: () => [], get: () => undefined, run: () => undefined } as unknown as AppDb;

interface Mail { name: string; subject: string; html: string; text: string }
function allTemplates(p: ProjectRecord = project, company = "Sunny Example Solar"): Mail[] {
  const addr = notifier.formatProjectAddress(p);
  const out: Mail[] = [];
  const notices: Array<[string, Record<string, string>]> = [
    ["issued", { targetType: "permit", permitType: "electrical", permitNumber: "EX-1" }],
    ["ready_for_issue", { targetType: "permit" }],
    ["nem_approved", { targetType: "nem", applicationNumber: "EX-2" }],
    ["correction_flagged", { targetType: "permit", permitType: "building" }],
    ["filed", { targetType: "nem", applicationNumber: "EX-3" }],
    ["final_passed", { targetType: "permit" }],
    ["pto_requested", { targetType: "nem" }],
    ["pto_granted", { targetType: "nem" }],
  ];
  for (const [outcome, ctx] of notices) {
    const update = updates.clientUpdateFor(none, p, outcome, ctx as never) as ClientUpdate;
    assert.ok(update, `no wording for ${outcome}`);
    const m = notifier.clientUpdateNotice(update, { company, homeownerName: String(p.homeownerName), address: addr, fallbackRef: p.id, statusLine: outcome, link: LINK });
    out.push({ name: `notice:${outcome}`, subject: m.subject, html: m.html, text: m.body });
  }
  const needs = { bill: ["account number"], questions: ["Is there a second meter?"], fields: ["jobValue"] as never[], heldFields: [] };
  for (const reminder of [false, true]) {
    const a = requests.intakeEmail(p, company, needs, "https://app.keelix.example.test/intake?token=abc", reminder);
    out.push({ name: `intake-ask${reminder ? ":reminder" : ""}`, subject: a.subject, html: a.html, text: a.body });
    const c = requests.credentialEmail(p, company, { label: "Example Electric's interconnection portal", url: "https://portal.example.test/apply" },
      "https://app.keelix.example.test/credentials?token=OneTime123", "2026-11-06T00:00:00.000Z", reminder);
    out.push({ name: `login-ask${reminder ? ":reminder" : ""}`, subject: c.subject, html: c.html, text: c.body });
  }
  const r = intake.intakeReplyEmail({ project: p, attached: false, link: LINK, missing: ["Utility"], unsure: ["System size (DC kW)"], refused: [{ name: "x.dwg", size: 1, refused: "A CAD drawing" } as never], secrets: [] });
  out.push({ name: "intake-reply", subject: r.subject, html: r.html, text: r.body });
  const h = handoff.installerHandoffEmail({
    project: p, company, address: addr, link: LINK, approved: ["Building permit — City of Example: issued, permit EX-4."],
    attachmentLabels: ["Issued permit"], secrets: [],
    update: { subject: "Ready for install — handoff packet", headline: "Ready.", meaning: "", action: "Schedule the install." },
  });
  out.push({ name: "handoff", subject: h.subject, html: h.html, text: h.body });
  for (const runStatus of staff.RUN_STATES_THAT_ALERT) {
    const m = staff.runAlertEmail({ address: addr, projectId: p.id, track: "building", runStatus, why: "the reason" });
    out.push({ name: `staff:run:${runStatus}`, subject: m.subject, html: m.html, text: m.body });
  }
  for (const [name, m] of [
    ["staff:correction", staff.correctionAlertEmail({ address: addr, projectId: p.id, track: "permit" })],
    ["staff:stage-held", staff.stageHeldAlertEmail({ address: addr, projectId: p.id, track: "nem", why: "Missing: Homeowner email (project)." })],
    ["staff:status", staff.statusAlertEmail({ address: addr, projectId: p.id, track: "electrical", outcome: "issued" })],
    ["staff:unmatched", staff.unmatchedEmailAlert({ domain: "example.gov", day: "2026-11-03", bucket: "permit_correction" })],
    ["staff:digest", staff.staffDigestEmail([{ id: p.id, address: addr, urgency: "today", headline: "Stage it" }], new Date(2026, 10, 3, 7))],
    ["staff:digest-empty", staff.staffDigestEmail([], new Date(2026, 10, 3, 7))],
  ] as const) out.push({ name, subject: m.subject, html: m.html, text: m.body });
  const plain = "Hi there,\n\nYour permit was issued.\nLive status page (no login needed): https://app.keelix.example.test/status?token=t";
  out.push({ name: "text-only (sendEmail fallback)", subject: "Permit issued", html: String(notifier.buildMailOptions("a@b.example", "Permit issued", plain).html), text: plain });
  const ops = mailer.opsMailOptions("ops@example.test", "[Solar Autopilot] PROBLEM: server", "PROBLEM: server\nhttps://app.keelix.example.test/health", { SMTP_FROM: "w@ops.example.test" });
  out.push({ name: "ops mailer", subject: ops.subject, html: ops.html, text: ops.text });
  return out;
}

const URLS = /https?:\/\/[^\s<>"']+/g;

// ── 1. both parts ────────────────────────────────────────────────────────────────────────────
await check("1. BOTH PARTS: every template gives the HTML layout and a text twin with the same URLs and no chrome", () => {
  const mails = allTemplates();
  assert.ok(mails.length >= 25, `only ${mails.length} templates`);
  for (const m of mails) {
    assert.ok(m.subject.trim(), `${m.name}: no subject`);
    assert.ok(m.text.trim(), `${m.name}: no text part`);
    assert.match(m.html, /^<!DOCTYPE html>/, `${m.name}: not an HTML document`);
    assert.match(m.html, />KEELIX</, `${m.name}: no wordmark`);
    assert.match(m.html, />AUTOMATION</, `${m.name}: no wordmark kicker`);
    assert.match(m.html, /Keelix Automation/, `${m.name}: no footer`);
    assert.doesNotMatch(m.html, /<style|<img|<svg|<script|<link /i, `${m.name}: a <style>/<img>/<svg>/<script> in the email`);
    for (const url of m.text.match(URLS) ?? []) {
      assert.ok(m.html.includes(`href="${layout.escapeHtml(new URL(url.replace(/[.,;:!?)]+$/, "")).href)}"`), `${m.name}: the text's link ${url} is not a link in the HTML`);
    }
    assert.doesNotMatch(m.text, /Keelix Automation|AUTOMATION|<\w/, `${m.name}: layout chrome or markup in the text twin`);
  }
});

await check("1b. renderEmail: every content string is in the text verbatim and in the HTML escaped", () => {
  const c: EmailContent = {
    audience: "client", preheader: "Pre header", eyebrow: "Eye brow", headline: "Head line", greeting: "Hi Co,",
    intro: ["First para.", "Second para."], rows: [["Label A", "Value A"], ["Label B", "Value B"]],
    sections: [{ heading: "Sec head", paragraphs: ["Sec para."], items: ["Item one", { text: "Item two", url: "https://x.example.test/a", linkLabel: "Open it" }], ordered: true }],
    nextStep: "Do the thing.", action: { label: "Press", url: "https://x.example.test/go", textLabel: "Go here" }, note: ["A note."], signoff: ["Thanks,", "Keelix"],
  };
  const { html, text } = layout.renderEmail(c, { contact: "filings@example.test" });
  for (const s of ["Head line", "Hi Co,", "First para.", "Second para.", "Label A: Value A\nLabel B: Value B", "Sec head:", "Sec para.", "1. Item one", "2. Item two\n  https://x.example.test/a", "Do the thing.", "Go here: https://x.example.test/go", "A note.", "Thanks,\nKeelix"]) {
    assert.ok(text.includes(s), `text lacks ${JSON.stringify(s)}:\n${text}`);
  }
  for (const s of ["Pre header", "Eye brow", "Head line", "Hi Co,", "First para.", "Second para.", "Label A", "Value A", "Sec head", "Sec para.", "Item one", "Item two", "Open it", "Do the thing.", "Press", "A note.", "Thanks,", "filings@example.test"]) {
    assert.ok(html.includes(s), `html lacks ${s}`);
  }
  assert.ok(!text.endsWith("\n"), "the text twin ends on its last line");
});

// ── 2. escaping ──────────────────────────────────────────────────────────────────────────────
const EVIL = `<script>alert("dq")</script> & 'sq' <b>x</b>`;
function assertEscaped(html: string, where: string): void {
  assert.ok(!html.includes("<script"), `${where}: a raw <script> reached the HTML`);
  assert.ok(!html.includes("<b>"), `${where}: a raw <b> reached the HTML`);
  assert.ok(!html.includes(`"dq"`), `${where}: a raw double quote reached the HTML`);
  assert.ok(!html.includes(`'sq'`), `${where}: a raw single quote reached the HTML`);
  assert.ok(html.includes("&lt;script&gt;alert(&quot;dq&quot;)&lt;/script&gt; &amp; &#39;sq&#39;"), `${where}: the value is not there, escaped`);
}

await check("2. ESCAPING: <script>, quotes and & in EVERY field of the content, one at a time, never reach the HTML raw", () => {
  const base = (): EmailContent => ({
    audience: "staff", preheader: "p", eyebrow: "e", headline: "h", greeting: "g", intro: ["i"], rows: [["l", "v"]],
    sections: [{ heading: "sh", paragraphs: ["sp"], items: [{ text: "it", url: "https://x.example.test/", linkLabel: "ll" }] }],
    nextStep: "n", action: { label: "a", url: "https://x.example.test/go", textLabel: "t" }, note: ["no"], signoff: ["s"],
  });
  const setters: Array<[string, (c: EmailContent) => void]> = [
    ["preheader", (c) => { c.preheader = EVIL; }],
    ["eyebrow", (c) => { c.eyebrow = EVIL; }],
    ["headline (and <title>)", (c) => { c.headline = EVIL; }],
    ["greeting", (c) => { c.greeting = EVIL; }],
    ["intro", (c) => { c.intro = [EVIL]; }],
    ["row label", (c) => { c.rows = [[EVIL, "v"]]; }],
    ["row value", (c) => { c.rows = [["l", EVIL]]; }],
    ["section heading", (c) => { c.sections![0].heading = EVIL; }],
    ["section paragraph", (c) => { c.sections![0].paragraphs = [EVIL]; }],
    ["item text", (c) => { c.sections![0].items = [EVIL]; }],
    ["item link label", (c) => { c.sections![0].items = [{ text: "it", url: "https://x.example.test/", linkLabel: EVIL }]; }],
    ["item url (not http)", (c) => { c.sections![0].items = [{ text: "it", url: EVIL }]; }],
    ["next step", (c) => { c.nextStep = EVIL; }],
    ["action label", (c) => { c.action = { label: EVIL, url: "https://x.example.test/go" }; }],
    ["action url (not http)", (c) => { c.action = { label: "a", url: EVIL }; }],
    ["action text label (shown when the url is not a link)", (c) => { c.action = { label: "a", url: "not a url", textLabel: EVIL }; }],
    ["note", (c) => { c.note = [EVIL]; }],
    ["signoff", (c) => { c.signoff = [EVIL]; }],
  ];
  for (const [field, set] of setters) {
    const c = base();
    set(c);
    assertEscaped(layout.renderEmailHtml(c, { contact: "" }), field);
  }
  assertEscaped(layout.renderEmailHtml(base(), { contact: EVIL }), "footer contact");
  assertEscaped(layout.wrapPlainText(EVIL, { subject: "s", contact: "" }), "wrapPlainText body");
  assertEscaped(layout.wrapPlainText("body", { subject: EVIL, contact: "" }), "wrapPlainText <title>");
});

await check("2b. ESCAPING through every builder: a company, address, AHJ, utility, label or file name carrying markup", () => {
  const evilProject = { ...project, projectAddress: `1 ${EVIL} Way`, ahj: `AHJ ${EVIL}`, utility: `Utility ${EVIL}`, homeownerName: EVIL } as unknown as ProjectRecord;
  for (const m of allTemplates(evilProject, `Co ${EVIL}`)) {
    if (/^(text-only|ops mailer|staff:unmatched|staff:digest-empty)/.test(m.name)) continue; // no project input
    assertEscaped(m.html, m.name);
  }
  const needs = { bill: [], questions: [EVIL], fields: [] as never[], heldFields: [] };
  assertEscaped(requests.intakeEmail(project, "Co", needs, "https://app.keelix.example.test/intake?token=a").html, "intake ask: portal question");
  assertEscaped(requests.credentialEmail(project, "Co", { label: EVIL, url: "https://portal.example.test/" }, "https://app.keelix.example.test/credentials?token=a", "2026-11-06").html, "login ask: portal label");
  assertEscaped(intake.intakeReplyEmail({ project, attached: true, link: LINK, missing: [EVIL], unsure: [], refused: [{ name: EVIL, size: 1, refused: "x" } as never], secrets: [] }).html, "intake reply: labels and file names");
  assertEscaped(staff.runAlertEmail({ address, projectId: project.id, track: "building", runStatus: "failed", why: EVIL }).html, "staff: why");
  assertEscaped(staff.unmatchedEmailAlert({ domain: EVIL, day: "2026-11-03", bucket: "x" }).html, "staff: unmatched domain");
  assertEscaped(staff.staffDigestEmail([{ id: "p1", address: EVIL, urgency: "today", headline: "h" }], new Date()).html, "staff: digest address");
});

// ── 3. links ─────────────────────────────────────────────────────────────────────────────────
await check("3. LINKS: a non-http(s) action, item or in-text URL is never an href — shown as text", () => {
  const bad = ["javascript:alert(1)", "JavaScript:alert(1)", " javascript:alert(1)", "data:text/html;base64,PHNjcmlwdD4=", "vbscript:msgbox(1)",
    "mailto:a@b.example.test", "//evil.example.test/x", "/relative/path", "ftp://files.example.test/x", "https//missing-colon.example.test", ""];
  for (const url of bad) {
    assert.equal(layout.safeHttpUrl(url), null, `safeHttpUrl accepted ${JSON.stringify(url)}`);
    const html = layout.renderEmailHtml({
      audience: "client", preheader: "p", headline: "h", action: { label: "Go", url },
      sections: [{ items: [{ text: "it", url, linkLabel: "Open" }] }],
    }, { contact: "" });
    assert.doesNotMatch(html, /<a\s/i, `${JSON.stringify(url)} became a link`);
    if (url.trim()) assert.ok(html.includes(layout.escapeHtml(url.trim())), `${JSON.stringify(url)} is not shown as text`);
    const wrapped = layout.wrapPlainText(`Open ${url} now`, { contact: "" });
    assert.doesNotMatch(wrapped, /<a\s/i, `${JSON.stringify(url)} in plain text became a link`);
  }
  for (const ok of ["https://app.keelix.example.test/x?y=1", "HTTP://app.keelix.example.test/", "http://127.0.0.1:4173/#/project/a"]) {
    assert.ok(layout.safeHttpUrl(ok), `safeHttpUrl refused ${ok}`);
  }
  // An http(s) URL that carries quotes or brackets cannot break out of the attribute.
  const sly = `https://ok.example.test/"onmouseover="alert(1)"<script>`;
  const html = layout.renderEmailHtml({ audience: "client", preheader: "p", headline: "h", action: { label: "Go", url: sly } }, { contact: "" });
  assert.doesNotMatch(html, /onmouseover="|<script/i, "the URL broke out of its href");
  assert.match(html, /href="https:\/\/ok\.example\.test\/%22onmouseover=%22alert\(1\)%22%3Cscript%3E"/);
});

// ── 4. From, multipart ───────────────────────────────────────────────────────────────────────
await check("4. FROM: SMTP_FROM_NAME is the display name, SMTP_FROM the bare address; an older 'Name <addr>' still works", () => {
  assert.deepEqual(layout.mailFrom("filings@keelix.example.test", undefined), { name: "Keelix Filings", address: "filings@keelix.example.test" }, "the default name");
  assert.deepEqual(layout.mailFrom("filings@keelix.example.test", "Keelix Permits Desk"), { name: "Keelix Permits Desk", address: "filings@keelix.example.test" });
  assert.deepEqual(layout.mailFrom(`"Permits" <p@x.example.test>`, undefined), { name: "Permits", address: "p@x.example.test" }, "an older SMTP_FROM keeps its own name");
  assert.deepEqual(layout.mailFrom("Permits <p@x.example.test>", "Keelix Filings"), { name: "Keelix Filings", address: "p@x.example.test" }, "SMTP_FROM_NAME wins over it");
  assert.deepEqual(layout.mailFrom("a@b.example.test", "Evil\r\nBcc: x@y.example.test"), { name: "Evil Bcc: x@y.example.test", address: "a@b.example.test" }, "a header break in the name");
  assert.equal(layout.mailFrom("not an address", "X"), "not an address", "an unreadable value passes through as before");
  assert.equal(layout.mailFrom(undefined, "X"), undefined, "unset stays unset");
});

await check("4b. sendEmail's message: multipart text + html, From with the display name, the envelope sender bare", async () => {
  process.env.SMTP_FROM = "alerts@keelix.example.test";
  process.env.SMTP_FROM_NAME = "Keelix Filings";
  try {
    const opts = notifier.buildMailOptions("ops@client.example.test", "Permit issued", "Hello <b> & bye", [], { html: "<p>rendered</p>" });
    assert.equal(process.env.SMTP_FROM, "alerts@keelix.example.test", "SMTP_FROM itself is never rewritten");
    assert.deepEqual(opts.from, { name: "Keelix Filings", address: "alerts@keelix.example.test" });
    assert.equal(opts.html, "<p>rendered</p>", "the caller's HTML part is the one sent");
    const composed = new MailComposer(opts).compile();
    assert.equal(composed.getEnvelope().from, "alerts@keelix.example.test", "the envelope sender is the bare address");
    const raw = (await composed.build()).toString("utf8");
    assert.match(raw, /^From: Keelix Filings <alerts@keelix\.example\.test>$/m, raw.slice(0, 400));
    assert.match(raw, /Content-Type: multipart\/alternative/i);
    assert.match(raw, /Content-Type: text\/plain/i);
    assert.match(raw, /Content-Type: text\/html/i);
    // Text only: the layout still wraps it, escaped.
    const plain = notifier.buildMailOptions("ops@client.example.test", "Permit issued", "Hello <b> & bye");
    assert.match(String(plain.html), />KEELIX</, "a text-only caller got no layout");
    assert.ok(String(plain.html).includes("Hello &lt;b&gt; &amp; bye"), "the text is not in the layout, escaped");
    // With an attachment (the installer handoff) the HTML part still rides along.
    const file = path.join(process.cwd(), "issued-permit.pdf");
    fs.writeFileSync(file, "%PDF-1.4 synthetic");
    const withFile = (await new MailComposer(notifier.buildMailOptions("a@b.example.test", "s", "t", [{ filename: "issued-permit.pdf", path: file, label: "Issued permit" } as never], { html: "<p>h</p>" })).compile().build()).toString("utf8");
    assert.match(withFile, /multipart\/mixed/i);
    assert.match(withFile, /Content-Type: text\/html/i);
    // Unset name: the default.
    delete process.env.SMTP_FROM_NAME;
    assert.deepEqual(notifier.buildMailOptions("a@b.example.test", "s", "t").from, { name: "Keelix Filings", address: "alerts@keelix.example.test" });
  } finally {
    delete process.env.SMTP_FROM;
    delete process.env.SMTP_FROM_NAME;
  }
});

await check("4c. the ops mailer reads SMTP_FROM_NAME too (SMTP_ENV_KEYS), and SMTP_FROM stays bare in .env.example", () => {
  assert.ok((mailer.SMTP_ENV_KEYS as readonly string[]).includes("SMTP_FROM_NAME"));
  const o = mailer.opsMailOptions("ops@example.test", "s", "t", { SMTP_FROM: "w@ops.example.test", SMTP_FROM_NAME: "Keelix Ops" });
  assert.deepEqual(o.from, { name: "Keelix Ops", address: "w@ops.example.test" });
  assert.match(o.html, />KEELIX</);
  const env = fs.readFileSync(path.join(REPO, ".env.example"), "utf8");
  const fromLine = env.split(/\r?\n/).find((l) => /^#?\s*SMTP_FROM=/.test(l)) ?? "";
  assert.ok(fromLine && !/[<"]/.test(fromLine), `.env.example's SMTP_FROM is not a bare address: ${fromLine}`);
  assert.match(env, /^#?\s*SMTP_FROM_NAME=/m, ".env.example does not document SMTP_FROM_NAME");
  process.env.SMTP_HOST = "smtp.example.test";
  process.env.SMTP_FROM = "alerts@keelix.example.test";
  try { assert.equal(notifier.smtpConfigured(), true, "a bare SMTP_FROM is configured"); }
  finally { delete process.env.SMTP_HOST; delete process.env.SMTP_FROM; }
});

// ── 5. rule 2 ────────────────────────────────────────────────────────────────────────────────
await check("5. RULE 2: the HTML part is scrubbed like the text — an account number in a field that flows into the email reaches neither", () => {
  const leaky = { ...project, projectAddress: `${ACCOUNT} Example Way`, interconnectionMethod: `Supply-side tap, acct ${ACCOUNT}` } as unknown as ProjectRecord;
  const needs = { bill: ["account number"], questions: [], fields: [] as never[], heldFields: [] };
  const parts = [
    requests.intakeEmail(leaky, "Co", needs, "https://app.keelix.example.test/intake?token=a"),
    requests.credentialEmail(leaky, "Co", { label: "Portal", url: "https://portal.example.test/" }, "https://app.keelix.example.test/credentials?token=a", "2026-11-06"),
    intake.intakeReplyEmail({ project: leaky, attached: false, link: LINK, missing: [], unsure: [], refused: [{ name: `acct-${ACCOUNT}.pdf`, size: 1, refused: "x" } as never], secrets: [ACCOUNT] }),
    handoff.installerHandoffEmail({ project: leaky, company: "Co", address: `${ACCOUNT} Example Way`, link: LINK, approved: [], attachmentLabels: [], secrets: [ACCOUNT],
      update: { subject: "Ready for install — handoff packet", headline: "Ready.", meaning: "", action: "Schedule." } }),
  ];
  for (const [i, m] of parts.entries()) {
    assert.ok(!m.body.includes(ACCOUNT), `#${i}: the text carries the account number`);
    assert.ok(!m.html.includes(ACCOUNT), `#${i}: the HTML part carries the account number`);
    assert.ok(!m.subject.includes(ACCOUNT), `#${i}: the subject carries the account number`);
  }
});

// ── 6. the text twin's shape ─────────────────────────────────────────────────────────────────
await check("6. TEXT SHAPE: the status-link line refreshStatusLink rewrites, and the handoff's closing signoff", () => {
  const update = updates.clientUpdateFor(none, project, "issued", { targetType: "permit" }) as ClientUpdate;
  const notice = notifier.clientUpdateNotice(update, { company: "Co", homeownerName: "", address, fallbackRef: project.id, statusLine: "issued", link: LINK });
  assert.match(notice.body, /^Live status page \(no login needed\): https:\/\/app\.keelix\.example\.test\/status\?token=tok-123$/m);
  assert.match(notice.subject, /^Keelix — Permit issued — 123 Example Way, Portland, OR$/, "the client subject keeps its shape");
  const h = handoff.installerHandoffEmail({ project, company: "Co", address, link: LINK, approved: [], attachmentLabels: [], secrets: [],
    update: { subject: "Ready for install — handoff packet", headline: "Ready.", meaning: "", action: "Schedule." } });
  assert.match(h.body, /\n— Keelix \(automated update; reply to reach the team\)$/);
  const alert = staff.correctionAlertEmail({ address, projectId: project.id, track: "permit" });
  assert.equal(alert.subject, "Action needed: permit corrections requested — 123 Example Way");
  assert.match(alert.body, /^Track: Permit\nWhat happened: correction notice received\nWhy: the agency asked for changes\. Triage it and draft the reply\.$/m);
});

console.log(`\nemailLayout: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
