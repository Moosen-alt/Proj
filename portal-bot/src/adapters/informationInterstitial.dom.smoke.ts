// AN INFORMATION INTERSTITIAL IS NOT THE REVIEW SCREEN (issue #341).
//
// Portland DevHub, live 2026-10-14: the learner entered "Apply For A Permit", chose the "Solar
// Permit Request" tile, and landed on DevHub's PERMITTING INFORMATION page — prose ("This is a
// permit request only. A Permit Tech will review your submission … click "Continue". Please do
// not submit additional requests …"), Previous / Next, no field. The walk read it as the REVIEW
// screen (`review fields=31(fill=0,btn=31,link=26) … review=true`, advanceIndex null with "Next"
// at index 16), armed the review lockdown and ended "Nothing was staged — reached a screen treated
// as review but filled no fields". "review your submission" is review wording, and the page had
// no input, so "no input and not a dashboard" made it review.
//
// The fixtures are the captured page's markup (data/learn-runs/2026-10-14_21-49-19_city-of-
// portland_lb60/page-p002-before-Development_Hub_PDX.json), scrubbed: the signed-in company is
// synthetic ("Placeholder Solar Co" — NOT "Example …", which the entry vocabulary refuses, see
// choiceTiles.dom.smoke), the learner's marks are gone, and every link points at this server.
// Each scenario has its own path prefix so its requests can be counted on their own.
//
//   [0] VOCABULARY  — the interstitial's forward control: Next / Continue / Proceed / Begin /
//                     Start pass; Previous / Back / Cancel / Continue Later / Save and Exit /
//                     every submit- and pay-worded label, and a pager, never do.
//   [1] MUST PASS   — the captured page as served (POST form). The learner does NOT call it
//                     review: no review stop, no lockReview, no upload skip, no final submit; it
//                     records "advance: Next" and clicks it. What happens to that POST is the
//                     network backstop's business (see [1]'s KNOWN RESIDUAL note) — reported, not
//                     asserted away.
//   [2] MUST PASS   — the same page whose Next navigates by GET, with a planner that ALSO calls
//                     it review and names its Next as the final submit (the worst planner): the
//                     learner clicks Next ONCE, lands on the form page, fills it, reaches the real
//                     review page and stops THERE — lockReview armed on the review page and no
//                     other, "Submit Application" recorded as the final submit and never clicked.
//   [3] MUST EXCLUDE — rule 1: after a filled form, a review page that echoes the entered value
//                     and whose ONLY forward control is a "Next" that FILES still stops for review
//                     with the lockdown armed; the Next is never clicked and never recorded as a
//                     final submit or an advance.
//   [4] NO LOOPS    — an interstitial whose Next does nothing: clicked exactly once, then the walk
//                     stops and names the page (stopReason interstitial_loop) — never a review.
//   [5] NEVER BACK  — an interstitial with only Previous / Cancel and a planner that names
//                     Previous as its advance: nothing is clicked, nothing is review.
//
// Against origin/main's autoLearnAdapter.ts the MUST PASS lines of [0], [1], [2], [4] and [5]
// are FAIL banners (main stops at the interstitial as review); [3] passes on both.
//
//   npx tsx portal-bot/src/adapters/informationInterstitial.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium } from "playwright";
import * as adapterModule from "./autoLearnAdapter";
import { AutoLearnAdapter, type LearnPlanner, type LearnPlanRequest, type LearnPlanResponse } from "./autoLearnAdapter";
import { backstopFor } from "../filingBackstop";

// The entry finder keeps re-reading a page for ENTRY_SETTLE_MS (30 s by default) before it
// concludes there is no way in; read at call time, so set before the first learn.
process.env.ENTRY_SETTLE_MS = "0";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// ------------------------------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------------------------------
const ACCOUNT = "Placeholder Solar Co";
const SOLAR = "Solar Permit Request";
const ADDRESS = "1 Test St";

/** The interstitial's own words, as captured (the one paragraph the page carries). */
const PERMITTING_INFORMATION = `<div id="div_d_1685049573550" class="group">
	<div class="row"><div class="col-flex offset-md-0 col-md-12"><div id="div_d_1685049573552" class="pt-3 form-group static-text">
	<div class="d-flex label-group">
<label id="lbl_d_1685049573552" class="control-label" data-toggle="tooltip" data-bs-original-title="" title="">
	<span>This is a permit request only.</span>
	</label>
</div>
A Permit Tech will review your submission for minimum submittal standards, and if met, a permit will be created. Once your permit has been deemed complete for intake, you will be provided with instructions via email for how to pay your intake fees. If minimum submittal standards are not met, you will be provided with a list of the required information via DevHub. If you already have the information you need to apply, scroll to the bottom of the page and click "Continue".&nbsp;Please do not submit additional requests for the same scope of work as this will only further delay the review of your project.</div>
</div></div></div>`;

