// THE PLAN ACTS ON THE PAGE IT WAS MADE FOR, AND A REQUIRED BLANK STOPS THE ADVANCE (#410).
//
// Live, PGE PowerClerk 2026-10-29: the learner scraped the Welcome page (wizard step 1), and before
// its plan was applied the live page had become Preparer Information (step 2). No click of
// Welcome's Next was recorded. The Welcome plan ("no fills, advance: Next") was then applied to the
// Preparer page: the required-field sweep named Name and Address blank on the very page it was about
// to leave, and the walk pressed Next anyway. PowerClerk refused the submit at the end ("Missing
// Required Fields: Preparer - Name, Address, Phone"); a portal that validates later would have
// taken the filing without its preparer.
//
// The only event in that window was the entry pass (application_entry_pass ok:false, ~33 s after
// the scrape: the 30 s settle, then the deep search). The deep search opens a collapsed menu and
// reloads "home" (the page it started on) between looks. On PowerClerk the page it started on is
// the project's own address, and opening it resumes the application at the next form: Welcome had
// been seen, so the reload opened Preparer. That is a page change nothing records.
//
// This fixture is that portal: a dashboard whose "New Net Metering Application" opens /app/1; the
// app resumes at the first form not yet seen (Welcome marks itself seen, so a reload opens
// Preparer); a navbar toggle in the header; Preparer asks for Name, Address, Phone (required) and
// lets the advance through (the portal validates only at submit); Review carries the submit.
//
//   A. entry   - the learner's own walk. MUST: the toggle is never clicked and /app/1 is never
//                reloaded once the application has been entered; Welcome's Next is a recorded step
//                before the first Preparer fill; Name, Address and Phone hold values at review.
//   B. moved   - the page changes UNDER THE PLANNER (the planner stub clicks Welcome's Next while
//                "thinking" — a page that moves on its own). MUST: the stale plan is not applied;
//                the Preparer page is re-planned and its required fields hold values; the move is
//                named in the review hand-off notes (no step can replay it).
//   C. blank   - the planner's first plan for Preparer leaves Name out. MUST: the walk re-plans the
//                page once, naming the blank (and only the blank), before it advances; Name holds
//                its value; one re-plan only.
//   D. stubborn - the re-plan cannot fill Name either. MUST: the walk advances after that one
//                re-plan (no loop), and Name is still reported as a required miss.
//
// Run: npx tsx portal-bot/src/adapters/learnerPageChanged.dom.smoke.ts
import "../smokeArtifactDirs";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { AutoLearnAdapter, type LearnPlanner, type LearnPlanRequest } from "./autoLearnAdapter";
import type { ProjectRecord, RecipeStep } from "../../../shared/src/types";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
process.env.ENTRY_SETTLE_MS = "0";
process.env.AUTOLEARN_RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "learner-page-changed-smoke-"));

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const DASHBOARD = `<!doctype html><html><head><title>My Projects</title></head><body>
  <h1>My Projects</h1>
  <p>No projects yet.</p>
  <a href="/app/1" id="newapp">New Net Metering Application</a>
</body></html>`;

