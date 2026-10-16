// THE #349 ATTACK CATALOGUE AS HELD-PINS FOR THE INFORMATION-PAGE PASS (#344, option B).
//
// Every page shape the #349 rounds broke (Helm m1–m8 and d1/d2, skeptic A a1–a6, b1, e1/e2, f1/f2,
// k1, dr1, pay1/pay2, h1; skeptic B m7/m7a/m7c/m7g, lr/lrn/lrp, late, dr; skeptic C pf1/pf1a/pf1sg,
// tw, d1m/d1ma/d1mcap, cap/caps, ol, pns, gl/glf, m2–m6, capf/capfo, fo) — and the shapes those
// rounds found equal (skeptic A c1, d1 as d1s, d2 as d2s, g1; skeptic C tt) — is walked by the REAL
// learner (AutoLearnAdapter.learn, the network backstop installed by learn itself) TWICE:
//   (i)  with NO verified information page — exactly main's behaviour (no slot can open);
//   (ii) with a NEAR-MISS verified entry: the shape's OWN page read live (its forward control),
//        with one identity component one hash off (or, where the walk captured a candidate, that
//        candidate verified with its text hash one off).
// The assertion, both ways: what reached the server is main's (nothing state-changing — except the
// GET shapes main itself lets through, #346, which are asserted equal), and no information page was
// passed. These are REGRESSION GUARDS: they pass on main too. The fixtures are the probes' own
// (scratchpad lensA-probe.mts, lensB-probes/probe.mts + probe-draft.mts, lensC-probes/lensCProbe.ts),
// synthetic, every page served on 127.0.0.1.
//
// Used by infoPagePassHeldA / B / C .dom.smoke.ts (split to stay inside the DOM runner's budget).
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium, type Browser } from "playwright";
import { AutoLearnAdapter, type LearnPlanRequest, type LearnPlanResponse } from "./autoLearnAdapter";
import { backstopFor } from "../filingBackstop";
import { verifiedInfoPageFromCandidate, type InfoPageDigest } from "../../../shared/src/infoPagePass";
import type { InfoPageCandidateCapture, VerifiedInfoPage } from "../../../shared/src/types";
import { devhubPrefix, devhubReplica, entryFromLivePage, nearMissEntry } from "./infoPageFixture";

const ACCOUNT = "Placeholder Solar Co";
const SOLAR = "Solar Permit Request";
const ADDRESS = "1 Test St";
const card = (id: string, title: string, body: string): string => `
<div id="${id}" class="card-h card-l card"><div class="card-body"><div class="card-title">${title}</div><div class="card-text">${body}</div></div><div class="card-next"><i class="fa fa-chevron-right"></i></div></div>`;
const APPLY_TILES = [
  card("div_d_1", "Building Permit Request", "Residential additions, alterations, demolition."),
  card("div_d_2", SOLAR, "Solar Permit Requests for Residential or Commercial Projects."),
  card("div_d_3", "Trade Permits", "Electrical, Mechanical and Plumbing."),
  card("div_d_4", "Sign Permit Request", "Sign permits."),
].join("");
const HOME_TILES = [
  card("div_h_1", "My Permits &amp; Requests", "See the permits and requests you have filed."),
  card("div_h_2", "Apply For A Permit", "Start a new permit request."),
  card("div_h_3", "View or Pay Fees", "Fees due on your permits."),
].join("");
const delegation = (map: string): string => `<script>
document.getElementById('sgControls').addEventListener('click', function (e) {
  var card = e.target.closest('.card'); if (!card) return;
  var title = card.querySelector('.card-title').textContent.replace(/\\s+/g, ' ').trim();
  location.href = (${map})(title);
});
</script>`;
const sidebar = (p: string): string => `<div class="col left-section no-print"><nav class="navbar left-menu" role="navigation"><ul>
  <li class="title">Portal Fixture</li>
  <li class="item"><a href="${p}/homex">DevHub Home</a></li>
  <li class="item"><a href="${p}/profile">My Profile</a></li>
  <li class="item"><a href="${p}/my-permits">My Permits &amp; Requests</a></li>
  <li class="item"><a href="${p}/fees">View or Pay Fees</a></li>
  <li class="item"><a href="${p}/help">Help and FAQs</a></li>
 </ul></nav></div>`;
const shell = (p: string, o: { title: string; content: string; nav?: string; method?: string; action?: string; script?: string; enctype?: string }): string => `<!doctype html><html><head><meta charset="utf-8"><title>Development Hub Fixture</title>
<style>body{font:14px sans-serif;margin:0} .row{display:flex} .left-section{width:200px} .right-section{flex:1}
.card{display:flex;border:1px solid #ccc;margin:8px 0;padding:8px;min-height:60px} .card-body{flex:1} .card-next{width:32px}
#navigation{display:flex;gap:12px;margin:16px 0} a.btn{display:inline-block;padding:4px 10px;border:1px solid #888}</style>
</head><body class="">
<div id="top-header"><div class="container-xxl d-flex"><div id="signin-menu" class="ms-auto"><div>${ACCOUNT}</div></div></div></div>
<div id="sec-header"><h1>Development Hub Fixture</h1><h2>Online License &amp; Permit Services</h2></div>
<div id="main-content"><form id="smartguide_ApplyForAPermit" action="${o.action ?? `${p}/sg`}" method="${o.method ?? "POST"}"${o.enctype ? ` enctype="${o.enctype}"` : ""} class="form-content smartguide_form" accept-charset="UTF-8">
<div class="row">
 ${sidebar(p)}
 <div class="col-md-10 right-section"><div id="page-content">
  <div class="page-title auto-title">${o.title}</div>
  <div id="sgControls"><div class="row"><div class="col-flex col-md-12">${o.content}</div></div></div>
  <div id="navigation" class="d-flex ">${o.nav ?? ""}</div>
 </div></div>
</div></form></div>
<footer id="bottom-footer" role="contentinfo"><ul class="menu"><li><a href="${p}/privacy">Privacy policy</a></li></ul></footer>
${o.script ?? ""}
</body></html>`;
const PREV_NEXT = `<button type="submit" name="t_p1685049573549" class="btn btn-primary">Previous</button><button type="submit" name="t_n1685049573549" class="btn btn-primary ms-auto ">Next</button>`;
const PREV = (p: string): string => `<button type="submit" name="prev" formaction="${p}/back" formmethod="get" class="btn btn-primary">Previous</button>`;
const homePage = (p: string): string => shell(p, {
  title: "Welcome", content: HOME_TILES,
  script: delegation(`function (t) { return ({'Apply For A Permit':'${p}/apply','My Permits & Requests':'${p}/my-permits','View or Pay Fees':'${p}/fees'})[t] || '${p}/unknown'; }`),
});
const applyPageTo = (p: string, target: string): string => shell(p, {
  title: "Apply for a Permit", content: APPLY_TILES,
  script: delegation(`function (t) { return t === '${SOLAR}' ? '${p}${target}' : '${p}/other-type'; }`),
});
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c] as string);
const prefilledFormPage = (p: string): string => shell(p, {
  title: "Project Information", method: "GET", action: `${p}/to-step3`,
  content: `<div class="form-group"><label for="addr" class="control-label">Site Address</label><input id="addr" name="addr" type="text" value="${ADDRESS}"></div>`,
  nav: PREV_NEXT,
});
const MODAL = "Staff will review your application within 5 business days. Click Next to send it to the city.";
const MODAL_CONT = "The City will review the information you entered within 5 business days. Click Continue to send it to the city.";
const PREAMBLE = "Thank you for using the online permit service. This summary lists the details on file for this request, including the permit type and the site address shown below. "
  + "Permit requests are processed in the order they are received. Processing times vary by season and by the number of requests in the queue. "
  + "Questions about this request can be sent to the permit center by phone during business hours, Monday through Friday, excluding city holidays. "
  + "Requests for the same scope of work should not be repeated, as duplicates delay processing for everyone. ";
