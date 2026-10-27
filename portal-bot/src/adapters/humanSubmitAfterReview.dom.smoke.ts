// #333 — THE PERSON'S OWN SUBMIT AT THE REVIEW PAGE GOES THROUGH; AUTOMATION'S STILL NEVER DOES.
//
// Live 2026-10-14 (Lincoln County, Oregon ePermitting): a replay stopped at review and, in its last
// seconds, the owner clicked the portal's submit in the open window. The review-page lockdown aborted
// the owner's own click, the run read failed, and the filing (made on the second click) was never
// captured. Owner ruling: "we'll have to allow that in the future".
//
// A local fixture portal on 127.0.0.1 (never a real one); every non-GET request it receives is
// counted, so "reached" / "0 POSTs" is what the SERVER saw. A PERSON'S click is simulated with a raw
// page.mouse click (a trusted event); AUTOMATION'S click goes through the backstop's fence
// (withAutomationInput), the way every input the run makes does. Both arrive in the page as trusted
// events — the fence and the replay's own input refusal are what tell them apart.
//
//   [A] THE BACKSTOP, DIRECTLY (lockReview → watchHumanInput → handOverToHuman):
//     A1  a person's click after the hand-over: their form POST (a filing URL) reaches the portal.
//     A2  automation's fenced click after the hand-over: aborted by the lockdown.
//     A3  a page script's POST after the hand-over, no input: aborted.
//     A4  a person's click on the review page, and a POPUP posts within the 4 s window: aborted.
//     A5  a payment URL right after a person's click: aborted (payment is never lifted; rule 1 is only
//         as wide as PAY_FEE_URL).
//     A5b-A5e (Helm Should-fix 13) a person's click whose fetch goes to a processor endpoint rule 1 did
//         not know — A5b /xml/v1/request.api (Authorize.net), A5c /api/v1/transactions (Point & Pay),
//         A5d /api/fees/settle (a portal's own fee settle), A5e /gps/user/42/submit (GovPayNet) — within
//         the 4 s window: aborted by rule 1 (a fee-payment abort, flagged as the person's, never in
//         humanRequests). Loopback paths only, never the real processor hosts. Red while PAY_FEE_URL
//         lacked these tokens: the person's verdict lifted rules 2 and 4 and the POST reached the portal.
//     A6  an input 1 s BEFORE the hand-over, a script POST 1 s after it: aborted (not carried over).
//     A7  a person's click BEFORE the hand-over: aborted, flagged humanInput (the run says so).
//     A8  a person's click while a dismisser window is open: aborted.
//     A9  the input watch never armed: handOverToHuman refuses, a person's click is aborted.
//   [A, #370 × #333] A REDIRECT HOP CARRIES ITS FIRST LEG'S PERSON VERDICT (Helm's merge-order asks):
//     A10 the person's submit is answered 307 → /apply/submit only after 4.6 s (past HUMAN_INPUT_MS):
//         the hop still reaches it; the person's request is recorded once (the first leg).
//     A11 the person's submit is answered 307 → /payment/charge after 4.6 s: refused (payment first,
//         always) — a GUARD PIN, green before by design (rule 1 already precedes the verdict); its
//         kill: move the isPayRequestUrl check below rule 2, or let `via.human` short-circuit ahead
//         of it. The refusal is flagged humanInput (the first leg's verdict, carried): that check
//         fails while the abort flag is judged live at the hop.
//     A12 handed over but not yet locked (the drain's moment): the run's own save goes out, the
//         person touches the page, THEN its 307 → /SubmitApplication arrives: the hop is refused
//         (the first leg was not the person's), is not in humanRequests, and is NOT flagged
//         humanInput (the run fails by name, as on main).
//   [A, Helm Should-fix 6] THE FENCE HOLDS ONLY WHILE THE RUN'S INPUT IS IN FLIGHT (A2 is its pin):
//     A13 a fenced touch that sends nothing, then a person's click 100 ms later: their form POST
//         reaches the portal, recorded as theirs, no stopping abort. Red while the fence kept a
//         1.5 s grace after each fenced input (the person's pointerdown was dropped, the lockdown
//         aborted their filing).
//   [A, Helm Should-fix 2] AN INPUT COVERS ONLY THE DOCUMENT THAT SAW IT (each main-frame navigation
//   request is stamped; a request is judged against the stamp BEFORE it, so A1's own form POST — itself
//   a navigation — still goes). That the read precedes the stamp is held by a GUARD set, green before
//   by design; its kill Ka: the stamp is written before navBefore is read (swap the two lines at the
//   handler's top). Measured at 0c853c76, Ka reddens 20/100: A1 x3, A7 (the abort flagged humanInput),
//   A10 x2, A11 x2 (including "the refused hop is flagged as the person's", the pin this ask shares
//   with g1's hop verdict), A13 x2, B1 x3, B1b x2, B2 x2, B10 x3. B5-B7 stay green under Ka: they take
//   the no-navigation path, green by construction, not guards of the ordering:
//     A14 a person's GET link off the review page, then the next document's parse-time filing POST
//         (inside the 4 s window of the click): aborted by the filing-URL rule, 0 POSTs, not in
//         humanRequests, and the abort is NOT flagged humanInput (the flag is judged against the same
//         stamp, so the run fails by name as on main for a page script's POST). Red while the 4 s window survived the navigation (the POST reached the
//         portal and was recorded as the person's). The cost: an interstitial that auto-posts the
//         filing after the person's own click is held, as on main.
//   [B] THE REPLAY (RecipeAdapter, guided manual: no approval, the flagged final submit never clicked):
//     B1  the person clicks the portal's submit the moment the run hands the page over: the POST
//         reaches the portal, the run is NOT failed, and it reports the person's submit; the
//         runner's submit watch is handed that submit exactly once (the capture starts) and
//         HUMAN_SUBMITTED_NOTE is in the hand-off (Helm Should-fix 11). Those two checks are GUARD
//         checks, green before by design (nothing read them). Kills (measured at 5d785555): the
//         submit watch's callback reports nothing (noteHumanSubmit never called) reddens both, B1's
//         "reports the person's submit" and B1b's report + note (5/96) while the POST still goes and
//         r.ok holds; K1b (handOverReviewPage returns false) reddens B1 x5, B1b x4, B2's guard, B3,
//         B5 x2, B6 x2, B7 x3, B10 x2 (20/96).
//     B1b the person clicks the portal's submit right after the run LOCKS review (after the hand-over
//         and the drain; the click lands after the lock, not before "the page is yours": progress()
//         is synchronous and the click first awaits a bounding box): one POST, the run is NOT
//         failed, the submit reported from the review window and handed on once, HUMAN_SUBMITTED_NOTE
//         in the hand-off, never "YOUR CLICK WAS HELD BACK". GUARD pin, green before by design on
//         this branch (it fails on main BY NAME); kill K1b (the replay never hands over) reddens it.
//     B2  the person clicks BEFORE the hand-over: held, 0 POSTs, the run is not failed and says
//         "click again" (HUMAN_CLICK_HELD_NOTE).
//     B3  automation tries to click after the hand-over: the replay refuses its own input
//         (inputsClosed), 0 POSTs.
//     B4  an approved run (autoSubmit) is never handed over (the watch is never armed).
//   [B, skeptic rounds 2-3] — ONLY THE CLICK DETECTOR SAYS "THE PERSON SUBMITTED" (main's detector, armed
//   at the hand-over); what a page reads never does. A request the person sent that went through is
//   said plainly instead (PERSON_REQUEST_WENT_NOTE: "if it was the submit, enter its number"):
//     B5  a person's request, then "My Records" (a list headed "Record Number" with ANOTHER
//         application's number): not a filing; the request is said plainly.
//     B6  a fetch submit + location.href to the completion page under a label the click detector does
//         not know: never "stopped before review", never "click submit manually"; said plainly.
//     B7  the person's fetch submit WHILE the run drains its own save: recorded as theirs (never the
//         drain's own-save exemption), never "stopped before review"; said plainly.
//     B8  an older record ("Your application has been received") opened after the run let go: not
//         this run's filing.
//     B9  the person's payment click after the hand-over: aborted (automation never pays, and the
//         run still holds the page), the run is not failed, and never "your click before the
//         hand-over was held back".
//     B2 also: a held click's error page is not "where the run stopped".
//   [B, Helm Should-fix 4] A RUN THAT STOPPED BEFORE REVIEW NEVER READS AS STAGED, AND ONLY A CALLER
//   THAT WATCHES FOR THE SUBMIT IS HANDED THE PAGE (index.ts passes handOverReview only when the
//   caller gives onSubmitCaptured; replay() below passes it unless `handOver: false`):
//     B10 the replay ends on "Step 2: Attachments" (not the review page; neither its text nor its URL
//         reads as review, and "Continue Application" is no final submit, so no click detector fires)
//         and the person clicks Continue the moment the page is theirs. The fixture answers that POST
//         with its review page (a real navigation, so the pin does not rest on the request-time
//         document stamp alone): 1 POST, the run pauses stopped_before_review, the fill, the progress
//         line and the review step all say STOPPED on "Step 2: Attachments" — NOT the review page,
//         and none says "staged the review screen" / "stopped at review". Red before: the person's
//         Continue read as "moved on" from a staged review page (ok, no pause reason).
//     B11 a caller that passes no onSubmitCaptured (the learn self-test's shape: no handOverReview)
//         and a person's click right after the lock: never handed over (the watch never armed, no
//         "the page is yours"), 0 POSTs, the run fails by name (STOPPED BY THE NETWORK BACKSTOP), as
//         on main. Red before: every guided-manual replay was handed over and the click filed.
//   [B, Helm Should-fix 3] A FAILING RUN IS NEVER HANDED OVER: an UNFLAGGED stopping abort (a click the
//   watch did not see) refuses the hand-over before the arm and again just before handOverReviewPage;
//   each case asserts 0 POSTs to /apply/submit, failed by name, NOT_HANDED_OVER_NOTE in driftWarnings,
//   reviewHandoffNotes and the progress line, never "the page is yours", never "YOUR CLICK WAS HELD BACK":
//     B13 a person's click during the run's LAST WRITES (after its tick on an 8 s "Saving..." review
//         page, before the watch is armed), then a second click at the refusal (or at "the page is
//         yours"): the watch is never armed. Red before: handed over, and the second click filed.
//         Kill (no check before the arm): the armed watch flags the second click and the failing run
//         says "YOUR CLICK WAS HELD BACK".
//     B14 a person's click as the run arms its watch (before the arm itself). Red before: handed
//         over over a run that then fails by name. Kill (no check before handOverReviewPage): same.
//     B14b a filing request recorded WHILE the arm runs (page-script fetch alongside it, the
//         deterministic stand-in for a click inside the 12-19 ms arm). Red before / kill: as B14.
//     B2 (above) gains a GUARD check, green before by design: a click the watch SAW still hands over
//         ("the page is yours", no NOT_HANDED_OVER_NOTE). Kill: refuse on ANY stopping abort.
//   [B, Helm Should-fix 12] THE FAIL-CLOSED NOTE, PINNED ON ITS OWN CAUSE (a failed arm):
//     B12 the input watch cannot be armed (the arm reports false, no sink) and the person clicks
//         right after the lock: never "the page is yours", the whole NOT_HANDED_OVER_NOTE as a progress
//         line and in driftWarnings + reviewHandoffNotes, 0 POSTs, no submit reported, never "YOUR
//         CLICK WAS HELD BACK" (r.ok not asserted: the run fails by name, as on main). GUARD pin, green
//         before by design: the fail-closed branch and the <=200-char note landed before it (earlier,
//         nothing collected progress lines and progress() cut the 222-char note at 200). Kills
//         (measured at 15ad02a6): K11 alone (handOverToHuman without its armed-watch check) reddens
//         A9 only, because the adapter also asks for an armed watch; K11 plus the adapter's
//         `handOverArmed &&` dropped reddens A9 and B12's "page is yours", note and 0-POST checks;
//         dropping the three NOT_HANDED_OVER_NOTE lines reddens B12's note check (and B13/B14/B14b's).
//     B12b (a failed CDP arm) waits for the isolated-world watch (Should-fix 1); not pinned until then.
//   [B, Helm nit :97] ONLY THE HANDED-OVER PAGE'S OWN DOCUMENT REQUEST ENDS WHAT THE RUN ANSWERS FOR
//   (RecipeAdapter.humanDocumentFromHandedOverPage: the record's requesting Page must be the run's page):
//     B17 the person opens the review page's "Contact us" popup and sends its form (its document POST
//         goes, recorded as theirs, page = the popup), then — past the review page's 4 s window — a
//         page script submits the filing form on the review page: 0 POSTs to /apply/submit, the run
//         fails by name. Red before: the popup's document request excused the review-page abort (ok).
//     B17b (positive twin) the person's own submit on the handed-over page goes, then the completion
//         page's script POSTs the filing (aborted): the run is NOT failed. GUARD pin, green before by
//         design; it holds the identity `request.frame().page() === adapter.page` in real Chromium.
//         Kill Kp: record `page: null` at the backstop's push site. Measured at b936673f, Kp reddens
//         4/105: A1's page stamp, B10 x2 (personMovedOn's first clause reads the same predicate) and
//         B17b's "not failed". Kill Kr (the predicate without its page filter) reddens B17's "fails
//         by name" (1/105) and backstopStopHuman case 6 (1/18).
//   [round 4, THE RECORD'S SHAPE] (Helm Blocking 1 "stamp humanRequests and aborts with at", nit :97
//   "record the requesting page") — extra checks on existing cases, no new case numbers:
//     A1  also: the person's request is stamped POST / resourceType document / `at` inside the click's
//         window / the requesting page is the run's page.
//     A5  also: the payment abort is stamped with `at` inside the click's window.
//     B1  also: the completion document the person's POST committed is in the adapter's navDocuments
//         with `at` after the hand-over.
//   Each is red before the stamps exist (the fields are undefined).
//   [C] THE CAPTURE (Helm Blocking 1). After the hand-over a submit click is only a SIGHTING: evidence
//   after it (a non-GET request of the person's, a document a non-GET request committed, on any URL)
//   commits it; a stopping abort after it with no filing-shaped request of theirs holds it; and the
//   page after it is judged against the review page's own reading (numbers by shape tier, completion
//   wording with its veto, the review's submit control), never by URL. A capture that finds the review
//   (or the error page) reopens the watch. Each case arms index.ts armSubmitCapture; "recorded" = a
//   number the runner reported (index.ts reports any non-empty number HIGH). LATE = after the run let
//   go and after a capture of the first click would have read the page.
//     C1  an Accela review with an empty required box: the tail click sends nothing, then LATE the person
//         types their initials and clicks again: 26TMP-004411 never recorded, 187-26-000328-STR recorded.
//     C2  a dismissed confirm() on a review showing APP-7734120, and C19 the same on PSE Part 2's header
//         (NEM-204411): 0 POSTs, nothing recorded, no submit handed on.
//     C3  a Submit that sends nothing, then "My Applications" (status cells, ANOTHER application's
//         187-26-000100-STR) by GET: nothing recorded, no submit handed on. C3b: the Submit's only request
//         is an analytics fetch (the click commits on it), then "My Applications": nothing recorded (a
//         page reached by navigation alone never yields a number).
//     C4  the Submit posts to a payment URL (rule 1 holds it, 0 POSTs there), then LATE the real submit:
//         captured (BLD-2026-900123).
//     C10 a single-page app whose server answers the filing fetch 12 s after the click: 26TMP-004411
//         never recorded; the completion is captured once it arrives (the review read reopens the watch).
//     C11 an analytics fetch + pushState("?saved=1"), and C14 a POST that re-renders the review at
//         /review2, then LATE the real submit: 26TMP-004411 never recorded, the re-click captured.
//     C15 a "submitted with errors" re-render, C16 a duplicate rejection naming 187-26-000100-STR ("This
//         application was not filed."), C18 a re-render whose history TABLE cell reads "Your application
//         has been submitted" beside 187-26-000199-STR: nothing recorded, and the click does not stand
//         as the person's submit at the end (the capture found the review and reopened the watch).
//     Each of C1-C4, C10, C11, C14-C16, C18, C19 and C3b is red on main's capture (measured at 97a39d6a:
//     the click committed on sight, the one-shot detector was spent, and the loose read recorded the
//     review's own id, a list's or a banner's number HIGH).
//     GUARD pins, green before by design (the loose read already recorded these), each with its kill:
//     C5  a postback to the review page's OWN URL is captured. Kill: commit only on another URL.
//     C6a/C6b/C7/C8 the portal sends the filing 2.5 s / 4 s after the click, after the run let go — a form
//         POST, a postback to the review URL, an in-place fetch submit to a URL that is not filing-shaped
//         (the DOM re-renders): each captured. Kills: release a pending click after a fixed 1.5 s; drop a
//         late plain fetch's re-read (C8).
//     C12 PowerClerk's completion reusing the review's own APP-7734121 is captured, and C13 beside a
//         "Confirmation #: PFP-2026-55120" the APP- number is recorded. Kills: never take the review's own
//         number (C12); take the first new number of any tier (C13).
//     C17a a completion with only "Record Issued" + a new number, C17b one whose wording the review page
//         already showed: captured. Kill: a new number needs completion wording the review did not show.
//     C9  a person's filing DURING the run's dispose (after `disposed` is set, before the route comes
//         off — the harness holds the context's unroute until the fixture counted the POST, or 4 s):
//         it goes (1 POST), nothing is aborted at or after the click, and the run is not failed.
//         Red before the handler's first-line `if (disposed) → fallback`: the disposed backstop
//         judged the POST not the person's, and /apply/submit is a filing URL → aborted.
// Against main (no hand-over) A1 and B1b FAIL by name: the person's POST is aborted by the lockdown.
// B1 fails on main only because its person never clicks (main never says "the page is yours"), not by name.
//
//   npx tsx portal-bot/src/adapters/humanSubmitAfterReview.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium, type Page } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { backstopFor, installFilingBackstop, isStoppingAbort, withBackstopWindow, withOwnWriteWindow, type FilingBackstop } from "../filingBackstop";
import { HUMAN_CLICK_HELD_NOTE, HUMAN_SUBMITTED_NOTE, NOT_HANDED_OVER_NOTE, PERSON_REQUEST_WENT_NOTE, RecipeAdapter } from "./recipeAdapter";
import { armSubmitCapture } from "../index";

