// #381 — A NATIVE DIALOG ON THE WINDOW HANDED TO A PERSON WAITS FOR THAT PERSON; AUTOMATION NEVER
// ANSWERS ONE.
//
// Helm's reproduction (PR #378 review, main too): with no `dialog` listener on the window a replay leaves
// open, Playwright dismissed every native dialog by itself, so a portal whose Submit asks
// `confirm("Submit this application?")` could never be answered Yes by the person: the click resolved
// as Cancel and nothing was posted.
//
// A local fixture portal on 127.0.0.1 (never a real one); every non-GET request it receives is counted,
// so "1 POST" / "0 POSTs" is what the SERVER saw. THE PERSON is simulated the way a person acts in a
// headed window: a raw page.mouse.click on the Submit (a trusted event, never awaited — the click does
// not return while the dialog is open), and their answer to the browser's own dialog through a DevTools
// session of the person's, opened before the click (Page.handleJavaScriptDialog — the browser UI's
// button, which no page script and no Playwright call of the product makes). Product code never calls
// accept() / dismiss() on a dialog after the hand-over (personDialogs.test pins that by source).
//
//   D1  the person clicks the confirm()-guarded Submit at the hand-over and answers YES 5 s later (past
//       HUMAN_INPUT_MS, while the run still holds the page): the form posts ONCE, the run is not failed,
//       the submit is handed on once and the runner's capture records BLD-2026-900123. Red before: the
//       dialog was dismissed by Playwright (0 POSTs, the person never saw it); with only the listener
//       (no "the person's Yes is their input"), the POST was held by the review lockdown.
//   D1b the same Yes after the run let go (the left-open window, the stage finished): posts once,
//       captured. Red before: dismissed (Helm's `confirm=false` after the run let go).
//   D2  the person answers CANCEL: 0 POSTs, never "filed", nothing captured, no submit handed on; the
//       hand-off says the portal asked for a confirmation and never "click again" / "submit again".
//   D3  a page script opens a confirm() at the hand-over and NO person answers: the run's tail finishes
//       (the review read-back is skipped and says so; never "STOPPED … NOT the review page"), the
//       capture reads nothing, the dialog is STILL OPEN after the run, its report and its capture, and
//       nothing is posted. Red before: dismissed by Playwright (a person was never asked).
//   D4  BEFORE the hand-over dialogs behave exactly as on main: a page-load confirm() on the review page
//       is dismissed (the page reads `confirm=false`) and the run goes on to hand the page over. GUARD
//       pin, green before by design. Kill: register the listener before the hand-over.
//   D5  a window index.ts leaves open WITHOUT a hand-over (trackOpenAdapter: a refused hand-over, a
//       hand-coded adapter, a paused run): the person's Yes posts once; their Cancel posts nothing. Red
//       before: dismissed.
//
//   npx tsx portal-bot/src/adapters/personDialogAfterHandOver.dom.smoke.ts
import "../smokeArtifactDirs";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type CDPSession, type Page } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { backstopFor, type FilingBackstop } from "../filingBackstop";
import { dialogOpenOn } from "../personDialogs";
import * as recipeAdapterModule from "./recipeAdapter";
import { RecipeAdapter } from "./recipeAdapter";
import { armSubmitCapture, trackOpenAdapter } from "../index";

let failures = 0;
let total = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  total++;
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
// Read by namespace: undefined on code without #381 (a FAIL by name, never a link-time SyntaxError).
const REVIEW_READ_SKIPPED_SUMMARY = String((recipeAdapterModule as Record<string, unknown>).REVIEW_READ_SKIPPED_SUMMARY ?? "(no REVIEW_READ_SKIPPED_SUMMARY)");
const DIALOG_WAITING_CAPTURE = String((recipeAdapterModule as Record<string, unknown>).DIALOG_WAITING_CAPTURE ?? "(no DIALOG_WAITING_CAPTURE)");

