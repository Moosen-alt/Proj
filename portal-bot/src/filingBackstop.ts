// THE NETWORK BACKSTOP (hard rule 1): a click or key the bot makes WITHOUT a named human
// approval may never be the one that files, submits or pays.
//
// Every gate before this one reads WORDS — a control's label, a dialog's text, a form's buttons —
// and a word list loses to the next wording (the close-mustfix checker filed through four dialog
// shapes and three Enter shapes that each gate's list did not know). This layer does not care
// which control fired or what it said. It watches the requests themselves, for the whole of a
// learn or replay run — EVERY request that is not GET/HEAD/OPTIONS, from EVERY frame (the main
// frame, an iframe, a popup the context owns) and of EVERY resource type (a document navigation,
// a form posted into an iframe, XHR, fetch, a beacon) — and aborts:
//
//   1. PAYMENT RULE: a request whose URL reads as a fee payment (isPayRequestUrl). Always, in any
//      frame, of any type, even under a named approval: automation never pays.
//   2. FILING-URL RULE: a request whose URL — for a form POST, the form's action — reads as a
//      filing (isFilingOrPaymentRequest, the same predicate the demo recorder's abort asks). A
//      named approval admits ONE state-changing request in a short window after THE approved
//      final-submit click (each approved click — the submit, its confirm dialog's OK — one).
//      (close2-safety checker: this rule once held for main-frame navigations only, and an
//      iframe's "Continue", a form targeted at an iframe and a fetch POST each reached the server
//      — iframePay, iframeSubmit, targetFramePay, xhrFile, xhrPay.) KNOWN COST, fail-closed: a
//      legitimate mid-flow XHR whose URL happens to contain "submit" or "invoice" is aborted too,
//      and the run stops NAMED — never silently.
//   3. WINDOW RULE (the invariant part): ANY state-changing request fired while a bot action with
//      no legitimate reason to change server state is in flight: an overlay DISMISSER click, and a
//      bot Enter press on a page classified review/terminal. The window opens before the action
//      and closes a short grace after it, BEFORE the caller's next action (so a following recipe
//      click's ASP.NET postback is never caught in it).
//   4. REVIEW-PAGE LOCKDOWN: at review nothing legitimate needs to post, so EVERY state-changing
//      request is aborted (a) once the run has locked the page (replay's stopForReview step, the
//      learner's atReview), and (b) whenever the page the request comes from is classified
//      terminal by the SHARED in-page predicate (terminalPageInPage — the same one replay's click
//      gate asks), read at the moment of the request (a navigation request — a form POST — by
//      the page's reading at its last load, since a navigating page cannot be asked), so a page
//      script that posts a second after the review page loads is caught however fast the run
//      is. Lifted only by the approved
//      final submit's window (non-payment URLs), by dispose(), and — for a PERSON'S OWN click only —
//      by the hand-over (#333, owner ruling 2026-10-14 "we'll have to allow that in the future").
//      HAND-OVER (handOverToHuman): a guided-manual replay stopped at review hands the page to a
//      person BEFORE it drains its own pending save and before its read-only housekeeping (the
//      review read-back, screenshots), not after them.
//      From that moment a state-changing request whose page saw a TRUSTED pointer / Enter / Space
//      input within HUMAN_INPUT_MS passes rules 2 and 4 (the filing-URL rule and this lockdown):
//      the person's own submit. How a person's request is told apart from automation's — a
//      Playwright click or key press is a TRUSTED event in the page too:
//        (1) ORDERING — THE GUARANTEE: the input watch (watchHumanInput) is armed only after the
//            run's LAST input on the page, the replay refuses any input of its own from that moment
//            (recipeAdapter inputsClosed), and everything after it is reads (a source scan pins it);
//        (2) THE FENCE — A SECOND LINE for the replay's own input doors: its guarded clicks, presses,
//            typing and checkbox writes run inside withAutomationInput, and input the watch sees
//            while one is in flight, or within AUTOMATION_INPUT_GRACE_MS after it, is never recorded
//            as a person's. Helper modules' input (combobox fill, gap fill, login, signature) is not
//            fenced: the ordering covers it (all of it is awaited before the run's input closes).
//      THE TRADE-OFF, STATED (#333 skeptic round 1): for HUMAN_INPUT_MS after a person's input, ANY
//      state-changing request from that page passes rules 2 and 4 — the page's own scripts included.
//      It cannot be narrowed to "the click's own request" or "a click on a control" without holding
//      back a person's submit whose click first fires an analytics fetch, or whose control is a
//      styled div (DevHub's tiles). It lasts only until dispose() — seconds — after which main lets
//      everything through anyway. Automation's own input never opens it (the ordering).
//      Only input that arrives AFTER the hand-over counts (an input just before it is not carried
//      over), and only for the page that saw it. A page script posting with no input meets the lockdown
//      exactly as before; payment (rule 1) and an open dismisser / Enter window (rule 3, the
//      run's own action in flight) are never lifted. An abort that follows such an input is
//      flagged humanInput, so the run can say "your click was held back — click again".
//      (b) exempts the RUN'S OWN recorded write on that page while it is in flight
//      (withOwnWriteWindow: a fill / select / check whose per-field autosave posts — PowerClerk's
//      Terms checkbox at review); (a), the filing-URL rule and payment never exempt anything.
//      (b) ALSO exempts ONE request off a HUMAN-VERIFIED INFORMATION PAGE (#344, owner ruling
//      2026-10-15, option B): openInfoPagePass takes the backstop's own fresh identity read of the
//      page and its forward control, and the one predicate (shared/src/infoPagePass.ts
//      infoPagePassRefusals) must find that exact page verified by a named person, reached by the
//      exact verified steps with NOTHING entered on the run. Then one slot opens for 20 s: the
//      page's own main-frame document POST whose URL, media type and ordered [name, sha256(value)]
//      body equal the verified control's passes 4(b) — after payment, the filing-URL rule, the
//      windows and the sticky lock (4a) have all been applied, unchanged. The first request that
//      could take the slot consumes it, matched or not. With no verified page (every benchmark,
//      every test that does not opt in) no slot can open and every request meets main's rules.
//      An unverified page is held exactly as before; the held request is OBSERVED (method, URL
//      hash, media, body hashes) so the learner can record the page as a candidate for a person.
//      A page at a verified page's origin + path that reads differently is held the same way and
//      names that pass as drifted (an incident: the backend withdraws it). After an admitted click,
//      checkInfoPageAfterClick judges the page it led to: anything but POSITIVE evidence of an
//      unfiled application form (infoPageAfterClickRefusals) arms the sticky lock (4a) and is the
//      run's incident — it stops, the pass is withdrawn.
//      PROOF OF PROGRESS (round 3, structural: it reads no wording). A page that passed that
//      reading is then HELD: no state-changing request from any page passes — but the run's own
//      background writes (a non-document request such as a fetch / XHR in an open own-write window,
//      or a drain's same-origin fetch / XHR, on the requesting page; a document request in that
//      window — an AutoPostBack — is held like any other) — until the learner has recorded a fill / select / check bound to THIS JOB'S own data there and says so
//      (infoPageProofGiven). Leaving that page's document by a GET navigation first makes the proof
//      impossible (state "left": the hold stays). A held document request or filing URL stops the
//      run (as 4b's do); the learner then reports the incident (the run never entered the job's data
//      on the page the verified click led to), the pass is withdrawn, nothing is recorded as filed.
//
// Every abort is recorded (origin + path only — never a query string, which can carry a
// customer's data) so the run reports it; a filing, payment or lockdown abort also stops the run,
// named (replay: backstopStop; learner: at the next page boundary and in its result).
//
// Installed at the CONTEXT level when the page has one, so a filing that opens in a popup is
// covered too, and handed on with route.fallback() — never continue() — so a smoke's own
// context.route fixture server still answers what this layer lets through.
//
// Known cost: Playwright disables the browser's HTTP cache while any route is installed.
import { randomBytes } from "node:crypto";
import { isFilingOrPaymentRequest, isPayRequestUrl, paymentDialogVerdict, PORTAL_SAFETY_GLOBAL, PORTAL_SAFETY_IN_PAGE_SOURCE } from "../../shared/src/portalSafety";
import {
  digestInfoPageIdentity, infoPageAfterClickAckWording, infoPageAfterClickRefusals, infoPageDriftedEntries, infoPageNumberTokens, infoPageMatchRefusals, infoPageObservedRequest, infoPagePassEntry, infoPagePassRefusals,
  infoPagePrefixOf, infoPageProjectValueRefusals, infoPageRequestRefusals, isMatchClassRefusal,
  type InfoPageAfterClickBaseline, type InfoPageAfterClickReading, type InfoPageDigest, type InfoPageExpectedRequest, type InfoPageIdentityMaterial, type InfoPageIdentityReading,
  type InfoPageObservedRequest, type InfoPagePrefixStep, type InfoPageRunState,
} from "../../shared/src/infoPagePass";
import type { VerifiedInfoPage } from "../../shared/src/types";

export type BackstopRule = "filing-url" | "dismisser-window" | "enter-window" | "review-lockdown";

/** #344 round 5 — THE USE IS RESERVED AT ADMISSION: asked (and awaited) the moment the backstop would
 *  let a verified page's ONE request through 4(b) — the backend re-reads the verification's limits
 *  and writes the use in one transaction (backend infoPages.reserveInfoPagePassUse). Returns the
 *  refusals; empty = reserved. A refusal, a throw, or no reservation at all holds the request exactly
 *  as on main. */
export type InfoPageReserve = (entryId: string, where: string) => ReadonlyArray<string> | Promise<ReadonlyArray<string>>;
/** The refusal when the run has no way to reserve a use (fail closed: held as on main). */
export const INFO_PAGE_NO_RESERVATION = "a use of this verified page cannot be reserved on this run (no reservation given)";

/** What openInfoPagePass answered (#344). `candidateWatch`: no verified page matched, and ONLY
 *  that refused — the backstop watches this page's held forward request so the run can record it
 *  for a person to verify. */
export interface InfoPagePassOpen {
  opened: boolean;
  entryId?: string;
  refusals: string[];
  candidateWatch: boolean;
  /** With a candidate watch only (the page is held exactly as on main): the verified pages at this
   *  page's origin + path it did not match — each an INCIDENT (proposal §4, before the click) the
   *  run reports and the backend acts on (audited, withdrawn). */
  drifted?: Array<{ entryId: string; why: string[]; where: string }>;
  /** Refused, but the page IS a verified page reached by its verified steps (not yet passed on this
   *  run): which one. The learner reports it when only the project's prior progress refused (round
   *  2: a person may allow the pass once more for that project). Never authority for anything. */
  heldVerifiedEntryId?: string;
}

/** An unverified information page, captured when the watch opened — BEFORE the click (#344,
 *  amendment pin 2) — and, once the backstop held its forward request, what that request carried
 *  (`observed`; null when nothing was held: the person cannot verify such a candidate). The
 *  material is in memory only: the caller builds its scrubbed evidence and drops it. */
export interface InfoPageCandidateTake {
  digest: InfoPageDigest;
  prefix: InfoPagePrefixStep[];
  observed: InfoPageObservedRequest | null;
  material: InfoPageIdentityMaterial;
}

