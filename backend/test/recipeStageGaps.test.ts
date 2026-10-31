// REFUSE TO STAGE UNTIL EVERY FIELD THE RECIPE WILL FILL HAS A VALUE (#445; owner 2026-10-31: "I need
// to get to the point where automated fill is right every time").
//
// The stage gate used to read a FIXED list (validatePortalFields) plus the three per-job answer keys
// (openPerJobQuestions). A non-optional fill bound to any other project or client field — a preparer
// phone, an inverter model, a contractor licence — could be blank, and the first sign was the portal
// refusing Next after a full run. recipeStageGaps reads the BOUND steps (after bindRecipeForReplay)
// and names every gap; prepareSubmission refuses with a 409 before a browser opens; the track card
// shows the same list.
//
//   (P1-P5) a PacifiCorp-shaped and (G1-G5) a PGE-shaped recipe, the issue's five cases each:
//           all bound fields present passes; one blank bound fill is named (label + field); a blank
//           OPTIONAL step passes; a missing upload docType is named; a literal (unbound) step never
//           counts.
//   (R)     steps the REPLAY answers itself never count (fee tier, battery declaration / spec on a
//           job without storage, a binder-blanked box, a planner-invented key); the signature box
//           reads the authorized signer; a model with a certified name is present.
//   (Q)     the per-job questions are unchanged (same keys and labels as openPerJobQuestions).
//   (S)     RULE 2: a blank secret field is named by its fixed label, never the step's recorded
//           text; (I1) the 409 body and its audit line never carry the account or meter number.
//   (I)     THROUGH THE REAL prepareSubmission: refused 409 before any browser or run row, each gap
//           named in details.missingRecipeInputs; filled, it launches; a project with no recipe (the
//           mock adapter) still passes on the fixed list alone.
//   (A)     autopilot Segment A holds only the track whose recipe has the gap, and names it.
//   (C)     the track card (getSubmittalTracks) carries the same list, and writes nothing.
//
// KILL TESTS: drop the `fields` loop in recipeStageGaps → P2/G2/I fail; drop the optional skip →
// P3/G3 fail; drop the upload branch → P4/G4 fail; count unbound steps → P5/G5 fail; label a secret
// gap by step text → S fails; remove the gate call in repository.ts → I fails.
//
// Run: npx tsx backend/test/recipeStageGaps.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import type { RecipeStep } from "../../shared/src/types";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("recipe-stage-gaps");
const { db, repo, recipes } = fx;
const { recipeStageGaps } = await import("../src/recipeStageGaps");
const { bindRecipeForReplay, openPerJobQuestions } = await import("../src/recipeReplayBinding");
const { getSubmittalTracks } = await import("../src/submittalTracks");

const fill = (label: string, field: string, extra: Partial<RecipeStep> = {}): RecipeStep =>
  ({ action: "fill", selector: { label }, field, note: label, ...extra } as RecipeStep);
const select = (label: string, field: string, extra: Partial<RecipeStep> = {}): RecipeStep =>
  ({ action: "select", selector: { label }, field, note: label, ...extra } as RecipeStep);
const literal = (label: string, value: string, action: "fill" | "select" = "select"): RecipeStep =>
  ({ action, selector: { label }, value, note: label } as RecipeStep);
const upload = (docType: string, label: string, extra: Partial<RecipeStep> = {}): RecipeStep =>
  ({ action: "upload", selector: { label }, docType, note: `upload ${docType}: ${label}`, ...extra } as RecipeStep);
const REVIEW = { action: "stopForReview", selector: {} } as RecipeStep;