// ---------------------------------------------------------------------------------------------
// The fixture portal
// ---------------------------------------------------------------------------------------------
const RECORD = "BLD-2026-900123";
const posts: Array<{ k: string; path: string }> = [];
const html = (title: string, body: string): string => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const SUMMARY = `<h1>Step 3: Review</h1><p>Please review your application before you submit it.</p><table><tr><th>Address</th><td>100 Fixture Way</td></tr></table>`;
const confirmForm = (k: string): string => `<form method="post" action="/h/${k}/apply/submit" onsubmit="return confirm('Submit this application?')"><button type="submit" id="btnSubmit">Submit Application</button></form>`;
const COMPLETION = html("Application Submitted", `<h1>Application Submitted</h1><p>Your application has been successfully submitted.</p><p>Record Number: ${RECORD}</p>`);
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);
  const k = parts[0] === "h" ? parts[1] || "" : "";
  const rest = parts.slice(2).join("/");
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") posts.push({ k, path: url.pathname });
  const send = (body: string): void => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(body); };
  if (req.method === "POST" && rest === "apply/submit") { send(COMPLETION); return; }
  if (req.method !== "GET") { res.writeHead(204); res.end(); return; }
  if (rest === "review" && k === "D4") {
    // A page-load confirm() BEFORE the hand-over: Playwright answers it (dismissed), as on main.
    send(html("Review and Submit", `${SUMMARY}<script>document.title = 'confirm=' + confirm('Continue to the review?');</script>${confirmForm(k)}`));
    return;
  }
  if (rest === "review") { send(html("Review and Submit", `${SUMMARY}${confirmForm(k)}`)); return; }
  send(html("Not found", "<h1>Not found</h1>"));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch();
const postsFor = (k: string, from: number): string[] => posts.slice(from).filter((p) => p.k === k).map((p) => p.path);

// ---------------------------------------------------------------------------------------------
// The person: a trusted click, and their answer to the browser's dialog
// ---------------------------------------------------------------------------------------------
interface Person {
  session: CDPSession;
  opened: number[];
  closed: Array<{ at: number; result: boolean }>;
  clicking: Promise<unknown> | null;
}
async function personFor(page: Page): Promise<Person> {
  const session = await page.context().newCDPSession(page);
  const p: Person = { session, opened: [], closed: [], clicking: null };
  session.on("Page.javascriptDialogOpening", () => { p.opened.push(Date.now()); });
  session.on("Page.javascriptDialogClosed", (e: { result?: boolean }) => { p.closed.push({ at: Date.now(), result: e?.result === true }); });
  // Enabled BEFORE any dialog opens (a session enabling Page while one is open never answers).
  await session.send("Page.enable");
  return p;
}
/** The person clicks the Submit (never awaited: a click whose page opened a dialog returns only once
 *  the dialog is answered) and waits until the browser shows its dialog. */
async function personClicksSubmit(page: Page, person: Person): Promise<boolean> {
  const before = person.opened.length;
  const box = await page.locator("#btnSubmit").first().boundingBox();
  if (!box) throw new Error("no Submit box");
  person.clicking = page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => null);
  const t0 = Date.now();
  while (person.opened.length === before && Date.now() - t0 < 5000) await sleep(20);
  return person.opened.length > before;
}
/** The person presses the dialog's own button: OK / Yes (true) or Cancel (false). */
async function personAnswers(page: Page, person: Person, yes: boolean): Promise<void> {
  // No dialog showing (it was already answered — by Playwright, before #381) fails the checks, never the smoke.
  await person.session.send("Page.handleJavaScriptDialog", { accept: yes }).catch(() => null);
  await person.clicking;
  if (yes) await page.waitForLoadState("load", { timeout: 5000 }).catch(() => null);
}

