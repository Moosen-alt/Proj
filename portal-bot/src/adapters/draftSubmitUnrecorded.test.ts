// THE STAMPED DRAFT CLICK REFUSES AFTER AN UNRECORDED WRITE, EVEN ONE THAT THREW (#362).
//
// The CI-run twin of draftSubmitFilled.dom.smoke (which needs a real Chromium). A gap-fill write
// is recorded BEFORE it is applied, so a select that took the answer and then threw (a re-render, a
// detached node, a timeout after the change event) still counts as written: the stamped
// draft-creating Submit is refused as a review stop, and the control is named. A page that cannot
// be read for the check refuses too (fail closed).
//
//   npx tsx portal-bot/src/adapters/draftSubmitUnrecorded.test.ts
import assert from "node:assert/strict";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter, draftPickStopTell } from "./recipeAdapter";
import { draftTenantKey, type DraftCreatingStamp } from "../draftSubmitGate";
import type { LearnPlanRequest, LearnPlanResponse, RawField } from "./autoLearnAdapter";

let failures = 0;
const check = async (label: string, fn: () => Promise<void> | void): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

const URL_NOW = "http://127.0.0.1/m/unit/part1";
const AGREE = "Do you agree to the terms of the Interconnection Agreement?";
const submit = { action: "click", selector: { css: "#btnSubmit", text: "Submit" }, note: "final submit | creates a draft, not the filing (#302)" } as unknown as RecipeStep;
const recipe = {
  id: "draft-unit", scopeType: "utility", profileKey: "wa||twopart", state: "WA", ahj: "", utility: "Two-Part Utility",
  portalPlatform: "fixture", portalUrl: URL_NOW, status: "complete", version: 1, createdBy: "test", createdAt: "", updatedAt: "", notes: "",
  steps: [{ action: "stopForReview" } as unknown as RecipeStep, submit],
} as PortalRecipe;
const stamp: DraftCreatingStamp = { stepIndex: 1, tenantKey: draftTenantKey(URL_NOW), label: "Submit", healedAt: "2026-10-16T00:00:00.000Z" };

// A page double: one required Yes/No select the planner is offered. Its selectOption WRITES and then
// throws. Every click is recorded (none may happen). evaluate: undefined, or a throw.
function fakePage(evaluate: () => Promise<unknown>) {
  const writes: string[] = [];
  const clicks: string[] = [];
  const raws: RawField[] = [{ label: AGREE, fieldType: "select", options: ["Select…", "Yes", "No"], id: "agree", required: true } as RawField];
  const loc = (key: string) => {
    const self = {
      first: () => self, nth: () => self, last: () => self, filter: () => self, locator: () => self,
      count: async () => 1,
      inputValue: async () => "",
      isChecked: async () => false,
      isVisible: async () => true,
      textContent: async () => key,
      innerText: async () => key,
      getAttribute: async () => null,
      selectOption: async (v: unknown) => { writes.push(`${key}=${String(v)}`); throw new Error("element was detached from the DOM after the change"); },
      fill: async (v: string) => { writes.push(`${key}=${v}`); },
      check: async () => { writes.push(`${key}=checked`); },
      click: async () => { clicks.push(key); },
      blur: async () => undefined,
      waitFor: async () => undefined,
    };
    return self;
  };
  const page = {
    $$eval: async () => raws,
    $: async () => null,
    $$: async () => [],
    evaluate,
    url: () => URL_NOW,
    title: async () => "Interconnection Application Part 1",
    frames: () => [],
    mainFrame: () => null,
    waitForTimeout: async () => undefined,
    waitForLoadState: async () => undefined,
    locator: (css: string) => loc(css),
    getByLabel: (label: string) => loc(label),
    getByRole: (_role: string, o?: { name?: string }) => loc(String(o?.name ?? "")),
    // A text search finds nothing (a regex is the challenge scan): so the double reads as a page with
    // no captcha, and a click would get past every check before the stamped control's own label.
    getByText: (t: string | RegExp) => (typeof t === "string" ? loc(t) : { ...loc(String(t)), count: async () => 0, isVisible: async () => false }),
    getByPlaceholder: (t: string) => loc(t),
    getByTestId: (t: string) => loc(t),
  };
  return { page, writes, clicks };
}
const yesPlanner = async (req: LearnPlanRequest): Promise<LearnPlanResponse> => ({
  fills: req.fields.map((f, i) => ({ selectorIndex: i, value: "Yes", f })).filter((x) => x.f.fieldType === "select").map(({ selectorIndex, value }) => ({ selectorIndex, value })),
  atReview: false,
});

