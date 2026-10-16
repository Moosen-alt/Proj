// THE REPLAY'S OWN CLICK OF A KNOWN DRAFT-CREATING SUBMIT (#330) — the backend's half.
//
// Owner ruling 2026-10-16 ("Yes to PSE"). portal-bot's draftSubmitGate decides each click and
// draftSubmitClick.dom.smoke proves it in a real browser; this pins what the backend writes and
// reads, on the REAL prepareSubmission and the REAL recipe writers with only the browser stubbed:
//   (a) THE STAMP. The heal of a draft-creating final submit (#302) writes a SERVER-OWNED record
//       (portal_recipe_draft_submits) — step index, the tenant the draft page was on, the label
//       clicked, the signature of the whole recipe — and nothing stamp-like into steps_json. Without
//       a tenant the record is "healed, not yet stamped" and no replay gets a stamp.
//   (b) A STEP HEALED BEFORE IT COULD BE STAMPED is stamped when a person's click of it is seen to make
//       a draft again — only on the heal's own record (its row, or for a pre-#330 heal its audit row),
//       the recipe's last step, the same label, "created" wording only.
//   (c) WHO GETS IT: the NEM stage of the entity's own recipe gets draftSubmitStamp, naming the last
//       step of the steps it replays; a permit (trackless) stage never does. Two NEM stages in a row
//       both get it (nothing in a normal run turns it off).
//   (d) THE DRAFT THE REPLAY MADE is recorded as a person's would be (the next stage continues it);
//       nothing is filed, the recipe is not touched by the bot's own click.
//   (e) THE INCIDENT: the page after the click was not a draft → audited, the record is deleted, the
//       run is a pause, and the track never reads as filed — no submission, no record number.
//   (f) disarming is a no-op on a recipe without a record.
//   THE HELM'S FOUR SHAPES (review of 58050010), each ending with NO stamp passed to the replay:
//   P1 a recipe save forges the old stamp field onto the real filing click (and drops isFinalSubmit);
//   P2 a save re-aims a real stamp at another control with the same label;
//   P3 a disarmed stamp's steps written back by an abandoned re-record's restore;
//   P4 a save writes the heal's note onto a last click no heal ever named.
//   And a plain round-trip save of the very same steps turns it off too.
//
// KILL TESTS (run by hand on this tree):
//   K1 draftSubmitStampForReplay: drop the signature comparison → P2 fails.
//   K2 savePortalRecipeSteps: drop the disarm → the round-trip check fails.
//   K3 armHealedDraftStep: accept the heal note in place of healRecordFor → P4 fails.
//   K4 repository: drop the draftSubmitUnexpected branch → (e) fails (record kept, no incident row).
//   K5 repository: pass the stamp on every track → (c) fails.
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

// Synthetic (issue #302's wording; number and hosts invented, except the fixture's own PGE tenant).
const TENANT = "twopart-utility.powerclerk.example";
const NEM_TENANT = "pgenm.powerclerk.com";
const DRAFT = {
  applicationNumber: "NEM-90017",
  nextForm: "Interconnection Application - Part 2",
  evidence: "Your draft application NEM-90017 has been created. Please continue to Interconnection Application - Part 2 to complete your interconnection application and submit to PSE.",
  strength: "created" as const,
};
type Rec = Record<string, unknown>;
const stepsOf = (recipeId: string): RecipeStep[] => JSON.parse(String(fx.recipeRow(recipeId).steps_json));
const row = (recipeId: string): Rec | null => db.get<Rec>("SELECT * FROM portal_recipe_draft_submits WHERE recipe_id = ?", [recipeId]);
const noStampField = (recipeId: string): boolean => !String(fx.recipeRow(recipeId).steps_json).includes("draftCreatingSubmit");
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
const NEM_URL = "https://pgenm.powerclerk.com/MvcAccount/Login";
/** The fixture utility's own NEM recipe (one row per key), saved complete through the real writer. */
const nemRecipe = (steps: RecipeStep[] = [...fx.fills(2), fx.REVIEW, fx.FINAL]) => {
  const r = recipes.startPortalRecording(db, { scopeType: "utility", state: "OR", utility: "PGE", portalUrl: NEM_URL, portalPlatform: "powerclerk", createdBy: "test" });
  return recipes.savePortalRecipeSteps(db, r.id, steps, { status: "complete", notes: "test" });
};
/** The NEM recipe, healed and stamped by a person's Part 1 click seen to make a draft. */
const armedNem = () => {
  const r = nemRecipe();
  const h = draftMod.healDraftCreatingFinalSubmit(db, r.id, { ...DRAFT, clickedLabel: "Submit Application", tenantKey: NEM_TENANT });
  assert.equal(h.healed, true, h.why);
  return r;
};
/** What a NEM stage of a new project passes the replay. */
const nemStamp = async (): Promise<{ stamp: Rec | null; steps: RecipeStep[] }> => {
  const seen = stubbed(staged());
  await repo.prepareSubmission(db, fx.newProject(), "nem" as never);
  assert.ok(seen.opts, "the NEM stage never reached the runner");
  return { stamp: (seen.opts!.draftSubmitStamp ?? null) as Rec | null, steps: seen.steps };
};

