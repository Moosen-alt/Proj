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
//   [1] MUST PASS   — the captured page as served (a MULTIPART POST form, as live). The learner does
//                     NOT call it review: no review stop, no lockReview, no upload skip, no final
//                     submit; it records "advance: Next" and clicks it. #344 (option B):
//       [1a] no verified page: the network backstop holds the POST exactly as on main, the run
//            stops "HELD AT AN INFORMATION PAGE NO PERSON HAS VERIFIED" (stopReason backstop_abort)
//            and hands back the page as a CANDIDATE: identity, the exact prefix, the held request
//            (body names [t_n…]), scrubbed evidence, a screenshot.
//       [1b] a person verified [1a]'s candidate (the entry built from it by the product's own
//            builder): the POST reaches the server with the submitter, the walk lands on the form
//            page, fills it, reaches the REAL review and stops THERE (lockReview armed only there,
//            the final submit recorded and never clicked); infoPagePassed has one entry.
//       [1c] AN ORDINARY INTERSTITIAL (its review wording arrives after load, so the backstop's
//            load-time reading — the one 4(b) judges a form POST by — is not terminal and main
//            lets its Next through): no candidate is recorded (the wide-terminal precondition).
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
//   [6] MUST EXCLUDE — the same prose above a list of records whose rows each say "Continue":
//                     not one way forward, so no row is pressed (and nothing is review).
//   [7] NEM STAGE   — a run that LOOKED for an existing draft (every NEM stage passes the
//                     continueDraft option) and found none is starting fresh: the interstitial
//                     is passed exactly as in [2].
// In [1], [2] and [7] the sidebar's records / fees / corrections / profile pages are never
// requested (the upload pass now runs on the interstitial, and the sidebar is on every page).
//
// REVIEW 1 (Helm, PR #345 — both blockers rule 1; each check FAILS on f25c7478):
//   [0] (c)         — a label that names what it continues ("Next Record", "Continue Draft",
//                     "Continue Renewal", "Proceed with Deletion" …) is never the way forward.
//   [8] BLOCKER 1   — s1–s6: a prefilled form (NO fill recorded) → a REAL review page whose filing
//                     control is a forward word ("Next" / "Save and Continue" / "Continue »"), by
//                     POST, by GET, with the review heading rendered after load, with no review
//                     wording, with a planner that calls the filing control an advance. Never an
//                     interstitial: it stops at review, lockdown armed, the control recorded as the
//                     final submit (NOT clicked), and "filing request reached server: NO".
//   [9] BLOCKER 2   — an account home (the start page, no application entered) whose prose is
//                     review wording, above the account's draft and ONE Continue / Start / Get
//                     Started: never clicked, no draft opened, nothing saved or created.
//
// Against origin/main's autoLearnAdapter.ts every MUST PASS line above is a FAIL banner, not a
// crash: main stops at every interstitial as review (lockReview armed there, "advance: Next"
// never recorded) and, under [2]'s planner, records the interstitial's Next as an isFinalSubmit
// step. [3] cannot be reached on main (the walk never gets past the interstitial); its rule-1
// lines hold on both.
//
//   npx tsx portal-bot/src/adapters/informationInterstitial.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium } from "playwright";
import * as adapterModule from "./autoLearnAdapter";
import { AutoLearnAdapter, type LearnPlanner, type LearnPlanRequest, type LearnPlanResponse } from "./autoLearnAdapter";
import { backstopFor } from "../filingBackstop";
import { sha256Hex, verifiedInfoPageFromCandidate, type InfoPageDigest, type InfoPageEvidence, type InfoPageObservedRequest, type InfoPagePrefixStep } from "../../../shared/src/infoPagePass";
import type { InfoPageCandidateCapture, VerifiedInfoPage } from "../../../shared/src/types";
import { bodyNamesOf } from "./infoPageFixture";

