// ---------------------------------------------------------------------------
// THE ISSUED PERMIT AND THE UTILITY'S APPROVAL LETTER, PULLED OFF THE FILED RECORD (#492).
//
// When a permit reads issued, or a NEM application reads approved, the monitor has recorded the
// status — and the issued permit card and the approval / PTO letter stayed on the portal. Someone
// had to sign in, download them and attach them before the installer could be handed the job.
// This module does that download on the same record the monitor already reads, and keeps where
// each file came from:
//
//     downloaded from record 187-26-000309-STR on 2026-11-02
//
// RULES IT KEEPS
//   - READ-ONLY (hard rule 1). It never drives a browser and never clicks anything: it GETs the
//     record's own page, picks out ANCHORS whose words and target say "this is the issued permit"
//     or "this is the approval letter", and GETs those. A link whose words or address carry any
//     submit-intent word — submit, pay, schedule, request, apply, cancel, renew, upload, sign in,
//     confirm, approve… (SUBMIT_INTENT_WORDS) — is never followed, whatever else it says; a form,
//     a button and a javascript:/postback link are never candidates at all, because only <a href>
//     to an http(s) URL is read. A GET of a document link is what a person's click on it does.
//   - THE RECORD'S OWN PORTAL ON ITS OWN TRACK (hard rule 5). The record URL must pass
//     trackSafeUrl for the target's track (the same predicate the status sweep and the fee reader
//     use), and the page and every download — and every redirect hop of each — must stay on THAT
//     record's portal (onRecordPortal) and pass trackSafeUrl again: documentFetch asks `allowUrl`
//     before each request. A permit record never reaches a utility host, nor a NEM record an AHJ
//     permit portal, even by redirect.
//   - NEVER SOMEONE ELSE'S RECORD: the page must name the target's own record number.
//   - THE DOCUMENTS ROUTE'S TYPE CHECKS: each file is saved through saveProjectDocument, which
//     refuses anything that is not a PDF or an image for these slots; a link that answers a web
//     page is reported, never attached.
//   - IDEMPOTENT: the file's sha256 is recorded (portal_record_documents, UNIQUE per project), so
//     a re-read attaches nothing new; a file a person already attached under the same type is not
//     attached twice; a downloaded file a person later deleted is not pushed back.
//   - A PERSON'S FILE COUNTS: a file attached by hand under the track's slot (after the card said
//     "download it by hand") is the closeout document on the card and in the handoff packet, and
//     the monitor stops looking for one.
//   - SAYS WHY when nothing was attached (permit_check_targets.issued_docs_gap, on the card beside
//     #173's read gap): no record link, a sign-in wall, no document link on the page, a link that
//     answered a web page…
//   - PUBLIC PAGES ONLY, no credential: a record page behind a sign-in (PowerClerk's project page,
//     typically) is reported as such and left to a person. PORTAL_ISSUED_DOCS=off stops it;
//     DOCUMENT_FETCH=off (documentFetch) stops it too.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import fs from "node:fs";
import { load } from "cheerio";
import type { AppDb } from "./db";
import type { IssuedRecordDocument, ProjectRecord } from "../../shared/src/types";
import { fetchPublicDocument, type FetchedDocument, type FetchPublicDocumentOptions } from "./documentFetch";
import { isAuthWallText, isNemApprovalOutcome, trackKind, type TrackKind } from "./permitMonitor";
import { isPathTenantedHost, portalHostOf, portalTenantOf, sameHost, trackSafeUrl } from "./portalChannel";
import { saveProjectDocument } from "./projectDocuments";
import { sniffFileKind, isImageKind } from "./fileTypes";
import { addAuditLog } from "./audit";
import { id } from "./ids";
import { text } from "./json";
import { nowIso } from "./time";
import { logger } from "./logger";

type Row = Record<string, unknown>;

/** The document slot each track's closeout file is filed under. */
export const ISSUED_DOC_TYPE: Record<TrackKind, "issued_permit" | "utility_approval"> = {
  permit: "issued_permit",
  nem: "utility_approval",
};

