// ONE LETTER, ONE NOTICE (#523). The portal poll reads the correction first; the agency's email about
// the same correction arrives later. Through the REAL writer (recordPermitStatusCheck, source portal)
// and the REAL email tracker (runEmailTracker) on a scratch DB:
//   1. the email's correction is an item of the polled notice (same notice_id), its words kept, and
//      the team gets ONE correction alert, not two;
//   2. once the polled correction is CLOSED (that round answered), an emailed correction on the same
//      filing is a notice of its own, with its own alert;
//   3. a polled correction older than SAME_NOTICE_WINDOW_DAYS does not swallow an emailed one.
//   npx tsx backend/test/correctionSameNotice.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "correction-same-notice-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
for (const k of ["BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
for (const k of ["SMTP_HOST", "SMTP_FROM", "ANTHROPIC_API_KEY", "STAFF_ALERT_TO", "STAFF_ALERT_WEBHOOK_URL", "CLIENT_NOTIFICATIONS"]) delete process.env[k];

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");

const db = await openDatabase();
let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
const mkProjectWithTarget = (street: string, app: string): { pid: string; tid: string } => {
  const pid = R.createProject(db, {
    owner: `Notice Probe ${++seq}`, state: "OR", dcKw: "8.4", acKw: "7.7", permitPath: "prescriptive",
    street, city: "Coos Bay", zip: "97420", ahj: "City of Coos Bay", utility: "Pacific Power",
  } as never).project.id;
  db.run("UPDATE projects SET status = 'submitted' WHERE id = ?", [pid]);
  const d = R.createPermitCheckTarget(db, pid, { targetType: "permit", permitType: "building", jurisdiction: "City of Coos Bay", portalName: "X", portalUrl: "", applicationNumber: app } as never);
  const tid = (d as unknown as { permitCheckTargets: Array<{ id: string; applicationNumber: string }> }).permitCheckTargets.find((t) => t.applicationNumber === app)!.id;
  return { pid, tid };
};
const poll = async (pid: string, tid: string): Promise<void> => {
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "portal", rawStatusText: "Record Status: Corrections Required" });
  await sleep(100);
};
const email = async (street: string, app: string): Promise<void> => {
  const file = path.join(tmp, `m${++seq}.mbox`);
  fs.writeFileSync(file, `From x@y Mon Nov  2 10:0${seq % 10}:00 2026\nFrom: plans@coosbay.example.gov\nSubject: Plan review comments - building permit ${app}\nDate: ${new Date().toUTCString()}\n\nPlan review comments for building permit ${app} at ${street}, Coos Bay, OR 97420. Please revise the roof framing plan and resubmit.\n`);
  const label = path.basename(file);
  const source = R.configureEmailTrackingSource(db, { filePath: file, label }).sources.find((s) => s.label === label)!;
  const run = await R.runEmailTracker(db, { sourceId: source.id });
  assert.equal(run.projectMatches, 1, JSON.stringify(run));
  await sleep(250);
};
const corrections = (pid: string) => db.query<{ id: string; source: string; notice_id: string; correction_text: string }>(
  "SELECT id, source, notice_id, correction_text FROM corrections WHERE project_id = ? ORDER BY rowid", [pid]);
const correctionAlerts = (pid: string) => db.query<{ ref: string }>("SELECT ref FROM staff_notifications WHERE kind = 'correction' AND project_id = ?", [pid]);

await check("poll first, then the agency's email: one notice, the email's words kept, one staff alert", async () => {
  const { pid, tid } = mkProjectWithTarget("10 Harbor View Rd", "25-100100");
  await poll(pid, tid);
  assert.equal(corrections(pid).length, 1, "the poll opened no correction");
  await email("10 Harbor View Rd", "25-100100");
  const rows = corrections(pid);
  assert.equal(rows.length, 2, `expected the email's item beside the polled one, found ${rows.length}`);
  assert.deepEqual(rows.map((r) => r.source), ["portal", "email"]);
  assert.equal(rows[1].notice_id, rows[0].notice_id, "the email's item is a notice of its own");
  assert.match(rows[1].correction_text, /roof framing/i, "the email's words were not kept");
  assert.equal(correctionAlerts(pid).length, 1, `the team was alerted ${correctionAlerts(pid).length} times`);
});

await check("a closed polled correction (the previous round) never swallows an emailed one", async () => {
  const { pid, tid } = mkProjectWithTarget("20 Harbor View Rd", "25-200200");
  await poll(pid, tid);
  R.resolveCorrection(db, corrections(pid)[0].id, { resubmitted: true, actor: { type: "human", name: "test" } } as never);
  // The agency's email about its next round arrives while the filing still reads correction.
  const beforeEmail = corrections(pid);
  await email("20 Harbor View Rd", "25-200200");
  const rows = corrections(pid);
  const emailed = rows.find((r) => r.source === "email")!;
  assert.ok(emailed, "no emailed correction");
  const closedNotice = beforeEmail[0].notice_id;
  assert.notEqual(emailed.notice_id, closedNotice, "grouped under a closed notice");
});

await check(`a polled correction older than the window does not swallow an emailed one`, async () => {
  const { pid, tid } = mkProjectWithTarget("30 Harbor View Rd", "25-300300");
  await poll(pid, tid);
  const old = new Date(Date.now() - (R.SAME_NOTICE_WINDOW_DAYS + 3) * 86_400_000).toISOString();
  db.run("UPDATE corrections SET created_at = ? WHERE project_id = ?", [old, pid]);
  await email("30 Harbor View Rd", "25-300300");
  const rows = corrections(pid);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[1].notice_id, rows[0].notice_id, "an old polled notice swallowed a new email");
  assert.equal(correctionAlerts(pid).length, 2, "the new notice did not alert");
});

if (failures) {
  console.error(`FAIL - correctionSameNotice: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("correctionSameNotice: all checks passed");
process.exit(0);