async function drive(evaluate: () => Promise<unknown>) {
  const adapter = new RecipeAdapter(recipe, {}, {}, { draftSubmitStamp: stamp });
  adapter.enableLlmGapFill(yesPlanner, {});
  const fake = fakePage(evaluate);
  (adapter as unknown as { page: unknown }).page = fake.page;
  const out = await (adapter as unknown as { clickDraftCreatingSubmit: (i: number) => Promise<{ kind: string; refusals?: string[] }> }).clickDraftCreatingSubmit(1);
  return { out, ...fake, notes: (adapter as unknown as { reviewHandoffNotes: string[] }).reviewHandoffNotes, tell: (adapter as unknown as { draftPickTell: string | null }).draftPickTell };
}

await check("MUST-STOP: a gap-fill select that wrote and then threw still refuses the stamped Submit, naming the control", async () => {
  const r = await drive(async () => undefined);
  assert.ok(r.writes.length >= 1 && r.writes[0].endsWith("=Yes"), `the write reached the page: ${JSON.stringify(r.writes)}`);
  assert.equal(r.out.kind, "refused", JSON.stringify(r.out));
  assert.ok((r.out.refusals ?? []).some((x) => /recorded steps never fill/.test(x) && x.includes("gap-fill: Do you agree")), JSON.stringify(r.out));
  assert.deepEqual(r.clicks, [], "nothing was clicked");
  assert.ok(r.notes.some((n) => /AUTOMATION PICKED ANSWERS/.test(n)), `the person is told: ${JSON.stringify(r.notes)}`);
  // ...and the stop message's first words (the run card) are set: one pick, counted once.
  assert.equal(r.tell, draftPickStopTell("Submit", [`gap-fill: ${AGREE}`]), String(r.tell));
});

await check("MUST-STOP: a page that throws on every read refuses the same way (fail closed)", async () => {
  const r = await drive(async () => { throw new Error("Execution context was destroyed"); });
  assert.equal(r.out.kind, "refused", JSON.stringify(r.out));
  assert.ok((r.out.refusals ?? []).some((x) => /recorded steps never fill/.test(x)), JSON.stringify(r.out));
  assert.deepEqual(r.clicks, [], "nothing was clicked");
});

// NOT VACUOUS: the same double with nothing picked gets PAST the pick check (and the challenge scan)
// and is refused only further on, at the stamped control's own label, which the double cannot read.
await check("CONTROL: with nothing picked the same page is not refused for picks, nor for a challenge", async () => {
  const adapter = new RecipeAdapter(recipe, {}, {}, { draftSubmitStamp: stamp });
  adapter.enableLlmGapFill(async () => ({ fills: [], atReview: false }), {});
  const fake = fakePage(async () => undefined);
  (adapter as unknown as { page: unknown }).page = fake.page;
  const out = await (adapter as unknown as { clickDraftCreatingSubmit: (i: number) => Promise<{ kind: string; refusals?: string[] }> }).clickDraftCreatingSubmit(1);
  assert.deepEqual(fake.writes, []);
  assert.equal(out.kind, "refused", JSON.stringify(out));
  assert.ok(!(out.refusals ?? []).some((x) => /recorded steps never fill|challenge/.test(x)), JSON.stringify(out));
  assert.ok((out.refusals ?? []).some((x) => /the control on the page reads/.test(x)), JSON.stringify(out));
});

console.log(failures === 0
  ? "\nAll draft-submit unrecorded-write checks passed."
  : `\n${failures} draft-submit unrecorded-write check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