const SUMMARY_DL = `<dl class="summary"><dt>Permit Type</dt><dd>${SOLAR}</dd><dt>Site Address</dt><dd>${ADDRESS}</dd></dl>`;
const onLoadPosts = (p: string, posts: Array<{ path: string; ms: number }>): string => posts.map((x) =>
  `<script>setTimeout(function () { fetch(${JSON.stringify(`${p}${x.path}`)}, { method: "POST", body: "autosave=1" }).catch(function () {}); }, ${x.ms});</script>`).join("");
const summaryPage = (p: string, o: { title?: string; prose: string; control?: string; method?: string; action?: string; onLoadPost?: string; linkGet?: string; script?: string }): string => shell(p, {
  title: o.title ?? "Application Summary", method: o.method ?? "POST", action: o.action ?? `${p}/file`,
  content: `<p>${o.prose}</p>${SUMMARY_DL}`,
  nav: o.linkGet
    ? `<a href="${p}/back" class="btn">Previous</a><a href="${p}${o.linkGet}" class="btn btn-primary ms-auto">${o.control ?? "Next"}</a>`
    : `${PREV(p)}<button type="submit" name="next" class="btn btn-primary ms-auto">${o.control ?? "Next"}</button>`,
  script: (o.onLoadPost ? `<script>fetch(${JSON.stringify(`${p}${o.onLoadPost}`)}, { method: "POST", body: "autosave=1" }).catch(function () {});</script>` : "") + (o.script ?? ""),
});
const otherDraftPage = (p: string): string => shell(p, {
  title: "Draft 2026-0141", method: "POST", action: `${p}/act/save-draft-0141`,
  content: `<div class="form-group"><label for="addr" class="control-label">Site Address</label><input id="addr" name="addr" type="text" value="77 Other Ave"></div>`,
  nav: `<button type="submit" name="t_save" class="btn btn-primary ms-auto">Next</button>`,
});
const cardPage = (p: string): string => shell(p, {
  title: "Payment", method: "POST", action: `${p}/pay`,
  content: `<div class="form-group"><label for="cc" class="control-label">Card Number</label><input id="cc" name="cardnumber" autocomplete="cc-number" type="text"></div>`,
  nav: `<button type="submit" name="pay" class="btn btn-primary ms-auto">Pay $350.00</button>`,
});
const FILED = `<!doctype html><html><body><h1>Application filed</h1><p>Your application was submitted. Confirmation 2026-9999.</p></body></html>`;
const SEND_PROSE = "Your solar permit renewal for 1 Test St is ready. Staff will review your application within 5 business days. Click Continue to send it to the city.";
const sendPage = (p: string, prose: string, control: string, method: string, action: string): string => shell(p, {
  title: "Renewal Request", method, action: `${p}${action}`, content: `<p>${prose}</p>${SUMMARY_DL}`,
  nav: `${PREV(p)}<button type="submit" name="next" class="btn btn-primary ms-auto">${control}</button>`,
});
const lateForm = (p: string, prose: string, lateMs: number): string => shell(p, {
  title: "Project Information", method: "GET", action: `${p}/to-step3`, content: `${prose}<div id="slot"></div>`, nav: PREV_NEXT,
  script: `<script>setTimeout(function () { document.getElementById('slot').innerHTML = '<div class="form-group"><label for="addr" class="control-label">Site Address</label><input id="addr" name="addr" type="text" value="${ADDRESS}"></div>'; }, ${lateMs});</script>`,
});
const DEVHUB_PROSE = "This is a permit request only. A Permit Tech will review your submission for minimum submittal standards, and if met, a permit will be created. If you already have the information you need to apply, scroll to the bottom of the page and click \"Continue\". Please do not submit additional requests for the same scope of work.";
const plainShell = (title: string, body: string, script = ""): string =>
  `<!doctype html><html><head><title>${title}</title></head><body><header><a href="HOME">Program Home</a></header><main>${body}</main>${script}</body></html>`;

type Reply = { html?: string; redirect?: string; status?: number };
export interface HeldShape {
  desc: string;
  /** Where the Solar tile leads (rest). */
  firstTarget: string;
  /** Start somewhere other than <p>/home (rest). */
  start?: string;
  route: (p: string, rest: string, method: string) => Reply | null;
  /** The planner by page (rest). null = nothing. */
  plan: (rest: string, idx: (label: string) => number) => LearnPlanResponse | null;
  plannerDelayMs?: number;
  options?: Record<string, unknown>;
  project?: Record<string, unknown>;
  /** What must never reach the server (`METHOD /rest`). */
  leak: RegExp;
  /** PREMISE: the page the walk must have reached (rest; default firstTarget) — a walk that never
   *  got there proves nothing. */
  premise?: string;
  /** Main ITSELF lets this shape's leak through (#346 GET forwards; a sentence rendered after load):
   *  asserted EQUAL to (i), never newly opened. */
  mainLeaks?: boolean;
}
const adv = (map: Record<string, string>) => (rest: string, idx: (l: string) => number): LearnPlanResponse | null =>
  map[rest] ? { fills: [], atReview: false, advanceSelectorIndex: idx(map[rest]) } : null;
const silent = (): null => null;
const fromForm = (p: string, rest: string): Reply | null => {
  if (rest === "/form") return { html: prefilledFormPage(p) };
  if (rest === "/to-step3") return { redirect: `${p}/step3` };
  return null;
};
const draftNotice = (p: string, text: string): string => shell(p, { title: "Permitting Information", method: "POST", content: text,
  nav: `<button type="submit" name="t_c1" class="btn btn-primary ms-auto">Continue</button>` });
const draftRoutes = (p: string, rest: string, m: string, notice: string): Reply | null =>
  rest === "/info" ? { html: draftNotice(p, notice) }
    : rest === "/sg" && m === "POST" ? { redirect: `${p}/draft-0141` } : rest === "/draft-0141" ? { html: otherDraftPage(p) }
      : rest.startsWith("/act/") ? { html: `<!doctype html><html><body><h1>Saved</h1><p>${esc(rest)}</p></body></html>` } : null;
const D1M = `<p>You have an application in progress.</p><p>Draft 2026-0141, 77 Other Ave. Once submitted, staff will review your application.</p>`;

