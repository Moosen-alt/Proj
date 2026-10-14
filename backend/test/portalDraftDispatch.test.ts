// A RECORDED DRAFT IS NEVER STARTED AGAIN BY AN ACTOR THAT CANNOT CONTINUE IT (#302, Helm review of PR #325).
//
// Only the learner can open a project's existing draft (AutoLearnAdapter continueDraft). With
// PORTAL_AUTOSEED off the NEM stage would go to the recipe replay, which starts the application
// from the top: a second NEM number for the same house. Pinned on the REAL prepareSubmission:
//   (a) a draft on record + PORTAL_AUTOSEED=0 → the stage stops before a browser opens (the stubbed
//       runner is never called), audits portal.draft_continuation_unavailable, and says why;
//   (b) the same project with no draft on record → the replay runs (the guard is the draft's alone).
//
// KILL TEST: drop the `nemDraft && (runActorLabel === …)` branch in repository.ts → (a) fails.
// Run: npx tsx backend/test/portalDraftDispatch.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("portal-draft-dispatch");
const { db, repo, recipes } = fx;
const draftMod = await import("../src/portalDraft");
process.env.PORTAL_AUTOSEED = "0";

// A complete NEM recipe for the fixture's utility, on a PowerClerk host (the utility track's own).
const nemRecipe = () => {
  const r = recipes.startPortalRecording(db, {
    scopeType: "utility", state: "OR", ahj: "Portland", utility: "PGE",
    portalUrl: "https://pge.powerclerk.example/MvcAccount/Login", portalPlatform: "powerclerk", createdBy: "test",
  });
  return recipes.savePortalRecipeSteps(db, r.id, [...fx.fills(3), fx.REVIEW, fx.FINAL], { status: "complete", notes: "Auto-learned and verified (high confidence)." });
};

let runnerCalls = 0;
fx.stubRunner(async () => {
  runnerCalls += 1;
  return { portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null, steps: [{ ok: true, message: "Human review required. AUTOMATION HAS STOPPED.", data: { finalSubmitClicked: false } }] };
});

await check("(a) a draft on record with the learner off: stopped before a browser opens, named and audited", async () => {
  nemRecipe();
  const projectId = fx.newProject();
  draftMod.recordPortalDraft(db, {
    projectId, track: "nem", source: "learn",
    draft: { applicationNumber: "NEM-90017", nextForm: "Interconnection Application - Part 2", evidence: "synthetic", strength: "created" },
  });
  runnerCalls = 0;
  await repo.prepareSubmission(db, projectId, "nem");
  const audits = fx.audits("portal.draft_continuation_unavailable").filter((a) => a.project_id === projectId);
  assert.equal(runnerCalls, 0, "the replay ran and would start the application again");
  assert.equal(audits.length, 1, `no draft_continuation_unavailable audit (run: ${JSON.stringify(fx.latestRun(projectId))?.slice(0, 600)})`);
  const d = JSON.parse(audits[0].details);
  assert.equal(d.applicationNumber, "NEM-90017");
  assert.equal(d.autoSeedEnabled, false);
  const run = fx.latestRun(projectId)!;
  assert.match(String(run.result_json ?? ""), /PORTAL_AUTOSEED is off/);
});

await check("(b) no draft on record: the NEM replay runs as before", async () => {
  const projectId = fx.newProject();
  runnerCalls = 0;
  await repo.prepareSubmission(db, projectId, "nem");
  assert.equal(fx.audits("portal.draft_continuation_unavailable").filter((a) => a.project_id === projectId).length, 0);
  assert.equal(runnerCalls, 1, `the replay did not run (run: ${JSON.stringify(fx.latestRun(projectId))?.slice(0, 600)})`);
});

fx.stubRunner(null as never);
finish("portalDraftDispatch");
