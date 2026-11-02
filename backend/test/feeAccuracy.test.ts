// FEE ACCURACY: QUOTED AT FILING VS PAID, PER JURISDICTION (#494).
//
// Portland quotes low (#421) and that was found by hand from the owner's receipts. This pins the
// report that finds the next one, on synthetic jobs (no real names, numbers or portals):
//
//   1. THE SNAPSHOT: markTrackSubmitted keeps the researched quote in force at filing, ONCE per
//      billing track — a second permit of the same track, and a fee recorded afterwards, leave it
//      as it was; captureConfirmation (the staged-run door) keeps one too.
//   2. THE PAID LADDER: a person's actual first; the portal's read only complete AND final;
//      receipts only when they name every filed record. A partial or provisional read, or half a
//      set of receipts, never counts — the job is listed as excluded with why.
//   3. THE REPORT: one AHJ within tolerance (not flagged), one low by 20% (flagged "low", jobs
//      linked), one with only partial reads (excluded, no group); median, worst and n per group;
//      the threshold is configurable; a pre-snapshot job grades on its frozen paid quote and an
//      open one is left out.
//   4. SCOPED BY ORG: another org's job never reaches this org's report; null reads every org.
//   5. RULE 3: building the report writes nothing — no schedule, no "verified", no fee row.
//   6. THE PANEL (frontend/fee-accuracy.js through node:vm): flagged row says "quotes LOW", jobs
//      link to their project, exclusions are counted by reason, everything escaped.
//
// Kill (measured): count any portal read in feeAccuracy.paidFor (`if (portal.complete &&
// portal.final)` -> `if (true)`) -> 2c, 3c and 6 FAIL. Kill (measured): drop snapshotFilingQuote's
// "already kept" return and make its insert OR REPLACE -> 1b FAILS (the quote moves on refiling).
//   npx tsx backend/test/feeAccuracy.test.ts
import "./_isolate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { REPO } from "./_isolate";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fee-accuracy-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SUBMISSION_SERVICE_FEE_USD = "0";
for (const k of ["BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH", "CLIENT_NOTIFICATIONS", "CODE_RESEARCH"]) process.env[k] = "off";
for (const k of ["SMTP_HOST", "SMTP_FROM", "ANTHROPIC_API_KEY", "FEE_ACCURACY_THRESHOLD_PCT"]) delete process.env[k];

const { openDatabase, DEFAULT_ORG_ID } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject, captureConfirmation } = await import("../src/repository");
const { markTrackSubmitted } = await import("../src/submittalTracks");
const { recordActualPermitFee, researchedPermitQuote } = await import("../src/submissionFees");
const { buildFeeAccuracyReport, snapshotFilingQuote, feeAccuracyThresholdPct } = await import("../src/feeAccuracy");

const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const ORG_B = "org-fee-accuracy-b";
db.run("INSERT OR IGNORE INTO orgs (id, name, edition, created_at) VALUES (?, 'Other Co', 'full', ?)", [ORG_B, new Date().toISOString()]);
const client = createClient(db, { companyName: "Accuracy Sample Solar", billingMode: "per_submission", serviceFeeUsd: "0" });
const clientB = createClient(db, { companyName: "Other Sample Solar", serviceFeeUsd: "0" }, ORG_B);

let n = 0;
const mk = (ahj: string, org = DEFAULT_ORG_ID, owner?: string) => createProject(db, {
  clientId: org === DEFAULT_ORG_ID ? client.id : clientB.id,
  owner: owner ?? `Sample Owner ${++n}`, street: `${n} Sample St`, city: "Sampleville",
  state: "OR", ahj, utility: "Sample Power", dcKw: "8", acKw: "6.4",
}, org).project;

const ts = new Date().toISOString();
let seq = 0;
const uid = (p: string) => `${p}-${++seq}`;