export interface BackstopAbort {
  rule: BackstopRule;
  method: string;
  /** origin + pathname only. */
  where: string;
  /** What was in flight (the window's reason), or the filing-URL rule's reason. */
  why: string;
  resourceType: string;
  /** #333: the requesting page saw a person's own input (watchHumanInput) within HUMAN_INPUT_MS —
   *  the held request was most likely their click, not the page acting by itself. */
  humanInput?: boolean;
}

export interface FilingBackstop {
  readonly aborts: BackstopAbort[];
  /** Open a window in which every state-changing request is aborted. Returns its closer. */
  openWindow(rule: "dismisser-window" | "enter-window", why: string): () => void;
  /** THE approved final submit only: open ONE slot, bound to the clicked page, that lets ONE
   *  state-changing request through — a FILING url, and past the review lockdown — within `ms`.
   *  Payment never, and never telemetry: only the clicked page's main-frame navigation (its form
   *  submission) or a fetch/XHR to the clicked page's own origin takes the slot — a beacon (ping)
   *  or a request to another origin meets the ordinary rules. The slot closes when that request goes, when the clicked page's main frame
   *  starts a navigation of its own (a GET: the click's own request was not state-changing, so
   *  there is nothing to admit) or loads a new document, or when `ms` runs out. Every later
   *  state-changing request (a page script's second POST, the completion page's on-load POST)
   *  meets the ordinary rules. While the slot is open a native confirm()/alert/beforeunload on the
   *  clicked page whose text speaks of no payment is ACCEPTED; a prompt, or a payment-worded
   *  dialog, is dismissed and recorded. Outside a slot there is no dialog handler at all
   *  (Playwright dismisses every dialog, as before). */
  allowApprovedFiling(ms: number, opts?: { page?: unknown }): void;
  /** Is an approved slot open and unused right now? */
  approvedSlotOpen(): boolean;
  /** Close the approved slot now (the filing request has gone, or a caller is done with it). */
  closeApprovedSlot(): void;
  /** Where (origin + path) each request the approved window admitted went, in order. */
  readonly approvedRequests: string[];
  /** Each admitted request: was it a NAVIGATION of the clicked page (a form submission — the
   *  click's own request) or another state-changing request fired inside the approved window?
   *  `filing` (autosubmit-2 MF-S4): is it THE FILING — the clicked page's MAIN-frame navigation (its
   *  form submission), or a fetch / XHR to a filing-shaped endpoint (isFilingOrPaymentRequest)? A
   *  subframe navigation, or a fetch to any other URL, took the window but is not the filing. */
  readonly approvedAdmissions: Array<{ where: string; navigation: boolean; mainFrame: boolean; resourceType: string; filing: boolean }>;
  /** The clicked page navigated (a GET document request) while the slot was open: a request DID
   *  reach the server even though nothing state-changing was admitted. origin + path. */
  readonly approvedNavigations: string[];
  /** Every native dialog seen while a slot's dialog handler was installed, and what was done. */
  readonly approvedDialogs: Array<{ type: string; message: string; action: "accepted" | "dismissed"; why: string }>;
  /** THE RUN'S OWN WRITE is in flight on `page` (a recorded fill / select / check / upload of a
   *  value the run decided). Until the returned closer runs, a state-changing request from that
   *  page is that write's commit — a portal's per-field autosave — and is exempt from the review
   *  lockdown's LIVE reading only (rule 4b). Payment, the filing-URL rule, the dismisser/Enter
   *  windows and the run's sticky lock (4a) all still apply. */
  openOwnWrite(page: unknown, why: string): () => void;
  /** Where (origin + path) each request the own-write exemption let through on a terminal-reading
   *  page went, in order — reported by the run. */
  readonly ownWriteRequests: string[];
  /** Did the run write (openOwnWrite) on this page's CURRENT document — since its last load? */
  ownWriteSinceLoad(page: unknown): boolean;
  /** THE RUN'S OWN SAVE DRAIN (dryrun-0928 B3) on `page`: until the closer runs, a fetch / XHR from
   *  that page to its OWN origin passes the review lockdown's live reading (rule 4b) — the portal
   *  committing the answers the run wrote (PowerClerk batches them into one SaveChanges XHR ~5 s
   *  after the first change, long after a per-write window closed). A document request (a form
   *  submit — the shape of a page that files by itself), another origin, payment, the filing-URL
   *  rule, the dismisser/Enter windows and the sticky lock (4a) all still apply. drainOwnWrites
   *  opens it; nothing else should. */
  openDrain(page: unknown, why: string): () => void;
  /** Where (origin + path) each request the drain let through went, in order. */
  readonly drainRequests: string[];
  /** The run is at review: abort every state-changing request until dispose() hands the page to
   *  a person. Sticky. */
  lockReview(why: string): void;
  /** #333 — WATCH FOR A PERSON'S OWN INPUT: from now on a trusted pointerdown / mousedown /
   *  touchstart, or an Enter / Space keydown, in any frame of any page of the run's context is
   *  recorded against its page. Call it only once the run has made its LAST input on the page (the
   *  run's own clicks are trusted input too). false = it could not be armed (the hand-over then
   *  lets nothing through: fail closed). */
  watchHumanInput(): Promise<boolean>;
  /** #333 — THE HAND-OVER: the run is done acting on the page and gives it to a person. From here a
   *  request that follows that person's own input (watchHumanInput) passes the filing-URL rule and
   *  the review lockdown; nothing else changes. false = disposed, or the input watch is not armed. */
  handOverToHuman(why: string): boolean;
  /** Has the run handed the page over (and not been disposed)? */
  handedOver(): boolean;
  /** #333 round 2 — did a person's own input reach `pg` (default: the run's page) at any time after
   *  the hand-over? Not time-limited (unlike the exemption): it tells "the person acted here" for
   *  the run's report, never lets anything through. */
  personActedSinceHandOver(pg?: unknown): boolean;
  /** #333 — THE FENCE: run `fn` (an input the run itself makes on `pg`: a click, a key press,
   *  typing) so the input watch never records it as a person's — while it is in flight and for
   *  AUTOMATION_INPUT_GRACE_MS after it (the trusted event lands in the page after the call
   *  returns). Nested calls are counted. */
  withAutomationInput<T>(pg: unknown, fn: () => Promise<T>): Promise<T>;
  /** Each request a person's own input let through after the hand-over: where it went (origin +
   *  path), whether it was a main-frame document request (a form submission), and how many aborts
   *  had been recorded before it (aborts after it are the page the person's click led to). */
  readonly humanRequests: Array<{ where: string; document: boolean; abortsBefore: number }>;
  /** Aborts that stop the run: filing, payment, review lockdown. */
  stoppingAborts(): BackstopAbort[];
  /** A HUMAN-VERIFIED INFORMATION PAGE (#344): read `page`'s identity fresh on `control` (a
   *  Playwright locator resolving to ONE element in the main frame) and ask infoPagePassRefusals.
   *  Passing, ONE slot opens: that page's main-frame document POST equal to the verified control's
   *  request passes rule 4(b) only, once, within 20 s. Refused only because no verified page
   *  matches, a WATCH opens instead: the held request is observed for takeInfoPageCandidate. Any
   *  other refusal opens nothing. Opening closes any earlier slot or watch. Round 5: the slot's
   *  request is let through only after `reserve` (awaited at that admission) reserved the use; with
   *  no `reserve` nothing opens. */
  openInfoPagePass(page: unknown, control: unknown, opts: { entries: ReadonlyArray<VerifiedInfoPage>; run: InfoPageRunState; reserve?: InfoPageReserve }): Promise<InfoPagePassOpen>;
  /** Close the info-page slot and watch now (the caller's click is over). */
  closeInfoPagePass(): void;
  /** AFTER A VERIFIED INFORMATION PAGE'S CLICK (proposal §4): read the page it led to (main frame)
   *  and ask infoPageAfterClickRefusals — it must show POSITIVE evidence of an unfiled application
   *  form (two empty plain fields in one form outside the page's chrome; not the review / terminal
   *  page; neither filed nor an error; no frame, no filing-worded control, no number the information
   *  page did not carry), twice, 1.2 s apart. Any refusal arms the sticky
   *  review lock (nothing more posts from here) and is the run's incident: it stops, the backend
   *  withdraws the pass, nothing is recorded as filed. */
  checkInfoPageAfterClick(page?: unknown): Promise<{ ok: boolean; refusals: string[] }>;
  /** PROOF OF PROGRESS (round 3): the learner recorded a fill / select / check bound to this job's
   *  own data on the page a verified click led to (infoPagePass.infoPageProofStepRefusals). Lifts the
   *  hold checkInfoPageAfterClick armed — only while the run is still on that page's document (state
   *  "pending"). true = proved (now or before); false = nothing to lift, or the run already left. */
  infoPageProofGiven(): boolean;
  /** "none" (no verified click passed), "pending" (held, on the page), "proved", or "left" (the page's
   *  document was left before the proof: the hold stays for the rest of the run). */
  infoPageProofState(): "none" | "pending" | "proved" | "left" | "continued" | "strayed";
  /** The unverified page whose forward request was held, once (then forgotten), or null. */
  takeInfoPageCandidate(): InfoPageCandidateTake | null;
  /** Each request the info-page slot admitted: exempted = it passed 4(b) only because of the
   *  pass (false: 4(b) would not have held it anyway). */
  readonly infoPageAdmissions: Array<{ entryId: string; where: string; exempted: boolean }>;
  /** Each request that took the info-page slot and did NOT match (origin + path, why). */
  readonly infoPageRefusedRequests: Array<{ where: string; refusals: string[] }>;
  dispose(): Promise<void>;
}

/** F3 (Helm's review of #349): why a slot's request is held when the run met a stopping abort after
 *  the slot opened. */
export const INFO_PAGE_STOPPING_ABORT_REFUSAL = "the run met a stopping abort (a filing, payment or form post was held) after the pass opened";

/** How long an opened information-page slot stays open, at most (#344). */
const INFO_PAGE_SLOT_MS = 20_000;
/** The fresh identity read must answer within this, or the pass is refused. */
const INFO_PAGE_IDENTITY_TIMEOUT_MS = 3_000;

/** The rules whose abort stops the run by name (a window abort is reported, and the run goes on:
 *  nothing was sent, and the dismissal / Enter was not a step of the recipe). */
//
// A REVIEW-LOCKDOWN ABORT STOPS THE RUN ONLY WHEN IT COULD HAVE BEEN A FILING: a document request (the
// review page submitting a form — the shape of a page that files by itself) or a filing- / payment-
// shaped URL. A background call the page's scripts make at review — a third-party tracker (live,
// Oregon ePermitting's CapConfirm: ec.walkme.com/event/tell, postEvent), the portal's own read-only
// page method (CapConfirm.aspx/DisplayRequiredLicenseProfessionalType), a keepalive — is STILL ABORTED
// (nothing reaches the server) and reported, but it does not fail a run that reached review: live run
// 3eaa1231 (Jules Testperson's building permit) was marked failed at the review page for exactly those.
// Operator ruling 2026-09-26: false stops on legitimate steps are bugs; the network block is the line.
export const isStoppingAbort = (a: BackstopAbort): boolean => a.rule === "filing-url"
  || (a.rule === "review-lockdown" && (/^document$/i.test(String(a.resourceType || "")) || isFilingOrPaymentRequest(a.method, a.where)));