await check("(a) the heal writes the server-owned record — tenant, label, step, signature — and nothing into the steps", async () => {
  const withTenant = fx.completeRecipe([...fx.fills(2), fx.REVIEW, fx.FINAL]);
  const r = draftMod.healDraftCreatingFinalSubmit(db, withTenant.id, { ...DRAFT, clickedLabel: "Submit Application", tenantKey: TENANT });
  assert.equal(r.healed, true, r.why);
  const steps = stepsOf(withTenant.id);
  assert.equal(steps[3].isFinalSubmit, undefined, "the healed step is still flagged final");
  assert.deepEqual(recipeShapeProblems(steps), []);
  assert.ok(noStampField(withTenant.id), "the heal wrote a stamp into steps_json");
  const rec = row(withTenant.id)!;
  assert.ok(rec, "no server-owned record");
  assert.equal(rec.tenant_key, TENANT);
  assert.equal(rec.label, "Submit Application");
  assert.equal(Number(rec.step_index), 3);
  assert.equal(rec.steps_sig, recipes.recipeStepsSignature(steps), "the record is not bound to the steps as stored");
  assert.deepEqual(draftMod.draftSubmitStampForReplay(db, withTenant.id, steps), { stepIndex: 3, tenantKey: TENANT, label: "Submit Application", healedAt: String(rec.healed_at) });

  const noTenant = fx.completeRecipe([...fx.fills(2), fx.REVIEW, fx.FINAL]);
  const r2 = draftMod.healDraftCreatingFinalSubmit(db, noTenant.id, { ...DRAFT, clickedLabel: "Submit Application" });
  assert.equal(r2.healed, true, r2.why);
  assert.equal(row(noTenant.id)?.tenant_key, "", "a heal with no tenant was stamped");
  assert.equal(draftMod.draftSubmitStampForReplay(db, noTenant.id, stepsOf(noTenant.id)), null, "an unstamped heal gave a replay a stamp");
});

await check("(b) a healed, unstamped last step is stamped on its heal record when a person's click of it makes a draft again — nothing else is", async () => {
  const recipe = fx.completeRecipe([...fx.fills(2), fx.REVIEW, fx.FINAL]);
  draftMod.healDraftCreatingFinalSubmit(db, recipe.id, { ...DRAFT, clickedLabel: "Submit Application" });
  draftMod.healDraftCreatingFinalSubmit(db, recipe.id, { ...DRAFT, strength: "status", clickedLabel: "Submit Application", tenantKey: TENANT });
  draftMod.healDraftCreatingFinalSubmit(db, recipe.id, { ...DRAFT, clickedLabel: "Save Draft", tenantKey: TENANT });
  draftMod.healDraftCreatingFinalSubmit(db, recipe.id, { ...DRAFT, clickedLabel: "Submit Application" });
  assert.equal(row(recipe.id)?.tenant_key, "", "a status-only page, another control or an unknown tenant stamped the step");
  const before = String(fx.recipeRow(recipe.id).steps_json);
  draftMod.healDraftCreatingFinalSubmit(db, recipe.id, { ...DRAFT, clickedLabel: "Submit Application", tenantKey: TENANT });
  assert.equal(row(recipe.id)?.tenant_key, TENANT, "the already-healed step was not stamped");
  assert.equal(String(fx.recipeRow(recipe.id).steps_json), before, "stamping wrote to the recipe");
  assert.equal(fx.audits("portal_recipe.draft_submit_stamped").length, 1);

  // A heal written BEFORE #330: only its audit row is on record (no server-owned row yet).
  const old = fx.completeRecipe([...fx.fills(2), fx.REVIEW, fx.FINAL]);
  draftMod.healDraftCreatingFinalSubmit(db, old.id, { ...DRAFT, clickedLabel: "Submit Application" });
  db.run("DELETE FROM portal_recipe_draft_submits WHERE recipe_id = ?", [old.id]); // a DB from before v49
  draftMod.healDraftCreatingFinalSubmit(db, old.id, { ...DRAFT, clickedLabel: "Submit Application", tenantKey: TENANT });
  assert.equal(row(old.id)?.tenant_key, TENANT, "a pre-#330 heal (its audit record) was not stamped");
  assert.equal(draftMod.draftSubmitStampForReplay(db, old.id, stepsOf(old.id))?.stepIndex, 3);
});

