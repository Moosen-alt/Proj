// AFTER A PERSON FILES IN THE REVIEW WINDOW, THE PROJECT HOLDS THE RECORD NUMBER AND ITS LINK (#400).
//
// On the REAL prepareSubmission with only the browser stubbed (the left-open window's capture is
// fired after the stage returns, exactly when a person's click would land), synthetic values:
//   (a) a confident capture writes the number AND the link through captureConfirmation, the one
//       door: portal_runs.tracking_url and the track target's tracking_url, the columns the
//       automatic-submit path writes. A number read off the account list says so.
//   (b) an unsure capture writes NOTHING as fact: its candidates sit on the run and the project's
//       next step offers them; one confirm (the same door, number + link) files it and clears them.
//   (c) a `javascript:` link, or a utility-portal link on a permit track (rule 5), is dropped — the
//       number is still written.
//   (d) the manual form, with no link, works as before; the write lands on the run's own project
//       only (rule 6).
//
// KILLS (on main 023ce333): captureConfirmation drops the link, so (a) fails; there is no
// candidate store or NextStep.recordCandidates, so (b) fails.
// Run: npx tsx backend/test/submitCaptureLink.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("submit-capture-link");
const { db, repo } = fx;
const { computeNextStep } = await import("../src/nextStep");

type Capture = Parameters<NonNullable<Parameters<typeof repo.setRecipeStageRunnerForTests>[0]>>[5] extends infer O
  ? O extends { onSubmitCaptured?: infer F } ? F : never : never;

async function stageAndHoldWindow(projectId: string): Promise<NonNullable<Capture>> {
  let captured: Capture | undefined;
  fx.stubRunner(async (_recipe, _project, _values, _docs, _files, opts) => {
    captured = opts?.onSubmitCaptured as Capture;
    return {
      portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null,
      steps: [
        { ok: true, message: "Opened stub portal." },
        { ok: true, message: "Human review required. AUTOMATION HAS STOPPED.", data: { finalSubmitClicked: false } },
      ],
    };
  });
  await repo.prepareSubmission(db, projectId);
  assert.ok(captured, "the stage handed the runner no onSubmitCaptured");
  return captured!;
}
const row = (sql: string, params: unknown[]) => db.get<Record<string, unknown>>(sql, params as never);
const targetOf = (projectId: string) => row("SELECT * FROM permit_check_targets WHERE project_id = ? AND active = 1 ORDER BY updated_at DESC LIMIT 1", [projectId]);
const submittedOf = (projectId: string) => db.query<Record<string, unknown>>("SELECT * FROM submissions WHERE project_id = ? AND status = 'submitted'", [projectId]);

const CAPDETAIL = "https://aca.example-city.test/CitizenAccess/Cap/CapDetail.aspx?Module=Building&capID1=26CAP&capID2=00000&capID3=00274&agencyCode=EXCITY";

fx.completeRecipe([...fx.fills(3), fx.REVIEW, fx.FINAL]);

await check("(a) a confident completion-page read writes the number and the link through the one door", async () => {
  const projectId = fx.newProject();
  const bystander = fx.newProject();
  const capture = await stageAndHoldWindow(projectId);
  const run = fx.latestRun(projectId)!;
  capture({ recordNumber: "517-26-000274-STR", confidence: "high", source: "completion_page", reason: "Matched the accela shape.", recordLink: CAPDETAIL });
  assert.equal(submittedOf(projectId).length >= 1, true, "no filing recorded");
  assert.equal(submittedOf(projectId)[0].application_number, "517-26-000274-STR");
  assert.equal(row("SELECT tracking_url FROM portal_runs WHERE id = ?", [run.id])!.tracking_url, CAPDETAIL, "the run lost the link");
  const tgt = targetOf(projectId);
  assert.ok(tgt, "no tracking target");
  assert.equal(tgt!.application_number, "517-26-000274-STR");
  assert.equal(tgt!.tracking_url, CAPDETAIL, "the track target lost the link");
  // Rule 6: nothing touched the other project.
  assert.equal(submittedOf(bystander).length, 0);
  assert.ok(!targetOf(bystander), "the other project got a target");
});

await check("(a) a number read off the account list is recorded as such", async () => {
  const projectId = fx.newProject();
  const capture = await stageAndHoldWindow(projectId);
  capture({ recordNumber: "PC-0042199", confidence: "high", source: "account_list", reason: "Exactly one new application appeared.", recordLink: "https://grid.example.test/Projects/View?ProjectId=42199" });
  const sub = submittedOf(projectId)[0];
  assert.equal(sub?.application_number, "PC-0042199");
  assert.match(String(sub?.submitted_by), /application list/);
  assert.equal(targetOf(projectId)!.tracking_url, "https://grid.example.test/Projects/View?ProjectId=42199");
});