/** A filed permit track with a quote kept at filing (inserted directly so the amounts are exact). */
function filed(projectId: string, quotedUsd?: number | null, track: "permit" | "nem" = "permit"): void {
  db.run(
    `INSERT INTO submissions (id, project_id, portal_profile_id, submission_type, permit_type, status, submitted_at, created_at)
     VALUES (?, ?, NULL, ?, ?, 'submitted', ?, ?)`,
    [uid("sub"), projectId, track === "nem" ? "interconnection" : "permit", track === "nem" ? "nem" : "building", ts, ts],
  );
  if (quotedUsd !== undefined) {
    db.run(
      `INSERT INTO fee_quote_snapshots (id, project_id, track, state, jurisdiction, quoted_usd, source, confidence, basis, snapshotted_at)
       VALUES (?, ?, ?, 'OR', '', ?, 'published_schedule', 'seeded', 'synthetic schedule line', ?)`,
      [uid("snap"), projectId, track, quotedUsd, ts],
    );
  }
}
function actual(projectId: string, usd: number, track: "permit" | "nem" = "permit"): void {
  db.run(
    `INSERT INTO submission_payments (id, project_id, track, status, permit_fee_estimate_usd, permit_fee_actual_usd, service_fee_usd, total_usd, fee_basis, quoted_at, updated_at)
     VALUES (?, ?, ?, 'paid', NULL, ?, 0, ?, '', ?, ?)
     ON CONFLICT(project_id, track) DO UPDATE SET permit_fee_actual_usd = excluded.permit_fee_actual_usd`,
    [uid("pay"), projectId, track, usd, usd, ts, ts],
  );
}
function target(projectId: string, record: string, outcome: string): string {
  const tid = uid("tgt");
  db.run(
    `INSERT INTO permit_check_targets (id, project_id, target_type, permit_type, permit_number, active, latest_outcome, created_at, updated_at)
     VALUES (?, ?, 'permit', 'building', ?, 1, ?, ?, ?)`,
    [tid, projectId, record, outcome, ts, ts],
  );
  return tid;
}
function portalRead(projectId: string, targetId: string, record: string, usd: number, outcome: string): void {
  db.run(
    `INSERT INTO portal_fee_readings (id, project_id, target_id, track, source_kind, record_number, status, total_usd, record_outcome, read_at, attempted_at)
     VALUES (?, ?, ?, 'permit', 'portal_record', ?, 'read', ?, ?, ?, ?)`,
    [uid("read"), projectId, targetId, record, usd, outcome, ts, ts],
  );
}
function receipt(projectId: string, permitNumber: string, authorityUsd: number): void {
  const r = { jurisdiction: "Sample", permitNumber, receiptNumber: uid("rc"), discipline: "building", authorityAmountUsd: authorityUsd, processingFeeUsd: 3.5, totalPaidUsd: authorityUsd + 3.5, paidAt: "2026-10-01" };
  db.run(
    "INSERT INTO permit_fee_history (id, state, ahj, utility, track, fee_usd, source, project_id, recorded_at) VALUES (?, 'OR', 'Sample', '', 'permit', ?, ?, ?, ?)",
    [uid("hist"), authorityUsd, `receipt_component:${JSON.stringify(r)}`, projectId, ts],
  );
}

// ── 1. the snapshot ─────────────────────────────────────────────────────────────────────────
const snapOf = (projectId: string, track = "permit") =>
  db.get<{ quoted_usd: number | null; source: string; basis: string; submission_id: string }>(
    "SELECT quoted_usd, source, basis, submission_id FROM fee_quote_snapshots WHERE project_id = ? AND track = ?", [projectId, track]);