const REGISTRY = new WeakMap<object, FilingBackstop>();

/** #333: how long after a person's own input a state-changing request is theirs. A click's form
 *  POST follows its pointerdown by well under a second; a confirm() answered first takes longer. */
const HUMAN_INPUT_MS = 4_000;
/** #333: how long after a fenced automation input its trusted events may still reach the watch (the
 *  CDP event is dispatched after the Playwright call's own round trip; measured well under 100 ms
 *  on the replica, kept generous). */
const AUTOMATION_INPUT_GRACE_MS = 1_500;
/** The page binding the input watch reports through (one per context or page, never removed). Named
 *  per process, not a fixed public name (the repo is public): a page script cannot call it by
 *  knowing this file (#333 skeptic round 1; Playwright's own binding global stays shared). */
const HUMAN_INPUT_BINDING = `__solarBackstopHumanInput_${randomBytes(6).toString("hex")}`;
/** The in-page watch. A string, not a function: tsx's __name wrapper does not exist in the page. */
const HUMAN_INPUT_SCRIPT = `(() => { const w = window; if (w.__solarBackstopHumanInputArmed) return; w.__solarBackstopHumanInputArmed = true;
  const note = (e) => { if (!e || !e.isTrusted) return; if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
    try { if (typeof w.${HUMAN_INPUT_BINDING} === "function") w.${HUMAN_INPUT_BINDING}(); } catch (_) { /* the watch never breaks the page */ } };
  for (const t of ["pointerdown", "mousedown", "touchstart", "keydown"]) w.addEventListener(t, note, true); })();`;
/** The binding is exposed once per host and dispatches to whichever backstop watches that host now
 *  (a second run in the same window — a correction reopen — must not lose its watch). */
const HUMAN_INPUT_EXPOSED = new WeakSet<object>();
const HUMAN_INPUT_SINKS = new WeakMap<object, (page: unknown) => void>();

/** #333 — run one of the run's own inputs on `page` inside its backstop's fence (no backstop: as is). */
export async function withAutomationInput<T>(page: unknown, fn: () => Promise<T>): Promise<T> {
  const bs = backstopFor(page);
  return bs ? bs.withAutomationInput(page, fn) : fn();
}

/** The backstop installed on this page's run, or null (a page no run owns: human capture). */
export function backstopFor(page: unknown): FilingBackstop | null {
  if (!page || typeof page !== "object") return null;
  const own = REGISTRY.get(page as object);
  if (own) return own;
  // A TAB THE RUN ADOPTED (a popup the learner switches this.page to) shares the context the
  // backstop was installed on — its windows must still open, or the window rule is silently off.
  try {
    const ctx = typeof (page as { context?: unknown }).context === "function" ? (page as { context: () => unknown }).context() : null;
    return ctx && typeof ctx === "object" ? REGISTRY.get(ctx as object) ?? null : null;
  } catch { return null; }
}