let failures = 0;
let total = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  total++;
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// The fixture portal
// ---------------------------------------------------------------------------------------------
const RECORD = "BLD-2026-900123";
const posts: Array<{ k: string; path: string }> = [];
const html = (title: string, body: string): string => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const COMPLETION = html("Application Submitted", `<h1>Application Submitted</h1><p>Your application has been successfully submitted.</p><p>Record Number: ${RECORD}</p>`);
// "My Records": a list headed "Record Number" carrying ANOTHER application's (Accela-shaped) number.
const MY_RECORDS = html("My Records", `<h1>My Records</h1><table><tr><th>Record Number</th><th>Type</th><th>Status</th></tr><tr><td>517-26-000274-STR</td><td>Residential Solar</td><td>Issued</td></tr></table>`);
// An OLDER application's record page, whose own text says it was received.
const OLD_RECORD = html("Record BLD-2026-900001", `<h1>Record BLD-2026-900001</h1><p>Your application has been received.</p><p>Record Number: BLD-2026-900001</p>`);
const formSubmit = (k: string): string => `<form method="post" action="/h/${k}/apply/submit"><button type="submit" id="btnSubmit">Submit Application</button></form>`;
// A fetch submit, then the completion page by location.href — under a label the click classifier
// does not know (classifyRecordedClick("Send to City") is "capture", never "finalSubmit").
const SEND = (k: string): string => `<button type="button" id="send" onclick="fetch('/h/${k}/api/application', { method: 'POST', body: 'x=1' }).then(function () { location.href = '/h/${k}/done'; })">Send to City</button>`;
// The portal's submit as a fetch (no navigation: a held click leaves the review page where it was, so
// the person can click it again), then the completion page by location.href.
const FETCH_SUBMIT = (k: string): string => `<button type="button" id="btnSubmit" onclick="fetch('/h/${k}/apply/submit', { method: 'POST', body: 'x=1' }).then(function () { location.href = '/h/${k}/done'; }).catch(function () {})">Submit Application</button>`;
// Processor endpoints rule 1 must know (Helm Should-fix 13), served by the loopback fixture only.
const PROCESSOR_PATHS: Record<string, string> = {
  A5b: "xml/v1/request.api",
  A5c: "api/v1/transactions",
  A5d: "api/fees/settle",
  A5e: "gps/user/42/submit",
};
// [C] THE CAPTURE'S FIXTURES (Helm Blocking 1). The review id an Accela review shows (labelled tier).
const TMP_ID = "26TMP-004411";
const SUMMARY = `<h1>Step 3: Review</h1><p>Please review your application before you submit it.</p><table><tr><th>Address</th><td>100 Fixture Way</td></tr></table>`;
const submitForm = (action: string, extra = "", id = "btnSubmit", attrs = ""): string => `<form method="post" action="${action}"${attrs}>${extra}<button type="submit" id="${id}">Submit Application</button></form>`;
const completionWith = (lines: string): string => html("Application Submitted", `<h1>Thank you</h1>${lines}`);
// What each C case's filing POST is answered with (default: COMPLETION with RECORD).
const C_COMPLETIONS: Record<string, string> = {
  C1: completionWith(`<p>Your application has been successfully submitted.</p><p>Record Number: 187-26-000328-STR</p>`),
  C5: completionWith(`<p>Your application has been successfully submitted.</p><p>Record Number: 187-26-000505-STR</p>`),
  C6a: completionWith(`<p>Your application has been successfully submitted.</p><p>Record Number: 187-26-000601-STR</p>`),
  C6b: completionWith(`<p>Your application has been successfully submitted.</p><p>Record Number: 187-26-000602-STR</p>`),
  C7: completionWith(`<p>Your application has been successfully submitted.</p><p>Record Number: 187-26-000707-STR</p>`),
  C10: completionWith(`<p>Your application has been successfully submitted.</p><p>Record Number: 187-26-000710-STR</p>`),
  C14: completionWith(`<p>Your application has been successfully submitted.</p><p>Record Number: 187-26-000714-STR</p>`),
  // PowerClerk reuses the review's own APP- id on its completion (C12), and may add a confirmation (C13).
  C12: completionWith(`<p>Your application has been submitted.</p><p>Application APP-7734121</p>`),
  C13: completionWith(`<p>Your application has been submitted.</p><p>Application APP-7734121</p><p>Confirmation #: PFP-2026-55120</p>`),
  // A completion with no listed phrase (C17a), and one whose wording the review page already showed (C17b).
  C17a: completionWith(`<h1>Record Issued</h1><p>Permit Number: BLD-2026-900777</p>`),
  C17b: completionWith(`<p>Your application has been submitted.</p><p>Record Number: BLD-2026-900778</p>`),
};
// The review pages of the C cases (each keeps its submit control; see the server for what a POST returns).
const C_REVIEWS: Record<string, string> = {
  // An Accela review with an EMPTY required box: the first click sends nothing (the browser holds it).
  C1: `${SUMMARY}<p>Record Number: ${TMP_ID}</p>${submitForm("/h/C1/apply/submit", `<label for="initials">Initials</label> <input id="initials" name="initials" required> `)}`,
  // A native confirm() Playwright dismisses: nothing is sent. C19 is PSE Part 2's header id (labelled).
  C2: `${SUMMARY}<p>Application APP-7734120</p>${submitForm("/h/C2/apply/submit", "", "btnSubmit", ` onsubmit="return confirm('Submit this application?')"`)}`,
  C19: `${SUMMARY}<p>Application NEM-204411 (Part 2: Interconnection Agreement)</p>${submitForm("/h/C19/apply/submit", "", "btnSubmit", ` onsubmit="return confirm('Submit this application?')"`)}`,
  // A Submit that sends nothing, and the portal's "My Applications" list one GET away.
  C3: `${SUMMARY}<button type="button" id="btnSubmit" onclick="return false">Submit Application</button> <a id="myapps" href="/h/C3/myapps">My Applications</a>`,
  // C3b: the Submit sends only an analytics fetch (a request of the person's, so the click commits), then
  // "My Applications" one GET away.
  C3b: `${SUMMARY}<button type="button" id="btnSubmit" onclick="fetch('/h/C3b/t/collect', { method: 'POST', body: 'e=submit' }).catch(function () {})">Submit Application</button> <a id="myapps" href="/h/C3b/myapps">My Applications</a>`,
  // The first Submit posts to a payment URL (rule 1 holds it); the real one is the form's.
  C4: `${SUMMARY}<button type="button" id="btnSubmit" onclick="fetch('/h/C4/payment/charge', { method: 'POST', body: 'amt=150' }).catch(function () {})">Submit Application</button>${submitForm("/h/C4/apply/submit", "", "btnSubmit2")}`,
  // A postback to the review page's own URL (ASP.NET-style).
  C5: `${SUMMARY}${submitForm("/h/C5/review")}`,
  // The portal posts the form 2.5 s / 4 s after the click (the run has let go by then); C7 to its own URL.
  C6a: `${SUMMARY}<form method="post" action="/h/C6a/apply/submit"></form><button type="button" id="btnSubmit" onclick="setTimeout(function () { document.forms[0].submit(); }, 2500)">Submit Application</button>`,
  C6b: `${SUMMARY}<form method="post" action="/h/C6b/apply/submit"></form><button type="button" id="btnSubmit" onclick="setTimeout(function () { document.forms[0].submit(); }, 4000)">Submit Application</button>`,
  C7: `${SUMMARY}<form method="post" action="/h/C7/review"></form><button type="button" id="btnSubmit" onclick="setTimeout(function () { document.forms[0].submit(); }, 2500)">Submit Application</button>`,
  // An in-place fetch submit to a URL that is not filing-shaped, 2.5 s after the click: the DOM re-renders.
  C8: `${SUMMARY}<button type="button" id="btnSubmit" onclick="setTimeout(function () { fetch('/h/C8/x/go', { method: 'POST', body: 'x=1' }).then(function () { document.body.innerHTML = '<h1>Thank you</h1><p>Your application has been submitted.</p><p>Permit Number: BLD-2026-900888</p>'; }); }, 2500)">Submit Application</button>`,
  // The server answers the filing 10 s after the click.
  // A single-page app: its submit is a fetch the server answers 12 s later, then it renders the answer.
  C10: `${SUMMARY}<p>Record Number: ${TMP_ID}</p><button type="button" id="btnSubmit" onclick="fetch('/h/C10/api/submit-slow', { method: 'POST', body: 'x=1' }).then(function (r) { return r.text(); }).then(function (t) { document.body.innerHTML = t; }).catch(function () {})">Submit Application</button>`,
  // An analytics fetch and a pushState (the page stays the review); the real submit is the form's.
  C11: `${SUMMARY}<p>Record Number: ${TMP_ID}</p><button type="button" id="btnSubmit" onclick="fetch('/h/C11/t/collect', { method: 'POST', body: 'e=submit' }).catch(function () {}); history.pushState({}, '', '?saved=1')">Submit Application</button>${submitForm("/h/C11/apply/submit", "", "btnSubmit2")}`,
  C12: `${SUMMARY}<p>Application APP-7734121</p>${submitForm("/h/C12/apply/submit")}`,
  C13: `${SUMMARY}<p>Application APP-7734121</p>${submitForm("/h/C13/apply/submit")}`,
  // The first POST re-renders the same review at a new URL (/review2), whose form then files.
  C14: `${SUMMARY}<p>Record Number: ${TMP_ID}</p>${submitForm("/h/C14/review2")}`,
  // A server-side validation error re-renders the review.
  C15: `${SUMMARY}<p>Record Number: ${TMP_ID}</p>${submitForm("/h/C15/apply/errors")}`,
  // A duplicate rejection re-renders the review with a banner naming another record.
  C16: `${SUMMARY}${submitForm("/h/C16/apply/dup")}`,
  C17a: `${SUMMARY}${submitForm("/h/C17a/apply/submit")}`,
  C17b: `${SUMMARY}<p>Once your application has been submitted, you cannot change it.</p>${submitForm("/h/C17b/apply/submit")}`,
  // The POST re-renders the review with a history TABLE whose status cell reads as completion wording.
  C18: `${SUMMARY}${submitForm("/h/C18/apply/history")}`,
};
// What a re-rendering POST answers (the review again, its submit control still there).
const C_RERENDERS: Record<string, string> = {
  "C14|review2": html("Review and Submit", `${SUMMARY}<p>Record Number: ${TMP_ID}</p>${submitForm("/h/C14/apply/submit")}`),
  "C15|apply/errors": html("Review and Submit", `<p class="err">The form was submitted with errors. Please correct the following.</p>${SUMMARY}<p>Record Number: ${TMP_ID}</p>${submitForm("/h/C15/apply/errors")}`),
  "C16|apply/dup": html("Review and Submit", `<p class="err">An application was submitted for this address on 10/01/2026 under record 187-26-000100-STR. This application was not filed.</p>${SUMMARY}${submitForm("/h/C16/apply/dup")}`),
  "C18|apply/history": html("Review and Submit", `${SUMMARY}<h2>History</h2><table><tr><th>Event</th><th>Record</th></tr><tr><td>Your application has been submitted</td><td>187-26-000199-STR</td></tr></table>${submitForm("/h/C18/apply/history")}`),
};
// "My Applications": status cells and ANOTHER application's number.
const MY_APPS = html("My Applications", `<h1>My Applications</h1><table><tr><th>Record</th><th>Status</th></tr><tr><td>187-26-000100-STR</td><td>Application Submitted</td></tr></table>`);
const reviewBody = (k: string): string => {
  if (C_REVIEWS[k]) return C_REVIEWS[k];
  const summary = SUMMARY;
  if (k === "B5") return `${summary}${formSubmit(k)}<button type="button" id="saveLater" onclick="fetch('/h/B5/api/save-later', { method: 'POST', body: 'x=1' }).then(function () { location.href = '/h/B5/records'; })">Save for Later</button>`;
  if (k === "B6") return `${summary}${formSubmit(k)}${SEND(k)}`;
  // The run's tick on the review page starts an 8 s "Saving..." (PowerClerk's batched autosave shape;
  // long enough to outlast the run's tail up to its drain). B13: the same page, with a fetch submit.
  if (k === "B7" || k === "B13") return `${summary}<span data-test-role="project-save-state">Saved</span>
    <div><input type="checkbox" id="terms"> <label for="terms">I certify the information in this application is correct</label></div>${k === "B13" ? FETCH_SUBMIT(k) : `${formSubmit(k)}${SEND(k)}`}
    <script>
      var st = document.querySelector("[data-test-role='project-save-state']"); var timer = null;
      document.getElementById('terms').addEventListener('change', function () {
        st.textContent = 'Saving...';
        if (timer) return;
        timer = setTimeout(function () {
          fetch('/h/${k}/Project/SaveChanges', { method: 'POST', body: 'terms=on' }).then(function () { st.textContent = 'Saved'; }).catch(function () { st.textContent = 'Save failed'; });
        }, 8000);
      });
    </script>`;
  if (k === "B14" || k === "B14b") return `${summary}${FETCH_SUBMIT(k)}`;
  if (k === "B8") return `${summary}${formSubmit(k)}<a id="older" href="/h/B8/record">Older application BLD-2026-900001</a>`;
  // B17: the review page links a contact form that opens in a popup (another tab, another Page).
  if (k === "B17") return `${summary}${formSubmit(k)}<a id="help" href="/h/B17/popup-form" target="_blank">Contact us</a>`;
  if (k === "B9") return `${summary}${formSubmit(k)}<button type="button" id="pay" onclick="fetch('/h/B9/payment/charge', { method: 'POST', body: 'amt=150' }).catch(function () {})">Pay Fees</button>`;
  if (k === "A4") return `${summary}<button type="button" id="btnSubmit" onclick="window.open('/h/A4/popup', '_blank')">Submit Application</button>`;
  if (k === "A5") return `${summary}<button type="button" id="btnSubmit" onclick="fetch('/h/A5/payment/charge', { method: 'POST', body: 'amt=150' }).catch(function(){})">Submit Application</button>`;
  if (PROCESSOR_PATHS[k]) return `${summary}<button type="button" id="btnSubmit" onclick="fetch('/h/${k}/${PROCESSOR_PATHS[k]}', { method: 'POST', body: 'amt=150' }).catch(function(){})">Submit Application</button>`;
  // The portal answers the submit with a method-keeping redirect (judged as a fresh request, #370).
  if (k === "A10") return `${summary}<form method="post" action="/h/A10/apply/slow307"><button type="submit" id="btnSubmit">Submit Application</button></form>`;
  if (k === "A11") return `${summary}<form method="post" action="/h/A11/apply/pay307"><button type="submit" id="btnSubmit">Submit Application</button></form>`;
  // A14: a plain GET link off the review page; the next document posts the filing as it parses.
  if (k === "A14") return `${summary}<a id="next" href="/h/A14/next">Continue</a>`;
  return `${summary}<form method="post" action="/h/${k}/apply/submit"><button type="submit" id="btnSubmit">Submit Application</button></form>`;
};
// A step BEFORE review (B10): an attachments page whose Continue posts and is answered with the review
// page. Neither its text nor its URL (/attachments) reads as the review step.
const ATTACHMENTS = (k: string): string => html("Attachments", `<h1>Step 2: Attachments</h1><p>Upload the documents this application needs.</p><div><label for="doc">Site plan</label> <input type="file" id="doc"></div><form method="post" action="/h/${k}/apply/continue"><button type="submit" id="btnContinue">Continue Application</button></form>`);
// Method-keeping redirects the fixture answers, with the delay before the 307 (ms): the slow one lands
// after HUMAN_INPUT_MS (4 s) has passed since the person's click.
const REDIRECTS: Record<string, [string, number]> = {
  "apply/slow307": ["apply/submit", 4600],
  "apply/pay307": ["payment/charge", 4600],
  "apply/autosave307": ["SubmitApplication", 1000],
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean); // h, <k>, ...
  const k = parts[0] === "h" ? parts[1] || "" : "";
  const rest = parts.slice(2).join("/");
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") posts.push({ k, path: url.pathname });
  const send = (body: string): void => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(body); };
  if (req.method === "POST" && REDIRECTS[rest]) {
    const [to, delay] = REDIRECTS[rest];
    setTimeout(() => { res.writeHead(307, { location: `/h/${k}/${to}` }); res.end(); }, delay);
    return;
  }
  if (req.method === "POST" && C_RERENDERS[`${k}|${rest}`]) { send(C_RERENDERS[`${k}|${rest}`]); return; }
  if (req.method === "POST" && rest === "api/submit-slow") { setTimeout(() => send(`<h1>Thank you</h1><p>Your application has been successfully submitted.</p><p>Record Number: 187-26-000710-STR</p>`), 12_000); return; }
  if (req.method === "POST" && rest === "review" && C_COMPLETIONS[k]) { send(C_COMPLETIONS[k]); return; }
  if (req.method === "POST" && rest === "apply/submit") { send(C_COMPLETIONS[k] ?? COMPLETION); return; }
  if (rest === "myapps") { send(MY_APPS); return; }
  if (req.method === "POST" && rest === "apply/continue") { send(html("Review and Submit", reviewBody(k))); return; }
  if (rest === "popup") { send(html("Processing", `<h1>Processing</h1><script>fetch('/h/${k}/popup/post', { method: 'POST', body: 'from=popup' }).catch(function(){});</script>`)); return; }
  if (req.method === "POST" && rest === "contact/send") { send(html("Message sent", "<h1>Thank you</h1><p>Your message was sent.</p>")); return; }
  if (req.method !== "GET") { res.writeHead(204); res.end(); return; }
  if (rest === "popup-form") { send(html("Contact us", `<h1>Contact us</h1><form method="post" action="/h/${k}/contact/send"><textarea name="msg">Question</textarea><button type="submit" id="sendMsg">Send</button></form>`)); return; }
  if (rest === "next") { send(html("Processing", `<h1>Processing</h1><script>fetch('/h/${k}/apply/submit', { method: 'POST', body: 'auto=1' }).catch(function(){});</script>`)); return; }
  if (rest === "records") { send(MY_RECORDS); return; }
  if (rest === "record") { send(OLD_RECORD); return; }
  if (rest === "done") { send(COMPLETION); return; }
  if (rest === "attachments") { send(ATTACHMENTS(k)); return; }
  if (rest === "review" || rest === "") { send(html("Review and Submit", reviewBody(k))); return; }
  send(html("Not found", "<h1>Not found</h1>"));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch();