// ── A PacifiCorp-shaped NEM recipe (PowerClerk) — synthetic, never run against a portal ──────────
const PACIFICORP: RecipeStep[] = [
  fill("Account Holder First Name", "ubAccountHolderFirstName"),
  fill("Account Holder Last Name", "ubAccountHolderLastName"),
  fill("Customer Email", "ubAccountHolderEmail"),
  fill("Service Address", "street"),
  fill("Account Number (please use this format: xxxxxxxx xxx x)", "accountNumber", { sensitive: true }),
  fill("Meter Number", "meterNumber", { sensitive: true }),
  select("Inverter Manufacturer", "inverterManufacturer"),
  select("Inverter Model", "inverterModel"),
  fill("Inverter Quantity", "inverterQuantity"),
  fill("Preparer Phone", "installerPhone"),
  literal("Will you be participating in the Wattsmart Battery Program?", "No, I will not be participating"),
  literal("System Mounting Method", "Roof Mounting"),
  fill("Notes to the utility", "workDescription", { optional: true }),
  upload("utility_bill", "Utility Bill"),
  upload("sld", "One-Line Diagram"),
  REVIEW,
];
const PACIFICORP_VALUES: Record<string, string> = {
  ubAccountHolderFirstName: "Pat", ubAccountHolderLastName: "Example", ubAccountHolderEmail: "pat@example.test",
  street: "100 Example Way", accountNumber: "90000000-0040", meterNumber: "77665544",
  inverterManufacturer: "Enphase", inverterModel: "IQ8M", inverterQuantity: "20", installerPhone: "(503) 555-0100",
  workDescription: "", hasBattery: "No",
};
const PACIFICORP_DOCS = { utility_bill: "/tmp/bill.pdf", sld: "/tmp/sld.pdf" };

// ── A PGE-shaped NEM recipe (PowerClerk) ─────────────────────────────────────────────────────────
const PGE: RecipeStep[] = [
  fill("Customer Name", "ubAccountHolder"),
  fill("Service Account Number", "accountNumber", { sensitive: true }),
  fill("Total System Export (kW)", "totalExportKw"),
  select("Manufacturer", "moduleMake", { selector: { label: "Manufacturer", section: "PV Module" } } as Partial<RecipeStep>),
  select("Model", "moduleModel", { selector: { label: "Model", section: "PV Module" } } as Partial<RecipeStep>),
  fill("Contractor License Number", "ccbLicenseNumber"),
  fill("Contractor Phone", "installerPhone"),
  literal("Is this a new service?", "No"),
  fill("Install date", "installDate", { optional: true }),
  upload("site_plan", "Site Plan"),
  REVIEW,
];
const PGE_VALUES: Record<string, string> = {
  ubAccountHolder: "PAT EXAMPLE", accountNumber: "1234567890", totalExportKw: "6.5", moduleMake: "Qcells",
  moduleModel: "", moduleModelCertified: "Q.TRON BLK M-G2.C1+/AC 430", ccbLicenseNumber: "240136", installerPhone: "(503) 555-0143",
  installDate: "",
};
const PGE_DOCS = { site_plan: "/tmp/site.pdf" };

const keys = (g: Array<{ key: string }>) => g.map((x) => x.key);

for (const [name, steps, values, docs, blankKey, blankLabel, docKey, literalLabel] of [
  ["PacifiCorp", PACIFICORP, PACIFICORP_VALUES, PACIFICORP_DOCS, "installerPhone", "Preparer Phone", "sld", "System Mounting Method"],
  ["PGE", PGE, PGE_VALUES, PGE_DOCS, "ccbLicenseNumber", "Contractor License Number", "site_plan", "Is this a new service?"],
] as const) {
  const tag = name === "PacifiCorp" ? "P" : "G";
  await check(`(${tag}1) ${name}: every bound field present (and every upload on file) passes`, () => {
    assert.deepEqual(recipeStageGaps(steps as RecipeStep[], values, docs), []);
  });
  await check(`(${tag}2) ${name}: one blank bound fill is refused, named by its label and its field`, () => {
    const gaps = recipeStageGaps(steps as RecipeStep[], { ...values, [blankKey]: "" }, docs);
    assert.equal(gaps.length, 1, JSON.stringify(gaps));
    assert.equal(gaps[0].kind, "field");
    assert.equal(gaps[0].key, blankKey);
    assert.equal(gaps[0].label, blankLabel);
    assert.equal(gaps[0].where, "client", "a company field is filled on the client record");
    assert.ok(gaps[0].fieldName.length > 0 && gaps[0].fieldName !== blankKey, `the field is not named in words: ${gaps[0].fieldName}`);
  });
  await check(`(${tag}3) ${name}: a blank OPTIONAL step passes`, () => {
    // The optional step's field is blank in the dictionary already; flip optional off to prove it is
    // the flag (not the value) that lets it through.
    assert.deepEqual(recipeStageGaps(steps as RecipeStep[], values, docs), []);
    const strict = (steps as RecipeStep[]).map((s) => (s.optional ? { ...s, optional: false } : s));
    assert.equal(recipeStageGaps(strict, values, docs).length, 1, "the same step, not optional, must be named");
  });
  await check(`(${tag}4) ${name}: an upload whose document is not on file is refused`, () => {
    const rest = { ...docs } as Record<string, string>;
    delete rest[docKey];
    const gaps = recipeStageGaps(steps as RecipeStep[], values, rest);
    assert.deepEqual(gaps.map((g) => [g.kind, g.key, g.where]), [["document", docKey, "documents"]]);
    // An optional upload does not hold the stage.
    const optionalUpload = (steps as RecipeStep[]).map((s) => (s.action === "upload" && s.docType === docKey ? { ...s, optional: true } : s));
    assert.deepEqual(recipeStageGaps(optionalUpload, values, rest), []);
  });
  await check(`(${tag}5) ${name}: a literal (unbound) step never counts as missing, whatever the dictionary holds`, () => {
    const step = (steps as RecipeStep[]).find((s) => s.note === literalLabel)!;
    assert.ok(step && !step.field, "the fixture's literal step is unbound");
    assert.deepEqual(recipeStageGaps([{ ...step, value: "" }], {}, {}), [], "even a blank literal is the recipe's own answer");
  });
}