/** Is this outcome the one that finishes the target's track — the moment there is a document to
 *  pull? A permit: issued (ready_for_issue still owes a fee and has no permit card). A NEM filing:
 *  the one approval outcome (isNemApprovalOutcome). */
export function isFinishedOutcome(track: TrackKind, outcome: string | null | undefined): boolean {
  return track === "nem" ? isNemApprovalOutcome(outcome) : String(outcome || "").trim() === "issued";
}

// ── which links on a record page are the documents ─────────────────────────────────────────

/** IS THIS URL ON THE RECORD'S OWN PORTAL? The same host — and, on a shared vendor instance that
 *  serves many agencies from one host by path (aca-oregon.accela.com/OREGON/…), the record's own
 *  agency's path. (Not samePortal: that reads ANY first path segment as a tenant, so a PowerClerk
 *  record at /MvcProjects/… and its letter at /Documents/… would read as two portals.) */
export function onRecordPortal(url: string, recordUrl: string): boolean {
  if (!sameHost(url, recordUrl)) return false;
  return !isPathTenantedHost(portalHostOf(recordUrl)) || portalTenantOf(url) === portalTenantOf(recordUrl);
}

/** Words that make a link a CONTROL, not a document — never followed, whatever else it says. Read
 *  as whole words of the link's text, title and address (camelCase and punctuation split), so
 *  "PayFees.aspx" and "Schedule Inspection" are refused and "ApprovalLetter.pdf" is not. */
const SUBMIT_INTENT_WORDS = new Set([
  "submit", "resubmit", "pay", "payment", "payments", "checkout", "cart", "schedule", "scheduling", "request", "requests",
  "apply", "cancel", "withdraw", "renew", "renewal", "extend", "extension", "upload", "delete", "remove", "login", "logout",
  "logon", "logoff", "signin", "signout", "signup", "sign", "log", "register", "edit", "save", "accept", "agree", "confirm",
  "approve", "reject", "esign", "docusign", "continue", "next", "create", "fee", "fees", "invoice", "receipt", "postback",
  "dopostback", "amend", "amendment", "transfer", "claim",
]);

/** Words that say a link is a downloadable FILE rather than a page of the portal. */
const DOWNLOAD_WORDS = new Set([
  "pdf", "download", "downloads", "filedownload", "document", "documents", "attachment", "attachments", "getdocument",
  "viewdocument", "file", "files", "report", "print", "letter",
]);

/** Words that say a "permit" link is something other than the issued permit itself. */
const NOT_THE_PERMIT = new Set([
  "application", "applications", "plan", "plans", "review", "comments", "comment", "correction", "corrections",
  "checklist", "inspection", "inspections", "guide", "instructions", "form", "forms", "template", "sample", "blank",
  "search", "list", "records", "home", "help", "my", "faq", "worksheet",
]);

/** …and for an approval letter. */
const NOT_THE_LETTER = new Set(["form", "forms", "template", "sample", "blank", "instructions", "guide", "checklist", "help", "faq", "search", "list", "home"]);

