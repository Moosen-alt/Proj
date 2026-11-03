// A NAVIGATE CLICK ON A CATEGORY BUTTON MUST OPEN IT, AND NO CLICK MAY HOLD A RUN FOR MINUTES (#556).
//
// Live, 2026-11-03 (a Utah city's Cityworks Public Access): signed in, New Application, and the
// page was "Case Categories" — six category buttons and a disabled "Begin Application". The
// planner chose the category "folder Building Permits" (the Material icon's ligature "folder" is
// part of the button's text). navigate_chosen was logged, and then NOTHING for over five minutes:
// the view never changed, the run held a portal-run slot, and it ended only when a person closed
// the browser ("locator.click: Target page, context or browser has been closed").
//
// The fixture is that page: fixtures/cityworks-case-create.html — the captured component markup
// and its inline component CSS, synthetic text, plain JS standing in for Angular (a category
// click re-renders the panel IN PLACE with its case types; choosing a case type enables "Begin
// Application"; that button routes to a simple application form). The planner is a stub that
// chooses exactly what the live planner chose, by the same label.
//
//   live    — the walk from the home page: New Application -> "folder Building Permits" ->
//             its case types (same URL, the panel re-rendered) -> "Residential Solar PV" ->
//             "Begin Application" (enabled now) -> the application form. MUST: the form is reached
//             in bounded time; each click is a recorded step whose selector re-finds its control.
//
// Run: npx tsx portal-bot/src/adapters/cityworksCategory.dom.smoke.ts
//   CW_DEADLINE_S=<s> (default 240) — the walk's wall-clock bound in this smoke; past it the walk
//   is reported as HUNG and the browser is closed to end it (which is how the live run ended).
import "../smokeArtifactDirs";
import fs from "node:fs";
import http from "node:http";
import { chromium, type Page } from "playwright";
import { AutoLearnAdapter, type LearnPlanner, type LearnPlanRequest } from "./autoLearnAdapter";
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

const DEADLINE_MS = Math.max(30, Number(process.env.CW_DEADLINE_S) || 240) * 1000;
const norm = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();

type Mode = "live";
type Call = { url: string; labels: string[]; hint: string; chose: string };

