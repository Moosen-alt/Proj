// A LEARN THAT LEFT A PAGE INCOMPLETE IS NEVER TRUSTED (issue #534) — the backend half.
//
// Live (PacifiCorp NEM, 2026-11-02, a two-array job): the learn ended "status: trusted" and promoted
// the shared recipe to complete. Its message read "3 field(s) checked on the final page … — the
// earlier pages were not re-read … The recipe is trusted". Page 9 had been left with the inverter
// Model blank, "This field is required." under it and System Rating "Needs to be recalculated".
//
// The adapter records, for every page with a form field, what the page ended with (#536's
// PageTrustEvidence, plus #534's computed-total reading) and which pages it read at all
// (pageExitReads); portal-bot/src/adapters/learnExitSweep.dom.smoke.ts proves that in real
// Chromium. This file proves, through the REAL autoLearnPortal with only the browser and the LLM
// stubbed, that the trust gate ACTS on all of it, on a MIDDLE page:
//
//   1. a required select left blank on a MIDDLE page (the portal's "This field is required." under
//      it) -> not trusted;
//   2. a MIDDLE page left with a computed total to recalculate -> not trusted;
//   3. an equipment value the portal did not keep (a required miss) -> not trusted, and that
//      equipment label never becomes a learned digest topic, while a real question still does;
//   4. a REQUIRED checkbox left unchecked on a middle page -> not trusted; one marked as an
//      acknowledgment (left for a person by design) alone does not block;
//   5. an equipment write that reached another control -> not trusted;
//   6. a page the exit reading could not read, or a learn that reports no reading -> not trusted
//      (an unknown is never a clean page);
//   7. a clean learn IS still trusted (the over-correction guard), and its words never pair
//      "trusted" with "not re-read" — they say how many pages were read, of how many;
//   8. pageExitTrustSignals / evaluateTrustGate, directly.
//
// KILL TESTS (each disables its fix and turns this file red):
//   K1 evaluateTrustGate: drop the exitValidationErrors blocker   -> (1), (8) fail.
//   K2 evaluateTrustGate: drop the exitComputePending blocker     -> (2), (8) fail.
//   K3 autoLearn: feed requiredMisses unfiltered to learnNoteTopicsFromMisses -> (3) fails.
//   K4 pageExitTrustSignals: drop the acknowledgment filter         -> (7), (8) fail.
//   K5 evaluateTrustGate: drop the exitPagesRead blockers          -> (6), (8) fail.
//   K6 trustedLearnWording: restore "the earlier pages were not re-read" -> (7) fails.
//   On origin/main (no pageExitTrustSignals, the gate blind to trustEvidence) (1), (2), (4), (5),
//   (6) and (8) fail.
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

type Evidence = { page: number; where: string; validationErrors: string[]; requiredUnchecked: Array<{ label: string; acknowledgment: boolean }>; strayWrites: string[]; computePending: string };
const portalUrl = "https://devhub.portlandoregon.gov/apply";
/** One page's evidence, the adapter's shape. */
const evidence = (page: number, e: Partial<Evidence>): Evidence => ({
  page, where: "devhub.portlandoregon.gov/apply", validationErrors: [], requiredUnchecked: [], strayWrites: [], computePending: "", ...e,
});
/** A four-page walk that reached review with six bound fills, every form page (2-4) read — enough
 *  to clear every other bar. Page 2 is the MIDDLE page. */
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
    equipmentNotHeld: [],
    pageExitReads: { read: [2, 3, 4], unread: [] },
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
const BLANK_SELECT = "Inverter Clone System Model: This field is required.";
const STALE = '"Needs to be recalculated"';
const UNHELD = "Inverter Clone System Model";

await check("(1) a required select left blank on the MIDDLE page is NOT trusted", async () => {
  const r = await learnWith({ trustEvidence: [evidence(2, { validationErrors: [BLANK_SELECT] })] });
  notTrusted(r, "a middle page left with a required select blank");
  assert.match(r.issues, /validation error.*page 2: Inverter Clone System Model: This field is required/i, `the issues do not say what stopped it: ${r.issues.slice(0, 300)}`);
});