export const HELD_SHAPES: Record<string, HeldShape> = {
  // ---- Helm (#349 review): form → summary; the learner stops at review on main.
  m1: { desc: "form -> summary 'Staff will review…', Next POST /file, planner says atReview", firstTarget: "/form",
    route: (p, rest) => fromForm(p, rest) ?? (rest === "/step3" ? { html: summaryPage(p, { prose: MODAL }) } : null),
    plan: (rest, idx) => rest === "/form" ? { fills: [], atReview: false, advanceSelectorIndex: idx("Next") } : rest === "/step3" ? { fills: [], atReview: true } : null, leak: /^POST \/file/ },
  m2: { desc: "form -> summary 'Staff will review…', Next POST /file, planner advance", firstTarget: "/form",
    route: (p, rest) => fromForm(p, rest) ?? (rest === "/step3" ? { html: summaryPage(p, { prose: MODAL }) } : null), plan: adv({ "/form": "Next", "/step3": "Next" }), leak: /^POST \/file/ },
  m3: { desc: "form -> 'The City will review…', Continue POST /file, planner advance", firstTarget: "/form",
    route: (p, rest) => fromForm(p, rest) ?? (rest === "/step3" ? { html: summaryPage(p, { prose: MODAL_CONT, control: "Continue" }) } : null), plan: adv({ "/form": "Next", "/step3": "Continue" }), leak: /^POST \/file/ },
  m4: { desc: "form -> 'A plans examiner may review…', Proceed POST /file, planner advance", firstTarget: "/form",
    route: (p, rest) => fromForm(p, rest) ?? (rest === "/step3" ? { html: summaryPage(p, { prose: "A plans examiner may review your submission within 5 business days. Click Proceed to send it to the city.", control: "Proceed" }) } : null),
    plan: adv({ "/form": "Next", "/step3": "Proceed" }), leak: /^POST \/file/ },
  m5: { desc: "form -> m2 wording, GET form Next /file, planner advance", firstTarget: "/form",
    route: (p, rest) => fromForm(p, rest) ?? (rest === "/step3" ? { html: summaryPage(p, { prose: MODAL, method: "GET" }) } : null), plan: adv({ "/form": "Next", "/step3": "Next" }), leak: /^(GET|POST) \/file/ },
  m6: { desc: "m2 + the summary's on-load POST /autosave", firstTarget: "/form",
    route: (p, rest) => fromForm(p, rest) ?? (rest === "/step3" ? { html: summaryPage(p, { prose: MODAL, onLoadPost: "/autosave" }) } : rest === "/autosave" ? { status: 204 } : null),
    plan: adv({ "/form": "Next", "/step3": "Next" }), leak: /^POST \/(autosave|file)/ },
  m7: { desc: "tile -> summary DIRECTLY (no form), modal-only prose, POST Next files; planner silent", firstTarget: "/step3",
    route: (p, rest) => rest === "/step3" ? { html: summaryPage(p, { prose: MODAL }) } : null, plan: silent, leak: /^POST \/file/ },
  m7a: { desc: "m7, planner calls Next an advance", firstTarget: "/step3",
    route: (p, rest) => rest === "/step3" ? { html: summaryPage(p, { prose: MODAL }) } : null, plan: adv({ "/step3": "Next" }), leak: /^POST \/file/ },
  m7c: { desc: "tile -> summary DIRECTLY, 'The City will review the information you entered', POST Continue files", firstTarget: "/step3",
    route: (p, rest) => rest === "/step3" ? { html: summaryPage(p, { prose: MODAL_CONT, control: "Continue" }) } : null, plan: silent, leak: /^POST \/file/ },
  m7g: { desc: "m7 with a GET Next (main lets it through: #346)", firstTarget: "/step3",
    route: (p, rest) => rest === "/step3" ? { html: summaryPage(p, { prose: MODAL, method: "GET" }) } : null, plan: silent, leak: /^(GET|POST) \/file/, mainLeaks: true },
  m8: { desc: "m7, planner says atReview", firstTarget: "/step3",
    route: (p, rest) => rest === "/step3" ? { html: summaryPage(p, { prose: MODAL }) } : null, plan: (rest) => rest === "/step3" ? { fills: [], atReview: true } : null, leak: /^POST \/file/ },
  d1: { desc: "Helm d1: after the tile, an in-progress notice with one Continue (POST) to somebody's draft; planner silent", firstTarget: "/info",
    route: (p, rest, m) => draftRoutes(p, rest, m, `<p>You have an application in progress.</p><p>Draft 2026-0141, 77 Other Ave.</p>`), plan: silent, leak: /^POST \/(sg|act\/)/ },
  d2: { desc: "Helm d2: 'Saved applications: Draft 2026-0141 …', one Continue", firstTarget: "/info",
    route: (p, rest, m) => draftRoutes(p, rest, m, `<p>Saved applications: Draft 2026-0141, 77 Other Ave.</p>`), plan: silent, leak: /^POST \/(sg|act\/)/ },
  // ---- skeptic A.
  a1: { desc: "send page, POST Continue -> /sg, planner advance", firstTarget: "/target", route: (p, rest) => rest === "/target" ? { html: sendPage(p, SEND_PROSE, "Continue", "POST", "/sg") } : null, plan: adv({ "/target": "Continue" }), leak: /^POST \/sg/ },
  a2: { desc: "send page, POST Continue -> /sg, planner atReview", firstTarget: "/target", route: (p, rest) => rest === "/target" ? { html: sendPage(p, SEND_PROSE, "Continue", "POST", "/sg") } : null, plan: (r) => r === "/target" ? { fills: [], atReview: true } : null, leak: /^POST \/sg/ },
  a3: { desc: "send page, POST Continue -> /sg, planner nothing", firstTarget: "/target", route: (p, rest) => rest === "/target" ? { html: sendPage(p, SEND_PROSE, "Continue", "POST", "/sg") } : null, plan: silent, leak: /^POST \/sg/ },
  a4: { desc: "send page, POST Next -> /sg, planner advance", firstTarget: "/target", route: (p, rest) => rest === "/target" ? { html: sendPage(p, SEND_PROSE.replace("Continue", "Next"), "Next", "POST", "/sg") } : null, plan: adv({ "/target": "Next" }), leak: /^POST \/sg/ },
  a5: { desc: "send page, POST 'Save and Continue' -> /sg, planner nothing", firstTarget: "/target", route: (p, rest) => rest === "/target" ? { html: sendPage(p, SEND_PROSE.replace("Continue", "Save and Continue"), "Save and Continue", "POST", "/sg") } : null, plan: silent, leak: /^POST \/sg/ },
  a6: { desc: "quick-apply page 'A plans examiner may review your submission', POST Proceed -> /apply-now", firstTarget: "/target",
    route: (p, rest) => rest === "/target" ? { html: sendPage(p, "Quick apply: your account's solar contractor licence and the address below are used. A plans examiner may review your submission after it is received. Click Proceed to send your permit request.", "Proceed", "POST", "/apply-now") } : null,
    plan: adv({ "/target": "Proceed" }), leak: /^POST \/apply-now/ },
  b1: { desc: "send page, Continue = fetch POST /api/send then location", firstTarget: "/target",
    route: (p, rest) => rest === "/target" ? { html: shell(p, { title: "Renewal Request", content: `<p>${SEND_PROSE}</p>${SUMMARY_DL}`,
      nav: `<button type="button" class="btn" onclick="location.href='${p}/back'">Previous</button><button type="button" id="go" class="btn btn-primary ms-auto">Continue</button>`,
      script: `<script>document.getElementById('go').addEventListener('click', function () { fetch('${p}/api/send', { method: 'POST', body: 'go=1' }).then(function () { location.href = '${p}/done'; }).catch(function () {}); });</script>` }) } : null,
    plan: adv({ "/target": "Continue" }), leak: /^POST \/api\/send/ },
  e1: { desc: "no-field send page, no forward control, fetch POST /autosave at 0 / 1500 / 4000 ms", firstTarget: "/target",
    route: (p, rest) => rest === "/target" ? { html: shell(p, { title: "Renewal Request", content: `<p>${SEND_PROSE.replace(" Click Continue to send it to the city.", "")}</p>${SUMMARY_DL}`, nav: PREV(p), script: onLoadPosts(p, [{ path: "/autosave0", ms: 0 }, { path: "/autosave1500", ms: 1500 }, { path: "/autosave4000", ms: 4000 }]) }) } : null,
    plan: silent, leak: /^POST \/autosave/ },
  e2: { desc: "DevHub-like page (Next POST /sg) that also fetch POSTs /autosave at 0 / 1500 / 4000 ms, planner advance", firstTarget: "/target",
    route: (p, rest) => rest === "/target" ? { html: shell(p, { title: "Renewal Request", content: `<p>${SEND_PROSE.replace("Continue", "Next")}</p>${SUMMARY_DL}`, nav: `${PREV(p)}<button type="submit" name="next" class="btn btn-primary ms-auto">Next</button>`, script: onLoadPosts(p, [{ path: "/autosave0", ms: 0 }, { path: "/autosave1500", ms: 1500 }, { path: "/autosave4000", ms: 4000 }]) }) } : null,
    plan: adv({ "/target": "Next" }), leak: /^POST \/(autosave|sg)/ },
  f1: { desc: "first form page (prefilled) 'Staff will review your application', fetch POST /draft at 0 / 1500 / 4000 ms, planner 3 s, Next GET", firstTarget: "/target", plannerDelayMs: 3000,
    route: (p, rest) => rest === "/target" ? { html: shell(p, { title: "Project Information", method: "GET", action: `${p}/to-step3`,
      content: `<p>Staff will review your application within 5 business days.</p><div class="form-group"><label for="addr" class="control-label">Site Address</label><input id="addr" name="addr" type="text" value="${ADDRESS}"></div>`,
      nav: `${PREV(p)}<button type="submit" name="next" class="btn btn-primary ms-auto">Next</button>`, script: onLoadPosts(p, [{ path: "/draft0", ms: 0 }, { path: "/draft1500", ms: 1500 }, { path: "/draft4000", ms: 4000 }]) }) }
      : rest === "/to-step3" ? { redirect: `${p}/step3` } : rest === "/step3" ? { html: shell(p, { title: "Review and Submit", content: `<p>Review your application before submitting.</p>${SUMMARY_DL}`, nav: `${PREV(p)}<button type="submit" class="btn">Submit Application</button>`, action: `${p}/file` }) } : null,
    plan: adv({ "/target": "Next" }), leak: /^POST \/(draft|file)/ },
  f2: { desc: "f1 without the planner latency", firstTarget: "/target", route: (p, rest, m) => HELD_SHAPES.f1.route(p, rest, m), plan: adv({ "/target": "Next" }), leak: /^POST \/(draft|file)/ },
  k1: { desc: "ACA record-type page (radio, deterministic pass) -> m6 summary with on-load POSTs, planner advance Next", firstTarget: "/summary", start: "/CitizenAccess/Cap/CapType.aspx",
    route: (p, rest) => rest === "/CitizenAccess/Cap/CapType.aspx" ? { html: `<!doctype html><html><head><meta charset="utf-8"><title>Accela Citizen Access</title></head><body>
<form id="aspnetForm" method="GET" action="${p}/summary">
<h1>Select a Record Type</h1><p>Choose one of the following available record types.</p>
<div><input type="radio" id="ctl00_PlaceHolderMain_rdoType_0" name="ctl00$PlaceHolderMain$rdoType" value="RS"><label for="ctl00_PlaceHolderMain_rdoType_0">Residential - Structural</label></div>
<div><input type="radio" id="ctl00_PlaceHolderMain_rdoType_1" name="ctl00$PlaceHolderMain$rdoType" value="RE"><label for="ctl00_PlaceHolderMain_rdoType_1">Residential - Electrical</label></div>
<div><button type="submit" id="ctl00_PlaceHolderMain_btnContinue" class="ACA_LgButton">Continue Application &raquo;</button></div>
</form></body></html>` } : rest === "/summary" ? { html: summaryPage(p, { title: "Application Summary", prose: MODAL, script: onLoadPosts(p, [{ path: "/autosave0", ms: 0 }, { path: "/autosave1500", ms: 1500 }, { path: "/autosave4000", ms: 4000 }]) }) } : null,
    plan: adv({ "/summary": "Next" }), leak: /^POST \/(autosave|file)/ },
  dr1: { desc: "continueDraft: home -> record NEM-90017 -> Begin Part 2 -> the draft's summary (modal review, Next POST /file) with on-load POSTs", firstTarget: "/home", start: "/home", premise: "/p2/1",
    options: { maxPages: 10, continueDraft: { nextForm: "Interconnection Application - Part 2", street: "1234 North Example Street, Lynden, WA, 98264", required: true } },
    project: { projectAddress: "1234 North Example Street, Lynden, WA, 98264", city: "Lynden", state: "WA", zip: "98264", homeownerName: "Jordan Testcase" },
    route: (p, rest) => rest === "/home" ? { html: plainShell("Program Home", `<h1>Program Home</h1><a href="${p}/new" class="btn">Start a New Application</a>
    <table><thead><tr><th>Project</th><th>Status</th><th>Customer</th><th>Site</th></tr></thead><tbody>
      <tr><td><a href="${p}/rec/80001">NEM-80001</a></td><td>Approved</td><td>Riley Sample</td><td>77 Other Rd, Lynden</td></tr>
      <tr><td><a href="${p}/rec/90017">NEM-90017</a></td><td>Application Draft</td><td>Jordan Testcase</td><td>1234 N Example St, Lynden</td></tr>
    </tbody></table>`).replace("HOME", `${p}/home`) }
      : rest === "/rec/90017" ? { html: plainShell("NEM-90017", `<h1>NEM-90017</h1><p>Status: Application Draft</p><p>1234 N Example St, Lynden</p>
    <div class="card"><div class="card-header">Current Forms</div><table><tbody>
      <tr><td>PSE - Cancellation Form <button type="button" onclick="location.href='${p}/cancel'">Begin</button></td><td>New Form</td></tr>
      <tr><td>Interconnection Application - Part 2 <button type="button" onclick="location.href='${p}/p2/1'">Begin</button></td><td>New Form</td></tr>
    </tbody></table></div>`).replace("HOME", `${p}/home`) }
      : rest === "/p2/1" ? { html: plainShell("Part 2 - Summary", `<h1>Interconnection Application - Part 2</h1><h2>Application Summary</h2><p>NEM-90017</p>
    <p>Staff will review your application within 5 business days. Click Next to send it to the utility.</p>
    <dl><dt>Customer</dt><dd>Jordan Testcase</dd><dt>Service Address</dt><dd>1234 N Example St, Lynden</dd></dl>
    <form action="${p}/file" method="post"><button type="submit">Next</button></form>`, onLoadPosts(p, [{ path: "/autosave0", ms: 0 }, { path: "/autosave1500", ms: 1500 }, { path: "/autosave4000", ms: 4000 }])).replace("HOME", `${p}/home`) } : null,
    plan: silent, leak: /^POST \/(autosave|file)/ },
  pay1: { desc: "'Your solar permit request has an application fee … A $350 fee is due now. Click Continue', Continue POST /sg, planner nothing", firstTarget: "/target",
    route: (p, rest, m) => rest === "/target" ? { html: shell(p, { title: "Fees", content: `<p>Your solar permit request has an application fee. A Permit Tech will review your submission for minimum submittal standards.</p><p>A $350 fee is due now. Click Continue to proceed.</p>`, nav: `${PREV(p)}<button type="submit" name="next" class="btn btn-primary ms-auto">Continue</button>` }) }
      : rest === "/sg" && m === "POST" ? { redirect: `${p}/card` } : rest === "/card" ? { html: cardPage(p) } : null,
    plan: silent, leak: /^POST \/(sg|pay)/ },
  pay2: { desc: "card-on-file charge 'The $350 application fee will be charged to the card on file now. Click Continue', Continue POST /sg", firstTarget: "/target",
    route: (p, rest, m) => rest === "/target" ? { html: shell(p, { title: "Fees", content: `<p>Staff will review your application within 5 business days.</p><p>The $350 application fee will be charged to the card on file now. Click Continue to proceed.</p>`, nav: `${PREV(p)}<button type="submit" name="next" class="btn btn-primary ms-auto">Continue</button>` }) }
      : rest === "/sg" && m === "POST" ? { redirect: `${p}/card` } : rest === "/card" ? { html: cardPage(p) } : null,
    plan: adv({ "/target": "Continue" }), leak: /^POST \/(sg|pay)/ },
  h1: { desc: "FIRST page of the run: account home 'Staff will review your application' + one Continue POST /sg, fetch POST /ping at 1500 / 4000 ms", firstTarget: "/form", start: "/acct", premise: "/acct",
    route: (p, rest) => rest === "/acct" ? { html: shell(p, { title: "My Account", content: `<p>Your last request: Staff will review your application within 5 business days.</p>`, nav: `<button type="submit" name="next" class="btn btn-primary">Continue</button>`, script: onLoadPosts(p, [{ path: "/ping1500", ms: 1500 }, { path: "/ping4000", ms: 4000 }]) }) } : null,
    plan: silent, leak: /^POST \/(sg|ping)/ },
  // ---- skeptic B.
  lr: { desc: "tile -> form page whose input renders 6 s after load (gate 2 s), DevHub prose, GET Next -> summary (POST Next files)", firstTarget: "/form",
    route: (p, rest) => rest === "/form" ? { html: lateForm(p, `<p>${DEVHUB_PROSE}</p>`, 6000) } : rest === "/to-step3" ? { redirect: `${p}/step3` } : rest === "/step3" ? { html: summaryPage(p, { prose: MODAL }) } : null,
    plan: silent, leak: /^POST \/file/ },
  lrn: { desc: "tile -> late-render form page (6 s), NO review prose, planner advances Next (GET) -> summary (POST Next files)", firstTarget: "/form",
    route: (p, rest) => rest === "/form" ? { html: lateForm(p, "<p>Project details.</p>", 6000) } : rest === "/to-step3" ? { redirect: `${p}/step3` } : rest === "/step3" ? { html: summaryPage(p, { prose: MODAL }) } : null,
    plan: adv({ "/form": "Next" }), leak: /^POST \/file/ },
  lrp: { desc: "lr with the PRODUCTION readiness gate (12 s) and the input rendered 22 s after load", firstTarget: "/form",
    route: (p, rest) => rest === "/form" ? { html: lateForm(p, `<p>${DEVHUB_PROSE}</p>`, 22000) } : rest === "/to-step3" ? { redirect: `${p}/step3` } : rest === "/step3" ? { html: summaryPage(p, { prose: MODAL }) } : null,
    plan: silent, leak: /^POST \/file/ },
  late: { desc: "tile -> summary DIRECTLY whose review sentence renders 1.5 s after load, POST Next (main lets it through: its load-time reading is not terminal)", firstTarget: "/step3",
    route: (p, rest) => rest === "/step3" ? { html: shell(p, { title: "Application Summary", method: "POST", action: `${p}/file`, content: `<p id="late"></p>${SUMMARY_DL}`,
      nav: `${PREV(p)}<button type="submit" name="next" class="btn btn-primary ms-auto">Next</button>`, script: `<script>setTimeout(function () { document.getElementById('late').textContent = ${JSON.stringify(MODAL)}; }, 1500);</script>` }) } : null,
    plan: silent, leak: /^POST \/file/, mainLeaks: true },
  // ---- skeptic C.
  pf1: { desc: "tile -> summary (no form), modal-only wording, Next POSTs /file, planner silent", firstTarget: "/step3", route: (p, rest) => rest === "/step3" ? { html: summaryPage(p, { prose: MODAL }) } : null, plan: silent, leak: /^POST \/file/ },
  pf1a: { desc: "pf1, planner advance Next", firstTarget: "/step3", route: (p, rest) => rest === "/step3" ? { html: summaryPage(p, { prose: MODAL }) } : null, plan: adv({ "/step3": "Next" }), leak: /^POST \/file/ },
  pf1sg: { desc: "pf1 whose Next POSTs /sg (DevHub's own form action), which files", firstTarget: "/step3",
    route: (p, rest, m) => rest === "/step3" ? { html: summaryPage(p, { prose: MODAL, action: `${p}/sg` }) } : rest === "/sg" && m === "POST" ? { redirect: `${p}/done` } : rest === "/done" ? { html: FILED } : null,
    plan: silent, leak: /^POST \/sg/ },
  tw: { desc: "tile -> a Yes/No BUTTON question (no fillable) -> summary, Next POSTs /file", firstTarget: "/q1",
    route: (p, rest) => rest === "/q1" ? { html: shell(p, { title: "Project Type", method: "GET", action: `${p}/q1go`, content: `<p>Is this a residential project?</p>`,
      nav: `<button type="submit" name="res" value="yes" class="btn btn-primary">Yes</button><button type="submit" name="res" value="no" class="btn btn-primary">No</button>` }) }
      : rest === "/q1go" ? { redirect: `${p}/step3` } : rest === "/step3" ? { html: summaryPage(p, { prose: MODAL }) } : null,
    plan: adv({ "/q1": "Yes" }), leak: /^POST \/file/ },
  d1m: { desc: "d1 notice + 'Once submitted, staff will review your application.' one Continue (POST), planner silent", firstTarget: "/info", route: (p, rest, m) => draftRoutes(p, rest, m, D1M), plan: silent, leak: /^POST \/(sg|act\/)/ },
  d1ma: { desc: "d1m, the planner advances Continue then the draft's Next", firstTarget: "/info", route: (p, rest, m) => draftRoutes(p, rest, m, D1M), plan: adv({ "/info": "Continue", "/draft-0141": "Next" }), leak: /^POST \/(sg|act\/)/ },
  d1mcap: { desc: "d1 notice, review wording PAST char 320, the planner advances Continue", firstTarget: "/info",
    route: (p, rest, m) => draftRoutes(p, rest, m, `<p>You have an application in progress.</p><p>Draft 2026-0141, 77 Other Ave.</p><p>${PREAMBLE}</p><p>Once submitted, staff will review your application.</p>`),
    plan: adv({ "/info": "Continue", "/draft-0141": "Next" }), leak: /^POST \/(sg|act\/)/ },
  cap: { desc: "tile -> summary (no form), the modal sentence PAST char 320, planner advance Next (POST /file)", firstTarget: "/step3",
    route: (p, rest) => rest === "/step3" ? { html: summaryPage(p, { prose: PREAMBLE + MODAL }) } : null, plan: adv({ "/step3": "Next" }), leak: /^POST \/file/ },
  ol: { desc: "pf1 that POSTs /autosave on load", firstTarget: "/step3",
    route: (p, rest) => rest === "/step3" ? { html: summaryPage(p, { prose: MODAL, onLoadPost: "/autosave" }) } : rest === "/autosave" ? { status: 204 } : null, plan: silent, leak: /^POST \/(autosave|file)/ },
  pns: { desc: "DevHub sentence + 'A $350 fee is due now. Click Continue', Continue POSTs /sg -> card page", firstTarget: "/info",
    route: (p, rest, m) => rest === "/info" ? { html: shell(p, { title: "Application Fee", method: "POST", content: `<p>Your solar permit request has an application fee. A Permit Tech will review your submission for minimum submittal standards.</p><p>A $350 fee is due now. Click Continue to proceed.</p>`,
      nav: `<button type="submit" name="t_c1" class="btn btn-primary ms-auto">Continue</button>` }) } : rest === "/sg" && m === "POST" ? { redirect: `${p}/card` } : rest === "/card" ? { html: cardPage(p) } : null,
    plan: silent, leak: /^POST \/(sg|pay)/ },
  gl: { desc: "pf1 whose filing control is a LINK GET /file?go=1 (main lets it through: #346)", firstTarget: "/step3",
    route: (p, rest) => rest === "/step3" ? { html: summaryPage(p, { prose: MODAL, linkGet: "/file?go=1" }) } : null, plan: silent, leak: /^(GET|POST) \/file/, mainLeaks: true },
  glf: { desc: "form -> summary whose filing control is a LINK GET /file?go=1, planner advance", firstTarget: "/form",
    route: (p, rest) => fromForm(p, rest) ?? (rest === "/step3" ? { html: summaryPage(p, { prose: MODAL, linkGet: "/file?go=1" }) } : null), plan: adv({ "/form": "Next", "/step3": "Next" }), leak: /^(GET|POST) \/file/ },
  capf: { desc: "form -> summary, the modal sentence PAST char 320, planner advance Next", firstTarget: "/form",
    route: (p, rest) => fromForm(p, rest) ?? (rest === "/step3" ? { html: summaryPage(p, { prose: PREAMBLE + MODAL }) } : null), plan: adv({ "/form": "Next", "/step3": "Next" }), leak: /^POST \/file/ },
  capfo: { desc: "capf + on-load POST /autosave", firstTarget: "/form",
    route: (p, rest) => fromForm(p, rest) ?? (rest === "/step3" ? { html: summaryPage(p, { prose: PREAMBLE + MODAL, onLoadPost: "/autosave" }) } : rest === "/autosave" ? { status: 204 } : null),
    plan: adv({ "/form": "Next", "/step3": "Next" }), leak: /^POST \/(autosave|file)/ },
  // ---- the rest of skeptic A's and C's shapes (equal on main and on #349's head; pinned anyway).
  c1: { desc: "send page, GET form Continue -> /sendget (main lets it through: #346)", firstTarget: "/target",
    route: (p, rest) => rest === "/target" ? { html: sendPage(p, SEND_PROSE, "Continue", "GET", "/sendget") } : null, plan: adv({ "/target": "Continue" }), leak: /^GET \/sendget/, mainLeaks: true },
  d1s: { desc: "send page whose control is 'Submit Request' (POST /sg): stops at review, the final recorded and never clicked", firstTarget: "/target",
    route: (p, rest) => rest === "/target" ? { html: sendPage(p, SEND_PROSE.replace("Click Continue", "Click Submit Request"), "Submit Request", "POST", "/sg") } : null, plan: silent, leak: /^POST \/sg/ },
  d2s: { desc: "send page whose control is 'Send' (POST /sg): no forward control adopted", firstTarget: "/target",
    route: (p, rest) => rest === "/target" ? { html: sendPage(p, SEND_PROSE.replace("Click Continue", "Click Send"), "Send", "POST", "/sg") } : null, plan: silent, leak: /^POST \/sg/ },
  g1: { desc: "send page, Continue POST -> /renewal/submit (a filing URL: rule 2)", firstTarget: "/target",
    route: (p, rest) => rest === "/target" ? { html: sendPage(p, SEND_PROSE, "Continue", "POST", "/renewal/submit") } : null, plan: adv({ "/target": "Continue" }), leak: /^POST \/renewal/ },
  tt: { desc: "tile -> a second page with ONE choice tile -> summary (POST Next files)", firstTarget: "/tt1",
    route: (p, rest) => rest === "/tt1" ? { html: shell(p, { title: "Project Type", content: card("div_t_1", "Residential Rooftop", "One- and two-family dwellings."),
      script: delegation(`function (t) { return '${p}/step3'; }`) }) } : rest === "/step3" ? { html: summaryPage(p, { prose: MODAL }) } : null,
    plan: silent, leak: /^POST \/file/ },
  caps: { desc: "cap with the planner silent", firstTarget: "/step3",
    route: (p, rest) => rest === "/step3" ? { html: summaryPage(p, { prose: PREAMBLE + MODAL }) } : null, plan: silent, leak: /^POST \/file/ },
  // skeptic B's dr: a resumed draft whose record page and Part 2 FORM page each POST by themselves on load.
  dr: { desc: "continueDraft: home -> record NEM-90017 (on-load POST /rec/90017/touch) -> Begin Part 2 -> a Part 2 FORM (on-load POST /p2/autosave) -> review", firstTarget: "/home", start: "/home", premise: "/p2/1",
    options: { maxPages: 10, continueDraft: { nextForm: "Interconnection Application - Part 2", street: "1234 North Example Street, Lynden, WA, 98264", required: true } },
    project: { projectAddress: "1234 North Example Street, Lynden, WA, 98264", city: "Lynden", state: "WA", zip: "98264", homeownerName: "Jordan Testcase" },
    route: (p, rest) => rest === "/home" ? { html: plainShell("Program Home", `<h1>Program Home</h1><a href="${p}/new" class="btn">Start a New Application</a>
    <table><thead><tr><th>Project</th><th>Status</th><th>Customer</th><th>Site</th></tr></thead><tbody>
      <tr><td><a href="${p}/rec/80001">NEM-80001</a></td><td>Approved</td><td>Riley Sample</td><td>77 Other Rd, Lynden</td></tr>
      <tr><td><a href="${p}/rec/90017">NEM-90017</a></td><td>Application Draft</td><td>Jordan Testcase</td><td>1234 N Example St, Lynden</td></tr>
    </tbody></table>`).replace("HOME", `${p}/home`) }
      : rest === "/rec/90017" ? { html: plainShell("NEM-90017", `<h1>NEM-90017</h1><p>Status: Application Draft</p><p>1234 N Example St, Lynden</p><p>The utility will review your application once Part 2 is complete.</p>
    <div class="card"><div class="card-header">Current Forms</div><table><tbody>
      <tr><td>Interconnection Application - Part 2 <button type="button" onclick="location.href='${p}/p2/1'">Begin</button></td><td>New Form</td></tr>
    </tbody></table></div>`, `<script>fetch(${JSON.stringify(`${p}/rec/90017/touch`)}, { method: "POST", body: "t=1" }).catch(function () {});</script>`).replace("HOME", `${p}/home`) }
      : rest === "/p2/1" ? { html: plainShell("Part 2 - Project", `<h1>Interconnection Application - Part 2</h1><p>Staff will review your application within 5 business days.</p>
    <form action="${p}/p2/2" method="get"><label for="sz">System Size (kW)</label><input id="sz" name="sz" type="text"><button type="submit">Next</button></form>`,
        `<script>fetch(${JSON.stringify(`${p}/p2/autosave`)}, { method: "POST", body: "a=1" }).catch(function () {});</script>`).replace("HOME", `${p}/home`) }
      : rest === "/p2/2" ? { html: plainShell("Part 2 - Review", `<h1>Review and Submit</h1><p>Review your application before submitting.</p><form action="${p}/file" method="post"><button type="submit">Submit Application</button></form>`).replace("HOME", `${p}/home`) }
      : rest === "/p2/autosave" || rest === "/rec/90017/touch" ? { status: 204 } : null,
    plan: (rest, idx) => rest === "/p2/1" ? { fills: [], atReview: false, advanceSelectorIndex: idx("Next") } : rest === "/p2/2" ? { fills: [], atReview: true } : null,
    leak: /^POST \/(rec|p2|file)/ },
  fo: { desc: "tile -> FIRST form page (prefilled) with modal-only review prose that POSTs /autosave on load -> Step 3: Review", firstTarget: "/form2",
    route: (p, rest) => rest === "/form2" ? { html: shell(p, { title: "Project Information", method: "GET", action: `${p}/to-step3`,
      content: `<p>Staff will review your application within 5 business days of submission.</p><div class="form-group"><label for="addr" class="control-label">Site Address</label><input id="addr" name="addr" type="text" value="${ADDRESS}"></div>`,
      nav: PREV_NEXT, script: `<script>fetch(${JSON.stringify(`${p}/autosave`)}, { method: "POST", body: "autosave=1" }).catch(function () {});</script>` }) }
      : rest === "/autosave" ? { status: 204 } : rest === "/to-step3" ? { redirect: `${p}/step3` }
        : rest === "/step3" ? { html: summaryPage(p, { title: "Step 3: Review", prose: "Please review your application before submitting.", control: "Submit Application" }) } : null,
    plan: adv({ "/form2": "Next" }), leak: /^POST \/(autosave|file)/ },
};