async function walk(mode: Mode): Promise<void> {
  console.log(`\n[${mode}]`);
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  // No setDefaultTimeout here: production runs with Playwright's own defaults, and the hang is
  // about what those defaults let a click cost.
  const page: Page = await ctx.newPage();
  const calls: Call[] = [];
  const planner: LearnPlanner = async (req: LearnPlanRequest) => {
    const at = (re: RegExp): number => req.fields.findIndex((f) => f.fieldType === "button" && re.test(norm(f.label)));
    const call: Call = { url: new URL(req.url).pathname, labels: req.fields.map((f) => norm(f.label)), hint: norm(req.recoveryHint), chose: "" };
    calls.push(call);
    const pick = (i: number, why: string) => { call.chose = `${why}: ${i >= 0 ? norm(req.fields[i]?.label) : "-"}`; return { fills: [], atReview: false, navigateSelectorIndex: i }; };
    // The application form: fill the description and stop there (what this smoke is about is
    // getting HERE).
    const desc = req.fields.findIndex((f) => /description of work/i.test(norm(f.label)));
    if (desc >= 0) { call.chose = "form"; return { fills: [{ selectorIndex: desc, value: "Roof-mounted solar PV system" }], atReview: true }; }
    // The case types of the chosen category, then Begin Application once it is enabled.
    const solar = at(/residential solar pv$/i);
    const begin = at(/^begin application$/i);
    if (solar >= 0) {
      if (begin >= 0 && !req.fields[begin].disabled) return pick(begin, "begin");
      return pick(solar, "case type");
    }
    // The categories: exactly the live planner's choice, by the label it was given.
    const cat = req.fields.findIndex((f) => norm(f.label) === "folder Building Permits");
    if (cat >= 0) return pick(cat, "category");
    const newApp = at(/new application$/i);
    if (newApp >= 0) return pick(newApp, "entry");
    call.chose = "nothing";
    return { fills: [], atReview: false };
  };

  await page.goto(`${base}/publicaccess/home/home`);
  const adapter = new AutoLearnAdapter("Cityworks Category Smoke", planner, { maxPages: 10 });
  (adapter as unknown as { page: unknown }).page = page;
  const T0 = Date.now();
  let r: Awaited<ReturnType<AutoLearnAdapter["learn"]>> | null = null;
  let hung = false;
  let thrown = "";
  const learning = adapter.learn({} as never, {} as ProjectRecord).then((x) => { r = x; }, (e) => { thrown = String(e).slice(0, 300); });
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    learning,
    new Promise<void>((resolve) => { deadlineTimer = setTimeout(() => { hung = true; resolve(); }, DEADLINE_MS); }),
  ]);
  if (deadlineTimer) clearTimeout(deadlineTimer);
  const tookS = Math.round((Date.now() - T0) / 1000);
  const app = await page.evaluate(() => JSON.parse(sessionStorage.getItem("cwReplica") || "{}")).catch(() => ({})) as {
    log?: string[]; caseType?: string; description?: string;
  };
  if (hung) {
    // What the live run's person did: close the browser out from under the stuck call.
    await browser.close().catch(() => null);
    await Promise.race([learning, new Promise((res) => setTimeout(res, 30_000))]);
  }
  const res = r as Awaited<ReturnType<AutoLearnAdapter["learn"]>> | null;
  const steps: RecipeStep[] = res?.steps ?? [];
  const log = app.log ?? [];
  const trace = `took=${tookS}s log=${JSON.stringify(log)} calls=${JSON.stringify(calls.map((c) => `${c.url} -> ${c.chose}${c.hint ? ` [hint: ${c.hint.slice(0, 80)}]` : ""}`))} ` +
    `steps=${JSON.stringify(steps.map((s) => `${s.action}:${norm(s.note).slice(0, 50)}`))} message=${norm(res?.message ?? thrown).slice(0, 300)}`;

  check(`${mode}: the walk ends on its own within ${Math.round(DEADLINE_MS / 1000)} s (it does not hang on a click)`, !hung, trace);
  check(`${mode}: the category click opened its case types — in place, on the same URL`,
    log.includes("category:Building Permits") && calls.some((c) => c.url === "/publicaccess/case/create" && c.labels.some((l) => /Residential Solar PV$/.test(l))), trace);
  check(`${mode}: the learner chose the solar case type by the planner's choice`, log.includes("case_type:Residential Solar PV"), trace);
  check(`${mode}: "Begin Application" became clickable and was clicked`, log.includes("begin_application:Residential Solar PV"), trace);
  check(`${mode}: the walk reached the application form`, log.includes("form_shown") && calls.some((c) => c.chose === "form"), trace);

  // A RECORDED CLICK IS ONLY AS GOOD AS ITS SELECTOR: on a fresh load of the categories page the
  // category step's selector must find that button (a replay re-finds it by this selector).
  if (!hung) {
    const catStep = steps.find((s) => s.action === "click" && /Building Permits/.test(norm(s.note)));
    let found = -1;
    if (catStep?.selector) {
      const b2 = await chromium.launch();
      const p2 = await b2.newPage();
      await p2.goto(`${base}/publicaccess/case/create`);
      await p2.waitForSelector(".category-subcategories button");
      const sel = catStep.selector as { role?: string; name?: string; exact?: boolean; text?: string; css?: string };
      const loc = sel.role && sel.name ? p2.getByRole(sel.role as "button", { name: sel.name, exact: !!sel.exact })
        : sel.text ? p2.getByText(sel.text, { exact: !!sel.exact }) : sel.css ? p2.locator(sel.css) : null;
      found = loc ? await loc.count() : -1;
      await b2.close();
    }
    check(`${mode}: the recorded category step's selector re-finds exactly that button on a fresh page`, found === 1,
      `selector=${JSON.stringify(catStep?.selector ?? null)} matches=${found}`);
  }
  console.log(`  (took ${tookS} s)`);
  await browser.close().catch(() => null);
}

try {
  for (const m of (process.env.ONLY_MODES ? process.env.ONLY_MODES.split(",") : ["live"]) as Mode[]) await walk(m);
} finally {
  server.close();
}
if (failures) { console.error(`\n${failures} Cityworks category check(s) FAILED.`); process.exit(1); }
console.log("\nAll Cityworks category checks passed (real Chromium).");
process.exit(0);