// The entry finder keeps re-reading a page for ENTRY_SETTLE_MS (30 s by default) before it
// concludes there is no way in; read at call time, so set before the first learn.
process.env.ENTRY_SETTLE_MS = "0";
// The section-readiness gate (waitForInteractiveControls) waits for a visible INPUT and gives up
// after 12 s; every page this smoke is about (interstitial, review, account home) has none, so it
// burned 12 s per such page and put the smoke past the DOM runner's 600 s budget. 2 s still
// outlasts [8]'s heading rendered 300 ms after load. Read at call time, so set before the first learn.
process.env.PORTAL_SECTION_READY_MS = "2000";

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
const shell = (p: string, o: { title: string; content: string; nav?: string; method?: string; action?: string; script?: string; enctype?: string }): string => `<!doctype html><html><head><meta charset="utf-8"><title>Development Hub Fixture</title>
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
<div id="main-content"><form id="smartguide_ApplyForAPermit" action="${o.action ?? `${p}/sg`}" method="${o.method ?? "POST"}"${o.enctype ? ` enctype="${o.enctype}"` : ""} class="form-content smartguide_form" accept-charset="UTF-8">
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
  // The review-1 shapes have no interstitial: the tile leads straight to the (prefilled) form.
  script: delegation(`function (t) { return t === '${SOLAR}' ? '${p}${SHAPES[p] ? "/form" : "/info"}' : '${p}/other-type'; }`),
});

// ------------------------------------------------------------------------------------------
// REVIEW 1 (Helm, blocker 1): a REAL review page reached with NO recorded fill. The form arrives
// prefilled (a re-learn over a draft; the planner fills nothing), so "nothing entered on this
// run" is true at the review — and a review whose filing control is a plain forward word has
// none of the submit/certify/URL shape. Each shape: tile → prefilled form ("Next") → /step3: no
// input, a summary of the entered data, Previous + the filing control.
// ------------------------------------------------------------------------------------------
interface Shape { what: string; method: "GET" | "POST"; heading: string; prose: string; control: string; late?: boolean; plannerAdvances?: boolean }
const SHAPES: Record<string, Shape> = {
  "/s1": { what: "POST, static \"Step 3: Review\", Next files", method: "POST", heading: "Step 3: Review", prose: "Check every value below.", control: "Next" },
  "/s2": { what: "GET form, \"Step 3: Review\", Next files", method: "GET", heading: "Step 3: Review", prose: "Check every value below.", control: "Next" },
  "/s3": { what: "POST, the review heading rendered by script 300 ms after load", method: "POST", heading: "Step 3: Review", prose: "Check every value below.", control: "Next", late: true },
  "/s4": { what: "POST, no review wording at all", method: "POST", heading: "Step 3", prose: "Check every value below.", control: "Next" },
  "/s5": { what: "POST, static review wording, \"Save and Continue\" files", method: "POST", heading: "Confirmation", prose: "Please review your information below.", control: "Save and Continue" },
  "/s6": { what: "GET form, \"Review your application below\", \"Continue »\" files, the planner calls it an advance", method: "GET", heading: "Confirmation", prose: "Review your application below.", control: "Continue »", plannerAdvances: true },
};
const prefilledFormPage = (p: string): string => shell(p, {
  title: "Project Information", method: "GET", action: `${p}/to-step3`,
  content: `<div class="form-group"><label for="addr" class="control-label">Site Address</label><input id="addr" name="addr" type="text" value="${ADDRESS}"></div>`,
  nav: PREV_NEXT,
});
const shapeStep3 = (p: string, s: Shape): string => shell(p, {
  title: s.late ? "" : s.heading, method: s.method, action: `${p}/file`,
  content: `<h2 id="rh"></h2><p>${s.prose}</p>
    <dl class="summary"><dt>Permit Type</dt><dd>${SOLAR}</dd><dt>Site Address</dt><dd>${ADDRESS}</dd></dl>`,
  nav: `<button type="submit" name="prev" formaction="${p}/back" formmethod="get" class="btn btn-primary">Previous</button><button type="submit" name="next" class="btn btn-primary ms-auto">${s.control}</button>`,
  script: s.late ? `<script>setTimeout(function () { document.getElementById('rh').textContent = ${JSON.stringify(s.heading)}; }, 300);</script>` : "",
});

// REVIEW 1 (Helm, blocker 2): an ACCOUNT HOME whose prose is review wording, above the account's
// own draft and ONE forward-worded control. The walk has entered no application: never clicked.
const ACCOUNT_HOMES: Record<string, { label: string; to: string }> = {
  "/acct-continue": { label: "Continue", to: "/draft-0141" },
  "/acct-start": { label: "Start", to: "/act/create-application" },
  "/acct-getstarted": { label: "Get Started", to: "/act/create-application" },
};
const accountHome = (p: string, label: string, to: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>Account Home</title></head><body>
  <h1>Account Home</h1><nav><a href="${p}/my-permits">My Permits</a> <a href="${p}/profile">My Profile</a></nav>
  <p>Welcome back, ${ACCOUNT}. Review your application status below.</p>
  <table><tr><td>Draft 2026-0141</td><td>In progress</td></tr></table>
  <button type="button" onclick="location.href='${p}${to}'">${label}</button>
</body></html>`;
const draftPage = (p: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>Draft 2026-0141</title></head><body>
  <h1>Draft 2026-0141</h1><form action="${p}/act/save-draft-0141" method="get">
  <label for="addr">Site Address</label><input id="addr" name="addr"><button type="submit">Next</button></form>
</body></html>`;
// #344 round 2: on /post (the verified pass's walk, [1b]) the page the verified Next leads to must
// show POSITIVE evidence of an application form: two empty plain fields in one POST form (DevHub's
// SmartGuide steps all POST). Q4 (round 6): like DevHub's, its Next posts back to the interview's own
// endpoint (/sg, routed by its BODY: its own submitter t_n_project) — the SAME INTERVIEW rule lets
// only that through after the verified Next.
const projectPage = (p: string): string => p === "/post" ? shell(p, {
  title: "Project Information", method: "POST", action: `${p}/sg`,
  content: `<div class="form-group"><label for="addr" class="control-label">Site Address</label><input id="addr" name="addr" type="text"></div><div class="form-group"><label for="unit" class="control-label">Unit / Suite</label><input id="unit" name="unit" type="text"></div>`,
  nav: `<button type="submit" name="t_p1685049573549" class="btn btn-primary">Previous</button><button type="submit" name="t_n_project" class="btn btn-primary ms-auto ">Next</button>`,
}) : shell(p, {
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

const PREFIXES = ["/post", "/late", "/get", "/next-files", "/stuck", "/noforward", "/rows", "/nem", ...Object.keys(SHAPES), ...Object.keys(ACCOUNT_HOMES)];
const hits: Array<{ method: string; url: string; names?: string[] }> = [];
// The POST bodies are read (multipart / urlencoded field NAMES only) before the handler routes them.
const server = http.createServer((q, r) => {
  const chunks: Buffer[] = [];
  q.on("data", (c: Buffer) => chunks.push(c));
  q.on("end", () => route(q, r, Buffer.concat(chunks)));
});
const route = (q: http.IncomingMessage, r: http.ServerResponse, body: Buffer): void => {
  const url = q.url || "/";
  const method = String(q.method || "GET").toUpperCase();
  const names = method === "GET" ? [] : bodyNamesOf(String(q.headers["content-type"] || ""), body);
  hits.push({ method, url, names });
  const [pathOnly, query = ""] = url.split("?");
  const p = PREFIXES.find((x) => pathOnly === x || pathOnly.startsWith(`${x}/`)) ?? "";
  const rest = pathOnly.slice(p.length);
  const qs = new URLSearchParams(query);
  const send = (html: string): void => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(html); };
  const redirect = (to: string): void => { r.writeHead(303, { Location: to }); r.end(); };
  if (!p) return send("<html><body><h1>Unknown</h1></body></html>");
  if (ACCOUNT_HOMES[p]) {
    if (rest === "/home") return send(accountHome(p, ACCOUNT_HOMES[p].label, ACCOUNT_HOMES[p].to));
    if (rest === "/draft-0141") return send(draftPage(p));
    if (rest.startsWith("/act/")) return send(`<!doctype html><html><body><h1>Saved</h1><p>${esc(rest)}</p></body></html>`);
  }
  if (SHAPES[p]) {
    if (rest === "/form") return send(prefilledFormPage(p));
    if (rest === "/to-step3") return redirect(`${p}/step3`);
    if (rest === "/step3") return send(shapeStep3(p, SHAPES[p]));
    if (rest === "/file") return send(`<!doctype html><html><body><h1>Application filed</h1><p>Your application was submitted.</p></body></html>`);
  }
  if (rest === "/home") return send(homePage(p));
  if (rest === "/apply") return send(applyPage(p));
  if (rest === "/info") {
    if (p === "/stuck") {
      // Next does nothing but tell the server it was pressed.
      return send(shell(p, { title: "Permitting Information", content: PERMITTING_INFORMATION,
        nav: `<button type="button" class="btn btn-primary ms-auto" onclick="fetch('${p}/clicked-next')">Next</button>` }));
    }
    if (p === "/rows") {
      // The same prose above a list of the account's records, each with its own "Continue".
      const row = (n: number): string => `<tr><td>Request ${n}</td><td>In progress</td><td><button type="button" class="btn" onclick="fetch('${p}/clicked-continue?row=${n}')">Continue</button></td></tr>`;
      return send(shell(p, { title: "Permitting Information", content: `${PERMITTING_INFORMATION}<table class="records"><tbody>${row(1)}${row(2)}${row(3)}</tbody></table>` }));
    }
    if (p === "/noforward") {
      return send(shell(p, { title: "Permitting Information", method: "GET", content: PERMITTING_INFORMATION,
        nav: `<button type="submit" name="t_p1685049573549" class="btn btn-primary">Previous</button><a href="${p}/cancel" class="btn">Cancel</a>` }));
    }
    if (p === "/late") {
      // AN ORDINARY INTERSTITIAL: the same prose, rendered by script 300 ms after load — the
      // backstop's load-time reading is not terminal, so main lets its Next POST through.
      return send(shell(p, { title: "Permitting Information", content: `<div id="lateProse"></div>`, nav: PREV_NEXT, method: "POST", enctype: "multipart/form-data",
        script: `<script>setTimeout(function () { document.getElementById('lateProse').innerHTML = ${JSON.stringify(PERMITTING_INFORMATION)}; }, 300);</script>` }));
    }
    // /post is the live shape: a MULTIPART POST to the form's own action.
    return send(shell(p, { title: "Permitting Information", content: PERMITTING_INFORMATION, nav: PREV_NEXT, method: p === "/post" ? "POST" : "GET", enctype: p === "/post" ? "multipart/form-data" : undefined }));
  }
  if (rest === "/sg") {
    // The interstitial's own form: Next → the project page, Previous → back to Apply. A POST is
    // routed by its BODY, as DevHub's is: only a body that carries Next's submitter goes forward.
    const names = hits[hits.length - 1].names ?? [];
    if (method === "POST" && names.includes("t_n_project")) return redirect(`${p}/review?addr=${encodeURIComponent(new URLSearchParams(body.toString("utf8")).get("addr") ?? "")}`);
    if ((method === "POST" && names.includes("t_n1685049573549")) || qs.has("t_n1685049573549")) return redirect(`${p}/project`);
    return redirect(`${p}/apply`);
  }
  if (rest === "/project") return send(projectPage(p));
  if (rest === "/sg2" || (rest === "/project-next" && method === "POST")) {
    const fields = rest === "/project-next" ? new URLSearchParams(body.toString("utf8")) : qs;
    const addr = fields.get("addr") ?? "";
    if (fields.has("t_p1685049573549")) return redirect(`${p}/info`);
    return redirect(`${p}/${p === "/next-files" ? "review-next" : "review"}?addr=${encodeURIComponent(addr)}`);
  }
  if (rest === "/review") return send(reviewPage(p, qs.get("addr") ?? ""));
  if (rest === "/review-next") return send(reviewNextPage(p, qs.get("addr") ?? ""));
  if (rest === "/clicked-next" || rest === "/clicked-continue") { r.writeHead(204); r.end(); return; }
  return send(`<!doctype html><html><body><h1>${esc(rest)}</h1><p>Automation must never land here.</p></body></html>`);
};
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
  notes: string[]; finals: string[]; events: Array<Record<string, unknown>>; locks: string[]; hits: Array<{ method: string; url: string; names?: string[] }>;
  plannerPages: string[];
  /** Recorded form-data steps (fill / select / check / uncheck). */
  formSteps: number;
  /** #344: the unverified information page the backstop held, and the verified ones it passed. */
  candidate?: InfoPageCandidateCapture;
  passed?: Array<{ passId: string; where: string }>;
}
const runLearn = async (prefix: string, planner: (req: LearnPlanRequest) => LearnPlanResponse | null, options: Record<string, unknown> = {}): Promise<Walk> => {
  const before = hits.length;
  const started = Date.now();
  const pw = await ctx.newPage();
  await pw.goto(`${base}${prefix}/home`);
  const plannerPages: string[] = [];
  const plan: LearnPlanner = async (req) => {
    plannerPages.push(pathOf(req.url));
    return planner(req) ?? { fills: [], atReview: false };
  };
  const a = new AutoLearnAdapter("Interstitial Walk", plan, { maxPages: 8, budgetMs: 240_000, ...options });
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
  console.log(`  (walk ${prefix}: ${Math.round((Date.now() - started) / 1000)}s)`);
  const url = pw.url();
  await pw.close().catch(() => null);
  return {
    ok: r.ok, message: r.message, stopReason: r.stopReason, reachedReview: r.reachedReview, url,
    notes: r.steps.map((s) => String(s.note ?? "")),
    finals: r.steps.filter((s) => s.isFinalSubmit).map((s) => String(s.note ?? "")),
    events, locks, hits: hits.slice(before), plannerPages,
    formSteps: r.steps.filter((s) => ["fill", "select", "check", "uncheck"].includes(String(s.action))).length,
    candidate: (r as { infoPageCandidate?: InfoPageCandidateCapture }).infoPageCandidate,
    passed: (r as { infoPagePassed?: Array<{ passId: string; where: string }> }).infoPagePassed,
  };
};
const pageTrace = (w: Walk, path: string): string =>
  String(w.events.find((e) => e.type === "page" && String(e.trace ?? "").includes(path))?.trace ?? "");
const interstitialEvents = (w: Walk) => w.events.filter((e) => e.type === "interstitial_not_review");
/** The sidebar's / footer's / header's other destinations: the account's records, fees,
 *  corrections, profile, help, policy pages, and the wrong tile. None is ever the way forward. */
const OFF_PATH = /^\/[a-z0-9-]+\/(profile|my-permits|fees|corrections|help|ada|privacy|about|unknown|other-type|cancel)\b/;
const offPath = (w: Walk): string[] => w.hits.map((h) => h.url).filter((u) => OFF_PATH.test(u));

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
  // REVIEW 1 (c): a word AFTER the forward word names what the click continues — somebody's record,
  // or an action on it. Only the whole bare label is the page's way forward.
  const records = ["Next Record", "Next Permit", "Continue Draft", "Continue Editing", "Continue as Guest", "Continue Renewal",
    "Continue Withdrawal", "Proceed with Deletion", "Continue to Delete", "Proceed with Application", "Proceed to Filing"];
  check("REVIEW 1 MUST EXCLUDE: a label that names what it continues (Next Record / Continue Draft / Continue Renewal / Proceed with Deletion …) is never the way forward",
    !!fwd && records.every((l) => !fwd(l)), fwd ? JSON.stringify(records.filter((l) => fwd(l))) : "isInterstitialForwardLabel is not exported — main's file");
  check("REVIEW 1 MUST PASS: the whole bare forward words still are (Next / Next » / Continue / Continue » / Continue > / Proceed / Begin / Start / Get Started / Save and Continue)",
    !!fwd && ["Next", "Next »", "Continue", "Continue »", "Continue >", "Proceed", "Begin", "Start", "Get Started", "Save and Continue"].every((l) => fwd(l)),
    fwd ? JSON.stringify(["Next", "Next »", "Continue", "Continue »", "Continue >", "Proceed", "Begin", "Start", "Get Started", "Save and Continue"].filter((l) => !fwd(l))) : "not exported");
}

// ===========================================================================================
// [1] The captured page, as served (POST form), the plain stub planner.
// ===========================================================================================
console.log("\n[1a] the captured Permitting Information page (MULTIPART POST form), NO verified page: held, captured");
let candidate1a: InfoPageCandidateCapture | undefined;
{
  const w = await runLearn("/post", () => null, { infoPagePriorProgress: false });
  candidate1a = w.candidate;
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
  check("no records / fees / corrections / profile page was ever requested", offPath(w).length === 0, JSON.stringify(offPath(w)));
  // #344: with no verified page, the network backstop holds the Next's multipart POST exactly as
  // on main (its terminal reading: "review your submission"), and the run hands the page back as a
  // candidate for a person to verify.
  const posted = w.hits.some((h) => h.method === "POST" && h.url.startsWith("/post/sg"));
  check("[1a] the Next's POST was HELD (never reached the server)", !posted, JSON.stringify(w.hits.map((h) => `${h.method} ${h.url}`)));
  check("[1a] the stop is the backstop's LIVE reading, named as an unverified information page (stopReason backstop_abort)",
    w.ok === false && w.stopReason === "backstop_abort" && w.message.startsWith("HELD AT AN INFORMATION PAGE NO PERSON HAS VERIFIED") && /the page this request came from/.test(w.message) && !/the run is at review/.test(w.message),
    `ok=${w.ok} stopReason=${w.stopReason} message=${w.message}`);
  const c = w.candidate;
  const digest = c?.digest as InfoPageDigest | undefined;
  const observed = c?.observed as InfoPageObservedRequest | null | undefined;
  const evidence = c?.evidence as InfoPageEvidence | undefined;
  check("[1a] a candidate: identity, version, origin + path, the control", !!c && /^[0-9a-f]{64}$/.test(c.identitySha256) && c.identityVersion === 1
    && c.path === "/post/info" && c.controlLabel === "Next" && !!digest && digest.identitySha256 === c.identitySha256, JSON.stringify(c ? { ...c, digest: undefined, evidence: undefined, screenshotBase64: c.screenshotBase64 ? "…" : undefined } : null).slice(0, 600));
  check("[1a] the candidate's prefix is exactly the walk's [goto entry url, application entry, permit type]",
    !!c && JSON.stringify(c.prefix.map((s: InfoPagePrefixStep) => [s[0], s[1]])) === JSON.stringify([["goto", "entry url"], ["click", "application entry: Apply For A Permit"], ["click", `permit type: ${SOLAR}`]]),
    JSON.stringify(c?.prefix));
  check("[1a] the held request was observed: POST /post/sg, multipart, body [[t_n…, sha('')]]",
    !!observed && observed.method === "POST" && /\/post\/sg$/.test(observed.where) && observed.media === "multipart/form-data"
    && JSON.stringify(observed.body) === JSON.stringify([["t_n1685049573549", sha256Hex("")]]), JSON.stringify(observed));
  check("[1a] the evidence carries the page's prose and no field value", !!evidence && evidence.text.includes("A Permit Tech will review your submission")
    && evidence.forms.every((f) => f.fields.every((x) => x.length === 3)), JSON.stringify(evidence ? { ...evidence, text: evidence.text.slice(0, 120) } : null));
  check("[1a] a masked screenshot was taken before the click", !!c?.screenshotBase64 && c.screenshotBase64.length > 1000, String(c?.screenshotBase64?.length ?? 0));
  check("[1a] a clean run's card carries no history stamp, and the message no history line",
    !!c && c.capturedWithHistory !== true && !/THIS project already made progress/.test(w.message), `stamp=${c?.capturedWithHistory} message=${w.message}`);
}

// ===========================================================================================
// [1h] #366 through the REAL learner: the same page on a project that already made progress on
// this portal (priorProgress true, a real reading). Held exactly as [1a], and the card is still
// captured — screenshot, observed request, the history stamp — and the message says this project
// still needs "Allow once more". [1u]: no reading at all (the backend's fail-closed stand-in, or no
// backend): held, and NO card.
// ===========================================================================================
console.log("\n[1h] #366: the same page on a project with history: held, the card captured with its stamp");
{
  const w = await runLearn("/post", () => null, { infoPagePriorProgress: true, infoPagePassUnavailable: false });
  const posted = w.hits.some((h) => h.method === "POST" && h.url.startsWith("/post/sg"));
  check("[1h] the Next's POST was HELD (never reached the server)", !posted, JSON.stringify(w.hits.map((h) => `${h.method} ${h.url}`)));
  const c = w.candidate;
  check("[1h] the card was captured through the real learner: the held request observed and a masked screenshot",
    !!c && !!c.observed && !!c.screenshotBase64 && c.screenshotBase64.length > 1000, JSON.stringify(c ? { observed: !!c.observed, shot: c.screenshotBase64?.length ?? 0 } : null));
  check("[1h] the card carries the history stamp (the person verifying it is warned)", !!c && c.capturedWithHistory === true, String(c?.capturedWithHistory));
  check("[1h] the message says this project still stops at the verified page (never 'after that, runs pass it')",
    w.stopReason === "backstop_abort" && /THIS project already made progress on this portal/.test(w.message) && !/after that, runs pass it/.test(w.message), w.message);
}
console.log("\n[1u] #366: no reading at all (the fail-closed stand-in): held, and no card");
{
  const w = await runLearn("/post", () => null, {});
  const posted = w.hits.some((h) => h.method === "POST" && h.url.startsWith("/post/sg"));
  check("[1u] the Next's POST was HELD (never reached the server)", !posted, JSON.stringify(w.hits.map((h) => `${h.method} ${h.url}`)));
  check("[1u] no card: an unknown reading records no evidence and claims no history",
    !w.candidate && !/THIS project already made progress/.test(w.message), JSON.stringify({ candidate: !!w.candidate, message: w.message }));
}

// ===========================================================================================
// [1b] The same page, verified by a named person from [1a]'s candidate: the ONE Next passes.
// ===========================================================================================
console.log("\n[1b] the same page, VERIFIED from [1a]'s candidate: Next passes, the walk fills the form and stops at the real review");
{
  const c = candidate1a;
  const entry: VerifiedInfoPage | null = c
    ? { id: "pass-post", verifiedAt: "2026-10-15T12:00:00.000Z", ...verifiedInfoPageFromCandidate({ identityVersion: c.identityVersion, identitySha256: c.identitySha256, digest: c.digest as InfoPageDigest, prefix: c.prefix }) }
    : null;
  // Round 3: the form page must take THIS JOB'S own data before the run leaves it (proof of
  // progress): the planner binds the job's street, which the backend names as one of its own values.
  const w = await runLearn("/post", (req) => {
    const at = pathOf(req.url);
    if (at === "/post/project") return { fills: [{ selectorIndex: idx(req, "Site Address"), value: ADDRESS, field: "street" }], atReview: false, advanceSelectorIndex: idx(req, "Next") };
    if (at === "/post/review") return { fills: [], atReview: true, finalSubmitSelectorIndex: idx(req, "Submit Application") };
    return null;
  }, { infoPagePasses: entry ? [entry] : [], infoPagePriorProgress: false, infoPageProofValues: { street: ADDRESS, city: "Springfield", zip: "62701" },
    // Round 5: the backend reserves each use at the admission; here it always reserves (the
    // reservation's own refusals are pinned in infoPagePass.dom.smoke [R] and backend infoPages.test).
    reserveInfoPagePass: () => [] });
  const nexts = w.hits.filter((h) => h.method === "POST" && h.url.startsWith("/post/sg") && (h.names ?? []).includes("t_n1685049573549"));
  check("[1b] premise: [1a] produced a candidate to verify", !!entry);
  check("[1b] the Next's multipart POST reached the server ONCE, carrying the submitter",
    nexts.length === 1 && (nexts[0].names ?? []).includes("t_n1685049573549"), JSON.stringify(w.hits.map((h) => `${h.method} ${h.url} ${(h.names ?? []).join(",")}`)));
  check("[1b] the walk passed the information page once (infoPagePassed)", (w.passed ?? []).length === 1 && w.passed![0].passId === "pass-post", JSON.stringify(w.passed));
  check("[1b] ...landed on the form page and filled it", w.plannerPages.includes("/post/project")
    && w.events.some((e) => e.type === "page" && /\/post\/project/.test(String(e.trace ?? "")) && /fills=1/.test(String(e.trace ?? ""))), JSON.stringify(w.plannerPages));
  check("[1b] ...and stopped at the REAL review page, lockReview armed there only",
    w.reachedReview === true && pathOf(w.url) === "/post/review" && w.locks.length === 1 && w.locks[0].startsWith("/post/review ::"),
    JSON.stringify({ reachedReview: w.reachedReview, url: w.url, locks: w.locks, message: w.message.slice(0, 300) }));
  check("[1b] 'Submit Application' is recorded as the final submit (recorded, NOT clicked); the filing never reached the server",
    w.finals.length === 1 && /Submit Application/.test(w.finals[0]) && /NOT clicked/.test(w.finals[0]) && !w.hits.some((h) => h.url.startsWith("/post/file")),
    JSON.stringify({ finals: w.finals, hits: w.hits.map((h) => h.url) }));
  check("[1b] no candidate is recorded for a verified page", !w.candidate, JSON.stringify(w.candidate ? { id: w.candidate.identitySha256 } : null));
}

// ===========================================================================================
// [1c] AN ORDINARY INTERSTITIAL: the backstop would not hold its Next (its load-time reading is
//      not terminal), so no pass is asked for and no candidate is recorded.
// ===========================================================================================
console.log("\n[1c] an ordinary interstitial (review wording rendered after load): no candidate");
{
  const w = await runLearn("/late", () => null, { infoPagePriorProgress: false });
  const posted = w.hits.some((h) => h.method === "POST" && h.url.startsWith("/late/sg"));
  check("[1c] premise: the learner took the page as an interstitial and pressed Next",
    interstitialEvents(w).some((e) => e.forward === "Next") && w.notes.includes("advance: Next"), JSON.stringify(interstitialEvents(w)));
  check("[1c] main's backstop does not hold this Next (its POST reached the server, exactly as on main)", posted, JSON.stringify(w.hits.map((h) => `${h.method} ${h.url}`)));
  check("[1c] NO candidate was recorded (the wide-terminal precondition)", !w.candidate, JSON.stringify(w.candidate ? { identity: w.candidate.identitySha256, observed: w.candidate.observed } : null));
  check("[1c] the refusal named the reading", w.events.some((e) => e.type === "info_page_refused" && JSON.stringify(e.refusals ?? []).includes("does not read this page as terminal")),
    JSON.stringify(w.events.filter((e) => String(e.type).startsWith("info_page"))));
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
  check("no records / fees / corrections / profile page was ever requested", offPath(w).length === 0, JSON.stringify(offPath(w)));
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

// ===========================================================================================
// [6] MUST EXCLUDE: the same prose above a list whose rows each say "Continue" — somebody's
//     records, not one way forward. Not review, and no row is pressed.
// ===========================================================================================
console.log("\n[6] MUST EXCLUDE: review prose above three record rows, each with its own Continue");
{
  const w = await runLearn("/rows", () => null);
  check("premise: the planner saw the page", w.plannerPages.includes("/rows/info"), JSON.stringify(w.plannerPages));
  check("not a review stop (nothing entered, no review shape): no lockReview, no final submit",
    w.locks.length === 0 && w.finals.length === 0 && w.reachedReview !== true, JSON.stringify({ locks: w.locks, finals: w.finals, reachedReview: w.reachedReview }));
  check("three same-worded controls are not ONE way forward: no forward control adopted",
    interstitialEvents(w).some((e) => e.forward === null && e.candidates === 3), JSON.stringify(interstitialEvents(w)));
  check("no row's Continue was pressed", !w.hits.some((h) => h.url.startsWith("/rows/clicked-continue")), JSON.stringify(w.hits.map((h) => h.url)));
}

// ===========================================================================================
// [7] A NEM STAGE: the run was told to LOOK for this project's draft (every NEM stage is) and
//     there is none on the portal — it is starting fresh, so the interstitial is passed.
// ===========================================================================================
console.log("\n[7] an NEM-stage run (continueDraft option set, no draft on the portal)");
{
  const w = await runLearn("/nem", (req) => {
    const at = pathOf(req.url);
    if (at === "/nem/project") return { fills: [{ selectorIndex: idx(req, "Site Address"), value: ADDRESS }], atReview: false, advanceSelectorIndex: idx(req, "Next") };
    if (at === "/nem/review") return { fills: [], atReview: true, finalSubmitSelectorIndex: idx(req, "Submit Application") };
    return null;
  }, { continueDraft: { street: ADDRESS, city: "Springfield", zip: "62701" } });
  check("premise: the run looked for an existing draft and found none",
    w.events.some((e) => e.type === "existing_draft" && e.kind === "none"), JSON.stringify(w.events.filter((e) => e.type === "existing_draft")));
  check("the interstitial is still not review: Next is the way forward",
    interstitialEvents(w).some((e) => e.forward === "Next"), JSON.stringify(interstitialEvents(w)));
  check("Next was clicked exactly once and the walk reached the form page",
    w.hits.filter((h) => h.url.startsWith("/nem/sg?") && h.url.includes("t_n1685049573549")).length === 1 && w.plannerPages.includes("/nem/project"),
    JSON.stringify({ hits: w.hits.map((h) => h.url), planner: w.plannerPages }));
  check("...and stopped at the real review page, lockReview armed there only",
    w.reachedReview === true && pathOf(w.url) === "/nem/review" && w.locks.length === 1 && w.locks[0].startsWith("/nem/review ::"),
    JSON.stringify({ reachedReview: w.reachedReview, url: w.url, locks: w.locks, message: w.message }));
  check("no records / fees / corrections / profile page was ever requested", offPath(w).length === 0, JSON.stringify(offPath(w)));
}

// ===========================================================================================
// [8] REVIEW 1, BLOCKER 1 (rule 1): a REAL review page reached with NO recorded fill — the form
//     arrived prefilled and the planner filled nothing — whose filing control is a plain forward
//     word. Never an interstitial: it stops at review, and the filing request never reaches the
//     server, whatever the backstop can or cannot see (GET; a heading rendered after load).
// ===========================================================================================
console.log("\n[8] REVIEW 1 blocker 1: a prefilled form (no fill recorded) → a real review page whose filing control is a forward word");
for (const [p, s] of Object.entries(SHAPES)) {
  const w = await runLearn(p, (req) => {
    const at = pathOf(req.url);
    if (at === `${p}/form`) return { fills: [], atReview: false, advanceSelectorIndex: idx(req, "Next") };
    if (at === `${p}/step3`) {
      return s.plannerAdvances
        ? { fills: [], atReview: false, advanceSelectorIndex: idx(req, s.control) }
        : { fills: [], atReview: true, finalSubmitSelectorIndex: idx(req, s.control) };
    }
    return null;
  });
  const filing = w.hits.filter((h) => h.url.startsWith(`${p}/file`)).map((h) => `${h.method} ${h.url}`);
  console.log(`  note - ${p} (${s.what}): FILING REQUEST REACHED SERVER: ${filing.length ? `YES [${filing.join(", ")}]` : "no"}`);
  check(`${p} premise: the walk reached the review page with NO fill recorded`,
    w.plannerPages.includes(`${p}/step3`) && w.formSteps === 0,
    JSON.stringify({ planner: w.plannerPages, formSteps: w.formSteps, notes: w.notes }));
  check(`${p} the review page is NOT an interstitial`, !/\binterstitial\b/.test(pageTrace(w, `${p}/step3`)) && !interstitialEvents(w).length,
    `${pageTrace(w, `${p}/step3`)} ${JSON.stringify(interstitialEvents(w))}`);
  check(`${p} filing request reached server: NO`, filing.length === 0, JSON.stringify(filing));
  check(`${p} the run stopped at review, on the review page, with the lockdown armed there`,
    w.reachedReview === true && pathOf(w.url) === `${p}/step3` && w.locks.some((l) => l.startsWith(`${p}/step3 ::`)),
    JSON.stringify({ reachedReview: w.reachedReview, url: w.url, locks: w.locks, message: w.message.slice(0, 200) }));
  // The prefilled form's own "Next" is one legitimate "advance: Next"; the review page adds none.
  const formAdvances = s.control === "Next" ? 1 : 0;
  check(`${p} the filing control "${s.control}" was never recorded as an advance off the review page`,
    w.notes.filter((n) => n === `advance: ${s.control}`).length === formAdvances, JSON.stringify(w.notes));
  if (!s.plannerAdvances) {
    check(`${p} "${s.control}" is recorded as the ONE final submit (recorded, NOT clicked)`,
      w.finals.length === 1 && w.finals[0] === `final submit: ${s.control} (recorded, NOT clicked)`, JSON.stringify(w.finals));
  }
}

// ===========================================================================================
// [9] REVIEW 1, BLOCKER 2: an ACCOUNT HOME (the start page — no application entered yet) whose
//     prose is review wording ("Review your application status below"), above the account's
//     own draft and ONE Continue / Start / Get Started. Not an interstitial: nothing is clicked,
//     no draft is opened or saved.
// ===========================================================================================
console.log("\n[9] REVIEW 1 blocker 2: an account home with review wording and one forward-worded control");
for (const [p, h] of Object.entries(ACCOUNT_HOMES)) {
  const w = await runLearn(p, (req) => {
    if (pathOf(req.url) === `${p}/draft-0141`) return { fills: [{ selectorIndex: idx(req, "Site Address"), value: ADDRESS }], atReview: false, advanceSelectorIndex: idx(req, "Next") };
    return null;
  });
  const touched = w.hits.filter((h2) => h2.url.startsWith(`${p}/draft-0141`) || h2.url.startsWith(`${p}/act/`)).map((h2) => h2.url);
  check(`${p}: "${h.label}" on the account home was never clicked — no draft opened, nothing saved or created`,
    touched.length === 0 && !w.notes.some((n) => n === `advance: ${h.label}`), JSON.stringify({ touched, notes: w.notes }));
  check(`${p}: the account home is not an interstitial`, !interstitialEvents(w).length, JSON.stringify(interstitialEvents(w)));
  check(`${p}: no records / profile page was requested`, offPath(w).length === 0, JSON.stringify(offPath(w)));
}

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures} informationInterstitial.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log("\nAll informationInterstitial.dom.smoke checks passed.");
process.exit(0);
