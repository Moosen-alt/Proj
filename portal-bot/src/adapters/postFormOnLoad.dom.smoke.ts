// A PAGE THAT POSTS ON LOAD RIGHT AFTER THE FORM IS JUDGED ON MAIN'S REVIEW READING (#344, m6).
//
// The backstop's live review lockdown (4b) reads "A Permit Tech will review your submission" as
// NOT the review step only while the learner says no page with a form control has been seen on
// the run (setPreForm). Helm's verified shape switched that off at the learner's NEXT page boundary,
// so on the FIRST page after a form, anything the page sent by itself on load was judged before
// that boundary — pre-form. A summary page whose only review wording is "Staff will review your
// application…" and which POSTs to a non-filing, non-payment URL on load got that POST through,
// where main holds it. The learner now switches the backstop off ON the form page itself.
//
// Same fixture as informationInterstitial.dom.smoke (informationInterstitialFixture.ts; its own
// file because that smoke already takes ~450 s of the DOM runner's 600 s budget). Synthetic data.
//
//   [13] MUST EXCLUDE (rule 1) — tile → prefilled form ("Next") → a summary page: modal-only
//        review wording, the entered data, Previous + a "Next" that FILES, and an on-load
//        fetch(POST) to /autosave; a planner that calls the Next an advance. Main's behaviour: the
//        on-load POST is held by the backstop, nothing reaches /file, the run stops at review.
//
//   npx tsx portal-bot/src/adapters/postFormOnLoad.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium } from "playwright";
import { AutoLearnAdapter, type LearnPlanner, type LearnPlanRequest, type LearnPlanResponse } from "./autoLearnAdapter";
import { backstopFor } from "../filingBackstop";
import { ADDRESS, applyPageTo, esc, homePage, prefilledFormPage, shapeStep3, type Shape } from "./informationInterstitialFixture";

// As in informationInterstitial.dom.smoke: no 30 s entry settle, a 2 s section-readiness gate.
process.env.ENTRY_SETTLE_MS = "0";
process.env.PORTAL_SECTION_READY_MS = "2000";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const P = "/m6";
const M6: Shape = {
  what: "POST, \"Staff will review your application…\", Next files, the page POSTs /autosave on load",
  method: "POST", heading: "Application Summary",
  prose: "Staff will review your application within 5 business days. Click Next to send it to the city.",
  control: "Next", plannerAdvances: true, onLoadPost: "/autosave",
};

const hits: Array<{ method: string; url: string }> = [];
const server = http.createServer((q, r) => {
  const url = q.url || "/";
  const method = String(q.method || "GET").toUpperCase();
  hits.push({ method, url });
  const [pathOnly] = url.split("?");
  const rest = pathOnly.startsWith(`${P}/`) ? pathOnly.slice(P.length) : "";
  const send = (html: string): void => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(html); };
  if (rest === "/home") return send(homePage(P));
  if (rest === "/apply") return send(applyPageTo(P, "/form"));
  if (rest === "/form") return send(prefilledFormPage(P));
  if (rest === "/to-step3") { r.writeHead(303, { Location: `${P}/step3` }); return r.end(); }
  if (rest === "/step3") return send(shapeStep3(P, M6));
  if (rest === "/autosave") { r.writeHead(204); return r.end(); }
  if (rest === "/file") return send(`<!doctype html><html><body><h1>Application filed</h1><p>Your application was submitted.</p></body></html>`);
  return send(`<!doctype html><html><body><h1>${esc(rest || pathOnly)}</h1><p>Automation must never land here.</p></body></html>`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const browser = await chromium.launch();
const ctx = await browser.newContext();
// The esbuild keepNames shim, as openPortal injects in production.
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const pathOf = (u: string): string => { try { return new URL(u).pathname; } catch { return u; } };
const idx = (req: LearnPlanRequest, label: string): number => req.fields.findIndex((f) => String(f.label ?? "").trim() === label);

console.log(`\n[13] ${M6.what}`);
{
  const pw = await ctx.newPage();
  await pw.goto(`${base}${P}/home`);
  const plannerPages: string[] = [];
  const plan: LearnPlanner = async (req): Promise<LearnPlanResponse> => {
    const at = pathOf(req.url);
    plannerPages.push(at);
    if (at === `${P}/form`) return { fills: [], atReview: false, advanceSelectorIndex: idx(req, "Next") };
    if (at === `${P}/step3`) return { fills: [], atReview: false, advanceSelectorIndex: idx(req, M6.control) };
    return { fills: [], atReview: false };
  };
  const a = new AutoLearnAdapter("Post-Form On-Load Walk", plan, { maxPages: 8, budgetMs: 240_000 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (a as any).page = pw;
  // The review lockdown, observed where it is armed (learn() installs the backstop itself).
  const locks: string[] = [];
  const spy = setInterval(() => {
    const bs = backstopFor(pw) as (ReturnType<typeof backstopFor> & { __spied?: boolean }) | null;
    if (!bs || bs.__spied) return;
    const orig = bs.lockReview.bind(bs);
    bs.lockReview = (why: string) => { locks.push(`${pathOf(pw.url())} :: ${why}`); orig(why); };
    bs.__spied = true;
  }, 2);
  const started = Date.now();
  const r = await a.learn(
    { portalUrl: `${base}${P}/home` } as never,
    { projectAddress: `${ADDRESS}, Springfield, IL, 62701`, city: "Springfield", state: "IL", zip: "62701", homeownerName: "T", permitType: "structural" } as never,
  );
  clearInterval(spy);
  console.log(`  (walk ${P}: ${Math.round((Date.now() - started) / 1000)}s)`);
  const url = pw.url();
  await pw.close().catch(() => null);

  const onLoadPost = hits.filter((h) => h.method === "POST" && h.url.startsWith(`${P}/autosave`));
  const filing = hits.filter((h) => h.url.startsWith(`${P}/file`)).map((h) => `${h.method} ${h.url}`);
  console.log(`  note - on-load POST /autosave reached server: ${onLoadPost.length ? "YES" : "no"}; filing request reached server: ${filing.length ? `YES [${filing.join(", ")}]` : "no"}`);
  check("premise: the walk reached the summary page after the form page", plannerPages.includes(`${P}/form`) && plannerPages.includes(`${P}/step3`), JSON.stringify(plannerPages));
  check("the summary page's on-load POST to /autosave was held by the backstop (never reached the server)",
    onLoadPost.length === 0, JSON.stringify(hits.map((h) => `${h.method} ${h.url}`)));
  check("filing request reached server: NO", filing.length === 0, JSON.stringify(filing));
  check("the run stopped at review, on the summary page, with the lockdown armed there",
    r.reachedReview === true && pathOf(url) === `${P}/step3` && locks.some((l) => l.startsWith(`${P}/step3 ::`)),
    JSON.stringify({ reachedReview: r.reachedReview, url, locks, message: String(r.message).slice(0, 200) }));
  check("the filing control \"Next\" was never recorded as an advance off the summary page (only the form page's)",
    r.steps.filter((s) => String(s.note ?? "") === "advance: Next").length === 1, JSON.stringify(r.steps.map((s) => s.note)));
}

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures} postFormOnLoad.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log("\nAll postFormOnLoad.dom.smoke checks passed.");
process.exit(0);