const snapProject = mk("City of Snapshotton");
const expected = researchedPermitQuote(db, snapProject, "permit");
markTrackSubmitted(db, snapProject, "building", { applicationNumber: "SNAP-26-0001" });
check("1a. filing the track keeps the researched quote in force, with its source and basis, tied to the submission", () => {
  const row = snapOf(snapProject.id);
  assert.ok(row, "no snapshot was kept when the track was filed");
  assert.equal(row!.quoted_usd, expected.usd);
  assert.equal(row!.source, expected.source);
  assert.ok(row!.basis.length > 0, "the snapshot carries no basis");
  const sub = db.get<{ id: string }>("SELECT id FROM submissions WHERE project_id = ? AND permit_type = 'building'", [snapProject.id]);
  assert.equal(row!.submission_id, sub?.id);
});
check("1b. ONCE: a second permit of the same track and a fee recorded after filing leave the snapshot as it was", () => {
  const before = snapOf(snapProject.id);
  // Something that would move the ladder if it were re-run: a real fee for this AHJ.
  const neighbour = mk("City of Snapshotton");
  recordActualPermitFee(db, neighbour, "permit", 9999);
  recordActualPermitFee(db, snapProject, "permit", 4321);
  markTrackSubmitted(db, snapProject, "electrical", { applicationNumber: "SNAP-26-0002" });
  assert.equal(snapshotFilingQuote(db, snapProject, "building"), false, "a second snapshot call wrote again");
  const rows = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM fee_quote_snapshots WHERE project_id = ?", [snapProject.id]);
  assert.equal(Number(rows?.n), 1);
  assert.deepEqual(snapOf(snapProject.id), before);
});
check("1c. the NEM track keeps its own snapshot beside the permit one", () => {
  markTrackSubmitted(db, snapProject, "nem", { applicationNumber: "INX-0001" });
  assert.ok(snapOf(snapProject.id, "nem"), "no NEM snapshot");
  assert.ok(snapOf(snapProject.id, "permit"), "the permit snapshot went away");
});
check("1d. captureConfirmation (a staged run's door) keeps one too", () => {
  const p = mk("City of Snapshotton");
  const want = researchedPermitQuote(db, p, "permit");
  const runId = uid("run");
  db.run("INSERT INTO portal_runs (id, project_id, portal_profile_id, run_type, status, started_at, permit_type) VALUES (?, ?, NULL, 'stage', 'awaiting_human_submit', ?, 'building')", [runId, p.id, ts]);
  db.run("INSERT INTO submissions (id, project_id, portal_profile_id, submission_type, permit_type, status, created_at) VALUES (?, ?, NULL, 'permit', 'building', 'awaiting_human_submit', ?)", [uid("sub"), p.id, ts]);
  captureConfirmation(db, runId, { applicationNumber: "CAP-26-0001" });
  const row = snapOf(p.id);
  assert.ok(row, "captureConfirmation kept no quote");
  assert.equal(row!.quoted_usd, want.usd); assert.equal(row!.source, want.source);
});

// ── fixtures for the report ─────────────────────────────────────────────────────────────────
// Within tolerance: −4.8% (actual) and +2.6% (complete, issued portal read).
const w1 = mk("City of Withinton"); filed(w1.id, 100); actual(w1.id, 105);
const w2 = mk("City of Withinton"); filed(w2.id, 200);
portalRead(w2.id, target(w2.id, "WIT-26-0002", "issued"), "WIT-26-0002", 195, "issued");
// Low by 20%: an actual, and paid receipts naming the filed record.
const l1 = mk("City of Lowtown", DEFAULT_ORG_ID, "Owner <Lowtown>"); filed(l1.id, 80); actual(l1.id, 100);
const l2 = mk("City of Lowtown"); filed(l2.id, 160); target(l2.id, "LOW-26-0002", "issued"); receipt(l2.id, "LOW-26-0002", 200);
// Only partial reads: one of two records read; the other a full read taken while in review.
const p1 = mk("City of Partialton"); filed(p1.id, 100);
portalRead(p1.id, target(p1.id, "PAR-26-0001", "issued"), "PAR-26-0001", 150, "issued"); target(p1.id, "PAR-26-0001-E", "issued");
const p2 = mk("City of Partialton"); filed(p2.id, 100);
portalRead(p2.id, target(p2.id, "PAR-26-0002", "in_review"), "PAR-26-0002", 40, "in_review");
// Half a set of receipts: two records filed, a receipt for one.
const h1 = mk("City of Halfreceipt"); filed(h1.id, 100); target(h1.id, "HAL-26-0001", "issued"); target(h1.id, "HAL-26-0001-E", "issued"); receipt(h1.id, "HAL-26-0001", 300);
// Billing summaries (Portland-shaped numbers, synthetic): the original's and a revision's, summed.
const s1 = mk("City of Summaryton"); filed(s1.id, 300); target(s1.id, "26-050978-000-00-RS", "issued");
for (const [permit, usd] of [["26-050978-000-00-RS", 1175.83], ["26-050978-REV-01-RS", 302]] as const) {
  db.run("INSERT INTO permit_fee_history (id, state, ahj, utility, track, fee_usd, source, project_id, recorded_at) VALUES (?, 'OR', 'City of Summaryton', '', 'permit', ?, ?, ?, ?)",
    [uid("hist"), usd, `fee_summary:${permit}`, s1.id, ts]);
}
// Filed before snapshots: a paid quote (frozen) grades; an open one does not.
const f1 = mk("City of Frozenton"); filed(f1.id);
db.run(`INSERT INTO submission_payments (id, project_id, track, status, permit_fee_estimate_usd, permit_fee_actual_usd, service_fee_usd, total_usd, fee_basis, quoted_at, paid_at, updated_at)
        VALUES (?, ?, 'permit', 'paid', 90, 100, 0, 100, '', ?, ?, ?)`, [uid("pay"), f1.id, ts, ts, ts]);
