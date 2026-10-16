// A VERIFIED INFORMATION PAGE'S INCIDENTS, WALKED BY THE REAL LEARNER (#344, proposal §4).
//
// One synthetic DevHub-like portal (home → "Apply For A Permit" → the Solar tile → the
// "Permitting Information" page, whose Next is a multipart POST the backstop's review lockdown
// holds on main). A first walk with NO verified page is held and hands back the page as a
// candidate; the entry a person's verification of that candidate writes (the product's own builder,
// verifiedInfoPageFromCandidate) is then live for every later walk. What the portal does with the
// verified Next is chosen per walk by a cookie, so every walk passes the SAME verified page:
//
//   AFTER THE CLICK — the page the verified click leads to must read as an unfiled form. Each of
//   these is an INCIDENT: the walk stops (stopReason "info_page_incident"), the pass is reported
//   (infoPageIncidents, phase "after") for the backend to withdraw, the sticky lock is armed,
//   nothing more reaches the server, no final submit is recorded and the walk did not reach review:
//     receipt  — "Your application has been submitted. Confirmation number: …" (no field);
//     filed    — a filed status ("Your request was received") beside a search box;
//     review   — the review page (review wording, a certify box, Submit Application);
//     error    — "There was an error processing your request." beside the form;
//     same     — the same information page again (no field);
//     blank    — an empty page;
//   ROUND 2 (the old check passed these: "a visible field and no known filed phrase") — each a
//   receipt worded outside classifySubmissionText's vocabulary beside a search or feedback box:
//     f_receipt_miss1-4 (s1), list, reqnum, confcolon, status, iframe, feedback, paid, receiptRef,
//     confirmEdit, confirmCertify (s2), feedback2 (a two-field feedback form), newreq (a receipt
//     offering a real two-field "start another request" form: only the new number gives it away),
//     late (a form skeleton swapped for a receipt 1 s after load: the second reading catches it).
//   THE POSITIVE CONTROL — form: the real application form (two empty plain fields in the
//   SmartGuide form) beside a header search box, the footer's phone number on both pages: no
//   incident, the walk goes on.
//   BEFORE THE CLICK — the verified page itself drifted:
//     drift    — one sentence added: held exactly as on main (nothing posted), the pass reported
//                as an incident (phase "before"), the page as it is now recorded as the candidate,
//                the message names the change;
//     tileb    — the same page reached through ANOTHER permit-type tile ("Rooftop Solar Request"):
//                held, nothing posted, an incident naming the different steps.
//
// Kill checks: without the after-click check (checkInfoPageAfterClick) the receipt walk does not
// stop as an incident; with main's filingBackstop.ts no walk passes the page at all.
//
//   npx tsx portal-bot/src/adapters/infoPageIncident.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium } from "playwright";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";
import { backstopFor } from "../filingBackstop";
import { verifiedInfoPageFromCandidate, type InfoPageDigest } from "../../../shared/src/infoPagePass";
import type { InfoPageCandidateCapture, InfoPageIncident, VerifiedInfoPage } from "../../../shared/src/types";
import { bodyNamesOf } from "./infoPageFixture";

process.env.ENTRY_SETTLE_MS = "0";
process.env.PORTAL_SECTION_READY_MS = "2000";
delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
let total = 0;
const lines: string[] = [];
const check = (label: string, ok: boolean, detail = ""): void => {
  total++;
  if (ok) lines.push(`  ok   - ${label}`);
  else { failures++; lines.push(`  FAIL - ${label}\n         ${detail.slice(0, 900)}`); }
};

// ------------------------------------------------------------------------------------------
// The portal (synthetic; the company name is a placeholder)
// ------------------------------------------------------------------------------------------
const ACCOUNT = "Placeholder Solar Co";
const SOLAR = "Solar Permit Request";
const NEXT = "t_n1685049573549";
const P = "/x";
const INFO_PROSE = `<p><span>This is a permit request only.</span> A Permit Tech will review your submission for minimum submittal standards, and if met, a permit will be created. Once your permit has been deemed complete for intake, you will be provided with instructions via email for how to pay your intake fees. If you already have the information you need to apply, scroll to the bottom of the page and click "Continue". Please do not submit additional requests for the same scope of work.</p>`;
const card = (id: string, title: string, body: string): string =>
  `<div id="${id}" class="card-h card-l card"><div class="card-body"><div class="card-title">${title}</div><div class="card-text">${body}</div></div><div class="card-next"><i class="fa fa-chevron-right"></i></div></div>`;
