// A CORRECTION REOPEN REPLAYS THE FILING'S OWN DISCIPLINE'S RECIPE (#455, the reopen half of #426).
//
// City of Coos Bay keeps per-discipline recipes (a `structural` and an `electrical` row, no '' row).
// reopenCorrectionOnPortal looked its recipe up with no discipline, so both lookups required
// discipline '' and neither matched: the reopen ran on the target's own URL with no steps, or stopped
// with "no portal URL is known" when the target carried none.
//
// The reopen is the real reopenCorrectionOnPortal over targets, corrections and recipes written
// through the real writers; only the browser is stubbed (opts.runner).
//
//   MUST-PASS    an electrical target with no URL of its own, on an AHJ with only per-discipline
//                recipes, reopens with the ELECTRICAL recipe and its steps; a building target with
//                the STRUCTURAL one
//   MUST-EXCLUDE a legacy '' recipe whose steps were learned for the other discipline is never
//                replayed (staging's own legacy-row check); the drop is audited
//   MUST-PASS    a legacy '' recipe learned for the SAME discipline still replays
//   MUST-EXCLUDE rule 5 unchanged: a discipline recipe whose portal is a utility interconnection host
//                is still refused by recipeHostFit and its steps never replayed
//
// Run: npx tsx backend/test/reopenDisciplineRecipe.test.ts
import "./_isolate"; // FIRST — generated files land in a temp cwd, never the repo's backend/data
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("reopen-discipline-recipe");
const { db, repo, recipes } = fx;

const ACA = "https://aca-test.accela.com/TESTBAY";
// Testcove's own portal: a recipe on Testbay's portal would be judged another entity's (recipeHostFit).
const COVE = "https://aca-cove.accela.com/TESTCOVE";
const REVIEW = { action: "stopForReview", selector: {} } as never;
const fill = (i: number, note = `Field ${i}`) => ({ action: "fill", selector: { name: `f${i}` }, field: "homeownerName", note }) as never;

type ReopenRunner = NonNullable<Parameters<typeof repo.reopenCorrectionOnPortal>[2]>["runner"];
const calls: Array<{ recipeId: string; portalUrl: string; steps: number }> = [];
const runner = (async (recipe: { id: string; portalUrl: string; steps: unknown[] }) => {
  calls.push({ recipeId: recipe.id, portalUrl: recipe.portalUrl, steps: recipe.steps.length });
  return { ok: false, needsHuman: true, message: "stub reopen", offeredForms: [] };
}) as unknown as ReopenRunner;

const target = (projectId: string, input: { permitType: string; applicationNumber: string; portalUrl?: string }) => {
  // jurisdiction = the project's own AHJ: a target's URL is evidence of whose portal a host is.
  const jurisdiction = db.get<{ ahj: string }>("SELECT ahj FROM projects WHERE id = ?", [projectId])!.ahj;
  repo.createPermitCheckTarget(db, projectId, { targetType: "permit", jurisdiction, portalName: "", portalUrl: "", ...input } as never);
  return db.get<{ id: string }>("SELECT id FROM permit_check_targets WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", [projectId])!.id;
};
const correctionFor = (projectId: string) =>
  repo.addManualCorrection(db, projectId, "Correction: the application was returned for revision — please resubmit the corrected plan set.", "portal").corrections[0].id;
const reopen = async (projectId: string, targetId: string) => {
  calls.length = 0;
  return repo.reopenCorrectionOnPortal(db, correctionFor(projectId), { targetId, runner });
};
const learn = (ahj: string, discipline: string, portalUrl: string, steps: unknown[] = [fill(1), fill(2), REVIEW]) => {
  const r = recipes.startPortalRecording(db, { scopeType: "ahj", state: "OR", ahj, portalUrl, portalPlatform: "accela", createdBy: "test", discipline });
  recipes.savePortalRecipeSteps(db, r.id, steps as never, { status: "complete" });
  return r.id;
};
const audited = (action: string, projectId: string) =>
  fx.audits(action).filter((a) => a.project_id === projectId).map((a) => JSON.parse(a.details));

// The AHJ's two per-discipline recipes — no '' row, exactly the Coos Bay shape.
const structural = learn("Testbay", "structural", `${ACA}/Login.aspx`);
const electrical = learn("Testbay", "electrical", `${ACA}/Login.aspx`);
const bayProject = () => fx.newProject({ ahj: "Testbay", utility: "Nowhere Power Co" });

