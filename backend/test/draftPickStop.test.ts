// THE PERSON SEES WHY THE STAMPED DRAFT CLICK DID NOT HAPPEN (#362, Helm review of 4081f12, SF1).
//
// When automation picked answers with no project data behind them, the stamped draft-creating
// Submit (#330/#354) is not clicked and the run stops before review. The run card and the project's
// stage line read only the FIRST LINE of the stop step's message (pausedRunSentence), behind
// "stopped before review — ", and the dashboard's why-line cuts at 240 characters. So the adapter
// leads that message with draftPickStopTell; this pins, on the REAL prepareSubmission(nem) with only
// the browser stubbed, that the run's error_message and the project's current_stage carry it within
// those 240 characters: what was not clicked, how many answers were picked, and which.
//
// Run: npx tsx backend/test/draftPickStop.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";
import { draftPickStopTell } from "../../portal-bot/src/adapters/recipeAdapter";

const fx = await setupStageFixture("draft-pick-stop");
const { db, repo, recipes } = fx;
const draftMod = await import("../src/portalDraft");

const NEM_URL = "https://pgenm.powerclerk.com/MvcAccount/Login";
const r = recipes.startPortalRecording(db, { scopeType: "utility", state: "OR", utility: "PGE", portalUrl: NEM_URL, portalPlatform: "powerclerk", createdBy: "test" });
const nem = recipes.savePortalRecipeSteps(db, r.id, [...fx.fills(2), fx.REVIEW, fx.FINAL], { status: "complete", notes: "test" });
const h = draftMod.healDraftCreatingFinalSubmit(db, nem.id, {
  applicationNumber: "NEM-90017", nextForm: "Interconnection Application - Part 2", strength: "created",
  evidence: "Your draft application NEM-90017 has been created.", clickedLabel: "Submit Application", tenantKey: "pgenm.powerclerk.com",
});
assert.equal(h.healed, true, h.why);

const PICKS = [
  "gap-fill: Is the system grid-tied?: Yes",
  "gap-fill: Do you agree to the terms of the Interconnection Agreement?",
  're-assert into "Email" (the recorded "Email")',
  "gap-fill: Is a battery included in this system?: No",
];

await check("draftPickStopTell stays within 200 characters with a long list, and names what to do", () => {
  const t = draftPickStopTell("Submit Application", [...PICKS, ...PICKS]);
  assert.ok(t.length <= 200, `${t.length}: ${t}`);
  assert.match(t, /^NOT CLICKED "Submit Application": automation picked 8 answer\(s\) with no project data behind them \(gap-fill: Is the system grid-tied\?: Yes/);
  assert.match(t, /check them, then click it yourself\.$/);
});

await check("the NEM run's card and stage line LEAD with what automation picked, within the 240-character why-line", async () => {
  const tell = draftPickStopTell("Submit Application", PICKS.slice(0, 2));
  const stopped = `${tell} Replayed 4 recorded step(s); STOPPED on "Interconnection Application Part 1" — the known draft-creating submit was not clicked: automation picked 2 answer(s) with no project data behind them, which the recorded steps never fill.`;
  let seen: Record<string, unknown> | null = null;
  fx.stubRunner(async (_recipe, _project, _values, _docs, _files, opts) => {
    seen = (opts ?? {}) as Record<string, unknown>;
    return {
      portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: "stopped_before_review",
      steps: [{ ok: true, message: "Opened stub portal." }, { ok: true, message: stopped, pauseReason: "stopped_before_review" }],
    } as never;
  });
  const projectId = fx.newProject();
  await repo.prepareSubmission(db, projectId, "nem" as never);
  assert.ok(seen && (seen as Record<string, unknown>).draftSubmitStamp, "the NEM stage was not given the stamp (the fixture is not the draft path)");
  const run = fx.latestRun(projectId)!;
  assert.equal(run.status, "paused_for_human", String(run.status));
  assert.equal(run.pause_reason, "stopped_before_review");
  const card = String(run.error_message);
  assert.ok(card.slice(0, 240).includes("NOT CLICKED"), `the run card's first 240 characters do not say the click was refused: ${card}`);
  assert.ok(card.slice(0, 240).includes("gap-fill: Is the system grid-tied?: Yes"), `the run card's first 240 characters do not name the pick: ${card}`);
  const stage = String(db.get<{ current_stage: string }>("SELECT current_stage FROM projects WHERE id = ?", [projectId])?.current_stage);
  assert.ok(stage.slice(0, 240).includes("NOT CLICKED") && stage.slice(0, 240).includes("automation picked 2 answer(s)"), `the stage line: ${stage}`);
  assert.doesNotMatch(stage, /challenge|nothing was staged|filed/i, stage);
  // The stamp is kept: a stop for picks is not an incident.
  assert.ok(db.get("SELECT 1 AS x FROM portal_recipe_draft_submits WHERE recipe_id = ?", [nem.id]), "the stamp was deleted by a review stop");
});

repo.setRecipeStageRunnerForTests(null);
finish("draft-pick-stop");
