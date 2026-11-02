// THE ISSUED PERMIT AND THE UTILITY'S APPROVAL LETTER, PULLED OFF THE FILED RECORD (#492).
//
// When a permit reads issued or a NEM application reads approved, the monitor now downloads the
// issued permit / approval letter off the same record and attaches it with provenance. Pinned here,
// with the outside door seamed (no portal is touched) except section 9, which drives the REAL
// documentFetch door against loopback stubs:
//
//   1. THE PICKER on an Accela-style record page: only the attachments row's issued permit is a
//      candidate — never Pay Fees, Schedule / Request Inspection, Renew / Request Extension /
//      Submit Revision links that name the permit, a javascript postback "Download Issued Permit",
//      the plan review comments, the permit application, a utility host (rule 5) or another city.
//   2. THE PICKER on a PowerClerk-style record page: only the approval letter — never Submit,
//      Withdraw, Edit, an "Approve" or "Accept" link, a sample / template, a please-sign agreement,
//      or an AHJ permit portal (rule 5).
//   3. THE SWEEP (runDuePermitChecks): an issued permit record → one issued_permit document, source
//      portal_record, provenance "downloaded from record X on <date>" on the card's target, an
//      audit row, and the seam asked ONLY for the record page and the picked link.
//   4. IDEMPOTENT: a re-sweep and a forced re-read attach no second copy; a file a person already
//      attached under the slot is not attached again.
//   5. NEM: an approved PowerClerk-style record → one utility_approval document.
//   6. SAYS WHY: a sign-in wall, a page naming another record, a link answering a web page, a
//      download that redirected off the record's portal — each leaves nothing attached and one line
//      on the target (issuedDocsGap); a record not issued is never visited.
//   7. THE HANDOFF PACKET: the closeout section lists the file with its provenance and
//      closeoutDocumentsComplete is true; a project missing its letter says why and is false.
//      Then the person attaches the letter by hand (the card's "download it by hand"): the card,
//      the packet and the monitor all count it ("attached by … on <date>"), and the upload
//      picker offers the slot.
//   8. THE CARD (frontend issuedDocumentsHtml, lifted from dashboard.js): the link and provenance,
//      or the gap line, everything escaped.
//   9. THE REAL DOOR (documentFetch allowUrl): a redirect hop the caller's door refuses is never
//      requested, and allowUrl forbids the browser rung on a 403.
//
// Kill: the sweep's fetchIssuedRecordDocuments call removed -> section 3 FAILS.
// Kill: the SUBMIT_INTENT_WORDS check removed (portalIssuedDocuments.pickRecordDocumentLinks) ->
//   sections 1 and 2 FAIL.
// Kill: handAttached removed from issuedDocumentsByTarget / fetchIssuedRecordDocuments -> 7d-7f FAIL.
// Kill: httpAttempt's allowUrl check removed (documentFetch) -> section 9 FAILS.
import "./_isolate";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { REPO } from "./_isolate";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   - ${name}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "issued-docs-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
process.env.AUTOPILOT_TEST_SEAMS = "1";
process.env.LOG_LEVEL = "error";
for (const k of ["BACKGROUND_WORKERS", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH", "CLIENT_NOTIFICATIONS", "CODE_RESEARCH", "PORTAL_FEE_READ"]) process.env[k] = "off";
for (const k of ["SMTP_HOST", "SMTP_FROM", "ANTHROPIC_API_KEY", "PORTAL_ISSUED_DOCS", "DOCUMENT_FETCH", "DOCUMENT_FETCH_BROWSER"]) delete process.env[k];
// No browser can start in this process.
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(tmp, "no-browsers");

const D = await import("../src/portalIssuedDocuments");

// ── fixtures (synthetic: numbers, names and hosts are fake) ─────────────────────────────────
const STR = "187-26-000901-STR";
const ACA = "https://aca-oregon.accela.com";
const recordUrl = (cap3: string) => `${ACA}/oregon/Cap/CapDetail.aspx?Module=Building&capID1=26CAP&capID2=00000&capID3=${cap3}&agencyCode=TESTBAY`;
const ISSUED_HREF = `${ACA}/oregon/FileUpload/FileDownload.aspx?docId=111`;
const accelaPage = (record: string, status = "Issued") => `<!doctype html><html><body>
  <div id="nav"><a href="/oregon/Login.aspx">Login</a> <a href="/oregon/Cap/CapHome.aspx?module=Building">Building Permits</a></div>
  <h1>Record ${record}: Residential Structural</h1><span>Record Status: ${status}</span>
  <p>Work Location 1 Example Way TESTBAY OR 97000</p>
  <div class="fees"><a href="/oregon/Cap/PayFees.aspx?capID=1">Pay Fees</a></div>
  <a href="/oregon/Cap/ScheduleInspection.aspx?capID=1">Schedule an Inspection</a>
  <a href="/oregon/Cap/Inspection.aspx?capID=1&action=request">Request Inspection</a>
  <a href="/oregon/Report/RenewPermit.pdf">Renew Permit (PDF)</a>
  <a href="/oregon/Report/PermitExtensionRequest.pdf">Request a permit extension (PDF)</a>
  <a href="/oregon/Report/PermitRevision.pdf?step=submit">Submit Permit Revision (PDF)</a>
  <form action="/oregon/Cap/Submit.aspx" method="post"><input type="submit" value="Submit"><button>Download Permit</button></form>
  <a href="javascript:__doPostBack('ctl00$PlaceHolderMain$DownloadPermit','')">Download Issued Permit</a>
  <table class="attachments">
    <tr><td>Issued Permit ${record}.pdf</td><td>Building</td><td><a href="/oregon/FileUpload/FileDownload.aspx?docId=111">Download</a></td></tr>
    <tr><td>Plan Review Comments.pdf</td><td>Building</td><td><a href="/oregon/FileUpload/FileDownload.aspx?docId=112">Download</a></td></tr>
    <tr><td>Permit Application.pdf</td><td>Building</td><td><a href="/oregon/FileUpload/FileDownload.aspx?docId=113">Download</a></td></tr>
  </table>
  <a href="https://pgenm.powerclerk.com/Documents/IssuedPermit.pdf">Issued permit (utility copy)</a>
  <a href="https://permits.othercity.example.gov/docs/issued-permit.pdf">Issued permit card</a>
  <a href="${ACA}/otheragency/FileUpload/FileDownload.aspx?docId=5">Issued permit (another agency on the shared instance)</a>
</body></html>`;

const PC = "https://testnm.powerclerk.com";
const APP = "APP-555123";
const nemUrl = (app: string) => `${PC}/MvcProjects/ProjectDetails?projectId=${app}`;
const LETTER_HREF = `${PC}/Documents/Download/9001`;
const powerClerkPage = (app: string) => `<!doctype html><html><body>
  <h2>Project ${app} - Interconnection Application</h2><div>Status: Approved</div>
  <a href="/Projects/${app}/Submit">Submit</a>
  <a href="/Projects/${app}/Withdraw">Withdraw Application</a>
  <a href="/Projects/${app}/Forms/EditApplication">Edit Application</a>
  <h3>Documents</h3>
  <table>
    <tr><td><a href="/Documents/Download/9001">Interconnection Approval Letter</a></td><td>PDF</td></tr>
    <tr><td><a href="/Documents/Download/9002">Sample Approval Letter Template</a></td><td>PDF</td></tr>
    <tr><td><a href="/Documents/Download/9003">Interconnection Agreement - please sign</a></td><td>PDF</td></tr>
    <tr><td><a href="/Documents/Download/9004?action=approve">Approve interconnection agreement (PDF)</a></td><td>PDF</td></tr>
    <tr><td><a href="/Documents/Download/9005?action=accept">Accept the approval letter's conditions</a></td><td>PDF</td></tr>
  </table>
  <a href="${ACA}/oregon/FileUpload/Approval-letter.pdf">Approval letter (city copy)</a>
</body></html>`;
const SIGN_IN_WALL = "<html><body><h1>PowerClerk Log In</h1><p>Username: Password: Forgot password?</p></body></html>";
const pdf = (tag: string) => new TextEncoder().encode(`%PDF-1.4\n% synthetic ${tag}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`);

// ═══ 1. THE PICKER, Accela-style ═══════════════════════════════════════════════════════════════
{
  const links = D.pickRecordDocumentLinks(accelaPage(STR), recordUrl("000A1"), "permit");
  check("1a. the issued permit's attachments row is the ONE candidate", links.length === 1 && links[0].href === ISSUED_HREF, JSON.stringify(links));
  const hrefs = links.map((l) => l.href).join(" ");
  check("1b. never Pay Fees / Schedule / Request / Renew / Extension / Submit Revision", !/PayFees|Schedule|action=request|Renew|Extension|Revision/i.test(hrefs), hrefs);
  check("1c. never a javascript postback, a form or a button", !/javascript|Submit\.aspx/i.test(hrefs), hrefs);
  check("1d. never the plan review comments or the permit application", !/docId=11[23]/.test(hrefs), hrefs);
  check("1e. never a utility host (rule 5), another city's host, or another agency's path on the shared Accela host", !/powerclerk|othercity|otheragency/.test(hrefs), hrefs);
  const skipped: string[] = [];
  D.pickRecordDocumentLinks(accelaPage(STR), recordUrl("000A1"), "permit", skipped);
  check("1f. …and those three are reported as skipped, not silently dropped",
    skipped.length === 3 && skipped.every((u) => /powerclerk|othercity|otheragency/.test(u)), JSON.stringify(skipped));
}

// ═══ 2. THE PICKER, PowerClerk-style ═══════════════════════════════════════════════════════════
{
  const links = D.pickRecordDocumentLinks(powerClerkPage(APP), nemUrl(APP), "nem");
  check("2a. the approval letter is the ONE candidate", links.length === 1 && links[0].href === LETTER_HREF, JSON.stringify(links));
  const hrefs = links.map((l) => l.href).join(" ");
  check("2b. never Submit / Withdraw / Edit / an Approve or Accept link", !/Submit|Withdraw|Edit|approve|accept/i.test(hrefs), hrefs);
  check("2c. never a sample template or a please-sign agreement", !/900[23]/.test(hrefs), hrefs);
  check("2d. never an AHJ permit portal on the NEM track (rule 5)", !/accela/.test(hrefs), hrefs);
}

// ═══ 3. THE SWEEP ════════════════════════════════════════════════════════════════════════════
const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const db = await openDatabase();

const mkProject = (ahj: string) => R.createProject(db, {
  owner: "Synthetic Owner", state: "OR", dcKw: "6.4", acKw: "5.8", street: "1 Example Way", city: "Testbay", zip: "97000", ahj, utility: "Test Power",
} as never).project;
const mkTarget = (pid: string, input: Record<string, unknown>, number: string): string => {
  const d = R.createPermitCheckTarget(db, pid, { checkFrequencyDays: 7, ...input } as never);
  return (d as unknown as { permitCheckTargets: Array<{ id: string; applicationNumber: string }> }).permitCheckTargets.find((t) => t.applicationNumber === number)!.id;
};
const due = (tid: string, when = "2020-01-01T00:00:00.000Z") => db.run("UPDATE permit_check_targets SET next_check_at = ? WHERE id = ?", [when, tid]);
const targetView = (pid: string, tid: string) => R.getProjectDetail(db, pid).permitCheckTargets.find((t) => t.id === tid)!;
const docsOf = (pid: string, type: string) => db.query<{ id: string; source: string; uploaded_by: string; original_filename: string }>(
  "SELECT id, source, uploaded_by, original_filename FROM project_documents WHERE project_id = ? AND doc_type = ?", [pid, type]);

// The seamed door: url -> response. Every URL asked is logged.
type Served = { kind: "html"; html: string; finalUrl?: string } | { kind: "pdf"; bytes: Uint8Array; finalUrl?: string };
const served = new Map<string, Served>();
const asked: string[] = [];
D.setIssuedDocumentFetchForTests(async (url) => {
  asked.push(url);
  const s = served.get(url);
  if (!s) return { ok: false, status: 404, contentType: "", via: "http", reason: "HTTP 404 (seam)", finalUrl: url };
  if (s.kind === "html") return { ok: true, status: 200, contentType: "text/html", bytes: new TextEncoder().encode(s.html), text: s.html, via: "http", reason: "ok", finalUrl: s.finalUrl ?? url };
  return { ok: true, status: 200, contentType: "application/pdf", bytes: s.bytes, via: "http", reason: "ok", finalUrl: s.finalUrl ?? url };
});
const statusText = new Map<string, string>();
R.setStatusCheckSeamsForTests({ checkStatus: async () => null, publicCheck: async (url: string) => statusText.get(url) ?? null });

const today = new Date().toISOString().slice(0, 10);
const ann = mkProject("City of Testbay");
const annUrl = recordUrl("000A1");
const annTid = mkTarget(ann.id, { targetType: "permit", permitType: "building", jurisdiction: "City of Testbay", portalName: "Oregon ePermitting", portalUrl: annUrl, applicationNumber: STR, permitNumber: STR }, STR);

// 3pre. Not issued yet: the record is never visited for documents.
statusText.set(annUrl, `Record ${STR}: Residential Structural Record Status: In Review`);
served.set(annUrl, { kind: "html", html: accelaPage(STR, "In Review") });
due(annTid);
await R.runDuePermitChecks(db, "permit");
check("3a. a record still in review is never visited for documents", asked.length === 0 && docsOf(ann.id, "issued_permit").length === 0, JSON.stringify(asked));

statusText.set(annUrl, `Record ${STR}: Residential Structural Record Status: Issued`);
served.set(annUrl, { kind: "html", html: accelaPage(STR) });
served.set(ISSUED_HREF, { kind: "pdf", bytes: pdf("issued permit 901") });
due(annTid);
await R.runDuePermitChecks(db, "permit");
const annDocs = docsOf(ann.id, "issued_permit");
check("3b. issued: ONE issued_permit document attached, source portal_record, by the permit monitor",
  annDocs.length === 1 && annDocs[0].source === "portal_record" && annDocs[0].uploaded_by === "permit monitor", JSON.stringify(annDocs));
check("3c. the seam was asked for the record page and the picked link ONLY", JSON.stringify(asked) === JSON.stringify([annUrl, ISSUED_HREF]), JSON.stringify(asked));
const annView = targetView(ann.id, annTid);
check("3d. the card's target carries the file with its provenance 'downloaded from record … on <date>'",
  annView.issuedDocuments?.length === 1 && annView.issuedDocuments[0].provenance === `downloaded from record ${STR} on ${today}`
    && annView.issuedDocuments[0].documentId === annDocs[0]?.id && !annView.issuedDocsGap, JSON.stringify(annView.issuedDocuments));
check("3e. an audit row names the record and the source URL",
  db.query<{ details: string }>("SELECT details FROM audit_logs WHERE project_id = ? AND action = 'permit_target.issued_document'", [ann.id])
    .some((r) => r.details.includes(STR) && r.details.includes("docId=111")));
check("3f. the documents list shows it under its slot", R.getProjectDetail(db, ann.id) !== null && docsOf(ann.id, "issued_permit")[0]?.original_filename.length > 0);

// ═══ 4. IDEMPOTENT ═══════════════════════════════════════════════════════════════════════════
{
  asked.length = 0;
  due(annTid);
  await R.runDuePermitChecks(db, "permit");
  check("4a. a re-sweep attaches no second copy and does not even re-visit", docsOf(ann.id, "issued_permit").length === 1 && asked.length === 0, JSON.stringify(asked));
  // A person deletes it, then a forced re-read: the same bytes are not pushed back.
  db.run("DELETE FROM project_documents WHERE id = ?", [annDocs[0].id]);
  const r = await D.fetchIssuedRecordDocuments(db, ann, annTid, { force: true });
  check("4b. a file a person deleted is not downloaded back, and the record is not re-visited for it",
    docsOf(ann.id, "issued_permit").length === 0 && r.status === "already_attached" && asked.length === 0, JSON.stringify({ r, asked }));

  // A person had already attached the very same permit by hand.
  const bob = mkProject("City of Testbay");
  const bobRec = "187-26-000902-STR";
  const bobUrl = recordUrl("000B2");
  const bobTid = mkTarget(bob.id, { targetType: "permit", permitType: "building", jurisdiction: "City of Testbay", portalUrl: bobUrl, applicationNumber: bobRec, permitNumber: bobRec }, bobRec);
  const { saveProjectDocument } = await import("../src/projectDocuments");
  const same = pdf("issued permit 902");
  saveProjectDocument(db, bob.id, { docType: "issued_permit", filename: "permit-by-hand.pdf", contentType: "application/pdf", buffer: Buffer.from(same), source: "upload" });
  await R.recordPermitStatusCheck(db, bob.id, { targetId: bobTid, source: "manual", rawStatusText: "Record Status: Issued" });
  served.set(bobUrl, { kind: "html", html: accelaPage(bobRec) });
  served.set(ISSUED_HREF, { kind: "pdf", bytes: same });
  const rb = await D.fetchIssuedRecordDocuments(db, bob, bobTid, { force: true });
  check("4c. a permit a person already attached is not attached a second time", docsOf(bob.id, "issued_permit").length === 1 && rb.status === "already_attached", JSON.stringify(rb));
}

// ═══ 5. NEM ══════════════════════════════════════════════════════════════════════════════════
const cy = mkProject("City of Testbay");
const cyTid = mkTarget(cy.id, { targetType: "nem", permitType: "nem", jurisdiction: "Test Power", portalName: "PowerClerk", portalUrl: nemUrl(APP), applicationNumber: APP }, APP);
{
  await R.recordPermitStatusCheck(db, cy.id, { targetId: cyTid, source: "manual", rawStatusText: "Approved" });
  check("5pre. the NEM target reads approved", targetView(cy.id, cyTid).latestOutcome === "nem_approved", String(targetView(cy.id, cyTid).latestOutcome));
  served.set(nemUrl(APP), { kind: "html", html: powerClerkPage(APP) });
  served.set(LETTER_HREF, { kind: "pdf", bytes: pdf("approval letter 555123") });
  asked.length = 0;
  const r = await D.fetchIssuedRecordDocuments(db, cy, cyTid);
  const docs = docsOf(cy.id, "utility_approval");
  check("5a. approved: ONE utility_approval document attached", r.status === "attached" && docs.length === 1 && docs[0].source === "portal_record", JSON.stringify({ r, docs }));
  check("5b. only the record page and the approval letter were requested", JSON.stringify(asked) === JSON.stringify([nemUrl(APP), LETTER_HREF]), JSON.stringify(asked));
  check("5c. provenance on the card", targetView(cy.id, cyTid).issuedDocuments?.[0]?.provenance === `downloaded from record ${APP} on ${today}`);
}

// ═══ 6. SAYS WHY ═════════════════════════════════════════════════════════════════════════════
const gapCase = async (label: string, setup: (url: string, rec: string) => void, expect: RegExp, track: "permit" | "nem" = "permit") => {
  const p = mkProject("City of Testbay");
  const rec = track === "nem" ? `APP-55${Math.floor(Math.random() * 9000 + 1000)}` : `187-26-00${Math.floor(Math.random() * 9000 + 1000)}-STR`;
  const url = track === "nem" ? nemUrl(rec) : recordUrl(`0${Math.floor(Math.random() * 9000 + 1000)}`);
  const tid = mkTarget(p.id, track === "nem"
    ? { targetType: "nem", permitType: "nem", jurisdiction: "Test Power", portalUrl: url, applicationNumber: rec }
    : { targetType: "permit", permitType: "building", jurisdiction: "City of Testbay", portalUrl: url, applicationNumber: rec, permitNumber: rec }, rec);
  await R.recordPermitStatusCheck(db, p.id, { targetId: tid, source: "manual", rawStatusText: track === "nem" ? "Approved" : "Record Status: Issued" });
  setup(url, rec);
  const r = await D.fetchIssuedRecordDocuments(db, p, tid, { force: true });
  const view = targetView(p.id, tid);
  const anyDoc = db.query("SELECT 1 FROM project_documents WHERE project_id = ?", [p.id]).length;
  check(`6. ${label}: nothing attached, and the card says why`, r.status === "nothing_attached" && anyDoc === 0 && expect.test(view.issuedDocsGap ?? ""), `${r.status} gap=${view.issuedDocsGap}`);
  return { p, tid };
};
const walled = await gapCase("a sign-in wall", (url) => served.set(url, { kind: "html", html: SIGN_IN_WALL }), /sign-in/i, "nem");
await gapCase("a page naming another record", (url) => served.set(url, { kind: "html", html: accelaPage("187-26-000999-STR") }), /does not name record/);
await gapCase("a link answering a web page", (url, rec) => {
  const href = `${ACA}/oregon/FileUpload/FileDownload.aspx?docId=777`;
  served.set(url, { kind: "html", html: accelaPage(rec).replace("docId=111", "docId=777") });
  served.set(href, { kind: "html", html: "<html><body>Session expired</body></html>" });
}, /not a PDF or an image/);
await gapCase("a download that redirected off the record's portal", (url, rec) => {
  const href = `${ACA}/oregon/FileUpload/FileDownload.aspx?docId=778`;
  served.set(url, { kind: "html", html: accelaPage(rec).replace("docId=111", "docId=778") });
  served.set(href, { kind: "pdf", bytes: pdf("off-portal"), finalUrl: "https://files.elsewhere.example.com/permit.pdf" });
}, /Refused: ended at https:\/\/files\.elsewhere/);
await gapCase("a record page whose only permit links leave its portal (said so, hosts named)", (url, rec) => {
  served.set(url, { kind: "html", html: accelaPage(rec).replace(/<table class="attachments">[\s\S]*?<\/table>/, "") });
}, /lists no downloadable issued permit.*Skipped 3 link\(s\) that leave the record's portal or its track: pgenm\.powerclerk\.com, permits\.othercity\.example\.gov, aca-oregon\.accela\.com/);
{
  // A NEM filing whose only URL is an AHJ permit portal is not a record on its track (rule 5).
  const p = mkProject("City of Testbay");
  db.run("INSERT INTO permit_check_targets (id, project_id, jurisdiction, portal_name, portal_url, application_number, permit_number, check_frequency_days, active, target_type, permit_type, latest_outcome, created_at, updated_at) VALUES (?, ?, 'Test Power', '', ?, 'APP-1', '', 7, 1, 'nem', 'nem', 'nem_approved', ?, ?)",
    ["tid-rule5", p.id, recordUrl("000R5"), new Date().toISOString(), new Date().toISOString()]);
  asked.length = 0;
  const r = await D.fetchIssuedRecordDocuments(db, p, "tid-rule5", { force: true });
  check("6. a NEM target bound to an AHJ permit portal is never visited (rule 5)", r.status === "nothing_attached" && asked.length === 0 && /No record link/.test(r.reason ?? ""), `${r.status} ${r.reason} ${JSON.stringify(asked)}`);
}

// ═══ 7. THE HANDOFF PACKET ═══════════════════════════════════════════════════════════════════
{
  const packet = R.getProjectHandoffPacket(db, cy.id);
  const section = packet.sections.find((s) => s.title === "Issued Permit & Approval Letter");
  check("7a. the closeout section lists the letter with its provenance; complete",
    !!section && section.severity === "pass" && section.lines.some((l) => l.includes(`downloaded from record ${APP} on ${today}`)) && packet.closeoutDocumentsComplete === true,
    JSON.stringify(section));
  check("7b. …and the packet text carries it", packet.reportText.includes("Issued Permit & Approval Letter - PASS"));
  const missing = R.getProjectHandoffPacket(db, walled.p.id);
  const ms = missing.sections.find((s) => s.title === "Issued Permit & Approval Letter");
  check("7c. a finished filing with no letter on file: warning, says why, not complete",
    !!ms && ms.severity === "warning" && ms.lines.some((l) => /not on file — .*sign-in/i.test(l)) && missing.closeoutDocumentsComplete === false, JSON.stringify(ms));
}

// ═══ 7b. THE SIGN-IN WALL, THEN THE PERSON ATTACHES IT BY HAND ═══════════════════════════════
{
  const { saveProjectDocument } = await import("../src/projectDocuments");
  saveProjectDocument(db, walled.p.id, { docType: "utility_approval", filename: "approval-letter.pdf", contentType: "application/pdf", buffer: Buffer.from(pdf("by hand")), source: "upload", uploadedBy: "Synthetic PM" });
  const view = targetView(walled.p.id, walled.tid);
  check("7d. a letter a person attached under the slot is the card's closeout document: 'attached by … on <date>', no gap",
    view.issuedDocuments?.length === 1 && view.issuedDocuments[0].provenance === `attached by Synthetic PM on ${today}` && !view.issuedDocsGap,
    JSON.stringify({ docs: view.issuedDocuments, gap: view.issuedDocsGap }));
  const packet = R.getProjectHandoffPacket(db, walled.p.id);
  const sec = packet.sections.find((s) => s.title === "Issued Permit & Approval Letter");
  check("7e. …the handoff packet counts it: pass, complete",
    !!sec && sec.severity === "pass" && sec.lines.some((l) => l.includes(`attached by Synthetic PM on ${today}`)) && packet.closeoutDocumentsComplete === true, JSON.stringify(sec));
  asked.length = 0;
  const r = await D.fetchIssuedRecordDocuments(db, walled.p, walled.tid, { force: true });
  const stored = db.get<{ issued_docs_gap: string }>("SELECT issued_docs_gap FROM permit_check_targets WHERE id = ?", [walled.tid]);
  check("7f. …and a re-read neither visits the record nor writes the gap back", r.status === "already_attached" && asked.length === 0 && stored?.issued_docs_gap === "",
    JSON.stringify({ r, asked, stored }));
  check("7g. a file the MONITOR downloaded is never re-labelled as attached by a person",
    targetView(cy.id, cyTid).issuedDocuments?.length === 1 && targetView(cy.id, cyTid).issuedDocuments![0].provenance.startsWith("downloaded from record"));
  const html = fs.readFileSync(path.join(REPO, "frontend", "dashboard.html"), "utf8");
  check("7h. the upload picker offers both slots, so the by-hand path has somewhere to land",
    /<option value="issued_permit">/.test(html) && /<option value="utility_approval">/.test(html));
}

// ═══ 8. THE CARD ═════════════════════════════════════════════════════════════════════════════
{
  const dashboard = fs.readFileSync(path.join(REPO, "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
  const cut = (name: string): string => {
    const m = new RegExp(`^function ${name}\\(`, "m").exec(dashboard);
    if (!m) throw new Error(`dashboard.js: could not find function ${name}`);
    const open = dashboard.indexOf("{", dashboard.indexOf(")", m.index));
    let depth = 0;
    for (let j = open; j < dashboard.length; j++) {
      if (dashboard[j] === "{") depth++;
      else if (dashboard[j] === "}") { depth--; if (depth === 0) return dashboard.slice(m.index, j + 1); }
    }
    throw new Error(`dashboard.js: unbalanced ${name}`);
  };
  const render = new Function(`${cut("esc")}\n${cut("issuedDocumentsHtml")}\nreturn issuedDocumentsHtml;`)() as (t: unknown) => string;
  const withDoc = render({ projectId: "p<1>", targetType: "permit", issuedDocuments: [{ documentId: "d1", filename: "<script>x</script>.pdf", provenance: `downloaded from record ${STR} on ${today}` }] });
  check("8a. the card links the file and shows its provenance", /Issued permit:/.test(withDoc) && withDoc.includes("/api/projects/p%3C1%3E/documents/d1") && withDoc.includes(`downloaded from record ${STR} on ${today}`), withDoc);
  check("8b. …escaped", !withDoc.includes("<script>") && withDoc.includes("&lt;script&gt;"), withDoc);
  const gap = render({ projectId: "p1", targetType: "nem", issuedDocsGap: "The record page asks for a sign-in <b>" });
  check("8c. no file: the gap line, escaped", /Approval letter not on file:/.test(gap) && gap.includes("&lt;b&gt;") && !gap.includes("<b>"), gap);
  check("8d. nothing to say: nothing rendered", render({ projectId: "p1", targetType: "permit" }) === "");
  check("8e. the card calls it", /\$\{issuedDocumentsHtml\(target\)\}/.test(cut("permitTargetCardHtml")));
}

// ═══ 9. THE REAL DOOR: documentFetch allowUrl ═══════════════════════════════════════════════
{
  D.setIssuedDocumentFetchForTests(null);
  let otherHits = 0;
  const other = http.createServer((_req, res) => { otherHits++; res.writeHead(200, { "content-type": "application/pdf" }); res.end("%PDF-1.4 other"); });
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", () => r()));
  const OTHER = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  const home = http.createServer((req, res) => {
    if (req.url === "/hop") { res.writeHead(302, { location: `${OTHER}/permit.pdf` }); res.end(); return; }
    if (req.url === "/walled.pdf") { res.writeHead(403, { "content-type": "text/html", server: "AkamaiGHost" }); res.end(""); return; }
    res.writeHead(200, { "content-type": "application/pdf" }); res.end("%PDF-1.4 home");
  });
  await new Promise<void>((r) => home.listen(0, "127.0.0.1", () => r()));
  const HOME = `http://127.0.0.1:${(home.address() as AddressInfo).port}`;
  process.env.DOCUMENT_FETCH_ALLOW_ORIGINS = `${HOME},${OTHER}`;
  const { fetchPublicDocument } = await import("../src/documentFetch");
  const onlyHome = (u: string) => (u.startsWith(`${HOME}/`) ? null : `${u} is not the record's own portal`);
  const control = await fetchPublicDocument(`${HOME}/hop`, { allowBrowser: false });
  check("9a. control: without allowUrl the redirect is followed to the other origin", control.ok && otherHits === 1, `${control.reason} hits=${otherHits}`);
  otherHits = 0;
  const got = await fetchPublicDocument(`${HOME}/hop`, { allowBrowser: false, allowUrl: onlyHome });
  check("9b. a redirect hop the caller's door refuses is never requested", !got.ok && otherHits === 0 && /Refused: .*redirected to .*not the record's own portal/.test(got.reason), `${got.reason} hits=${otherHits}`);
  check("9c. …and it is not reported as a private address", !got.privateTarget);
  let launches = 0;
  const launcher = async () => { launches++; throw new Error("fake launcher"); };
  await fetchPublicDocument(`${HOME}/walled.pdf`, { launcher } as never);
  check("9d. control: a 403 reaches the browser rung by default", launches === 1, `launches=${launches}`);
  launches = 0;
  await fetchPublicDocument(`${HOME}/walled.pdf`, { launcher, allowUrl: onlyHome } as never);
  check("9e. allowUrl forbids the browser rung (a window follows its own redirects)", launches === 0, `launches=${launches}`);
  other.close();
  home.close();
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall issued-document checks passed");
process.exit(0);
