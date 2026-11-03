// THE MONITOR READS A FILING WITH ITS OWN DISCIPLINE'S RECIPE (#426).
//
// Live install 2026-10-31: the City of Coos Bay recipes are per-discipline (a `structural` and an
// `electrical` row, both complete, no '' row). The signed-in status read looked its recipe up with no
// discipline, so both lookups required discipline '' and neither matched: the monitor never signed
// in, fell back to the public page, and every sweep logged "status unreadable this sweep".
//
// The sweep is the real runDuePermitChecks over targets and recipes written through the real writers;
// only the browser and the network are stubbed (setStatusCheckSeamsForTests).
//
//   MUST-PASS    a structural (building) target on an AHJ with only per-discipline recipes reaches
//                statusScrape("recipe", …) with the STRUCTURAL recipe; an electrical one with the
//                ELECTRICAL recipe; an old-door permit_type "structural" reads as building
//   MUST-PASS    the mapping is staging's own (recipeDisciplineForTrack): every track maps to what
//                staging asks for; NEM asks for no discipline
//   MUST-PASS    NEM unchanged: a NEM target reads the utility's recipe
//   MUST-EXCLUDE rule 5 unchanged: a discipline recipe whose portal is a utility interconnection host
//                is still refused by recipeHostFit and never handed to the scraper
//
// Run: npx tsx backend/test/monitorDisciplineRecipe.test.ts
import "./_isolate"; // FIRST — generated files land in a temp cwd, never the repo's backend/data
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("monitor-discipline-recipe");
const { db, repo, recipes } = fx;
process.env.PORTAL_AUTOSEED = "1"; // the live install's mode: an empty read is skipped, not mocked
process.env.PORTAL_FEE_READ = "off"; // the fee reader has its own suite; never the network here
const { recipeDisciplineForTrack } = await import("../src/portalChannel");
const { SUBMITTAL_TRACK_TYPES } = await import("../src/submittalTracks");

const ACA = "https://aca-test.accela.com/TESTBAY";
const REVIEW = { action: "stopForReview", selector: {} } as never;
const fill = (i: number) => ({ action: "fill", selector: { name: `f${i}` }, field: "homeownerName", note: `Field ${i}` }) as never;

type ScrapeCall = { adapter: string; apps: string[]; recipeId?: string };
const scrapes: ScrapeCall[] = [];
repo.setStatusCheckSeamsForTests({
  checkStatus: (async (adapter: string, apps: string[], opts: { recipe?: { id: string } }) => {
    scrapes.push({ adapter, apps, recipeId: opts.recipe?.id });
    return `Record Number: ${apps[0]} | Status: In Review`;
  }) as never,
  publicCheck: (async () => null) as never,
});

const target = (projectId: string, input: { targetType: "permit" | "nem"; permitNumber?: string; applicationNumber?: string; permitType?: string }) => {
  repo.createPermitCheckTarget(db, projectId, { portalUrl: "", jurisdiction: "Testbay", portalName: "", ...input } as never);
  const id = db.get<{ id: string }>("SELECT id FROM permit_check_targets WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", [projectId])!.id;
  // An older door wrote permit_type values that are not track names ("structural"): write it raw.
  if (input.permitType) db.run("UPDATE permit_check_targets SET permit_type = ? WHERE id = ?", [input.permitType, id]);
  return id;
};
const sweep = async (...ids: string[]) => {
  db.run("UPDATE permit_check_targets SET active = 0");
  for (const t of ids) db.run("UPDATE permit_check_targets SET active = 1, next_check_at = NULL WHERE id = ?", [t]);
  scrapes.length = 0;
  await repo.runDuePermitChecks(db, "all");
};

// The AHJ's two per-discipline recipes — no '' row, exactly the Coos Bay shape.
const learn = (ahj: string, discipline: string, portalUrl: string) => {
  const r = recipes.startPortalRecording(db, { scopeType: "ahj", state: "OR", ahj, portalUrl, portalPlatform: "accela", createdBy: "test", discipline });
  recipes.savePortalRecipeSteps(db, r.id, [fill(1), fill(2), REVIEW], { status: "complete" });
  return r.id;
};
const structural = learn("Testbay", "structural", `${ACA}/Login.aspx`);
const electrical = learn("Testbay", "electrical", `${ACA}/Login.aspx`);
const bayProject = () => fx.newProject({ ahj: "Testbay", utility: "Nowhere Power Co" });

