// #333 — WHICH ABORTS FAIL A RUN THAT HANDED THE REVIEW PAGE OVER (RecipeAdapter.backstopStop).
//
// The hand-over lets a person's own request past the review lockdown. What the run reports afterwards
// must still tell the page acting by itself from the person:
//   1. a person's click held back BEFORE the hand-over (abort flagged humanInput): not a failure, and
//      the run says plainly to click again;
//   2. a page script trying to file with no person's input: a failure, named;
//   3. a person's harmless click whose BACKGROUND request went (a same-origin fetch), then a page
//      script trying to file: still a failure — only a request that LEFT the page (the person's own
//      document submit or navigation) ends what the run answers for;
//   4. a person's own document submit went, then an abort on the page it led to: not a failure.
//
//   npx tsx portal-bot/src/adapters/backstopStopHuman.test.ts
import type { PortalRecipe } from "../../../shared/src/types";
import type { BackstopAbort } from "../filingBackstop";
import { RecipeAdapter, HUMAN_CLICK_HELD_NOTE } from "./recipeAdapter";

let failures = 0;
let total = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  total++;
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const recipe = {
  id: "backstop-stop-human", scopeType: "ahj", profileKey: "or|fernhollow|", state: "OR", ahj: "City of Fernhollow", utility: "",
  portalPlatform: "fixture", portalUrl: "http://127.0.0.1:9/review", status: "complete", version: 1, createdBy: "test", createdAt: "", updatedAt: "", notes: "",
  steps: [],
} as unknown as PortalRecipe;

type HumanRequest = { where: string; document: boolean; abortsBefore: number };
interface Internals { backstop: unknown; reviewHandoffNotes: string[]; backstopStop(): string }
const stopFor = (aborts: BackstopAbort[], humanRequests: HumanRequest[]): { stop: string; notes: string[] } => {
  const adapter = new RecipeAdapter(recipe, {}, {}, {}) as unknown as Internals;
  adapter.backstop = { aborts, humanRequests };
  const stop = adapter.backstopStop();
  return { stop, notes: [...adapter.reviewHandoffNotes] };
};

const filingDoc = (humanInput: boolean): BackstopAbort => ({
  rule: "review-lockdown", method: "POST", where: "https://portal.example/apply/submit", why: "the run is at review", resourceType: "document",
  ...(humanInput ? { humanInput: true } : {}),
} as BackstopAbort);

console.log("\n#333 backstopStop after the hand-over");
{
  const r = stopFor([filingDoc(true)], []);
  check("1. a person's click held back before the hand-over: the run is not failed", r.stop === "", r.stop);
  check("1. …and it says plainly to click again", r.notes.includes(HUMAN_CLICK_HELD_NOTE), JSON.stringify(r.notes));
}
{
  const r = stopFor([filingDoc(false)], []);
  check("2. a page script tries to file with no person's input: the run is stopped, named", /STOPPED BY THE NETWORK BACKSTOP/.test(r.stop), r.stop);
}
{
  const r = stopFor([filingDoc(false)], [{ where: "https://portal.example/api/track", document: false, abortsBefore: 0 }]);
  check("3. a person's harmless background request went, then a page script tries to file: still stopped",
    /STOPPED BY THE NETWORK BACKSTOP/.test(r.stop), `stop=${JSON.stringify(r.stop)}`);
}
{
  const r = stopFor([filingDoc(false)], [{ where: "https://portal.example/apply/submit", document: true, abortsBefore: 0 }]);
  check("4. the person's own document submit went, then an abort on the page it led to: not a failure", r.stop === "", r.stop);
}

if (failures) { console.error(`\n${failures}/${total} backstopStopHuman.test check(s) FAILED.`); process.exit(1); }
console.log(`\nAll ${total}/${total} backstopStopHuman.test checks passed.`);
process.exit(0);