const whereOf = (url: string): string => {
  try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return String(url || "").split(/[?#]/)[0].slice(0, 200); }
};

/** scheme://host:port of a URL; "" when it has none (unparseable, about:, data:). */
const originOf = (url: string): string => {
  try { const o = new URL(url).origin; return o && o !== "null" ? o : ""; } catch { return ""; }
};

/** Run `fn` inside a window on this page's backstop (if one is installed), closing it `graceMs`
 *  after `fn` settles — before the caller's next action. */
export async function withBackstopWindow<T>(page: unknown, rule: "dismisser-window" | "enter-window", why: string, fn: () => Promise<T>, graceMs = 600): Promise<T> {
  const bs = backstopFor(page);
  if (!bs) return fn();
  const close = bs.openWindow(rule, why);
  try {
    return await fn();
  } finally {
    await new Promise((r) => setTimeout(r, graceMs));
    close();
  }
}

/** Run the run's OWN recorded write `fn` with an own-write window open on this page's backstop (if
 *  one is installed). The window stays open `graceMs` after `fn` settles — a portal's autosave can
 *  be debounced past the write — but the caller is NOT held for it (a closer on a timer): a replay
 *  of forty fills pays nothing. The sticky lock (lockReview) is unaffected by an open window. */
export async function withOwnWriteWindow<T>(page: unknown, why: string, fn: () => Promise<T>, graceMs = 1500): Promise<T> {
  const bs = backstopFor(page);
  if (!bs) return fn();
  const close = bs.openOwnWrite(page, why);
  try {
    return await fn();
  } finally {
    const t = setTimeout(close, Math.max(0, graceMs));
    (t as { unref?: () => void }).unref?.();
  }
}

/**
 * IS THE PORTAL STILL SAVING WHAT THE RUN WROTE? — the one reading both adapters' drains ask
 * (dryrun-0928 B3). PowerClerk's own indicator ([data-test-role='project-save-state']) says
 * "Saving…" from the first unsaved change until its batched SaveChanges XHR returns; without it, a
 * visible element whose whole text is "Saving…". Deliberately NOT a spinner class: a persistent
 * spinner would hold every review page for the full budget and report answers "not saved" that
 * were. An unreadable page reads false (not saving) — the drain then ends; it never blocks a run.
 * The in-page callback is fully inline: tsx's __name wrapper does not exist in the browser.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function autosavePending(page: any): Promise<boolean> {
  if (!page || typeof page.evaluate !== "function") return false;
  try {
    return Boolean(await page.evaluate(() => {
      const state = document.querySelector("[data-test-role='project-save-state']");
      if (state) {
        // Saved (its own marker, or the word) = not pending; an EMPTY indicator says nothing either
        // way = not pending; any other state it prints ("Saving…", "Unsaved changes") = pending.
        if (state.querySelector("[data-test-role='save-state-saved']")) return false;
        const text = ((state as HTMLElement).innerText || state.textContent || "").trim();
        if (!text) return false;
        return /saving|unsaved|pending/i.test(text) || !/\bsaved\b/i.test(text);
      }
      const els = Array.from(document.querySelectorAll("span, div, small, p, label"));
      for (const el of els) {
        const t = (el.textContent || "").trim();
        if (!/^saving(\.{0,3}|…)?$/i.test(t)) continue;
        const r = (el as HTMLElement).getBoundingClientRect();
        const s = window.getComputedStyle(el as HTMLElement);
        if (r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none") return true;
      }
      return false;
    }));
  } catch { return false; }
}

export interface DrainOutcome {
  /** A drain window was opened (the run wrote on this page's current document). */
  drained: boolean;
  /** The portal still read as saving when the budget ran out — its save was NOT seen to finish. */
  stillSaving: boolean;
  waitedMs: number;
}

/**
 * NEVER LOCK OR HAND OVER A REVIEW PAGE WHILE THE RUN'S OWN SAVE IS PENDING (dryrun-0928 B3).
 *
 * On PowerClerk's last page the learn chose "No Aggregation", "No" and ticked the certification at
 * 16:13:11; PowerClerk batched them into ONE SaveChanges3 XHR at 16:13:16 — 5 s after the first
 * change — and the review lockdown aborted it: each write's own-write window had closed 1.5 s after
 * the write. The page was handed over reading "Saving…", and closing it lost the answers.
 *
 * So before the run locks the page (lockReview) or hands it to a person, it waits — while the
 * portal reads as saving (autosavePending), up to `budgetMs` — with a DRAIN open on the backstop:
 * a same-origin fetch / XHR from the page passes rule 4b; a document request (a form submit), any
 * other origin, a payment or a filing URL is still aborted (hard rule 1 unchanged). Only a page the
 * run WROTE on since its last load is drained. It ends after ~750 ms of "not saving". Returns what
 * it saw; stillSaving=true is the run's cue to say, by name, that the answers may not be saved.
 */
export async function drainOwnWrites(
  page: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  opts: { isSaving?: (page: any) => Promise<boolean>; budgetMs?: number; why?: string } = {},
): Promise<DrainOutcome> {
  const bs = backstopFor(page);
  if (!bs || !bs.ownWriteSinceLoad(page)) return { drained: false, stillSaving: false, waitedMs: 0 };
  const isSaving = opts.isSaving ?? autosavePending;
  // 12 s by default — above the ~5 s PowerClerk batch delay measured live. REVIEW_SAVE_DRAIN_MS
  // overrides it (a smoke's short budget; an operator with a slower portal).
  const envBudget = Number(process.env.REVIEW_SAVE_DRAIN_MS);
  const budget = Math.max(0, opts.budgetMs ?? (Number.isFinite(envBudget) && envBudget > 0 ? envBudget : 12_000));
  const close = bs.openDrain(page, opts.why ?? "the run's own answers still saving");
  const t0 = Date.now();
  let quiet = 0;
  try {
    while (Date.now() - t0 < budget) {
      const saving = await isSaving(page).catch(() => false);
      quiet = saving ? 0 : quiet + 1;
      if (quiet >= 3) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const stillSaving = await isSaving(page).catch(() => false);
    return { drained: true, stillSaving, waitedMs: Date.now() - t0 };
  } finally {
    close();
  }
}

/** The one sentence a run adds when its drain ran out with the portal still saving (B3). */
export function unsavedAtReviewWarning(where: string): string {
  return `ANSWERS ON THE REVIEW PAGE MAY NOT BE SAVED: the portal still read "Saving…" when automation handed ${where} over — make sure the page shows it saved (touch a field again if it does not) before you verify and submit.`;
}

/**
 * THE PORTAL'S OWN CALLS THE REVIEW LOCKDOWN HELD BACK (dryrun-0928 B14). Both Accela runs aborted
 * CapConfirm.aspx/DisplayRequiredLicenseProfessionalType — the review page's own load-time
 * PageMethod (ASP.NET PageMethods always POST) — and the person got the page with no hint a
 * section may render incomplete. The abort is right (a word list exempting "Display*" calls is what
 * the backstop exists not to be); saying so is the fix. Only non-stopping review-lockdown aborts
 * (stopping ones already fail the run, named) whose ORIGIN is the review page's: a third-party
 * tracker (WalkMe) is not the portal's own and stays in the warnings only. origin + path only.
 */
export function portalOwnCallsBlockedAtReview(aborts: BackstopAbort[], reviewPageUrl: string): string[] {
  const home = originOf(reviewPageUrl);
  if (!home) return [];
  const out: string[] = [];
  for (const a of aborts) {
    if (a.rule !== "review-lockdown" || isStoppingAbort(a)) continue;
    if (originOf(a.where) !== home) continue;
    if (!out.includes(a.where)) out.push(a.where);
  }
  return out;
}

/** The hand-off line for those calls. `lastDocumentMethod` decides the advice: a page reached by
 *  GET can be reloaded; one rendered from a POST (or unknown) must not be — a reload re-sends the
 *  previous form — so the person goes back through the portal's own navigation instead. */
export function reviewBlockedCallsLine(paths: string[], lastDocumentMethod: string | null): string {
  if (!paths.length) return "";
  const shown = paths.slice(0, 3).map((p) => p.replace(/^https?:\/\/[^/]+/i, "")).join(", ");
  const advice = String(lastDocumentMethod ?? "").toUpperCase() === "GET"
    ? "reload the review page before you verify and submit"
    : "use the portal's own navigation back to the review step before you verify and submit (a reload could re-send the previous form)";
  return `While automation held this review page, the portal's own background request(s) ${shown}${paths.length > 3 ? `, +${paths.length - 3} more` : ""} were blocked — nothing was sent. A section that depends on them may render incomplete: ${advice}.`;
}

/** How long the lockdown waits for the requesting page to answer "are you terminal?". A page
 *  blocked in a SYNCHRONOUS XHR cannot answer until this handler lets that XHR go — the timeout
 *  breaks that wait. Unknown then falls back to the sticky lock (and the filing/payment rules,
 *  which need no page read). */
const TERMINAL_READ_TIMEOUT_MS = 1500;

/** Read the shared terminal-page predicate in a page's main frame: true / false, or null when it
 *  cannot be read (a navigating or blocked page). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function mainFrameIsTerminal(main: any): Promise<boolean | null> {
  if (!main || typeof main.evaluate !== "function") return null;
  const read = (async (): Promise<boolean | null> => {
    await main.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE).catch(() => null);
    const r = await main.evaluate((g: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ps = (globalThis as any)[g];
      if (!ps || typeof ps.terminalPageInPage !== "function") return null;
      const t = ps.terminalPageInPage();
      return typeof t.terminal === "boolean" ? t.terminal : null;
    }, PORTAL_SAFETY_GLOBAL).catch(() => null);
    return typeof r === "boolean" ? r : null;
  })();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((r) => { timer = setTimeout(() => r(null), TERMINAL_READ_TIMEOUT_MS); });
  try { return await Promise.race([read, timeout]); } finally { if (timer) clearTimeout(timer); }
}

/** THE BACKSTOP'S OWN FRESH IDENTITY READ (#344): the page's identity on exactly one control, in
 *  the main frame, within 3 s — never a caller's or a load-time reading. Any doubt refuses. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readInfoPageIdentity(page: any, control: any): Promise<InfoPageIdentityReading> {
  const notOne: InfoPageIdentityReading = { ok: false, why: "the control is not one element in the main frame" };
  const read = (async (): Promise<InfoPageIdentityReading> => {
    if (!page || typeof page.mainFrame !== "function") return { ok: false, why: "the page cannot be read" };
    if (!control || typeof control.count !== "function" || typeof control.elementHandle !== "function") return notOne;
    const n = await control.count().catch(() => -1);
    if (n !== 1) return notOne;
    const handle = await control.elementHandle({ timeout: INFO_PAGE_IDENTITY_TIMEOUT_MS }).catch(() => null);
    if (!handle) return notOne;
    try {
      const frame = await handle.ownerFrame().catch(() => null);
      if (!frame || frame !== page.mainFrame()) return notOne;
      await frame.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE).catch(() => null);
      const r = await handle.evaluate((el: unknown, g: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ps = (globalThis as any)[g];
        return ps && typeof ps.infoPageIdentityInPage === "function" ? ps.infoPageIdentityInPage(el) : { ok: false, why: "the page has no identity reader" };
      }, PORTAL_SAFETY_GLOBAL).catch((e: unknown) => ({ ok: false, why: `the identity read failed (${String((e as { message?: string })?.message ?? e).slice(0, 80)})` }));
      return r && typeof r === "object" && typeof (r as { ok?: unknown }).ok === "boolean" ? r as InfoPageIdentityReading : { ok: false, why: "the identity read returned nothing" };
    } finally {
      await handle.dispose().catch(() => null);
    }
  })();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<InfoPageIdentityReading>((r) => { timer = setTimeout(() => r({ ok: false, why: "the identity read timed out" }), INFO_PAGE_IDENTITY_TIMEOUT_MS); });
  try { return await Promise.race([read, timeout]); } finally { if (timer) clearTimeout(timer); }
}

/** How long the page after a verified click may take to show its form (a SmartGuide step renders
 *  server-side; a few hundred ms of script is normal). Only "no form yet" / "no text yet" waits:
 *  a page that reads as filed, review, an error or carries a new number refuses at once. */
const INFO_PAGE_AFTER_CLICK_MS = 6_000;
/** A clean reading of the page after the click is confirmed by a second one this much later. */
const INFO_PAGE_AFTER_CLICK_CONFIRM_MS = 1_200;

/** One reading of the page a verified click led to, in its main frame, within 3 s (null = unread). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readAfterClick(page: any): Promise<InfoPageAfterClickReading | null> {
  if (!page || typeof page.mainFrame !== "function") return null;
  const read = (async (): Promise<InfoPageAfterClickReading | null> => {
    const frame = page.mainFrame();
    await frame.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE).catch(() => null);
    const r = await frame.evaluate((g: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ps = (globalThis as any)[g];
      return ps && typeof ps.infoPageAfterClickInPage === "function" ? ps.infoPageAfterClickInPage() : null;
    }, PORTAL_SAFETY_GLOBAL).catch(() => null);
    return r && typeof r === "object" ? r as InfoPageAfterClickReading : null;
  })();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((r) => { timer = setTimeout(() => r(null), INFO_PAGE_IDENTITY_TIMEOUT_MS); });
  try { return await Promise.race([read, timeout]); } finally { if (timer) clearTimeout(timer); }
}

/** origin + path + every query [key, value] sorted: the page's exact address, for R5. */
const pageKeyOf = (url: string): string => {
  try {
    const u = new URL(url);
    const q = Array.from(u.searchParams.entries()).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    return JSON.stringify([u.origin, u.pathname, q]);
  } catch { return ""; }
};

/** The page a request came from (its frame's page), or null (a service-worker request). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pageOfRequest(request: any): any {
  try {
    const frame = request.frame();
    return frame && typeof frame.page === "function" ? frame.page() : null;
  } catch { return null; }
}

/** Install the backstop for one learn/replay run. null when the page cannot route (a unit-test
 *  double) — the word gates still run; nothing claims a backstop that is not there. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function installFilingBackstop(page: any, label = "run"): Promise<FilingBackstop | null> {
  if (!page || typeof page !== "object") return null;
  const existing = REGISTRY.get(page);
  if (existing) return existing;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ctx: any = null;
  try { ctx = typeof page.context === "function" ? page.context() : null; } catch { ctx = null; }
  const target = ctx && typeof ctx.route === "function" && typeof ctx.unroute === "function" ? ctx
    : typeof page.route === "function" && typeof page.unroute === "function" ? page : null;
  if (!target) return null;

  const aborts: BackstopAbort[] = [];
  const windows = new Map<number, { rule: "dismisser-window" | "enter-window"; why: string }>();
  let nextWindow = 1;
  // ONE REQUEST PER APPROVED CLICK. The window used to admit EVERY non-payment state-changing
  // request for 20 s, so a page script's second POST fired in the approved click's window reached
  // the server as if a person had approved it too (portal-run-close 8, approvedFinalSubmit smoke
  // 'extraPost'). A named approval covers the click's own request and nothing else. KNOWN COST,
  // fail-closed: a script POST that fires BEFORE the click's own request takes the slot and the
  // filing itself is aborted (named, nothing filed).
  //
  // THE SLOT IS BOUND TO THE CLICK (portal-run-close-2 M4). It was consumed by ANY first
  // state-changing request, so when the click's own request was NOT state-changing (a form
  // method=GET to the completion page; a button setting location.href) the completion page's
  // on-load fetch(POST …/track/completed) took the slot, reached the server, and was reported as
  // "the approved click's request" (skeptic getSubmit / jsNav). Now the slot admits a request
  // only from the CLICKED page (any of its frames), and closes as soon as that page's main frame
  // starts a GET navigation or loads a new document — the click's navigation is over, and
  // whatever the next document posts is not what the person approved. Deliberately NOT
  // framenavigated: Playwright fires it on pushState, and an SPA that pushes state and then
  // posts the filing would lose its slot (a new false stop on a legitimate filing).
  type Slot = { page: unknown; until: number; open: boolean; timer: ReturnType<typeof setTimeout> | null; detach: () => void };
  let slot: Slot | null = null;
  const approvedRequests: string[] = [];
  const approvedAdmissions: Array<{ where: string; navigation: boolean; mainFrame: boolean; resourceType: string; filing: boolean }> = [];
  const approvedNavigations: string[] = [];
  const approvedDialogs: Array<{ type: string; message: string; action: "accepted" | "dismissed"; why: string }> = [];
  const slotLive = (): boolean => !!slot && slot.open && Date.now() < slot.until;
  const closeSlot = (): void => {
    const s = slot;
    if (!s) return;
    s.open = false;
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    s.detach();
  };
  // TELEMETRY NEVER TAKES THE SLOT (autosubmit-close MF-B). The slot went to the FIRST
  // state-changing request from the clicked page, and a GA4-style navigator.sendBeacon in the
  // form's onsubmit, a cross-origin beacon, or a fetch(keepalive) to an analytics host in the
  // Submit's onclick all fire BEFORE the form's own POST: the beacon took the approval, the filing
  // was then aborted, nothing filed — and the run said the approved request went
  // (finalSubmitRequestSent true, the backend would have recorded the filing). The slot now admits
  // only what can be the click's filing:
  //   - the clicked page's own MAIN-FRAME NAVIGATION (its form submission), whatever the host — a
  //     form's action may live on another host, and a beacon or fetch is never a navigation;
  //   - a fetch / XHR (or a subframe navigation) to the clicked page's OWN ORIGIN — an SPA's
  //     filing call (extraSpa, confirmThenSpa);
  //   - never a ping (sendBeacon, <a ping>), whatever its origin.
  // Anything else meets the ordinary rules as if no slot were open — at review that is the sticky
  // lock, so a beacon is ABORTED (reported after the approved click as "aborted N other
  // state-changing request(s)", never a stop, never "the approved request").
  // RESIDUAL, named: a SAME-origin fetch({keepalive}) / fetch({mode:'no-cors'}) is not visible to
  // a route handler (Chromium sends no sec-fetch-mode to it and the resource type is "fetch"),
  // so one fired before the filing would still take the slot — fail-closed: the filing is then
  // aborted by the filing-URL rule / lockdown and the run reports the admitted URL, not a filing.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slotAdmits = (request: any, pg: any, url: string, resourceType: string, navigation: boolean): boolean => {
    if (resourceType === "ping") return false;
    let mainFrame = false;
    try { mainFrame = !!pg && typeof pg.mainFrame === "function" && request.frame() === pg.mainFrame(); } catch { mainFrame = false; }
    if (navigation && mainFrame) return true;
    // The clicked page's origin, read now (a pushState keeps it; a navigation away closed the slot).
    // Unreadable -> not admitted (fail-closed: the filing is aborted, named, nothing claims it went).
    let pageUrl = "";
    try { pageUrl = pg && typeof pg.url === "function" ? String(pg.url() || "") : ""; } catch { pageUrl = ""; }
    const origin = originOf(url);
    return origin !== "" && origin === originOf(pageUrl);
  };
  // THE RUN'S OWN WRITES in flight (openOwnWrite), each bound to the page it writes on.
  const ownWrites = new Map<number, { page: unknown; why: string }>();
  let nextOwnWrite = 1;
  const ownWriteRequests: string[] = [];
  // WHEN the run last wrote on a page, and when that page last loaded a document: "the run wrote on
  // this document" is lastOwnWriteAt > lastLoadAt (a write on an earlier page is not this page's save).
  const lastOwnWriteAt = new WeakMap<object, number>();
  const lastLoadAt = new WeakMap<object, number>();
  // THE OWN-SAVE DRAINS (openDrain), each bound to the page whose save it lets finish.
  const drains = new Map<number, { page: unknown; why: string }>();
  let nextDrain = 1;
  const drainRequests: string[] = [];
  let locked = "";
  let disposed = false;
  // #333 — THE HAND-OVER. When each page last saw a person's own input (watchHumanInput), and when
  // the run handed the page over (0 = not yet).
  const humanInputAt = new WeakMap<object, number>();
  let humanWatchArmed = false;
  let handedOverAt = 0;
  const humanRequests: Array<{ where: string; document: boolean; abortsBefore: number }> = [];
  const recentHumanInput = (pg: unknown): boolean => {
    if (!pg || typeof pg !== "object") return false;
    const t = humanInputAt.get(pg as object) ?? 0;
    return t > 0 && Date.now() - t <= HUMAN_INPUT_MS;
  };
  // A PERSON'S INPUT THAT COUNTS for the hand-over: on this page, AFTER the hand-over (an input just
  // before it is never carried over), and recent.
  const humanInputSinceHandOver = (pg: unknown): boolean => {
    if (!pg || typeof pg !== "object" || !handedOverAt) return false;
    const t = humanInputAt.get(pg as object) ?? 0;
    return t > handedOverAt && Date.now() - t <= HUMAN_INPUT_MS;
  };
  // THE FENCE (#333): per page, how many of the run's own inputs are in flight and when the last ended.
  const automationDepth = new WeakMap<object, number>();
  const automationEndedAt = new WeakMap<object, number>();
  const automationFenced = (pg: object): boolean =>
    (automationDepth.get(pg) ?? 0) > 0 || Date.now() - (automationEndedAt.get(pg) ?? 0) <= AUTOMATION_INPUT_GRACE_MS;
  // #344 — THE INFORMATION-PAGE PASS. Run-wide facts its predicate asks (the run wrote through an
  // own-write window; an approved final-submit slot was ever opened), its ONE slot, its candidate
  // watch, and what each admitted. Every closer below also closes these.
  let everWrote = false;
  let approvedEverOpened = false;
  type InfoSlot = { page: unknown; entryId: string; expected: InfoPageExpectedRequest; pageKey: string; beforeTokens: string[]; beforeAck: string[]; reserve: InfoPageReserve; until: number; open: boolean; timer: ReturnType<typeof setTimeout> | null; detach: () => void };
  let infoSlot: InfoSlot | null = null;
  type InfoWatch = { page: unknown; capture: InfoPageCandidateTake; until: number; open: boolean; timer: ReturnType<typeof setTimeout> | null; detach: () => void };
  let infoWatch: InfoWatch | null = null;
  let infoCandidate: InfoPageCandidateTake | null = null;
  // The information page whose ONE request was admitted last, with its own number-shaped tokens: what
  // checkInfoPageAfterClick compares the next page against (a token only the next page has is new).
  let infoAfterBaseline: (InfoPageAfterClickBaseline & { entryId: string }) | null = null;
  const infoPageAdmissions: Array<{ entryId: string; where: string; exempted: boolean }> = [];
  const infoPageRefusedRequests: Array<{ where: string; refusals: string[] }> = [];
  const admittedEntryIds: string[] = [];
  // PROOF OF PROGRESS (round 3): armed when the page a verified click led to passed the after-click
  // reading; until the learner proves it entered this job's own data there, nothing state-changing
  // but the run's own writes passes (the hold in the handler, rule 3b).
  let infoProof: { page: unknown; entryId: string; state: "pending" | "proved" | "left" | "continued" | "strayed"; checked: boolean } | null = null;
  // Q4 — SAME INTERVIEW: the origin + path the admitted verified request went to (whereOf). Once the
  // proof is given, the one way off the page it led to is that interview's own form posting back there.
  let infoProofEndpoint = "";
  const ownWriteOn = (pg: unknown): boolean => !!pg && [...ownWrites.values()].some((w) => w.page === pg);
  const infoSlotLive = (): boolean => !!infoSlot && infoSlot.open && Date.now() < infoSlot.until;
  const infoWatchLive = (): boolean => !!infoWatch && infoWatch.open && Date.now() < infoWatch.until;
  const closeInfoSlot = (): void => {
    const s = infoSlot;
    if (!s) return;
    s.open = false;
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    s.detach();
    infoSlot = null;
  };
  const closeInfoWatch = (): void => {
    const w = infoWatch;
    if (!w) return;
    w.open = false;
    if (w.timer) clearTimeout(w.timer);
    w.timer = null;
    w.detach();
    infoWatch = null;
  };
  const closeInfo = (): void => { closeInfoSlot(); closeInfoWatch(); };
  /** Close on the page's next document, and on a timer. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bindInfoClosers = (pg: any, onClose: () => void): { detach: () => void; timer: ReturnType<typeof setTimeout> } => {
    const detachers: Array<() => void> = [];
    if (pg && typeof pg.on === "function" && typeof pg.off === "function") {
      const onLoad = (): void => onClose();
      pg.on("domcontentloaded", onLoad);
      detachers.push(() => { try { pg.off("domcontentloaded", onLoad); } catch { /* page gone */ } });
    }
    const timer = setTimeout(onClose, INFO_PAGE_SLOT_MS);
    (timer as { unref?: () => void }).unref?.();
    return { detach: () => { for (const d of detachers.splice(0)) d(); }, timer };
  };
  // A NAVIGATION REQUEST (a form POST) CANNOT BE ASKED LIVE: evaluating the page it is navigating
  // waits for that navigation, which waits for this handler — every Accela postback stalled the
  // full read timeout (measured: 9 postbacks x 1.5 s on the Accela replica). So each page's
  // classification is also read on every load and on every live read, and a navigation request
  // is judged by the page's last reading. A server-rendered page's review text is there at load;
  // an SPA's posts are fetch/XHR, which are read live.
  const lastReading = new WeakMap<object, boolean>();
  const unwatch: Array<() => void> = [];
  const watched = new WeakSet<object>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const refresh = (pg: any): void => {
    if (disposed || !pg || typeof pg.mainFrame !== "function") return;
    void mainFrameIsTerminal(pg.mainFrame()).then((v) => { if (typeof v === "boolean") lastReading.set(pg, v); }).catch(() => null);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const watch = (pg: any): void => {
    if (!pg || typeof pg !== "object" || watched.has(pg) || typeof pg.on !== "function") return;
    watched.add(pg);
    const onLoad = (): void => refresh(pg);
    // A new document on this page: the run's writes on the previous one are not this one's to save.
    const onDocument = (): void => { lastLoadAt.set(pg, Date.now()); };
    pg.on("domcontentloaded", onDocument);
    pg.on("domcontentloaded", onLoad);
    pg.on("load", onLoad);
    unwatch.push(() => { try { pg.off("domcontentloaded", onDocument); pg.off("domcontentloaded", onLoad); pg.off("load", onLoad); } catch { /* page gone */ } });
    refresh(pg);
  };
  try {
    if (ctx && typeof ctx.pages === "function" && typeof ctx.on === "function") {
      for (const p of ctx.pages()) watch(p);
      const onPage = (p: unknown): void => watch(p);
      ctx.on("page", onPage);
      unwatch.push(() => { try { ctx.off("page", onPage); } catch { /* context gone */ } });
    } else watch(page);
  } catch { /* no events (a double): live reads only */ }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = async (route: any, request: any): Promise<void> => {
    let method = "";
    let url = "";
    try { method = String(request.method() || "").toUpperCase(); url = String(request.url() || ""); } catch { /* unreadable: fall through as not-GET */ }
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      // The clicked page's main frame navigating by GET ends the approved click's slot: its own
      // request was that navigation (nothing state-changing to admit), and the next document's
      // posts are not the click's. The navigation itself reached the server — recorded.
      if (method === "GET" && slotLive()) {
        try {
          const pg = pageOfRequest(request);
          if (request.isNavigationRequest() && pg && pg === slot!.page && request.frame() === pg.mainFrame()) {
            approvedNavigations.push(whereOf(url));
            closeSlot();
          }
        } catch { /* unreadable: the slot keeps its other closers */ }
      }
      // ...and the information-page slot / watch (#344): the page is leaving by GET, so its one
      // state-changing request can no longer be the verified control's.
      if (method === "GET" && (infoSlot || infoWatch)) {
        try {
          const pg = pageOfRequest(request);
          if (request.isNavigationRequest() && pg && request.frame() === pg.mainFrame()) {
            if (infoSlot && pg === infoSlot.page) closeInfoSlot();
            if (infoWatch && pg === infoWatch.page) closeInfoWatch();
          }
        } catch { /* unreadable: the slot keeps its other closers */ }
      }
      // PROOF OF PROGRESS (round 3): the page a verified click led to navigating AWAY by GET before
      // the run proved it entered this job's data there — the proof can no longer be given on that
      // page (state "left"; the hold stays). The run's own write in flight on it (a cascading select
      // that reloads) is not leaving.
      if (method === "GET" && infoProof && infoProof.state === "pending" && infoProof.checked) {
        try {
          const pg = pageOfRequest(request);
          if (request.isNavigationRequest() && pg && pg === infoProof.page && request.frame() === pg.mainFrame() && !ownWriteOn(pg)) infoProof.state = "left";
        } catch { /* unreadable: the hold stays as it is */ }
      }
      await route.fallback().catch(() => null);
      return;
    }
    let resourceType = "";
    try { resourceType = String(request.resourceType() || ""); } catch { /* keep "" */ }
    const requestPage = pageOfRequest(request);
    const abort = async (rule: BackstopRule, why: string): Promise<void> => {
      aborts.push({ rule, method: method || "?", where: whereOf(url), why, resourceType, ...(recentHumanInput(requestPage) ? { humanInput: true } : {}) });
      await route.abort("blockedbyclient").catch(() => null);
    };
    // #333 — A PERSON'S OWN REQUEST AFTER THE HAND-OVER: the requesting page saw their input (the
    // watch is armed only after the run's last input, and the run makes none after the hand-over)
    // and no run action is in flight (a dismisser / Enter window). It passes the filing-URL rule and
    // the review lockdown below; payment and the windows still apply.
    const human = handedOverAt > 0 && !disposed && windows.size === 0 && humanInputSinceHandOver(requestPage);
    // R0 — THE INFORMATION-PAGE SLOT IS CONSUMED by the FIRST request that could be the verified
    // control's (#344): the bound page's own main-frame document navigation. Matched or not, the
    // slot is gone, and consuming it changes no rule's outcome: the request meets payment, the
    // filing-URL rule, the windows and the sticky lock (4a) below exactly as on main, and only 4(b)
    // can be lifted — only when R2-R5 all hold (URL, media, ordered body, the page's address).
    let infoAdmit: { entryId: string; refusals: string[]; tokens: string[]; ack: string[]; reserve: InfoPageReserve } | null = null;
    if (infoSlotLive()) {
      const s = infoSlot!;
      const pg = pageOfRequest(request);
      let navigation = false;
      let mainFrame = false;
      try { navigation = !!request.isNavigationRequest(); } catch { navigation = false; }
      try { mainFrame = !!pg && typeof pg.mainFrame === "function" && request.frame() === pg.mainFrame(); } catch { mainFrame = false; }
      if (pg && pg === s.page && navigation && mainFrame && /^document$/i.test(resourceType)) {
        closeInfoSlot();
        let contentType = "";
        try {
          const h = typeof request.allHeaders === "function" ? await request.allHeaders() : request.headers();
          contentType = String((h && (h["content-type"] ?? h["Content-Type"])) || "");
        } catch { contentType = ""; }
        let buf: Buffer | null = null;
        try { buf = request.postDataBuffer(); } catch { buf = null; }
        const observed = infoPageObservedRequest(method || "?", url, contentType, buf);
        const refusals = infoPageRequestRefusals(s.expected, observed);
        let pageUrl = "";
        try { pageUrl = String(pg.url() || ""); } catch { pageUrl = ""; }
        if (!pageUrl || pageKeyOf(pageUrl) !== s.pageKey) refusals.push("the page's address is not the one whose identity was read");
        // F3 (Helm's review of #349): a STOPPING abort since the slot opened — a page script tried to
        // file, pay or post a form while the run was between the open and the click — means the run is
        // stopping: the slot it opened is no longer good for anything (asked here, at consumption).
        if (aborts.some(isStoppingAbort)) refusals.push(INFO_PAGE_STOPPING_ABORT_REFUSAL);
        infoAdmit ={ entryId: s.entryId, refusals, tokens: s.beforeTokens, ack: s.beforeAck, reserve: s.reserve };
        if (refusals.length) infoPageRefusedRequests.push({ where: whereOf(url), refusals });
      }
    }
    // 1. PAYMENT: never, in any frame, any type, whatever was approved.
    if (isPayRequestUrl(url)) { await abort("filing-url", "a fee-payment endpoint — automation never pays"); return; }
    // The approved click's ONE request takes the slot (checked after the payment rule: a payment
    // never uses it) — and only a request from the clicked page that can BE the click's filing.
    let approved = false;
    if (slotLive()) {
      const pg = pageOfRequest(request);
      let navigation = false;
      try { navigation = !!request.isNavigationRequest(); } catch { /* unknown: not a navigation */ }
      if ((!slot!.page || pg === slot!.page) && slotAdmits(request, pg, url, resourceType, navigation)) {
        approved = true;
        approvedRequests.push(whereOf(url));
        // WHAT TOOK THE SLOT IS NOT ALWAYS THE FILING (autosubmit-2 MF-S4). Admission is unchanged
        // (slotAdmits); the RECORD says whether the admitted request can be the filing: the clicked
        // page's main-frame navigation, or a fetch / XHR to a filing-shaped URL. A same-origin
        // fetch('/analytics') in the Submit's onclick, or a tracking form posted into a hidden
        // iframe, took the window, the form's filing POST was then aborted — and the run reported
        // "the approved click's request went" (finalSubmitRequestSent true).
        let mainFrame = false;
        try { mainFrame = !!pg && typeof pg.mainFrame === "function" && request.frame() === pg.mainFrame(); } catch { mainFrame = false; }
        // The URL's PATH decides (autosubmit-close-2 skeptic s4TrackQuery): server-side GTM's
        // "/gtm/collect?en=form_submit" is analytics whose query merely names the event.
        const filing = navigation ? mainFrame : isFilingOrPaymentRequest(method || "POST", url.split(/[?#]/)[0]);
        approvedAdmissions.push({ where: whereOf(url), navigation, mainFrame, resourceType, filing });
        closeSlot();
      }
    }
    // 2. FILING URL: only inside THE approved final submit's window.
    if (isFilingOrPaymentRequest(method || "POST", url) && !approved && !human) {
      await abort("filing-url", `a filing endpoint, and no named approval covers this request (${label})`);
      return;
    }
    // 3. WINDOW RULE: any state-changing request while a dismisser click / terminal Enter is in flight.
    const open = [...windows.values()];
    if (open.length) {
      const w = open[open.length - 1];
      await abort(w.rule, w.why);
      return;
    }
    // 3b. PROOF OF PROGRESS (#344 round 3): after a verified information page's click led to a page
    // that read as an unfiled form, NOTHING state-changing passes until the run has entered this
    // job's own data on that page (infoPageProofGiven) — but the run's own writes there: a background
    // (non-document) request such as a fetch / XHR in an open own-write window on the requesting page
    // (a fill's autosave), or a drain's same-origin fetch / XHR. A document request (a form submit: the
    // run or the page leaving it) or a filing URL held here stops the run (isStoppingAbort, as 4b's do); a background call is held and reported.
    // Never lifted by anything but the proof; the approved final-submit slot is never open on such a
    // run (it never opens after an information-page pass, and vice versa).
    // AUTOPOSTBACK (worker-local's V6_apb_else / V6_apb_change_else): the own-write window covers the
    // run's own BACKGROUND writes only (fetch / XHR — a field's autosave). A DOCUMENT request (resource
    // type document, or any navigation) in the window is the page posting a form — an ASP.NET
    // AutoPostBack's oninput / onchange "this.form.submit()" sends the receipt's form with the job's
    // street — never the write's own commit: it is judged exactly as with no window open (held here).
    if (!approved && infoProof && infoProof.state !== "proved" && infoProof.state !== "continued") {
      const pg = pageOfRequest(request);
      let navigation = true;
      try { navigation = !!request.isNavigationRequest(); } catch { /* unknown: a navigation */ }
      const documentRequest = navigation || /^document$/i.test(resourceType);
      let ownWrite = !documentRequest && ownWriteOn(pg);
      if (!ownWrite && pg && !navigation && /^(xhr|fetch)$/i.test(resourceType) && [...drains.values()].some((d) => d.page === pg)) {
        let pageUrl = "";
        try { pageUrl = typeof pg.url === "function" ? String(pg.url() || "") : ""; } catch { pageUrl = ""; }
        const origin = originOf(url);
        ownWrite = origin !== "" && origin === originOf(pageUrl);
      }
      if (!ownWrite) {
        await abort("review-lockdown", `PROOF OF PROGRESS — the page a verified information page led to has not taken this job's own data yet (${infoProof.state === "strayed" ? "it already tried to send it somewhere other than the interview's own form" : infoProof.state === "left" ? "the run left it first" : "nothing bound to the job was entered there"}), so nothing leaves it (${label})`);
        return;
      }
    }
    // 3c. SAME INTERVIEW (Q4, a POSITIVE rule — it reads no wording): once the proof is given, the ONE
    // state-changing way off the page the verified click led to (but the run's own writes, as in 3b)
    // is that page's own main-frame DOCUMENT request back to the endpoint the verified request went to
    // (origin + path): the interview continuing. A receipt's "start another request", "tell us more",
    // contact or list-filter form posts elsewhere — that is not the next step of THIS application, so
    // it stops the run (state "strayed": the learner reports the pass's incident). After the interview
    // continued, main's rules apply unchanged. As in 3b, the own-write window exempts only the run's
    // background writes: a document request in it is judged as with no window (only the main-frame
    // submit back to the verified origin + path continues; anything else is the stray).
    if (!approved && infoProof && infoProof.state === "proved") {
      const pg = pageOfRequest(request);
      let navigation = true;
      try { navigation = !!request.isNavigationRequest(); } catch { /* unknown: a navigation */ }
      const documentRequest = navigation || /^document$/i.test(resourceType);
      let ownWrite = !documentRequest && ownWriteOn(pg);
      if (!ownWrite && pg && !navigation && /^(xhr|fetch)$/i.test(resourceType) && [...drains.values()].some((d) => d.page === pg)) {
        let pageUrl = "";
        try { pageUrl = typeof pg.url === "function" ? String(pg.url() || "") : ""; } catch { pageUrl = ""; }
        const origin = originOf(url);
        ownWrite = origin !== "" && origin === originOf(pageUrl);
      }
      if (!ownWrite) {
        let mainFrame = false;
        try { mainFrame = !!pg && pg === infoProof.page && request.frame() === pg.mainFrame(); } catch { mainFrame = false; }
        if (navigation && mainFrame && /^document$/i.test(resourceType) && infoProofEndpoint !== "" && whereOf(url) === infoProofEndpoint) infoProof.state = "continued";
        else {
          // A document request (a form leaving the page) or a filing URL is the stray that stops the
          // run; a background call is only held and reported, as in 3b.
          if (/^document$/i.test(resourceType) || isFilingOrPaymentRequest(method, url)) infoProof.state = "strayed";
          await abort("review-lockdown", `SAME INTERVIEW — the page a verified information page led to sent this request somewhere other than the interview's own form (${whereOf(url) === infoProofEndpoint ? "not the page's own document submit" : "another endpoint"}); it may be a receipt's form, so nothing leaves it (${label})`);
          return;
        }
      }
    }
    // 4. REVIEW-PAGE LOCKDOWN: the run locked it, or the requesting page reads as terminal now.
    if (!approved && !human) {
      if (locked) { await abort("review-lockdown", locked); return; }
      const pg = pageOfRequest(request);
      let navigation = true;
      try { navigation = !!request.isNavigationRequest(); } catch { /* unknown: treat as navigation (no live read) */ }
      let terminal: boolean | null = null;
      if (navigation) terminal = pg ? lastReading.get(pg) ?? null : null;
      else if (pg) {
        terminal = await mainFrameIsTerminal(pg.mainFrame());
        if (typeof terminal === "boolean") lastReading.set(pg, terminal);
      }
      if (terminal === true && !disposed) {
        // THE RUN'S OWN WRITE (autosubmit-close item 7): a recorded value written on a
        // terminal-reading page — PowerClerk's Terms checkbox at review, its per-field Autosave
        // POST — is that write's commit, not the page acting on its own. It passes; everything
        // else a terminal page posts is still aborted.
        const own = pg ? [...ownWrites.values()].find((w) => w.page === pg) : undefined;
        if (own) {
          ownWriteRequests.push(whereOf(url));
          await route.fallback().catch(() => null);
          return;
        }
        // THE RUN'S OWN SAVE, STILL IN FLIGHT (dryrun-0928 B3): while drainOwnWrites holds the page, a
        // fetch / XHR to the page's OWN origin is the portal committing what the run wrote — never a
        // document request (a form submit), never another origin (a tracker), never a navigation.
        const drain = pg ? [...drains.values()].find((d) => d.page === pg) : undefined;
        if (drain && !navigation && /^(xhr|fetch)$/i.test(resourceType)) {
          let pageUrl = "";
          try { pageUrl = typeof pg.url === "function" ? String(pg.url() || "") : ""; } catch { pageUrl = ""; }
          const origin = originOf(url);
          if (origin !== "" && origin === originOf(pageUrl)) {
            drainRequests.push(whereOf(url));
            await route.fallback().catch(() => null);
            return;
          }
        }
        // A HUMAN-VERIFIED INFORMATION PAGE'S ONE REQUEST (#344): the slot openInfoPagePass opened
        // (identity, prefix, run state and shape all held at the click) took this request and it
        // is exactly the verified control's. 4(b) only: everything above already applied.
        // ROUND 5 — RESERVED HERE, AT THE ADMISSION: the verification's limits (30 days, 10
        // projects, a skewed clock, still on record) are checked again and the use written in one
        // backend transaction before anything is let through. A refusal, a throw or a malformed
        // answer falls through to the abort below — the hold exactly as on main, its reason named.
        if (infoAdmit && infoAdmit.refusals.length === 0) {
          let reserved: string[];
          try {
            const answer = await infoAdmit.reserve(infoAdmit.entryId, whereOf(url));
            reserved = Array.isArray(answer) ? answer.map((x) => String(x)) : ["the use could not be reserved (no answer)"];
          } catch (e) {
            reserved = [`the use could not be reserved (${String((e as { message?: string })?.message ?? e).slice(0, 80)})`];
          }
          // The await is the one place this handler yields with a slot's request in hand: a run that
          // locked or was disposed meanwhile is never let through (the use stays counted).
          if (!reserved.length && (locked || disposed)) reserved = ["the run locked while the use was being reserved"];
          // F3: …and one that met a stopping abort meanwhile (the use stays counted).
          if (!reserved.length && aborts.some(isStoppingAbort)) reserved = [INFO_PAGE_STOPPING_ABORT_REFUSAL];
          if (reserved.length) {
            infoAdmit.refusals.push(...reserved);
            infoPageRefusedRequests.push({ where: whereOf(url), refusals: reserved });
          }
        }
        if (infoAdmit && infoAdmit.refusals.length === 0) {
          infoPageAdmissions.push({ entryId: infoAdmit.entryId, where: whereOf(url), exempted: true });
          admittedEntryIds.push(infoAdmit.entryId);
          infoAfterBaseline = { entryId: infoAdmit.entryId, tokens: [...infoAdmit.tokens], ack: [...infoAdmit.ack] };
          // F1 FIX: the proof hold (3b) is ARMED AT THE ADMISSION — the next document's own requests
          // are held from its first byte, not only after checkInfoPageAfterClick returns.
          infoProof = { page: pg, entryId: infoAdmit.entryId, state: "pending", checked: false };
          infoProofEndpoint = whereOf(url);
          await route.fallback().catch(() => null);
          return;
        }
        // AN UNVERIFIED INFORMATION PAGE'S HELD REQUEST, OBSERVED (#344): the watch the click opened
        // records what the page's forward control sent — method, URL hash, media, body hashes — so
        // the run can offer the page to a person. The abort below is unchanged.
        if (infoWatchLive() && pg && pg === infoWatch!.page && navigation && /^document$/i.test(resourceType)) {
          let mainFrame = false;
          try { mainFrame = typeof pg.mainFrame === "function" && request.frame() === pg.mainFrame(); } catch { mainFrame = false; }
          if (mainFrame) {
            const w = infoWatch!;
            let contentType = "";
            try {
              const h = typeof request.allHeaders === "function" ? await request.allHeaders() : request.headers();
              contentType = String((h && (h["content-type"] ?? h["Content-Type"])) || "");
            } catch { contentType = ""; }
            let buf: Buffer | null = null;
            try { buf = request.postDataBuffer(); } catch { buf = null; }
            if (!w.capture.observed) w.capture.observed = infoPageObservedRequest(method || "?", url, contentType, buf);
            closeInfoWatch();
          }
        }
        const passWhy = infoAdmit ? ` — the information-page pass did not cover it: ${infoAdmit.refusals.join("; ").slice(0, 200)}` : "";
        await abort("review-lockdown", `the page this request came from is the review/terminal page (${label})${passWhy}`);
        return;
      }
    }
    // The slot's request was not one 4(b) would have held: it passes as on main (recorded).
    if (infoAdmit && infoAdmit.refusals.length === 0) infoPageAdmissions.push({ entryId: infoAdmit.entryId, where: whereOf(url), exempted: false });
    if (human) {
      let mainFrame = false;
      try { mainFrame = !!requestPage && typeof requestPage.mainFrame === "function" && request.frame() === requestPage.mainFrame(); } catch { mainFrame = false; }
      humanRequests.push({ where: whereOf(url), document: mainFrame && /^document$/i.test(resourceType), abortsBefore: aborts.length });
    }
    await route.fallback().catch(() => null);
  };

  await target.route("**/*", handler);
  const bs: FilingBackstop = {
    aborts,
    openWindow(rule, why) {
      closeInfo();
      const id = nextWindow++;
      windows.set(id, { rule, why: String(why || "").slice(0, 120) });
      return () => { windows.delete(id); };
    },
    approvedRequests,
    approvedAdmissions,
    approvedNavigations,
    approvedDialogs,
    allowApprovedFiling(ms: number, opts?: { page?: unknown }) {
      // Reset, never added: each approved click (the submit, a confirm dialog's OK) covers one.
      closeSlot();
      // A run that ever opened the approved final-submit door never passes an information page.
      approvedEverOpened = true;
      closeInfo();
      if (disposed) return;
      // Bound to the page the caller clicked on — by default the page this backstop was installed
      // for, never "any page" (an unbound slot is how a completion page's POST took it).
      const clicked = opts && opts.page && typeof opts.page === "object" ? opts.page : page;
      const span = Math.max(0, Math.min(ms, 60_000));
      const detachers: Array<() => void> = [];
      const s: Slot = { page: clicked, until: Date.now() + span, open: true, timer: null, detach: () => { for (const d of detachers.splice(0)) d(); } };
      slot = s;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pg: any = clicked;
      if (pg && typeof pg.on === "function" && typeof pg.off === "function") {
        // A NEW DOCUMENT on the clicked page ends the click's slot (the belt to the GET-navigation
        // braces above: a navigation the route never saw, e.g. a bfcache restore).
        const onLoad = (): void => { if (slot === s) closeSlot(); };
        pg.on("domcontentloaded", onLoad);
        detachers.push(() => { try { pg.off("domcontentloaded", onLoad); } catch { /* page gone */ } });
        // NATIVE DIALOGS DURING THE APPROVED CLICK (portal-run-close-2 M3). With no listener,
        // Playwright DISMISSES every dialog: a Submit whose onclick is `return confirm('File this
        // application now?')` cancelled its own form and the approved run never filed (skeptic
        // confirmNative). While a listener is registered Playwright no longer auto-answers, so
        // this handler answers EVERY dialog it sees: accept a confirm / alert / beforeunload whose
        // text pays nothing NOW, while the slot is open and unused; dismiss a prompt (it asks for
        // input nobody approved) and any dialog that pays now — the adapter reads approvedDialogs
        // and pauses fee_payment. FEE WORDING IS NOT PAYING (autosubmit-close, operator ruling
        // 2026-09-27 "Yes, submit and then we can pay the fees later"): "Submit application? Fees
        // will be invoiced later." is accepted; "Pay $150 and submit?" is not. ONE predicate,
        // portalSafety paymentDialogVerdict — the DOM-modal reader in replay asks the same one.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const onDialog = async (dialog: any): Promise<void> => {
          let type = "";
          let message = "";
          try { type = String(dialog.type() || ""); message = String(dialog.message() || ""); } catch { /* unreadable: dismissed below */ }
          const fee = paymentDialogVerdict(message);
          // A PAYS-NOW DIALOG CLOSES THE SLOT, WHATEVER ITS TYPE (autosubmit-2 MF-S3). Dismissing a
          // confirm() cancels its form, but an alert() cannot: "Your card on file will be charged
          // $150 when you submit." on a submit button was "dismissed", its form posted anyway, and the
          // still-open slot admitted the filing. Closed BEFORE the dialog is answered, so the form's
          // POST meets the filing-URL rule / review lock (aborted, nothing filed) and the adapter
          // pauses fee_payment off approvedDialogs.
          if (fee === "pays_now") closeSlot();
          let why = "";
          if (type === "prompt") why = "a prompt asks for input nobody approved";
          else if (fee === "pays_now") why = "it asks for a payment now — automation never pays";
          else if (!(slot === s && slotLive())) why = "outside the approved click's slot";
          else if (!/^(confirm|alert|beforeunload)$/.test(type)) why = `an unknown dialog type "${type}"`;
          const accept = !why;
          approvedDialogs.push({ type, message: message.slice(0, 200), action: accept ? "accepted" : "dismissed",
            why: accept ? (fee === "fee_deferred" ? "the approved click's own confirmation (a fee is mentioned as deferred / invoiced later — nothing is paid)" : "the approved click's own confirmation") : why });
          try { if (accept) await dialog.accept(); else await dialog.dismiss(); } catch { /* already answered / page gone */ }
        };
        pg.on("dialog", onDialog);
        detachers.push(() => { try { pg.off("dialog", onDialog); } catch { /* page gone */ } });
      }
      s.timer = setTimeout(() => { if (slot === s) closeSlot(); }, span);
    },
    openOwnWrite(pg: unknown, why: string) {
      // The run wrote a value: no information page passes on this run any more (#344).
      everWrote = true;
      closeInfo();
      const id = nextOwnWrite++;
      // Bound to the page written on — by default the backstop's own page, never "any page".
      const bound = pg && typeof pg === "object" ? pg : page;
      ownWrites.set(id, { page: bound, why: String(why || "").slice(0, 120) });
      lastOwnWriteAt.set(bound as object, Date.now());
      return () => { ownWrites.delete(id); };
    },
    ownWriteRequests,
    ownWriteSinceLoad(pg: unknown) {
      const p = (pg && typeof pg === "object" ? pg : page) as object;
      const wrote = lastOwnWriteAt.get(p);
      return typeof wrote === "number" && wrote >= (lastLoadAt.get(p) ?? 0);
    },
    openDrain(pg: unknown, why: string) {
      const id = nextDrain++;
      drains.set(id, { page: pg && typeof pg === "object" ? pg : page, why: String(why || "").slice(0, 120) });
      return () => { drains.delete(id); };
    },
    drainRequests,
    approvedSlotOpen() { return slotLive(); },
    closeApprovedSlot() { closeSlot(); },
    lockReview(why: string) {
      closeInfo();
      if (!locked) locked = `the run is at review (${String(why || label).slice(0, 100)}) — nothing legitimate posts from here until a person takes the page`;
    },
    async watchHumanInput() {
      if (disposed) return false;
      if (humanWatchArmed) return true;
      // The binding and the init script live on the context when there is one, so a popup the
      // person opens is watched too; the existing documents get the script now.
      const host = ctx && typeof ctx.exposeBinding === "function" && typeof ctx.addInitScript === "function" ? ctx
        : typeof page.exposeBinding === "function" && typeof page.addInitScript === "function" ? page : null;
      if (!host) return false;
      // An input the run itself is making (the fence) is never a person's.
      HUMAN_INPUT_SINKS.set(host, (pg) => { if (!disposed && pg && typeof pg === "object" && !automationFenced(pg as object)) humanInputAt.set(pg as object, Date.now()); });
      try {
        if (!HUMAN_INPUT_EXPOSED.has(host)) {
          await host.exposeBinding(HUMAN_INPUT_BINDING, (source: { page?: unknown }) => {
            try { HUMAN_INPUT_SINKS.get(host)?.(source && source.page); } catch { /* the watch never breaks the page */ }
          });
          await host.addInitScript({ content: HUMAN_INPUT_SCRIPT });
          // Marked only once BOTH are in place: a failed init script is retried by the next arm.
          HUMAN_INPUT_EXPOSED.add(host);
        }
      } catch { return false; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pages: any[] = host === ctx && typeof ctx.pages === "function" ? ctx.pages() : [page];
      const inject = async (): Promise<void> => {
        for (const p of pages) {
          for (const f of typeof p?.frames === "function" ? p.frames() : []) await f.evaluate(HUMAN_INPUT_SCRIPT).catch(() => null);
        }
      };
      // A navigating frame cannot answer; the init script covers the document it is loading.
      let timer: ReturnType<typeof setTimeout> | null = null;
      await Promise.race([inject(), new Promise<void>((r) => { timer = setTimeout(r, TERMINAL_READ_TIMEOUT_MS); })]);
      if (timer) clearTimeout(timer);
      // ARMED MEANS THE RUN'S OWN PAGE IS LISTENING (#333 skeptic rounds 1 and 2): the marker is read
      // back from its main frame. A frame that cannot answer (navigating, hung) is NOT armed — the
      // hand-over then fails closed and says so (NOT_HANDED_OVER_NOTE), never "the page is yours"
      // over a document that cannot see the person's click.
      let listening = false;
      try {
        const mf = typeof page.mainFrame === "function" ? page.mainFrame() : null;
        let readTimer: ReturnType<typeof setTimeout> | null = null;
        listening = mf ? Boolean(await Promise.race([
          Promise.resolve(mf.evaluate("!!window.__solarBackstopHumanInputArmed")).catch(() => false),
          new Promise<boolean>((r) => { readTimer = setTimeout(() => r(false), TERMINAL_READ_TIMEOUT_MS); }),
        ])) : false;
        if (readTimer) clearTimeout(readTimer);
      } catch { listening = false; }
      humanWatchArmed = !disposed && listening;
      return humanWatchArmed;
    },
    handOverToHuman(_why: string) {
      if (disposed || !humanWatchArmed) return false;
      closeSlot();
      closeInfo();
      if (!handedOverAt) handedOverAt = Date.now();
      return true;
    },
    handedOver() { return handedOverAt > 0 && !disposed; },
    personActedSinceHandOver(pg?: unknown) {
      const p = (pg && typeof pg === "object" ? pg : page) as object;
      return handedOverAt > 0 && !disposed && (humanInputAt.get(p) ?? 0) > handedOverAt;
    },
    async withAutomationInput<T>(pg: unknown, fn: () => Promise<T>): Promise<T> {
      const p = (pg && typeof pg === "object" ? pg : page) as object;
      automationDepth.set(p, (automationDepth.get(p) ?? 0) + 1);
      try {
        return await fn();
      } finally {
        automationDepth.set(p, Math.max(0, (automationDepth.get(p) ?? 1) - 1));
        automationEndedAt.set(p, Date.now());
      }
    },
    humanRequests,
    stoppingAborts() { return aborts.filter(isStoppingAbort); },
    async openInfoPagePass(pg: unknown, control: unknown, opts: { entries: ReadonlyArray<VerifiedInfoPage>; run: InfoPageRunState; reserve?: InfoPageReserve }): Promise<InfoPagePassOpen> {
      // A new open closes any earlier slot or watch (a candidate already observed is kept).
      closeInfo();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p: any = pg && typeof pg === "object" ? pg : page;
      const reading = await readInfoPageIdentity(p, control);
      const run = opts && opts.run ? opts.run : undefined;
      const entries = opts && Array.isArray(opts.entries) ? opts.entries : [];
      // The reading 4(b) consults for this page's NAVIGATION: its last load's (a navigation request
      // cannot be asked live). Only a page whose click 4(b) would hold asks for a pass or a candidate.
      let wideTerminal: boolean | null = lastReading.has(p) ? lastReading.get(p) ?? null : null;
      if (wideTerminal === null && p && typeof p.mainFrame === "function") wideTerminal = await mainFrameIsTerminal(p.mainFrame()).catch(() => null);
      // The backstop's own state, read AFTER the identity read (a page script may have tripped a
      // stopping abort, or the run locked, while it ran).
      const state = {
        installed: true,
        disposed,
        locked: !!locked,
        windowsOpen: windows.size > 0,
        approvedSlotOpen: slotLive(),
        approvedEverOpened,
        stoppingAbort: aborts.some(isStoppingAbort),
        everWrote,
        admissions: infoPageAdmissions.filter((a) => a.exempted).length,
        admittedEntryIds: [...admittedEntryIds],
        wideTerminal,
      };
      const digest = reading.ok ? digestInfoPageIdentity(reading.material) : null;
      const identity = reading.ok && digest
        ? { ok: true, digest, projectValueHits: run && Array.isArray(run.projectValues) ? infoPageProjectValueRefusals(reading.material.text, run.projectValues) : undefined }
        : { ok: false, why: reading.ok ? "the page could not be digested" : reading.why };
      const ctx = { backstop: state, run, identity, entries };
      const refusals = infoPagePassRefusals(ctx);
      if (!refusals.length && reading.ok && digest) {
        const entry = infoPagePassEntry(ctx);
        if (!entry) return { opened: false, refusals: ["no verified information page matches"], candidateWatch: false };
        // Round 5: no way to reserve the use at the admission = nothing opens (held as on main).
        const reserve = opts && typeof opts.reserve === "function" ? opts.reserve : null;
        if (!reserve) return { opened: false, refusals: [INFO_PAGE_NO_RESERVATION], candidateWatch: false };
        const m = reading.material;
        const q = m.page.query.map(([k, v]) => [k, v]);
        const s: InfoSlot = {
          page: p, entryId: entry.id, expected: digest.expected, beforeTokens: infoPageNumberTokens(m.text), beforeAck: infoPageAfterClickAckWording(m.text), reserve,
          pageKey: JSON.stringify([m.page.origin, m.page.path, q]), until: Date.now() + INFO_PAGE_SLOT_MS, open: true, timer: null, detach: () => undefined,
        };
        const c = bindInfoClosers(p, () => { if (infoSlot === s) closeInfoSlot(); });
        s.timer = c.timer;
        s.detach = c.detach;
        infoSlot = s;
        return { opened: true, entryId: entry.id, refusals: [], candidateWatch: false };
      }
      if (reading.ok && digest && refusals.length > 0 && refusals.every(isMatchClassRefusal)) {
        // CAPTURED NOW, before the click (amendment pin 2): a BackstopAbort carries no page identity.
        const prefix = infoPagePrefixOf(run && Array.isArray(run.priorSteps) ? run.priorSteps : []);
        const capture: InfoPageCandidateTake = { digest, prefix, material: reading.material, observed: null };
        infoCandidate = capture;
        const w: InfoWatch = { page: p, capture, until: Date.now() + INFO_PAGE_SLOT_MS, open: true, timer: null, detach: () => undefined };
        const c = bindInfoClosers(p, () => { if (infoWatch === w) closeInfoWatch(); });
        w.timer = c.timer;
        w.detach = c.detach;
        infoWatch = w;
        // INVALIDATION BEFORE THE CLICK (proposal §4): a verified page at this origin + path that
        // this read did not match exactly (signature, control, request, the steps before it). The
        // click is held exactly as on main; the run reports each as an incident.
        const drifted = infoPageDriftedEntries(digest, entries, prefix, admittedEntryIds);
        return { opened: false, refusals, candidateWatch: true, ...(drifted.length ? { drifted } : {}) };
      }
      // HELD AT A VERIFIED PAGE: the page and its steps match a verified entry, but something else
      // refused (round 2: the project's prior progress, for one). Named so the run can say so.
      let heldVerifiedEntryId: string | undefined;
      if (reading.ok && digest) {
        const m = infoPageMatchRefusals(digest, entries, infoPagePrefixOf(run && Array.isArray(run.priorSteps) ? run.priorSteps : []));
        if (m.entry && !admittedEntryIds.includes(m.entry.id)) heldVerifiedEntryId = m.entry.id;
      }
      return { opened: false, refusals, candidateWatch: false, ...(heldVerifiedEntryId ? { heldVerifiedEntryId } : {}) };
    },
    closeInfoPagePass() { closeInfo(); },
    async checkInfoPageAfterClick(pg?: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p: any = pg && typeof pg === "object" ? pg : page;
      const deadline = Date.now() + INFO_PAGE_AFTER_CLICK_MS;
      // The information page whose request this run admitted, and its own tokens (none = refused).
      const baseline = infoAfterBaseline;
      let refusals: string[] = ["the page after the click could not be read"];
      let clean = 0;
      for (;;) {
        refusals = infoPageAfterClickRefusals(await readAfterClick(p).catch(() => null), baseline);
        // TWO clean readings, INFO_PAGE_AFTER_CLICK_CONFIRM_MS apart: a form skeleton that a script
        // swaps for a receipt after the first reading is caught by the second (round 2).
        if (!refusals.length) {
          clean++;
          if (clean >= 2) break;
          await new Promise((r) => setTimeout(r, INFO_PAGE_AFTER_CLICK_CONFIRM_MS));
          continue;
        }
        // Only an empty page (no text / no form YET) is waited for, and only before a clean reading;
        // anything that reads as filed, review, an error, a new number or a filing control is final.
        const waitable = clean === 0 && refusals.every((r) => /could not be read|shows no application form/.test(r));
        if (!waitable || Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (refusals.length) bs.lockReview(`the page after a verified information page did not read as an unfiled form (${refusals[0].slice(0, 60)})`);
      // PROOF OF PROGRESS (round 3): a page that reads as an unfiled form must now TAKE this job's
      // data before anything leaves it — the hold (rule 3b) is armed on it until the learner proves it.
      else if (infoProof && infoProof.page === p && !infoProof.checked) infoProof.checked = true;
      else infoProof = { page: p, entryId: baseline ? baseline.entryId : "", state: "pending", checked: true };
      return { ok: refusals.length === 0, refusals };
    },
    infoPageProofGiven() {
      if (!infoProof) return false;
      if (infoProof.state === "pending") infoProof.state = "proved";
      return infoProof.state === "proved" || infoProof.state === "continued";
    },
    infoPageProofState() { return infoProof ? infoProof.state : "none"; },
    takeInfoPageCandidate() {
      const c = infoCandidate;
      infoCandidate = null;
      return c;
    },
    infoPageAdmissions,
    infoPageRefusedRequests,
    async dispose() {
      disposed = true;
      closeSlot();
      closeInfo();
      infoProof = null;
      if (REGISTRY.get(page) === bs) REGISTRY.delete(page);
      if (target !== page && REGISTRY.get(target) === bs) REGISTRY.delete(target);
      windows.clear();
      ownWrites.clear();
      drains.clear();
      locked = "";
      // The input binding stays exposed (Playwright cannot remove it); it now reports to nobody.
      for (const h of [ctx, page]) if (h && typeof h === "object" && HUMAN_INPUT_SINKS.has(h)) HUMAN_INPUT_SINKS.delete(h);
      for (const u of unwatch.splice(0)) u();
      await target.unroute("**/*", handler).catch(() => null);
    },
  };
  REGISTRY.set(page, bs);
  if (target !== page) REGISTRY.set(target, bs);
  return bs;
}

/** One line per abort, for a run's warnings. */
export function describeBackstopAbort(a: BackstopAbort): string {
  const what = a.rule === "filing-url" ? a.why
    : a.rule === "review-lockdown" ? `REVIEW-PAGE LOCKDOWN — ${a.why}`
      : `fired while ${a.rule === "dismisser-window" ? "an overlay dismisser click" : "a bot Enter on a review/terminal page"} was in flight (${a.why})`;
  return `BACKSTOP ABORTED ${a.method} ${a.where} (${a.resourceType || "request"}): ${what}`;
}