const postsFor = (k: string, from: number): Array<{ k: string; path: string }> => posts.slice(from).filter((p) => p.k === k);

/** A PERSON'S click: a raw mouse click at the control's centre (a trusted event, no fence). */
async function personClicks(page: Page, css = "#btnSubmit"): Promise<void> {
  const box = await page.locator(css).first().boundingBox();
  if (!box) throw new Error(`no box for ${css}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
/** A person's click on an empty part of the page (an input that sends nothing). */
async function personTouchesPage(page: Page): Promise<void> {
  await page.mouse.click(5, 5);
}

// ---------------------------------------------------------------------------------------------
// [A] The backstop, directly
// ---------------------------------------------------------------------------------------------
interface Bed { page: Page; bs: FilingBackstop; close: () => Promise<void> }
async function bed(k: string, opts: { arm?: boolean; handOver?: boolean; lock?: boolean } = {}): Promise<Bed> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // Installed BEFORE the page loads, as every production run's first step loads a fresh document
  // under it: the redirect guard (#370) does not see subresource redirects of a document that was
  // already loaded when it joined (#394).
  const bs = await installFilingBackstop(page, `human-submit ${k}`);
  if (!bs) throw new Error("no backstop");
  await page.goto(`${base}/h/${k}/review`);
  // lock:false — the replay's own order is hand over → drain its own save → lock (B7); a bed that
  // still has its own save to send must not be locked yet.
  if (opts.lock !== false) bs.lockReview(`smoke ${k} at review`);
  if (opts.arm !== false) {
    const armed = await bs.watchHumanInput();
    if (!armed) throw new Error("the input watch could not be armed");
  }
  if (opts.handOver !== false && opts.arm !== false) bs.handOverToHuman(`smoke ${k}`);
  return { page, bs, close: async () => { await bs.dispose().catch(() => null); await ctx.close().catch(() => null); } };
}
// Fields picked by name: a humanRequests entry carries the requesting Page (circular — JSON.stringify
// would throw on it).
const brief = (b: Bed, k: string, from: number): string => JSON.stringify({
  posts: postsFor(k, from).map((p) => p.path), aborts: b.bs.aborts.map((a) => ({ rule: a.rule, where: a.where.replace(base, ""), human: !!a.humanInput, at: a.at })),
  humanRequests: b.bs.humanRequests.map((r) => ({ where: r.where.replace(base, ""), document: r.document, abortsBefore: r.abortsBefore, method: r.method, resourceType: r.resourceType, at: r.at })),
}).slice(0, 700);

console.log("\n[A] THE BACKSTOP, DIRECTLY");
{
  const from = posts.length;
  const b = await bed("A1");
  const clickAt = Date.now();
  await personClicks(b.page);
  await sleep(900);
  const doneAt = Date.now();
  check("A1 a person's click after the hand-over: their form POST (a filing URL) reaches the portal",
    postsFor("A1", from).filter((p) => /\/apply\/submit$/.test(p.path)).length === 1, brief(b, "A1", from));
  check("A1 …recorded as the person's request (a main-frame document submission), no stopping abort",
    b.bs.humanRequests.some((r) => r.document && /\/apply\/submit$/.test(r.where)) && b.bs.stoppingAborts().length === 0, brief(b, "A1", from));
  // Round 4 (Helm Blocking 1, nit :97): the record says WHEN it went, HOW (method, resource type) and
  // FROM WHICH PAGE — the capture judges a click by requests after it, never by a GET or a beacon,
  // and counts only the handed-over page's document request.
  const rec = b.bs.humanRequests.find((r) => /\/apply\/submit$/.test(r.where));
  check("A1 …stamped: POST, resourceType document, `at` inside the click's window, and the requesting page is the run's page",
    !!rec && rec.method === "POST" && rec.resourceType === "document" && typeof rec.at === "number" && rec.at >= clickAt && rec.at <= doneAt && rec.page === b.page,
    `clickAt=${clickAt} doneAt=${doneAt} samePage=${!!rec && rec.page === b.page} ${brief(b, "A1", from)}`);
  await b.close();
}
{
  const from = posts.length;
  const b = await bed("A2");
  await b.bs.withAutomationInput(b.page, () => b.page.locator("#btnSubmit").click());
  await sleep(900);
  check("A2 automation's (fenced) click after the hand-over: aborted, nothing reached the portal",
    postsFor("A2", from).length === 0 && b.bs.aborts.some((a) => isStoppingAbort(a) && !a.humanInput), brief(b, "A2", from));
  check("A2 …and it is not recorded as a person's request", b.bs.humanRequests.length === 0, brief(b, "A2", from));
  await b.close();
}
{
  const from = posts.length;
  const b = await bed("A3");
  await b.page.evaluate(() => { void fetch("track/post", { method: "POST", body: "x=1" }).catch(() => null); });
  await sleep(700);
  check("A3 a page script's POST after the hand-over, with no input: aborted", postsFor("A3", from).length === 0 && b.bs.aborts.length > 0, brief(b, "A3", from));
  await b.close();
}
{
  const from = posts.length;
  const b = await bed("A4");
  await personClicks(b.page);
  await sleep(1500);
  check("A4 a person's click on the review page, then a POPUP posts within the window: the popup's POST is aborted",
    postsFor("A4", from).length === 0 && b.bs.aborts.some((a) => /\/popup\/post$/.test(a.where)), brief(b, "A4", from));
  await b.close();
}
{
  const from = posts.length;
  const b = await bed("A5");
  const clickAt = Date.now();
  await personClicks(b.page);
  await sleep(700);
  const doneAt = Date.now();
  check("A5 a payment URL right after a person's click: aborted (payment is never lifted; rule 1 is only as wide as PAY_FEE_URL)",
    postsFor("A5", from).length === 0 && b.bs.aborts.some((a) => /\/payment\/charge$/.test(a.where)), brief(b, "A5", from));
  // Round 4 (Helm Blocking 1): an abort says when it was held — "a stopping abort AFTER the click".
  const held = b.bs.aborts.find((a) => /\/payment\/charge$/.test(a.where));
  check("A5 …the abort is stamped with when it was held (`at` inside the click's window)",
    !!held && typeof held.at === "number" && held.at >= clickAt && held.at <= doneAt, `clickAt=${clickAt} doneAt=${doneAt} ${brief(b, "A5", from)}`);
  await b.close();
}
for (const [k, path] of Object.entries(PROCESSOR_PATHS)) {
  // A5b-A5e (Helm Should-fix 13): rule 1 is only as wide as PAY_FEE_URL. A processor endpoint it did
  // not name passed inside the person's 4 s window (rules 2 and 4 lifted). /fee-payment/ on `why`
  // tells rule 1 from rule 2, which also aborts with rule "filing-url".
  const from = posts.length;
  const b = await bed(k);
  await personClicks(b.page);
  await sleep(700);
  const held = b.bs.aborts.find((a) => a.where.endsWith("/" + path));
  check(`${k} a person's click whose request goes to /${path} within 4 s: aborted by rule 1 (payment stays blocked for URLs rule 1 knows)`,
    postsFor(k, from).length === 0 && !!held && held.rule === "filing-url" && /fee-payment/.test(held.why) && held.humanInput === true && !held.beforeHandOver,
    brief(b, k, from));
  check(`${k} …and it is never recorded as the person's request`, b.bs.humanRequests.length === 0, brief(b, k, from));
  await b.close();
}
{
  const from = posts.length;
  const b = await bed("A6", { handOver: false });
  await personTouchesPage(b.page);
  await sleep(1000);
  b.bs.handOverToHuman("smoke A6");
  await sleep(1000);
  await b.page.evaluate(() => { void fetch("track/post", { method: "POST", body: "x=1" }).catch(() => null); });
  await sleep(700);
  check("A6 an input 1 s BEFORE the hand-over and a script POST 1 s after it: aborted (input is never carried over)",
    postsFor("A6", from).length === 0 && b.bs.aborts.some((a) => /\/track\/post$/.test(a.where)), brief(b, "A6", from));
  await b.close();
}
{
  const from = posts.length;
  const b = await bed("A7", { handOver: false });
  await personClicks(b.page);
  await sleep(900);
  check("A7 a person's click BEFORE the hand-over: aborted, nothing sent", postsFor("A7", from).length === 0, brief(b, "A7", from));
  check("A7 …and the abort is flagged humanInput (the run can say 'click again')", b.bs.aborts.some((a) => isStoppingAbort(a) && a.humanInput === true), brief(b, "A7", from));
  await b.close();
}
{
  const from = posts.length;
  const b = await bed("A8");
  await withBackstopWindow(b.page, "dismisser-window", "smoke A8 dismisser in flight", async () => { await personClicks(b.page); await sleep(700); });
  await sleep(300);
  check("A8 a person's click while a dismisser window is open: aborted (the window rule still applies)",
    postsFor("A8", from).length === 0 && b.bs.aborts.length > 0, brief(b, "A8", from));
  await b.close();
}
{
  const from = posts.length;
  const b = await bed("A9", { arm: false });
  const handed = b.bs.handOverToHuman("smoke A9");
  await personClicks(b.page);
  await sleep(900);
  check("A9 the input watch never armed: handOverToHuman refuses, and a person's click is aborted",
    handed === false && postsFor("A9", from).length === 0, `handed=${handed} ${brief(b, "A9", from)}`);
  await b.close();
}

