// ---------------------------------------------------------------------------
// EMAIL-IN INTAKE (#489, owner request #485).
//
// Every job used to start with a person uploading the plan set and bill in the Parser and
// pressing Save to project. Now an installer can email the job to the intake address with their
// tag — intake+acme@… — and the server creates the project, attaches the files, runs the same
// extraction and local chain as the Parser path, and replies with the project's status link and
// what is still missing. Anything it cannot place waits on the unsorted intake list for a person.
//
// WHICH MESSAGES. Only mail addressed to EMAIL_INTAKE_ADDRESS (To, Cc, Delivered-To or
// X-Original-To), with or without a +tag. That address is distinct from the status-tracking
// tags (permits+acme@…): the poller hands intake mail here and never to the status tracker, and
// mail to any other address never reaches this module. Unset = intake is off.
//
// WHICH CLIENT (rule 6). The tag picks the client (clients.intake_tag), and the org is that
// client's org — never anything the message text or the plan set says. The sender must be one of
// that client's own addresses (contact, business, updates, billing) or an entry an operator added
// to clients.intake_senders; anything else is unsorted, never filed on a guessed client. A
// message whose DMARC result is a fail is unsorted too. A plan set whose licence number binds to
// a DIFFERENT client (the parser's exact-CCB auto-assign) is unsorted rather than filed under
// either. A per-client IMAP source (a DB row) only ever matches clients in its own org.
//
// WHICH FILES. Each attachment is sniffed by its bytes (fileTypes.ts) and saved through the same
// saveProjectDocument the documents route uses, so the same type checks apply; a refused file is
// listed in the reply and never drops the others (compare #311). Inline signature images are not
// attachments and are skipped.
//
// THE PARSE. The documents' text is read on the server (batchImport.extractPdfText) and handed to
// extractParserFields — the function behind /api/parser/llm-extract, not a copy. A field the
// model flagged as low-confidence is NOT written (a doubt never becomes a fact on an application);
// it is named in the reply as something we will confirm. Then the project is created exactly as
// the Parser's save creates it (createProject) and the local chain is queued (enqueueStageSteps),
// which splits the plan set and reads a photographed bill as it does for any project.
//
// SAME JOB TWICE. The same street address (and ZIP, when both have one) for the same client within
// EMAIL_INTAKE_DEDUPE_DAYS (default 30) attaches the files to that project instead of making a
// second one; a file already on it (same slot, name and size) is not added again. The same MESSAGE
// is never processed twice: every message is recorded by its Message-ID (else a hash of it), and
// the IMAP poller re-reads the newest messages every tick.
//
// RULE 2. Reading the customer's own bill at intake is the one allowed read: its text goes to the
// extraction, as on the Parser page. Nothing is logged from it, and the reply never carries the
// account or meter number (labels only, then redactSecretValues with the project's own values).
// The email's own body is never sent to a model.
//
// THE REPLY. Only to a known sender, only once a project was created or attached, to the From
// address (never Reply-To). SMTP_HOST + SMTP_FROM set and PUBLIC_BASE_URL set → sent; otherwise a
// DRAFT communication on the project, like every other client email. EMAIL_INTAKE_AUTO_REPLY=off
// or CLIENT_NOTIFICATIONS=off keeps it a draft.
// ---------------------------------------------------------------------------
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Attachment, ParsedMail } from "mailparser";
import type { AppDb } from "./db";
import { DEFAULT_ORG_ID } from "./db";
import type {
  EmailIntakeFile, EmailIntakeReason, EmailIntakeRunResult, EmailIntakeStatus, EmailIntakeView,
  ParserExtractionResponse, ParserPayload, ProjectRecord,
} from "../../shared/src/types";
import { redactSecretValues } from "../../shared/src/portalSafety";
import { addAuditLog } from "./audit";
import { enqueueStageSteps } from "./autoStageSteps";
import { classifyDoc, extractPdfText } from "./batchImport";
import { BRAND } from "./clientUpdates";
import { ensureStatusShareToken, formatProjectAddress, sendEmail, smtpConfigured, statusShareUrl } from "./clientNotifier";
import { addCommunication } from "./crm";
import { describeKind, isImageKind, looksLikeCad, sniffFileKind } from "./fileTypes";
import { HttpError } from "./httpError";
import { id } from "./ids";
import { text } from "./json";
import { logger } from "./logger";
import { normalizeProject, normalizeTokens } from "./normalize";
import { saveProjectDocument } from "./projectDocuments";
import { createProject, getProjectDetail } from "./repository";
import { backendDataDir } from "./statePaths";
import { nowIso } from "./time";

