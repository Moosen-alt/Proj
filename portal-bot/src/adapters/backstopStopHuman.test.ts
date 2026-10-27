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
//   4. a person's own document submit went, then an abort on the page it led to: not a failure;
//   5. a person's input AFTER the hand-over whose request was still held (their own payment click:
//      rule 1 never lifts): not a failure, and never "your click before the hand-over was held".
//   8. (round 4) personFilingShapedRequestAfter(at) — the one predicate the capture's commit/held
//      split and the review step's wording read: a main-frame document request, or a fetch/XHR to a
//      submit/payment URL, after the click, never a GET and never a beacon; off the handed-over
//      backstop only (cases 6-7 are allocated to later commits of this round).
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

// The backstop's record of a person's request (#333 round 4: stamped with when it went, its method,
// its resource type and the page that sent it).
type HumanRequest = { where: string; document: boolean; abortsBefore: number; at?: number; method?: string; resourceType?: string; page?: unknown };
interface Internals {
  backstop: unknown; handedOverBackstop: unknown; page: unknown; reviewHandoffNotes: string[]; backstopStop(): string;
  personFilingShapedRequestAfter?: (at: number) => boolean;
}
// The run's page (a sentinel object): the page the backstop's record names for the run's own requests.
const RUN_PAGE = {};
// backstopStop is read WHILE the run holds the page (runAll, before its finally lets the backstop go),
// so these cases set `backstop`.
const stopFor = (aborts: BackstopAbort[], humanRequests: HumanRequest[]): { stop: string; notes: string[] } => {
  const adapter = new RecipeAdapter(recipe, {}, {}, {}) as unknown as Internals;
  adapter.page = RUN_PAGE;
  adapter.backstop = { aborts, humanRequests };
  const stop = adapter.backstopStop();
  return { stop, notes: [...adapter.reviewHandoffNotes] };
};
// What the run reads WHEN IT REPORTS (stopAtReview): fillApplication's finally has already let the
// backstop go (this.backstop is null), so only the handed-over backstop's record is there. `backstop`
// stays null here on purpose: a reader that looks at this.backstop finds nothing and fails these cases.
const atReportTime = (aborts: BackstopAbort[], humanRequests: HumanRequest[]): Internals => {
  const adapter = new RecipeAdapter(recipe, {}, {}, {}) as unknown as Internals;
  adapter.page = RUN_PAGE;
  adapter.backstop = null;
  adapter.handedOverBackstop = { aborts, humanRequests };
  return adapter;
};

// humanInput: the backstop flagged a person's input; beforeHandOver: …and it came before the hand-over.
const filingDoc = (humanInput: boolean, beforeHandOver = humanInput): BackstopAbort => ({
  rule: "review-lockdown", method: "POST", where: "https://portal.example/apply/submit", why: "the run is at review", resourceType: "document",
  ...(humanInput ? { humanInput: true, ...(beforeHandOver ? { beforeHandOver: true } : {}) } : {}),
} as BackstopAbort);
const payment = (): BackstopAbort => ({
  rule: "filing-url", method: "POST", where: "https://portal.example/payment/charge", why: "a fee-payment endpoint — automation never pays", resourceType: "fetch", humanInput: true,
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
{
  const r = stopFor([payment()], []);
  check("5. the person's own payment click after the hand-over, held: not a failure", r.stop === "", r.stop);
  check("5. …and never 'your click before the hand-over was held back'", !r.notes.includes(HUMAN_CLICK_HELD_NOTE), JSON.stringify(r.notes));
}

console.log("\n#333 round 4 — did a FILING-SHAPED request of the person's go after the click? (personFilingShapedRequestAfter)");
{
  // A click at t=10. "Filing-shaped": a main-frame document request (a form submission), or a
  // fetch/XHR to a submit or payment URL — never a GET (a navigation is not evidence), and never a
  // beacon (resourceType "ping"), whatever its URL says ("/analytics/form_submit" matches the
  // filing-URL vocabulary). Read off the HANDED-OVER backstop only (this.backstop is null by now).
  const CLICK = 10;
  const probe = (r: HumanRequest): boolean | string => {
    const a = atReportTime([], [r]);
    if (typeof a.personFilingShapedRequestAfter !== "function") return "no personFilingShapedRequestAfter on the adapter";
    return a.personFilingShapedRequestAfter.call(a, CLICK);
  };
  const exists = typeof atReportTime([], []).personFilingShapedRequestAfter === "function";
  check("8. the adapter has the one predicate (personFilingShapedRequestAfter)", exists, "missing");
  if (exists) {
    const beacon = probe({ where: "https://portal.example/analytics/form_submit", document: false, abortsBefore: 0, method: "POST", resourceType: "ping", at: 10, page: RUN_PAGE });
    check("8. a form_submit BEACON (resourceType ping) after the click is not filing-shaped, whatever its URL", beacon === false, String(beacon));
    const fetchSubmit = probe({ where: "https://portal.example/apply/submit", document: false, abortsBefore: 0, method: "POST", resourceType: "fetch", at: 10, page: RUN_PAGE });
    check("8. a fetch POST to a submit URL at the click's own moment is filing-shaped", fetchSubmit === true, String(fetchSubmit));
    const before = probe({ where: "https://portal.example/apply/submit", document: false, abortsBefore: 0, method: "POST", resourceType: "fetch", at: 5, page: RUN_PAGE });
    check("8. …the same request BEFORE the click is not the click's", before === false, String(before));
    const doc = probe({ where: "https://portal.example/Cap/CapDetail.aspx", document: true, abortsBefore: 0, method: "POST", resourceType: "document", at: 10, page: RUN_PAGE });
    check("8. a main-frame document POST after the click (a form submission, any URL) is filing-shaped", doc === true, String(doc));
    const nav = probe({ where: "https://portal.example/MyApplications", document: true, abortsBefore: 0, method: "GET", resourceType: "document", at: 10, page: RUN_PAGE });
    check("8. a GET navigation after the click (\"My Applications\") is never filing-shaped", nav === false, String(nav));
    const xhrSave = probe({ where: "https://portal.example/api/SaveField", document: false, abortsBefore: 0, method: "POST", resourceType: "xhr", at: 10, page: RUN_PAGE });
    check("8. an XHR POST to a URL that is not a submit or payment URL is not filing-shaped", xhrSave === false, String(xhrSave));
    const live = new RecipeAdapter(recipe, {}, {}, {}) as unknown as Internals;
    live.page = RUN_PAGE;
    live.backstop = { aborts: [], humanRequests: [{ where: "https://portal.example/apply/submit", document: true, abortsBefore: 0, method: "POST", resourceType: "document", at: 10, page: RUN_PAGE }] };
    live.handedOverBackstop = null;
    const offLive = live.personFilingShapedRequestAfter!.call(live, CLICK);
    check("8. it reads the HANDED-OVER backstop's record only (never this.backstop): no hand-over, nothing", offLive === false, String(offLive));
  }
}

if (failures) { console.error(`\n${failures}/${total} backstopStopHuman.test check(s) FAILED.`); process.exit(1); }
console.log(`\nAll ${total}/${total} backstopStopHuman.test checks passed.`);
process.exit(0);