// [A, #370 × #333] A redirect hop is judged as a fresh request (#370). The person's verdict is the FIRST
// leg's, carried on the hop — never recomputed when the 307 arrives. Judged live, A10's hop would
// read as not the person's (4.6 s > HUMAN_INPUT_MS: their filing cut off) and A12's hop as theirs
// (a touch 0.7 s before it: the run's own save let through to a filing URL).
console.log("\n[A, #370] A REDIRECT HOP CARRIES THE FIRST LEG'S PERSON VERDICT");
{
  const from = posts.length;
  const b = await bed("A10");
  await personClicks(b.page);
  await sleep(6500);
  const p = postsFor("A10", from).map((x) => x.path);
  check("A10 MUST-PASS the person's submit answered 307 after 4.6 s: the hop still reaches /apply/submit",
    p.filter((x) => /\/apply\/slow307$/.test(x)).length === 1 && p.filter((x) => /\/apply\/submit$/.test(x)).length === 1 && b.bs.stoppingAborts().length === 0, brief(b, "A10", from));
  check("A10 …recorded as the person's request ONCE (the first leg), never again for the hop",
    b.bs.humanRequests.filter((r) => /\/apply\/slow307$/.test(r.where)).length === 1 && !b.bs.humanRequests.some((r) => /\/apply\/submit$/.test(r.where)), brief(b, "A10", from));
  await b.close();
}
{
  const from = posts.length;
  const b = await bed("A11");
  await personClicks(b.page);
  await sleep(6500);
  const p = postsFor("A11", from).map((x) => x.path);
  const hop = b.bs.aborts.find((a) => a.redirect && /\/apply\/pay307$/.test(a.redirect.from) && /\/payment\/charge$/.test(a.where));
  // GUARD PIN (green before by design): rule 1 already runs before the person's verdict is read.
  check("A11 MUST-EXCLUDE the person's submit answered 307 → /payment/charge after 4.6 s: nothing reaches it (payment is checked before the person's verdict)",
    p.filter((x) => /\/apply\/pay307$/.test(x)).length === 1 && !p.some((x) => /\/payment\/charge$/.test(x)) && !!hop && hop.rule === "filing-url" && isStoppingAbort(hop), brief(b, "A11", from));
  // The refusal is the PERSON'S (carried from the first leg), so the run reads it as their payment
  // click held, never as the recipe's failure — judged live 4.6 s after the click it read unflagged.
  check("A11 …and the refused hop is flagged as the person's (humanInput carried from the first leg, not before the hand-over)",
    !!hop && hop.humanInput === true && !hop.beforeHandOver, brief(b, "A11", from));
  await b.close();
}
{
  const from = posts.length;
  // Handed over, not yet locked: the run still has its own save to drain (the replay's order, B7).
  const b = await bed("A12", { lock: false });
  // The run's own save (an own-write window, as the drain's or a fill's autosave) goes out first…
  await withOwnWriteWindow(b.page, "smoke A12 autosave", () => b.page.evaluate(() => { void fetch("/h/A12/apply/autosave307", { method: "POST", body: "terms=on" }).catch(() => null); }));
  await sleep(300);
  // …the person touches the page (an input that sends nothing)…
  await personTouchesPage(b.page);
  // …and its 307 → /SubmitApplication (a filing URL) arrives 0.7 s after the touch.
  await sleep(2200);
  const p = postsFor("A12", from).map((x) => x.path);
  const hop = b.bs.aborts.find((a) => a.redirect && /\/apply\/autosave307$/.test(a.redirect.from) && /\/SubmitApplication$/.test(a.where));
  check("A12 MUST-EXCLUDE the run's own save, 307 → /SubmitApplication just after a touch: the hop never reaches it (the first leg was not the person's)",
    p.filter((x) => /\/apply\/autosave307$/.test(x)).length === 1 && !p.some((x) => /\/SubmitApplication$/.test(x)) && !!hop && hop.rule === "filing-url", brief(b, "A12", from));
  check("A12 …and the hop is not in humanRequests", !b.bs.humanRequests.some((r) => /\/(SubmitApplication|apply\/autosave307)$/.test(r.where)), brief(b, "A12", from));
  // The refusal is the RUN'S (its first leg was not the person's): unflagged, so the run fails by
  // name as on main — judged live, the touch 0.7 s earlier flagged it as the person's.
  check("A12 …and the refused hop is NOT flagged as the person's (the first leg's verdict, carried)", !!hop && !hop.humanInput, brief(b, "A12", from));
  await b.close();
}
{
  // A13 (Helm Should-fix 6): the fence holds only while the run's input is in flight. A fenced touch
  // that sends nothing, then the PERSON'S click 100 ms later: theirs goes. Live, a click 432 ms after
  // the run's last fenced tick was aborted and failed the run (the 1.5 s grace ate its pointerdown).
  const from = posts.length;
  const b = await bed("A13");
  await b.bs.withAutomationInput(b.page, () => b.page.mouse.click(5, 5));
  await sleep(100);
  await personClicks(b.page);
  await sleep(900);
  check("A13 a person's click 100 ms after a fenced input: their form POST reaches the portal (no grace after the fence)",
    postsFor("A13", from).filter((p) => /\/apply\/submit$/.test(p.path)).length === 1, brief(b, "A13", from));
  check("A13 …recorded as the person's request, no stopping abort",
    b.bs.humanRequests.some((r) => r.document && /\/apply\/submit$/.test(r.where)) && b.bs.stoppingAborts().length === 0, brief(b, "A13", from));
  await b.close();
}
{
  // A14 (Helm Should-fix 2): a person's input covers only the DOCUMENT that saw it. They follow a GET
  // link off the review page; the next document posts the filing while it parses, well inside the
  // 4 s window of their click. Their click asked for that page, not for its script's POST.
  const from = posts.length;
  const b = await bed("A14");
  await personClicks(b.page, "#next");
  await sleep(1500);
  const filing = postsFor("A14", from).filter((p) => /\/apply\/submit$/.test(p.path));
  check("A14 a GET link, then the next document's parse-time filing POST: 0 POSTs reach the portal",
    filing.length === 0, brief(b, "A14", from));
  const held = b.bs.aborts.find((a) => a.rule === "filing-url" && /\/apply\/submit$/.test(a.where));
  check("A14 …aborted by the filing-URL rule", !!held, brief(b, "A14", from));
  // The abort flag is judged against the same stamp (recentHumanInput): the click asked for the
  // next page, so the held POST is not "your click was held back" — the run fails by name, as on main
  // for a page script's POST.
  check("A14 …and the abort is NOT flagged as the person's input (the click was for another document)",
    !!held && !held.humanInput, brief(b, "A14", from));
  check("A14 …and never recorded as the person's request",
    !b.bs.humanRequests.some((r) => /\/apply\/submit$/.test(r.where)), brief(b, "A14", from));
  await b.close();
}

