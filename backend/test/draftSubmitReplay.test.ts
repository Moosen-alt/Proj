// THE REPLAY'S OWN CLICK OF A KNOWN DRAFT-CREATING SUBMIT (#330) — the backend's half.
//
// Owner ruling 2026-10-16 ("Yes to PSE"). portal-bot's draftSubmitGate decides each click and
// draftSubmitClick.dom.smoke proves it in a real browser; this pins what the backend writes and
// reads, on the REAL prepareSubmission with only the browser stubbed:
//   (a) THE STAMP. The heal of a draft-creating final submit (#302) stamps the step with the tenant
//       the draft page was on and the label clicked — only with a tenant; without one the step is
//       healed and NOT stamped. The stamp never comes with isFinalSubmit.
//   (b) A STEP HEALED BEFORE IT COULD BE STAMPED is stamped when a person's click of it is seen to make
//       a draft again: the recipe's last step, healed, same label, "created" wording only.
//   (c) WHO MAY CLICK: the NEM stage of the entity's own recipe passes draftSubmitClick; a permit
//       (trackless) stage never does — its next stage would start the application again.
//   (d) THE DRAFT THE REPLAY MADE is recorded as a person's would be (the next stage continues it);
//       nothing is filed, the recipe is not touched by the bot's own click.
//   (e) THE INCIDENT: the page after the click was not a draft → audited, the stamp comes off every
//       step, the run is a pause, and the track never reads as filed — no submission, no record
//       number, even if the runner's result carried one.
//
// KILL TESTS:
//   K1 portalDraft.healDraftCreatingFinalSubmit: drop the stamp → (a) fails.
//   K2 repository stageOptions: draftSubmitClick true for every track → (c) fails.
//   K3 repository: drop the draftSubmitUnexpected branch → (e) fails (stamp kept, no incident row).
//   K4 portalDraft.disarmDraftCreatingSubmit: return early → (e) fails.
//
// Run: npx tsx backend/test/draftSubmitReplay.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import type { RecipeStep } from "../../shared/src/types";
import { recipeShapeProblems } from "../../shared/src/portalSafety";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("draft-submit-replay");
const { db, repo, recipes } = fx;
const draftMod = await import("../src/portalDraft");

// Synthetic (issue #302's wording; number and host invented).
const TENANT = "twopart-utility.powerclerk.example";
const DRAFT = {
  applicationNumber: "NEM-90017",
  nextForm: "Interconnection Application - Part 2",
  evidence: "Your draft application NEM-90017 has been created. Please continue to Interconnection Application - Part 2 to complete your interconnection application and submit to PSE.",
  strength: "created" as const,
};
const stepsOf = (recipeId: string): RecipeStep[] => JSON.parse(String(fx.recipeRow(recipeId).steps_json));
const last = (recipeId: string): RecipeStep => { const st = stepsOf(recipeId); return st[st.length - 1]; };
type StageOpts = Record<string, unknown>;
const stubbed = (result: Record<string, unknown>): { opts: StageOpts | null; steps: RecipeStep[] } => {
  const seen: { opts: StageOpts | null; steps: RecipeStep[] } = { opts: null, steps: [] };
  fx.stubRunner(async (recipe, _project, _values, _docs, _files, opts) => {
    seen.opts = (opts ?? {}) as StageOpts;
    seen.steps = recipe.steps ?? [];
    return result as never;
  });
  return seen;
};
const staged = (data: Record<string, unknown> = {}) => ({
  portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null, ...data,
  steps: [{ ok: true, message: "Opened stub portal." }, { ok: true, message: "Replayed.", data: { finalSubmitClicked: false } }],
});

await check("(a) the heal stamps the step with the tenant and label — only with a tenant, never with isFinalSubmit", async () => {
  const withTenant = fx.completeRecipe([...fx.fills(2), fx.REVIEW, fx.FINAL]);
  const r = draftMod.healDraftCreatingFinalSubmit(db, withTenant.id, { ...DRAFT, clickedLabel: "Submit Application", tenantKey: TENANT });
  assert.equal(r.healed, true, r.why);
  const st = last(withTenant.id);
  assert.equal(st.isFinalSubmit, undefined, "the stamped step is still flagged final");
  assert.equal(st.draftCreatingSubmit?.tenantKey, TENANT);
  assert.equal(st.draftCreatingSubmit?.label, "Submit Application");
  assert.deepEqual(recipeShapeProblems(stepsOf(withTenant.id)), []);
  assert.equal(stepsOf(withTenant.id).filter((s) => s.draftCreatingSubmit).length, 1, "a step other than the clicked one was stamped");

  const noTenant = fx.completeRecipe([...fx.fills(2), fx.REVIEW, fx.FINAL]);
  const r2 = draftMod.healDraftCreatingFinalSubmit(db, noTenant.id, { ...DRAFT, clickedLabel: "Submit Application" });
  assert.equal(r2.healed, true, r2.why);
  assert.equal(last(noTenant.id).draftCreatingSubmit, undefined, "a heal with no tenant stamped the step");
});