/** One tile, as captured on the Apply page (#315). */
const card = (id: string, title: string, body: string): string => `
<div id="${id}" class="card-h card-l card">
<div class="card-body">
	<div class="card-title">${title}</div>
	<div class="card-text">${body}</div>
</div>
<div class="card-next"><i class="fa fa-chevron-right"></i></div>
</div>`;
const APPLY_TILES = [
  card("div_d_1683576453192", "Building Permit Request", "Residential additions, alterations, demolition."),
  card("div_d_1683576453204", SOLAR, "Solar Permit Requests for Residential or Commercial Projects."),
  card("div_d_1683576453207", "Trade Permits", "Electrical, Mechanical and Plumbing."),
  card("div_d_1683576453209", "Sign Permit Request", "Sign permits."),
].join("");
const HOME_TILES = [
  card("div_h_1", "My Permits &amp; Requests", "See the permits and requests you have filed."),
  card("div_h_2", "Apply For A Permit", "Start a new permit request."),
  card("div_h_3", "View or Pay Fees", "Fees due on your permits."),
].join("");

/** The click delegation the live page binds in script: the CARD navigates. */
const delegation = (map: string): string => `<script>
document.getElementById('sgControls').addEventListener('click', function (e) {
  var card = e.target.closest('.card');
  if (!card) return;
  var title = card.querySelector('.card-title').textContent.replace(/\\s+/g, ' ').trim();
  location.href = (${map})(title);
});
</script>`;

/** The sidebar every DevHub page carries — its links all point at this server. */
const sidebar = (p: string): string => `<div class="col left-section no-print"><nav class="navbar navbar-expand-md navbar-light left-menu" role="navigation">
 <button class="navbar-toggler always-enabled" type="button" aria-controls="leftMenuNav" aria-expanded="false" aria-label="Toggle navigation"><span class="navbar-toggler-icon"></span></button>
 <div class="collapse navbar-collapse" id="leftMenuNav"><ul>
  <li class="title">Portal Fixture</li>
  <li class="item"><a href="${p}/home">DevHub Home</a></li>
  <li class="item"><a href="${p}/profile">My Profile</a></li>
  <li class="item"><a href="${p}/my-permits">My Permits &amp; Requests</a></li>
  <li class="item"><a href="${p}/apply">Apply For A Permit</a></li>
  <li class="item"><a href="${p}/fees">View or Pay Fees</a></li>
  <li class="item"><a href="${p}/corrections">Upload Corrections</a></li>
  <li class="item"><a href="${p}/help">Help and FAQs</a></li>
 </ul></div></nav></div>`;

/** The DevHub shell, as captured: signed-in menu (name scrubbed), breadcrumb, sidebar, the
 *  SmartGuide form (method/action per scenario), its #navigation bar, a footer. */
