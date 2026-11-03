// A NAVIGATE CLICK ON A CATEGORY BUTTON MUST OPEN IT, AND NO CLICK MAY HOLD A RUN FOR MINUTES (#556).
//
// Live, 2026-11-03 (a Utah city's Cityworks Public Access): signed in, New Application, and the
// page was "Case Categories" — six category buttons and a disabled "Begin Application". The
// planner chose the category "folder Building Permits" (the Material icon's ligature "folder" is
// part of the button's text). navigate_chosen was logged, and then NOTHING for over five minutes:
// the view never changed, the run held a portal-run slot, and it ended only when a person closed
// the browser ("locator.click: Target page, context or browser has been closed").
//
// WHY (reproduced here, measured on main): the icon sits in an aria-hidden wrapper, so the button's
// accessible name is "Building Permits" while the recorded selector was getByRole('button', { name:
// 'folder Building Permits', exact: true }) — it matched NOTHING. clickResilient then paid ~46 s per
// attempt on the absent control (12 s visibility wait, 2 s scroll, 8 s click, a boundingBox at
// Playwright's 30 s default), a 4 s force click and a 30 s dispatchEvent: 3 min 44 s per call. Each
// attempt ended in a TimeoutError, which safeAction's withRetry repeats four times, and the navigate
// door had no budget: ~15 minutes without an event.
//
// The fixture is that page: fixtures/cityworks-case-create.html — the captured component markup
// and its inline component CSS, synthetic text, plain JS standing in for Angular (a category
// click re-renders the panel IN PLACE with its case types; choosing a case type enables "Begin
// Application"; that button routes to a simple application form). The planner is a stub that
// chooses exactly what the live planner chose, by the same label.
//
//   live   — New Application -> "folder Building Permits" -> its case types (same URL, the panel
//            re-rendered) -> "Residential Solar PV" -> "Begin Application" (enabled now) -> the
//            form. MUST: the form is reached in bounded time, and each recorded click's selector
//            re-finds its control on a fresh page (a replay walks the same three clicks).
//   eager  — the planner names "Begin Application" while it is still DISABLED. MUST: it is not
//            clicked (no step, no wasted retries), the planner is told to make the enabling choice,
//            and the walk still reaches the form — the later, enabled click is not refused as a
//            "re-click".
//   gone   — the chosen category disappears between the plan and the click (an SPA re-render).
//            MUST: a named failure ("not on the page") in seconds, never minutes of retries.
//   wedge  — the category's click handler never returns (the page's script is stuck). MUST: the
//            navigate click's budget ends the walk, named (AUTOLEARN_CLICK_BUDGET_MS=20000 here).
//   stall  — the planner never answers. MUST: the stall watchdog ends the run, named, closes its
//            page, and learn() returns (stallWatchdogMs=40000 here: above this replica's longest healthy quiet stretch, ~16 s on page 1).
//
// Run: npx tsx portal-bot/src/adapters/cityworksCategory.dom.smoke.ts   (ONLY_MODES=live,eager,…)
//   Past each mode's deadline the walk is reported as HUNG and the browser is closed to end it
//   (which is how the live run ended).
import "../smokeArtifactDirs";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { AutoLearnAdapter, type LearnPlanner, type LearnPlanRequest, type LearnPlanResponse } from "./autoLearnAdapter";
import type { ProjectRecord, RecipeStep } from "../../../shared/src/types";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
process.env.ENTRY_SETTLE_MS = "0";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const PAGE = fs.readFileSync(new URL("./fixtures/cityworks-case-create.html", import.meta.url), "utf8");
const CASE_TYPES: Record<string, string[]> = {
  "Building Permits": ["Residential Addition", "Residential Solar PV", "Commercial Remodel", "Demolition"],
};
const hits: string[] = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://127.0.0.1");
  hits.push(`${req.method} ${u.pathname}${u.search}`);
  if (u.pathname === "/publicaccess/api/casetypes") {
    // Angular loads a category's case types over XHR; a short server delay, as on the live portal.
    const cat = u.searchParams.get("category") || "";
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(CASE_TYPES[cat] ?? ["General Request"]));
    }, 250);
    return;
  }
  if (u.pathname.startsWith("/publicaccess/")) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
    return;
  }
  res.writeHead(302, { location: "/publicaccess/home/home" });
  res.end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const norm = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();