// ---------------------------------------------------------------------------------------------
// [B] The replay
// ---------------------------------------------------------------------------------------------
console.log("\n[B] THE REPLAY (guided manual: the flagged final submit is never clicked by automation)");
const flagged: RecipeStep = { action: "click", selector: { css: "#btnSubmit" }, note: "final submit: Submit Application", isFinalSubmit: true } as RecipeStep;
const TICK = { action: "check", selector: { css: "#terms", label: "I certify the information in this application is correct" }, note: "I certify the information in this application is correct" } as RecipeStep;
// `at`: the fixture page the recipe ends on ("review" by default; B10's "attachments" must never be a
// /review path, which looksLikeReviewUrl would read as the review step).
const recipeFor = (k: string, extra: RecipeStep[] = [], at = "review"): PortalRecipe => ({
  id: `human-submit-${k}`, scopeType: "ahj", profileKey: "or|fernhollow|", state: "OR", ahj: "City of Fernhollow", utility: "",
  portalPlatform: "fixture", portalUrl: `${base}/h/${k}/${at}`, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
  steps: [
    { action: "goto", value: `${base}/h/${k}/${at}`, note: `open the ${at} page` } as RecipeStep,
    ...extra,
    { action: "stopForReview" } as RecipeStep,
    flagged,
  ],
} as PortalRecipe);
interface Replay {
  ok: boolean; message: string; data: Record<string, unknown>; pauseReason: string;
  review: { ok: boolean; message: string; data: Record<string, unknown> };
  posts: string[]; watchArmed: boolean; handedOver: boolean; extra?: unknown;
  /** What the runner's submit watch (index.ts armSubmitCapture) was handed: one entry per submit. */
  observed: string[];
  /** The backstop's record of the person's own requests (path only). */
  humanRequests: string[];
  /** When the run's first own-save drain closed (0: none). */
  drainClosedAt: number;
  /** When the adapter's "the page is yours" progress line arrived (0: never). */
  handOverSeenAt: number;
  /** The adapter's record of the main-frame documents that committed (url, method, when). */
  navDocuments: Array<{ url: string; method: string; at?: number }>;
  /** The backstop's aborts (path, rule, flagged as the person's, when). */
  aborts: Array<{ where: string; rule: string; human: boolean; at?: number }>;
  /** What onUnroute returned (the dispose gap's action). */
  gap?: unknown;
  /** Every progress line the adapter sent, in order. */
  progressLines: string[];
  /** What the runner's capture (index.ts armSubmitCapture, `capture: true` only) reported. */
  captures: SubmitCapture[];
}
type SubmitCapture = Parameters<NonNullable<Parameters<typeof armSubmitCapture>[1]["onSubmitCaptured"]>>[0];
type Track = (p: Promise<unknown>) => void;
/** THE SHARED REPLAY HARNESS (#333 fix round, built once for every later pin). Options:
 *   handOver       false = a caller that passes no onSubmitCaptured (never handed over); default true,
 *                  as index.ts passes it when the runner watches for the person's submit.
 *   at             the fixture page the recipe ends on (default "review").
 *   onHandOver     fires at the adapter's "the page is yours" progress line.
 *   onRefused      fires at the adapter's NOT_HANDED_OVER_NOTE progress line (the hand-over refused).
 *   onTailSweep    awaited at each tail sweep of the page the run ends on (emptyRequiredControls: after
 *                  its last step, re-assert and gap-fill, before the watch is armed).
 *   onBeforeArm   fires inside watchHumanInput, BEFORE the real arm (the run's last writes are done).
 *   onArming       runs alongside the real arm (Promise.all with it).
 *   armFails       the arm reports false without arming anything.
 *   onArmed        fires after a successful arm, before the hand-over.
 *   onDrain        fires when the run opens its first own-save drain.
 *   onLock         fires right after the real lockReview (pushed through track).
 *   onReviewRead   fires at the start of the run's review read-back (verifyReviewScreen).
 *   afterFill      fires after fillApplication returned and the submit watch is armed.
 *   onUnroute      fires inside the dispose gap (disposed set, route still on).
 *   capture        also arms index.ts armSubmitCapture and waits up to captureWaitMs for its reports.
 *   settleMs       a FIXED wait after afterFill (default 2000): a capture that reopens and commits again
 *                  reports twice, so "as many captures as submits" can end the wait too early. */
async function replay(k: string, opts: {
  autoSubmit?: boolean; handOver?: boolean; at?: string; extraSteps?: RecipeStep[];
  onHandOver?: (page: Page, adapter: RecipeAdapter) => Promise<unknown>;
  onRefused?: (page: Page, adapter: RecipeAdapter) => Promise<unknown>;
  onTailSweep?: (page: Page) => Promise<unknown>;
  onBeforeArm?: (page: Page, track: Track) => Promise<void>;
  onArming?: (page: Page) => Promise<unknown>;
  armFails?: boolean;
  onArmed?: (page: Page, track: Track) => Promise<void>;
  onDrain?: (page: Page, track: Track) => void;
  onLock?: (page: Page, track: Track) => void;
  onReviewRead?: (page: Page, track: Track) => void;
  afterFill?: (page: Page) => Promise<unknown>;
  onUnroute?: (page: Page) => Promise<unknown>;
  capture?: boolean; captureWaitMs?: number; settleMs?: number;
} = {}): Promise<Replay> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const from = posts.length;
  let watchArmed = false;
  let extra: unknown;
  let pending: Promise<unknown> | null = null;
  const spied: { bs: FilingBackstop | null } = { bs: null };
  const tracked: Array<Promise<unknown>> = [];
  const drain = { closedAt: 0 };
  let handOverSeenAt = 0;
  // THE DISPOSE GAP (C9): the backstop's route is installed on the BrowserContext, and dispose sets
  // `disposed` first and takes the route off last. Holding the context's unroute once dispose has
  // begun makes that gap as long as onUnroute needs (on a real portal it is a few ms — a coin flip
  // without the hold).
  const gapState = { disposing: false, fired: false, value: undefined as unknown };
  if (opts.onUnroute) {
    const c = ctx as unknown as { unroute: (...a: unknown[]) => Promise<void> };
    const unroute = c.unroute.bind(ctx);
    c.unroute = async (...a: unknown[]) => {
      if (gapState.disposing && !gapState.fired) {
        gapState.fired = true;
        gapState.value = await opts.onUnroute!(page).catch((e: unknown) => e);
      }
      return unroute(...a);
    };
  }
  const progressLines: string[] = [];
  const captures: SubmitCapture[] = [];
  const track: Track = (p) => { tracked.push(p); };
  // The adapter's own progress line at the hand-over is the moment a watching person can click.
  const adapter: RecipeAdapter = new RecipeAdapter(recipeFor(k, opts.extraSteps ?? [], opts.at), {}, {}, {
    ...(opts.autoSubmit ? { autoSubmit: true } : {}),
    // What index.ts stageWithRecipe passes when its caller watches for the person's submit.
    ...(opts.handOver === false ? {} : { handOverReview: true }),
    onProgress: (p) => {
      progressLines.push(String(p.message ?? ""));
      if (/the page is yours/i.test(String(p.message ?? "")) && !handOverSeenAt) handOverSeenAt = Date.now();
      if (/the page is yours/i.test(String(p.message ?? "")) && opts.onHandOver && !pending) pending = opts.onHandOver(page, adapter).then((v) => { extra = v; }, (e) => { extra = e; });
      if (String(p.message ?? "") === NOT_HANDED_OVER_NOTE && opts.onRefused && !pending) pending = opts.onRefused(page, adapter).then((v) => { extra = v; }, (e) => { extra = e; });
    },
  });
  (adapter as unknown as { page: unknown }).page = page;
  // The run's review read-back (an instance wrap: the method's source, which humanHandover.test
  // scans, is untouched).
  // The run's tail sweep of the page it ends on (emptyRequiredControls, after its last step, its
  // re-assert and gap-fill, BEFORE its input watch is armed): onTailSweep's person acts there, awaited
  // (an instance wrap, as above).
  if (opts.onTailSweep) {
    const a = adapter as unknown as { emptyRequiredControls: (...x: unknown[]) => Promise<unknown> };
    const sweep = a.emptyRequiredControls.bind(adapter);
    a.emptyRequiredControls = async (...x: unknown[]) => { await opts.onTailSweep!(page).catch(() => null); return sweep(...x); };
  }
  if (opts.onReviewRead) {
    const a = adapter as unknown as { verifyReviewScreen: (...x: unknown[]) => Promise<unknown> };
    const verify = a.verifyReviewScreen.bind(adapter);
    a.verifyReviewScreen = (...x: unknown[]) => { opts.onReviewRead!(page, track); return verify(...x); };
  }
  // Spy the backstop the run installs: note when its input watch is armed (and run onArmed then).
  const spy = setInterval(() => {
    const bs = backstopFor(page) as (FilingBackstop & { __spied?: boolean }) | null;
    if (!bs || bs.__spied) return;
    bs.__spied = true;
    spied.bs = bs;
    const orig = bs.watchHumanInput.bind(bs);
    bs.watchHumanInput = async () => {
      if (opts.onBeforeArm) await opts.onBeforeArm(page, track);
      if (opts.armFails) return false;
      const r = opts.onArming ? (await Promise.all([orig(), opts.onArming(page).catch(() => null)]))[0] : await orig();
      watchArmed = watchArmed || r;
      if (r && opts.onArmed) await opts.onArmed(page, track);
      return r;
    };
    // The moment the run locks the page (after its own save drained): onLock's person acts.
    if (opts.onLock) {
      const lockReview = bs.lockReview.bind(bs);
      bs.lockReview = (...a: Parameters<FilingBackstop["lockReview"]>) => { const v = lockReview(...a); opts.onLock!(page, track); return v; };
    }
    // THE RUN IS STILL FINISHING WHEN THE PERSON ACTS. On this local fixture the run's tail takes
    // milliseconds (on a real portal its review read-back and screenshots take seconds), so the
    // backstop is let go only once the person's action, and the page it led to, have settled.
    const dispose = bs.dispose.bind(bs);
    bs.dispose = async () => { if (pending) tracked.push(pending); await Promise.allSettled(tracked); if (tracked.length) await sleep(1500); gapState.disposing = true; return dispose(); };
    // The moment the run starts draining its own save is when onDrain's person acts (whatever the
    // run's tail took to get there).
    if (opts.onDrain) {
      const openDrain = bs.openDrain.bind(bs);
      let fired = false;
      bs.openDrain = (pg: unknown, why: string) => {
        const first = !fired;
        if (first) { fired = true; opts.onDrain!(page, track); }
        const close = openDrain(pg, why);
        return () => { if (first) drain.closedAt = Date.now(); close(); };
      };
    }
  }, 2);
  const project = { id: `p-${k}` } as ProjectRecord;
  const fill = await adapter.fillApplication(project);
  clearInterval(spy);
  if (pending) await pending;
  await sleep(600);
  // What the runner does next for a left-open window (index.ts armSubmitCapture): register for the
  // person's submit — one seen during the run is handed on at once.
  const observed: string[] = [];
  await adapter.armSubmitWatch((label?: string) => { observed.push(label || "(completion page)"); }).catch(() => false);
  // …and, when asked, the runner's own capture of the person's submit (reads 4 s after the click).
  if (opts.capture) await armSubmitCapture(adapter, { onSubmitCaptured: (c) => { captures.push(c); } });
  if (opts.afterFill) await opts.afterFill(page).catch(() => null);
  await sleep(opts.settleMs ?? 2000); // a completion page's read lands ~1.2 s after its load
  if (opts.capture) {
    const t0 = Date.now();
    while (Date.now() - t0 < (opts.captureWaitMs ?? 6000) && captures.length < observed.length) await sleep(50);
  }
  const review = await adapter.stopAtReview();
  const navDocuments = [...((adapter as unknown as { navDocuments?: Array<{ url: string; method: string; at?: number }> }).navDocuments ?? [])];
  await ctx.close().catch(() => null);
  return {
    ok: fill.ok, message: String(fill.message ?? ""), data: (fill.data ?? {}) as Record<string, unknown>,
    pauseReason: String((fill as { pauseReason?: unknown }).pauseReason ?? ""),
    review: { ok: review.ok, message: String(review.message ?? ""), data: (review.data ?? {}) as Record<string, unknown> },
    posts: postsFor(k, from).map((p) => p.path), watchArmed, handedOver: /the page is yours/.test(String(fill.message ?? "")) || watchArmed, extra,
    observed,
    humanRequests: (spied.bs?.humanRequests ?? []).map((r) => r.where.replace(base, "")),
    drainClosedAt: drain.closedAt,
    handOverSeenAt,
    navDocuments,
    aborts: (spied.bs?.aborts ?? []).map((a) => ({ where: a.where.replace(base, ""), rule: a.rule, human: !!a.humanInput, at: a.at })),
    gap: gapState.value,
    progressLines,
    captures,
  };
}
/** The person's request was said plainly, and nobody was told to "click submit manually". */
const saidPlainly = (r: Replay): boolean => {
  const notes = (r.review.data.reviewHandoffNotes as string[] | undefined) ?? [];
  return notes.includes(PERSON_REQUEST_WENT_NOTE) && !/click submit manually/i.test(r.review.message);
};
const rbrief = (r: Replay): string => JSON.stringify({ ok: r.ok, pause: r.pauseReason, posts: r.posts, msg: r.message.slice(0, 260), review: { ok: r.review.ok, msg: r.review.message.slice(0, 200), human: r.review.data.humanSubmittedInReviewWindow }, armed: r.watchArmed, observed: r.observed, humanRequests: r.humanRequests, extra: r.extra instanceof Error ? r.extra.message.slice(0, 160) : r.extra }).slice(0, 1100);