const shell = (p: string, o: { title: string; content: string; nav?: string; method?: string; action?: string; script?: string }): string => `<!doctype html><html><head><meta charset="utf-8"><title>Development Hub Fixture</title>
<style>body{font:14px sans-serif;margin:0} .row{display:flex} .left-section{width:200px} .right-section{flex:1}
.card{display:flex;border:1px solid #ccc;margin:8px 0;padding:8px;min-height:60px} .card-body{flex:1} .card-next{width:32px}
#navigation{display:flex;gap:12px;margin:16px 0}</style>
</head><body class="">
<div id="top-header"><div class="container-xxl d-flex">
	<a href="${p}/home"><img id="top-header-logo" alt="City seal"></a>
	<div id="signin-menu" class="ms-auto">
	<button id="signedin-menu-btn" type="button" class="dropdown-toggle" data-bs-toggle="dropdown" aria-expanded="false"><i class="bi bi-person-fill"></i><div>${ACCOUNT}</div></button>
		<ul class="dropdown-menu" aria-labelledby="userMenuButton" style="display:none">
			<li><a class="dropdown-item" href="${p}/profile">My Profile</a></li>
			<li><a class="dropdown-item" href="#" onclick="return false">Sign Out</a></li>
		</ul>
	</div>
</div></div>
<div id="sec-header"><h1>Development Hub Fixture</h1><h2>Online License &amp; Permit Services</h2></div>
<div id="breadcrumb"><nav aria-label="breadcrumb"><ol class="breadcrumb"><li class="breadcrumb-item"><a href="${p}/home">Home</a></li><li class="breadcrumb-item"><a href="${p}/apply">Apply For A Permit</a></li></ol></nav></div>
<div id="main-content"><form id="smartguide_ApplyForAPermit" action="${o.action ?? `${p}/sg`}" method="${o.method ?? "POST"}" class="form-content smartguide_form" accept-charset="UTF-8">
<div class="row">
 ${sidebar(p)}
 <div class="col-md-10 right-section"><div id="page-content">
  <div class="page-title auto-title">${o.title}</div>
  <div id="sgControls"><div class="row"><div class="col-flex col-md-12">${o.content}</div></div></div>
  <div id="navigation" class="d-flex ">${o.nav ?? ""}</div>
 </div></div>
</div></form></div>
<footer id="bottom-footer" role="contentinfo">
  <p>The City ensures meaningful access to City programs, services, and activities. To request these services, contact <a href="tel:503-000-0000">503-000-0000</a> or TTY via Relay Service: <a href="tel:711">711</a>.</p>
  <ul class="menu"><li><a href="${p}/ada">ADA Accommodation</a></li><li><a href="${p}/privacy">Privacy policy</a></li><li><a href="${p}/about">About this Website</a></li></ul>
</footer>
${o.script ?? ""}
</body></html>`;

/** DevHub's navigation bar, as captured: two submit buttons named by the step. */
const PREV_NEXT = `<button type="submit" name="t_p1685049573549" class="btn btn-primary">Previous</button><button type="submit" name="t_n1685049573549" class="btn btn-primary ms-auto ">Next</button>`;

const homePage = (p: string): string => shell(p, {
  title: "Welcome", content: HOME_TILES,
  script: delegation(`function (t) { return ({'Apply For A Permit':'${p}/apply','My Permits & Requests':'${p}/my-permits','View or Pay Fees':'${p}/fees'})[t] || '${p}/unknown'; }`),
});
const applyPage = (p: string): string => shell(p, {
  title: "Apply for a Permit", content: APPLY_TILES,
  script: delegation(`function (t) { return t === '${SOLAR}' ? '${p}/info' : '${p}/other-type'; }`),
});
const projectPage = (p: string): string => shell(p, {
  title: "Project Information", method: "GET", action: `${p}/sg2`,
  content: `<div class="form-group"><label for="addr" class="control-label">Site Address</label><input id="addr" name="addr" type="text"></div>`,
  nav: PREV_NEXT,
});
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c] as string);
/** A REAL review page: the entered value echoed back, a certify box, a Submit that files. */
const reviewPage = (p: string, addr: string): string => shell(p, {
  title: "Review Your Application", method: "POST", action: `${p}/file`,
  content: `<p>Please review your application before submitting.</p>
    <dl class="summary"><dt>Permit Type</dt><dd>${SOLAR}</dd><dt>Site Address</dt><dd>${esc(addr)}</dd></dl>
    <div class="form-check"><input type="checkbox" id="cert" name="cert" class="form-check-input"><label for="cert" class="form-check-label">I certify that the information above is true and correct.</label></div>`,
  nav: `<button type="submit" name="t_p2" formaction="${p}/back" formmethod="get" class="btn btn-primary">Previous</button><button type="submit" name="t_s2" class="btn btn-primary ms-auto">Submit Application</button>`,
});
/** A REAL review page whose ONLY forward control is a "Next" that FILES (no submit word). */
const reviewNextPage = (p: string, addr: string): string => shell(p, {
  title: "Step 3: Review", method: "POST", action: `${p}/file`,
  content: `<p>Review your application below. Your request will not be submitted until you click Next.</p>
    <dl class="summary"><dt>Permit Type</dt><dd>${SOLAR}</dd><dt>Site Address</dt><dd>${esc(addr)}</dd></dl>`,
  nav: PREV_NEXT,
});