type Mode = "live" | "eager" | "gone" | "wedge" | "stall";
/** Each mode's wall-clock bound in this smoke: well above its healthy time, far below the hang. */
const DEADLINE_S: Record<Mode, number> = { live: 240, eager: 240, gone: 150, wedge: 150, stall: 180 };
type Call = { url: string; labels: string[]; hint: string; chose: string; at: number };
type Result = Awaited<ReturnType<AutoLearnAdapter["learn"]>>;

/** Read the replica's own record of what was clicked, bounded (a wedged page never answers). */
async function readApp(page: Page): Promise<{ log?: string[]; caseType?: string }> {
  return Promise.race([
    page.evaluate(() => JSON.parse(sessionStorage.getItem("cwReplica") || "{}")).catch(() => ({})),
    new Promise<Record<string, never>>((r) => setTimeout(() => r({}), 3000)),
  ]) as Promise<{ log?: string[]; caseType?: string }>;
}

/** A replay walks the recorded clicks by their selectors: each must find exactly its control. */
async function replayFinds(steps: RecipeStep[]): Promise<string> {
  const clicks = steps.filter((s) => s.action === "click" && /^navigate to application:/.test(norm(s.note)));
  const b = await chromium.launch();
  const out: string[] = [];
  try {
    const p = await b.newPage();
    await p.goto(`${base}/publicaccess/case/create`);
    await p.waitForSelector(".category-subcategories button");
    for (const s of clicks) {
      const sel = s.selector as { role?: string; name?: string; exact?: boolean; text?: string; css?: string };
      const loc = sel.role && sel.name ? p.getByRole(sel.role as "button", { name: sel.name, exact: !!sel.exact })
        : sel.text ? p.getByText(sel.text, { exact: !!sel.exact }) : sel.css ? p.locator(sel.css) : null;
      const n = loc ? await loc.count() : -1;
      out.push(`${norm(s.note).replace(/^navigate to application: /, "")}=${n}`);
      if (n !== 1 || !loc) break;
      await loc.click({ timeout: 5000 });
      await p.waitForTimeout(600);
    }
    if (!/\/case\/apply$/.test(new URL(p.url()).pathname)) out.push(`ended at ${new URL(p.url()).pathname}`);
  } finally {
    await b.close();
  }
  return out.join(" ");
}

