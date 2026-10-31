// #333 — WHICH ABORTS FAIL A RUN THAT HANDED THE REVIEW PAGE OVER (RecipeAdapter.backstopStop).
//
// The hand-over lets a person's own request past the review lockdown. What the run reports afterwards
// must still tell the page acting by itself from the person:
//   1. a person's click held back BEFORE the hand-over (abort flagged humanInput): not a failure, and
//      the run says plainly to click again; 1b (round 5): only on a run that handed the page over —
//      after a REFUSED hand-over the same flagged click never says "click submit again";
//   2. a page script trying to file with no person's input: a failure, named;
//   3. a person's harmless click whose BACKGROUND request went (a same-origin fetch), then a page
//      script trying to file: still a failure — only a request that LEFT the page (the person's own
//      document submit or navigation) ends what the run answers for;
//   4. a person's own document submit went, then an abort on the page it led to: not a failure;
//   5. a person's input AFTER the hand-over whose request was still held (their own payment click:
//      rule 1 never lifts): not a failure, and never "your click before the hand-over was held".
//   6. (Helm nit :97) a person's document request from ANOTHER page (a popup's contact form) went,
//      then a page script tries to file on the handed-over page: still a failure — only the
//      HANDED-OVER page's own document request ends what the run answers for (case 4's entry names
//      the run's page). Red while firstHumanDocument took a document request from any page.
//   8. (round 4) personFilingShapedRequestAfter(at) — the one predicate the capture's commit/held
//      split and the review step's wording read: a main-frame document request, or a fetch/XHR to a
//      submit/payment URL, after the click, never a GET and never a beacon; off the handed-over
//      backstop only, and (round 5) from the run's own page only, never a popup's.
//   7. (round 4, Helm Blocking 2) followUpHeldOnErrorPage — the person's document submit went, a stopping
//      abort followed, and the window shows Chromium's error page: true; on a portal page, or read off
//      this.backstop instead of the handed-over backstop: false. Red before: no such predicate.
//  10. (round 4, Helm Blocking 2) stopAtReview at report time (backstop null): a held payment after a
//      validate fetch gets ONE note (the payment's), never PERSON_REQUEST_WENT_NOTE; a pending click with
//      an unflagged stopping abort after it reads as held, never "saw no request go". Red before: the
//      validate made it PERSON_REQUEST_WENT_NOTE and no payment note; the pending click had no note. The
//      no-sighting case (PERSON_REQUEST_WENT_NOTE still said) is a GUARD, green before by design; its
//      kill: push PERSON_REQUEST_WENT_NOTE only with a sighting.
//   9. (round 4) NOT_HANDED_OVER_NOTE fits one progress line: at most 200 characters, and a progress
//      sink receives the constant whole (progress() cuts at 200).
//
//   npx tsx portal-bot/src/adapters/backstopStopHuman.test.ts
import type { PortalRecipe } from "../../../shared/src/types";
import type { BackstopAbort } from "../filingBackstop";
import { RecipeAdapter, HUMAN_CLICK_HELD_NOTE, HUMAN_SUBMITTED_NOTE, NOT_HANDED_OVER_NOTE, PERSON_REQUEST_WENT_NOTE } from "./recipeAdapter";

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
// so these cases set `backstop`. They read a run that handed the page over (handedOverBackstop is the
// same backstop), unless `handedOver: false` (a refused hand-over: case 1b).
const stopFor = (aborts: BackstopAbort[], humanRequests: HumanRequest[], opts: { handedOver?: boolean } = {}): { stop: string; notes: string[] } => {
  const adapter = new RecipeAdapter(recipe, {}, {}, {}) as unknown as Internals;
  adapter.page = RUN_PAGE;
  adapter.backstop = { aborts, humanRequests };
  adapter.handedOverBackstop = opts.handedOver === false ? null : adapter.backstop;
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
  // Round 5 (Helm item 1): the SAME flagged, held click on a run whose hand-over was REFUSED (the watch
  // was armed, then the run refused to hand over: B14's shape, or a half-failed arm). That run never let
  // go of the page, so "click submit again" would be false. Red before: heldHumanClick read only the
  // abort's flags.
  const r = stopFor([filingDoc(true)], [], { handedOver: false });
  check("1b. a flagged held click on a run that did NOT hand the page over: never 'click submit again'", !r.notes.includes(HUMAN_CLICK_HELD_NOTE), JSON.stringify(r.notes));
}
{
  const r = stopFor([filingDoc(false)], []);
  check("2. a page script tries to file with no person's input: the run is stopped, named", /STOPPED BY THE NETWORK BACKSTOP/.test(r.stop), r.stop);
}
{
  const r = stopFor([filingDoc(false)], [{ where: "https://portal.example/api/track", document: false, abortsBefore: 0, page: RUN_PAGE }]);
  check("3. a person's harmless background request went, then a page script tries to file: still stopped",
    /STOPPED BY THE NETWORK BACKSTOP/.test(r.stop), `stop=${JSON.stringify(r.stop)}`);
}
{
  const r = stopFor([filingDoc(false)], [{ where: "https://portal.example/apply/submit", document: true, abortsBefore: 0, page: RUN_PAGE }]);
  check("4. the person's own document submit went, then an abort on the page it led to: not a failure", r.stop === "", r.stop);
}
{
  // Helm nit :97 — the excuse is the HANDED-OVER page's own document request only. A popup's contact
  // form (another Page object than the run's) that the person sent does not excuse a page script's
  // filing on the review page afterwards.
  const POPUP = {};
  const r = stopFor([filingDoc(false)], [{ where: "https://portal.example/contact/send", document: true, abortsBefore: 0, page: POPUP }]);
  check("6. a person's document request from ANOTHER page (a popup's contact form) went, then a page script files on the handed-over page: still stopped",
    /STOPPED BY THE NETWORK BACKSTOP/.test(r.stop), `stop=${JSON.stringify(r.stop)}`);
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
    // Round 5 (Helm item 2): the run's own page only. A popup (another Page) sending its contact form
    // after the click — a document POST, filing-shaped by every other measure — is not the person's
    // filing on the handed-over page. Red before: the predicate read every page's requests.
    const popupDoc = probe({ where: "https://portal.example/contact/send", document: true, abortsBefore: 0, method: "POST", resourceType: "document", at: 10, page: {} });
    check("8. a POPUP's document POST after the click is not the person's filing on the run's page", popupDoc === false, String(popupDoc));
    const live = new RecipeAdapter(recipe, {}, {}, {}) as unknown as Internals;
    live.page = RUN_PAGE;
    live.backstop = { aborts: [], humanRequests: [{ where: "https://portal.example/apply/submit", document: true, abortsBefore: 0, method: "POST", resourceType: "document", at: 10, page: RUN_PAGE }] };
    live.handedOverBackstop = null;
    const offLive = live.personFilingShapedRequestAfter!.call(live, CLICK);
    check("8. it reads the HANDED-OVER backstop's record only (never this.backstop): no hand-over, nothing", offLive === false, String(offLive));
  }
}

