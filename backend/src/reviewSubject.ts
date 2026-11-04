// ---------------------------------------------------------------------------
// Standalone review-gate submissions — the sellable surface of the reviewer.
//
// reviewSubjectToProject adapts the small ReviewSubject DTO onto the
// ProjectRecord shape the (pure) engine already consumes, so the internal
// all-in-one product and the AHJ-facing API run the IDENTICAL engine —
// there is one reviewer, packaged twice.
//
// runStandaloneReview is the whole flow: resolve the jurisdiction's adopted-
// codes context → optional plan-set PDF (page renders for the AI pass + text
// extraction) → runReviewPack (deterministic solar / AI general hybrid) →
// persist a review_submissions row (org-scoped for multi-tenant sale).
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { backendDataDir } from "./statePaths";
import type { AppDb } from "./db";
import type { AiPlanReviewResult, LLMProvider, ProjectRecord, ReviewerFinding, ReviewerReport, ReviewSubject, ReviewWorkType } from "../../shared/src/types";
import { resolveEffectiveCodeContext, ensureCodeProfilesResearched } from "./codeProfiles";
import { runReviewPack, reviewPackFor } from "./reviewPacks";
import { createLLMProvider, StubLLMProvider } from "./llm";
import { extractPdfPagesCounted } from "./batchImport";
import { renderPdfPageToPng } from "./pageImages";
import { readImageSheetListings } from "./imageSheetListings";
import { IMAGE_SHEET_LISTING_COVERAGE_KEY, IMAGE_SHEET_LISTING_READINGS_KEY, packageListings } from "./codeReviewRules";
import { addAuditLog } from "./audit";
import { logger } from "./logger";
import { id } from "./ids";
import { asJson, parseJson, text as s } from "./json";
import { nowIso } from "./time";

interface Row { [key: string]: unknown }

/** Adapt the DTO onto the engine's ProjectRecord contract. Synthetic id; every
 *  field the engine reads is populated; `fields` land in parserSnapshot verbatim
 *  (the engine's fieldValue() reads that bag defensively). */
export function reviewSubjectToProject(subject: ReviewSubject, submissionId: string): ProjectRecord {
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(subject.fields ?? {})) {
    if (v == null) continue;
    fields[k] = String(v);
  }
  // Jurisdiction keys are read from the payload too (baseline rules).
  fields.state = fields.state || subject.state;
  fields.ahj = fields.ahj || subject.ahj;
  if (subject.utility) fields.utility = fields.utility || subject.utility;
  if (subject.system?.sizeDcKw != null) fields.dcKw = fields.dcKw || String(subject.system.sizeDcKw);
  if (subject.system?.sizeAcKw != null) fields.acKw = fields.acKw || String(subject.system.sizeAcKw);

  return {
    id: submissionId,
    clientId: null,
    homeownerName: subject.applicant?.name || "",
    projectAddress: subject.applicant?.address || "",
    city: subject.applicant?.city || "",
    state: subject.state,
    zip: subject.applicant?.zip || "",
    ahj: subject.ahj,
    utility: subject.utility || "",
    accountNumber: "",
    meterNumber: "",
    systemSizeDcKw: subject.system?.sizeDcKw ?? null,
    systemSizeAcKw: subject.system?.sizeAcKw ?? null,
    interconnectionMethod: subject.system?.interconnectionMethod || "",
    status: "review_only",
    parserSnapshot: fields,
  } as unknown as ProjectRecord;
}

export interface ReviewSubmissionRecord {
  id: string;
  orgId: string;
  workType: ReviewWorkType;
  state: string;
  ahj: string;
  status: "complete" | "failed";
  report: ReviewerReport | null;
  aiSummary: string;
  plansetPath: string;
  createdAt: string;
}

function mapSubmission(row: Row): ReviewSubmissionRecord {
  return {
    id: s(row.id),
    orgId: s(row.org_id),
    workType: (s(row.work_type) || "general") as ReviewWorkType,
    state: s(row.state),
    ahj: s(row.ahj),
    status: s(row.status) === "failed" ? "failed" : "complete",
    report: parseJson<ReviewerReport | null>(s(row.report_json), null),
    aiSummary: s(row.ai_summary),
    plansetPath: s(row.planset_path),
    createdAt: s(row.created_at),
  };
}

export function getReviewSubmission(db: AppDb, orgId: string, submissionId: string): ReviewSubmissionRecord | null {
  const row = db.get<Row>("SELECT * FROM review_submissions WHERE id = ? AND org_id = ?", [submissionId, orgId]);
  return row ? mapSubmission(row) : null;
}