{
  const r = await replay("B1", { onHandOver: (page) => personClicks(page) });
  check("B1 the person clicks the portal's submit the moment the run hands the page over: the POST reaches the portal",
    r.posts.filter((p) => /\/apply\/submit$/.test(p)).length === 1, rbrief(r));
  check("B1 …the run is NOT failed", r.ok === true, rbrief(r));
  check("B1 …and it reports the person's submit from the review window (automation clicked nothing)",
    r.review.ok === true && r.review.data.humanSubmittedInReviewWindow === true && r.review.data.finalSubmitClicked === false, rbrief(r));
  // Round 4 (Helm Blocking 1): the run's record of committed documents says WHEN each committed — the
  // capture's "a main-frame document committed by a non-GET request within a short bound".
  const done = r.navDocuments.find((d) => /\/apply\/submit$/.test(d.url) && d.method === "POST");
  check("B1 …the completion document the person's POST committed is recorded with when it committed (`at` after the hand-over)",
    !!done && typeof done.at === "number" && r.handOverSeenAt > 0 && done.at >= r.handOverSeenAt,
    `handOverSeenAt=${r.handOverSeenAt} navDocuments=${JSON.stringify(r.navDocuments.map((d) => ({ ...d, url: d.url.replace(base, "") })))}`);
  // Helm Should-fix 11 (GUARD, green before by design): the capture STARTS — the runner's watch is
  // handed the person's submit once, and the hand-off says they filed.
  check("B1 …the runner's submit watch is handed the person's submit exactly once (the capture starts)", r.observed.length === 1, rbrief(r));
  check("B1 …and HUMAN_SUBMITTED_NOTE is in the hand-off (reviewHandoffNotes)",
    ((r.review.data.reviewHandoffNotes as string[] | undefined) ?? []).includes(HUMAN_SUBMITTED_NOTE), rbrief(r));
  // Round 4 (Helm nit "word a held click with no person's input as 'A click on X'"): the sighting is
  // stamped, when it is seen, with whether the person's own input reached the page in the last 2 s.
  check("B1 …the submit is stamped as the person's own input (humanSubmitPersonInput true)",
    r.review.data.humanSubmitPersonInput === true, rbrief(r));
}
{
  // Helm Should-fix 11 — B1b: the click lands right after the run LOCKS review (the real lock first, so
  // the click meets the locked page, not the drain window — that is B7's case).
  const r = await replay("B1b", { onLock: (page, track) => track(personClicks(page)) });
  const all = JSON.stringify({ m: r.message, d: r.data, rm: r.review.message, rd: r.review.data, p: r.progressLines });
  check("B1b the person clicks the portal's submit right after the run locks review (after the lock, not before 'the page is yours'): the POST reaches the portal",
    r.posts.filter((p) => /\/apply\/submit$/.test(p)).length === 1, rbrief(r));
  check("B1b …the run is NOT failed", r.ok === true, rbrief(r));
  check("B1b …it reports the person's submit from the review window, and the runner's watch is handed it once",
    r.review.data.humanSubmittedInReviewWindow === true && r.review.data.finalSubmitClicked === false && r.observed.length === 1, rbrief(r));
  check("B1b …HUMAN_SUBMITTED_NOTE is in the hand-off",
    ((r.review.data.reviewHandoffNotes as string[] | undefined) ?? []).includes(HUMAN_SUBMITTED_NOTE), rbrief(r));
  check("B1b …and never 'YOUR CLICK WAS HELD BACK' (the armed watch saw the click)", !all.includes("YOUR CLICK WAS HELD BACK"), rbrief(r));
}
{
  // The click settles (its watch report and its held request) before the run can hand over: the watch
  // stamps an input when its report reaches the run, so a click a few ms before the hand-over could
  // otherwise count as after it — and a person's own click after the hand-over is let through.
  const r = await replay("B2", { onArmed: async (page) => { await personClicks(page); await sleep(500); } });
  check("B2 the person clicks BEFORE the hand-over: held, nothing reached the portal", r.posts.length === 0, rbrief(r));
  check("B2 …the run is not failed, and it says plainly to click again", r.ok === true && (r.message.includes(HUMAN_CLICK_HELD_NOTE) || JSON.stringify(r.data).includes("YOUR CLICK WAS HELD BACK") || JSON.stringify(r.review.data).includes("YOUR CLICK WAS HELD BACK")), rbrief(r));
  check("B2 …and the error page a held click leaves is not 'where the run stopped' (never 'stopped before review')", r.pauseReason !== "stopped_before_review", rbrief(r));
  // GUARD (Helm Should-fix 3, green before by design): a click the ARMED watch saw is flagged, so the
  // run still hands the page over. Kill: refuse the hand-over on ANY stopping abort (drop the
  // `!a.humanInput` from the run's unflaggedStop) and this goes red.
  check("B2 …a click the watch saw still hands the page over ('the page is yours', never NOT_HANDED_OVER_NOTE)",
    r.progressLines.some((l) => /the page is yours/i.test(l)) && !r.progressLines.includes(NOT_HANDED_OVER_NOTE)
      && !((r.data.driftWarnings as string[] | undefined) ?? []).includes(NOT_HANDED_OVER_NOTE), JSON.stringify(r.progressLines.slice(-4)));
}
{
  const r = await replay("B3", {
    onHandOver: async (page, adapter) => {
      const click = (adapter as unknown as { guardedClick: (t: unknown, why: string) => Promise<void> }).guardedClick.bind(adapter);
      return click(page.locator("#btnSubmit"), "smoke B3: automation clicks after the hand-over");
    },
  });
  check("B3 automation tries to click after the hand-over: the replay refuses its own input, nothing reached the portal",
    r.posts.length === 0 && r.extra instanceof Error && /handing the page to a person/.test((r.extra as Error).message), rbrief(r));
}
{
  const r = await replay("B4", { autoSubmit: true });
  check("B4 an approved (autoSubmit) run is never handed over: the input watch is never armed", r.watchArmed === false && r.posts.length === 0, rbrief(r));
}
{
  // B10 (Helm Should-fix 4): the run ends on an attachments step, not the review page. Its text and its
  // /attachments URL do not read as review, and "Continue Application" is no final submit, so the click
  // detector never fires (humanSubmit stays unset) — either slipping would make this a review-page case.
  const r = await replay("B10", { at: "attachments", onHandOver: (page) => personClicks(page, "#btnContinue") });
  const at = `STOPPED on "Step 2: Attachments" — NOT the review page`;
  const said = `${r.message} ${r.review.message}`;
  check("B10 the run stopped on an attachments step and the person clicks Continue at 'the page is yours': their POST goes (1 POST)",
    r.posts.length === 1 && /\/apply\/continue$/.test(r.posts[0] ?? ""), rbrief(r));
  check("B10 …the run pauses stopped_before_review, naming where it stopped",
    r.pauseReason === "stopped_before_review" && r.message.includes(at), rbrief(r));
  check("B10 …the review step says the same (stoppedBeforeReview), never that it staged the review screen",
    r.review.data.stoppedBeforeReview === true && r.review.message.includes(at) && !/staged the review screen|stopped at review/i.test(said), rbrief(r));
  check("B10 …and the progress line that handed the page over said so too (never 'Staged to review')",
    r.progressLines.some((l) => l.startsWith(`Stopped on "Step 2: Attachments" — NOT the review page; the page is yours`)) && !r.progressLines.some((l) => /Staged to review/i.test(l)),
    JSON.stringify(r.progressLines.slice(-4)));
}
{
  // B11 (Helm Should-fix 4): a caller that does not watch for the person's submit (the learn self-test,
  // runCrossProjectReplay, runReplayBenchmark pass no onSubmitCaptured) is never handed the page: a
  // person's click right after the lock is held by the lockdown and fails the run by name, as on main.
  const r = await replay("B11", { handOver: false, onLock: (page, track) => track(personClicks(page)) });
  check("B11 a caller with no onSubmitCaptured is never handed over: the watch is never armed, nobody is told 'the page is yours'",
    r.watchArmed === false && !r.progressLines.some((l) => /the page is yours/i.test(l)), rbrief(r));
  check("B11 …the person's click at the lock reaches nothing (0 POSTs)", r.posts.length === 0, rbrief(r));
  check("B11 …and the run fails by name (STOPPED BY THE NETWORK BACKSTOP), never reporting the person's submit",
    r.ok === false && r.message.includes("STOPPED BY THE NETWORK BACKSTOP") && r.review.data.humanSubmittedInReviewWindow !== true, rbrief(r));
}
/** Helm Should-fix 3: a run that holds an UNFLAGGED stopping abort (a click the watch did not see) is
 *  never handed over — 0 filing POSTs, failed by name, NOT_HANDED_OVER_NOTE in the fill and the review
 *  step, never "the page is yours", never "YOUR CLICK WAS HELD BACK". Asserted on driftWarnings and
 *  reviewHandoffNotes, never on pauseReason. */
