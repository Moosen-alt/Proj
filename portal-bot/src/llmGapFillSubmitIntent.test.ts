// THE GAP-FILL NEVER ANSWERS A CONTROL THAT READS AS SUBMITTING (#362).
//
// The gap-fill prompt says a required Yes/No MUST be answered. On a page where the required dropdown
// reads "Are you ready to submit your Net Metering (kWh) application?", a planner obeying it answered
// Yes and the page's Submit then FILED, with no approval and no PORTAL_ALLOW_FINAL_SUBMIT (found
// re-checking PR #353 against a stub planner). Wherever gap-fill runs (gapFillCurrentPage is its one
// door), a control whose label reads as submit intent (portalSafety isSubmitIntent) is never offered
// to the planner and never written, and an answer that itself reads as submitting is never typed.
// Left blank, a required one is still reported for a person.
//
//   npx tsx portal-bot/src/llmGapFillSubmitIntent.test.ts
import assert from "node:assert/strict";
import { gapFillCurrentPage, gapFillMayAnswer } from "./llmGapFill";
import type { LearnPlanRequest, LearnPlanResponse, RawField } from "./adapters/autoLearnAdapter";

let failures = 0;
const check = async (label: string, fn: () => Promise<void> | void): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

const READY = "Are you ready to submit your Net Metering (kWh) application?";
const AGREE = "Do you agree to the terms of the Net Metering (kWh) Agreement?";

// A page double: $$eval returns the raw fields; every locator, however it was built, resolves by the
// key it was asked for, and every write is recorded against that key. Values start empty.
function fakePage(raws: RawField[]) {
  const writes: Array<{ key: string; value: string }> = [];
  const loc = (key: string) => {
    const self = {
      first: () => self,
      nth: () => self,
      count: async () => 1,
      inputValue: async () => "",
      isChecked: async () => false,
      selectOption: async (v: unknown) => { writes.push({ key, value: typeof v === "string" ? v : JSON.stringify(v) }); },
      fill: async (v: string) => { writes.push({ key, value: v }); },
      check: async () => { writes.push({ key, value: "checked" }); },
      uncheck: async () => { writes.push({ key, value: "unchecked" }); },
      blur: async () => undefined,
    };
    return self;
  };
  const page = {
    $$eval: async () => raws,
    evaluate: async () => undefined,
    url: () => "http://127.0.0.1/part1",
    title: async () => "Interconnection Application Part 1",
    locator: (css: string) => (css === "body" ? { innerText: async () => "Interconnection Application Part 1" } : loc(css)),
    getByLabel: (label: string) => loc(label),
    getByRole: (_role: string, o?: { name?: string }) => loc(String(o?.name ?? "")),
    getByText: (t: string) => loc(t),
    getByPlaceholder: (t: string) => loc(t),
    getByTestId: (t: string) => loc(t),
  };
  return { page, writes };
}

const yesNo = (id: string, label: string, required = true): RawField =>
  ({ label, fieldType: "select", options: ["Select…", "Yes", "No"], id, required } as RawField);

// The stub planner does what the prompt says: every Yes/No it is offered is answered Yes.
function yesPlanner() {
  const offered: string[][] = [];
  const planner = async (req: LearnPlanRequest): Promise<LearnPlanResponse> => {
    offered.push(req.fields.map((f) => String(f.label ?? "")));
    return { fills: req.fields.map((f, i) => ({ selectorIndex: i, value: "Yes" })).filter((_, i) => req.fields[i].fieldType === "select"), atReview: false };
  };
  return { planner, offered };
}

await check("MUST EXCLUDE: a required control whose label reads as submit intent is never offered or written", async () => {
  const { page, writes } = fakePage([yesNo("ready", READY), yesNo("agree", AGREE)]);
  const { planner, offered } = yesPlanner();
  const out = await gapFillCurrentPage(page, planner, {});
  assert.equal(offered.length, 1, "the planner was asked once (the page has another required gap)");
  assert.ok(!offered[0].some((l) => l.includes("ready to submit")), `offered: ${JSON.stringify(offered[0])}`);
  assert.ok(!out.filled.some((l) => l.includes("ready to submit")) && !out.attempted.some((l) => l.includes("ready to submit")), `filled: ${JSON.stringify(out.filled)}`);
  assert.equal(writes.length, 1, `writes: ${JSON.stringify(writes)}`);
  assert.ok(out.filled.some((l) => l.includes("agree to the terms")), "the other required gap is still answered");
});

await check("MUST EXCLUDE: a page whose only required gap is the submit-intent control spends no planner call and writes nothing", async () => {
  const { page, writes } = fakePage([yesNo("ready", READY)]);
  const { planner, offered } = yesPlanner();
  const out = await gapFillCurrentPage(page, planner, {});
  assert.equal(offered.length, 0, `offered: ${JSON.stringify(offered)}`);
  assert.equal(writes.length, 0, `writes: ${JSON.stringify(writes)}`);
  assert.ok(out.reportedMissing.includes(READY), `the required blank is still reported for a person: ${JSON.stringify(out)}`);
});

await check("MUST EXCLUDE: an answer that reads as submitting is never typed, even on an innocent label", async () => {
  const { page, writes } = fakePage([{ label: "Next step", fieldType: "select", options: ["Select…", "Save draft", "Submit application"], id: "next", required: true } as RawField]);
  const planner = async (): Promise<LearnPlanResponse> => ({ fills: [{ selectorIndex: 0, value: "Submit application" }], atReview: false });
  const out = await gapFillCurrentPage(page, planner, {});
  assert.equal(writes.length, 0, `writes: ${JSON.stringify(writes)}`);
  assert.deepEqual(out.attempted, []);
});

await check("MUST PASS: the predicate is portalSafety's reading — submit wording out, ordinary wording in", () => {
  assert.equal(gapFillMayAnswer(READY), false);
  assert.equal(gapFillMayAnswer("Finalize your application"), false);
  assert.equal(gapFillMayAnswer("Resubmit"), false);
  assert.equal(gapFillMayAnswer(AGREE, "Yes"), true);
  assert.equal(gapFillMayAnswer("Submittal Type", "Residential"), true);
  assert.equal(gapFillMayAnswer("Next step", "Submit application"), false);
});

await check("MUST PASS: every write the gap-fill tries is reported in attempted (what the draft click reads)", async () => {
  const { page } = fakePage([yesNo("agree", AGREE)]);
  const { planner } = yesPlanner();
  const out = await gapFillCurrentPage(page, planner, {});
  assert.deepEqual(out.attempted, [AGREE]);
  assert.deepEqual(out.filled, [AGREE]);
});

console.log(failures === 0
  ? "\nAll gap-fill submit-intent checks passed."
  : `\n${failures} gap-fill submit-intent check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
