// A SUBMIT THAT ONLY MADE A DRAFT IS NOT A FILING, AND IS NOT THE RECIPE'S FINAL SUBMIT (#302).
//
// PSE's two-part PowerClerk flow: Part 1's Submit answers "Your draft application NEM-… has been
// created. Please continue to Interconnection Application - Part 2 …". Pinned here, on the REAL
// prepareSubmission with only the browser stubbed (the left-open window's capture is fired after
// the stage returns, exactly when a person's click would land):
//   (a) the capture records the draft and NO filing: no submitted row, no record number; the run's
//       result_json carries the draft; the next stage can find it (openPortalDraftFor).
//   (b) the recipe step the person clicked stops being the final submit — that flag ONLY. The
//       stopForReview stays, auto-submit is disarmed, and the healed recipe is shape-valid.
//   (c) a different control, or a bare "Application Draft" status, heals nothing.
//   (d) a filing recorded after the draft closes it: openPortalDraftFor returns null.
//   (e) the healed Part 1 click plus Part 2 recorded after it is a recipe with exactly ONE final
//       submit, terminal and behind stopForReview — Part 2's real submit still stops for review.
//   (f) draftContinuationGaps names what PSE's Part 2 step 1 validates, names only.
//
// KILL TESTS:
//   K1 portalDraft.healDraftCreatingFinalSubmit: drop the label comparison → (c) fails.
//   K2 drop the `strength !== "created"` guard → (c) fails.
//   K3 repository onSubmitCaptured: remove the draftCreated branch → (a) fails (a captured
//      empty number is a low-confidence note there, but the recipe is not healed and no draft is
//      recorded).
//   K4 heal by deleting the step instead of its flag → (b) fails (step count).
//
// Run: npx tsx backend/test/portalDraft.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import type { RecipeStep } from "../../shared/src/types";
import { recipeShapeProblems } from "../../shared/src/portalSafety";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("portal-draft");
const { db, repo } = fx;
const draftMod = await import("../src/portalDraft");

// Synthetic (issue #302's wording; number invented).
const DRAFT = {
  applicationNumber: "NEM-90017",
  nextForm: "Interconnection Application - Part 2",
  evidence: "Your draft application NEM-90017 has been created. Please continue to Interconnection Application - Part 2 to complete your interconnection application and submit to PSE.",
  strength: "created" as const,
};

type Capture = Parameters<NonNullable<Parameters<typeof repo.setRecipeStageRunnerForTests>[0]>>[5] extends infer O
  ? O extends { onSubmitCaptured?: infer F } ? F : never : never;

/** Stage the project with the browser stubbed to "staged to review"; returns the left-open
 *  window's capture callback, to fire as a person's click would — after the stage returned. */
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
const stepsOf = (recipeId: string): RecipeStep[] => JSON.parse(String(fx.recipeRow(recipeId).steps_json));
const finals = (steps: RecipeStep[]) => steps.filter((s) => s.isFinalSubmit === true).length;

await check("(a)+(b) a person's Part 1 Submit that made a draft: no filing, the draft is recorded, the flag comes off that step only", async () => {
  const recipe = fx.completeRecipe([...fx.fills(3), fx.REVIEW, fx.FINAL]);
  db.run("UPDATE portal_recipes SET auto_submit_enabled = 1 WHERE id = ?", [recipe.id]);
  const projectId = fx.newProject();
  const capture = await stageAndHoldWindow(projectId);
  const run = fx.latestRun(projectId)!;
  capture({ recordNumber: "", confidence: "low", reason: "draft", recordLink: "", draftCreated: { ...DRAFT, clickedLabel: "Submit Application" } });

  const submitted = db.query("SELECT id FROM submissions WHERE project_id = ? AND status = 'submitted'", [projectId]);
  assert.equal(submitted.length, 0, "a draft was recorded as a filing");
  const proj = db.get<Record<string, unknown>>("SELECT * FROM projects WHERE id = ?", [projectId])!;
  assert.ok(!String(proj.permit_number ?? "").includes("90017"), "the draft's number was written as a record number");
  const result = JSON.parse(String(db.get<Record<string, unknown>>("SELECT result_json FROM portal_runs WHERE id = ?", [run.id])!.result_json));
  assert.equal(result.draftCreated?.applicationNumber, "NEM-90017", "the run does not carry the draft");
  const open = draftMod.openPortalDraftFor(db, projectId, "permit");
  assert.equal(open?.applicationNumber, "NEM-90017");
  assert.equal(open?.nextForm, "Interconnection Application - Part 2");

  const steps = stepsOf(recipe.id);
  assert.equal(steps.length, 5, "the heal added or removed a step");
  assert.equal(finals(steps), 0, "the draft-creating click is still flagged as the final submit");
  assert.equal(steps[3].action, "stopForReview", "the stopForReview in front of the click was touched");
  assert.equal(steps[4].action, "click");
  assert.match(String(steps[4].note), /creates a draft/);
  assert.deepEqual(steps.slice(0, 3), [...fx.fills(3)], "a step other than the final click changed");
  assert.deepEqual(recipeShapeProblems(steps), []);
  const row = fx.recipeRow(recipe.id);
  assert.equal(Number(row.auto_submit_enabled), 0, "the healed recipe is still armed for auto-submit");
  assert.match(String(row.notes), /draft-creating submit/);
  assert.equal(fx.audits("portal_recipe.draft_submit_healed").length, 1);
  assert.equal(fx.audits(draftMod.DRAFT_CREATED_ACTION).filter((a) => a.project_id === projectId).length, 1);
});