const refusedHandOver = (k: string, r: Replay): void => {
  const all = JSON.stringify({ m: r.message, d: r.data, rm: r.review.message, rd: r.review.data });
  check(`${k} …nothing reached the portal's submit (0 POSTs to /apply/submit)`, !r.posts.some((p) => /\/apply\/submit$/.test(p)), rbrief(r));
  check(`${k} …the run fails by name (STOPPED BY THE NETWORK BACKSTOP), never reporting the person's submit`,
    r.ok === false && r.message.includes("STOPPED BY THE NETWORK BACKSTOP") && r.review.data.humanSubmittedInReviewWindow !== true, rbrief(r));
  check(`${k} …the hand-over is refused and said: NOT_HANDED_OVER_NOTE in the fill's driftWarnings, the review step's notes and the progress line`,
    ((r.data.driftWarnings as string[] | undefined) ?? []).includes(NOT_HANDED_OVER_NOTE)
      && ((r.review.data.reviewHandoffNotes as string[] | undefined) ?? []).includes(NOT_HANDED_OVER_NOTE)
      && r.progressLines.includes(NOT_HANDED_OVER_NOTE), JSON.stringify(r.progressLines.slice(-4)));
  check(`${k} …nobody is told 'the page is yours'`, !r.progressLines.some((l) => /the page is yours/i.test(l)), JSON.stringify(r.progressLines.slice(-4)));
  check(`${k} …and never 'YOUR CLICK WAS HELD BACK' (no 'click again' on a run that fails)`, !all.includes("YOUR CLICK WAS HELD BACK"), rbrief(r));
};
{
  // B13 (Helm Should-fix 3, "a click during the last writes"): the run ticks the review page's box (the
  // portal reads "Saving..." for 8 s), runs out of steps and re-asserts, gap-fills and sweeps the page
  // it ends on — its tail, BEFORE its input watch is armed and after the step loop's own backstop
  // check. The person clicks the portal's (fetch) submit at that sweep: the watch is not listening, so
  // the backstop holds the filing UNFLAGGED. Then, at the progress line that refuses the hand-over (or,
  // before the fix, at "the page is yours"), the person clicks again. The refusal BEFORE ARMING is what
  // this pins: armed anyway, the watch would flag the second click as a held click and the run would
  // say "click again" while it fails by name.
  let clickedAt = 0;
  let armCalledAt = 0;
  const r = await replay("B13", {
    extraSteps: [TICK],
    onTailSweep: async (page) => {
      if (clickedAt) return;
      clickedAt = Date.now();
      await personClicks(page);
      await sleep(500);
    },
    onBeforeArm: async () => { armCalledAt = armCalledAt || Date.now(); },
    onRefused: (page) => personClicks(page),
    onHandOver: (page) => personClicks(page),
  });
  check("B13 the person's first click landed in the run's tail, before any arm (and was held unflagged)",
    clickedAt > 0 && (armCalledAt === 0 || clickedAt < armCalledAt) && r.aborts.some((a) => /\/apply\/submit$/.test(a.where) && !a.human && (a.at ?? 0) >= clickedAt),
    `clickedAt=${clickedAt} armCalledAt=${armCalledAt} aborts=${JSON.stringify(r.aborts)}`);
  check("B13 …the watch is never armed once an unflagged stop is on record", r.watchArmed === false, rbrief(r));
  refusedHandOver("B13", r);
}
{
  // B14 (Helm Should-fix 3, "one during arming"): a person's click at the moment the run arms its watch
  // (inside watchHumanInput, before the arm itself): the watch did not see it, so it is held UNFLAGGED,
  // and the refusal JUST BEFORE handOverReviewPage is what this pins. The fetch submit leaves the review
  // page where it was (a form POST would leave Chromium's error page under the arm).
  const r = await replay("B14", { onBeforeArm: async (page) => { await personClicks(page); await sleep(500); } });
  check("B14 a person's click as the run arms its watch is held unflagged", r.aborts.some((a) => /\/apply\/submit$/.test(a.where) && !a.human), JSON.stringify(r.aborts));
  refusedHandOver("B14", r);
}
{
  // B14b: the same refusal for a filing request recorded WHILE the arm runs (a page-script fetch run
  // alongside the real arm — the abort record a person's click inside the 12-19 ms arm leaves; a raw
  // mouse click concurrent with the arm is a race the watch may or may not see, so this deterministic
  // stand-in is the pin).
  const r = await replay("B14b", {
    onArming: (page) => page.evaluate(() => fetch("/h/B14b/apply/submit", { method: "POST", body: "x=1" }).then(() => 0, () => 0)),
  });
  check("B14b a filing request recorded during the arm is held unflagged", r.aborts.some((a) => /\/apply\/submit$/.test(a.where) && !a.human), JSON.stringify(r.aborts));
  refusedHandOver("B14b", r);
}
{
  // B12 (Helm Should-fix 12, "a failed arm and a click at the lock"): the input watch cannot be armed
  // (the spy reports false without arming anything, the real failed-arm shape: no sink), and the person
  // clicks the portal's submit right after the lockdown. Fail closed AND say so: never "the page is
  // yours", the whole NOT_HANDED_OVER_NOTE as its own progress line and in the hand-off, 0 POSTs. r.ok
  // is not asserted: the click's abort is unflagged, so the run fails by name, as on main.
  const r = await replay("B12", { armFails: true, onLock: (page, track) => track(personClicks(page)) });
  const all = JSON.stringify({ m: r.message, d: r.data, rm: r.review.message, rd: r.review.data });
  check("B12 the watch cannot be armed and the person clicks at the lock: nobody is told 'the page is yours'",
    r.watchArmed === false && !r.progressLines.some((l) => /the page is yours/i.test(l)), JSON.stringify(r.progressLines.slice(-4)));
  check("B12 …the whole NOT_HANDED_OVER_NOTE is a progress line, in the fill's driftWarnings and in the review step's notes",
    r.progressLines.includes(NOT_HANDED_OVER_NOTE)
      && ((r.data.driftWarnings as string[] | undefined) ?? []).includes(NOT_HANDED_OVER_NOTE)
      && ((r.review.data.reviewHandoffNotes as string[] | undefined) ?? []).includes(NOT_HANDED_OVER_NOTE),
    JSON.stringify(r.progressLines.slice(-4)));
  check("B12 …the click reaches nothing (its filing is held by the lockdown, 0 POSTs) and no submit is reported",
    r.aborts.some((a) => /\/apply\/submit$/.test(a.where)) && r.posts.length === 0 && r.observed.length === 0 && r.review.data.humanSubmittedInReviewWindow !== true, rbrief(r));
  check("B12 …and never 'YOUR CLICK WAS HELD BACK'", !all.includes("YOUR CLICK WAS HELD BACK"), rbrief(r));
}

{
  // B5 (skeptic r2 F1): after the hand-over the person saves for later — their own request goes — and
  // lands on "My Records", a list headed "Record Number" with ANOTHER application's number.
  const r = await replay("B5", { onHandOver: (page) => personClicks(page, "#saveLater") });
  check("B5 a person's request after the hand-over, then a records list: the request went", r.posts.some((p) => /\/api\/save-later$/.test(p)), rbrief(r));
  check("B5 …the records list is NOT taken for a filing: no submit reported, nothing handed to the capture",
    r.observed.length === 0 && r.review.data.humanSubmittedInReviewWindow !== true, rbrief(r));
  check("B5 …the request that went is said plainly ('if it was the submit, enter its number')", saidPlainly(r), rbrief(r));
  check("B5 …and the run is not 'stopped before review' (the person moved on from the page it handed over)", r.ok === true && r.pauseReason !== "stopped_before_review", rbrief(r));
}
{
  // B6 (skeptic r2 F3): a fetch submit, then location.href to the completion page, under a label the
  // click classifier does not know.
  const r = await replay("B6", { onHandOver: (page) => personClicks(page, "#send") });
  check("B6 a fetch submit after the hand-over reaches the portal", r.posts.filter((p) => /\/api\/application$/.test(p)).length === 1, rbrief(r));
  check("B6 …the run is not failed and not 'stopped before review'", r.ok === true && r.pauseReason !== "stopped_before_review", rbrief(r));
  check("B6 …what the page it led to reads is never taken for a filing (the click detector did not see a final submit)",
    r.observed.length === 0 && r.review.data.humanSubmittedInReviewWindow !== true, rbrief(r));
  check("B6 …and the request that went is said plainly, never 'click submit manually'", saidPlainly(r), rbrief(r));
}
{
  // B7 (skeptic r2 F2): the run ticks a box on the review page, the portal reads "Saving...", and the
  // person clicks the fetch submit the moment the run starts draining that save (the run's own steps
  // wait the indicator out first, so the drain is short; the tick's own report arrived while it was
  // in flight).
  let clickedAt = 0;
  const r = await replay("B7", {
    extraSteps: [TICK],
    onDrain: (page, track) => { track(personClicks(page, "#send").then(() => { clickedAt = Date.now(); })); },
  });
  check("B7 a person's fetch submit reaches the portal, clicked while the run's drain was open",
    r.posts.filter((p) => /\/api\/application$/.test(p)).length === 1 && clickedAt > 0 && r.drainClosedAt > 0 && clickedAt < r.drainClosedAt,
    `clickedAt=${clickedAt} drainClosedAt=${r.drainClosedAt} ${rbrief(r)}`);
  check("B7 …and is recorded as the person's request (never taken by the drain's own-save exemption)", r.humanRequests.some((w) => /\/api\/application$/.test(w)), rbrief(r));
  check("B7 …the run is not failed and not 'stopped before review'", r.ok === true && r.pauseReason !== "stopped_before_review", rbrief(r));
  check("B7 …and the request that went is said plainly, never 'click submit manually'", saidPlainly(r), rbrief(r));
}
{
  // B8 (skeptic r2 F1): after the run has let go (its backstop disposed), the person opens an OLDER
  // record whose page says "Your application has been received".
  const r = await replay("B8", { afterFill: (page) => personClicks(page, "#older") });
  check("B8 an older record opened after the run let go is NOT taken for this run's filing",
    r.observed.length === 0 && r.review.data.humanSubmittedInReviewWindow !== true, rbrief(r));
}
{
  // B9 (skeptic r2b): the person clicks "Pay Fees" after the hand-over. Payment is never lifted, so it
  // is aborted; that is the person's own click after the hand-over, not one held back before it.
  const r = await replay("B9", { onHandOver: (page) => personClicks(page, "#pay") });
  const all = JSON.stringify({ m: r.message, d: r.data, rm: r.review.message, rd: r.review.data });
  check("B9 the person's payment click after the hand-over is aborted (automation never pays; the run still holds the page)", r.posts.length === 0, rbrief(r));
  check("B9 …the run is not failed, and never says the click came before the hand-over", r.ok === true && !all.includes("YOUR CLICK WAS HELD BACK"), rbrief(r));
}

{
  // B17 (Helm nit :97, "a popup's contact form excused a later review-page filing abort"): after the
  // hand-over the person opens the review page's "Contact us" popup and sends its form (their own
  // input in THAT page: its document POST goes, recorded as theirs with page = the popup). More than
  // the 4 s input window after their click on the review page, a page script there submits the
  // filing form with no input of theirs: aborted, and the run fails by name — the popup's document
  // request is not the handed-over page's. Red while firstHumanDocument took the first document
  // request of ANY page: the review page's abort indexed after the popup's and was excused (ok).
  const r = await replay("B17", {
    onHandOver: async (page) => {
      const popupP = page.context().waitForEvent("page", { timeout: 5000 });
      const clickedAt = Date.now();
      await personClicks(page, "#help");
      const popup = await popupP;
      await popup.waitForLoadState("load");
      await Promise.all([popup.waitForLoadState("load"), personClicks(popup, "#sendMsg")]);
      await sleep(400);
      // Past the review page's own 4 s input window (HUMAN_INPUT_MS), so its script's request is
      // never the person's on that count alone.
      const wait = 4600 - (Date.now() - clickedAt);
      if (wait > 0) await sleep(wait);
      await page.evaluate(() => (document.forms[0] as HTMLFormElement).submit()).catch(() => null);
      await sleep(900);
    },
  });
  check("B17 the person's popup contact form went (their own input in the popup; the precondition)",
    r.posts.some((p) => /\/contact\/send$/.test(p)) && r.humanRequests.some((w) => /\/contact\/send$/.test(w)), rbrief(r));
  check("B17 …then a page script's filing submit on the review page: 0 POSTs to /apply/submit",
    r.posts.filter((p) => /\/apply\/submit$/.test(p)).length === 0 && r.aborts.some((a) => /\/apply\/submit$/.test(a.where) && !a.human), rbrief(r));
  check("B17 …and the run fails by name: the popup's request does not excuse the handed-over page's abort",
    r.ok === false && /STOPPED BY THE NETWORK BACKSTOP/.test(r.message), rbrief(r));
}
{
  // B17b (positive twin, GUARD — green before by design): the person's own document submit on the
  // handed-over page goes, and on the completion page it led to a script then tries a filing POST
  // (aborted). The run is NOT failed: the run's own page's document request is found, which holds
  // only while the backstop's record of the requesting page (request.frame().page()) is the SAME
  // object as the adapter's page in real Chromium. Kill Kp: record `page: null` at the push site.
  const r = await replay("B17b", {
    onHandOver: async (page) => {
      await Promise.all([page.waitForLoadState("load"), personClicks(page)]);
      await page.waitForURL(/\/apply\/submit$/, { timeout: 5000 }).catch(() => null);
      await page.evaluate(() => fetch("/h/B17b/apply/submit", { method: "POST", body: "auto=1" }).then(() => "sent", () => "aborted")).catch(() => null);
      await sleep(600);
    },
  });
  check("B17b the person's own submit on the handed-over page went (1 POST), the completion page's script POST was aborted",
    r.posts.filter((p) => /\/apply\/submit$/.test(p)).length === 1 && r.aborts.some((a) => /\/apply\/submit$/.test(a.where) && !a.human), rbrief(r));
  check("B17b …and the run is not failed: that abort follows the handed-over page's own document request",
    r.ok === true && !/STOPPED BY THE NETWORK BACKSTOP/.test(r.message), rbrief(r));
}