await check("(b) an unsure read writes nothing; the next step offers it; one confirm files it", async () => {
  const projectId = fx.newProject();
  const capture = await stageAndHoldWindow(projectId);
  const run = fx.latestRun(projectId)!;
  capture({
    recordNumber: "", confidence: "low", source: "none", reason: "2 new applications appeared in the account's list after the submit.",
    recordLink: "https://grid.example.test/Projects/List",
    candidates: [
      { recordNumber: "PC-0042199", recordLink: "https://grid.example.test/Projects/View?ProjectId=42199", source: "account_list" },
      { recordNumber: "PC-0042200", recordLink: "javascript:alert(1)", source: "account_list" },
    ],
  });
  assert.equal(submittedOf(projectId).length, 0, "an unsure read was written as a filing");
  assert.ok(!targetOf(projectId), "an unsure read started tracking");
  const step = computeNextStep(db, projectId);
  const cands = step.recordCandidates ?? [];
  assert.deepEqual(cands.map((c) => c.recordNumber), ["PC-0042199", "PC-0042200"], JSON.stringify(step));
  assert.ok(cands.every((c) => c.runId === run.id), "a candidate names another run");
  assert.equal(cands[1].recordLink, "", "a javascript: link reached the panel");
  // One click: the same door, with the number and the link that was seen.
  repo.captureConfirmation(db, String(run.id), { applicationNumber: cands[0].recordNumber, recordLink: cands[0].recordLink, submittedBy: "confirmed from the next-step panel" });
  assert.equal(submittedOf(projectId)[0]?.application_number, "PC-0042199");
  assert.equal(targetOf(projectId)!.tracking_url, "https://grid.example.test/Projects/View?ProjectId=42199");
  assert.equal(row("SELECT submit_capture_candidates FROM portal_runs WHERE id = ?", [run.id])!.submit_capture_candidates, "", "the answered candidates stayed");
  assert.equal((computeNextStep(db, projectId).recordCandidates ?? []).length, 0, "the panel still offers a confirmed number");
});

await check("(b) a low read with no candidate leaves nothing on the panel", async () => {
  const projectId = fx.newProject();
  const capture = await stageAndHoldWindow(projectId);
  capture({ recordNumber: "", confidence: "low", source: "none", reason: "No record number on the page.", recordLink: "" });
  assert.equal(submittedOf(projectId).length, 0);
  assert.equal(computeNextStep(db, projectId).recordCandidates, undefined);
});

await check("(c) a javascript: link is dropped and the number is still written", async () => {
  const projectId = fx.newProject();
  const capture = await stageAndHoldWindow(projectId);
  const run = fx.latestRun(projectId)!;
  capture({ recordNumber: "517-26-000275-STR", confidence: "high", source: "completion_page", reason: "accela", recordLink: "javascript:alert(document.cookie)" });
  assert.equal(submittedOf(projectId)[0]?.application_number, "517-26-000275-STR");
  assert.equal(row("SELECT tracking_url FROM portal_runs WHERE id = ?", [run.id])!.tracking_url, "");
  assert.equal(targetOf(projectId)!.tracking_url, "");
});

await check("(c) rule 5: a utility-portal link never lands on a permit target, and costs the filing nothing", async () => {
  const projectId = fx.newProject();
  const capture = await stageAndHoldWindow(projectId);
  capture({ recordNumber: "517-26-000276-STR", confidence: "high", source: "completion_page", reason: "accela", recordLink: "https://pge.powerclerk.com/MvcProjects/EditProject?ProjectId=1" });
  assert.equal(submittedOf(projectId)[0]?.application_number, "517-26-000276-STR");
  assert.equal(targetOf(projectId)!.tracking_url, "", "a utility link landed on a permit target");
  const audit = fx.audits("submission.confirmation_captured").filter((a) => a.project_id === projectId).pop();
  assert.match(String(audit?.details), /recordLinkRefused/);
});

await check("(d) the manual form with no link works as before", async () => {
  const projectId = fx.newProject();
  await stageAndHoldWindow(projectId);
  const run = fx.latestRun(projectId)!;
  db.run("UPDATE portal_runs SET tracking_url = ? WHERE id = ?", ["https://aca.example-city.test/CitizenAccess/Cap/CapDetail.aspx?capID1=X", run.id]);
  repo.captureConfirmation(db, String(run.id), { applicationNumber: "517-26-000277-STR", submittedBy: "Operator" });
  assert.equal(submittedOf(projectId)[0]?.application_number, "517-26-000277-STR");
  assert.equal(row("SELECT tracking_url FROM portal_runs WHERE id = ?", [run.id])!.tracking_url, "https://aca.example-city.test/CitizenAccess/Cap/CapDetail.aspx?capID1=X", "a capture with no link wiped the run's link");
});

finish("submitCaptureLink");