console.log("\n#333 round 4 — the person's submit went, then the next page's request was held, on an error page (followUpHeldOnErrorPage)");
{
  // Helm Blocking 2: "When a stopping abort follows the person's document request and the window is on
  // Chromium's error page, say the follow-up request was held." Read at REPORT time: off the
  // handed-over backstop (this.backstop is null by then) and the page's address now.
  const ERR_PAGE = { url: () => "chrome-error://chromewebdata/" };
  const OK_PAGE = { url: () => "https://portal.example/Cap/Interstitial.aspx" };
  const probe = (page: unknown, liveOnly = false): boolean | string => {
    const a = atReportTime([{ ...filingDoc(false), at: 20 } as BackstopAbort],
      [{ where: "https://portal.example/apply/submit", document: true, abortsBefore: 0, method: "POST", resourceType: "document", at: 10, page }]);
    a.page = page;
    if (liveOnly) { a.backstop = a.handedOverBackstop; a.handedOverBackstop = null; }
    const fn = (a as unknown as { followUpHeldOnErrorPage?: () => boolean }).followUpHeldOnErrorPage;
    return typeof fn === "function" ? fn.call(a) : "no followUpHeldOnErrorPage on the adapter";
  };
  const onError = probe(ERR_PAGE);
  check("7. the person's document submit went, then a stopping abort, and the window shows chrome-error: the follow-up was held", onError === true, String(onError));
  const onPage = probe(OK_PAGE);
  check("7. …the same record with the window on a portal page: not this case", onPage === false, String(onPage));
  const live = probe(ERR_PAGE, true);
  check("7. …read off the HANDED-OVER backstop only (never this.backstop)", live === false, String(live));
}