/** Walk the named shapes twice each and print ok / FAIL lines; exits the process. */
export async function runHeldShapes(name: string, ids: string[], o: { concurrency?: number; readyMs?: string | null } = {}): Promise<never> {
  process.env.ENTRY_SETTLE_MS = "0";
  if (o.readyMs === null) delete process.env.PORTAL_SECTION_READY_MS; else process.env.PORTAL_SECTION_READY_MS = o.readyMs ?? "2000";
  delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
  let failures = 0;
  let total = 0;
  const lines: string[] = [];
  const check = (label: string, ok: boolean, detail = ""): void => {
    total++;
    if (ok) lines.push(`  ok   - ${label}`);
    else { failures++; lines.push(`  FAIL - ${label}\n         ${detail.slice(0, 900)}`); }
  };
  const hits: Array<{ method: string; url: string }> = [];
  const server = http.createServer((q, r) => {
    const url = q.url || "/";
    const method = String(q.method || "GET").toUpperCase();
    hits.push({ method, url });
    const [pathOnly] = url.split("?");
    const m = /^\/([a-z0-9]+)(\/.*)?$/i.exec(pathOnly);
    const key = m ? m[1] : "";
    const p = `/${key}`;
    const rest = m ? (m[2] ?? "/") : pathOnly;
    const send = (html: string): void => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(html); };
    const s = HELD_SHAPES[key];
    if (!s) { send("<html><body><h1>Unknown</h1></body></html>"); return; }
    // The near-miss entry's page: a DevHub replica under this shape's prefix (a verified page nearby).
    if (rest === "/permits/sfjsp" && method === "GET") { send(devhubReplica({ p })); return; }
    const reply = s.route(p, rest, method);
    if (reply) {
      if (reply.redirect) { r.writeHead(303, { Location: reply.redirect }); r.end(); return; }
      if (reply.status) { r.writeHead(reply.status); r.end(); return; }
      send(reply.html ?? "");
      return;
    }
    if (method !== "GET" && /^\/(autosave|draft|ping|api\/send|sg|apply-now)/.test(rest)) {
      if (rest === "/sg" || rest === "/apply-now") { r.writeHead(303, { Location: `${p}/done` }); r.end(); return; }
      r.writeHead(204); r.end(); return;
    }
    if (rest === "/home") { send(homePage(p)); return; }
    if (rest === "/apply") { send(applyPageTo(p, s.firstTarget)); return; }
    if (rest === "/to-step3") { r.writeHead(303, { Location: `${p}/step3` }); r.end(); return; }
    if (rest === "/file" || rest === "/done") { send(FILED); return; }
    send(`<!doctype html><html><body><h1>${esc(rest)}</h1><p>Automation must never land here.</p></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser: Browser = await chromium.launch();
  const pathOf = (u: string): string => { try { return new URL(u).pathname; } catch { return u; } };

  interface Walked { reached: string[]; leaks: string[]; passed: number; candidate?: InfoPageCandidateCapture; secs: number; asked: number; message: string; arrived: boolean }
  const walk = async (id: string, entries: VerifiedInfoPage[]): Promise<Walked> => {
    const s = HELD_SHAPES[id];
    const P = `/${id}`;
    const start = `${base}${P}${s.start ?? "/home"}`;
    const ctx = await browser.newContext();
    await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
    const pw = await ctx.newPage();
    const before = hits.length;
    await pw.goto(start);
    const plan = async (req: LearnPlanRequest): Promise<LearnPlanResponse> => {
      if (s.plannerDelayMs) await new Promise((r) => setTimeout(r, s.plannerDelayMs));
      const rest = pathOf(req.url).slice(P.length);
      const idx = (label: string): number => req.fields.findIndex((f) => String(f.label ?? "").trim() === label);
      return s.plan(rest, idx) ?? { fills: [], atReview: false };
    };
    const a = new AutoLearnAdapter("Held Walk", plan, { maxPages: 8, budgetMs: 240_000, infoPagePasses: entries, infoPagePriorProgress: false, ...(s.options ?? {}) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (a as any).page = pw;
    let asked = 0;
    const holder = a as unknown as { debug?: { event: (e: Record<string, unknown>) => void } };
    const count = (e: Record<string, unknown>): void => { if (e.type === "info_page_refused" || e.type === "info_page_pass_open") asked++; };
    if (holder.debug && typeof holder.debug.event === "function") {
      const orig = holder.debug.event.bind(holder.debug);
      holder.debug.event = (e) => { count(e); orig(e); };
    } else holder.debug = { event: count };
    void backstopFor;
    const t0 = Date.now();
    let r: Record<string, unknown> = {};
    try {
      r = await a.learn({ portalUrl: start } as never, (s.project ?? { projectAddress: `${ADDRESS}, Springfield, IL, 62701`, city: "Springfield", state: "IL", zip: "62701", homeownerName: "T", permitType: "structural" }) as never) as unknown as Record<string, unknown>;
    } catch (e) { r = { message: `threw: ${String(e)}` }; }
    await ctx.close().catch(() => null);
    const mine = hits.slice(before).filter((h) => h.url.startsWith(`${P}/`)).map((h) => `${h.method} ${h.url.slice(P.length).split("?")[0]}`);
    // The filing / state-changing requests that reached the server (GET /file counts: a GET filing).
    const reached = mine.filter((h) => !/^GET /.test(h) || /^GET \/file/.test(h));
    return {
      reached, leaks: mine.filter((h) => s.leak.test(h)), arrived: mine.some((h) => h === `GET ${s.premise ?? s.firstTarget}`),
      passed: Array.isArray(r.infoPagePassed) ? (r.infoPagePassed as unknown[]).length : 0,
      candidate: r.infoPageCandidate as InfoPageCandidateCapture | undefined,
      secs: Math.round((Date.now() - t0) / 1000), asked, message: String(r.message ?? "").slice(0, 200),
    };
  };
  const nearEntry = async (id: string, cand?: InfoPageCandidateCapture): Promise<VerifiedInfoPage | null> => {
    const s = HELD_SHAPES[id];
    const P = `/${id}`;
    const prefix = devhubPrefix(`${base}${P}${s.start ?? "/home"}`);
    if (cand && cand.digest) {
      const d = cand.digest as InfoPageDigest;
      return nearMissEntry({ id: `own-${id}`, verifiedAt: "2026-10-15T12:00:00.000Z", ...verifiedInfoPageFromCandidate({ identityVersion: cand.identityVersion, identitySha256: cand.identitySha256, digest: d, prefix: cand.prefix }) }, "textSha");
    }
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();
    let e: VerifiedInfoPage | null = null;
    try {
      // The shape's own page where its forward control sits (when it can be served by GET)…
      await pg.goto(`${base}${P}${s.firstTarget}`).catch(() => null);
      e = await entryFromLivePage(pg, "#navigation button[type=submit]:last-of-type, form button[type=submit]", prefix, `own-${id}`).catch(() => null);
      // …else a verified page nearby (the DevHub replica under the same prefix).
      if (!e) { await pg.goto(`${base}${P}/permits/sfjsp`); e = await entryFromLivePage(pg, "button[name=\"t_n1685049573549\"]", prefix, `near-${id}`); }
    } finally { await ctx.close().catch(() => null); }
    return e ? nearMissEntry(e, "textSha") : null;
  };

  const queue = [...ids];
  const results: Record<string, string[]> = {};
  const worker = async (): Promise<void> => {
    while (queue.length) {
      const id = queue.shift()!;
      const s = HELD_SHAPES[id];
      const out: string[] = [];
      const local = (label: string, ok: boolean, detail = ""): void => { out.push(JSON.stringify([label, ok, detail])); };
      if (!s) { local(`${id}: shape exists`, false, "unknown shape"); results[id] = out; continue; }
      const one = await walk(id, []);
      const entry = await nearEntry(id, one.candidate);
      const two = await walk(id, entry ? [entry] : []);
      const held = (w: Walked): boolean => w.arrived && (s.mainLeaks ? true : w.leaks.length === 0) && w.passed === 0;
      local(`${id} (i) no verified page: ${s.desc} — ${s.mainLeaks ? "exactly main's outcome (main lets it through)" : "HELD, nothing state-changing reached the server"}`,
        held(one) && (s.mainLeaks ? true : one.reached.length === 0), JSON.stringify({ arrived: one.arrived, reached: one.reached, leaks: one.leaks, passed: one.passed, msg: one.message }));
      local(`${id} (ii) a near-miss verified page (one identity hash off): the same outcome, no pass`,
        !!entry && held(two) && JSON.stringify(two.reached) === JSON.stringify(one.reached), JSON.stringify({ entry: !!entry, arrived: two.arrived, reached: two.reached, first: one.reached, passed: two.passed, msg: two.message }));
      out.push(JSON.stringify([`  note - ${id}: ${one.secs}s + ${two.secs}s; the pass was asked ${one.asked}x / ${two.asked}x; ${one.candidate ? `a person COULD verify this page (candidate ${one.candidate.identitySha256.slice(0, 12)}, held=${!!one.candidate.observed})` : "no candidate (refused by shape, run state, or the page is not held)"}`, null, ""]));
      results[id] = out;
    }
  };
  const started = Date.now();
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 3) }, () => worker()));
  for (const id of ids) {
    for (const raw of results[id] ?? []) {
      const [label, ok, detail] = JSON.parse(raw) as [string, boolean | null, string];
      if (ok === null) lines.push(label);
      else check(label, ok, detail);
    }
  }
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
  console.log(`\n${name}: ${ids.length} shapes, two walks each (${Math.round((Date.now() - started) / 1000)}s)`);
  for (const l of lines) (l.includes("FAIL - ") ? console.error : console.log)(l);
  if (failures) { console.error(`\n${failures}/${total} ${name} check(s) FAILED.`); process.exit(1); }
  console.log(`\nAll ${total}/${total} ${name} checks passed.`);
  process.exit(0);
}