await check("(b) a healed, unstamped last step is stamped when a person's click of it makes a draft again — nothing else is", async () => {
  const recipe = fx.completeRecipe([...fx.fills(2), fx.REVIEW, fx.FINAL]);
  draftMod.healDraftCreatingFinalSubmit(db, recipe.id, { ...DRAFT, clickedLabel: "Submit Application" });
  const before = String(fx.recipeRow(recipe.id).steps_json);
  draftMod.healDraftCreatingFinalSubmit(db, recipe.id, { ...DRAFT, strength: "status", clickedLabel: "Submit Application", tenantKey: TENANT });
  draftMod.healDraftCreatingFinalSubmit(db, recipe.id, { ...DRAFT, clickedLabel: "Save Draft", tenantKey: TENANT });
  draftMod.healDraftCreatingFinalSubmit(db, recipe.id, { ...DRAFT, clickedLabel: "Submit Application" });
  assert.equal(String(fx.recipeRow(recipe.id).steps_json), before, "a status-only page, another control or an unknown tenant stamped the step");
  draftMod.healDraftCreatingFinalSubmit(db, recipe.id, { ...DRAFT, clickedLabel: "Submit Application", tenantKey: TENANT });
  assert.equal(last(recipe.id).draftCreatingSubmit?.tenantKey, TENANT, "the already-healed step was not stamped");
  assert.equal(last(recipe.id).isFinalSubmit, undefined);
  assert.equal(fx.audits("portal_recipe.draft_submit_stamped").length, 1);
  // A never-healed recipe (its last click still flagged final) is the heal's case, not this one;
  // an unhealed, unflagged last click (no heal note) is never stamped.
  const plain = fx.completeRecipe([...fx.fills(2), fx.REVIEW, { action: "click", selector: { text: "Submit Application" }, note: "submit" } as RecipeStep]);
  draftMod.healDraftCreatingFinalSubmit(db, plain.id, { ...DRAFT, clickedLabel: "Submit Application", tenantKey: TENANT });
  assert.equal(last(plain.id).draftCreatingSubmit, undefined, "a step the heal never marked was stamped");
});

await check("(c) only the NEM stage of the entity's own recipe may click it; a permit stage never", async () => {
  fx.completeRecipe([...fx.fills(2), fx.REVIEW, fx.FINAL]);
  const permit = stubbed(staged());
  await repo.prepareSubmission(db, fx.newProject());
  assert.ok(permit.opts, "the permit stage never reached the runner");
  assert.equal(permit.opts!.draftSubmitClick, false, "a permit (trackless) stage passed draftSubmitClick");

  // The NEM track, on the utility's own PowerClerk tenant (the fixture's PGE: pgenm.powerclerk.com).
  const r = recipes.startPortalRecording(db, { scopeType: "utility", state: "OR", utility: "PGE", portalUrl: "https://pgenm.powerclerk.com/MvcAccount/Login", portalPlatform: "powerclerk", createdBy: "test" });
  recipes.savePortalRecipeSteps(db, r.id, [...fx.fills(2), fx.REVIEW, fx.FINAL], { status: "complete", notes: "test" });
  draftMod.healDraftCreatingFinalSubmit(db, r.id, { ...DRAFT, clickedLabel: "Submit Application", tenantKey: "pgenm.powerclerk.com" });
  const nem = stubbed(staged());
  await repo.prepareSubmission(db, fx.newProject(), "nem" as never);
  assert.ok(nem.opts, "the NEM stage never reached the runner");
  assert.equal(nem.opts!.draftSubmitClick, true, "the NEM stage of the utility's own recipe did not pass draftSubmitClick");
  // The stamp reaches the replay through the replay binding (recipeReplayBinding rebuilds each step).
  assert.equal(nem.steps[nem.steps.length - 1]?.draftCreatingSubmit?.tenantKey, "pgenm.powerclerk.com", "the replay binding dropped the stamp");
});