// ---------------------------------------------------------------------------------------------
// The replay (guided manual, handed over), as index.ts stageWithRecipe runs it
// ---------------------------------------------------------------------------------------------
const flagged: RecipeStep = { action: "click", selector: { css: "#btnSubmit" }, note: "final submit: Submit Application", isFinalSubmit: true } as RecipeStep;
const recipeFor = (k: string): PortalRecipe => ({
  id: `person-dialog-${k}`, scopeType: "ahj", profileKey: "or|fernhollow|", state: "OR", ahj: "City of Fernhollow", utility: "",
  portalPlatform: "fixture", portalUrl: `${base}/h/${k}/review`, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
  steps: [
    { action: "goto", value: `${base}/h/${k}/review`, note: "open the review page" } as RecipeStep,
    { action: "stopForReview" } as RecipeStep,
    flagged,
  ],
} as PortalRecipe);
type SubmitCapture = Parameters<NonNullable<Parameters<typeof armSubmitCapture>[1]["onSubmitCaptured"]>>[0];
interface Run {
  ok: boolean; message: string; data: Record<string, unknown>;
  review: { ok: boolean; message: string; data: Record<string, unknown> };
  posts: string[]; observed: string[]; captures: SubmitCapture[]; handedOver: boolean; fillMs: number;
  aborts: Array<{ where: string; rule: string; human: boolean }>;
  person: Person; extra?: unknown; dialogOpenAtEnd: boolean; reported?: unknown; title: string;
  /** The person's session's record of dialog closes, taken BEFORE the window is closed (closing a page
   *  with a dialog open reports one more close, result false — the harness's, not the run's). */
  closedAtEnd: Array<{ at: number; result: boolean }>;
}
async function replay(k: string, opts: {
  onHandOver?: (page: Page, person: Person) => Promise<unknown>;
  afterFill?: (page: Page, person: Person) => Promise<unknown>;
  afterReport?: (page: Page, adapter: RecipeAdapter) => Promise<unknown>;
  settleMs?: number;
} = {}): Promise<Run> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const person = await personFor(page);
  const from = posts.length;
  let pending: Promise<unknown> | null = null;
  let extra: unknown;
  let handedOver = false;
  const spied: { bs: FilingBackstop | null } = { bs: null };
  const adapter: RecipeAdapter = new RecipeAdapter(recipeFor(k), {}, {}, {
    handOverReview: true,
    onProgress: (p) => {
      if (/the page is yours/i.test(String(p.message ?? ""))) {
        handedOver = true;
        if (opts.onHandOver && !pending) pending = opts.onHandOver(page, person).then((v) => { extra = v; }, (e) => { extra = e; });
      }
    },
  });
  (adapter as unknown as { page: unknown }).page = page;
  // THE RUN IS STILL FINISHING WHEN THE PERSON ACTS: on this fixture the tail takes milliseconds (on a
  // real portal seconds), so the backstop is let go only once the person's action has settled.
  const spy = setInterval(() => {
    const bs = backstopFor(page) as (FilingBackstop & { __spied?: boolean }) | null;
    if (!bs || bs.__spied) return;
    bs.__spied = true;
    spied.bs = bs;
    const dispose = bs.dispose.bind(bs);
    bs.dispose = async () => { if (pending) { await pending; await sleep(1000); } return dispose(); };
  }, 2);
  const t0 = Date.now();
  const fill = await adapter.fillApplication({ id: `p-${k}` } as ProjectRecord);
  const fillMs = Date.now() - t0;
  clearInterval(spy);
  if (pending) await pending;
  // What the runner does next for a left-open window: watch for the person's submit, capture it.
  const observed: string[] = [];
  const captures: SubmitCapture[] = [];
  await adapter.armSubmitWatch((label?: string) => { observed.push(label || "(completion page)"); }).catch(() => false);
  await armSubmitCapture(adapter, { onSubmitCaptured: (c) => { captures.push(c); } });
  if (opts.afterFill) extra = await opts.afterFill(page, person).catch((e: unknown) => e);
  await sleep(opts.settleMs ?? 6500); // the capture reads 4 s after the submit is handed on
  const review = await adapter.stopAtReview();
  const reported = opts.afterReport ? await opts.afterReport(page, adapter).catch((e: unknown) => e) : undefined;
  const dialogOpenAtEnd = dialogOpenOn(page);
  const closedAtEnd = [...person.closed];
  const title = dialogOpenAtEnd ? "(dialog open)" : await Promise.race([page.title().catch(() => ""), sleep(2000).then(() => "(unread)")]);
  await ctx.close().catch(() => null);
  return {
    ok: fill.ok, message: String(fill.message ?? ""), data: (fill.data ?? {}) as Record<string, unknown>,
    review: { ok: review.ok, message: String(review.message ?? ""), data: (review.data ?? {}) as Record<string, unknown> },
    posts: postsFor(k, from), observed, captures, handedOver, fillMs,
    aborts: (spied.bs?.aborts ?? []).map((a) => ({ where: a.where.replace(base, ""), rule: a.rule, human: !!a.humanInput })),
    person, extra, dialogOpenAtEnd, reported, title, closedAtEnd,
  };
}
const notesOf = (r: Run): string[] => (r.review.data.reviewHandoffNotes as string[] | undefined) ?? [];
const said = (r: Run): string => JSON.stringify({ fill: r.message, m: r.review.message, d: r.review.data });
const recorded = (r: Run): string[] => r.captures.filter((c) => !!c.recordNumber).map((c) => c.recordNumber);
const brief = (r: Run): string => JSON.stringify({
  ok: r.ok, handedOver: r.handedOver, fillMs: r.fillMs, posts: r.posts, observed: r.observed,
  captures: r.captures.map((c) => `${c.recordNumber || "-"}/${c.confidence}/${c.source}`), aborts: r.aborts,
  opened: r.person.opened.length, closed: r.closedAtEnd, open: r.dialogOpenAtEnd, verdict: r.review.data.humanClick,
  fill: r.message.slice(0, 300), msg: r.review.message.slice(0, 300), notes: notesOf(r).map((n) => n.slice(0, 260)),
  extra: r.extra instanceof Error ? r.extra.message.slice(0, 160) : r.extra,
}).slice(0, 2400);
const CLICK_AGAIN = /click again|submit again|click submit again|click it again/i;

