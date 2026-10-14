// THE LEARN'S LEFT-OPEN WINDOW: A PERSON'S SUBMIT THAT MADE A DRAFT IS NOT "THE HUMAN SUBMITTED" (#302).
//
// index.ts draftAwareHumanSink sits between the human-capture sink and the backend's handler.
// Every recorded step passes straight through. The submit-observed signal is held until the page
// settles and is read: a draft-created page reports the draft (with the clicked label) and the
// signal is NOT forwarded — the backend never promotes the recipe on a click that filed nothing;
// any other page forwards the signal exactly as before. A page that cannot be read forwards too
// (the old behaviour, never a silent drop). Synthetic page text only.
// Run: tsx portal-bot/src/draftAwareHumanSink.test.ts
import assert from "node:assert/strict";
import type { RecipeStep } from "../../shared/src/types";
import { HUMAN_SUBMIT_OBSERVED_NOTE } from "./humanCapture";
import { draftAwareHumanSink, type DraftCreatedObserved } from "./index";

let failures = 0;
const check = async (label: string, fn: () => Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const tick = () => new Promise((r) => setTimeout(r, 20));

const DRAFT_PAGE = "Your draft application NEM-90017 has been created. Please continue to Interconnection Application - Part 2 to complete your interconnection application and submit to PSE.";
const FILED_PAGE = "Thank you. Your application has been submitted. PP - Application Submitted (APP-111681)";
const submitSignal: RecipeStep = { action: "click", selector: {}, optional: true, note: HUMAN_SUBMIT_OBSERVED_NOTE, value: "Submit" } as RecipeStep;
const fill: RecipeStep = { action: "fill", selector: { name: "first" }, value: "x", note: "First name" } as RecipeStep;

function harness(pageText: string | (() => Promise<string>)) {
  const forwarded: RecipeStep[] = [];
  const drafts: DraftCreatedObserved[] = [];
  const adapter = { readCurrentPageText: typeof pageText === "function" ? pageText : async () => pageText };
  const sink = draftAwareHumanSink(adapter, (s) => forwarded.push(s), (d) => drafts.push(d), 0);
  return { sink, forwarded, drafts };
}

await check("an ordinary recorded step passes straight through", async () => {
  const h = harness(DRAFT_PAGE);
  h.sink(fill);
  assert.deepEqual(h.forwarded, [fill]);
  assert.equal(h.drafts.length, 0);
});

await check("a submit whose page reads 'draft created' reports the draft and is NOT forwarded as a submit", async () => {
  const h = harness(DRAFT_PAGE);
  h.sink(submitSignal);
  await tick();
  assert.equal(h.forwarded.length, 0, "the draft-creating click reached the backend as 'the human submitted'");
  assert.equal(h.drafts.length, 1);
  assert.equal(h.drafts[0].applicationNumber, "NEM-90017");
  assert.equal(h.drafts[0].nextForm, "Interconnection Application - Part 2");
  assert.equal(h.drafts[0].clickedLabel, "Submit");
  assert.equal(h.drafts[0].strength, "created");
});

await check("a submit whose page reads as filed is forwarded unchanged", async () => {
  const h = harness(FILED_PAGE);
  h.sink(submitSignal);
  await tick();
  assert.deepEqual(h.forwarded, [submitSignal]);
  assert.equal(h.drafts.length, 0);
});

await check("a page that cannot be read forwards the submit (never a silent drop)", async () => {
  const h = harness(async () => { throw new Error("page closed"); });
  h.sink(submitSignal);
  await tick();
  assert.deepEqual(h.forwarded, [submitSignal]);
});

await check("with no draft handler, the sink is the original handler itself", async () => {
  const on = (_s: RecipeStep) => {};
  assert.equal(draftAwareHumanSink({ readCurrentPageText: async () => "" }, on), on);
  assert.equal(draftAwareHumanSink({}, on, () => {}), on);
});

if (failures) { console.error(`\n${failures} draftAwareHumanSink check(s) failed`); process.exit(1); }
console.log("\ndraftAwareHumanSink: all checks passed");
process.exit(0);
