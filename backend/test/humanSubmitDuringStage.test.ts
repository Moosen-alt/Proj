// #333 — A PERSON WHO FILES FROM THE REVIEW WINDOW WHILE THE RUN IS STILL FINISHING IS RECORDED.
//
// Live 2026-10-14 (Lincoln County via Oregon ePermitting): the replay stopped at review, the owner
// clicked the portal's submit in the left-open window in the run's last seconds, the application
// went through — and the run read failed and nothing captured the record; it was typed by hand.
// The replay now hands the page over before its own read-only housekeeping and watches the window
// from that moment, so the completion page can be read while this run's portal_runs row still says
// 'running' and no awaiting_human_submit submission exists. Recorded then, captureConfirmation found
// no row to stamp and the outcome written afterwards overwrote the run's 'submitted'.
//
//   (a) a confident completion-page read that arrives BEFORE the stage returns is recorded after
//       the outcome: the run is 'submitted', the run's own submission row carries the number, the
//       project is submitted, and no older row is stamped.
//   (b) the same when the run itself reported a failure: a filing that went is never left failed.
//   (c) an unconfident read before the outcome changes nothing but the audit note (as after it).
//   (d) a read AFTER the stage returned is recorded exactly as before (the left-open window).
//
// KILL TEST: in repository.ts onSubmitCaptured, record at once instead of holding the capture
// until runOutcomeRecorded → (a) and (b) fail (run 'awaiting_human_submit' / 'failed', number lost).
//
// Run: npx tsx backend/test/humanSubmitDuringStage.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("human-submit-during-stage");
const { db, repo } = fx;

type Capture = Parameters<NonNullable<Parameters<typeof repo.setRecipeStageRunnerForTests>[0]>>[5] extends infer O
  ? O extends { onSubmitCaptured?: infer F } ? F : never : never;
type CaptureArg = Parameters<NonNullable<Capture>>[0];

// Synthetic record number in Accela's shape.
const RECORD = "519-26-009901-STR";
const READ: CaptureArg = { recordNumber: RECORD, confidence: "high", reason: `Captured submission confirmation: ${RECORD}.`, recordLink: "" };

const STAGED = {
  portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null,
  steps: [
    { ok: true, message: "Opened stub portal." },
    { ok: true, message: "Human review required. AUTOMATION HAS STOPPED.", data: { finalSubmitClicked: false } },
  ],
};

/** Stage with the browser stubbed; `during` fires the left-open window's capture INSIDE the run
 *  (before the runner returns), as a person's click during the run's housekeeping would. */
async function stage(projectId: string, opts: { during?: CaptureArg; result?: Record<string, unknown> }): Promise<NonNullable<Capture>> {
  let captured: Capture | undefined;
  fx.stubRunner(async (_recipe, _project, _values, _docs, _files, o) => {
    captured = o?.onSubmitCaptured as Capture;
    if (opts.during) captured?.(opts.during);
    return (opts.result ?? STAGED) as never;
  });
  await repo.prepareSubmission(db, projectId);
  assert.ok(captured, "the stage handed the runner no onSubmitCaptured");
  return captured!;
}
const subs = (projectId: string) => db.query<Record<string, unknown>>(
  "SELECT id, status, application_number, submitted_by FROM submissions WHERE project_id = ? ORDER BY created_at, rowid", [projectId]);
const project = (projectId: string) => db.get<Record<string, unknown>>("SELECT status, stage_detail FROM projects WHERE id = ?", [projectId])!;

fx.completeRecipe();

await check("(a) a confident read during the run is recorded after the outcome: run submitted, its own row carries the number", async () => {
  const projectId = fx.newProject();
  await stage(projectId, { during: READ });
  const run = fx.latestRun(projectId)!;
  assert.equal(run.status, "submitted", `the run reads ${String(run.status)}, not submitted`);
  const rows = subs(projectId);
  assert.equal(rows.length, 1, `expected the run's one submission row, found ${rows.length}`);
  assert.equal(rows[0].status, "submitted", `the run's submission row reads ${String(rows[0].status)}`);
  assert.equal(rows[0].application_number, RECORD, "the record number was not written");
  assert.match(String(rows[0].submitted_by), /completion page/);
  assert.equal(project(projectId).status, "submitted", `the project reads ${String(project(projectId).status)}`);
  assert.equal(fx.audits("submission.record_number_read").filter((a) => a.project_id === projectId).length, 1, "no audit line for the read");
});

await check("(b) the run itself reported a failure, the person's filing went: the run is submitted, never failed", async () => {
  const projectId = fx.newProject();
  await stage(projectId, { during: READ, result: fx.failingStep("STOPPED BY THE NETWORK BACKSTOP: a review-page request was held") });
  const run = fx.latestRun(projectId)!;
  assert.equal(run.status, "submitted", `the run reads ${String(run.status)}, not submitted`);
  const rows = subs(projectId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "submitted", `the run's submission row reads ${String(rows[0].status)}`);
  assert.equal(rows[0].application_number, RECORD);
});

await check("(c) an unconfident read during the run records nothing but the audit note", async () => {
  const projectId = fx.newProject();
  await stage(projectId, { during: { recordNumber: "", confidence: "low", reason: "Submitted; no record number found on the completion page yet.", recordLink: "" } });
  const run = fx.latestRun(projectId)!;
  assert.equal(run.status, "awaiting_human_submit", `the run reads ${String(run.status)}`);
  assert.equal(subs(projectId)[0]?.status, "awaiting_human_submit");
  assert.ok(fx.audits("submission.record_number_unread").some((a) => a.project_id === projectId), "the unread note is missing");
});

await check("(d) a read after the stage returned is recorded as before", async () => {
  const projectId = fx.newProject();
  const capture = await stage(projectId, {});
  assert.equal(fx.latestRun(projectId)!.status, "awaiting_human_submit");
  capture(READ);
  assert.equal(fx.latestRun(projectId)!.status, "submitted");
  assert.equal(subs(projectId)[0]?.application_number, RECORD);
});

finish("human-submit-during-stage");