type Row = Record<string, unknown>;
const ACTOR = "email intake";
const MAX_FILES = 20;

export type IntakeSender = (to: string, subject: string, body: string) => Promise<void>;
export type IntakeExtractor = (input: { planText: string; utilityBillText: string; structuralLetterText: string }, orgId: string) => Promise<ParserExtractionResponse>;

export interface IntakeOptions {
  /** Org of the polling source. A DB-row IMAP source passes its org and `restrictToOrg`; the
   *  central (env) inbox and Gmail are operator-level and match a tag in any org. */
  sourceOrgId?: string;
  restrictToOrg?: boolean;
  /** Test doors: the model read and the mail send. Production uses extractParserFields / SMTP. */
  extract?: IntakeExtractor;
  send?: IntakeSender;
}

// ---------------------------------------------------------------------------
// The intake address.
// ---------------------------------------------------------------------------

export function intakeAddressSetting(): { local: string; domain: string } | null {
  const m = /^([^@\s+]+)@([^@\s]+)$/.exec(String(process.env.EMAIL_INTAKE_ADDRESS ?? "").trim().toLowerCase());
  return m ? { local: m[1], domain: m[2] } : null;
}

/** Intake is configured (EMAIL_INTAKE_ADDRESS is an address). */
export function intakeEnabled(): boolean {
  return intakeAddressSetting() !== null;
}

/** The tag an intake recipient carries: "" for the bare intake address, null when no recipient is
 *  the intake address at all. A tagged recipient wins over a bare one. */
export function intakeTagFrom(recipients: string[], addr = intakeAddressSetting()): string | null {
  if (!addr) return null;
  let found: string | null = null;
  for (const r of recipients) {
    const m = /^([^@\s]+)@([^@\s]+)$/.exec(String(r).trim().toLowerCase());
    if (!m || m[2] !== addr.domain) continue;
    const [base, ...tagParts] = m[1].split("+");
    if (base !== addr.local) continue;
    const tag = tagParts.join("+");
    if (tag) return tag;
    found = "";
  }
  return found;
}

const ADDRESS_RE = /[^\s<>,;:"'()[\]]+@[^\s<>,;:"'()[\]]+/g;

/** A header as plain text, whatever shape mailparser gave it (a string, an address object, a
 *  structured { value } header, or an array of those when the header repeats). */
function headerText(parsed: ParsedMail, name: string): string {
  const flat = (v: unknown): string => {
    if (v == null) return "";
    if (Array.isArray(v)) return v.map(flat).join(" ");
    if (typeof v === "object") {
      const o = v as { text?: unknown; value?: unknown };
      return o.text != null ? String(o.text) : flat(o.value);
    }
    return String(v);
  };
  return flat(parsed.headers?.get(name) as unknown);
}

/** Every address the message was delivered to: To, Cc, and the Delivered-To / X-Original-To a
 *  server adds (the only trace of a Bcc). */
export function messageRecipients(parsed: ParsedMail): string[] {
  const out: string[] = [];
  for (const field of [parsed.to, parsed.cc]) {
    for (const obj of field ? (Array.isArray(field) ? field : [field]) : []) {
      for (const a of obj.value ?? []) if (a.address) out.push(a.address);
    }
  }
  for (const name of ["delivered-to", "x-original-to"]) out.push(...(headerText(parsed, name).match(ADDRESS_RE) ?? []));
  return out.map((a) => a.toLowerCase());
}

/** Is this parsed message addressed to the intake address? */
export function isIntakeMessage(parsed: ParsedMail): boolean {
  return intakeTagFrom(messageRecipients(parsed)) !== null;
}

// ---------------------------------------------------------------------------
// Client and sender.
// ---------------------------------------------------------------------------

interface ClientRow {
  id: string; org_id: string; company_name: string;
  contact_email: string; business_email: string; updates_inbox: string; billing_contact_email: string; intake_senders: string;
}

function clientsForTag(db: AppDb, tag: string, opts: IntakeOptions): ClientRow[] {
  const sql = "SELECT id, org_id, company_name, contact_email, business_email, updates_inbox, billing_contact_email, intake_senders FROM clients WHERE intake_tag = ?";
  return opts.restrictToOrg
    ? db.query<ClientRow>(`${sql} AND org_id = ?`, [tag, opts.sourceOrgId || DEFAULT_ORG_ID])
    : db.query<ClientRow>(sql, [tag]);
}

/** The client's own addresses plus its intake_senders entries ("@domain" allows a whole domain). */
export function senderIsKnown(client: Pick<ClientRow, "contact_email" | "business_email" | "updates_inbox" | "billing_contact_email" | "intake_senders">, sender: string): boolean {
  const from = sender.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(from)) return false;
  const entries = [client.contact_email, client.business_email, client.updates_inbox, client.billing_contact_email, ...String(client.intake_senders || "").split(/[\s,;]+/)]
    .map((e) => String(e || "").trim().toLowerCase())
    .filter(Boolean);
  const domain = from.slice(from.lastIndexOf("@"));
  return entries.some((e) => (e.startsWith("@") ? e === domain : e === from));
}