export function listReviewSubmissions(db: AppDb, orgId: string, limit = 50): ReviewSubmissionRecord[] {
  return db
    .query<Row>("SELECT * FROM review_submissions WHERE org_id = ? ORDER BY created_at DESC LIMIT ?", [orgId, Math.max(1, Math.min(200, limit))])
    .map(mapSubmission);
}

const REVIEW_FILES_DIR = () => path.join(backendDataDir(), "review-submissions");

// WHAT AN UPLOADED PLAN SET'S TEXT FEEDS (#532). The deterministic checks used to read the first
// 20,000 characters of the first 40 pages: a real ~25-page set ran to ~36,000 characters, so the
// back half — where the cut sheets and certificates sit — was never read. They now read every page
// (up to REVIEW_TEXT_MAX_PAGES; a longer set's unread pages are named on the report). The AI second
// opinion's text is a PROMPT and keeps its old size: nothing new is sent to the model.
/** Pages of an uploaded plan set whose text the deterministic checks read. */
export const REVIEW_TEXT_MAX_PAGES = 200;
/** Characters of plan text handed to the AI second opinion (reviewPlanSetGeneral) — unchanged. */
export const REVIEW_AI_TEXT_CHARS = 20000;
/** First sheets rendered for the AI second opinion (intake triage) — unchanged. */
const REVIEW_AI_PAGE_IMAGES = 6;

/** The text checks did not read the whole plan set: say which pages they did not read. `total`
 *  null = the text could not be extracted at all, so no page was read (and the count is unknown). */
export function unreadPagesFinding(read: number, total: number | null): ReviewerFinding {
  const failed = total == null;
  const unread = failed ? "" : total - read === 1 ? `Page ${total} was` : `Pages ${read + 1}–${total} were`;
  return {
    id: "reviewer.plan.text-pages-not-read",
    severity: "callout",
    category: "plan_set",
    title: failed ? "Plan set text not read" : "Plan set only partly read",
    message: failed
      ? "The plan set's text could not be extracted, so the text checks read none of its pages; nothing stated only in the plan set is reflected in this report."
      : `The plan set has ${total} pages; the text checks read pages 1–${read}. ${unread} not read, so nothing stated only there is reflected in this report.`,
    cityFeedback: "",
    designTeamAction: failed
      ? "Review the plan set by hand, or re-export it as a standard PDF and submit it again."
      : `Review page${total - read === 1 ? ` ${total}` : `s ${read + 1}–${total}`} by hand, or submit the plan set in parts.`,
    evidenceNeeded: [],
    codeReferences: [],
    installerCallout: false,
    evidenceStatus: "missing",
    evidenceFound: [{
      kind: "absence_check",
      label: "Pages not read",
      source: "Plan-set text extraction",
      excerpt: failed ? "Text extraction failed: 0 pages read." : `Read ${read} of ${total} pages (cap ${REVIEW_TEXT_MAX_PAGES}).`,
      confidence: "high",
      pageHint: "",
      screenshotPath: "",
      verifier: "rule_engine",
      note: failed ? "The plan set could not be parsed for text." : "The text checks read at most the first pages of an uploaded plan set.",
    }],
  };
}

/** The full standalone review flow. Never leaks internals: a failure records a
 *  failed submission with the reason instead of a 500 with a stack.
 *  `opts.llm` replaces the configured provider (tests; no spend). */