console.log("\n#333 round 4 — what the review step says about the person's click, at report time (stopAtReview)");
{
  // Helm Blocking 2: a held click never also gets a note saying the filing went, and "held" is any
  // stopping abort after the click, flagged as the person's or not (the fill step already says STOPPED
  // BY THE NETWORK BACKSTOP; the review step must not say it saw no request). At report time: backstop
  // null, the handed-over backstop's record, the page a fake with no DOM (no page read).
  const PAGE = { url: () => "https://portal.example/review" };
  type Sighting = { label?: string; at: number; abortsBefore: number; requestsBefore: number; personInput: boolean | undefined };
  const report = async (aborts: BackstopAbort[], humanRequests: HumanRequest[], s: { held?: Sighting; pending?: Sighting }): Promise<{ notes: string[]; all: string; data: Record<string, unknown> }> => {
    const a = atReportTime(aborts, humanRequests) as unknown as Internals & Record<string, unknown> & { stopAtReview(): Promise<{ message?: string; data?: Record<string, unknown> }> };
    a.page = PAGE;
    if (s.held) a.heldHumanClickAfterHandOver = s.held;
    if (s.pending) a.pendingHumanClick = s.pending;
    const r = await a.stopAtReview();
    const data = r.data ?? {};
    return { notes: (data.reviewHandoffNotes as string[] | undefined) ?? [], all: JSON.stringify({ m: r.message, d: data }), data };
  };
  const click = (at: number): Sighting => ({ label: "Submit Application", at, abortsBefore: 0, requestsBefore: 0, personInput: true });
  const validate: HumanRequest = { where: "https://portal.example/api/validate", document: false, abortsBefore: 0, method: "POST", resourceType: "fetch", at: 12, page: PAGE };
  {
    const r = await report([{ ...payment(), at: 13 } as BackstopAbort], [validate], { held: click(10) });
    check("10. a validate fetch went, then the person's payment was held: exactly one note, the payment's",
      r.notes.filter((n) => /\/payment\//.test(n)).length === 1, JSON.stringify(r.notes));
    check("10. …never PERSON_REQUEST_WENT_NOTE beside it, never 'has been filed'",
      !r.notes.includes(PERSON_REQUEST_WENT_NOTE) && !r.all.includes("has been filed") && !r.notes.includes(HUMAN_SUBMITTED_NOTE) && r.data.humanSubmittedInReviewWindow !== true, JSON.stringify(r.notes));
  }
  {
    // The judge may still be inside its settle when the run reports: a pending click with an UNFLAGGED
    // stopping abort after it is held all the same.
    const r = await report([{ ...filingDoc(false), at: 11 } as BackstopAbort], [], { pending: click(10) });
    check("10. a pending click with an unflagged stopping abort after it reads as held, never 'saw no request go'",
      r.notes.some((n) => n.startsWith('YOUR CLICK ON "Submit Application"') && /WAS HELD BACK/.test(n)) && !/saw no request go/.test(r.all), JSON.stringify(r.notes));
  }
  {
    // No sighting at all: the request that went is still said plainly (B5-B7's shape).
    const r = await report([], [validate], {});
    check("10. no sighting, a request of the person's went: PERSON_REQUEST_WENT_NOTE (GUARD)", r.notes.includes(PERSON_REQUEST_WENT_NOTE), JSON.stringify(r.notes));
  }
}

console.log("\n#333 round 4 — the 'could not hand over' note fits one progress line (NOT_HANDED_OVER_NOTE)");
{
  // progress() cuts every message at 200 characters, so a longer note reached the dashboard
  // truncated ("…an earlier click can be held back, and n"). The ONE constant must fit whole: the
  // hand-off notes and the progress line carry the same text, with no second short version.
  check("9. NOT_HANDED_OVER_NOTE is at most 200 characters", NOT_HANDED_OVER_NOTE.length <= 200, `length=${NOT_HANDED_OVER_NOTE.length}`);
  const messages: string[] = [];
  const adapter = new RecipeAdapter(recipe, {}, {}, { onProgress: (p) => { messages.push(p.message); } }) as unknown as {
    progress(phase: "wait", message: string, elapsedMs: number): void;
  };
  adapter.progress("wait", NOT_HANDED_OVER_NOTE, 0);
  check("9. …and a progress sink receives it whole", messages.includes(NOT_HANDED_OVER_NOTE), JSON.stringify(messages));
}

if (failures) { console.error(`\n${failures}/${total} backstopStopHuman.test check(s) FAILED.`); process.exit(1); }
console.log(`\nAll ${total}/${total} backstopStopHuman.test checks passed.`);
process.exit(0);