await check("(R) steps the replay answers itself never count; the signature reads the signer; a certified model is present", () => {
  const steps: RecipeStep[] = [
    fill("5.01kva through 15kva:", "feeTierKva5_01To15"),                 // fee-tier box: decided from the page
    select("Does the system include energy storage?", "energyStorageAnswer"), // battery declaration
    fill("Energy Storage Capacity of Battery (kWh)", "essKwh"),           // battery spec on a no-battery job
    upload("battery_spec", "Battery Specification Sheet"),                // battery document, no battery
    fill("Blanked by the binder", "__replayBlank"),
    fill("Job Category", "jobCategory", { value: "STAND-ALONE" }),       // planner-invented key
    fill("Applicant Signature", "installerContactName", { note: "e-signature: Applicant Signature" }),
    select("Inverter Model", "inverterModel"),
  ];
  const values = { hasBattery: "No", energyStorageAnswer: "", essKwh: "", installerContactName: "", authorizedSignerName: "Pat Signer", inverterModel: "", inverterModelCertified: "IQ8M-72-2-US {240V}" };
  assert.deepEqual(recipeStageGaps(steps, values, {}), [], JSON.stringify(recipeStageGaps(steps, values, {})));
  const noSigner = recipeStageGaps(steps, { ...values, authorizedSignerName: "" }, {});
  assert.deepEqual(keys(noSigner), ["authorizedSignerName"], "the signature box needs the client's authorized signer, not the contact");
  assert.equal(noSigner[0].where, "client");
  // With storage, the battery's spec and document ARE this job's to fill.
  const withBattery = recipeStageGaps(steps, { ...values, hasBattery: "Yes" }, {});
  assert.deepEqual(withBattery.map((g) => g.key).sort(), ["battery_spec", "essKwh"]);
  // One entry per key: two boxes bound to the same blank field are one gap.
  assert.equal(recipeStageGaps([fill("Phone", "installerPhone"), fill("Phone (again)", "installerPhone")], { installerPhone: "" }, {}).length, 1);
});

await check("(Q) the per-job questions are listed as before (openPerJobQuestions' keys and labels), before any field", () => {
  const OWNERSHIP_Q = "Will the System be Customer-Owned or Third-Party Owned?";
  const steps = bindRecipeForReplay({
    steps: [fill("Preparer Phone", "installerPhone"), { action: "select", selector: { label: OWNERSHIP_Q }, value: "Customer-Owned", note: OWNERSHIP_Q } as RecipeStep],
    project: { state: "OR", ahj: "Coos Bay", parserSnapshot: {} }, fieldValues: { installerPhone: "" }, track: "nem", borrowed: null, agency: null,
  }).steps;
  const gaps = recipeStageGaps(steps, { installerPhone: "" }, {});
  assert.deepEqual(gaps.map((g) => [g.kind, g.key]), [["question", "ownershipModel"], ["field", "installerPhone"]]);
  const q = openPerJobQuestions(steps, { installerPhone: "" });
  assert.deepEqual(gaps.filter((g) => g.kind === "question").map((g) => ({ key: g.key, label: g.label })), q);
  assert.deepEqual(recipeStageGaps(steps, { installerPhone: "(503) 555-0100", ownershipModel: "PPA" }, {}), []);
});

