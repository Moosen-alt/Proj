// ---------------------------------------------------------------------------
// FEE ACCURACY: WHAT WE QUOTED BESIDE WHAT WAS PAID, PER JURISDICTION (#494).
//
// Fee quotes are about to be sold to clients, and nothing compared a quote with the bill. Portland
// quotes low (#421) and that was found by hand, from the owner's own receipts. This module finds
// the next one: for every filed job carrying BOTH a quote and a paid figure it computes the miss,
// groups by AHJ (permit) / utility (nem), and flags any jurisdiction whose quotes miss by more
// than the threshold (10% unless set).
//
// THE QUOTE is the one in force when the track was filed, snapshotted then (fee_quote_snapshots,
// migration v56) by the two filing doors. It is the RESEARCHED ladder's figure (learned history,
// published schedule, estimate, printed form), never the portal's own number, which is what it is
// graded against. A job filed before snapshots existed falls back to the estimate frozen on its
// paid or waived payment row (a re-quote never rewrites one), and says so; a job whose payment row
// is still open has no frozen quote and is left out rather than graded on a number that moved.
//
// THE PAID FIGURE, most trusted first, and only a whole, settled figure counts:
//   1. the person's actual (submission_payments.permit_fee_actual_usd, "Record real fee");
//   2. the portal's own read, only when COMPLETE (every filed record read) and FINAL (every
//      record issued). A partial or provisional read is a lower bound and never counts;
//   3. permit track only: the paid receipts' authority amounts (receipt_component:*), else the
//      authority's billing summaries (fee_summary:*), only when they name every filed record of
//      the track (a receipt for one of two permits is half a bill).
//
// RULE 3: this is a report. It reads; it never writes "verified" onto a fee and never changes a
// schedule. The only write in this file is the filing-time snapshot, into its own table.
// ---------------------------------------------------------------------------

import type { AppDb } from "./db";
import type {
  FeeAccuracyExclusion,
  FeeAccuracyGroup,
  FeeAccuracyJob,
  FeeAccuracyPaidSource,
  FeeAccuracyReport,
  ProjectRecord,
} from "../../shared/src/types";
import { billingTrack, researchedPermitQuote } from "./submissionFees";
import { portalFeeSummary } from "./portalFeeReadings";
import { trackKind } from "./permitMonitor";
import { orgClause } from "./scope";
import { id } from "./ids";
import { text } from "./json";
import { nowIso } from "./time";
import { logger } from "./logger";

type Row = Record<string, unknown>;
type Track = "permit" | "nem";

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;

export const DEFAULT_FEE_ACCURACY_THRESHOLD_PCT = 10;

/** The flag threshold: the caller's, else FEE_ACCURACY_THRESHOLD_PCT, else 10. A value that is
 *  not a number in 0..1000 is ignored rather than turning every jurisdiction red (or none). */
export function feeAccuracyThresholdPct(requested?: unknown): number {
  for (const raw of [requested, process.env.FEE_ACCURACY_THRESHOLD_PCT]) {
    if (raw == null || raw === "") continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 1000) return n;
  }
  return DEFAULT_FEE_ACCURACY_THRESHOLD_PCT;
}

// ── the snapshot, taken by the filing doors ─────────────────────────────────────────────────

/**
 * Keep the quote in force as this track is filed, ONCE per project and billing track: a second
 * permit of the same track, a re-capture or a refiling keeps the first. Returns whether a row was
 * written. NEVER THROWS — the filing is the precious fact; a fee lookup that fails must not cost
 * it its record, so the caller runs this after its own transaction and a failure is logged.
 */