console.log("\n[D] A NATIVE DIALOG AFTER THE HAND-OVER WAITS FOR THE PERSON");
{
  // D1: the person's Yes, 5 s after their click, while the run still holds the page.
  const r = await replay("D1", {
    onHandOver: async (page, person) => {
      const shown = await personClicksSubmit(page, person);
      await sleep(5000); // past HUMAN_INPUT_MS (4 s) since the click
      if (shown) await personAnswers(page, person, true);
      return shown;
    },
  });
  check("D1 the person clicks the confirm()-guarded Submit after the hand-over: the browser's dialog waits for them (not dismissed)",
    r.handedOver && r.extra === true && r.closedAtEnd.length >= 1 && r.closedAtEnd[0].result === true && r.closedAtEnd[0].at - r.person.opened[0] >= 4500, brief(r));
  check("D1 …their Yes 5 s later posts the form ONCE (the backstop let it through as theirs: no stopping abort)",
    r.posts.filter((p) => /\/apply\/submit$/.test(p)).length === 1 && r.posts.length === 1 && !r.aborts.some((a) => /filing|lockdown/.test(a.rule)), brief(r));
  check("D1 …the run is NOT failed, the submit is handed on once, and the capture records the filing's number",
    r.ok === true && r.observed.length === 1 && recorded(r).includes(RECORD) && !recorded(r).some((n) => n !== RECORD), brief(r));
  check("D1 …the review step says the person filed (and never 'click again')",
    r.review.data.humanSubmittedInReviewWindow === true && !CLICK_AGAIN.test(said(r)), brief(r));
}
{
  // D1b: the window the run left open, the stage finished: the person clicks and answers Yes.
  const r = await replay("D1b", {
    afterFill: async (page, person) => {
      const shown = await personClicksSubmit(page, person);
      await sleep(1500);
      if (shown) await personAnswers(page, person, true);
      return shown;
    },
    settleMs: 7000,
  });
  check("D1b after the run let go, the person's Yes on the confirm() posts ONCE and is captured",
    r.extra === true && r.closedAtEnd[0]?.result === true && r.posts.filter((p) => /\/apply\/submit$/.test(p)).length === 1 && r.posts.length === 1
      && r.observed.length === 1 && recorded(r).includes(RECORD), brief(r));
}
{
  // D2: the person's Cancel.
  const r = await replay("D2", {
    onHandOver: async (page, person) => {
      const shown = await personClicksSubmit(page, person);
      await sleep(1500);
      if (shown) await personAnswers(page, person, false);
      return shown;
    },
  });
  check("D2 the person answers CANCEL: nothing reaches the portal, nothing is captured, no submit handed on",
    r.extra === true && r.closedAtEnd[0]?.result === false && r.posts.length === 0 && r.captures.length === 0 && r.observed.length === 0, brief(r));
  check("D2 …never 'filed', and the run is not failed", r.review.data.humanSubmittedInReviewWindow !== true && !said(r).includes("has been filed") && r.ok === true, brief(r));
  check("D2 …the hand-off names the click, says the portal asked for a confirmation, and never says 'click again' / 'submit again'",
    notesOf(r).some((n) => n.startsWith('YOU CLICKED "Submit Application"') && /asked for a confirmation/.test(n) && /only you answer it/.test(n)) && !CLICK_AGAIN.test(said(r)), brief(r));
}
{
  // D3: a page script's confirm() at the hand-over; no person answers it.
  const r = await replay("D3", {
    onHandOver: async (page) => {
      // The page's own script (no input of anyone's): confirm, then submit the form on a Yes.
      await page.evaluate(() => { setTimeout(() => { if (confirm("Save and submit your application now?")) (document.querySelector("form") as HTMLFormElement).submit(); }, 0); });
      await sleep(300);
      return true;
    },
    afterReport: (_page, adapter) => Promise.race([adapter.captureSubmissionConfirmation(), sleep(10_000).then(() => "the capture hung")]),
    settleMs: 1500,
  });
  check("D3 a page script's confirm() at the hand-over, no person: the run's tail still finishes (no read waits on the dialog)",
    r.handedOver && r.fillMs < 30_000 && r.person.opened.length === 1, brief(r));
  check("D3 …the dialog is STILL OPEN after the run, its report and its capture — automation answered nothing",
    r.dialogOpenAtEnd && r.closedAtEnd.length === 0, brief(r));
  check("D3 …nothing reached the portal, nothing captured, never 'filed'",
    r.posts.length === 0 && r.captures.length === 0 && r.review.data.humanSubmittedInReviewWindow !== true, brief(r));
  check("D3 …the review read-back was skipped and says so; never 'STOPPED … NOT the review page'",
    r.message.includes(REVIEW_READ_SKIPPED_SUMMARY.trim()) && r.data.reviewReadSkipped !== undefined && !/NOT the review page/.test(said(r)), brief(r));
  const rep = r.reported as { message?: string; data?: Record<string, unknown> } | string | undefined;
  check("D3 …the capture reads nothing while the dialog waits, and records nothing",
    typeof rep === "object" && rep?.message === DIALOG_WAITING_CAPTURE && rep?.data?.permitNumber === "", JSON.stringify(rep).slice(0, 300));
  check("D3 …never 'click again'", !CLICK_AGAIN.test(said(r)), brief(r));
}
{
  // D4: before the hand-over, as on main — Playwright answers a dialog (dismissed).
  const r = await replay("D4", { settleMs: 500 });
  check("D4 BEFORE the hand-over a page-load confirm() is dismissed as on main (the page reads confirm=false), and the run still hands over",
    r.title === "confirm=false" && r.closedAtEnd.length === 1 && r.closedAtEnd[0].result === false && r.handedOver && r.posts.length === 0, brief(r));
}