await check("(c) a different control, a missing label, or a bare draft status heals nothing", async () => {
  const recipe = fx.completeRecipe([...fx.fills(2), fx.REVIEW, fx.FINAL]);
  const before = String(fx.recipeRow(recipe.id).steps_json);
  const other = draftMod.healDraftCreatingFinalSubmit(db, recipe.id, { ...DRAFT, clickedLabel: "Save Draft" });
  assert.equal(other.healed, false, other.why);
  const unknown = draftMod.healDraftCreatingFinalSubmit(db, recipe.id, { ...DRAFT });
  assert.equal(unknown.healed, false, unknown.why);
  const status = draftMod.healDraftCreatingFinalSubmit(db, recipe.id, { ...DRAFT, strength: "status", clickedLabel: "Submit Application" });
  assert.equal(status.healed, false, status.why);
  assert.equal(String(fx.recipeRow(recipe.id).steps_json), before, "a refused heal changed the recipe");
  assert.equal(finals(stepsOf(recipe.id)), 1);
});

await check("(c) the label match ignores case and punctuation only", async () => {
  const recipe = fx.completeRecipe([...fx.fills(1), fx.REVIEW, fx.FINAL]);
  const r = draftMod.healDraftCreatingFinalSubmit(db, recipe.id, { ...DRAFT, clickedLabel: "  submit   application. " });
  assert.equal(r.healed, true, r.why);
  const again = draftMod.healDraftCreatingFinalSubmit(db, recipe.id, { ...DRAFT, clickedLabel: "Submit Application" });
  assert.equal(again.healed, false, "a second heal found another final to remove");
});

await check("(d) a filing recorded after the draft closes it; another track's draft is not this track's", async () => {
  const projectId = fx.newProject();
  draftMod.recordPortalDraft(db, { projectId, track: "nem", draft: DRAFT, source: "learn" });
  assert.equal(draftMod.openPortalDraftFor(db, projectId, "nem")?.applicationNumber, "NEM-90017");
  assert.equal(draftMod.openPortalDraftFor(db, projectId, "permit"), null, "a NEM draft read as the permit track's");
  db.run(
    `INSERT INTO submissions (id, project_id, submission_type, permit_type, status, submitted_at, created_at)
     VALUES (?, ?, 'portal', 'nem', 'submitted', ?, ?)`,
    [`sub-${projectId}`, projectId, "2999-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z"],
  );
  assert.equal(draftMod.openPortalDraftFor(db, projectId, "nem"), null, "a filed draft is still offered for continuation");
});

await check("(e) the healed Part 1 click and Part 2 behind it: exactly one final, terminal, after stopForReview", async () => {
  const part1Click: RecipeStep = { action: "click", selector: { text: "Submit" }, note: "creates a draft, not the filing (#302)" } as RecipeStep;
  const part2Final: RecipeStep = { action: "click", selector: { text: "Submit" }, isFinalSubmit: true, note: "Part 2 submit" } as RecipeStep;
  const steps = [...fx.fills(2), part1Click, ...fx.fills(5), fx.REVIEW, part2Final];
  assert.deepEqual(recipeShapeProblems(steps), []);
  assert.equal(finals(steps), 1);
  // A recipe that kept Part 1's flag AND recorded Part 2's is refused — never silently accepted.
  assert.ok(recipeShapeProblems([...fx.fills(2), fx.REVIEW, { ...part1Click, isFinalSubmit: true }, ...fx.fills(5), fx.REVIEW, part2Final]).length > 0);
});

await check("(f) the draft continuation names the customer fields it lacks — names, never values", async () => {
  assert.deepEqual(draftMod.draftContinuationGaps({ accountNumber: "1234567890", meterNumber: "987654321", homeownerName: "Jordan Testcase", projectAddress: "1234 N Example St" } as never), []);
  const gaps = draftMod.draftContinuationGaps({ accountNumber: " ", meterNumber: "", homeownerName: "Jordan Testcase", projectAddress: "" } as never);
  assert.deepEqual(gaps, ["the utility account number", "the meter number", "the service address"]);
});

fx.stubRunner(null as never);
finish("portalDraft");