/** DMARC said the From domain did not send this. Only a stated fail counts: plenty of honest mail
 *  passes through servers that add no Authentication-Results at all. */
function dmarcFailed(parsed: ParsedMail): boolean {
  return /\bdmarc=fail\b/i.test(headerText(parsed, "authentication-results"));
}

// ---------------------------------------------------------------------------
// Attachments.
// ---------------------------------------------------------------------------

interface WorkingFile extends EmailIntakeFile {
  content: Buffer;
  kind: string;
  pdfText: string;
}

function maxFileBytes(): number {
  const mb = Number(process.env.EMAIL_INTAKE_MAX_FILE_MB || 100);
  return (Number.isFinite(mb) && mb > 0 ? mb : 100) * 1024 * 1024;
}

/** The message's real attachments: an inline image a signature or a quoted reply embeds
 *  (cid:, multipart/related) is part of the body, not a file the installer sent. */
function realAttachments(parsed: ParsedMail): Attachment[] {
  return (parsed.attachments ?? []).filter((a) => !(a.related || (a.contentDisposition === "inline" && a.cid && /^image\//i.test(a.contentType || ""))));
}

async function pdfTextOf(content: Buffer): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "email-intake-"));
  try {
    const file = path.join(dir, "doc.pdf");
    fs.writeFileSync(file, content);
    return await extractPdfText(file, 60);
  } catch {
    return ""; // an encrypted or broken PDF reads as a scan: kept, never parsed
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Sniff, refuse what no slot can take, read each PDF's text, and give every usable file a slot. */
async function sortAttachments(attachments: Attachment[]): Promise<WorkingFile[]> {
  const files: WorkingFile[] = [];
  for (const [i, a] of attachments.entries()) {
    const name = (a.filename || `attachment-${i + 1}`).trim().slice(0, 200);
    const content = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content ?? []);
    const kind = sniffFileKind(content);
    const f: WorkingFile = { name, size: content.length, content, kind, pdfText: "" };
    if (i >= MAX_FILES) f.refused = `More than ${MAX_FILES} attachments; send the rest in another email.`;
    else if (!content.length) f.refused = "The file is empty.";
    else if (content.length > maxFileBytes()) f.refused = `Larger than ${Math.round(maxFileBytes() / 1024 / 1024)} MB.`;
    else if (looksLikeCad(name, kind)) f.refused = "A CAD drawing, not a submittable document: export the plan set to PDF and send that.";
    else if (kind !== "pdf" && !isImageKind(kind)) f.refused = `${describeKind(kind, name)}, not a PDF or a photo.`;
    else if (kind === "pdf") f.pdfText = await pdfTextOf(content);
    files.push(f);
  }
  const usable = files.filter((f) => !f.refused);
  const base = (f: WorkingFile) => path.basename(f.name, path.extname(f.name));
  for (const f of usable) {
    if (/meter/i.test(base(f)) && !/bill|statement/i.test(base(f))) f.docType = "meter_photo";
    else if (f.kind === "pdf" ? classifyDoc(f.name, f.pdfText) === "utility_bill" : /bill|statement|invoice|account/i.test(base(f))) f.docType = "utility_bill";
    else if (f.kind === "pdf" && /struct|engineer|stamp|letter|calc/i.test(base(f))) f.docType = "structural_letter";
  }
  // THE PLAN SET is the PDF with the most text among those not yet placed (a scan has none: then
  // the largest one). Every other PDF is kept as "other"; an image nobody named stays a "photo" —
  // guessing a photo is the bill would hand a meter shot to the bill reader.
  const pdfs = usable.filter((f) => f.kind === "pdf" && !f.docType);
  const plan = pdfs.sort((a, b) => b.pdfText.length - a.pdfText.length || b.size - a.size)[0];
  if (plan) plan.docType = "plan_set";
  for (const f of usable) if (!f.docType) f.docType = f.kind === "pdf" ? "other" : "photo";
  return files;
}

// ---------------------------------------------------------------------------
// The parse → project payload.
// ---------------------------------------------------------------------------

/** The plan set's contractor block is a client SUGGESTION on the Parser page, never project data;
 *  structureDescription is a person's answer there (parser.html applyExtraction). */
const NOT_PROJECT_FIELDS = new Set([
  "contractorCompany", "contractorCcb", "contractorElectricalLicense", "contractorMetroCityLicense", "contractorAddress",
  "contractorPhone", "contractorEmail", "contractorSupervisor", "contractorElectricianLicense", "structureDescription",
]);

/** Every confident extracted value, keyed by the parser's own field ids (normalizeProject reads
 *  them). Low-confidence fields are left out and returned as `unsure`. */
export function payloadFromExtraction(extraction: Pick<ParserExtractionResponse, "fields" | "lowConfidenceFields">): { payload: ParserPayload; unsure: string[] } {
  const payload: ParserPayload = {};
  const unsure: string[] = [];
  const low = new Set(extraction.lowConfidenceFields ?? []);
  for (const [key, field] of Object.entries(extraction.fields ?? {})) {
    if (NOT_PROJECT_FIELDS.has(key)) continue;
    const value = field?.value;
    if (value == null || value === "" || (Array.isArray(value) && !value.length)) continue;
    if (low.has(key)) { unsure.push(key); continue; }
    payload[key] = value as ParserPayload[string];
  }
  return { payload, unsure };
}

/** The street line, normalised: what "the same address" compares. */
function streetKey(address: string): string {
  return normalizeTokens(String(address || "").split(",")[0]);
}

function dedupeDays(): number {
  const n = Number(process.env.EMAIL_INTAKE_DEDUPE_DAYS || 30);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

/** The client's project at the same street (and ZIP when both have one) created within the window. */
export function recentProjectAtAddress(db: AppDb, orgId: string, clientId: string, project: Pick<ProjectRecord, "projectAddress" | "zip">): string | null {
  const key = streetKey(project.projectAddress);
  if (!key) return null;
  const since = new Date(Date.now() - dedupeDays() * 86_400_000).toISOString();
  const rows = db.query<Row>(
    `SELECT id, project_address, zip FROM projects
     WHERE org_id = ? AND client_id = ? AND created_at >= ? AND COALESCE(archived_at, '') = ''
     ORDER BY created_at DESC`,
    [orgId, clientId, since],
  );
  const zip = String(project.zip || "").trim();
  const hit = rows.find((r) => streetKey(text(r.project_address)) === key && (!zip || !text(r.zip).trim() || text(r.zip).trim() === zip));
  return hit ? text(hit.id) : null;
}

// ---------------------------------------------------------------------------
// Records.
// ---------------------------------------------------------------------------

const REASON_TEXT: Record<EmailIntakeReason, string> = {
  no_tag: "Sent to the intake address without a client tag (intake+<tag>@…), so no client could be chosen.",
  unknown_tag: "No client has this intake tag.",
  ambiguous_tag: "More than one client has this intake tag.",
  unknown_sender: "The sender is not one of this client's addresses. Add it to the client's intake senders if it should be.",
  sender_not_authenticated: "The sender's domain failed its DMARC check, so the From address cannot be trusted.",
  no_usable_attachments: "None of the attachments is a PDF or a photo we can use.",
  address_unreadable: "The project address could not be read from the documents (a scanned plan set, or no plan set). Open the files in the Parser.",
  plan_set_names_another_client: "The plan set's licence number belongs to a different client than the tag.",
  failed: "Processing failed; the files are kept here.",
};

function intakeDir(rowId: string): string {
  return path.join(backendDataDir(), "email-intake", rowId);
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "file";
}

interface StoredFile extends EmailIntakeFile { stored?: string }

function mapRow(row: Row): EmailIntakeView {
  let files: StoredFile[] = [];
  try { files = JSON.parse(text(row.files_json) || "[]"); } catch { files = []; }
  const reason = text(row.reason) as EmailIntakeReason | "";
  return {
    id: text(row.id),
    status: text(row.status) as EmailIntakeStatus,
    reason,
    reasonText: reason ? REASON_TEXT[reason] ?? reason : "",
    sender: text(row.sender),
    intakeTag: text(row.intake_tag),
    subject: text(row.subject),
    clientId: text(row.client_id) || null,
    projectId: text(row.project_id) || null,
    files: files.map(({ stored: _stored, ...f }) => f),
    replyStatus: text(row.reply_status),
    receivedAt: text(row.received_at),
    createdAt: text(row.created_at),
  };
}

function insertRow(db: AppDb, row: {
  id: string; key: string; orgId: string; clientId: string | null; projectId: string | null; status: EmailIntakeStatus;
  reason: EmailIntakeReason | ""; sender: string; tag: string; subject: string; files: StoredFile[]; replyStatus: string; receivedAt: string;
}): EmailIntakeView {
  db.run(
    `INSERT INTO email_intake_messages
       (id, message_key, org_id, client_id, project_id, status, reason, sender, intake_tag, subject, files_json, reply_status, received_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.key, row.orgId, row.clientId, row.projectId, row.status, row.reason, row.sender.slice(0, 320), row.tag.slice(0, 80),
      row.subject.slice(0, 240), JSON.stringify(row.files), row.replyStatus, row.receivedAt, nowIso()],
  );
  return mapRow(db.get<Row>("SELECT * FROM email_intake_messages WHERE id = ?", [row.id])!);
}

/** Keep an unplaced message's attachments for the person who will place it. */
function keepFiles(rowId: string, attachments: Attachment[], working: WorkingFile[] | null): StoredFile[] {
  if (!attachments.length) return [];
  const dir = intakeDir(rowId);
  fs.mkdirSync(dir, { recursive: true });
  return attachments.slice(0, MAX_FILES).map((a, i) => {
    const w = working?.[i];
    const name = w?.name ?? (a.filename || `attachment-${i + 1}`).slice(0, 200);
    const content = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content ?? []);
    const out: StoredFile = { name, size: content.length, ...(w?.docType ? { docType: w.docType } : {}), ...(w?.refused ? { refused: w.refused } : {}) };
    if (content.length && content.length <= maxFileBytes()) {
      const stored = path.join(dir, `${i + 1}-${safeName(name)}`);
      fs.writeFileSync(stored, content);
      out.stored = stored;
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// The reply.
// ---------------------------------------------------------------------------

const FIELD_LABELS: Record<string, string> = {
  owner: "Homeowner name", street: "Project address", city: "City", state: "State", zip: "ZIP", ahj: "Permitting jurisdiction (AHJ)",
  utility: "Utility", account: "Utility account number", meter: "Meter number", dcKw: "System size (DC kW)", acKw: "System size (AC kW)",
  moduleMake: "Module make", moduleModel: "Module model", moduleQty: "Module count", invMake: "Inverter make", invModel: "Inverter model",
};

export function intakeReplyEmail(input: {
  project: ProjectRecord; attached: boolean; link: string; missing: string[]; unsure: string[]; refused: EmailIntakeFile[];
}): { subject: string; body: string } {
  const address = formatProjectAddress(input.project) || "your job";
  const lines = [
    "Hello,",
    "",
    input.attached
      ? `We received your email for ${address} and added the files to the project we already have for that address.`
      : `We received your email for ${address} and started a new project for it.`,
    "",
    `Live status page (no login needed): ${input.link}`,
  ];
  if (input.missing.length) lines.push("", "Still needed — reply with these, or send them in a new email to the same address:", ...input.missing.map((m) => `  • ${m}`));
  if (input.unsure.length) lines.push("", "We will double-check these against your documents before anything is filed:", ...input.unsure.map((u) => `  • ${u}`));
  if (input.refused.length) lines.push("", "Files we could not use:", ...input.refused.map((f) => `  • ${f.name}: ${f.refused}`));
  lines.push("", "Thank you,", BRAND);
  const secrets = [String(input.project.accountNumber ?? ""), String(input.project.meterNumber ?? "")];
  return {
    subject: redactSecretValues(`Received: ${address}`, secrets),
    body: redactSecretValues(lines.join("\n"), secrets),
  };
}

function autoReplyOff(): string {
  if (/^(0|false|off)$/i.test(String(process.env.EMAIL_INTAKE_AUTO_REPLY ?? "").trim())) return "EMAIL_INTAKE_AUTO_REPLY is off, so no send was attempted.";
  if (/^(0|false|off)$/i.test(String(process.env.CLIENT_NOTIFICATIONS ?? "").trim())) return "CLIENT_NOTIFICATIONS is off, so no send was attempted.";
  return "";
}

async function reply(db: AppDb, input: { project: ProjectRecord; orgId: string; to: string; subject: string; body: string }, opts: IntakeOptions): Promise<string> {
  let status: "sent" | "draft" | "failed" = "draft";
  let detail = autoReplyOff();
  if (detail) { /* stays a draft */ }
  else if (!String(process.env.PUBLIC_BASE_URL ?? "").trim()) detail = "PUBLIC_BASE_URL is not set, so the status link would point at this machine; nothing was sent.";
  else if (!opts.send && !smtpConfigured()) detail = "SMTP is not configured (SMTP_HOST / SMTP_FROM are unset), so no send was attempted.";
  else {
    try { await (opts.send ?? sendEmail)(input.to, input.subject, input.body); status = "sent"; }
    catch (err) { status = "failed"; detail = err instanceof Error ? err.message : String(err); }
  }
  addCommunication(db, {
    projectId: input.project.id, direction: "outbound", channel: "email", subject: input.subject, body: input.body,
    loggedBy: `${ACTOR} (automated)`, deliveryStatus: status, deliveryDetail: detail, recipient: input.to, orgId: input.orgId,
  });
  if (status !== "sent") logger.warn("email-intake", `reply ${status} for project ${input.project.id}: ${detail}`);
  return status;
}

// ---------------------------------------------------------------------------
// One message.
// ---------------------------------------------------------------------------

function messageKey(parsed: ParsedMail, raw: Buffer): string {
  const mid = String(parsed.messageId || "").trim().toLowerCase();
  return mid ? `mid:${mid}` : `sha256:${crypto.createHash("sha256").update(raw).digest("hex")}`;
}

function defaultExtractor(db: AppDb): IntakeExtractor {
  return async (input, orgId) => {
    const { createLLMProvider } = await import("./llm");
    const { extractParserFields } = await import("./parserExtraction");
    return extractParserFields(db, createLLMProvider(), input, orgId);
  };
}

const MISSING_DOCS: Array<[string, string]> = [["plan_set", "The plan set (PDF)"], ["utility_bill", "The customer's utility bill (PDF or photo)"]];
const IDENTITY_FIELDS: Array<[keyof ProjectRecord, string]> = [
  ["homeownerName", "Homeowner name"], ["utility", "Utility"], ["ahj", "Permitting jurisdiction (AHJ)"], ["systemSizeDcKw", "System size (DC kW)"],
];

async function processOne(db: AppDb, raw: Buffer, opts: IntakeOptions, result: EmailIntakeRunResult): Promise<void> {
  const { simpleParser } = await import("mailparser");
  const parsed = await simpleParser(raw);
  const tag = intakeTagFrom(messageRecipients(parsed));
  if (tag === null) return; // not intake mail: never ours
  result.scanned += 1;
  const key = messageKey(parsed, raw);
  if (db.get("SELECT id FROM email_intake_messages WHERE message_key = ?", [key])) { result.skippedDuplicates += 1; return; }

  const rowId = id();
  const sender = String(parsed.from?.value?.[0]?.address || "").trim().toLowerCase();
  const subject = String(parsed.subject || "").trim();
  const receivedAt = parsed.date ? parsed.date.toISOString() : nowIso();
  const attachments = realAttachments(parsed);
  const base = { id: rowId, key, sender, tag, subject, receivedAt, replyStatus: "" };

  const unsorted = (reason: EmailIntakeReason, orgId: string, clientId: string | null, working: WorkingFile[] | null): void => {
    // A message with nothing attached is recorded (so it is never re-read) but never listed: the
    // unsorted list is for jobs a person can place, not for every stray email to the address.
    const status: EmailIntakeStatus = attachments.length ? "unsorted" : "ignored";
    const item = insertRow(db, { ...base, orgId, clientId, projectId: null, status, reason, files: keepFiles(rowId, attachments, working) });
    if (status === "unsorted") { result.unsorted += 1; result.items.push(item); }
    logger.info("email-intake", `message ${status}: ${reason}`, { tag, files: attachments.length });
  };

  const sourceOrg = opts.sourceOrgId || DEFAULT_ORG_ID;
  if (!tag) return unsorted("no_tag", sourceOrg, null, null);
  const clients = clientsForTag(db, tag, opts);
  if (!clients.length) return unsorted("unknown_tag", sourceOrg, null, null);
  if (clients.length > 1) return unsorted("ambiguous_tag", sourceOrg, null, null);
  const client = clients[0];
  const orgId = client.org_id || DEFAULT_ORG_ID;
  if (!senderIsKnown(client, sender)) return unsorted("unknown_sender", orgId, client.id, null);
  if (dmarcFailed(parsed)) return unsorted("sender_not_authenticated", orgId, client.id, null);

  const files = await sortAttachments(attachments);
  const usable = files.filter((f) => !f.refused);
  if (!usable.length) return unsorted("no_usable_attachments", orgId, client.id, files);

  // THE PARSE: the documents' own text only — never the email body (rule 2).
  const textOf = (docType: string) => usable.find((f) => f.docType === docType)?.pdfText ?? "";
  const texts = { planText: textOf("plan_set"), utilityBillText: textOf("utility_bill"), structuralLetterText: textOf("structural_letter") };
  let extraction: ParserExtractionResponse | null = null;
  if (texts.planText.trim() || texts.utilityBillText.trim() || texts.structuralLetterText.trim()) {
    extraction = await (opts.extract ?? defaultExtractor(db))(texts, orgId);
  }
  const resolution = extraction?.clientResolution;
  if (resolution?.decision === "auto_assign" && resolution.clientId && resolution.clientId !== client.id) {
    return unsorted("plan_set_names_another_client", orgId, client.id, files);
  }
  const { payload, unsure } = extraction ? payloadFromExtraction(extraction) : { payload: {} as ParserPayload, unsure: [] };
  const probe = normalizeProject("probe", payload);
  if (!probe.projectAddress.trim()) return unsorted("address_unreadable", orgId, client.id, files);

  // CREATE, or ATTACH to the same job sent again.
  const existingId = recentProjectAtAddress(db, orgId, client.id, probe);
  let projectId: string;
  if (existingId) {
    projectId = existingId;
  } else {
    projectId = createProject(db, { ...payload, clientId: client.id }, orgId).project.id;
  }
  const existingDocs = new Set(
    db.query<Row>("SELECT doc_type, original_filename, size_bytes FROM project_documents WHERE project_id = ?", [projectId])
      .map((d) => `${text(d.doc_type)}|${text(d.original_filename)}|${Number(d.size_bytes)}`),
  );
  for (const f of usable) {
    if (existingDocs.has(`${f.docType}|${f.name}|${f.size}`)) continue;
    try {
      saveProjectDocument(db, projectId, { filename: f.name, docType: f.docType, contentType: f.kind === "pdf" ? "application/pdf" : `image/${f.kind}`, buffer: f.content, source: "email_intake", uploadedBy: ACTOR });
    } catch (err) {
      // The same door as an upload refuses it; it is reported, and the others still go on.
      f.refused = err instanceof HttpError || err instanceof Error ? err.message : String(err);
    }
  }
  // The chain is queued after the files are on the project, so its first step sees the plan set.
  try { enqueueStageSteps(db, projectId); } catch { /* the chain is a convenience, not the intake */ }

  const project = getProjectDetail(db, projectId).project;
  const docTypes = new Set(db.query<Row>("SELECT doc_type FROM project_documents WHERE project_id = ?", [projectId]).map((d) => text(d.doc_type)));
  const missing = [
    ...IDENTITY_FIELDS.filter(([k]) => project[k] == null || String(project[k]).trim() === "").map(([, label]) => label),
    ...MISSING_DOCS.filter(([t]) => !docTypes.has(t)).map(([, label]) => label),
  ];
  const refused = files.filter((f) => f.refused).map(({ name, size, refused: why }) => ({ name, size, refused: why }));
  const email = intakeReplyEmail({
    project, attached: Boolean(existingId), link: statusShareUrl(ensureStatusShareToken(db, projectId)),
    missing, unsure: unsure.map((k) => FIELD_LABELS[k] ?? k), refused,
  });
  const replyStatus = await reply(db, { project, orgId, to: sender, ...email }, opts);

  const status: EmailIntakeStatus = existingId ? "attached" : "created";
  const item = insertRow(db, {
    ...base, orgId, clientId: client.id, projectId, status, reason: "", replyStatus,
    files: files.map(({ name, size, docType, refused: why }) => ({ name, size, ...(why ? { refused: why } : { docType }) })),
  });
  addAuditLog(db, projectId, "system", ACTOR, existingId ? "project.files_attached_from_email" : "project.created_from_email", {
    intakeId: rowId, files: item.files.map((f) => ({ docType: f.docType ?? null, refused: Boolean(f.refused) })), unsure, missing: missing.length, reply: replyStatus,
  });
  if (existingId) result.attached += 1; else result.created += 1;
  result.items.push(item);
}

/** Process raw RFC822 messages. Messages not addressed to the intake address are ignored. Never
 *  throws: a message that fails is recorded unsorted (reason "failed") with its files kept. */
export async function processIntakeMessages(db: AppDb, raws: Buffer[], opts: IntakeOptions = {}): Promise<EmailIntakeRunResult> {
  const result: EmailIntakeRunResult = { scanned: 0, created: 0, attached: 0, unsorted: 0, skippedDuplicates: 0, items: [] };
  if (!intakeEnabled()) return result;
  for (const raw of raws) {
    try {
      await processOne(db, raw, opts, result);
    } catch (err) {
      logger.warn("email-intake", `message failed: ${err instanceof Error ? err.message : String(err)}`);
      try {
        const { simpleParser } = await import("mailparser");
        const parsed = await simpleParser(raw);
        const key = messageKey(parsed, raw);
        if (!db.get("SELECT id FROM email_intake_messages WHERE message_key = ?", [key])) {
          const rowId = id();
          const item = insertRow(db, {
            id: rowId, key, orgId: opts.sourceOrgId || DEFAULT_ORG_ID, clientId: null, projectId: null, status: "unsorted", reason: "failed",
            sender: String(parsed.from?.value?.[0]?.address || "").toLowerCase(), tag: intakeTagFrom(messageRecipients(parsed)) ?? "",
            subject: String(parsed.subject || ""), files: keepFiles(rowId, realAttachments(parsed), null), replyStatus: "",
            receivedAt: parsed.date ? parsed.date.toISOString() : nowIso(),
          });
          result.unsorted += 1;
          result.items.push(item);
        }
      } catch { /* an unparseable message is left for the next poll */ }
    }
  }
  return result;
}

/** Split an MBOX file's text into raw messages (the "From " separator line removed, the
 *  writer's ">From " escape undone). */
export function mboxMessages(mboxText: string): Buffer[] {
  return mboxText.replace(/\r\n/g, "\n")
    .split(/\n(?=From [^\n]*\n)/g)
    .map((m) => m.replace(/^From [^\n]*\n/, "").replace(/\n>From /g, "\nFrom ").trim())
    .filter(Boolean)
    .map((m) => Buffer.from(`${m}\n`, "utf8"));
}

// ---------------------------------------------------------------------------
// The unsorted list (routes).
// ---------------------------------------------------------------------------

/** Unsorted messages waiting on a person, and the most recent ones placed. `orgFilter` null reads
 *  every org (superadmin); a string, one org. */
export function listEmailIntake(db: AppDb, orgFilter: string | null): { enabled: boolean; address: string; unsorted: EmailIntakeView[]; recent: EmailIntakeView[] } {
  const where = orgFilter === null ? "" : " AND org_id = ?";
  const params = orgFilter === null ? [] : [orgFilter];
  const addr = intakeAddressSetting();
  return {
    enabled: Boolean(addr),
    address: addr ? `${addr.local}+<client tag>@${addr.domain}` : "",
    unsorted: db.query<Row>(`SELECT * FROM email_intake_messages WHERE status = 'unsorted'${where} ORDER BY created_at DESC LIMIT 100`, params).map(mapRow),
    recent: db.query<Row>(`SELECT * FROM email_intake_messages WHERE status IN ('created', 'attached')${where} ORDER BY created_at DESC LIMIT 20`, params).map(mapRow),
  };
}

/** The row, or a 404 when it is outside the caller's org (never a 403: rule 6). */
function rowInScope(db: AppDb, intakeId: string, orgFilter: string | null): Row {
  const row = db.get<Row>("SELECT * FROM email_intake_messages WHERE id = ?", [intakeId]);
  if (!row || (orgFilter !== null && text(row.org_id) !== orgFilter)) throw new HttpError(404, "Intake message not found.");
  return row;
}

export function emailIntakeFile(db: AppDb, intakeId: string, index: number, orgFilter: string | null): { path: string; filename: string } {
  const row = rowInScope(db, intakeId, orgFilter);
  let files: StoredFile[] = [];
  try { files = JSON.parse(text(row.files_json) || "[]"); } catch { files = []; }
  const f = files[index];
  const dir = path.resolve(intakeDir(text(row.id)));
  if (!f?.stored || !path.resolve(f.stored).startsWith(dir + path.sep) || !fs.existsSync(f.stored)) throw new HttpError(404, "File not found.");
  return { path: f.stored, filename: f.name };
}

/** A person cleared it: the row stays (so the message is never re-read), its files go. */
export function dismissEmailIntake(db: AppDb, intakeId: string, orgFilter: string | null, by: string): EmailIntakeView {
  const row = rowInScope(db, intakeId, orgFilter);
  if (text(row.status) !== "unsorted") throw new HttpError(409, "Only an unsorted message can be dismissed.");
  db.run("UPDATE email_intake_messages SET status = 'dismissed', resolved_at = ? WHERE id = ?", [nowIso(), text(row.id)]);
  fs.rmSync(intakeDir(text(row.id)), { recursive: true, force: true });
  addAuditLog(db, null, "human", by || "operator", "email_intake.dismissed", { intakeId: text(row.id), reason: text(row.reason) });
  return mapRow(db.get<Row>("SELECT * FROM email_intake_messages WHERE id = ?", [text(row.id)])!);
}