await check("(2) a MIDDLE page left with a total to recalculate is NOT trusted", async () => {
  const r = await learnWith({ trustEvidence: [evidence(2, { computePending: STALE })] });
  notTrusted(r, "a page left stale");
  assert.match(r.issues, /recalculate.*page 2: "Needs to be recalculated"/i, `the issues do not say what stopped it: ${r.issues.slice(0, 300)}`);
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

await check("(4) a REQUIRED checkbox left unchecked on a middle page is NOT trusted", async () => {
  const BOX = "The battery system will not backfeed into the grid.";
  const r = await learnWith({ trustEvidence: [evidence(2, { requiredUnchecked: [{ label: BOX, acknowledgment: false }] })] });
  notTrusted(r, "a required box left unchecked");
  assert.match(r.issues, /checkbox.*page 2: The battery system will not backfeed/i, `the issues do not name the box: ${r.issues.slice(0, 300)}`);
  // Unmarked counts as required (fail closed): a box with no acknowledgment flag at all blocks too.
  const unmarked = await learnWith({ trustEvidence: [evidence(3, { requiredUnchecked: [{ label: BOX } as never] })] });
  notTrusted(unmarked, "a required box with no acknowledgment flag");
});

await check("(5) an equipment write that reached another control is NOT trusted", async () => {
  const r = await learnWith({ trustEvidence: [evidence(2, { strayWrites: ['Battery Inverter Model: its selector now reaches "Total System Export (kW)" — not filled'] })] });
  notTrusted(r, "a stray equipment write");
  assert.match(r.issues, /another control.*page 2: Battery Inverter Model/i, `the issues do not name the write: ${r.issues.slice(0, 300)}`);
});

await check("(6) a page the exit reading could not read, or a learn with no reading, is NOT trusted", async () => {
  const unread = await learnWith({ pageExitReads: { read: [3, 4], unread: [2] } });
  notTrusted(unread, "a page left unread");
  assert.match(unread.issues, /Page\(s\) 2 could not be read/i, `the issues do not name the unread page: ${unread.issues.slice(0, 300)}`);
  const none = await learnWith({ pageExitReads: undefined });
  notTrusted(none, "a learn that reports no page-exit reading");
  assert.match(none.issues, /did not report reading its pages/i, none.issues.slice(0, 300));
});

await check("(7) a CLEAN learn is still trusted, with an acknowledgment left for a person; its words never pair 'trusted' with 'not re-read'", async () => {
  const r = await learnWith({ trustEvidence: [evidence(4, { requiredUnchecked: [{ label: "I understand my form will not be submitted until I click Submit", acknowledgment: true }] })] });
  assert.equal(r.result.status, "trusted", `the gate must still pass a clean run: ${String(r.result.message).slice(0, 300)} | ${r.issues.slice(0, 300)}`);
  const message = String(r.result.message);
  const note = String(r.recipe?.notes ?? "");
  for (const [what, text] of [["message", message], ["note", note]] as const) {
    assert.doesNotMatch(text, /not re-?read/i, `the ${what} says trusted AND that pages were not re-read: ${text}`);
    assert.match(text, /read 3 of the 4 page\(s\) as it left them/i, `the ${what} does not say how many pages were read, of how many: ${text}`);
    // The denominator dryrunPortalClose (B10) pins is still there.
    assert.match(text, /3 field\(s\) checked on the final page \(3 matched\) of 6 recorded fill\(s\) across 4 page\(s\)/, `the ${what} lost its denominator: ${text}`);
  }
  assert.match(message, /recipe is trusted/i);
  assert.match(note, /^Auto-learned and verified \(high confidence\) on 4 page\(s\)\./, "the matching-key prefix changed");
});

await check("(8) pageExitTrustSignals + evaluateTrustGate: every kind blocks, the acknowledgment does not, an unknown is not clean", () => {
  const clean = {
    reachedReview: true, filledSomething: true, reviewReadable: true, verificationAccurate: true, textContradicts: false,
    requiredFieldMisses: [] as string[], missingRequiredDocs: [] as string[], validationBlocks: [] as string[],
    ambiguousLiteralCount: 0, deadBindings: [] as string[], pageCount: 10, substantiveFills: 92, formPurposeMismatch: false,
  };
  type Learn = { trustEvidence?: Evidence[]; pageExitReads?: { read: number[]; unread: number[] } };
  const gate = (learn: Learn) => autoLearn.evaluateTrustGate({ ...clean, ...autoLearn.pageExitTrustSignals(learn) });
  const reads = { read: [3, 4, 5, 6, 7, 8, 9, 10], unread: [] as number[] };
  assert.deepEqual(gate({ pageExitReads: reads }), { trusted: true, blockers: [] });
  assert.deepEqual(gate({ pageExitReads: reads, trustEvidence: [evidence(10, { requiredUnchecked: [{ label: "I certify I am the property owner", acknowledgment: true }] })] }), { trusted: true, blockers: [] },
    "an acknowledgment left for a person by design must not block");
  const cases: Array<[string, Learn, RegExp]> = [
    ["blank select on page 9", { pageExitReads: reads, trustEvidence: [evidence(9, { validationErrors: [BLANK_SELECT] })] }, /validation error: page 9: Inverter Clone System Model/],
    ["stale total on page 9", { pageExitReads: reads, trustEvidence: [evidence(9, { computePending: STALE })] }, /recalculated: page 9: "Needs to be recalculated"/],
    ["required box on page 9", { pageExitReads: reads, trustEvidence: [evidence(9, { requiredUnchecked: [{ label: "The battery system will not backfeed into the grid.", acknowledgment: false }] })] }, /left unchecked: page 9: The battery system/],
    ["stray write on page 9", { pageExitReads: reads, trustEvidence: [evidence(9, { strayWrites: ["Battery Inverter Model: not filled"] })] }, /another control: page 9: Battery Inverter Model/],
    ["page 9 unread", { pageExitReads: { read: [3, 4, 5, 6, 7, 8, 10], unread: [9] } }, /could not be read as the walk left them: 9/],
    ["no reading reported", {}, /did not report reading its pages/],
    ["no page read", { pageExitReads: { read: [], unread: [] } }, /no page was read/],
  ];
  for (const [label, learn, why] of cases) {
    const v = gate(learn);
    assert.equal(v.trusted, false, `${label} must block`);
    assert.match(v.blockers.join(" | "), why, `${label}: ${v.blockers.join(" | ")}`);
  }
});

finish("learn-trust-blanks");