await check("(S) rule 2: a blank secret field is named by its fixed label, never by the step's recorded text", () => {
  const steps = [fill("Acct # 90000000-0040 (from bill)", "accountNumber", { sensitive: true }), fill("ESI ID", "esiId", { sensitive: true })];
  const gaps = recipeStageGaps(steps, { accountNumber: "", esiId: "" }, {});
  assert.deepEqual(gaps.map((g) => [g.key, g.label, g.secret]), [["accountNumber", "Utility account number", true], ["esiId", "ESI ID", true]]);
  assert.ok(!JSON.stringify(gaps).includes("90000000"), "recorded text carrying digits reached the gap");
});

// ── (I) THROUGH THE REAL prepareSubmission ──────────────────────────────────────────────────────
const ACCOUNT = "1234567890"; // the fixture project's synthetic account (setupStageFixture FIXTURE)
const METER = "987654321";
let launched = 0;
fx.stubRunner(async () => {
  launched++;
  return { portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null, steps: [{ ok: true, message: "staged" }] };
});
const runRows = (projectId: string) => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM portal_runs WHERE project_id = ?", [projectId])!.n;

await check("(I1) a recipe box bound to a blank project field refuses the stage with a 409 naming it — before any browser or run row; the body never carries a secret", async () => {
  const projectId = fx.newProject();
  fx.completeRecipe([
    ...fx.fills(2),
    fill("Account Number", "accountNumber", { sensitive: true }),
    fill("Meter Number", "meterNumber", { sensitive: true }),
    fill("Owner Email", "homeownerEmail"),
    upload("zoning_approval", "Zoning Approval"),
    fx.REVIEW, fx.FINAL,
  ]);
  const before = launched;
  await assert.rejects(repo.prepareSubmission(db, projectId), (err: { status?: number; message?: string; details?: Record<string, unknown> }) => {
    assert.equal(err.status, 409, String(err.message));
    const missing = (err.details?.missingRecipeInputs ?? []) as Array<{ kind: string; key: string; label: string; where: string }>;
    assert.deepEqual(missing.map((g) => [g.kind, g.key]), [["field", "homeownerEmail"], ["document", "zoning_approval"]], String(err.message));
    assert.match(String(err.message), /"Owner Email" needs Homeowner email/);
    assert.match(String(err.message), /Zoning approval document/);
    assert.equal(err.details?.unansweredPortalQuestions, undefined, "no per-job question was asked");
    const body = JSON.stringify({ message: err.message, details: err.details });
    assert.ok(!body.includes(ACCOUNT) && !body.includes(METER), "the 409 echoed the account or meter number");
    return true;
  });
  assert.equal(launched, before, "a browser was launched with a recipe box blank");
  assert.equal(runRows(projectId), 0, "no run row may be written for a stage that never started");
  const audit = fx.audits("portal.recipe_inputs_missing").filter((a) => a.project_id === projectId);
  assert.equal(audit.length, 1);
  assert.ok(!audit[0].details.includes(ACCOUNT) && !audit[0].details.includes(METER), "the audit line carries a secret");
});

await check("(I2) filled, the same recipe stages: the gate refuses only what is missing", async () => {
  const projectId = fx.newProject();
  fx.completeRecipe([...fx.fills(2), fill("Account Number", "accountNumber", { sensitive: true }), fill("Owner Email", "homeownerEmail"), fx.REVIEW, fx.FINAL]);
  await assert.rejects(repo.prepareSubmission(db, projectId), (err: { status?: number; details?: Record<string, unknown> }) => {
    assert.equal(err.status, 409);
    assert.deepEqual(((err.details?.missingRecipeInputs ?? []) as Array<{ key: string }>).map((g) => g.key), ["homeownerEmail"]);
    return true;
  });
  repo.updateProject(db, projectId, { homeownerEmail: "owner@example.test" });
  const before = launched;
  await repo.prepareSubmission(db, projectId);
  assert.equal(launched, before + 1, "the filled stage did not launch");
});