const PREFIXES = ["/post", "/get", "/next-files", "/stuck", "/noforward"] as const;
const hits: Array<{ method: string; url: string }> = [];
const server = http.createServer((q, r) => {
  const url = q.url || "/";
  const method = String(q.method || "GET").toUpperCase();
  hits.push({ method, url });
  const [pathOnly, query = ""] = url.split("?");
  const p = PREFIXES.find((x) => pathOnly === x || pathOnly.startsWith(`${x}/`)) ?? "";
  const rest = pathOnly.slice(p.length);
  const qs = new URLSearchParams(query);
  const send = (html: string): void => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(html); };
  const redirect = (to: string): void => { r.writeHead(303, { Location: to }); r.end(); };
  if (!p) return send("<html><body><h1>Unknown</h1></body></html>");
  if (rest === "/home") return send(homePage(p));
  if (rest === "/apply") return send(applyPage(p));
  if (rest === "/info") {
    if (p === "/stuck") {
      // Next does nothing but tell the server it was pressed.
      return send(shell(p, { title: "Permitting Information", content: PERMITTING_INFORMATION,
        nav: `<button type="button" class="btn btn-primary ms-auto" onclick="fetch('${p}/clicked-next')">Next</button>` }));
    }
    if (p === "/noforward") {
      return send(shell(p, { title: "Permitting Information", method: "GET", content: PERMITTING_INFORMATION,
        nav: `<button type="submit" name="t_p1685049573549" class="btn btn-primary">Previous</button><a href="${p}/cancel" class="btn">Cancel</a>` }));
    }
    return send(shell(p, { title: "Permitting Information", content: PERMITTING_INFORMATION, nav: PREV_NEXT, method: p === "/post" ? "POST" : "GET" }));
  }
  if (rest === "/sg") {
    // The interstitial's own form: Next → the project page, Previous → back to Apply. A POST is
    // read the same way (the body is not needed to route it — only Next reaches here unaborted).
    if (method === "POST" || qs.has("t_n1685049573549")) return redirect(`${p}/project`);
    return redirect(`${p}/apply`);
  }
  if (rest === "/project") return send(projectPage(p));
  if (rest === "/sg2") {
    const addr = qs.get("addr") ?? "";
    if (qs.has("t_p1685049573549")) return redirect(`${p}/info`);
    return redirect(`${p}/${p === "/next-files" ? "review-next" : "review"}?addr=${encodeURIComponent(addr)}`);
  }
  if (rest === "/review") return send(reviewPage(p, qs.get("addr") ?? ""));
  if (rest === "/review-next") return send(reviewNextPage(p, qs.get("addr") ?? ""));
  if (rest === "/clicked-next") { r.writeHead(204); return r.end(); }
  return send(`<!doctype html><html><body><h1>${esc(rest)}</h1><p>Automation must never land here.</p></body></html>`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch();
const ctx = await browser.newContext();
// The esbuild keepNames transform wraps nameable functions as __name(fn); a raw page has no
// such global. openPortal injects the same shim in production.
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

const pathOf = (u: string): string => { try { return new URL(u).pathname; } catch { return u; } };
const idx = (req: LearnPlanRequest, label: string): number => req.fields.findIndex((f) => String(f.label ?? "").trim() === label);

interface Walk {
  ok: boolean; message: string; stopReason?: string; reachedReview?: boolean; url: string;
  notes: string[]; finals: string[]; events: Array<Record<string, unknown>>; locks: string[]; hits: Array<{ method: string; url: string }>;
  plannerPages: string[];
}
const runLearn = async (prefix: string, planner: (req: LearnPlanRequest) => LearnPlanResponse | null): Promise<Walk> => {
  const before = hits.length;
  const pw = await ctx.newPage();
  await pw.goto(`${base}${prefix}/home`);
  const plannerPages: string[] = [];
  const plan: LearnPlanner = async (req) => {
    plannerPages.push(pathOf(req.url));
    return planner(req) ?? { fills: [], atReview: false };
  };
  const a = new AutoLearnAdapter("Interstitial Walk", plan, { maxPages: 8, budgetMs: 240_000 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (a as any).page = pw;
  // Every debug event the walk emits (the run bundle's timeline), captured in order.
  const events: Array<Record<string, unknown>> = [];
  const holder = a as unknown as { debug?: { event: (e: Record<string, unknown>) => void } };
  if (holder.debug && typeof holder.debug.event === "function") {
    const orig = holder.debug.event.bind(holder.debug);
    holder.debug.event = (e) => { events.push(e); orig(e); };
  } else holder.debug = { event: (e) => { events.push(e); } };
  // THE REVIEW LOCKDOWN, OBSERVED WHERE IT IS ARMED: learn() installs the backstop itself; the
  // moment it exists, its lockReview is wrapped to record which page armed it (and why).
  const locks: string[] = [];
  const spy = setInterval(() => {
    const bs = backstopFor(pw) as (ReturnType<typeof backstopFor> & { __spied?: boolean }) | null;
    if (!bs || bs.__spied) return;
    const orig = bs.lockReview.bind(bs);
    bs.lockReview = (why: string) => { locks.push(`${pathOf(pw.url())} :: ${why}`); orig(why); };
    bs.__spied = true;
  }, 2);
  const r = await a.learn(
    { portalUrl: `${base}${prefix}/home` } as never,
    { projectAddress: `${ADDRESS}, Springfield, IL, 62701`, city: "Springfield", state: "IL", zip: "62701", homeownerName: "T", permitType: "structural" } as never,
  );
  clearInterval(spy);
  const url = pw.url();
  await pw.close().catch(() => null);
  return {
    ok: r.ok, message: r.message, stopReason: r.stopReason, reachedReview: r.reachedReview, url,
    notes: r.steps.map((s) => String(s.note ?? "")),
    finals: r.steps.filter((s) => s.isFinalSubmit).map((s) => String(s.note ?? "")),
    events, locks, hits: hits.slice(before), plannerPages,
  };
};
const pageTrace = (w: Walk, path: string): string =>
  String(w.events.find((e) => e.type === "page" && String(e.trace ?? "").includes(path))?.trace ?? "");
const interstitialEvents = (w: Walk) => w.events.filter((e) => e.type === "interstitial_not_review");

// ===========================================================================================
// [0] The forward control's vocabulary — both directions.
// ===========================================================================================
console.log("\n[0] the interstitial's forward control: what passes, what never does");
{
  const fwd = (adapterModule as { isInterstitialForwardLabel?: (l: string) => boolean }).isInterstitialForwardLabel;
  const passes = ["Next", "Continue", "Proceed", "Begin", "Start", "Get Started", "Next »", "Save and Continue", "Continue >"];
  const never = ["Previous", "Back", "Go Back", "Cancel", "Continue Later", "Save and Exit", "Exit", "Close", "Submit", "Submit Application",
    "Continue Application", "Finish", "Finalize", "Pay Fees", "Continue to Payment", "Next page", "Start Over", "Apply For A Permit", "View or Pay Fees"];
  check("MUST PASS: Next / Continue / Proceed / Begin / Start (and their arrowed or save-and- forms) are the way forward",
    !!fwd && passes.every((l) => fwd(l)), fwd ? JSON.stringify(passes.filter((l) => !fwd(l))) : "isInterstitialForwardLabel is not exported — main's file");
  check("MUST EXCLUDE: Previous / Back / Cancel / exits, every submit- or pay-worded label, a pager and a menu link never are",
    !!fwd && never.every((l) => !fwd(l)), fwd ? JSON.stringify(never.filter((l) => fwd(l))) : "isInterstitialForwardLabel is not exported — main's file");
}

// ===========================================================================================
// [1] The captured page, as served (POST form), the plain stub planner.
// ===========================================================================================
console.log("\n[1] the captured Permitting Information page (POST form): home → entry → tile → interstitial");
{
  const w = await runLearn("/post", () => null);
  check("premise: the walk entered through 'Apply For A Permit' and chose the Solar tile",
    w.notes.some((n) => /^application entry: Apply For A Permit/.test(n)) && w.notes.includes(`permit type: ${SOLAR}`), JSON.stringify(w.notes));
  const trace = pageTrace(w, "/post/info");
  check("the interstitial is classified 'interstitial', never 'review', and the plan is not at review",
    /\binterstitial\b/.test(trace) && !/\breview fields=/.test(trace) && /review=false/.test(trace), trace || JSON.stringify(w.events.filter((e) => e.type === "page")));
  check("the learner says so (interstitial_not_review) and names Next as the way forward",
    interstitialEvents(w).some((e) => e.forward === "Next"), JSON.stringify(interstitialEvents(w)));
  check("no lockReview was armed anywhere on this run", w.locks.length === 0, JSON.stringify(w.locks));
  check("uploads were not skipped 'on review' (it is not the review page)",
    !w.events.some((e) => e.type === "upload_skipped_on_review"), JSON.stringify(w.events.filter((e) => e.type === "upload_skipped_on_review")));
  check("the walk recorded 'advance: Next' (and never Previous)",
    w.notes.includes("advance: Next") && !w.notes.some((n) => /previous/i.test(n)), JSON.stringify(w.notes));
  check("nothing was recorded as a final submit", w.finals.length === 0, JSON.stringify(w.finals));
  check("the run did not end 'at review'", w.reachedReview !== true, `reachedReview=${w.reachedReview} message=${w.message}`);
  // KNOWN RESIDUAL (filed separately, not this issue's file): the network backstop reads the
  // same page as terminal (shared reviewSignals: "review your submission"), so the Next's form
  // POST is aborted and the run stops NAMED by the backstop. Reported here so the line is seen.
  const posted = w.hits.some((h) => h.method === "POST" && h.url.startsWith("/post/sg"));
  console.log(`  note - the Next POST ${posted ? "reached the server" : "was held by the network backstop"}: stopReason=${w.stopReason ?? "-"}; ${w.message.slice(0, 260)}`);
  check("if the backstop held the POST, the stop is its LIVE reading — never the learner's review lockdown",
    posted || (w.stopReason === "backstop_abort" && /the page this request came from/.test(w.message) && !/the run is at review/.test(w.message)),
    `stopReason=${w.stopReason} message=${w.message}`);
}

// ===========================================================================================
// [2] The same page with a GET form, and the worst planner: it calls the interstitial review
//     and names its Next as the final submit.
// ===========================================================================================
console.log("\n[2] the interstitial → the form page → the real review page (worst planner)");
{
  const w = await runLearn("/get", (req) => {
    const at = pathOf(req.url);
    if (at === "/get/info") return { fills: [], atReview: true, finalSubmitSelectorIndex: idx(req, "Next") };
    if (at === "/get/project") return { fills: [{ selectorIndex: idx(req, "Site Address"), value: ADDRESS }], atReview: false, advanceSelectorIndex: idx(req, "Next") };
    if (at === "/get/review") return { fills: [], atReview: true, finalSubmitSelectorIndex: idx(req, "Submit Application") };
    return null;
  });
  check("the planner saw the interstitial (premise: the run reached it)", w.plannerPages.includes("/get/info"), JSON.stringify(w.plannerPages));
  check("the planner's review verdict on the interstitial was overruled (plannerSaidReview recorded)",
    interstitialEvents(w).some((e) => e.plannerSaidReview === true && e.forward === "Next"), JSON.stringify(interstitialEvents(w)));
  const nextClicks = w.hits.filter((h) => h.url.startsWith("/get/sg?") && h.url.includes("t_n1685049573549")).length;
  check("the learner clicked the interstitial's Next exactly once", nextClicks === 1, JSON.stringify(w.hits.map((h) => `${h.method} ${h.url}`)));
  check("...and landed on the form page behind it", w.plannerPages.includes("/get/project"), JSON.stringify(w.plannerPages));
  check("Previous was never clicked", !w.hits.some((h) => h.url.includes("t_p1685049573549")), JSON.stringify(w.hits.map((h) => h.url)));
  check("the interstitial's Next was NEVER recorded as a final submit",
    !w.finals.some((n) => /\bnext\b/i.test(n)), JSON.stringify(w.finals));
  check("the form page was filled (Site Address)", w.events.some((e) => e.type === "page" && /\/get\/project/.test(String(e.trace ?? "")) && /fills=1/.test(String(e.trace ?? ""))),
    JSON.stringify(w.events.filter((e) => e.type === "page").map((e) => e.trace)));
  check("the run stopped at the REAL review page", w.reachedReview === true && pathOf(w.url) === "/get/review", `reachedReview=${w.reachedReview} url=${w.url} message=${w.message}`);
  check("lockReview was armed exactly once, ON the review page",
    w.locks.length === 1 && w.locks[0].startsWith("/get/review ::"), JSON.stringify(w.locks));
  check("'Submit Application' is recorded as the final submit (recorded, NOT clicked)",
    w.finals.length === 1 && /Submit Application/.test(w.finals[0]) && /NOT clicked/.test(w.finals[0]), JSON.stringify(w.finals));
  check("the filing POST never reached the server", !w.hits.some((h) => h.url.startsWith("/get/file")), JSON.stringify(w.hits.map((h) => `${h.method} ${h.url}`)));
}

// ===========================================================================================
// [3] MUST EXCLUDE (rule 1): after a filled form, a review page whose only forward control is
//     a "Next" that FILES still stops for review.
// ===========================================================================================
console.log("\n[3] MUST EXCLUDE: filled form → a review page whose Next files (naive planner advances)");
{
  const w = await runLearn("/next-files", (req) => {
    const at = pathOf(req.url);
    if (at === "/next-files/project") return { fills: [{ selectorIndex: idx(req, "Site Address"), value: ADDRESS }], atReview: false, advanceSelectorIndex: idx(req, "Next") };
    // The naive planner: "Next" is an advance, as on every other page.
    if (at === "/next-files/review-next") return { fills: [], atReview: false, advanceSelectorIndex: idx(req, "Next") };
    return null;
  });
  check("premise: the run reached the review page after filling the form",
    w.plannerPages.includes("/next-files/review-next") && w.events.some((e) => e.type === "page" && /\/next-files\/project/.test(String(e.trace ?? "")) && /fills=1/.test(String(e.trace ?? ""))),
    JSON.stringify(w.plannerPages));
  check("the review page is NOT an interstitial (data was entered on this run)",
    /\breview fields=/.test(pageTrace(w, "/next-files/review-next")) && !/\binterstitial\b/.test(pageTrace(w, "/next-files/review-next")),
    pageTrace(w, "/next-files/review-next"));
  check("the run stopped at review, on that page", w.reachedReview === true && pathOf(w.url) === "/next-files/review-next", `reachedReview=${w.reachedReview} url=${w.url} message=${w.message}`);
  check("lockReview was armed on the review page", w.locks.some((l) => l.startsWith("/next-files/review-next ::")), JSON.stringify(w.locks));
  check("its Next was never clicked: the filing POST never reached the server", !w.hits.some((h) => h.url.startsWith("/next-files/file")),
    JSON.stringify(w.hits.map((h) => `${h.method} ${h.url}`)));
  check("...and never recorded as an advance off the review page", w.notes.filter((n) => n === "advance: Next").length === 2,
    `${JSON.stringify(w.notes)} (expected exactly two: the interstitial's and the form page's)`);
}

// ===========================================================================================
// [4] NO LOOPS: an interstitial whose Next does nothing.
// ===========================================================================================
console.log("\n[4] an interstitial whose Next does nothing");
{
  const w = await runLearn("/stuck", () => null);
  const presses = w.hits.filter((h) => h.url === "/stuck/clicked-next").length;
  check("its Next was pressed exactly once", presses === 1, `presses=${presses}; ${JSON.stringify(w.hits.map((h) => h.url))}`);
  check("the walk stopped and named the page (interstitial_loop) — not a review stop",
    w.stopReason === "interstitial_loop" && w.reachedReview !== true && /information page/.test(w.message), `stopReason=${w.stopReason} reachedReview=${w.reachedReview} message=${w.message}`);
  check("no lockReview, no final submit", w.locks.length === 0 && w.finals.length === 0, JSON.stringify({ locks: w.locks, finals: w.finals }));
}

// ===========================================================================================
// [5] NEVER BACK: an interstitial with only Previous / Cancel; the planner names Previous.
// ===========================================================================================
console.log("\n[5] an interstitial with no way forward (Previous / Cancel only)");
{
  const w = await runLearn("/noforward", (req) => {
    if (pathOf(req.url) === "/noforward/info") return { fills: [], atReview: true, advanceSelectorIndex: idx(req, "Previous") };
    return null;
  });
  check("premise: the planner saw the interstitial", w.plannerPages.includes("/noforward/info"), JSON.stringify(w.plannerPages));
  check("the learner calls it an interstitial with no way forward",
    interstitialEvents(w).some((e) => e.forward === null), JSON.stringify(interstitialEvents(w)));
  check("Previous and Cancel were never clicked",
    !w.hits.some((h) => h.url.includes("t_p1685049573549") || h.url.startsWith("/noforward/cancel")), JSON.stringify(w.hits.map((h) => h.url)));
  check("not a review stop: no lockReview, no final submit, not reachedReview",
    w.locks.length === 0 && w.finals.length === 0 && w.reachedReview !== true, JSON.stringify({ locks: w.locks, finals: w.finals, reachedReview: w.reachedReview, message: w.message }));
}

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures} informationInterstitial.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log("\nAll informationInterstitial.dom.smoke checks passed.");
process.exit(0);