export function snapshotFilingQuote(db: AppDb, project: ProjectRecord, permitType: string, submissionId = ""): boolean {
  const track = billingTrack(permitType);
  try {
    if (db.get("SELECT 1 AS hit FROM fee_quote_snapshots WHERE project_id = ? AND track = ?", [project.id, track])) return false;
    const q = researchedPermitQuote(db, project, track);
    db.run(
      `INSERT OR IGNORE INTO fee_quote_snapshots
         (id, project_id, track, submission_id, state, jurisdiction, quoted_usd, source, confidence, basis, snapshotted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id(), project.id, track, submissionId, text(project.state), q.jurisdiction, q.usd, q.source, q.confidence, q.basis.slice(0, 2000), nowIso()],
    );
    return true;
  } catch (err) {
    logger.warn("fees", "could not snapshot the quote at filing — the filing is recorded, the fee accuracy report will leave this job out", {
      projectId: project.id, track, err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ── the quote a job is graded on ────────────────────────────────────────────────────────────

interface Quote { usd: number | null; source: FeeAccuracyJob["quoteSource"]; confidence: string; basis: string; at: string }

function quoteFor(db: AppDb, projectId: string, track: Track): Quote | FeeAccuracyExclusion["reason"] {
  const snap = db.get<Row>("SELECT * FROM fee_quote_snapshots WHERE project_id = ? AND track = ?", [projectId, track]);
  if (snap) {
    return {
      usd: snap.quoted_usd == null ? null : Number(snap.quoted_usd),
      source: text(snap.source) as FeeAccuracyJob["quoteSource"],
      confidence: text(snap.confidence),
      basis: text(snap.basis),
      at: text(snap.snapshotted_at),
    };
  }
  // FILED BEFORE SNAPSHOTS. A paid or waived payment row is frozen (a re-quote never rewrites
  // one) and was settled before staging, so its estimate is what the client was quoted. A row
  // still 'quoted' is refreshed by every view of the fee panel and has been since the filing.
  const pay = db.get<Row>("SELECT * FROM submission_payments WHERE project_id = ? AND track = ?", [projectId, track]);
  if (!pay) return "no_quote";
  if (!["paid", "waived"].includes(text(pay.status))) return "quote_not_frozen";
  return {
    usd: pay.permit_fee_estimate_usd == null ? null : Number(pay.permit_fee_estimate_usd),
    source: "payment_row",
    confidence: "",
    basis: "The researched estimate stored on the paid quote (filed before filing-time quotes were kept).",
    at: text(pay.paid_at) || text(pay.quoted_at),
  };
}

// ── the paid figure ─────────────────────────────────────────────────────────────────────────

interface Paid { usd: number; source: FeeAccuracyPaidSource; basis: string }

const norm = (s: string): string => s.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

/** Does a receipt's / summary's permit number name this filed record? Separators ignored, and
 *  otherwise EXACT: "HAL-26-0001" does not name "HAL-26-0001-E" (a building receipt is not the
 *  electrical permit's). The one widening is a billing summary's base number: Portland bills a
 *  revision ("26-050978-REV-01-RS") under its original's base ("26-050978"), which is how
 *  feeSummary groups the two, so a summary names a record that carries that base. */
function namesRecord(docPermit: string, recordNumber: string, byBase: boolean): boolean {
  const record = norm(recordNumber);
  if (!record) return false;
  if (norm(docPermit) === record) return true;
  const base = byBase ? norm(/^(\d{2}-\d{5,})/.exec(docPermit.trim())?.[1] ?? "") : "";
  return base.length >= 7 && record.startsWith(base) && /^\d{2}-\d{5,}/.test(recordNumber.trim());
}

/** The record numbers of this project's filed permit records (active permit-track targets). */
function filedPermitRecords(db: AppDb, projectId: string): string[] {
  return db.query<Row>(
    "SELECT target_type, permit_type, permit_number, application_number FROM permit_check_targets WHERE project_id = ? AND active = 1",
    [projectId],
  )
    .filter((r) => trackKind(text(r.target_type), text(r.permit_type)) === "permit")
    .map((r) => text(r.permit_number) || text(r.application_number))
    .filter(Boolean);
}

function paidFor(db: AppDb, projectId: string, track: Track): Paid | { reason: FeeAccuracyExclusion["reason"]; detail: string } {
  const pay = db.get<Row>("SELECT permit_fee_actual_usd FROM submission_payments WHERE project_id = ? AND track = ?", [projectId, track]);
  const actual = pay?.permit_fee_actual_usd == null ? null : Number(pay.permit_fee_actual_usd);
  if (actual != null && Number.isFinite(actual) && actual > 0) {
    return { usd: round2(actual), source: "actual", basis: "Entered by a person from the portal's fee screen." };
  }

  // The portal's own read: the whole track, settled. Anything less is remembered as the reason.
  let partial: { reason: FeeAccuracyExclusion["reason"]; detail: string } | null = null;
  const portal = portalFeeSummary(db, projectId, track);
  if (portal && portal.totalUsd != null && portal.totalUsd > 0) {
    if (portal.complete && portal.final) {
      return { usd: round2(portal.totalUsd), source: "portal_record", basis: `The portal's own fee, ${portal.provenance}.` };
    }
    partial = !portal.complete
      ? { reason: "partial_portal_read", detail: `Read $${portal.totalUsd.toFixed(2)} so far; ${portal.unread.length} filed record(s) not read yet.` }
      : { reason: "provisional_portal_read", detail: `Read $${portal.totalUsd.toFixed(2)} while a record was still in review; the jurisdiction may invoice more.` };
  }

  if (track === "permit") {
    const filed = filedPermitRecords(db, projectId);
    const covers = (permits: string[], byBase: boolean): boolean => filed.every((rec) => permits.some((p) => namesRecord(p, rec, byBase)));
    // Paid receipts first: proof the money moved. The authority's amount, never the processor's fee.
    const receipts = db.query<Row>(
      "SELECT source FROM permit_fee_history WHERE project_id = ? AND source LIKE 'receipt_component:%'",
      [projectId],
    ).flatMap((r) => {
      try {
        const parsed = JSON.parse(text(r.source).slice("receipt_component:".length)) as { permitNumber?: string; authorityAmountUsd?: number };
        const amount = Number(parsed.authorityAmountUsd);
        return Number.isFinite(amount) && amount >= 0 ? [{ permit: text(parsed.permitNumber), amount }] : [];
      } catch { return []; }
    });
    const summaries = db.query<Row>(
      "SELECT fee_usd, source FROM permit_fee_history WHERE project_id = ? AND source LIKE 'fee_summary:%'",
      [projectId],
    ).map((r) => ({ permit: text(r.source).slice("fee_summary:".length), amount: Number(r.fee_usd) }))
      .filter((r) => Number.isFinite(r.amount) && r.amount >= 0);
    for (const [docs, source, what] of [
      [receipts, "receipts", "paid receipt"],
      [summaries, "billing_summary", "billing summar"],
    ] as const) {
      if (!docs.length) continue;
      const total = round2(docs.reduce((s, d) => s + d.amount, 0));
      const plural = what === "paid receipt" ? (docs.length === 1 ? "" : "s") : (docs.length === 1 ? "y" : "ies");
      if (total > 0 && covers(docs.map((d) => d.permit), source === "billing_summary")) {
        return {
          usd: total,
          source,
          basis: `Total of ${docs.length} ${what}${plural} (${docs.map((d) => d.permit || "no permit number").join(", ")})`
            + (filed.length ? "." : "; no filed record is on file to check that they are the whole bill."),
        };
      }
      if (total > 0 && !partial) {
        partial = { reason: "receipts_incomplete", detail: `${docs.length} ${what}${plural} totalling $${total.toFixed(2)} do not name every filed record (${filed.join(", ")}).` };
      }
    }
  }
  return partial ?? { reason: "no_paid_figure", detail: "No paid figure recorded yet." };
}