// The application shell: one address for every form, like PowerClerk's project page. State lives
// in sessionStorage so it survives the reloads the portal itself uses to move between forms.
const APP = `<!doctype html><html><head><title>Net Metering Application</title></head><body>
  <nav class="navbar"><button type="button" class="navbar-toggler" aria-label="Open navigation menu" id="burger">Menu</button>
    <div id="menu" hidden><a href="/">My Projects</a></div></nav>
  <main id="main"></main>
  <script>
    const st = JSON.parse(sessionStorage.getItem("app") || '{"resume":"welcome","loads":[],"vals":{},"burger":0}');
    const save = () => sessionStorage.setItem("app", JSON.stringify(st));
    document.getElementById("burger").addEventListener("click", () => {
      st.burger++; save();
      const m = document.getElementById("menu"); m.hidden = !m.hidden;
    });
    const step = st.resume;
    st.loads.push(step);
    // PowerClerk marks Welcome as seen when it is shown: opening the project again resumes at the
    // next form. A RELOAD HERE IS A PAGE CHANGE.
    if (step === "welcome") st.resume = "preparer";
    save();
    const main = document.getElementById("main");
    if (step === "welcome") {
      main.innerHTML = '<h2>Welcome</h2><p>Step 1 of 3. Read the program rules, then press Next.</p>' +
        '<label><input type="checkbox" id="guide"> Email me a copy of the program guide</label> ' +
        '<button type="button" id="next">Next</button>';
      document.getElementById("next").addEventListener("click", () => location.reload());
    } else if (step === "preparer") {
      main.innerHTML = '<h2>Preparer Information</h2><p>Step 2 of 3. The person or company preparing this application.</p>' +
        '<div><label for="pname">Name *</label><input id="pname" name="pname" required></div>' +
        '<div><label for="paddr">Address *</label><input id="paddr" name="paddr" required></div>' +
        '<div><label for="pphone">Phone *</label><input id="pphone" name="pphone" required></div>' +
        '<button type="button" id="next">Next</button>';
      for (const id of ["pname", "paddr", "pphone"]) {
        const el = document.getElementById(id);
        el.value = st.vals[id] || "";
        el.addEventListener("input", () => { st.vals[id] = el.value; save(); });
        el.addEventListener("change", () => { st.vals[id] = el.value; save(); });
      }
      // This portal lets an incomplete page through; it validates only at submit.
      document.getElementById("next").addEventListener("click", () => { st.resume = "review"; save(); location.reload(); });
    } else {
      main.innerHTML = '<h2>Review</h2><p>Step 3 of 3. Review all information before you submit.</p>' +
        '<p>Preparer: ' + [st.vals.pname, st.vals.paddr, st.vals.pphone].map((v) => v || "(blank)").join(" / ") + '</p>' +
        '<button type="button" id="submit">Submit Application</button>';
    }
  </script>
</body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://127.0.0.1");
  res.writeHead(200, { "content-type": "text/html" });
  res.end(u.pathname.startsWith("/app/") ? APP : DASHBOARD);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

type Mode = "entry" | "moved" | "blank" | "stubborn";
const VALUES: Record<string, string> = { Name: "Test Solar Co", Address: "100 Example Way, Testville", Phone: "555-0100" };
const idxOf = (req: LearnPlanRequest, re: RegExp): number =>
  req.fields.findIndex((f) => re.test(String(f.label ?? "").replace(/\*/g, "").trim()));

async function walk(mode: Mode): Promise<void> {
  console.log(`\n[${mode}]`);
  const ctx = await chromium.launch().then((b) => b.newContext().then((c) => ({ b, c })));
  await ctx.c.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  ctx.c.setDefaultTimeout(8000);
  const page = await ctx.c.newPage();
  const calls: Array<{ page: string; hint: string }> = [];
  let movedOnce = false;
  const planner: LearnPlanner = async (req) => {
    const nextIdx = req.fields.findIndex((f) => f.fieldType === "button" && /^next$/i.test(String(f.label ?? "").trim()));
    const isPreparer = idxOf(req, /^name$/i) >= 0;
    const isReview = /review all information/i.test(req.bodyText);
    calls.push({ page: isReview ? "review" : isPreparer ? "preparer" : "welcome", hint: String(req.recoveryHint ?? "") });
    if (isReview) return { fills: [], atReview: true };
    if (!isPreparer) {
      // B: the page moves while the planner is working, before the plan comes back.
      if (mode === "moved" && !movedOnce) {
        movedOnce = true;
        await page.locator("#next").click();
        await page.waitForLoadState("domcontentloaded").catch(() => null);
        await page.waitForTimeout(500);
      }
      return { fills: [], atReview: false, ...(nextIdx >= 0 ? { advanceSelectorIndex: nextIdx } : {}) };
    }
    // C: the planner leaves Name out until it is TOLD the Name is a required blank (the page's own
    // reveal re-scan asks it again without saying so, and gets the same answer).
    const toldName = /still blank/i.test(String(req.recoveryHint ?? "")) && /\bName\b/.test(String(req.recoveryHint ?? ""));
    const wanted = mode === "blank" && !toldName ? ["Address", "Phone"]
      : mode === "stubborn" ? ["Address", "Phone"]
      : ["Name", "Address", "Phone"];
    const fills = wanted
      .map((label) => ({ selectorIndex: idxOf(req, new RegExp(`^${label}$`, "i")), value: VALUES[label] }))
      .filter((f) => f.selectorIndex >= 0);
    return { fills, atReview: false, ...(nextIdx >= 0 ? { advanceSelectorIndex: nextIdx } : {}) };
  };
  await page.goto(`${base}/`);
  const adapter = new AutoLearnAdapter("Page Changed Smoke", planner, { maxPages: 8 });
  (adapter as unknown as { page: unknown }).page = page;
  const T0 = Date.now();
  let r: Awaited<ReturnType<AutoLearnAdapter["learn"]>> | null = null;
  try { r = await adapter.learn({} as never, {} as ProjectRecord); }
  catch (e) { check(`${mode}: the learn runs`, false, String(e).slice(0, 300)); }
  const app = await page.evaluate(() => JSON.parse(sessionStorage.getItem("app") || "{}")).catch(() => ({})) as {
    loads?: string[]; vals?: Record<string, string>; burger?: number; resume?: string;
  };
  await ctx.b.close().catch(() => null);
  if (!r) return;
  const steps: RecipeStep[] = r.steps ?? [];
  const vals = app.vals ?? {};
  const trace = `loads=${JSON.stringify(app.loads)} vals=${JSON.stringify(vals)} calls=${JSON.stringify(calls.map((c) => (c.hint ? `${c.page}: ${c.hint.slice(0, 90)}` : c.page)))} ` +
    `steps=${JSON.stringify(steps.map((s) => `${s.action}:${String(s.note ?? "").slice(0, 40)}`))} misses=${JSON.stringify(r.requiredFieldMisses ?? [])} ` +
    `message=${String(r.message ?? "").slice(0, 240)}`;
  check(`${mode}: the walk reaches review`, r.reachedReview === true && app.resume === "review", trace);
  if (mode !== "stubborn") {
    check(`${mode}: MUST-FILL the Preparer's Name, Address and Phone hold values at review`,
      vals.pname === VALUES.Name && vals.paddr === VALUES.Address && vals.pphone === VALUES.Phone, trace);
    check(`${mode}: no required miss reported`, (r.requiredFieldMisses ?? []).length === 0, trace);
  }
  if (mode === "entry") {
    check("entry: the menu toggle is never clicked inside the entered application", (app.burger ?? 0) === 0, trace);
    check("entry: the application page is loaded once per form (no reload by the entry pass)",
      JSON.stringify(app.loads) === JSON.stringify(["welcome", "preparer", "review"]), trace);
    const nextAt = steps.findIndex((s) => s.action === "click" && /next/i.test(String(s.note ?? "")));
    const firstFill = steps.findIndex((s) => s.action === "fill");
    check("entry: Welcome's Next is a recorded step, before the first Preparer fill", nextAt >= 0 && firstFill > nextAt, trace);
  }
  if (mode === "moved") {
    check("moved: the stale Welcome plan is never applied to Preparer (Preparer is planned)", calls.some((c) => c.page === "preparer"), trace);
    check("moved: the move is named in the review hand-off notes",
      (r.reviewHandoffNotes ?? []).some((n) => /moved from .*without a recorded step/i.test(n) && /Preparer Information/.test(n)),
      `notes=${JSON.stringify(r.reviewHandoffNotes ?? [])}`);
  }
  if (mode === "blank" || mode === "stubborn") {
    const prep = calls.filter((c) => c.page === "preparer");
    const told = prep.filter((c) => /still blank/i.test(c.hint));
    check(`${mode}: the page is re-planned exactly once, and the re-plan names the blank`,
      told.length === 1 && /\bName\b/.test(told[0].hint) && !/\bAddress\b|\bPhone\b/.test(told[0].hint) && !/\bName\b/.test(prep[0].hint), trace);
  }
  if (mode === "stubborn") {
    check("stubborn: the blank the re-plan could not fill is still reported", (r.requiredFieldMisses ?? []).some((m) => /^name\b/i.test(m)), trace);
    check("stubborn: what the planner did fill holds", vals.paddr === VALUES.Address && vals.pphone === VALUES.Phone, trace);
  }
  console.log(`  (took ${Math.round((Date.now() - T0) / 1000)} s)`);
}

try {
  for (const m of (process.env.ONLY_MODES ? process.env.ONLY_MODES.split(",") : ["entry", "moved", "blank", "stubborn"]) as Mode[]) await walk(m);
} finally {
  server.close();
  fs.rmSync(process.env.AUTOLEARN_RUN_DIR!, { recursive: true, force: true });
}
if (failures) { console.error(`\n${failures} learner page-changed check(s) FAILED.`); process.exit(1); }
console.log("\nAll learner page-changed checks passed (real Chromium).");
process.exit(0);