await check("(c) the NEM stage of the entity's own recipe gets the stamp for its last step, twice in a row; a permit stage never", async () => {
  const ahj = fx.completeRecipe([...fx.fills(2), fx.REVIEW, fx.FINAL]);
  draftMod.healDraftCreatingFinalSubmit(db, ahj.id, { ...DRAFT, clickedLabel: "Submit Application", tenantKey: "permits.portland.example" });
  assert.ok(draftMod.draftSubmitStampForReplay(db, ahj.id, stepsOf(ahj.id)), "precondition: the AHJ recipe is stamped");
  const permit = stubbed(staged());
  await repo.prepareSubmission(db, fx.newProject());
  assert.ok(permit.opts, "the permit stage never reached the runner");
  assert.equal(permit.opts!.draftSubmitStamp ?? null, null, "a permit (trackless) stage was passed a stamp");

  armedNem();
  for (const n of [1, 2]) {
    const { stamp, steps } = await nemStamp();
    assert.ok(stamp, `NEM stage ${n} of the utility's own recipe got no stamp`);
    assert.equal(stamp!.tenantKey, NEM_TENANT);
    assert.equal(stamp!.label, "Submit Application");
    assert.equal(stamp!.stepIndex, steps.length - 1, "the stamp does not name the last step the replay runs");
    assert.ok(!JSON.stringify(steps).includes("draftCreatingSubmit"), "the replayed steps carry a stamp field");
  }
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
  assert.equal(row(recipe.id)?.tenant_key, TENANT, "the bot's own click changed the record");
  assert.equal(fx.audits("portal.draft_submit_clicked").filter((a) => a.project_id === projectId).length, 1);
});

await check("(e) an unexpected page after the click: incident audited, the record is deleted, a pause — never a filing", async () => {
  const recipe = fx.completeRecipe([...fx.fills(2), fx.REVIEW, fx.FINAL]);
  draftMod.healDraftCreatingFinalSubmit(db, recipe.id, { ...DRAFT, clickedLabel: "Submit Application", tenantKey: TENANT });
  assert.ok(row(recipe.id), "precondition: stamped");
  const stepsBefore = String(fx.recipeRow(recipe.id).steps_json);
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
  assert.equal(row(recipe.id), null, "the record survived the incident");
  assert.equal(String(fx.recipeRow(recipe.id).steps_json), stepsBefore, "disarming touched the recipe's steps");
  assert.equal(fx.audits("portal_recipe.draft_submit_disarmed").length >= 1, true);
  assert.equal(db.query("SELECT id FROM submissions WHERE project_id = ? AND status IN ('submitted', 'submitted_unconfirmed')", [projectId]).length, 0, "the incident reads as a filing");
  const run = fx.latestRun(projectId)!;
  assert.equal(String(run.status), "paused_for_human", `run status ${String(run.status)}`);
  const proj = db.get<Rec>("SELECT * FROM projects WHERE id = ?", [projectId])!;
  assert.ok(!JSON.stringify(proj).includes("NEM-90017"), "the incident's number was written onto the project");
  assert.equal(draftMod.openPortalDraftFor(db, projectId, "permit"), null, "the incident was recorded as a draft");
});

await check("(f) disarming is a no-op on a recipe without a record", async () => {
  const recipe = fx.completeRecipe([...fx.fills(2), fx.REVIEW, fx.FINAL]);
  assert.equal(row(recipe.id), null, "precondition: the save left no record");
  const before = String(fx.recipeRow(recipe.id).steps_json);
  assert.equal(draftMod.disarmDraftCreatingSubmit(db, recipe.id), false);
  assert.equal(String(fx.recipeRow(recipe.id).steps_json), before);
});

await check("P1 a recipe save that forges the stamp field onto the real filing click (and drops its flag) gives the replay no stamp", async () => {
  // Never healed: the real filing click, its isFinalSubmit dropped and the old stamp field added by one save.
  const forged = { action: "click", selector: { text: "Submit Application" }, note: "final submit",
    draftCreatingSubmit: { tenantKey: NEM_TENANT, label: "Submit Application", healedAt: "2026-10-16T00:00:00.000Z" } } as unknown as RecipeStep;
  const r = nemRecipe([...fx.fills(2), fx.REVIEW, forged]);
  assert.equal(fx.recipeRow(r.id).status, "complete");
  assert.ok(noStampField(r.id), "the save kept the forged stamp field in steps_json");
  assert.equal(row(r.id), null, "a save wrote a draft-submit record");
  assert.equal((await nemStamp()).stamp, null, "a forged stamp reached the replay");
  // The same forgery on a recipe that WAS legitimately stamped: the save turns the real one off.
  const armed = armedNem();
  recipes.savePortalRecipeSteps(db, armed.id, [...fx.fills(2), fx.REVIEW, forged], { status: "complete", notes: "test" });
  assert.equal((await nemStamp()).stamp, null, "a save over a stamped recipe left the stamp on");
});