await check("(d0) the fixture is the Coos Bay shape: a discipline-less lookup finds no recipe", () => {
  assert.notEqual(structural, electrical, "the two disciplines share one row");
  const input = { scopeType: "ahj" as const, state: "OR", ahj: "Testbay", utility: "Nowhere Power Co" };
  assert.equal(recipes.findCompleteRecipeForProject(db, input), null);
  assert.equal(recipes.findAnyRecipeForProject(db, input), null);
});

await check("(d1) MUST-PASS a structural target reaches statusScrape(\"recipe\", …) with the structural recipe", async () => {
  const t = target(bayProject(), { targetType: "permit", permitNumber: "187-26-000901-STR", permitType: "building" });
  await sweep(t);
  assert.equal(scrapes.length, 1, "the signed-in read did not run (no recipe found — the #426 bug)");
  assert.equal(scrapes[0].adapter, "recipe");
  assert.equal(scrapes[0].recipeId, structural, "the structural filing was read with another recipe");
});

await check("(d2) MUST-PASS an electrical target reads with the electrical recipe", async () => {
  const t = target(bayProject(), { targetType: "permit", permitNumber: "194-26-000902-ELEC", permitType: "electrical" });
  await sweep(t);
  assert.equal(scrapes.length, 1, "the signed-in read did not run");
  assert.equal(scrapes[0].recipeId, electrical, "the electrical filing was read with another recipe");
});

await check("(d3) MUST-PASS an old-door permit_type \"structural\" reads as building", async () => {
  const t = target(bayProject(), { targetType: "permit", permitNumber: "187-26-000903-STR", permitType: "structural" });
  await sweep(t);
  assert.equal(scrapes.length, 1, "the signed-in read did not run");
  assert.equal(scrapes[0].recipeId, structural);
});

await check("(d4) MUST-PASS the mapping is staging's own, track by track; NEM asks for no discipline", () => {
  for (const track of SUBMITTAL_TRACK_TYPES) {
    const want = track === "nem" ? "" : recipeDisciplineForTrack(track);
    assert.equal(repo.recipeDisciplineForTarget(track === "nem" ? "nem" : "permit", track), want, `track ${track}`);
  }
  assert.equal(repo.recipeDisciplineForTarget("permit", "structural"), "structural");
  assert.equal(repo.recipeDisciplineForTarget("permit", "Electrical"), "electrical");
  assert.equal(repo.recipeDisciplineForTarget("permit", "nem"), "", "a legacy permit-typed NEM row is NEM");
  assert.equal(repo.recipeDisciplineForTarget("permit", ""), "", "a target with no permit type keeps today's lookup");
});

await check("(d5) MUST-PASS NEM unchanged: a NEM target reads the utility's recipe", async () => {
  const nem = recipes.startPortalRecording(db, { scopeType: "utility", state: "OR", utility: "Testbay Power", portalUrl: "https://testbaypower.powerclerk.com/MvcAccount/Login", portalPlatform: "powerclerk", createdBy: "test" });
  recipes.savePortalRecipeSteps(db, nem.id, [fill(1), fill(2), REVIEW], { status: "complete" });
  const t = target(fx.newProject({ ahj: "Testbay", utility: "Testbay Power" }), { targetType: "nem", applicationNumber: "APP-900001" });
  await sweep(t);
  assert.equal(scrapes.length, 1, "the NEM signed-in read did not run");
  assert.equal(scrapes[0].recipeId, nem.id);
});

await check("(d6) MUST-EXCLUDE rule 5: a discipline recipe on a utility host is still refused, never scraped", async () => {
  // Written raw: the recipe writers may refuse this shape, and the monitor must refuse it anyway.
  const bad = learn("Testharbor", "structural", `${ACA}/Login.aspx`);
  db.run("UPDATE portal_recipes SET portal_url = ? WHERE id = ?", ["https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login", bad]);
  const projectId = fx.newProject({ ahj: "Testharbor", utility: "Nowhere Power Co" });
  const t = target(projectId, { targetType: "permit", permitNumber: "187-26-000904-STR", permitType: "building" });
  await sweep(t);
  assert.deepEqual(scrapes, [], "a utility-host recipe was handed to the scraper on a permit filing");
  const refused = fx.audits("portal.track_host_conflict").map((a) => JSON.parse(a.details)).filter((d) => d.targetId === t);
  assert.equal(refused.length, 1, "the refusal was not audited");
  assert.equal(refused[0].recipeId, bad, "the refusal did not name the discipline recipe it judged");
});

finish("monitorDisciplineRecipe");