export async function runStandaloneReview(
  db: AppDb,
  orgId: string,
  subject: ReviewSubject,
  planset?: { buffer: Buffer; filename: string },
  opts: { llm?: LLMProvider } = {},
): Promise<{ submission: ReviewSubmissionRecord; report: ReviewerReport; ai: AiPlanReviewResult | null }> {
  const submissionId = id();
  const ts = nowIso();
  const ctx = resolveEffectiveCodeContext(db, subject.state, subject.ahj);
  // AUTONOMY: first contact with an un-profiled jurisdiction auto-queues web
  // research for its missing layers (state default + this county/city) so the
  // next review runs against seeded adopted-code data without anyone asking.
  if (!ctx.verified) ensureCodeProfilesResearched(db, subject.state, subject.ahj);
  const project = reviewSubjectToProject(subject, submissionId);
  const snapshot = project.parserSnapshot as Record<string, string>;
  // What the title-block-only-sheet read found is written by that read alone, never by the caller.
  delete snapshot[IMAGE_SHEET_LISTING_READINGS_KEY];
  delete snapshot[IMAGE_SHEET_LISTING_COVERAGE_KEY];
  const llm = opts.llm ?? createLLMProvider();
  const pack = reviewPackFor(subject.workType);

  // Persist the plan set (if provided) so the report's evidence can be revisited.
  let plansetPath = "";
  let pageImagesBase64: string[] = [];
  let extractedText = subject.fields?.splitPagesText ? String(subject.fields.splitPagesText) : "";
  let unreadPages: { read: number; total: number | null } | null = null;
  if (planset && planset.buffer.length > 0) {
    fs.mkdirSync(REVIEW_FILES_DIR(), { recursive: true });
    plansetPath = path.join(REVIEW_FILES_DIR(), `${submissionId}.pdf`);
    fs.writeFileSync(plansetPath, planset.buffer);
    let pages: string[] = [];
    try {
      // The page count comes from the SAME pdf.js parse as the text: a second parser's count (the
      // pdf-lib raster count) could fail alone and silently drop what the cap left unread.
      const extracted = await extractPdfPagesCounted(plansetPath, REVIEW_TEXT_MAX_PAGES);
      pages = extracted.pages;
      if (extracted.pageCount > pages.length) unreadPages = { read: pages.length, total: extracted.pageCount };
      const fullText = pages.join("\n");
      if (!extractedText) extractedText = fullText.slice(0, REVIEW_AI_TEXT_CHARS);
      // The solar pack's plan-text checks read splitPagesText — every page of it.
      if (fullText && !snapshot.splitPagesText) snapshot.splitPagesText = fullText;
      // Render the first sheets for the AI vision pass (intake triage).
      const renderCount = Math.min(pages.length || 1, REVIEW_AI_PAGE_IMAGES);
      for (let p = 1; p <= renderCount; p++) {
        try {
          const png = await renderPdfPageToPng(plansetPath, p, 1.4);
          pageImagesBase64.push(png.toString("base64"));
        } catch { /* skip unrenderable page */ }
      }
    } catch (err) {
      logger.warn("review", `plan-set extraction failed: ${err instanceof Error ? err.message : String(err)}`);
      // No page's text was read: the report says so rather than reading as a clean plan set.
      pages = [];
      unreadPages = { read: 0, total: null };
    }
    // LISTING MARKS ON TITLE-BLOCK-ONLY SHEETS (#532): only for the solar pack (the only one with
    // the UL LISTINGS rule), and only for the listings the text left unshown — the rule's own
    // reader decides, so a set whose text shows both pays for nothing.
    if (pack.deterministic && pages.length) {
      const shown = packageListings(project);
      const want = { module: !shown.module, racking: !shown.racking };
      if (want.module || want.racking) {
        try {
          const read = await readImageSheetListings(llm instanceof StubLLMProvider ? null : llm, planset.buffer, pages, { want });
          snapshot[IMAGE_SHEET_LISTING_READINGS_KEY] = JSON.stringify(read.readings);
          if (read.coverage) snapshot[IMAGE_SHEET_LISTING_COVERAGE_KEY] = read.coverage;
        } catch (err) {
          // Never the response: only that the read failed.
          logger.warn("review", `image-sheet listing read failed: ${err instanceof Error ? err.message : String(err)}`);
          // An unknown, said as one: not even which sheets would have qualified is known.
          snapshot[IMAGE_SHEET_LISTING_COVERAGE_KEY] = "The plan set's sheets could not be checked for listing marks: the read failed, so no sheet was read by vision.";
        }
      }
    }
  }

  const { report, ai } = await runReviewPack({
    workType: subject.workType,
    project,
    ctx,
    llm,
    pageImagesBase64,
    extractedText,
    // AI second opinion beside the deterministic solar pack only when there is
    // something visual/textual for it to read.
    includeAiSecondOpinion: pack.deterministic && (pageImagesBase64.length > 0),
  });
  // A set longer than the text cap: the report names what the text checks never read.
  if (unreadPages) report.findings.push(unreadPagesFinding(unreadPages.read, unreadPages.total));

  db.run(
    `INSERT INTO review_submissions
      (id, org_id, work_type, state, ahj, status, subject_json, report_json, ai_summary, planset_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [submissionId, orgId, subject.workType, subject.state, subject.ahj, "complete", asJson(subject), asJson(report), ai?.summary || "", plansetPath, ts],
  );
  addAuditLog(db, null, "system", "review-gate", "review.submitted", {
    submissionId, orgId, workType: subject.workType, state: subject.state, ahj: subject.ahj,
    blockers: report.findings.filter((f) => f.severity === "blocker").length,
    codeProfileSource: ctx.source,
  });
  return { submission: getReviewSubmission(db, orgId, submissionId)!, report, ai };
}