const f2 = mk("City of Frozenton"); filed(f2.id);
db.run(`INSERT INTO submission_payments (id, project_id, track, status, permit_fee_estimate_usd, permit_fee_actual_usd, service_fee_usd, total_usd, fee_basis, quoted_at, updated_at)
        VALUES (?, ?, 'permit', 'quoted', 90, 100, 0, 100, '', ?, ?)`, [uid("pay"), f2.id, ts, ts]);
// Another org's job, 50% low, in an AHJ this org also files in.
const b1 = mk("City of Lowtown", ORG_B); filed(b1.id, 50); actual(b1.id, 100);

// ── 5 (before): the tables a report must never write ────────────────────────────────────────
const fingerprint = (): string => JSON.stringify(["fee_schedules", "permit_fee_history", "submission_payments", "fee_quote_snapshots", "portal_fee_readings"]
  .map((t) => db.query(`SELECT * FROM ${t} ORDER BY id`)));
const beforeReport = fingerprint();

const report = buildFeeAccuracyReport(db, DEFAULT_ORG_ID);
const group = (name: string) => report.groups.find((g) => g.jurisdiction === name);
const excludedFor = (projectId: string) => report.excluded.find((e) => e.projectId === projectId);

// ── 2. the paid ladder ──────────────────────────────────────────────────────────────────────
check("2a. a person's actual is the paid figure", () => {
  const j = group("City of Withinton")!.jobs.find((x) => x.projectId === w1.id)!;
  assert.equal(j.paidSource, "actual"); assert.equal(j.paidUsd, 105);
});
check("2b. a complete, final portal read counts; receipts naming every filed record count", () => {
  const j = group("City of Withinton")!.jobs.find((x) => x.projectId === w2.id)!;
  assert.equal(j.paidSource, "portal_record"); assert.equal(j.paidUsd, 195);
  const r = group("City of Lowtown")!.jobs.find((x) => x.projectId === l2.id)!;
  assert.equal(r.paidSource, "receipts"); assert.equal(r.paidUsd, 200, "the receipt's processing fee was counted as the jurisdiction's");
});
check("2c. a PARTIAL read and a PROVISIONAL read never count — excluded, with why", () => {
  assert.equal(excludedFor(p1.id)?.reason, "partial_portal_read");
  assert.equal(excludedFor(p2.id)?.reason, "provisional_portal_read");
});
check("2d. receipts for one of two filed records are half a bill — excluded", () => {
  assert.equal(excludedFor(h1.id)?.reason, "receipts_incomplete");
  assert.equal(group("City of Halfreceipt"), undefined);
});

check("2e. billing summaries naming the filed record (a revision by its base number) are summed", () => {
  const j = group("City of Summaryton")!.jobs[0];
  assert.equal(j.paidSource, "billing_summary"); assert.equal(j.paidUsd, 1477.83);
  assert.equal(j.missPct, round1(((300 - 1477.83) / 1477.83) * 100));
});