await check("(I3) the fixed list stays the floor: a project with no recipe stages on the mock adapter as before", async () => {
  db.run("DELETE FROM portal_recipes");
  const projectId = fx.newProject();
  await repo.prepareSubmission(db, projectId);
  const run = fx.latestRun(projectId);
  assert.ok(run, "the mock stage wrote no run");
  assert.notEqual(String(run!.status), "failed", JSON.stringify(run));
});

await check("(A) autopilot: a NEM recipe box with no value holds ONLY the NEM track, named; the permit track still stages", async () => {
  db.run("DELETE FROM portal_recipes");
  const projectId = fx.newProject();
  const { requiredTracks } = await import("../src/submittalTracks");
  const tracks = requiredTracks(repo.getProjectDetail(db, projectId).project);
  assert.equal(tracks[0], "nem", `fixture: NEM must be the first required track (${tracks.join(",")})`);
  fx.completeRecipe(); // the AHJ (permit) recipe — every box has a value
  const nem = recipes.startPortalRecording(db, { scopeType: "utility", state: "OR", utility: "PGE", portalUrl: "https://pgenm.powerclerk.example/MvcAccount/Login", createdBy: "test" });
  recipes.savePortalRecipeSteps(db, nem.id, [...fx.fills(2), fill("Owner Email", "homeownerEmail"), fx.REVIEW, fx.FINAL], { status: "complete", notes: "Auto-learned and verified (high confidence)." });
  const launchedFor: string[] = [];
  fx.stubRunner(async (r) => {
    launchedFor.push(String(r.portalUrl ?? ""));
    return { portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null, steps: [{ ok: true, message: "staged" }] };
  });
  const { runAutopilotSegmentA } = await import("../src/autopilot");
  const seg = await runAutopilotSegmentA(db, projectId);
  const missing = seg.blockers.filter((b) => b.code === "recipe_field_missing");
  assert.equal(seg.blocked, true, seg.message);
  assert.equal(missing.length, 1, JSON.stringify(seg.blockers));
  assert.match(missing[0].detail, /^nem: Fill Homeowner email on the project: the portal's "Owner Email"/, missing[0].detail);
  assert.equal(launchedFor.some((u) => /powerclerk/.test(u)), false, "a browser was opened on the NEM portal with a recipe box blank");
  assert.ok(launchedFor.some((u) => /permits\.portland\.example/.test(u)), `the permit track must still launch: ${launchedFor.join(", ")}`);
});

await check("(C) the NEM track card carries the same gaps the gate names, and reading it writes nothing", () => {
  const projectId = fx.newProject();
  const r = recipes.startPortalRecording(db, {
    scopeType: "utility", state: "OR", utility: "PGE", portalUrl: "https://pge.powerclerk.example/apply", portalPlatform: "powerclerk", createdBy: "test",
  });
  recipes.savePortalRecipeSteps(db, r.id, [fill("Customer Name", "homeownerName"), fill("Owner Email", "homeownerEmail"), upload("meter_photo", "Meter Photo"), REVIEW],
    { status: "complete", notes: "Auto-learned and verified (high confidence)." });
  const project = repo.getProjectDetail(db, projectId).project;
  const changes = () => db.get<{ n: number }>("SELECT total_changes() AS n")!.n;
  const before = changes();
  const nem = getSubmittalTracks(db, project).find((t) => t.type === "nem");
  assert.equal(changes(), before, "the card read wrote a row");
  assert.ok(nem, "no NEM track");
  assert.deepEqual((nem!.stageGaps ?? []).map((g) => [g.kind, g.key, g.where]), [["field", "homeownerEmail", "project"], ["document", "meter_photo", "documents"]], JSON.stringify(nem!.stageGaps));
  // Filled, the card says nothing.
  repo.updateProject(db, projectId, { homeownerEmail: "owner@example.test" });
  const filled = getSubmittalTracks(db, repo.getProjectDetail(db, projectId).project).find((t) => t.type === "nem");
  assert.deepEqual((filled!.stageGaps ?? []).map((g) => g.key), ["meter_photo"], JSON.stringify(filled!.stageGaps));
});

finish("recipe stage gaps");
