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
//   [B] THE REPLAY (RecipeAdapter, guided manual: no approval, the flagged final submit never clicked):
//     B1  the person clicks the portal's submit the moment the run hands the page over: the POST
//         reaches the portal, the run is NOT failed, and it reports the person's submit.
//     B2  the person clicks BEFORE the hand-over: held, 0 POSTs, the run is not failed and says
//         "click again" (HUMAN_CLICK_HELD_NOTE).
//     B3  automation tries to click after the hand-over: the replay refuses its own input
//         (inputsClosed), 0 POSTs.
//     B4  an approved run (autoSubmit) is never handed over (the watch is never armed).
// Against main (no hand-over) A1 and B1 FAIL by name: the person's POST is aborted.
//
//   npx tsx portal-bot/src/adapters/humanSubmitAfterReview.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium, type Page } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { backstopFor, installFilingBackstop, isStoppingAbort, withBackstopWindow, type FilingBackstop } from "../filingBackstop";
import { HUMAN_CLICK_HELD_NOTE, RecipeAdapter } from "./recipeAdapter";

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
const reviewBody = (k: string): string => {
  const summary = `<h1>Step 3: Review</h1><p>Please review your application before you submit it.</p><table><tr><th>Address</th><td>100 Fixture Way</td></tr></table>`;
  if (k === "A4") return `${summary}<button type="button" id="btnSubmit" onclick="window.open('/h/A4/popup', '_blank')">Submit Application</button>`;
  if (k === "A5") return `${summary}<button type="button" id="btnSubmit" onclick="fetch('/h/A5/payment/charge', { method: 'POST', body: 'amt=150' }).catch(function(){})">Submit Application</button>`;
  return `${summary}<form method="post" action="/h/${k}/apply/submit"><button type="submit" id="btnSubmit">Submit Application</button></form>`;
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean); // h, <k>, ...
  const k = parts[0] === "h" ? parts[1] || "" : "";
  const rest = parts.slice(2).join("/");
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") posts.push({ k, path: url.pathname });
  const send = (body: string): void => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(body); };
  if (req.method === "POST" && rest === "apply/submit") { send(COMPLETION); return; }
  if (rest === "popup") { send(html("Processing", `<h1>Processing</h1><script>fetch('/h/${k}/popup/post', { method: 'POST', body: 'from=popup' }).catch(function(){});</script>`)); return; }
  if (req.method !== "GET") { res.writeHead(204); res.end(); return; }
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
async function bed(k: string, opts: { arm?: boolean; handOver?: boolean } = {}): Promise<Bed> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${base}/h/${k}/review`);
  const bs = await installFilingBackstop(page, `human-submit ${k}`);
  if (!bs) throw new Error("no backstop");
  bs.lockReview(`smoke ${k} at review`);
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

// ---------------------------------------------------------------------------------------------
// [B] The replay
// ---------------------------------------------------------------------------------------------
console.log("\n[B] THE REPLAY (guided manual: the flagged final submit is never clicked by automation)");
const flagged: RecipeStep = { action: "click", selector: { css: "#btnSubmit" }, note: "final submit: Submit Application", isFinalSubmit: true } as RecipeStep;
const recipeFor = (k: string): PortalRecipe => ({
  id: `human-submit-${k}`, scopeType: "ahj", profileKey: "or|fernhollow|", state: "OR", ahj: "City of Fernhollow", utility: "",
  portalPlatform: "fixture", portalUrl: `${base}/h/${k}/review`, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
  steps: [
    { action: "goto", value: `${base}/h/${k}/review`, note: "open the review page" } as RecipeStep,
    { action: "stopForReview" } as RecipeStep,
    flagged,
  ],
} as PortalRecipe);
interface Replay { ok: boolean; message: string; data: Record<string, unknown>; review: { ok: boolean; message: string; data: Record<string, unknown> }; posts: string[]; watchArmed: boolean; handedOver: boolean; extra?: unknown }
async function replay(k: string, opts: { autoSubmit?: boolean; onHandOver?: (page: Page, adapter: RecipeAdapter) => Promise<unknown>; onArmed?: (page: Page) => Promise<void> } = {}): Promise<Replay> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const from = posts.length;
  let watchArmed = false;
  let extra: unknown;
  let pending: Promise<unknown> | null = null;
  // The adapter's own progress line at the hand-over is the moment a watching person can click.
  const adapter: RecipeAdapter = new RecipeAdapter(recipeFor(k), {}, {}, {
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
    const orig = bs.watchHumanInput.bind(bs);
    bs.watchHumanInput = async () => { const r = await orig(); watchArmed = watchArmed || r; if (r && opts.onArmed) await opts.onArmed(page); return r; };
  }, 2);
  const project = { id: `p-${k}` } as ProjectRecord;
  const fill = await adapter.fillApplication(project);
  clearInterval(spy);
  if (pending) await pending;
  await sleep(600);
  const review = await adapter.stopAtReview();
  await ctx.close().catch(() => null);
  return {
    ok: fill.ok, message: String(fill.message ?? ""), data: (fill.data ?? {}) as Record<string, unknown>,
    review: { ok: review.ok, message: String(review.message ?? ""), data: (review.data ?? {}) as Record<string, unknown> },
    posts: postsFor(k, from).map((p) => p.path), watchArmed, handedOver: /the page is yours/.test(String(fill.message ?? "")) || watchArmed, extra,
  };
}
const rbrief = (r: Replay): string => JSON.stringify({ ok: r.ok, posts: r.posts, msg: r.message.slice(0, 260), review: { ok: r.review.ok, msg: r.review.message.slice(0, 260), human: r.review.data.humanSubmittedInReviewWindow }, armed: r.watchArmed, extra: r.extra instanceof Error ? r.extra.message.slice(0, 160) : r.extra }).slice(0, 900);

{
  const r = await replay("B1", { onHandOver: (page) => personClicks(page) });
  check("B1 the person clicks the portal's submit the moment the run hands the page over: the POST reaches the portal",
    r.posts.filter((p) => /\/apply\/submit$/.test(p)).length === 1, rbrief(r));
  check("B1 …the run is NOT failed", r.ok === true, rbrief(r));
  check("B1 …and it reports the person's submit from the review window (automation clicked nothing)",
    r.review.ok === true && r.review.data.humanSubmittedInReviewWindow === true && r.review.data.finalSubmitClicked === false, rbrief(r));
}
{
  const r = await replay("B2", { onArmed: (page) => personClicks(page) });
  check("B2 the person clicks BEFORE the hand-over: held, nothing reached the portal", r.posts.length === 0, rbrief(r));
  check("B2 …the run is not failed, and it says plainly to click again", r.ok === true && (r.message.includes(HUMAN_CLICK_HELD_NOTE) || JSON.stringify(r.data).includes("YOUR CLICK WAS HELD BACK") || JSON.stringify(r.review.data).includes("YOUR CLICK WAS HELD BACK")), rbrief(r));
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

await browser.close();
server.close();
if (failures) { console.error(`\n${failures}/${total} humanSubmitAfterReview.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log(`\nAll ${total}/${total} humanSubmitAfterReview.dom.smoke checks passed.`);
process.exit(0);