await check("(d) the draft the replay's click made is recorded for the next stage; nothing is filed, the recipe is untouched", async () => {
  const recipe = fx.completeRecipe([...fx.fills(2), fx.REVIEW, fx.FINAL]);
  draftMod.healDraftCreatingFinalSubmit(db, recipe.id, { ...DRAFT, clickedLabel: "Submit Application", tenantKey: TENANT });
  const before = String(fx.recipeRow(recipe.id).steps_json);
  stubbed(staged({ draftCreatedByReplay: { ...DRAFT, clickedLabel: "Submit Application", tenantKey: TENANT } }));
  const projectId = fx.newProject();
  await repo.prepareSubmission(db, projectId);
  const open = draftMod.openPortalDraftFor(db, projectId, "permit");
  assert.equal(open?.applicationNumber, "NEM-90017", "the replay's draft was not recorded");
  assert.equal(open?.nextForm, "Interconnection Application - Part 2");
  assert.equal(db.query("SELECT id FROM submissions WHERE project_id = ? AND status = 'submitted'", [projectId]).length, 0, "a draft was recorded as a filing");
  const run = fx.latestRun(projectId)!;
  assert.notEqual(String(run.status), "submitted");
  assert.notEqual(String(run.status), "submitted_unconfirmed");
  assert.equal(String(fx.recipeRow(recipe.id).steps_json), before, "the bot's own click rewrote the recipe");
  assert.equal(fx.audits("portal.draft_submit_clicked").filter((a) => a.project_id === projectId).length, 1);
});

await check("(e) an unexpected page after the click: incident audited, the stamp comes off, a pause — never a filing", async () => {
  const recipe = fx.completeRecipe([...fx.fills(2), fx.REVIEW, fx.FINAL]);
  draftMod.healDraftCreatingFinalSubmit(db, recipe.id, { ...DRAFT, clickedLabel: "Submit Application", tenantKey: TENANT });
  assert.ok(last(recipe.id).draftCreatingSubmit, "precondition: stamped");
  const incident = { label: "Submit Application", verdict: "filed", tenantKey: TENANT, stepIndex: 3, evidence: "Your application has been submitted." };
  stubbed({
    portalName: "stub", ok: false, finalSubmitClicked: false, pauseReason: "draft_submit_unexpected",
    // A runner that also carried a record number must not get it written anywhere.
    capturedPermitNumber: "NEM-90017", capturedConfirmationNumber: "NEM-90017", draftSubmitUnexpected: incident,
    steps: [
      { ok: true, message: "Opened stub portal." },
      { ok: false, pauseReason: "draft_submit_unexpected", message: "UNEXPECTED PAGE AFTER A DRAFT-CREATING SUBMIT: … The portal MAY HAVE FILED this application.", data: { finalSubmitClicked: false, draftSubmitUnexpected: incident } },
    ],
  });
  const projectId = fx.newProject();
  await repo.prepareSubmission(db, projectId);
  const rows = fx.audits(draftMod.DRAFT_SUBMIT_UNEXPECTED_ACTION).filter((a) => a.project_id === projectId);
  assert.equal(rows.length, 1, "the incident was not recorded");
  assert.equal(JSON.parse(rows[0].details).verdict, "filed");
  assert.equal(stepsOf(recipe.id).filter((s) => s.draftCreatingSubmit).length, 0, "the stamp survived the incident");
  assert.equal(stepsOf(recipe.id).length, 4, "disarming changed more than the stamp");
  assert.equal(fx.audits("portal_recipe.draft_submit_disarmed").length >= 1, true);
  assert.equal(db.query("SELECT id FROM submissions WHERE project_id = ? AND status IN ('submitted', 'submitted_unconfirmed')", [projectId]).length, 0, "the incident reads as a filing");
  const run = fx.latestRun(projectId)!;
  assert.equal(String(run.status), "paused_for_human", `run status ${String(run.status)}`);
  const proj = db.get<Record<string, unknown>>("SELECT * FROM projects WHERE id = ?", [projectId])!;
  assert.ok(!JSON.stringify(proj).includes("NEM-90017"), "the incident's number was written onto the project");
  assert.equal(draftMod.openPortalDraftFor(db, projectId, "permit"), null, "the incident was recorded as a draft");
});

await check("(f) disarming removes only stamps and is a no-op on a recipe without one", async () => {
  const recipe = fx.completeRecipe([...fx.fills(2), fx.REVIEW, fx.FINAL]);
  const before = String(fx.recipeRow(recipe.id).steps_json);
  assert.equal(draftMod.disarmDraftCreatingSubmit(db, recipe.id), false);
  assert.equal(String(fx.recipeRow(recipe.id).steps_json), before);
});

fx.stubRunner(null as never);
finish("draftSubmitReplay");
