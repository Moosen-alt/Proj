// A LEARN THAT LEFT A PAGE INCOMPLETE IS NEVER TRUSTED (issue #534) — the backend half.
//
// Live (PacifiCorp NEM, 2026-11-02, a two-array job): the learn ended "status: trusted" and promoted
// the shared recipe to complete. Its message read "3 field(s) checked on the final page … — the
// earlier pages were not re-read … The recipe is trusted". Page 9 had been left with the inverter
// Model blank, "This field is required." under it and System Rating "Needs to be recalculated".
//
// The adapter half (portal-bot/src/adapters/learnExitSweep.dom.smoke.ts, real Chromium) proves the
// learn now RECORDS those facts for every page it leaves. This file proves, through the REAL
// autoLearnPortal with only the browser and the LLM stubbed, that the trust gate ACTS on them:
//
//   1. a learn whose MIDDLE page was left with a computed total to recalculate is not trusted;
//   2. ...or left showing a field validation error;
//   3. ...or left an equipment value the portal did not keep (a required miss), and that
//      equipment label never becomes a learned digest topic (it is not a question), while a real
//      unanswered question still does;
//   4. a clean learn IS still trusted (the over-correction guard), and its message never says
//      "trusted" while also saying the earlier pages were not re-read;
//   5. evaluateTrustGate itself blocks on each new signal and passes without them.
//
// KILL TESTS (each disables its fix and turns this file red — recorded in the commit):
//   K1 autoLearn.evaluateTrustGate: drop the computePendingAtExit blocker      -> (1), (5) fail.
//   K2 autoLearn.evaluateTrustGate: drop the exitValidationErrors blocker      -> (2), (5) fail.
//   K3 autoLearn: feed requiredMisses unfiltered to learnNoteTopicsFromMisses  -> (3) fails.
//   K4 autoLearn.trustedLearnWording: restore "the earlier pages were not re-read" -> (4) fails.
//
// Run: npx tsx backend/test/learnTrustBlanks.test.ts
import "./_isolate"; // FIRST — generated files land in a temp cwd, never the repo's backend/data
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("learn-trust-blanks");
const { db, repo, recipes } = fx;
const autoLearn = await import("../src/autoLearn");
const llmMod = await import("../src/llm");

// ── the stub launcher and the stub LLM (dryrunPortalClose's pattern) ───────────────────────────
let nextLearn: Record<string, unknown> = {};
const failedLearn = { ok: false, portalName: "stub", steps: [], reviewScreen: { fields: [], bodyTextSnippet: "" }, finalSubmitRecorded: false, pageCount: 0, pauseReason: null, message: "stub learn: nothing walked" };
autoLearn.setAutoLearnSeamsForTests({ learnPortal: (async () => ({ ...failedLearn, ...nextLearn })) as never });
// The verifier is satisfied with the final page — exactly what it said on the live run.
const verified = {
  accurate: true, overallConfidence: "high" as const, issues: [], notes: "",
  matches: [
    { label: "Meter aggregation", expected: "No Aggregation", found: "No Aggregation", ok: true },
    { label: "Serve more than one customer?", expected: "No", found: "No", ok: true },
    { label: "I certify", expected: "checked", found: "checked", ok: true },
  ],
};
const base = llmMod.createLLMProvider(); // no API key -> the stub provider
const fakeLlm = Object.assign(Object.create(base), {
  verifyPortalFill: async () => verified,
  verifyPortalFillVision: async () => verified,
  planPortalFields: async () => ({ fills: [], advanceIndex: null, navigateIndex: null, finalSubmitIndex: null, atReview: false, notes: "" }),
});
autoLearn.setAutoLearnSeamsForTests({ llm: () => fakeLlm });

const portalUrl = "https://devhub.portlandoregon.gov/apply";
/** A four-page walk that reached review with six bound fills — enough to clear every other bar. */
function walkedLearn(projectId: string, extra: Record<string, unknown>): Record<string, unknown> {
  const project = repo.getProjectDetail(db, projectId).project;
  const replay = recipes.resolveRecipeFieldValues(db, project, "AHJ", "building");
  const keys = Object.keys(replay).filter((k) => String(replay[k] ?? "").trim() && !/acc(oun)?t|meter|ssn|passw/i.test(k)).slice(0, 6);
  assert.ok(keys.length >= 5, `fixture: need 5 bindable fields, got ${keys.join(",")}`);
  return {
    ok: true, portalName: "Portland Permits", pageCount: 4, pauseReason: null, finalSubmitRecorded: true,
    reachedReview: true, filledSomething: true, message: "reached review",
    steps: [
      { action: "goto", value: portalUrl, note: "entry url" },
      ...keys.map((k, i) => ({ action: "fill", selector: { name: `f${i}` }, field: k, note: k })),
      { action: "stopForReview", selector: {} },
      { action: "click", selector: { text: "Submit" }, isFinalSubmit: true, note: "final submit: Submit (recorded, NOT clicked)" },
    ],
    reviewScreen: { fields: [{ label: "Owner", value: "x" }], bodyTextSnippet: "Review your application before submitting." },
    reviewScreenshotBase64: "iVBORw0KGgo=",
    requiredFieldMisses: [], missingRequiredDocs: [], validationBlocks: [],
    equipmentNotHeld: [], computePendingAtExit: [], exitValidationErrors: [],
    ...extra,
  };
}
async function learnWith(extra: Record<string, unknown>) {
  const projectId = fx.newProject();
  nextLearn = walkedLearn(projectId, extra);
  const result = await autoLearn.autoLearnPortal(db, projectId, { scope: "ahj", portalUrl, createdBy: "operator" });
  const recipe = result.recipe ? recipes.getPortalRecipe(db, result.recipe.id) : null;
  return { result, recipe, issues: (result.verification?.issues ?? []).join(" | ") };
}
const notTrusted = (r: Awaited<ReturnType<typeof learnWith>>, why: string): void => {
  assert.notEqual(r.result.status, "trusted", `${why}: the learn was TRUSTED (${String(r.result.message).slice(0, 200)})`);
  assert.notEqual(r.recipe?.status, "complete", `${why}: the shared recipe was promoted to complete`);
};