// ── the report ──────────────────────────────────────────────────────────────────────────────

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const groupKey = (track: Track, state: string, jurisdiction: string): string =>
  `${track}|${state.trim().toUpperCase()}|${jurisdiction.replace(/\s+/g, " ").trim().toLowerCase()}`;

/**
 * Every filed job in scope, graded. `orgId` follows the data-layer convention: a tenant's id, or
 * null for every org (superadmin). Grouped by the project's AHJ as entered (permit) or utility
 * (nem) and the state, so the operator reads it under the name they file by.
 */
export function buildFeeAccuracyReport(db: AppDb, orgId: string | null, opts: { thresholdPct?: unknown } = {}): FeeAccuracyReport {
  const thresholdPct = feeAccuracyThresholdPct(opts.thresholdPct);
  const scope = orgClause(orgId, "p.org_id");

  // The jobs: every (project, billing track) that was filed, plus any that carry a snapshot.
  const filed = db.query<Row>(
    `SELECT p.id AS project_id, p.homeowner_name, p.state, p.ahj, p.utility, s.permit_type, s.submission_type, s.submitted_at
       FROM submissions s JOIN projects p ON p.id = s.project_id
      WHERE s.status = 'submitted'${scope.clause}
      ORDER BY s.submitted_at`,
    [...scope.params],
  );
  const snapped = db.query<Row>(
    `SELECT p.id AS project_id, p.homeowner_name, p.state, p.ahj, p.utility, f.track, f.snapshotted_at
       FROM fee_quote_snapshots f JOIN projects p ON p.id = f.project_id
      WHERE 1 = 1${scope.clause}`,
    [...scope.params],
  );
  const jobs = new Map<string, { projectId: string; label: string; state: string; jurisdiction: string; track: Track; filedAt: string }>();
  const addJob = (r: Row, track: Track, filedAt: string): void => {
    const key = `${text(r.project_id)}|${track}`;
    if (jobs.has(key)) return;
    jobs.set(key, {
      projectId: text(r.project_id),
      label: text(r.homeowner_name) || text(r.project_id),
      state: text(r.state),
      jurisdiction: text(track === "nem" ? r.utility : r.ahj),
      track,
      filedAt,
    });
  };
  for (const r of filed) {
    const track: Track = text(r.submission_type) === "interconnection" ? "nem" : billingTrack(text(r.permit_type));
    addJob(r, track, text(r.submitted_at));
  }
  for (const r of snapped) addJob(r, billingTrack(text(r.track)), text(r.snapshotted_at));

  const groups = new Map<string, FeeAccuracyGroup>();
  const excluded: FeeAccuracyExclusion[] = [];
  for (const job of jobs.values()) {
    const base = { projectId: job.projectId, label: job.label, track: job.track, state: job.state, jurisdiction: job.jurisdiction };
    const quote = quoteFor(db, job.projectId, job.track);
    if (typeof quote === "string") {
      excluded.push({ ...base, reason: quote, detail: quote === "no_quote" ? "No quote was kept for this filing." : "Filed before quotes were kept, and its payment row is still open, so the quote has moved since." });
      continue;
    }
    if (quote.usd == null) {
      excluded.push({ ...base, reason: "no_researched_figure", detail: "The quote at filing had no amount (nothing priced this job)." });
      continue;
    }
    const paid = paidFor(db, job.projectId, job.track);
    if ("reason" in paid) {
      excluded.push({ ...base, reason: paid.reason, detail: paid.detail });
      continue;
    }
    const missUsd = round2(quote.usd - paid.usd);
    const graded: FeeAccuracyJob = {
      projectId: job.projectId,
      label: job.label,
      filedAt: job.filedAt,
      quotedUsd: round2(quote.usd),
      quoteSource: quote.source,
      quoteConfidence: quote.confidence,
      quoteBasis: quote.basis,
      quotedAt: quote.at,
      paidUsd: paid.usd,
      paidSource: paid.source,
      paidBasis: paid.basis,
      missUsd,
      // Against what was PAID: a $80 quote on a $100 bill is 20% low.
      missPct: round1((missUsd / paid.usd) * 100),
    };
    const key = groupKey(job.track, job.state, job.jurisdiction);
    let g = groups.get(key);
    if (!g) {
      g = {
        track: job.track, state: job.state, jurisdiction: job.jurisdiction || "(no jurisdiction on the project)",
        n: 0, medianMissPct: 0, medianAbsMissPct: 0, worstMissPct: 0, direction: "on", flagged: false, jobs: [],
      };
      groups.set(key, g);
    }
    g.jobs.push(graded);
  }

  for (const g of groups.values()) {
    const misses = g.jobs.map((j) => j.missPct);
    g.n = g.jobs.length;
    g.medianMissPct = round1(median(misses));
    g.medianAbsMissPct = round1(median(misses.map(Math.abs)));
    g.worstMissPct = misses.reduce((w, m) => (Math.abs(m) > Math.abs(w) ? m : w), 0);
    // THE TYPICAL MISS, NOT THE ONE BAD JOB: a jurisdiction is flagged when its median absolute
    // miss is over the threshold. The worst job is shown beside it either way.
    g.flagged = g.medianAbsMissPct > thresholdPct;
    g.direction = Math.abs(g.medianMissPct) <= thresholdPct ? "on" : g.medianMissPct < 0 ? "low" : "high";
    g.jobs.sort((a, b) => Math.abs(b.missPct) - Math.abs(a.missPct));
  }
  const sorted = [...groups.values()].sort((a, b) =>
    Number(b.flagged) - Number(a.flagged) || b.medianAbsMissPct - a.medianAbsMissPct || a.jurisdiction.localeCompare(b.jurisdiction));

  return {
    thresholdPct,
    generatedAt: nowIso(),
    groups: sorted,
    excluded,
    notes: [
      "Quote: the researched figure kept when the track was filed (never the portal's own number). Jobs filed before quotes were kept use the estimate frozen on their paid quote.",
      "Paid: a person's recorded fee first, then the portal's read only when every filed record is read and issued, then paid receipts or billing summaries that name every filed record. Partial or provisional reads never count.",
      "Miss % = (quoted − paid) ÷ paid. Negative means we quoted low. A jurisdiction is flagged when its median absolute miss is over the threshold.",
    ],
  };
}