/** The words of a string: camelCase split, everything not a letter or digit a separator. */
function wordsOf(value: string): string[] {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export interface RecordDocumentLink {
  href: string;
  text: string;
  score: number;
}

/**
 * THE DOCUMENT LINKS ON A RECORD PAGE for `track` — pure, so the fixture tests ask the same
 * question production does. Only <a href> to http(s) on the record's own portal and track; a
 * link carrying any submit-intent word is refused before it is scored. At most three, best first.
 */
export function pickRecordDocumentLinks(
  html: string,
  pageUrl: string,
  track: TrackKind,
  /** Collects the hrefs of links that WOULD be the document but leave the record's portal or its
   *  track — skipped, never requested, and named in the card's reason. */
  skipped: string[] = [],
): RecordDocumentLink[] {
  const $ = load(html);
  const out = new Map<string, RecordDocumentLink>();
  $("a[href]").each((_i, el) => {
    const raw = String($(el).attr("href") || "").trim();
    if (!raw || raw.startsWith("#") || /^(javascript|mailto|tel|data|blob):/i.test(raw) || /__dopostback/i.test(raw)) return;
    let href: string;
    try { href = new URL(raw, pageUrl).toString(); } catch { return; }
    if (!/^https?:\/\//i.test(href)) return;
    // The words a person would read: the anchor's text, its title / aria-label, and the cell the
    // link sits in (an Accela attachments row names the file beside a bare "Download").
    const label = [$(el).text(), $(el).attr("title"), $(el).attr("aria-label"), $(el).attr("download")]
      .map((v) => String(v || "")).join(" ").replace(/\s+/g, " ").trim();
    // Only a SHORT row is the link's own row; a layout table's row is the whole page.
    const rowRaw = String($(el).closest("tr").text() || "").replace(/\s+/g, " ").trim();
    const rowText = rowRaw.length <= 300 ? rowRaw : "";
    let pathAndQuery = "";
    try { const u = new URL(href); pathAndQuery = decodeURIComponent(`${u.pathname} ${u.search}`); } catch { pathAndQuery = href; }
    const labelWords = wordsOf(label);
    const hrefWords = wordsOf(pathAndQuery);
    const rowWords = wordsOf(rowText);
    // RULE 1 FIRST: any submit-intent word in what the link says or where it goes ends it. (An
    // address's "upload" alone is let through: a GET cannot upload, and a portal's download
    // handler often lives under its FileUpload folder. A link that SAYS upload is still refused.)
    if (labelWords.some((w) => SUBMIT_INTENT_WORDS.has(w))) return;
    if (hrefWords.some((w) => SUBMIT_INTENT_WORDS.has(w) && w !== "upload")) return;
    const words = new Set([...labelWords, ...hrefWords, ...rowWords]);
    // What the link names: its own words, and its row's (an attachments row names the file).
    const named = [...labelWords, ...hrefWords, ...rowWords];
    const isFile = /\.(pdf|png|jpe?g|tiff?)$/i.test(new URL(href).pathname) || [...hrefWords, ...labelWords].some((w) => DOWNLOAD_WORDS.has(w));
    if (!isFile) return;
    let score = 0;
    if (track === "permit") {
      if (!words.has("permit") && !words.has("permits")) return;
      if (named.some((w) => NOT_THE_PERMIT.has(w))) return;
      score = 1;
      if (words.has("issued") || words.has("card") || words.has("certificate")) score += 2;
    } else {
      if (named.some((w) => NOT_THE_LETTER.has(w))) return;
      const approval = words.has("approval") || words.has("approved");
      const pto = words.has("pto") || (words.has("permission") && words.has("operate"));
      const authorization = (words.has("authorization") || words.has("authorisation")) && (words.has("operate") || words.has("interconnect") || words.has("install"));
      const executed = words.has("executed") && words.has("agreement");
      if (!approval && !pto && !authorization && !executed) return;
      score = 1;
      if (words.has("letter") || pto || authorization) score += 2;
    }
    // RULE 5, and the record's own portal: a link that would be the document but leaves either is
    // skipped and named, never requested.
    if (!trackSafeUrl(track, href) || !onRecordPortal(href, pageUrl)) {
      if (!skipped.includes(href)) skipped.push(href);
      return;
    }
    if (/\.pdf$/i.test(new URL(href).pathname)) score += 1;
    const prior = out.get(href);
    if (!prior || prior.score < score) out.set(href, { href, text: label || rowText, score });
  });
  return [...out.values()].sort((a, b) => b.score - a.score).slice(0, 3);
}

// ── the one door to the outside, behind a test seam ─────────────────────────────────────────
export type IssuedDocFetch = (url: string, opts: FetchPublicDocumentOptions) => Promise<FetchedDocument>;
let seam: IssuedDocFetch | null = null;
export function setIssuedDocumentFetchForTests(next: IssuedDocFetch | null): void {
  if (process.env.AUTOPILOT_TEST_SEAMS !== "1") throw new Error("setIssuedDocumentFetchForTests needs AUTOPILOT_TEST_SEAMS=1 — it is a test seam only.");
  seam = next;
}

/** Every GET goes through here: the door is asked before the request (and, inside
 *  fetchPublicDocument, before every redirect hop) and again of where the bytes came from. */
async function guardedGet(url: string, allowUrl: (u: string) => string | null, maxBytes: number): Promise<FetchedDocument> {
  const refusal = allowUrl(url);
  if (refusal) return { ok: false, status: 0, contentType: "", via: "http", reason: `Refused: ${refusal}`, finalUrl: url };
  const opts: FetchPublicDocumentOptions = { allowBrowser: false, allowUrl, maxBytes, timeoutMs: 20_000 };
  const got = await (seam ?? fetchPublicDocument)(url, opts);
  const landed = got.finalUrl || url;
  const after = allowUrl(landed);
  if (got.ok && after) return { ok: false, status: got.status, contentType: "", via: got.via, reason: `Refused: ended at ${landed}. ${after}`, finalUrl: landed };
  return got;
}

const off = (v: string | undefined): boolean => /^(off|0|false|no)$/i.test(String(v ?? "").trim());
/** A record that offered nothing is looked at again at most this often. */
const RECHECK_AFTER_MS = 20 * 60 * 60_000;
const PAGE_MAX_BYTES = 5 * 1024 * 1024;
const DOC_MAX_BYTES = 32 * 1024 * 1024;

/** Does the page name THIS record? Separators ignored (the fee reader's rule). */
function pageNamesRecord(pageText: string, recordNumber: string): boolean {
  const want = recordNumber.replace(/[\s-]+/g, "").toUpperCase();
  return !!want && pageText.replace(/[\s-]+/g, "").toUpperCase().includes(want);
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** A filename for the attached file: the link's own file name when it has one, else the record's. */
function fileNameFor(href: string, recordNumber: string, docType: string, kind: string): string {
  let last = "";
  try { last = decodeURIComponent(new URL(href).pathname.split("/").pop() || ""); } catch { last = ""; }
  if (/\.(pdf|png|jpe?g|tiff?|gif|heic)$/i.test(last)) return last.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
  const ext = kind === "pdf" ? "pdf" : kind === "jpeg" ? "jpg" : kind;
  return `${(recordNumber || "record").replace(/[^A-Za-z0-9-]+/g, "_")}-${docType.replace(/_/g, "-")}.${ext}`;
}

/** Hashes of the files a project already holds under this doc type (a person's own upload counts). */
function heldHashes(db: AppDb, projectId: string, docType: string): Set<string> {
  const out = new Set<string>();
  for (const r of db.query<Row>("SELECT sha256 FROM portal_record_documents WHERE project_id = ?", [projectId])) out.add(text(r.sha256));
  for (const r of db.query<Row>("SELECT stored_path FROM project_documents WHERE project_id = ? AND doc_type = ?", [projectId, docType])) {
    try { out.add(sha256(fs.readFileSync(text(r.stored_path)))); } catch { /* a missing file holds nothing */ }
  }
  return out;
}

function setGap(db: AppDb, targetId: string, gap: string): void {
  db.run("UPDATE permit_check_targets SET issued_docs_gap = ?, issued_docs_checked_at = ? WHERE id = ?", [gap.slice(0, 400), nowIso(), targetId]);
}

export interface IssuedDocsResult {
  status: "attached" | "already_attached" | "nothing_attached" | "skipped";
  attached: number;
  reason?: string;
}

/**
 * THE MONITOR'S HOOK: after a target's status is recorded, and only when that status finishes the
 * track (issued / approved), pull the closeout document(s) off the record. Never throws at the
 * sweep (the caller also guards) and never touches the status.
 */
export async function fetchIssuedRecordDocuments(
  db: AppDb,
  project: Pick<ProjectRecord, "id">,
  targetId: string,
  opts: { force?: boolean } = {},
): Promise<IssuedDocsResult> {
  if (off(process.env.PORTAL_ISSUED_DOCS)) return { status: "skipped", attached: 0, reason: "PORTAL_ISSUED_DOCS=off" };
  const target = db.get<Row>("SELECT * FROM permit_check_targets WHERE id = ? AND project_id = ?", [targetId, project.id]);
  if (!target || Number(target.active ?? 0) !== 1) return { status: "skipped", attached: 0, reason: "no active target" };
  const track = trackKind(text(target.target_type), text(target.permit_type));
  if (!isFinishedOutcome(track, text(target.latest_outcome))) return { status: "skipped", attached: 0, reason: "not issued or approved" };
  const docType = ISSUED_DOC_TYPE[track];
  const what = track === "nem" ? "the approval letter" : "the issued permit";

  // Already pulled for this filing: nothing to do, nothing to say — and not visited again. That
  // holds when a person has since deleted the file: their removal stands, and the record is not
  // re-read every day to fetch bytes that would only be refused by hash.
  const have = db.get<Row>(
    "SELECT COUNT(*) AS n FROM portal_record_documents WHERE project_id = ? AND target_id = ?",
    [project.id, targetId],
  );
  if (Number(have?.n ?? 0) > 0) {
    if (text(target.issued_docs_gap)) setGap(db, targetId, "");
    return { status: "already_attached", attached: 0 };
  }
  // A PERSON ATTACHED IT (the card's "download it by hand" followed): the file under this track's
  // slot that the monitor did not download is the closeout document. Nothing to fetch, no gap.
  if (handAttached(db, project.id, docType).length > 0) {
    if (text(target.issued_docs_gap)) setGap(db, targetId, "");
    return { status: "already_attached", attached: 0 };
  }
  const lastTry = Date.parse(text(target.issued_docs_checked_at));
  if (!opts.force && Number.isFinite(lastTry) && Date.now() - lastTry < RECHECK_AFTER_MS) {
    return { status: "skipped", attached: 0, reason: "looked recently" };
  }

  const nothing = (reason: string): IssuedDocsResult => {
    setGap(db, targetId, reason);
    return { status: "nothing_attached", attached: 0, reason };
  };

  // THE RECORD'S OWN PAGE, on its own track (rule 5): the public status link first, then the
  // portal URL — each only if trackSafeUrl lets it on this track.
  const recordUrl = [text(target.tracking_url), text(target.portal_url)].map((u) => trackSafeUrl(track, u)).find(Boolean) || "";
  if (!recordUrl) return nothing(`No record link on file for this filing, so ${what} could not be looked for. Download it from the portal by hand.`);
  const recordNumber = text(target.permit_number) || text(target.application_number);
  if (!recordNumber) return nothing(`The filing has no record number, so the monitor cannot tell the record page is this one. Download ${what} by hand.`);

  const allowUrl = (u: string): string | null => {
    if (!trackSafeUrl(track, u)) return `${portalHostOf(u) || u} is the other track's kind of portal (rule 5)`;
    if (!onRecordPortal(u, recordUrl)) return `${portalHostOf(u) || u} is not the record's own portal (${portalHostOf(recordUrl)})`;
    return null;
  };

  const page = await guardedGet(recordUrl, allowUrl, PAGE_MAX_BYTES).catch((err) => ({
    ok: false, status: 0, contentType: "", via: "http" as const, reason: err instanceof Error ? err.message : String(err), finalUrl: recordUrl,
  } satisfies FetchedDocument));
  if (!page.ok || !page.text) return nothing(`Could not open the record page to look for ${what}: ${page.reason.slice(0, 200)}`);
  const $ = load(page.text);
  $("script, style, noscript").remove();
  const pageText = String($("body").text() || $.root().text() || "").replace(/\s+/g, " ").trim();
  if (isAuthWallText(pageText)) {
    return nothing(`The record page asks for a sign-in, and the monitor downloads only from a record page it can open without one. Download ${what} from the portal by hand.`);
  }
  if (!pageNamesRecord(pageText, recordNumber)) {
    return nothing(`The page at the record link does not name record ${recordNumber} — nothing was downloaded from someone else's record.`);
  }
  const offPortal: string[] = [];
  const links = pickRecordDocumentLinks(page.text, page.finalUrl || recordUrl, track, offPortal);
  const skippedNote = offPortal.length
    ? ` Skipped ${offPortal.length} link(s) that leave the record's portal or its track: ${offPortal.map((u) => portalHostOf(u) || u).join(", ")}.`
    : "";
  if (offPortal.length) {
    addAuditLog(db, project.id, "system", "permit monitor", "permit_target.issued_document_link_skipped", { targetId, track, recordNumber, skipped: offPortal.slice(0, 5) });
  }
  if (!links.length) {
    return nothing(`Record ${recordNumber} lists no downloadable ${track === "nem" ? "approval or PTO letter" : "issued permit"} the monitor can open without a sign-in.${skippedNote} Download ${what} from the portal by hand.`);
  }

  const held = heldHashes(db, project.id, docType);
  const notes: string[] = [];
  let attached = 0;
  let already = 0;
  for (const link of links) {
    const got = await guardedGet(link.href, allowUrl, DOC_MAX_BYTES).catch((err) => ({
      ok: false, status: 0, contentType: "", via: "http" as const, reason: err instanceof Error ? err.message : String(err), finalUrl: link.href,
    } satisfies FetchedDocument));
    if (!got.ok || !got.bytes || !got.bytes.length) { notes.push(`"${link.text || link.href}" could not be downloaded: ${got.reason.slice(0, 160)}`); continue; }
    const buffer = Buffer.from(got.bytes);
    const kind = sniffFileKind(buffer);
    if (kind !== "pdf" && !isImageKind(kind)) { notes.push(`"${link.text || link.href}" answered ${got.contentType || "something"} that is not a PDF or an image`); continue; }
    const hash = sha256(buffer);
    if (held.has(hash)) { already++; continue; }
    const filename = fileNameFor(got.finalUrl || link.href, recordNumber, docType, kind);
    let documentId = "";
    try {
      // The documents route's own door: saveProjectDocument refuses anything this slot cannot hold.
      documentId = saveProjectDocument(db, project.id, {
        docType, filename, contentType: kind === "pdf" ? "application/pdf" : got.contentType || "application/octet-stream",
        buffer, source: "portal_record", uploadedBy: "permit monitor",
      }).id;
    } catch (err) {
      notes.push(`"${link.text || link.href}" was refused by the documents check: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
      continue;
    }
    const fetchedAt = nowIso();
    db.run(
      `INSERT INTO portal_record_documents (id, project_id, target_id, track, doc_type, document_id, record_number, source_url, link_text, sha256, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id(), project.id, targetId, track, docType, documentId, recordNumber, got.finalUrl || link.href, link.text.slice(0, 200), hash, fetchedAt],
    );
    held.add(hash);
    attached++;
    addAuditLog(db, project.id, "system", "permit monitor", "permit_target.issued_document", {
      targetId, track, docType, documentId, recordNumber, sourceUrl: got.finalUrl || link.href,
    });
  }
  if (attached || already) {
    setGap(db, targetId, "");
    if (attached) logger.info("monitor", `attached ${attached} closeout document(s) from record ${recordNumber}`, { projectId: project.id, targetId, docType });
    return { status: attached ? "attached" : "already_attached", attached };
  }
  return nothing(`Found ${links.length} link(s) on record ${recordNumber} but none gave a file: ${notes.join("; ")}`.slice(0, 400));
}

// ── what the card and the handoff packet read ──────────────────────────────────────────────

function provenanceOf(recordNumber: string, fetchedAt: string): string {
  return `downloaded from record ${recordNumber || "(no number)"} on ${fetchedAt.slice(0, 10)}`;
}

/** The files under a closeout slot that the MONITOR did not download — a person attached them
 *  (the upload picker's "Issued permit" / "Utility approval / PTO letter", or any other door).
 *  The record they belong to is not known, so each counts for every finished filing of its track
 *  that has no downloaded file of its own. */
function handAttached(db: AppDb, projectId: string, docType: string): Row[] {
  return db.query<Row>(
    `SELECT d.* FROM project_documents d
      WHERE d.project_id = ? AND d.doc_type = ?
        AND NOT EXISTS (SELECT 1 FROM portal_record_documents r WHERE r.document_id = d.id)
      ORDER BY d.uploaded_at, d.rowid`,
    [projectId, docType],
  );
}

/** Every closeout document on file for this project, by target: what the monitor downloaded off
 *  that filing's record, else — on a finished filing — what a person attached under its slot. */
export function issuedDocumentsByTarget(db: AppDb, projectId: string): Map<string, IssuedRecordDocument[]> {
  const rows = db.query<Row>(
    `SELECT r.*, d.original_filename AS filename FROM portal_record_documents r
       JOIN project_documents d ON d.id = r.document_id
      WHERE r.project_id = ? ORDER BY r.fetched_at, r.id`,
    [projectId],
  );
  const out = new Map<string, IssuedRecordDocument[]>();
  for (const r of rows) {
    const list = out.get(text(r.target_id)) ?? [];
    list.push({
      documentId: text(r.document_id),
      docType: text(r.doc_type),
      filename: text(r.filename),
      recordNumber: text(r.record_number),
      sourceUrl: text(r.source_url),
      fetchedAt: text(r.fetched_at),
      provenance: provenanceOf(text(r.record_number), text(r.fetched_at)),
    });
    out.set(text(r.target_id), list);
  }
  const byHand: Partial<Record<TrackKind, IssuedRecordDocument[]>> = {};
  for (const track of ["permit", "nem"] as const) {
    byHand[track] = handAttached(db, projectId, ISSUED_DOC_TYPE[track]).map((d) => ({
      documentId: text(d.id),
      docType: ISSUED_DOC_TYPE[track],
      filename: text(d.original_filename),
      recordNumber: "",
      sourceUrl: "",
      fetchedAt: text(d.uploaded_at),
      provenance: `attached by ${text(d.uploaded_by) || "a person"} on ${text(d.uploaded_at).slice(0, 10)}`,
    }));
  }
  if (byHand.permit?.length || byHand.nem?.length) {
    for (const t of db.query<Row>("SELECT * FROM permit_check_targets WHERE project_id = ? AND active = 1", [projectId])) {
      const track = trackKind(text(t.target_type), text(t.permit_type));
      if (!isFinishedOutcome(track, text(t.latest_outcome)) || out.get(text(t.id))?.length) continue;
      if (byHand[track]?.length) out.set(text(t.id), byHand[track]!);
    }
  }
  return out;
}

/** The handoff packet's closeout-documents lines: one per finished filing, the file(s) with their
 *  provenance or why none is on file. `complete` when every finished filing has its document. */
export function closeoutDocumentLines(db: AppDb, projectId: string): { lines: string[]; complete: boolean; finished: number } {
  const byTarget = issuedDocumentsByTarget(db, projectId);
  const targets = db.query<Row>("SELECT * FROM permit_check_targets WHERE project_id = ? AND active = 1 ORDER BY created_at, id", [projectId]);
  const lines: string[] = [];
  let finished = 0;
  let missing = 0;
  for (const t of targets) {
    const track = trackKind(text(t.target_type), text(t.permit_type));
    if (!isFinishedOutcome(track, text(t.latest_outcome))) continue;
    finished++;
    const name = `${track === "nem" ? "Approval letter" : "Issued permit"} — ${text(t.jurisdiction) || text(t.portal_name) || "filing"}${text(t.permit_number) || text(t.application_number) ? ` ${text(t.permit_number) || text(t.application_number)}` : ""}`;
    const docs = byTarget.get(text(t.id)) ?? [];
    if (docs.length) {
      for (const d of docs) lines.push(`${name}: ${d.filename} (${d.provenance})`);
    } else {
      missing++;
      lines.push(`${name}: not on file — ${text(t.issued_docs_gap) || "not looked for yet"}`);
    }
  }
  return { lines, complete: finished > 0 && missing === 0, finished };
}