// The PROBLEM cases run first: a trusted recipe on this portal would turn every later run into
// the protect-complete path, which proves nothing about the gate.
const STALE = 'page 2: "Needs to be recalculated"';
const INVALID = "page 2: Inverter Clone System Model: This field is required.";
const UNHELD = "Inverter Clone System Model";

await check("(1) a learn whose MIDDLE page was left with a total to recalculate is NOT trusted", async () => {
  const r = await learnWith({ computePendingAtExit: [STALE] });
  notTrusted(r, "a page left stale");
  assert.match(r.issues, /recalculate/i, `the issues do not say what stopped it: ${r.issues.slice(0, 300)}`);
  assert.match(r.issues, /page 2/, "the issues do not name the page");
});

await check("(2) a learn whose MIDDLE page was left showing a validation error is NOT trusted", async () => {
  const r = await learnWith({ exitValidationErrors: [INVALID] });
  notTrusted(r, "a page left invalid");
  assert.match(r.issues, /validation error.*This field is required/i, `the issues do not say what stopped it: ${r.issues.slice(0, 300)}`);
});

await check("(3) an equipment value the portal did not keep blocks trust, and never becomes a digest topic", async () => {
  const QUESTION = "Will the System be Customer-Owned or Third-Party Owned?";
  db.run("DELETE FROM learned_note_topics");
  const r = await learnWith({ requiredFieldMisses: [UNHELD, QUESTION], equipmentNotHeld: [UNHELD] });
  notTrusted(r, "an equipment value not kept");
  assert.match(r.issues, /Inverter Clone System Model/, `the issues do not name the unheld equipment: ${r.issues.slice(0, 300)}`);
  const terms = db.query<{ term: string }>("SELECT term FROM learned_note_topics").map((t) => t.term);
  assert.ok(!terms.includes("inverter") && !terms.includes("clone"), `the equipment label was learned as a digest topic: ${terms.join(",")}`);
  assert.ok(terms.includes("owned"), `a real unanswered question must still teach its words: ${terms.join(",")}`);
});

await check("(4) a CLEAN learn is still trusted, and its words never pair 'trusted' with 'not re-read'", async () => {
  const r = await learnWith({});
  assert.equal(r.result.status, "trusted", `the gate must still pass a clean run: ${String(r.result.message).slice(0, 300)} | ${r.issues.slice(0, 300)}`);
  const message = String(r.result.message);
  const note = String(r.recipe?.notes ?? "");
  for (const [what, text] of [["message", message], ["note", note]] as const) {
    assert.doesNotMatch(text, /not re-?read/i, `the ${what} says trusted AND that pages were not re-read: ${text}`);
    assert.match(text, /each form page was checked as the walk left it/i, `the ${what} does not say what every page was checked for: ${text}`);
    // The denominator dryrunPortalClose (B10) pins is still there.
    assert.match(text, /3 field\(s\) checked on the final page \(3 matched\) of 6 recorded fill\(s\) across 4 page\(s\)/, `the ${what} lost its denominator: ${text}`);
  }
  assert.match(message, /recipe is trusted/i);
  assert.match(note, /^Auto-learned and verified \(high confidence\) on 4 page\(s\)\./, "the matching-key prefix changed");
});

await check("(5) evaluateTrustGate blocks on each new signal, and passes without them", () => {
  const clean = {
    reachedReview: true, filledSomething: true, reviewReadable: true, verificationAccurate: true, textContradicts: false,
    requiredFieldMisses: [] as string[], missingRequiredDocs: [] as string[], validationBlocks: [] as string[],
    computePendingAtExit: [] as string[], exitValidationErrors: [] as string[],
    ambiguousLiteralCount: 0, deadBindings: [] as string[], pageCount: 10, substantiveFills: 92, formPurposeMismatch: false,
  };
  assert.deepEqual(autoLearn.evaluateTrustGate(clean), { trusted: true, blockers: [] });
  const stale = autoLearn.evaluateTrustGate({ ...clean, computePendingAtExit: [STALE] });
  assert.equal(stale.trusted, false);
  assert.match(stale.blockers.join(" | "), /recalculated.*page 2/i);
  const invalid = autoLearn.evaluateTrustGate({ ...clean, exitValidationErrors: [INVALID] });
  assert.equal(invalid.trusted, false);
  assert.match(invalid.blockers.join(" | "), /validation error.*Model/i);
});

finish("learn-trust-blanks");