await check("P2 a save that re-aims a real stamp at another control with the same label gives the replay no stamp", async () => {
  const r = armedNem();
  assert.ok((await nemStamp()).stamp, "precondition: stamped");
  const steps = stepsOf(r.id);
  // Part 2's Submit behind a goto in place of the review stop: the last step keeps its index and
  // Part 1's label, so only the signature tells the steps apart.
  const reaimed = [...steps.slice(0, -2), { action: "goto", value: "https://pgenm.powerclerk.com/MvcProjects/Part2", note: "open Part 2" } as RecipeStep, steps[steps.length - 1]];
  // The real save path, and (the narrower case) the same re-aim written straight past every writer.
  db.run("UPDATE portal_recipes SET steps_json = ? WHERE id = ?", [JSON.stringify(reaimed), r.id]);
  assert.equal(draftMod.draftSubmitStampForReplay(db, r.id, stepsOf(r.id)), null, "a re-aimed step kept the stamp (signature not compared)");
  recipes.savePortalRecipeSteps(db, r.id, reaimed, { status: "complete", notes: "test" });
  assert.equal((await nemStamp()).stamp, null, "a re-aimed stamp reached the replay");
});

await check("P3 an abandoned re-record's restore writes the stamped steps back after a disarm: no stamp", async () => {
  const r = armedNem();
  const stamped = String(fx.recipeRow(r.id).steps_json);
  // A re-record starts (the stamped steps go to prev_steps_json), then an incident disarms the recipe.
  recipes.startPortalRecording(db, { scopeType: "utility", state: "OR", utility: "PGE", portalUrl: NEM_URL, portalPlatform: "powerclerk", createdBy: "test" });
  assert.equal(draftMod.disarmDraftCreatingSubmit(db, r.id, { why: "test incident" }), true);
  assert.equal(recipes.restoreRecipeSnapshotIfAbandoned(db, r.id), "complete");
  assert.equal(String(fx.recipeRow(r.id).steps_json), stamped, "precondition: the restore wrote the very same steps back");
  assert.equal(row(r.id), null);
  assert.equal((await nemStamp()).stamp, null, "the restore revived a disarmed stamp");
});

await check("P4 a save that writes the heal's note onto a last click no heal named: never stamped", async () => {
  // A recipe with no heal history at all.
  const fresh = recipes.startPortalRecording(db, { scopeType: "utility", state: "WA", utility: "Fourth Utility", portalUrl: "https://fourth.powerclerk.example/MvcAccount/Login", portalPlatform: "powerclerk", createdBy: "test" });
  const noted = { action: "click", selector: { text: "Submit Application" }, note: `final submit | ${draftMod.DRAFT_HEAL_NOTE}` } as RecipeStep;
  recipes.savePortalRecipeSteps(db, fresh.id, [...fx.fills(2), fx.REVIEW, noted], { status: "complete", notes: "test" });
  draftMod.healDraftCreatingFinalSubmit(db, fresh.id, { ...DRAFT, clickedLabel: "Submit Application", tenantKey: "fourth.powerclerk.example" });
  assert.equal(row(fresh.id), null, "a forged heal note was stamped");
  // A recipe that WAS healed (step 4, "Submit Application"): the note moved by a save onto a new last
  // step with another label is not that heal's step.
  const r = armedNem();
  const steps = stepsOf(r.id);
  const moved = { action: "click", selector: { text: "Submit" }, note: `submit | ${draftMod.DRAFT_HEAL_NOTE}` } as RecipeStep;
  recipes.savePortalRecipeSteps(db, r.id, [...steps, moved], { status: "complete", notes: "test" });
  draftMod.healDraftCreatingFinalSubmit(db, r.id, { ...DRAFT, clickedLabel: "Submit", tenantKey: NEM_TENANT });
  assert.equal(row(r.id), null, "a moved heal note was stamped");
  assert.equal((await nemStamp()).stamp, null);
});

await check("a plain round-trip save of the very same steps turns the auto-click off; a person's next draft click re-arms it", async () => {
  const r = armedNem();
  assert.ok((await nemStamp()).stamp, "precondition: stamped");
  recipes.savePortalRecipeSteps(db, r.id, stepsOf(r.id), { status: "complete", notes: "test" });
  assert.equal((await nemStamp()).stamp, null, "a round-trip save left the stamp on");
  draftMod.healDraftCreatingFinalSubmit(db, r.id, { ...DRAFT, clickedLabel: "Submit Application", tenantKey: NEM_TENANT });
  assert.ok((await nemStamp()).stamp, "a person's draft click on the healed step did not re-arm it");
});

fx.stubRunner(null as never);
finish("draftSubmitReplay");