async function walk(mode: Mode): Promise<void> {
  console.log(`\n[${mode}]`);
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  if (mode === "wedge") {
    // The category's own click handler never returns: the page's main thread is stuck for good.
    await ctx.addInitScript({ content: `document.addEventListener("click", function (e) {
      var b = e.target && e.target.closest ? e.target.closest(".category-subcategories button") : null;
      if (b) { for (;;) { /* stuck */ } }
    }, true);` });
  }
  // No setDefaultTimeout here: production runs with Playwright's own defaults, and the hang is
  // about what those defaults let a click cost.
  const page: Page = await ctx.newPage();
  const calls: Call[] = [];
  let eagerDone = false;
  let stallAt = 0;
  const planner: LearnPlanner = async (req: LearnPlanRequest): Promise<LearnPlanResponse> => {
    const at = (re: RegExp): number => req.fields.findIndex((f) => f.fieldType === "button" && re.test(norm(f.label)));
    const call: Call = { url: new URL(req.url).pathname, labels: req.fields.map((f) => norm(f.label)), hint: norm(req.recoveryHint), chose: "", at: Date.now() };
    calls.push(call);
    const pick = (i: number, why: string): LearnPlanResponse => { call.chose = `${why}: ${i >= 0 ? norm(req.fields[i]?.label) : "-"}`; return { fills: [], atReview: false, navigateSelectorIndex: i }; };
    // The application form: fill the description and stop there (what this smoke is about is
    // getting HERE).
    const desc = req.fields.findIndex((f) => /description of work/i.test(norm(f.label)));
    if (desc >= 0) { call.chose = "form"; return { fills: [{ selectorIndex: desc, value: "Roof-mounted solar PV system" }], atReview: true }; }
    // The case types of the chosen category, then Begin Application once it is enabled.
    const solar = at(/residential solar pv$/i);
    const begin = at(/^begin application$/i);
    if (solar >= 0) {
      // eager: a planner that jumps ahead to the primary button while it is still disabled.
      if (mode === "eager" && !eagerDone && begin >= 0) { eagerDone = true; return pick(begin, "begin (eager)"); }
      if (begin >= 0 && !req.fields[begin].disabled) return pick(begin, "begin");
      return pick(solar, "case type");
    }
    // The categories: exactly the live planner's choice, by the label it was given.
    const cat = req.fields.findIndex((f) => norm(f.label) === "folder Building Permits");
    if (cat >= 0) {
      if (mode === "stall") { call.chose = "never answers"; stallAt = Date.now(); return new Promise<LearnPlanResponse>(() => { /* never */ }); }
      return pick(cat, "category");
    }
    const newApp = at(/new application$/i);
    if (newApp >= 0) return pick(newApp, "entry");
    call.chose = "nothing";
    return { fills: [], atReview: false };
  };

  await page.goto(`${base}/publicaccess/home/home`);
  const adapter = new AutoLearnAdapter("Cityworks Category Smoke", planner, { maxPages: 10, ...(mode === "stall" ? { stallWatchdogMs: 40_000 } : {}) });
  (adapter as unknown as { page: unknown }).page = page;
  // gone: the chosen category leaves the page between the plan and the click (an SPA re-render),
  // timed off the learner's own navigate_chosen event so it lands before the click, every time.
  let chosenAt = 0;
  if (adapter.debug) {
    const listener = adapter.debug.onEvent;
    adapter.debug.onEvent = (evt) => {
      listener?.(evt);
      if (evt.type === "navigate_chosen" && /Building Permits/.test(String(evt.label ?? ""))) {
        chosenAt = Date.now();
        if (mode === "gone") {
          void page.evaluate(() => {
            for (const b of Array.from(document.querySelectorAll(".category-subcategories button"))) {
              if ((b.textContent || "").includes("Building Permits")) b.remove();
            }
          }).catch(() => null);
        }
      }
    };
  }
  if (mode === "wedge") process.env.AUTOLEARN_CLICK_BUDGET_MS = "20000";
  const T0 = Date.now();
  let r: Result | null = null;
  let hung = false;
  let thrown = "";
  let endedAt = 0;
  const learning = adapter.learn({} as never, {} as ProjectRecord).then((x) => { r = x; endedAt = Date.now(); }, (e) => { thrown = String(e).slice(0, 300); endedAt = Date.now(); });
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    learning,
    new Promise<void>((resolve) => { deadlineTimer = setTimeout(() => { hung = true; resolve(); }, DEADLINE_S[mode] * 1000); }),
  ]);
  if (deadlineTimer) clearTimeout(deadlineTimer);
  delete process.env.AUTOLEARN_CLICK_BUDGET_MS;
  const tookS = Math.round((Date.now() - T0) / 1000);
  const pageClosed = page.isClosed();
  const app = pageClosed ? {} : await readApp(page);
  if (hung) {
    // What the live run's person did: close the browser out from under the stuck call.
    await browser.close().catch(() => null);
    await Promise.race([learning, new Promise((res) => setTimeout(res, 30_000))]);
  }
  const res = r as Result | null;
  const steps: RecipeStep[] = res?.steps ?? [];
  const log = app.log ?? [];
  const events: Array<Record<string, unknown>> = (() => {
    try {
      return fs.readFileSync(path.join(adapter.debug?.dir ?? "", "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  })();
  const evTypes = events.map((e) => String(e.type));
  const trace = `took=${tookS}s log=${JSON.stringify(log)} calls=${JSON.stringify(calls.map((c) => `${c.url} -> ${c.chose}${c.hint ? ` [hint: ${c.hint.slice(0, 80)}]` : ""}`))} ` +
    `steps=${JSON.stringify(steps.map((s) => `${s.action}:${norm(s.note).slice(0, 50)}`))} stopReason=${res?.stopReason ?? "-"} message=${norm(res?.message ?? thrown).slice(0, 300)}`;

  check(`${mode}: the walk ends on its own within ${DEADLINE_S[mode]} s (it does not hang)`, !hung, trace);

  if (mode === "live" || mode === "eager") {
    check(`${mode}: the category click opened its case types — in place, on the same URL`,
      log.includes("category:Building Permits") && calls.some((c) => c.url === "/publicaccess/case/create" && c.labels.some((l) => /Residential Solar PV$/.test(l))), trace);
    check(`${mode}: the learner chose the solar case type by the planner's choice`, log.includes("case_type:Residential Solar PV"), trace);
    check(`${mode}: "Begin Application" became clickable and was clicked`, log.includes("begin_application:Residential Solar PV"), trace);
    check(`${mode}: the walk reached the application form`, log.includes("form_shown") && calls.some((c) => c.chose === "form"), trace);
    if (!hung) {
      const found = await replayFinds(steps);
      check(`${mode}: each recorded click's selector re-finds exactly its control on a fresh page, through to the form`,
        /^folder Building Permits=1 description Residential Solar PV=1 Begin Application=1$/.test(found), `replay: ${found} | ${trace}`);
    }
  }
  if (mode === "eager") {
    const beginSteps = steps.filter((s) => /^navigate to application: Begin Application/.test(norm(s.note)));
    const typeAt = steps.findIndex((s) => /Residential Solar PV/.test(norm(s.note)));
    const beginAt = steps.findIndex((s) => /^navigate to application: Begin Application/.test(norm(s.note)));
    check("eager: the disabled \"Begin Application\" is refused before any click (named), never recorded as a step",
      evTypes.includes("navigate_disabled_refused") && beginSteps.length === 1 && typeAt >= 0 && beginAt > typeAt, `events=${JSON.stringify(evTypes)} | ${trace}`);
    check("eager: the planner is told the control is disabled and what the page is waiting for",
      calls.some((c) => /Begin Application" is DISABLED/.test(c.hint) && /choice/.test(c.hint)), trace);
  }
  if (mode === "gone") {
    const secs = chosenAt && endedAt ? Math.round((endedAt - chosenAt) / 1000) : -1;
    check("gone: a chosen control that left the page fails the walk NAMED ('not on the page') — no retries, no timeout",
      !!res && res.ok === false && /not on the page/i.test(String(res.message)) && !/timeout|did not finish/i.test(String(res.message)), trace);
    check(`gone: ...in seconds, not minutes (${secs} s from the choice to the end; bound 60 s)`, secs >= 0 && secs <= 60, trace);
  }
  if (mode === "wedge") {
    const secs = chosenAt && endedAt ? Math.round((endedAt - chosenAt) / 1000) : -1;
    check("wedge: a click whose page never answers is ended by the click's budget, named",
      !!res && res.ok === false && evTypes.includes("navigate_timed_out") && /did not finish within 20 s/.test(String(res.message)), `events=${JSON.stringify(evTypes)} | ${trace}`);
    check(`wedge: ...at the budget, not minutes later (${secs} s from the choice to the end; bound 60 s)`, secs >= 0 && secs <= 60, trace);
  }
  if (mode === "stall") {
    const secs = stallAt && endedAt ? Math.round((endedAt - stallAt) / 1000) : -1;
    check("stall: a planner that never answers is ended by the stall watchdog, named (stopReason 'stalled')",
      !!res && res.ok === false && res.stopReason === "stalled" && /^Stopped by the stall watchdog: the walk showed no sign of progress for \d+ s \(budget 40 s; last: asking the planner \(page 2\)\)/.test(String(res.message)) && evTypes.includes("stall_watchdog"),
      `events=${JSON.stringify(evTypes)} | ${trace}`);
    check(`stall: ...within its budget plus the grace (${secs} s from the stall to the end; bound 80 s), and its page is closed`,
      secs >= 0 && secs <= 80 && pageClosed, `pageClosed=${pageClosed} | ${trace}`);
  }
  console.log(`  (took ${tookS} s)`);
  await browser.close().catch(() => null);
}

try {
  for (const m of (process.env.ONLY_MODES ? process.env.ONLY_MODES.split(",") : ["live", "eager", "gone", "wedge", "stall"]) as Mode[]) await walk(m);
} finally {
  server.close();
}
if (failures) { console.error(`\n${failures} Cityworks category check(s) FAILED.`); process.exit(1); }
console.log("\nAll Cityworks category checks passed (real Chromium).");
process.exit(0);