console.log("\n[D5] A WINDOW LEFT OPEN WITHOUT A HAND-OVER (index.ts trackOpenAdapter)");
for (const yes of [true, false]) {
  const k = yes ? "D5y" : "D5n";
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const person = await personFor(page);
  await page.goto(`${base}/h/${k}/review`);
  const from = posts.length;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "person-dialog-"));
  // What runAdapter's finally does for a window it leaves open (a stand-in adapter around the page).
  trackOpenAdapter(dir, { page, portalName: "fixture", close: async () => { await ctx.close().catch(() => null); } } as unknown as Parameters<typeof trackOpenAdapter>[1]);
  const shown = await personClicksSubmit(page, person);
  await sleep(800);
  if (shown) await personAnswers(page, person, yes);
  await sleep(500);
  const sent = postsFor(k, from);
  if (yes) check("D5 the person's Yes on a left-open window's confirm() posts ONCE", shown && person.closed[0]?.result === true && sent.length === 1, JSON.stringify({ shown, closed: person.closed, sent }));
  else check("D5 …their Cancel posts nothing", shown && person.closed[0]?.result === false && sent.length === 0, JSON.stringify({ shown, closed: person.closed, sent }));
  await ctx.close().catch(() => null);
  fs.rmSync(dir, { recursive: true, force: true });
}

await browser.close().catch(() => null);
server.close();
if (failures) { console.error(`\n${failures}/${total} personDialogAfterHandOver smoke check(s) FAILED.`); process.exit(1); }
console.log(`\nAll ${total}/${total} personDialogAfterHandOver smoke checks passed.`);
process.exit(0);