await check("(r0) the fixture is the Coos Bay shape: a discipline-less lookup finds no recipe", () => {
  assert.notEqual(structural, electrical, "the two disciplines share one row");
  const input = { scopeType: "ahj" as const, state: "OR", ahj: "Testbay", utility: "Nowhere Power Co" };
  assert.equal(recipes.findCompleteRecipeForProject(db, input), null);
  assert.equal(recipes.findAnyRecipeForProject(db, input), null);
});

await check("(r1) MUST-PASS an electrical target with no URL of its own reopens with the electrical recipe", async () => {
  const projectId = bayProject();
  const t = target(projectId, { permitType: "electrical", applicationNumber: "194-26-000902-ELEC" });
  const result = await reopen(projectId, t);
  assert.equal(calls.length, 1, `the reopen did not run (no recipe found — the #455 bug): ${result.message}`);
  assert.equal(calls[0].recipeId, electrical, "the electrical filing was reopened with another recipe");
  assert.equal(calls[0].steps, 3, "the electrical recipe's steps were not handed to the run");
  assert.equal(calls[0].portalUrl, `${ACA}/Login.aspx`);
});

await check("(r2) MUST-PASS a building target reopens with the structural recipe", async () => {
  const projectId = bayProject();
  const t = target(projectId, { permitType: "building", applicationNumber: "187-26-000901-STR", portalUrl: `${ACA}/Default.aspx` });
  await reopen(projectId, t);
  assert.equal(calls.length, 1, "the reopen did not run");
  assert.equal(calls[0].recipeId, structural, "the building filing was reopened with another recipe");
  assert.equal(calls[0].steps, 3);
  assert.equal(calls[0].portalUrl, `${ACA}/Default.aspx`, "the target's own URL no longer wins");
});

await check("(r3) MUST-EXCLUDE a legacy '' recipe learned for the electrical permit is never replayed on a building filing", async () => {
  const legacy = learn("Testcove", "", `${COVE}/Login.aspx`, [fill(1, "record type: Residential - Electrical Solar"), fill(2), REVIEW]);
  const projectId = fx.newProject({ ahj: "Testcove", utility: "Nowhere Power Co" });
  const t = target(projectId, { permitType: "building", applicationNumber: "187-26-000905-STR", portalUrl: `${COVE}/Default.aspx` });
  await reopen(projectId, t);
  assert.equal(calls.length, 1, "the reopen did not run on the target's own URL");
  assert.notEqual(calls[0].recipeId, legacy, "the electrical-learned recipe was replayed on a structural filing");
  assert.equal(calls[0].steps, 0, "steps learned for the other discipline were replayed");
  assert.equal(calls[0].portalUrl, `${COVE}/Default.aspx`);
  const dropped = audited("portal.discipline_recipe_skipped", projectId).filter((d) => d.targetId === t);
  assert.equal(dropped.length, 1, "the drop was not audited");
  assert.equal(dropped[0].recipeId, legacy);
  assert.equal(dropped[0].learnedFor, "electrical");

  // MUST-PASS: the same legacy row still replays for the discipline it was learned for.
  const et = target(projectId, { permitType: "electrical", applicationNumber: "194-26-000906-ELEC" });
  await reopen(projectId, et);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].recipeId, legacy, "a legacy '' recipe of the SAME discipline stopped replaying");
  assert.equal(calls[0].steps, 3);
});

await check("(r4) MUST-EXCLUDE rule 5: a discipline recipe on a utility host is still refused by recipeHostFit", async () => {
  // Written raw: the recipe writers may refuse this shape, and the reopen must refuse it anyway.
  const bad = learn("Testharbor", "electrical", `${ACA}/Login.aspx`);
  db.run("UPDATE portal_recipes SET portal_url = ? WHERE id = ?", ["https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login", bad]);
  const projectId = fx.newProject({ ahj: "Testharbor", utility: "Nowhere Power Co" });
  const t = target(projectId, { permitType: "electrical", applicationNumber: "194-26-000904-ELEC", portalUrl: `${ACA}/Default.aspx` });
  await reopen(projectId, t);
  assert.equal(calls.length, 1, "the reopen did not run on the target's own URL");
  assert.notEqual(calls[0].recipeId, bad, "a utility-host recipe was replayed on a permit filing");
  assert.equal(calls[0].steps, 0);
  const refused = audited("portal.track_host_conflict", projectId).filter((d) => d.targetId === t);
  assert.equal(refused.length, 1, "the refusal was not audited");
  assert.equal(refused[0].recipeId, bad, "the refusal did not name the discipline recipe it judged");
});

finish("reopenDisciplineRecipe");