const delegation = (map: string): string => `<script>
document.getElementById('sgControls').addEventListener('click', function (e) {
  var card = e.target.closest('.card'); if (!card) return;
  var title = card.querySelector('.card-title').textContent.replace(/\\s+/g, ' ').trim();
  location.href = (${map})(title);
});
</script>`;
const shell = (o: { title: string; content: string; nav?: string; method?: string; action?: string; enctype?: string; script?: string }): string => `<!doctype html><html><head><meta charset="utf-8"><title>Development Hub Fixture</title>
<style>body{font:14px sans-serif;margin:0} .row{display:flex} .left-section{width:200px} .right-section{flex:1}
.card{display:flex;border:1px solid #ccc;margin:8px 0;padding:8px;min-height:60px} .card-body{flex:1} .card-next{width:32px}
#navigation{display:flex;gap:12px;margin:16px 0}</style>
</head><body class="">
<div id="top-header"><div class="container-xxl d-flex"><a href="${P}/home"><img id="top-header-logo" alt="City seal"></a>
 <div id="signin-menu" class="ms-auto"><button id="signedin-menu-btn" type="button" class="dropdown-toggle" data-bs-toggle="dropdown" aria-expanded="false"><div>${ACCOUNT}</div></button></div></div></div>
<div id="sec-header"><h1>Development Hub Fixture</h1><h2>Online License &amp; Permit Services</h2></div>
<div id="main-content"><form id="smartguide_ApplyForAPermit" action="${o.action ?? `${P}/sg`}" method="${o.method ?? "POST"}"${o.enctype ? ` enctype="${o.enctype}"` : ""} class="form-content smartguide_form" accept-charset="UTF-8">
<div class="row">
 <div class="col left-section no-print"><nav class="navbar left-menu" role="navigation"><ul>
  <li class="title">Portal Fixture</li>
  <li class="item"><a href="${P}/home">DevHub Home</a></li>
  <li class="item"><a href="${P}/profile">My Profile</a></li>
  <li class="item"><a href="${P}/my-permits">My Permits &amp; Requests</a></li>
  <li class="item"><a href="${P}/fees">View or Pay Fees</a></li>
 </ul></nav></div>
 <div class="col-md-10 right-section"><div id="page-content">
  <div class="page-title auto-title">${o.title}</div>
  <div id="sgControls"><div class="row"><div class="col-flex col-md-12">${o.content}</div></div></div>
  <div id="navigation" class="d-flex ">${o.nav ?? ""}</div>
 </div></div>
</div></form></div>
<footer id="bottom-footer" role="contentinfo"><p>Questions? Call 503-000-0000.</p><ul class="menu"><li><a href="${P}/privacy">Privacy policy</a></li></ul></footer>
${o.script ?? ""}
</body></html>`;
const PREV_NEXT = `<button type="submit" name="t_p1685049573549" class="btn btn-primary">Previous</button><button type="submit" name="${NEXT}" class="btn btn-primary ms-auto ">Next</button>`;
const homePage = (): string => shell({
  title: "Welcome",
  content: [card("div_h_1", "My Permits &amp; Requests", "See the permits and requests you have filed."), card("div_h_2", "Apply For A Permit", "Start a new permit request."), card("div_h_3", "View or Pay Fees", "Fees due on your permits.")].join(""),
  script: delegation(`function (t) { return ({'Apply For A Permit':'${P}/apply','My Permits & Requests':'${P}/my-permits','View or Pay Fees':'${P}/fees'})[t] || '${P}/unknown'; }`),
});
// The tile the walk takes leads to the SAME information page whatever it is called (critique [0]:
// the page belongs to the whole Apply interview, not to one tile). The tileb walk is offered
// "Rooftop Solar Request" where the verified walk took "Solar Permit Request".
const TILE_B = "Rooftop Solar Request";
const applyPage = (mode: string): string => shell({
  title: "Apply for a Permit",
  content: [card("div_d_1", "Building Permit Request", "Residential additions, alterations, demolition."), card("div_d_2", mode === "tileb" ? TILE_B : SOLAR, "Solar Permit Requests for Residential Projects."), card("div_d_3", "Trade Permits", "Electrical, Mechanical and Plumbing.")].join(""),
  script: delegation(`function (t) { return (t === '${SOLAR}' || t === '${TILE_B}') ? '${P}/info' : '${P}/other-type'; }`),
});
const infoPage = (drift: boolean): string => shell({
  title: "Permitting Information", method: "POST", enctype: "multipart/form-data", nav: PREV_NEXT,
  content: `${INFO_PROSE}${drift ? "<p>New: intake now opens on weekdays only.</p>" : ""}`,
});
const plain = (title: string, body: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
// Round 2 widgets: a search box in the page's header (its own GET form, role=search), one INSIDE the
// big SmartGuide form (an ASP.NET-style page wraps everything in one POST form), a feedback box in
// the main content, and the real form's two empty plain fields.
const HEADER_SEARCH = `<header id="site-header"><form action="${P}/search" method="get" role="search"><label for="q">Search permits</label> <input id="q" name="q" type="search" placeholder="Search"></form></header>`;
const IN_FORM_SEARCH = `<div class="site-search"><input type="text" name="ctl00$SearchText" placeholder="Search permits" aria-label="Search permits"></div>`;
const FEEDBACK_BOX = `<div class="form-group"><label for="fb">Tell us how we did</label><textarea id="fb" name="feedback"></textarea></div>`;
const TWO_FIELDS = `<div class="form-group"><label for="addr">Site Address</label><input id="addr" name="addr" type="text"></div><div class="form-group"><label for="unit">Unit / Suite</label><input id="unit" name="unit" type="text"></div>`;
/** A page in the SmartGuide shell (its POST form wraps the content), with an optional header. */
const receipt = (title: string, body: string, inForm = "", header = "", nav = ""): string => {
  const html = shell({ title, content: `${body}${inForm}`, nav });
  return header ? html.replace("<body class=\"\">", `<body class="">${header}`) : html;
};
const AFTER: Record<string, () => string> = {
  receipt: () => plain("Request Received", `<h1>Request received</h1><p>Your application has been submitted. Confirmation number: PR-2026-00042.</p>`),
  filed: () => plain("My Requests", `<h1>My Requests</h1><form action="${P}/search" method="get"><label for="q">Search</label><input id="q" name="q" type="text"></form><p>Your request was received and is with a Permit Tech.</p>`),
  review: () => shell({
    title: "Review Your Application", action: `${P}/file`,
    content: `<p>Please review your application before submitting.</p><dl><dt>Permit Type</dt><dd>${SOLAR}</dd></dl>
      <div class="form-check"><input type="checkbox" id="cert" name="cert"><label for="cert">I certify that the information above is true and correct.</label></div>`,
    nav: `<button type="submit" name="t_s2" class="btn btn-primary ms-auto">Submit Application</button>`,
  }),
  error: () => shell({ title: "Project Information", method: "GET", action: `${P}/sg2`, content: `<p class="alert">There was an error processing your request.</p><div class="form-group"><label for="addr">Site Address</label><input id="addr" name="addr" type="text"></div>`, nav: PREV_NEXT }),
  same: () => infoPage(false),
  blank: () => `<!doctype html><html><head><title></title></head><body></body></html>`,
  // ROUND 2 — every after-click shape the round-1 verifiers found PASSING the old check ("a visible
  // field and no known filed phrase"): a receipt worded outside classifySubmissionText's vocabulary
  // beside a search box or a feedback box. Each must now be an incident.
  f_receipt_miss1: () => receipt("Request Received", `<p>Your solar permit request has been created and sent to a Permit Tech for intake. Request 26-104233-000-00-PR.</p>`, IN_FORM_SEARCH),
  f_receipt_miss2: () => receipt("Thank You", `<p>We've got your permit request. A Permit Tech will contact you by email.</p>`, "", HEADER_SEARCH),
  f_receipt_miss3: () => receipt("Request Sent", `<p>Your request was sent to the City on 10/16/2026.</p>`, FEEDBACK_BOX),
  f_receipt_miss4: () => receipt("In The Queue", `<p>Intake request #A-26-0042 is now in the queue.</p>`, "", HEADER_SEARCH),
  list: () => receipt("My Permits &amp; Requests", `<table><tr><th>Number</th><th>Type</th><th>Status</th></tr><tr><td>26-104455-RS</td><td>${SOLAR}</td><td>Submitted</td></tr></table>`, "", HEADER_SEARCH),
  reqnum: () => receipt("Request Received", `<p>We have received your request. Your request number is 26-104455-RS.</p>`, "", HEADER_SEARCH),
  confcolon: () => receipt("Done", `<p>Confirmation: PR-2026-00042</p>`, "", HEADER_SEARCH),
  status: () => receipt("Your Request", `<p>Status: Submitted</p>`, "", HEADER_SEARCH),
  iframe: () => receipt("Your Request", `<iframe title="receipt" style="width:600px;height:200px;border:0" srcdoc="&lt;p&gt;Your solar permit request has been created. Request 26-104233.&lt;/p&gt;"></iframe>`, "", HEADER_SEARCH),
  feedback: () => receipt("Complete", `<p>Thank you! Your request is complete.</p>`, FEEDBACK_BOX),
  feedback2: () => plain("Request Sent", `<h1>Request sent</h1><p>Your request was sent to the City.</p>
    <form id="feedbackForm" action="${P}/feedback" method="post"><label for="fbn">Your name</label><input id="fbn" name="fb_name" type="text"><label for="fbc">Comments</label><textarea id="fbc" name="fb_comments"></textarea><button type="submit" name="fb_send">Send</button></form>`),
  paid: () => receipt("Payment Received", `<p>Payment received. Receipt 26-104455. Amount paid $350.00.</p>`, "", HEADER_SEARCH),
  receiptRef: () => receipt("Thank You", `<p>Your reference is SR-2026-104455.</p>`, "", HEADER_SEARCH),
  confirmEdit: () => shell({ title: "Confirm And Send", action: `${P}/file`,
    content: `<p>Confirm and send. Press Submit Application to send it to the City.</p><div class="form-group"><label for="addr">Site Address</label><input id="addr" name="addr" type="text" value="1 Test St"></div>`,
    nav: `<button type="submit" name="t_s2" class="btn btn-primary ms-auto">Submit Application</button>` }),
  confirmCertify: () => shell({ title: "Send To The City", action: `${P}/file`,
    content: `<div class="form-group"><label for="addr">Site Address</label><input id="addr" name="addr" type="text" value="1 Test St"></div><div class="form-check"><input type="checkbox" id="cert" name="cert"><label for="cert">I certify that the information above is true and correct.</label></div>`,
    nav: `<button type="submit" name="t_s2" class="btn btn-primary ms-auto">Send to City</button>` }),
  // A receipt that offers to start ANOTHER request (a real two-field form): only the new number
  // gives it away — the token rule on its own.
  newreq: () => shell({ title: "Request Received", action: `${P}/sg2`,
    content: `<p>Thanks — request 26-104233 is with a Permit Tech.</p><p>Start another request:</p>${TWO_FIELDS}`, nav: `<button type="submit" name="t_n2" class="btn btn-primary ms-auto">Next</button>` }),
  // A form skeleton a script swaps for a receipt 1 s after load: the second reading catches it.
  late: () => shell({ title: "Project Information", action: `${P}/sg2`, content: `<div id="swap">${TWO_FIELDS}</div>`,
    nav: `<button type="submit" name="t_n2" class="btn btn-primary ms-auto">Next</button>`,
    script: `<script>setTimeout(function () { document.getElementById('swap').innerHTML = '<p>Your solar permit request has been created and sent. Request 26-104233-000-00-PR.</p>'; document.getElementById('navigation').innerHTML = ''; }, 1000);</script>` }),
  // THE POSITIVE CONTROL: the real application form — two empty plain fields in the SmartGuide form,
  // a header search box beside it (never counted), and the footer's phone number, which the
  // information page carries too (not new). No incident; the walk goes on.
  form: () => receipt("Project Information", TWO_FIELDS, "", HEADER_SEARCH, `<button type="submit" name="t_n2" formaction="${P}/sg2" class="btn btn-primary ms-auto">Next</button>`),
};

const hits: Array<{ method: string; url: string; names: string[]; mode: string }> = [];
const modeOf = (q: http.IncomingMessage): string => /(?:^|;\s*)mode=([A-Za-z0-9_]+)/.exec(String(q.headers.cookie || ""))?.[1] ?? "capture";
const server = http.createServer((q, r) => {
  const chunks: Buffer[] = [];
  q.on("data", (c: Buffer) => chunks.push(c));
  q.on("end", () => {
    const url = q.url || "/";
    const method = String(q.method || "GET").toUpperCase();
    const mode = modeOf(q);
    const names = method === "GET" ? [] : bodyNamesOf(String(q.headers["content-type"] || ""), Buffer.concat(chunks));
    hits.push({ method, url, names, mode });
    const pathOnly = url.split("?")[0];
    const send = (html: string): void => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(html); };
    if (pathOnly === `${P}/home`) return send(homePage());
    if (pathOnly === `${P}/apply`) return send(applyPage(mode));
    if (pathOnly === `${P}/info`) return send(infoPage(mode === "drift"));
    if (pathOnly === `${P}/sg` && method === "POST" && names.includes(NEXT)) {
      r.writeHead(303, { Location: `${P}/after` });
      return r.end();
    }
    // An unknown mode is never silently another mode's page (round 2: a cookie parser that cut
    // "f_receipt_miss1" to "f" served the old receipt page).
    if (pathOnly === `${P}/after`) return send(AFTER[mode] ? AFTER[mode]() : plain("Unknown mode", `<h1>UNKNOWN MODE</h1>`));
    return send(plain("Elsewhere", `<h1>${pathOnly.replace(/[<>&"]/g, "")}</h1><p>Automation must never land here.</p>`));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch();

interface Walk {
  ok: boolean; message: string; stopReason?: string; reachedReview?: boolean;
  notes: string[]; finals: string[]; locks: string[];
  hits: Array<{ method: string; url: string; names: string[] }>;
  candidate?: InfoPageCandidateCapture; passed?: Array<{ passId: string; where: string }>; incidents?: InfoPageIncident[];
  secs: number;
}
const walk = async (mode: string, entries: VerifiedInfoPage[], permitType = "structural"): Promise<Walk> => {
  const ctx = await browser.newContext();
  await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  await ctx.addCookies([{ name: "mode", value: mode, url: base }]);
  const pw = await ctx.newPage();
  await pw.goto(`${base}${P}/home`);
  const plan: LearnPlanner = async () => ({ fills: [], atReview: false });
  const a = new AutoLearnAdapter("Incident Walk", plan, { maxPages: 6, budgetMs: 180_000, infoPagePasses: entries, infoPagePriorProgress: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (a as any).page = pw;
  const locks: string[] = [];
  const spy = setInterval(() => {
    const bs = backstopFor(pw) as (ReturnType<typeof backstopFor> & { __spied?: boolean }) | null;
    if (!bs || bs.__spied) return;
    const orig = bs.lockReview.bind(bs);
    bs.lockReview = (why: string) => { locks.push(why); orig(why); };
    bs.__spied = true;
  }, 2);
  const t0 = Date.now();
  let r: Record<string, unknown>;
  try {
    r = await a.learn({ portalUrl: `${base}${P}/home` } as never,
      { projectAddress: "1 Test St, Springfield, IL, 62701", city: "Springfield", state: "IL", zip: "62701", homeownerName: "T", permitType } as never) as unknown as Record<string, unknown>;
  } catch (e) { r = { ok: false, message: `threw: ${String(e)}`, steps: [] }; }
  clearInterval(spy);
  await ctx.close().catch(() => null);
  const steps = Array.isArray(r.steps) ? r.steps as Array<{ note?: string; isFinalSubmit?: boolean }> : [];
  return {
    ok: r.ok === true, message: String(r.message ?? ""), stopReason: r.stopReason as string | undefined, reachedReview: r.reachedReview as boolean | undefined,
    notes: steps.map((s) => String(s.note ?? "")), finals: steps.filter((s) => s.isFinalSubmit).map((s) => String(s.note ?? "")), locks,
    hits: hits.filter((h) => h.mode === mode).map(({ method, url, names }) => ({ method, url, names })),
    candidate: r.infoPageCandidate as InfoPageCandidateCapture | undefined, passed: r.infoPagePassed as Walk["passed"], incidents: r.infoPageIncidents as InfoPageIncident[] | undefined,
    secs: Math.round((Date.now() - t0) / 1000),
  };
};
const posts = (w: Walk): string[] => w.hits.filter((h) => h.method !== "GET").map((h) => `${h.method} ${h.url} [${h.names.join(",")}]`);

// ------------------------------------------------------------------------------------------
// The capture: no verified page — held exactly as on main, handed back as a candidate.
// ------------------------------------------------------------------------------------------
const cap = await walk("capture", []);
check("capture: the walk entered, chose the Solar tile and reached the information page",
  cap.notes.some((n) => /^application entry: Apply For A Permit/.test(n)) && cap.notes.includes(`permit type: ${SOLAR}`), JSON.stringify(cap.notes));
check("capture: with no verified page the Next is HELD (nothing posted) and the page comes back as a candidate with its held request",
  posts(cap).length === 0 && !!cap.candidate && !!cap.candidate.observed && cap.stopReason === "backstop_abort", JSON.stringify({ posts: posts(cap), stop: cap.stopReason, cand: !!cap.candidate }));
const entry: VerifiedInfoPage | null = cap.candidate
  ? { id: "pass-incident", verifiedAt: "2026-10-16T12:00:00.000Z", ...verifiedInfoPageFromCandidate({ identityVersion: cap.candidate.identityVersion, identitySha256: cap.candidate.identitySha256, digest: cap.candidate.digest as InfoPageDigest, prefix: cap.candidate.prefix }) }
  : null;
check("premise: a person's verification of the candidate is the entry every later walk receives", !!entry);

// ------------------------------------------------------------------------------------------
// The walks, three at a time.
// ------------------------------------------------------------------------------------------
// Round 2 adds every shape the verifiers found passing the old check, each pinned as an incident
// (and, where one rule alone catches it, that rule named), and the positive control (form).
const ROUND2: Record<string, RegExp> = {
  f_receipt_miss1: /no application form/, f_receipt_miss2: /no application form/, f_receipt_miss3: /no application form/, f_receipt_miss4: /no application form/,
  list: /no application form/, reqnum: /no application form/, confcolon: /no application form/, status: /no application form/,
  iframe: /frame\(s\) the reading cannot see into/, feedback: /no application form/, feedback2: /no application form/, paid: /no application form/,
  receiptRef: /no application form/, confirmEdit: /no application form|submit-, filing- or pay-worded control/, confirmCertify: /no application form/,
  newreq: /number that was not on the information page/, late: /./,
};
const AFTER_MODES = ["receipt", "filed", "review", "error", "same", "blank", ...Object.keys(ROUND2)];
const results: Record<string, Walk> = {};
const queue: Array<[string, string]> = [...AFTER_MODES.map((m) => [m, "structural"] as [string, string]), ["form", "structural"], ["drift", "structural"], ["tileb", "structural"]];
await Promise.all(Array.from({ length: 4 }, async () => {
  while (queue.length) {
    const [mode, permitType] = queue.shift()!;
    results[mode] = await walk(mode, entry ? [entry] : [], permitType);
  }
}));

for (const mode of AFTER_MODES) {
  const w = results[mode];
  const p = posts(w);
  check(`after [${mode}]: the verified Next passed ONCE (its own multipart POST, carrying the submitter) and nothing else was sent`,
    p.length === 1 && p[0].startsWith(`POST ${P}/sg [`) && p[0].includes(NEXT) && (w.passed ?? []).length === 1, JSON.stringify({ posts: p, passed: w.passed }));
  check(`after [${mode}]: an INCIDENT — the walk stopped (info_page_incident), the pass reported for withdrawal (phase after)`,
    w.ok === false && w.stopReason === "info_page_incident" && /^STOPPED AFTER A VERIFIED INFORMATION PAGE/.test(w.message)
    && (w.incidents ?? []).length === 1 && w.incidents![0].passId === "pass-incident" && w.incidents![0].phase === "after",
    JSON.stringify({ ok: w.ok, stop: w.stopReason, incidents: w.incidents, message: w.message.slice(0, 300) }));
  check(`after [${mode}]: nothing is recorded as filed — no final submit recorded, review not reached, the sticky lock armed`,
    w.finals.length === 0 && w.reachedReview !== true && w.locks.some((l) => /did not read as an unfiled form/.test(l)), JSON.stringify({ finals: w.finals, reachedReview: w.reachedReview, locks: w.locks }));
  if (ROUND2[mode]) {
    check(`after [${mode}] (round 2): the incident names the rule that caught it`, (w.incidents?.[0]?.why ?? []).some((x) => ROUND2[mode].test(x)), JSON.stringify(w.incidents?.[0]?.why ?? []));
  }
  lines.push(`  note - [${mode}] ${w.secs}s: ${(w.incidents?.[0]?.why ?? []).join("; ").slice(0, 200)}`);
}

{
  // THE POSITIVE CONTROL (round 2): the real application form after the verified Next — two empty
  // plain fields in the SmartGuide form, a header search box beside it, and the footer phone number
  // the information page carries too. Positive evidence: no incident, no lock, the walk goes on.
  const w = results.form;
  const p = posts(w);
  check("after [form] (round 2 positive control): the verified Next passed ONCE",
    p.length >= 1 && p[0].startsWith(`POST ${P}/sg [`) && p[0].includes(NEXT) && (w.passed ?? []).length === 1, JSON.stringify({ posts: p, passed: w.passed }));
  check("after [form] (round 2 positive control): NO incident — the page after the click read as an unfiled application form (a search box and a number both pages carry do not count against it)",
    w.stopReason !== "info_page_incident" && !(w.incidents ?? []).length && !w.locks.some((l) => /did not read as an unfiled form/.test(l)),
    JSON.stringify({ ok: w.ok, stop: w.stopReason, incidents: w.incidents, locks: w.locks, message: w.message.slice(0, 300) }));
  lines.push(`  note - [form] ${w.secs}s`);
}

{
  const w = results.drift;
  check("before [drift]: the verified page with one sentence added is HELD exactly as on main — nothing posted, no pass used",
    posts(w).length === 0 && !(w.passed ?? []).length && w.stopReason === "backstop_abort", JSON.stringify({ posts: posts(w), passed: w.passed, stop: w.stopReason }));
  check("before [drift]: an INCIDENT on the pass (phase before) naming the changed text, and the page as it is now is the fresh candidate",
    (w.incidents ?? []).length === 1 && w.incidents![0].passId === "pass-incident" && w.incidents![0].phase === "before" && w.incidents![0].why.some((x) => /text/.test(x))
    && !!w.candidate && w.candidate.identitySha256 !== entry?.identitySha256 && !!w.candidate.observed,
    JSON.stringify({ incidents: w.incidents, cand: w.candidate?.identitySha256?.slice(0, 12) }));
  check("before [drift]: the message says the verified page changed and its verification is withdrawn",
    /^HELD AT AN INFORMATION PAGE THAT CHANGED SINCE A PERSON VERIFIED IT/.test(w.message) && /withdrawn/.test(w.message), w.message.slice(0, 300));
  lines.push(`  note - [drift] ${w.secs}s`);
}
{
  const w = results.tileb;
  check("before [tileb] premise: the walk reached the SAME page through the other tile",
    w.notes.includes(`permit type: ${TILE_B}`) && w.hits.some((h) => h.url === `${P}/info`), JSON.stringify(w.notes));
  check("before [tileb]: HELD — nothing posted, no pass used — and an incident naming the different steps",
    posts(w).length === 0 && !(w.passed ?? []).length && (w.incidents ?? []).some((i) => i.passId === "pass-incident" && i.phase === "before" && i.why.some((x) => /different steps/.test(x))),
    JSON.stringify({ posts: posts(w), passed: w.passed, incidents: w.incidents, message: w.message.slice(0, 200) }));
  lines.push(`  note - [tileb] ${w.secs}s`);
}

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
console.log("\ninfoPageIncident.dom.smoke");
for (const l of lines) (l.includes("FAIL - ") ? console.error : console.log)(l);
if (failures) { console.error(`\n${failures}/${total} infoPageIncident.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log(`\nAll ${total}/${total} infoPageIncident.dom.smoke checks passed.`);
process.exit(0);