// ── 3. the report ───────────────────────────────────────────────────────────────────────────
check("3a. within tolerance: n, median, worst, and NOT flagged", () => {
  const g = group("City of Withinton")!;
  assert.equal(g.n, 2); assert.equal(g.track, "permit");
  assert.equal(g.worstMissPct, -4.8);
  assert.equal(g.medianMissPct, round1((-4.8 + 2.6) / 2));
  assert.equal(g.flagged, false); assert.equal(g.direction, "on");
});
check("3b. low by 20%: flagged, direction low, jobs linked; flagged groups sort first", () => {
  const g = group("City of Lowtown")!;
  assert.equal(g.n, 2, "another org's Lowtown job was counted");
  assert.equal(g.medianMissPct, -20); assert.equal(g.worstMissPct, -20);
  assert.equal(g.flagged, true); assert.equal(g.direction, "low");
  assert.deepEqual(g.jobs.map((j) => j.projectId).sort(), [l1.id, l2.id].sort());
  const firstUnflagged = report.groups.findIndex((x) => !x.flagged);
  assert.ok(report.groups.indexOf(g) < firstUnflagged, "a flagged jurisdiction sorted below an unflagged one");
});
check("3c. only partial reads: no group at all", () => {
  assert.equal(group("City of Partialton"), undefined);
});
check("3d. the threshold is configurable (argument, then env), and junk is ignored", () => {
  assert.equal(report.thresholdPct, 10);
  assert.equal(buildFeeAccuracyReport(db, DEFAULT_ORG_ID, { thresholdPct: "25" }).groups.find((g) => g.jurisdiction === "City of Lowtown")!.flagged, false);
  process.env.FEE_ACCURACY_THRESHOLD_PCT = "3";
  assert.equal(buildFeeAccuracyReport(db, DEFAULT_ORG_ID).groups.find((g) => g.jurisdiction === "City of Withinton")!.flagged, true, "median |miss| 3.7 > 3 should flag");
  delete process.env.FEE_ACCURACY_THRESHOLD_PCT;
  assert.equal(feeAccuracyThresholdPct("lots"), 10);
  assert.equal(feeAccuracyThresholdPct(-5), 10);
});
check("3e. filed before snapshots: a paid quote grades on its frozen estimate; an open one is left out", () => {
  const j = group("City of Frozenton")!.jobs.find((x) => x.projectId === f1.id)!;
  assert.equal(j.quoteSource, "payment_row"); assert.equal(j.quotedUsd, 90); assert.equal(j.missPct, -10);
  assert.equal(excludedFor(f2.id)?.reason, "quote_not_frozen");
});

// ── 4. org scope ────────────────────────────────────────────────────────────────────────────
check("4. scoped by org: another org's job never reaches this report; null reads every org", () => {
  assert.ok(!report.groups.some((g) => g.jobs.some((j) => j.projectId === b1.id)));
  assert.ok(!report.excluded.some((e) => e.projectId === b1.id));
  const orgB = buildFeeAccuracyReport(db, ORG_B);
  assert.deepEqual(orgB.groups.map((g) => g.jobs.map((j) => j.projectId)), [[b1.id]]);
  const all = buildFeeAccuracyReport(db, null);
  assert.equal(all.groups.find((g) => g.jurisdiction === "City of Lowtown")!.n, 3);
});

// ── 5. rule 3 ───────────────────────────────────────────────────────────────────────────────
check("5. RULE 3: building the report writes nothing (schedules, fee history, payments, snapshots, reads)", () => {
  assert.equal(fingerprint(), beforeReport);
});

// ── 6. the panel ────────────────────────────────────────────────────────────────────────────
check("6. the panel: flagged row says quotes LOW, jobs link to the project, exclusions counted, all escaped", () => {
  const src = fs.readFileSync(path.join(REPO, "frontend", "fee-accuracy.js"), "utf8");
  const sandbox: { window: Record<string, unknown> } = { window: {} };
  vm.runInNewContext(src, sandbox, { filename: "fee-accuracy.js" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const html = (sandbox.window.FeeAccuracy as any).renderFeeAccuracy(report) as string;
  assert.match(html, /quotes LOW/);
  assert.ok(html.includes(`href="#/project/${encodeURIComponent(l1.id)}"`), "the job does not link to its project");
  assert.ok(html.includes("Owner &lt;Lowtown&gt;") && !html.includes("Owner <Lowtown>"), "a job label was not escaped");
  assert.match(html, /Only a partial portal read \(1\)/);
  assert.match(html, /-20\.0%/);
});

function round1(x: number): number { return Math.round(x * 10) / 10; }

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nfee accuracy: all checks passed");