// ---------------------------------------------------------------------------------------------
// [C] The capture
// ---------------------------------------------------------------------------------------------
console.log("\n[C] THE CAPTURE (Helm Blocking 1)");
{
  // C9 (Helm Blocking 1, "a person's filing during `dispose`"): the run is letting go — `disposed` is
  // set, the route is not yet off — and the person clicks the portal's submit. Held open by the
  // harness until the fixture has counted the POST (or 4 s pass with nothing counted).
  const r = await replay("C9", {
    onUnroute: async (page) => {
      const before = posts.length;
      const clickAt = Date.now();
      await personClicks(page);
      const t0 = Date.now();
      while (Date.now() - t0 < 4000 && !postsFor("C9", before).length) await sleep(25);
      return clickAt;
    },
  });
  const clickAt = typeof r.gap === "number" ? r.gap : 0;
  const detail = `clickAt=${clickAt} aborts=${JSON.stringify(r.aborts)} ${rbrief(r)}`;
  check("C9 a person's filing during the run's dispose: it goes (exactly one POST reaches /apply/submit)",
    clickAt > 0 && r.posts.filter((p) => /\/apply\/submit$/.test(p)).length === 1, detail);
  // An abort in the gap is what the run would later read as a held — or "may have gone" — filing.
  check("C9 …nothing is aborted at or after the click (the disposed backstop judges nothing)",
    clickAt > 0 && !r.aborts.some((a) => (a.at ?? 0) >= clickAt), detail);
  check("C9 …and the run is not failed (no stopping abort of its own making in the gap)", r.ok === true, detail);
}
// The numbers the runner's capture recorded (index.ts reports any non-empty number HIGH, and the
// backend records exactly those): "never recorded" means never in this list.
const recorded = (r: Replay): string[] => r.captures.filter((c) => !!c.recordNumber).map((c) => c.recordNumber);
const cbrief = (r: Replay): string => JSON.stringify({ posts: r.posts, observed: r.observed, captures: r.captures.map((c) => `${c.recordNumber || "-"}/${c.confidence}/${c.source}`), aborts: r.aborts.map((a) => `${a.rule}:${a.where}`), human: r.review.data.humanSubmittedInReviewWindow, msg: r.review.message.slice(0, 160) }).slice(0, 900);
// A capture case: the person acts at "the page is yours" (onHandOver), and — when given — again LATE,
// after the run let go and after a capture of the first click would have read the page (afterFill
// waits LATE_MS first).
const LATE_MS = 7000;
const captureCase = (k: string, first: (page: Page) => Promise<unknown>, late?: (page: Page) => Promise<unknown>, settleMs = 9000): Promise<Replay> =>
  replay(k, {
    capture: true, settleMs,
    onHandOver: first,
    ...(late ? { afterFill: async (page: Page) => { await sleep(LATE_MS); await late(page); } } : {}),
  });
{
  // C1: an Accela review with an empty required box — the tail click is held by the browser (nothing
  // sent); then, late, the person types their initials and clicks again. Red before: the first click
  // spent the one-shot detector, the capture read the review page 4 s later and recorded its own id
  // (26TMP-004411) HIGH, and the real filing was never captured.
  const r = await captureCase("C1", (page) => personClicks(page), async (page) => {
    await personClicks(page, "#initials");
    await page.keyboard.type("AB");
    await personClicks(page);
  });
  check("C1 the Accela review's own id (26TMP-004411) is never recorded after a click that sent nothing", !recorded(r).includes(TMP_ID), cbrief(r));
  check("C1 …and the person's real re-click is captured: 187-26-000328-STR recorded",
    recorded(r).includes("187-26-000328-STR") && r.posts.filter((p) => /\/apply\/submit$/.test(p)).length === 1, cbrief(r));
}
for (const [k, id] of [["C2", "APP-7734120"], ["C19", "NEM-204411"]] as const) {
  // C2 / C19: a dismissed confirm() on a review page showing a PowerClerk APP- id (C2) or PSE Part 2's
  // NEM- header (C19): nothing is sent. Red before: the click spent the detector and the review's own
  // id was recorded HIGH off the review page.
  const r = await captureCase(k, (page) => personClicks(page));
  check(`${k} a dismissed confirm() (nothing sent): no number recorded (never ${id}) and no submit handed on`,
    r.posts.length === 0 && recorded(r).length === 0 && r.observed.length === 0, cbrief(r));
}
{
  // C3: a Submit that sends nothing, then the person opens "My Applications" (a GET): status cells and
  // ANOTHER application's number. Red before: 187-26-000100-STR recorded HIGH ("it has been filed").
  const r = await captureCase("C3", async (page) => { await personClicks(page); await sleep(800); await Promise.all([page.waitForLoadState("load"), personClicks(page, "#myapps")]); });
  check("C3 a Submit that sent nothing, then 'My Applications': no number recorded (never 187-26-000100-STR), no submit handed on",
    recorded(r).length === 0 && r.observed.length === 0, cbrief(r));
  // C3b: the Submit's only request is an analytics fetch (the click commits on it), then the person
  // opens "My Applications" by GET. A page reached by navigation alone never yields a number. Red
  // before: 187-26-000100-STR recorded HIGH.
  const r3b = await captureCase("C3b", async (page) => { await personClicks(page); await sleep(800); await Promise.all([page.waitForLoadState("load"), personClicks(page, "#myapps")]); });
  check("C3b an analytics fetch, then 'My Applications' by GET: no number recorded (navigation alone never takes one)",
    recorded(r3b).length === 0 && r3b.posts.some((p) => /\/t\/collect$/.test(p)), cbrief(r3b));
}
{
  // C4: the first Submit posts to a payment URL — rule 1 holds it (0 POSTs there) — then, late, the
  // person clicks the real submit. Red before: the held click spent the detector; the re-click was
  // never captured.
  const r = await captureCase("C4", (page) => personClicks(page), (page) => personClicks(page, "#btnSubmit2"));
  check("C4 the held payment-URL submit sent nothing (rule 1), and the re-click's filing is captured",
    !r.posts.some((p) => /payment/.test(p)) && recorded(r).includes(RECORD), cbrief(r));
}
{
  // C5 (GUARD, green before by design: the click committed on sight): a postback to the review page's
  // OWN URL is evidence like any other POST. Kill: commit only on a request to another URL than the
  // handed-over page's.
  const r = await captureCase("C5", (page) => personClicks(page));
  check("C5 a postback to the review page's own URL is captured (URL identity is never the evidence)", recorded(r).includes("187-26-000505-STR"), cbrief(r));
}
for (const [k, n] of [["C6a", "187-26-000601-STR"], ["C6b", "187-26-000602-STR"], ["C7", "187-26-000707-STR"], ["C8", "BLD-2026-900888"]] as const) {
  // C6a/C6b/C7/C8 (GUARD pins, green before by design: the click committed on sight and the harness's
  // read landed after the page changed): the portal sends the filing 2.5 s / 4 s after the click, after
  // the run let go — a form POST (C6a/C6b), a postback to the review URL (C7), an in-place fetch submit
  // to a URL that is not filing-shaped that re-renders the DOM (C8). Kills: release a pending click
  // after a fixed 1.5 s (C6-C8); commit late only on another URL (C7); drop late non-filing fetches (C8).
  const r = await captureCase(k, (page) => personClicks(page), undefined, 11_000);
  check(`${k} the portal's filing after the run let go is committed late and captured (${n})`, recorded(r).includes(n), cbrief(r));
}
{
  // C10: a single-page app whose server answers the filing fetch 12 s after the click (Helm: "8 s").
  // Red before: the capture read the review page at +4 s and recorded its own 26TMP-004411 HIGH. After:
  // that read finds the review and reopens the watch; the filing request's own completion (or the one
  // slow-server re-read) commits it again and the completion is captured.
  const r = await captureCase("C10", (page) => personClicks(page), undefined, 22_000);
  check("C10 a slow server: the review's 26TMP-004411 is never recorded", !recorded(r).includes(TMP_ID), cbrief(r));
  check("C10 …and the completion read after it arrives is captured (187-26-000710-STR)", recorded(r).includes("187-26-000710-STR"), cbrief(r));
}
for (const k of ["C11", "C14"] as const) {
  // C11: an analytics fetch + pushState("?saved=1") (the page is still the review); C14: a POST that
  // re-renders the same review at /review2. Then, late, the person's real submit. Red before: the
  // review's own 26TMP-004411 recorded HIGH, the re-click never captured. Judged by content, never URL.
  const n = k === "C11" ? RECORD : "187-26-000714-STR";
  const r = await captureCase(k, (page) => personClicks(page), (page) => personClicks(page, k === "C11" ? "#btnSubmit2" : "#btnSubmit"));
  check(`${k} the review's own 26TMP-004411 is never recorded, whatever URL the review now has`, !recorded(r).includes(TMP_ID), cbrief(r));
  check(`${k} …and the person's real re-click is captured (${n})`, recorded(r).includes(n), cbrief(r));
}
{
  // C12 / C13 (GUARD pins, green before by design: extractRecordNumber's tier order). PowerClerk reuses
  // the review's APP-7734121 on its completion: captured (kill: take only numbers the review did not
  // show); and beside a "Confirmation #: PFP-2026-55120" the APP- number still wins (kill: take the first
  // new number of any shape).
  const r12 = await captureCase("C12", (page) => personClicks(page));
  check("C12 PowerClerk's completion reusing the review's own APP-7734121 is captured", recorded(r12).includes("APP-7734121"), cbrief(r12));
  const r13 = await captureCase("C13", (page) => personClicks(page));
  check("C13 …and beside a 'Confirmation #: PFP-2026-55120' the APP- number is recorded, never PFP-2026-55120",
    recorded(r13).includes("APP-7734121") && !recorded(r13).includes("PFP-2026-55120"), cbrief(r13));
}
for (const [k, label] of [["C15", "a 'submitted with errors' re-render"], ["C16", "a duplicate rejection naming 187-26-000100-STR"], ["C18", "a re-render whose history table's cell reads 'Your application has been submitted'"]] as const) {
  // C15 / C16 / C18: the person's POST went, and the portal answered with the review again — a
  // validation error, a duplicate rejection, a table whose status cell carries completion wording. Red
  // before: the review's id or the banner's / cell's number recorded HIGH and the submit stood.
  const r = await captureCase(k, (page) => personClicks(page));
  check(`${k} ${label}: no number recorded`, recorded(r).length === 0, cbrief(r));
  check(`${k} …and the click does not stand as the person's submit (the capture found the review and reopened the watch)`,
    r.review.data.humanSubmittedInReviewWindow !== true, cbrief(r));
}
for (const [k, n] of [["C17a", "BLD-2026-900777"], ["C17b", "BLD-2026-900778"]] as const) {
  // C17a / C17b (GUARD pins, green before by design: the loose read took any number): a completion with
  // no listed phrase ("Record Issued"), and one whose wording the review page already showed — a NEW
  // number on a page without the review's submit control counts. Kill: a number needs a phrase.
  const r = await captureCase(k, (page) => personClicks(page));
  check(`${k} a completion with a new number and no review form is captured (${n})`, recorded(r).includes(n), cbrief(r));
}

await browser.close();
server.close();
if (failures) { console.error(`\n${failures}/${total} humanSubmitAfterReview.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log(`\nAll ${total}/${total} humanSubmitAfterReview.dom.smoke checks passed.`);
process.exit(0);
