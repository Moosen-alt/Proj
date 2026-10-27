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
//     A5  a payment URL right after a person's click: aborted (payment is never lifted).
//     A6  an input 1 s BEFORE the hand-over, a script POST 1 s after it: aborted (not carried over).
//     A7  a person's click BEFORE the hand-over: aborted, flagged humanInput (the run says so).
//     A8  a person's click while a dismisser window is open: aborted.
//     A9  the input watch never armed: handOverToHuman refuses, a person's click is aborted.
//   [A, #370 × #333] A REDIRECT HOP CARRIES ITS FIRST LEG'S PERSON VERDICT (Helm's merge-order asks):
//     A10 the person's submit is answered 307 → /apply/submit only after 4.6 s (past HUMAN_INPUT_MS):
//         the hop still reaches it; the person's request is recorded once (the first leg).
//     A11 the person's submit is answered 307 → /payment/charge: refused (payment first, always).
//     A12 handed over but not yet locked (the drain's moment): the run's own save goes out, the
//         person touches the page, THEN its 307 → /SubmitApplication arrives: the hop is refused
//         (the first leg was not the person's) and is not in humanRequests.
//   [B] THE REPLAY (RecipeAdapter, guided manual: no approval, the flagged final submit never clicked):
//     B1  the person clicks the portal's submit the moment the run hands the page over: the POST
//         reaches the portal, the run is NOT failed, and it reports the person's submit.
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
// Against main (no hand-over) A1 and B1 FAIL by name: the person's POST is aborted.
//
//   npx tsx portal-bot/src/adapters/humanSubmitAfterReview.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium, type Page } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { backstopFor, installFilingBackstop, isStoppingAbort, withBackstopWindow, withOwnWriteWindow, type FilingBackstop } from "../filingBackstop";
import { HUMAN_CLICK_HELD_NOTE, PERSON_REQUEST_WENT_NOTE, RecipeAdapter } from "./recipeAdapter";

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
const reviewBody = (k: string): string => {
  const summary = `<h1>Step 3: Review</h1><p>Please review your application before you submit it.</p><table><tr><th>Address</th><td>100 Fixture Way</td></tr></table>`;
  if (k === "B5") return `${summary}${formSubmit(k)}<button type="button" id="saveLater" onclick="fetch('/h/B5/api/save-later', { method: 'POST', body: 'x=1' }).then(function () { location.href = '/h/B5/records'; })">Save for Later</button>`;
  if (k === "B6") return `${summary}${formSubmit(k)}${SEND(k)}`;
  // The run's tick on the review page starts an 8 s "Saving..." (PowerClerk's batched autosave shape;
  // long enough to outlast the run's tail up to its drain).
  if (k === "B7") return `${summary}<span data-test-role="project-save-state">Saved</span>
    <div><input type="checkbox" id="terms"> <label for="terms">I certify the information in this application is correct</label></div>${formSubmit(k)}${SEND(k)}
    <script>
      var st = document.querySelector("[data-test-role='project-save-state']"); var timer = null;
      document.getElementById('terms').addEventListener('change', function () {
        st.textContent = 'Saving...';
        if (timer) return;
        timer = setTimeout(function () {
          fetch('/h/B7/Project/SaveChanges', { method: 'POST', body: 'terms=on' }).then(function () { st.textContent = 'Saved'; }).catch(function () { st.textContent = 'Save failed'; });
        }, 8000);
      });
    </script>`;
  if (k === "B8") return `${summary}${formSubmit(k)}<a id="older" href="/h/B8/record">Older application BLD-2026-900001</a>`;
  if (k === "B9") return `${summary}${formSubmit(k)}<button type="button" id="pay" onclick="fetch('/h/B9/payment/charge', { method: 'POST', body: 'amt=150' }).catch(function () {})">Pay Fees</button>`;
  if (k === "A4") return `${summary}<button type="button" id="btnSubmit" onclick="window.open('/h/A4/popup', '_blank')">Submit Application</button>`;
  if (k === "A5") return `${summary}<button type="button" id="btnSubmit" onclick="fetch('/h/A5/payment/charge', { method: 'POST', body: 'amt=150' }).catch(function(){})">Submit Application</button>`;
  // The portal answers the submit with a method-keeping redirect (judged as a fresh request, #370).
  if (k === "A10") return `${summary}<form method="post" action="/h/A10/apply/slow307"><button type="submit" id="btnSubmit">Submit Application</button></form>`;
  if (k === "A11") return `${summary}<form method="post" action="/h/A11/apply/pay307"><button type="submit" id="btnSubmit">Submit Application</button></form>`;
  return `${summary}<form method="post" action="/h/${k}/apply/submit"><button type="submit" id="btnSubmit">Submit Application</button></form>`;
};
// Method-keeping redirects the fixture answers, with the delay before the 307 (ms): the slow one lands
// after HUMAN_INPUT_MS (4 s) has passed since the person's click.
const REDIRECTS: Record<string, [string, number]> = {
  "apply/slow307": ["apply/submit", 4600],
  "apply/pay307": ["payment/charge", 300],
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
  if (req.method === "POST" && rest === "apply/submit") { send(COMPLETION); return; }
  if (rest === "popup") { send(html("Processing", `<h1>Processing</h1><script>fetch('/h/${k}/popup/post', { method: 'POST', body: 'from=popup' }).catch(function(){});</script>`)); return; }
  if (req.method !== "GET") { res.writeHead(204); res.end(); return; }
  if (rest === "records") { send(MY_RECORDS); return; }
  if (rest === "record") { send(OLD_RECORD); return; }
  if (rest === "done") { send(COMPLETION); return; }
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
const brief = (b: Bed, k: string, from: number): string => JSON.stringify({
  posts: postsFor(k, from).map((p) => p.path), aborts: b.bs.aborts.map((a) => ({ rule: a.rule, where: a.where.replace(base, ""), human: !!a.humanInput })), humanRequests: b.bs.humanRequests.map((r) => ({ ...r, where: r.where.replace(base, "") })),
}).slice(0, 700);

console.log("\n[A] THE BACKSTOP, DIRECTLY");
{
  const from = posts.length;
  const b = await bed("A1");
  await personClicks(b.page);
  await sleep(900);
  check("A1 a person's click after the hand-over: their form POST (a filing URL) reaches the portal",
    postsFor("A1", from).filter((p) => /\/apply\/submit$/.test(p.path)).length === 1, brief(b, "A1", from));
  check("A1 …recorded as the person's request (a main-frame document submission), no stopping abort",
    b.bs.humanRequests.some((r) => r.document && /\/apply\/submit$/.test(r.where)) && b.bs.stoppingAborts().length === 0, brief(b, "A1", from));
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
  await personClicks(b.page);
  await sleep(700);
  check("A5 a payment URL right after a person's click: aborted (payment is never lifted)",
    postsFor("A5", from).length === 0 && b.bs.aborts.some((a) => /\/payment\/charge$/.test(a.where)), brief(b, "A5", from));
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
  await sleep(1800);
  const p = postsFor("A11", from).map((x) => x.path);
  const hop = b.bs.aborts.find((a) => a.redirect && /\/apply\/pay307$/.test(a.redirect.from) && /\/payment\/charge$/.test(a.where));
  check("A11 MUST-EXCLUDE the person's submit answered 307 → /payment/charge: nothing reaches it (payment is checked before the person's verdict)",
    p.filter((x) => /\/apply\/pay307$/.test(x)).length === 1 && !p.some((x) => /\/payment\/charge$/.test(x)) && !!hop && hop.rule === "filing-url" && isStoppingAbort(hop), brief(b, "A11", from));
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
  await b.close();
}

// ---------------------------------------------------------------------------------------------
// [B] The replay
// ---------------------------------------------------------------------------------------------
console.log("\n[B] THE REPLAY (guided manual: the flagged final submit is never clicked by automation)");
const flagged: RecipeStep = { action: "click", selector: { css: "#btnSubmit" }, note: "final submit: Submit Application", isFinalSubmit: true } as RecipeStep;
const TICK = { action: "check", selector: { css: "#terms", label: "I certify the information in this application is correct" }, note: "I certify the information in this application is correct" } as RecipeStep;
const recipeFor = (k: string, extra: RecipeStep[] = []): PortalRecipe => ({
  id: `human-submit-${k}`, scopeType: "ahj", profileKey: "or|fernhollow|", state: "OR", ahj: "City of Fernhollow", utility: "",
  portalPlatform: "fixture", portalUrl: `${base}/h/${k}/review`, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
  steps: [
    { action: "goto", value: `${base}/h/${k}/review`, note: "open the review page" } as RecipeStep,
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
}
async function replay(k: string, opts: { autoSubmit?: boolean; extraSteps?: RecipeStep[]; onHandOver?: (page: Page, adapter: RecipeAdapter) => Promise<unknown>; onArmed?: (page: Page, track: (p: Promise<unknown>) => void) => Promise<void>; onDrain?: (page: Page, track: (p: Promise<unknown>) => void) => void; afterFill?: (page: Page) => Promise<unknown> } = {}): Promise<Replay> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const from = posts.length;
  let watchArmed = false;
  let extra: unknown;
  let pending: Promise<unknown> | null = null;
  const spied: { bs: FilingBackstop | null } = { bs: null };
  const tracked: Array<Promise<unknown>> = [];
  const drain = { closedAt: 0 };
  // The adapter's own progress line at the hand-over is the moment a watching person can click.
  const adapter: RecipeAdapter = new RecipeAdapter(recipeFor(k, opts.extraSteps ?? []), {}, {}, {
    ...(opts.autoSubmit ? { autoSubmit: true } : {}),
    onProgress: (p) => {
      if (/the page is yours/i.test(String(p.message ?? "")) && opts.onHandOver && !pending) pending = opts.onHandOver(page, adapter).then((v) => { extra = v; }, (e) => { extra = e; });
    },
  });
  (adapter as unknown as { page: unknown }).page = page;
  // Spy the backstop the run installs: note when its input watch is armed (and run onArmed then).
  const spy = setInterval(() => {
    const bs = backstopFor(page) as (FilingBackstop & { __spied?: boolean }) | null;
    if (!bs || bs.__spied) return;
    bs.__spied = true;
    spied.bs = bs;
    const orig = bs.watchHumanInput.bind(bs);
    bs.watchHumanInput = async () => { const r = await orig(); watchArmed = watchArmed || r; if (r && opts.onArmed) await opts.onArmed(page, (p) => { tracked.push(p); }); return r; };
    // THE RUN IS STILL FINISHING WHEN THE PERSON ACTS. On this local fixture the run's tail takes
    // milliseconds (on a real portal its review read-back and screenshots take seconds), so the
    // backstop is let go only once the person's action, and the page it led to, have settled.
    const dispose = bs.dispose.bind(bs);
    bs.dispose = async () => { if (pending) tracked.push(pending); await Promise.allSettled(tracked); if (tracked.length) await sleep(1500); return dispose(); };
    // The moment the run starts draining its own save is when onDrain's person acts (whatever the
    // run's tail took to get there).
    if (opts.onDrain) {
      const openDrain = bs.openDrain.bind(bs);
      let fired = false;
      bs.openDrain = (pg: unknown, why: string) => {
        const first = !fired;
        if (first) { fired = true; opts.onDrain!(page, (p) => { tracked.push(p); }); }
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
  if (opts.afterFill) await opts.afterFill(page).catch(() => null);
  await sleep(2000); // a completion page's read lands ~1.2 s after its load
  const review = await adapter.stopAtReview();
  await ctx.close().catch(() => null);
  return {
    ok: fill.ok, message: String(fill.message ?? ""), data: (fill.data ?? {}) as Record<string, unknown>,
    pauseReason: String((fill as { pauseReason?: unknown }).pauseReason ?? ""),
    review: { ok: review.ok, message: String(review.message ?? ""), data: (review.data ?? {}) as Record<string, unknown> },
    posts: postsFor(k, from).map((p) => p.path), watchArmed, handedOver: /the page is yours/.test(String(fill.message ?? "")) || watchArmed, extra,
    observed,
    humanRequests: (spied.bs?.humanRequests ?? []).map((r) => r.where.replace(base, "")),
    drainClosedAt: drain.closedAt,
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
}
{
  // The click settles (its watch report and its held request) before the run can hand over: the watch
  // stamps an input when its report reaches the run, so a click a few ms before the hand-over could
  // otherwise count as after it — and a person's own click after the hand-over is let through.
  const r = await replay("B2", { onArmed: async (page) => { await personClicks(page); await sleep(500); } });
  check("B2 the person clicks BEFORE the hand-over: held, nothing reached the portal", r.posts.length === 0, rbrief(r));
  check("B2 …the run is not failed, and it says plainly to click again", r.ok === true && (r.message.includes(HUMAN_CLICK_HELD_NOTE) || JSON.stringify(r.data).includes("YOUR CLICK WAS HELD BACK") || JSON.stringify(r.review.data).includes("YOUR CLICK WAS HELD BACK")), rbrief(r));
  check("B2 …and the error page a held click leaves is not 'where the run stopped' (never 'stopped before review')", r.pauseReason !== "stopped_before_review", rbrief(r));
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
  // wait the indicator out first, so the drain is short; the tick is long past the fence's grace).
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

await browser.close();
server.close();
if (failures) { console.error(`\n${failures}/${total} humanSubmitAfterReview.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log(`\nAll ${total}/${total} humanSubmitAfterReview.dom.smoke checks passed.`);
process.exit(0);
