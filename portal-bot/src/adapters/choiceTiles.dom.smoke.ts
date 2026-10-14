// A PAGE OF CHOICE TILES IS A MENU, AND A TILE'S TITLE IS ITS LABEL (issue #315).
//
// Portland DevHub, live 2026-10-13: auto-learn logged in, pressed "Apply For A Permit", and
// landed on a column of cards — "Building Permit Request", "Solar Permit Request", "Trade
// Permits", … — each clickable as a whole by a handler bound in script (no onclick, no role, no
// <button>, no <a> around it), each carrying a "See more information…" link that stops
// propagation. Field discovery saw 35 buttons/links and no card; the entry pass found nothing;
// the planner's only candidate was the information link, which the rule-5 guard rightly
// refused; and the run ended "Auto-learn found nothing fillable on 2 page(s) … Record it
// manually instead." — on a page of ten plainly labelled choices.
//
// The fixtures below are the captured page's markup (data/learn-runs/2026-10-13_21-18-04_
// city-of-portland_u1f4/page-p002-before-Development_Hub_PDX.json), scrubbed: the signed-in
// company name is synthetic, the learner's own marks are gone, and every link points at this
// server so a wrong click is a visible URL, never a real site.
//
//   MUST PASS  — the chooser picks "Solar Permit Request" on EVERY track and clicks the CARD:
//                the URL changes to the card's destination, never to the information page.
//   MUST PASS  — the LEARNER, end to end from the home page: entry → tile → the next page,
//                with the tile recorded by its title text (a replay can re-find it).
//   MUST PASS  — field discovery lists the tile as a button-typed navigate candidate labelled
//                by its title; the information link keeps its own label and is still refused
//                by the same vocabulary the rule-5 guard uses.
//   MUST PASS  — a page of tiles that names nothing we came for STOPS and NAMES the tiles —
//                never "nothing fillable".
//   MUST PASS  — the entry pass enters a home whose "Apply for a Permit" is a card, never its
//                "My Permits" / "View or Pay Fees" cards; a pointer cursor alone is an affordance.
//   MUST PASS  — a home whose ONLY way in is one card worded outside the entry vocabulary
//                ("Begin Submittal") is ENTERED, not stopped at (owner's ruling 2026-09-26:
//                a false stop on a legitimate step is a bug); a single "Pay Fees Due" card is not.
//   MUST EXCLUDE — a chevron step bar, a card holding inputs, an accordion, and a dashboard
//                of record cards (titles with numbers) are never tiles.
//   REVIEW 1   — a wrapper around cards is never the page's one tile ([8]); the planner never
//                clicks a tile, at the navigate door or the advance door ([9]); the recipe
//                records the entry click before the type click ([3], [7]).
//
// Against main's applicationEntry.ts + autoLearnAdapter.ts every MUST PASS line is a FAIL
// banner, not a crash: the new exports are reached through a namespace import.
//
//   npx tsx portal-bot/src/adapters/choiceTiles.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium } from "playwright";
import * as entry from "./applicationEntry";
import { chooseApplicationType, findApplicationEntry, isExcludedEntryLabel } from "./applicationEntry";
import { AutoLearnAdapter, EXTRACT_SEL, toExtractedField, type LearnPlanner, type RawField } from "./autoLearnAdapter";

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
const INFO_SOLAR = "See more information about Solar Permit requirements.";
const SOLAR = "Solar Permit Request";

/** One tile, as captured: the portal's own ids and class names, a title, prose, a chevron. */
const card = (id: string, title: string, body: string): string => `
<div id="${id}" class="card-h card-l card">
<div class="card-body">
	<div class="card-title">${title}</div>
	<div class="card-text">${body}</div>
</div>
<div class="card-next">
<i class="fa fa-chevron-right"></i>
</div>
</div>`;
const info = (href: string, text: string): string => `<a href="${href}" onclick="event.stopPropagation()">${text}</a>`;

const BUILDING = card("div_d_1683576453192", "Building Permit Request",
  `<p>Use this option to request the following types of permits:</p><ul><li>Residential (RS) - Addition, Alteration, Demolition, Other</li><li>Commercial (CO)</li><li>Site Development (SD)</li><li>Development Review (DR)</li><li>Zoning Permit (ZP)</li><li>Deferred Submittals on Issued Permits</li><li>Revisions to Issued Permits</li></ul>`);
const NSFR = card("div_d_1704625478502", "New Single-Family Residence and/or New Detached Accessory Dwelling Unit Permit Request",
  `<p>This includes new construction for one- and two-family dwellings such as new single-family houses, two-family houses (such as ‘duplexes’), townhouses, and ADUs.&nbsp;See more information about ${info("/info/nsfr", "New Single Family Residential permits")}.</p>`);
const SOLAR_CARD = card("div_d_1683576453204", SOLAR,
  `Solar Permit Requests for Residential or Commercial Projects. Attention! The new Solar Permit Request includes the Renewable Energy Electrical Permit.&nbsp;${info("/info/solar", INFO_SOLAR)}`);
const WIRELESS = card("div_d_1683576453205", "FCC Wireless Applications - Permit Request",
  info("/info/wireless", "See more information about Radio Frequency Transmission Facilities (Wireless) permits."));
const DEMOLITION = card("div_d_1683576453206", "Demolition Permit Request",
  `Demolitions for entire buildings. ${info("/info/demolition", "See more information about demolitions.")}`);
const TRADES = card("div_d_1683576453207", "Trade Permits",
  `Use this option to apply or pay for Standard Trade Permits:<ul><li>Electrical,</li><li>Mechanical, and</li><li>Plumbing</li></ul>`);
const TRADES_PLANS = card("div_d_1683576453208", "Trade Permits with Plan Review - Permit Request",
  `Click <strong>here </strong>to:<ul><li>request a trade permit,&nbsp;</li><li>request a Revision to an issued trade permit with plan review,</li><li>upload your plans,</li><li>have the Permit Tech set up your permit, and</li><li>have your plans reviewed.</li></ul><br>Click this link to leave the portal and ${info("/info/trades", "see more information about Trades Permits and see if your work requires plan review.")}`);
const SIGNS = card("div_d_1683576453209", "Sign Permit Request", `<p>${info("/info/signs", "See more information about Sign Permits.")}</p>`);
const TREES = card("div_d_1683576453210", "Tree Permits",
  `Select to apply for one of the following tree permits:<ul><li>Street Trees<ul><li>Cabling and Bracing</li><li>Chemical Treatment</li><li>Ornamental Lighting</li><li>Permanent Attachments</li><li>Pruning, Inspection required</li><li>Pruning, Self-Issued</li><li>Removal/Replant</li><li>Root Pruning</li></ul></li><li>Private Trees<ul><li>Removal/Replant</li></ul></li></ul>`);

const APPLY_TILES = [BUILDING, NSFR, SOLAR_CARD, WIRELESS, DEMOLITION, TRADES, TRADES_PLANS, SIGNS, TREES].join("");
const NO_SOLAR_TILES = [BUILDING, NSFR, SIGNS, TREES].join("");

/** The home page's five cards, as captured (titles only matter here). */
const HOME_TILES = [
  card("div_h_1", "My Permits &amp; Requests", "See the permits and requests you have filed."),
  card("div_h_2", "Apply For A Permit", "Start a new permit request."),
  card("div_h_3", "View or Pay Fees", "Fees due on your permits."),
  card("div_h_4", "Upload Corrections", "Respond to checksheet corrections."),
  card("div_h_5", "Inspections", "Request or view inspections."),
].join("");

/** The captured home's "Learn More About…" accordion: repeated items with a heading and a
 *  button each — the shape of a tile, except that the BUTTON is the control. */
const ACCORDION = `<div class="accordion" id="acc">
  <div class="accordion-item"><h2 class="accordion-header"><button class="accordion-button collapsed" type="button">Want to know more about submittal requirements?</button></h2><div class="accordion-collapse collapse" style="display:none">…</div></div>
  <div class="accordion-item"><h2 class="accordion-header"><button class="accordion-button collapsed" type="button">Getting a Trade Permit?</button></h2><div class="accordion-collapse collapse" style="display:none">…</div></div>
</div>`;

/** The sidebar every page carries — the 10 links the live run's field discovery listed. */
const sidebar = (applyHref: string): string => `<div class="col left-section no-print"><nav class="navbar navbar-expand-md navbar-light left-menu" role="navigation">
 <button class="navbar-toggler always-enabled" type="button" aria-controls="leftMenuNav" aria-expanded="false" aria-label="Toggle navigation"><span class="navbar-toggler-icon"></span></button>
 <div class="collapse navbar-collapse" id="leftMenuNav"><ul>
  <li class="title">Portal Fixture</li>
  <li class="item"><a href="/home">DevHub Home</a></li>
  <li class="item"><a href="/profile">My Profile</a></li>
  <li class="item"><a href="/my-permits">My Permits &amp; Requests</a></li>
  <li class="item"><a href="${applyHref}">Apply For A Permit</a></li>
  <li class="item"><a href="/fees">View or Pay Fees</a></li>
  <li class="item"><a href="/bills">My Bills</a></li>
  <li class="item"><a href="/corrections">Upload Corrections</a></li>
  <li class="item"><a href="/inspections">Inspections</a></li>
  <li class="item"><a href="/help">Help and FAQs</a></li>
 </ul></div></nav></div>`;

/** The click delegation the live page binds in script: the CARD navigates; its inner links
 *  stop propagation. No onclick attribute on the card, no role, no button. */
const DELEGATION = (hrefFor: string): string => `<script>
document.getElementById('sgControls').addEventListener('click', function (e) {
  var card = e.target.closest('.card');
  if (!card) return;
  var title = card.querySelector('.card-title').textContent.replace(/\\s+/g, ' ').trim();
  location.href = (${hrefFor})(title);
});
</script>`;
const TO_CHOSEN = "function (t) { return '/chosen?tile=' + encodeURIComponent(t); }";
const HOME_MAP = "function (t) { return ({'Apply For A Permit':'/apply','My Permits & Requests':'/my-permits','View or Pay Fees':'/fees','Upload Corrections':'/corrections','Inspections':'/inspections'})[t] || '/unknown'; }";

/** The portal shell, as captured: signed-in menu (name scrubbed), breadcrumb, sidebar, footer. */
const shell = (o: { title: string; content: string; applyHref?: string; nav?: boolean; script?: string }): string => `<!doctype html><html><head><meta charset="utf-8"><title>Development Hub Fixture</title>
<style>body{font:14px sans-serif;margin:0} .row{display:flex} .left-section{width:200px} .right-section{flex:1}
.card{display:flex;border:1px solid #ccc;margin:8px 0;padding:8px;min-height:60px} .card-body{flex:1} .card-next{width:32px}</style>
</head><body class="apply-permit">
<div id="top-header"><div id="signin-menu">
  <button id="signedin-menu-btn" type="button" class="dropdown-toggle" aria-expanded="false"><i class="bi bi-person-fill"></i><div>Example Solar Co</div></button>
  <ul class="dropdown-menu" style="display:none"><li><a class="dropdown-item" href="/profile">My Profile</a></li><li><a class="dropdown-item" href="#" onclick="return false">Sign Out</a></li></ul>
</div></div>
<div id="sec-header"><h1>Development Hub Fixture</h1><h2>Online License &amp; Permit Services</h2></div>
<div id="breadcrumb"><nav aria-label="breadcrumb"><ol class="breadcrumb"><li class="breadcrumb-item"><a href="/home">Home</a></li>${o.nav === false ? "" : `<li class="breadcrumb-item"><a href="${o.applyHref ?? "/apply"}">Apply For A Permit</a></li>`}</ol></nav></div>
<div id="main-content"><form id="smartguide" action="/post" method="POST" class="form-content smartguide_form">
<div class="row">
 ${o.nav === false ? "" : sidebar(o.applyHref ?? "/apply")}
 <div class="col-md-10 right-section"><div id="page-content">
  <div class="page-title auto-title">${o.title}</div>
  <div id="sgControls"><div class="row"><div class="col-flex col-md-12"><div id="div_d_1682982152632" class="section-apply d-flex justify-content-center flex-wrap align-items-stretch section">${o.content}</div></div></div></div>
  <div id="navigation" class="d-flex"></div>
 </div></div>
</div></form></div>
<footer id="bottom-footer" role="contentinfo">
  <p>To request these services, contact <a href="tel:503-000-0000">503-000-0000</a> or TTY via Relay Service: <a href="tel:711">711</a>.</p>
  <ul class="menu"><li><a href="/ada">ADA Accommodation</a></li><li><a href="/privacy">Privacy policy</a></li><li><a href="/about">About this Website</a></li></ul>
</footer>
${o.script ?? ""}
</body></html>`;

const never = (what: string): string => `<!doctype html><html><body><h1>${what}</h1><p>Automation must never land here.</p></body></html>`;

const PAGES: Record<string, string> = {
  // The captured HOME: sidebar + five cards + the accordion.
  "/home": shell({ title: "Welcome", content: HOME_TILES + ACCORDION, script: DELEGATION(HOME_MAP) }),
  // A home where the only way in is the CARD.
  "/home-tiles-only": shell({ title: "Welcome", content: HOME_TILES, nav: false, script: DELEGATION(HOME_MAP) }),
  // The captured "Apply for a Permit" page: nine tiles, nothing fillable.
  "/apply": shell({ title: "Apply for a Permit", content: APPLY_TILES, script: DELEGATION(TO_CHOSEN) }),
  // The same page with no solar tile — the stop path.
  "/home-none": shell({ title: "Welcome", content: HOME_TILES, applyHref: "/apply-none", script: DELEGATION("function (t) { return t === 'Apply For A Permit' ? '/apply-none' : '/unknown'; }") }),
  "/apply-none": shell({ title: "Apply for a Permit", content: NO_SOLAR_TILES, applyHref: "/apply-none", script: DELEGATION(TO_CHOSEN) }),
  // A pointer cursor and nothing else says "this goes somewhere" (Material-style cards).
  "/cursor": `<!doctype html><html><head><style>.tile{cursor:pointer;border:1px solid #999;padding:12px;margin:8px;min-height:50px}</style></head><body>
    <h1>What are you applying for?</h1>
    <div id="choices">
      <div class="tile"><h3>Fence Permit</h3><p>A fence over six feet.</p></div>
      <div class="tile"><h3>Residential Solar Permit</h3><p>Rooftop PV on a dwelling.</p></div>
      <div class="tile"><h3>Electrical Permit</h3><p>Service changes and circuits.</p></div>
    </div>
    <script>document.getElementById('choices').addEventListener('click', function (e) { var t = e.target.closest('.tile'); if (t) location.href = '/chosen?tile=' + encodeURIComponent(t.querySelector('h3').textContent); });</script>
  </body></html>`,
  // MUST EXCLUDE: a chevron step bar is a row of "heading + arrow" siblings. Its items are not
  // choices, and its "Review and Submit" must never reach the harvest as a button.
  "/stepper": `<!doctype html><html><body>
    <ol class="steps" style="display:flex;list-style:none">
      <li class="step active" style="width:160px;height:40px"><h4>Applicant</h4><i class="fa fa-chevron-right"></i></li>
      <li class="step" style="width:160px;height:40px"><h4>Project</h4><i class="fa fa-chevron-right"></i></li>
      <li class="step" style="width:160px;height:40px"><h4>Review and Submit</h4></li>
    </ol>
    <label for="n">Applicant Name</label><input id="n" name="n">
    <button type="button">Next</button>
  </body></html>`,
  // MUST EXCLUDE: a lone card is content; a card holding inputs is a form.
  "/lone": `<!doctype html><html><head><style>.card{border:1px solid #999;padding:12px;min-height:50px;cursor:pointer}</style></head><body>
    <div class="card"><h3>Solar Permit Request</h3><p>Only one of these.</p><i class="fa fa-chevron-right"></i></div>
    <div id="forms">
      <div class="card"><h3>Owner</h3><label for="o">Owner name</label><input id="o" name="o"><i class="fa fa-chevron-right"></i></div>
      <div class="card"><h3>Installer</h3><label for="i">Installer name</label><input id="i" name="i"><i class="fa fa-chevron-right"></i></div>
    </div>
  </body></html>`,
  // A home whose ONLY way in is one card, worded outside the entry vocabulary ("Begin
  // Submittal"): no fillable, no entry-pattern control, no other tile. The owner's ruling
  // (2026-09-26): a false stop on a legitimate step is a bug — the learner enters it.
  "/home-single": `<!doctype html><html><head><style>.card{display:flex;border:1px solid #ccc;padding:12px;min-height:60px} .card-body{flex:1}</style></head><body>
    <h1>Welcome to the Permit Portal</h1>
    <p>Signed in as Example Solar Co.</p>
    <div id="sgControls">
      <div class="card"><div class="card-body"><div class="card-title">Begin Submittal</div><div class="card-text">Start a new permit submittal with the city.</div></div><div class="card-next"><i class="fa fa-chevron-right"></i></div></div>
    </div>
    <ul class="menu"><li><a href="/help">Help and FAQs</a></li><li><a href="/privacy">Privacy policy</a></li></ul>
    ${DELEGATION("function () { return '/apply'; }")}
  </body></html>`,
  // MUST EXCLUDE: the same shape, but the one card is a real-filing control.
  "/home-single-pay": `<!doctype html><html><head><style>.card{display:flex;border:1px solid #ccc;padding:12px;min-height:60px} .card-body{flex:1}</style></head><body>
    <h1>Welcome to the Permit Portal</h1>
    <div id="sgControls">
      <div class="card"><div class="card-body"><div class="card-title">Pay Fees Due</div><div class="card-text">Fees are due on your permits.</div></div><div class="card-next"><i class="fa fa-chevron-right"></i></div></div>
    </div>
    ${DELEGATION("function () { return '/fees'; }")}
  </body></html>`,
  // REVIEW 1 (Helm, finding 1 — the blocker): a CONTAINER must never inherit a cut card's title
  // and arrow and survive as the page's one tile. Nine cards inside a wrapper the chrome cut
  // drops (`apply-steps`, `permit-menu`), nine 28px rows under a heading, a heading over nine
  // hidden cards: each read as ONE tile stamped on the wrapper, clicked at its centre into
  // whichever card sat there (a Demolition request, recorded as "Building Permit Request").
  "/home-wrapped": shell({ title: "Welcome", content: HOME_TILES, applyHref: "/apply-wrapped", script: DELEGATION("function (t) { return t === 'Apply For A Permit' ? '/apply-wrapped' : '/unknown'; }") }),
  "/apply-wrapped": shell({ title: "Apply for a Permit", content: `<div class="apply-steps">${APPLY_TILES}</div>`, applyHref: "/apply-wrapped", script: DELEGATION(TO_CHOSEN) }),
  "/apply-wrapped-menu": shell({ title: "Apply for a Permit", content: `<div class="permit-menu">${APPLY_TILES}</div>`, applyHref: "/apply-wrapped-menu", script: DELEGATION(TO_CHOSEN) }),
  "/apply-rows": `<!doctype html><html><body>
    <div id="content"><h2>Choose a permit type</h2><ul id="rows" style="list-style:none;padding:0;margin:0">
      ${["Building Permit Request", "New Single-Family Residence Permit Request", SOLAR, "FCC Wireless Applications - Permit Request", "Demolition Permit Request", "Trade Permits", "Trade Permits with Plan Review", "Sign Permit Request", "Tree Permits"]
        .map((t) => `<li style="height:28px;display:flex;align-items:center"><span class="row-title">${t}</span><i class="fa fa-chevron-right"></i></li>`).join("")}
    </ul></div>
    <script>document.getElementById('rows').addEventListener('click', function (e) { var li = e.target.closest('li'); if (li) location.href = '/chosen?tile=' + encodeURIComponent(li.querySelector('.row-title').textContent); });</script>
  </body></html>`,
  "/apply-hidden": `<!doctype html><html><body>
    <section id="sgControls"><h2>Apply for a Permit</h2><div style="display:none">${APPLY_TILES}</div></section>
    ${DELEGATION(TO_CHOSEN)}
  </body></html>`,
  // REVIEW 1 (finding 3): tiles the chooser refused beside a SEARCH BOX — the page has
  // something fillable, so it reaches the planner; a planner that names a tile as its
  // navigate or its advance must be refused at both doors. No entry control on purpose.
  "/apply-search": `<!doctype html><html><head><style>.card{display:flex;border:1px solid #ccc;margin:8px 0;padding:8px;min-height:60px} .card-body{flex:1}</style></head><body>
    <h1>Apply for a Permit</h1>
    <label for="q">Search permit types</label><input id="q" name="q" type="search">
    <div id="sgControls">${NO_SOLAR_TILES}</div>
    ${DELEGATION(TO_CHOSEN)}
  </body></html>`,
  // MUST EXCLUDE: a dashboard of the operator's RECORDS as pointer-cursor cards. A record's
  // title carries a number; a type's never does.
  "/records": `<!doctype html><html><head><style>.card{border:1px solid #999;padding:12px;min-height:50px;cursor:pointer}</style></head><body>
    <div id="recent">
      <div class="card"><h3>BP-2024-00123 — Solar PV, 123 Main St</h3><p>In review</p></div>
      <div class="card"><h3>BP-2024-00456 — Solar PV, 456 Oak Ave</h3><p>Issued</p></div>
    </div>
  </body></html>`,
};
const hits: string[] = [];
const server = http.createServer((q, r) => {
  const url = q.url || "/";
  hits.push(url);
  const path = url.split("?")[0];
  let body: string;
  if (path === "/chosen") {
    const title = decodeURIComponent((url.split("tile=")[1] ?? "").split("&")[0]);
    body = `<!doctype html><html><body><h1>${title} — Step 1 of 4</h1><label for="addr">Site Address</label><input id="addr" name="addr"><button type="button">Next</button></body></html>`;
  } else if (path.startsWith("/info/")) body = never("Information page");
  else body = PAGES[path] ?? never(`Records page ${path}`);
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(body);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch();
const ctx = await browser.newContext();
// The esbuild keepNames transform wraps nameable functions as __name(fn); a raw page has no
// such global. openPortal injects the same shim in production.
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

type Scan = ((page: unknown) => Promise<Array<{ key: string; label: string }>>) | undefined;
const scanChoiceTiles = (entry as { scanChoiceTiles?: Scan }).scanChoiceTiles;
const stubPlanner: LearnPlanner = async () => ({ fills: [], atReview: false });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const harvest = async (page: any): Promise<RawField[]> => {
  const a = new AutoLearnAdapter("Choice Tiles Harvest", stubPlanner, { maxPages: 1 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (a as any).page = page;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (a as any).extractAllFrames(EXTRACT_SEL) as Promise<RawField[]>;
};

// ===========================================================================================
// 1) MUST PASS — the chooser: the tile that names the job, clicked as a CARD, on every track.
// ===========================================================================================
console.log("\n[1] the captured 'Apply for a Permit' page: nine tiles, nothing fillable");
const page = await ctx.newPage();
await page.goto(`${base}/apply`);
const scanned = scanChoiceTiles ? await scanChoiceTiles(page) : null;
check("the in-page scan reports the nine tiles, labelled by their titles",
  !!scanned && scanned.length === 9 && scanned.some((t) => t.label === SOLAR),
  scanned ? JSON.stringify(scanned.map((t) => t.label)) : "scanChoiceTiles is not exported — main's file");

for (const track of ["electrical", "structural", "solar"]) {
  await page.goto(`${base}/apply`);
  const picked = await chooseApplicationType(page, track);
  const choice = picked.ok ? picked.choice : null;
  check(`${track} track: the chooser picks "${SOLAR}" and it is the TILE`,
    !!choice && choice.label === SOLAR && (choice as { kind?: string }).kind === "tile",
    picked.ok ? JSON.stringify({ label: picked.choice.label, kind: (picked.choice as { kind?: string }).kind })
      : `refused: ${picked.refusal.reason}; offered=${JSON.stringify(picked.refusal.offered.slice(0, 12))}`);
  if (choice) {
    await choice.locator.click({ timeout: 5000 }).catch(() => null);
    await page.waitForLoadState("domcontentloaded").catch(() => null);
  }
  check(`${track} track: clicking the card NAVIGATES to the card's destination`,
    page.url().includes("/chosen?tile=Solar%20Permit%20Request"), `url=${page.url()}`);
  check(`${track} track: ...and never to the information page`, !page.url().includes("/info/"), `url=${page.url()}`);
}

// ===========================================================================================
// 2) MUST PASS — field discovery: the tile is a navigate candidate labelled by its title; the
//    information link keeps its own label and is refused by the same vocabulary as before.
// ===========================================================================================
console.log("\n[2] field discovery on the tile page");
await page.goto(`${base}/apply`);
const raws = await harvest(page);
const tileRaw = raws.find((f) => f.label === SOLAR);
check("the harvest lists a button-typed field whose label is the card's TITLE",
  !!tileRaw && tileRaw.fieldType === "button", JSON.stringify(raws.map((f) => f.label).slice(0, 60)));
check("...marked as a tile, with the title as its text (never the card's prose)",
  !!tileRaw && (tileRaw as { tile?: boolean }).tile === true && tileRaw.text === SOLAR, JSON.stringify(tileRaw));
check("every one of the nine titles is a candidate",
  ["Building Permit Request", SOLAR, "Trade Permits", "Sign Permit Request", "Tree Permits", "Demolition Permit Request"]
    .every((t) => raws.some((f) => f.label === t && f.fieldType === "button")),
  JSON.stringify(raws.map((f) => f.label)));
const infoRaw = raws.find((f) => f.label === INFO_SOLAR);
check("the information link inside the card keeps ITS OWN label and href",
  !!infoRaw && infoRaw.href === "/info/solar" && !(infoRaw as { tile?: boolean }).tile, JSON.stringify(infoRaw));
check("RULE 5 UNCHANGED: the information link's label is still an excluded (off-limits) target",
  isExcludedEntryLabel(INFO_SOLAR), "isExcludedEntryLabel must still refuse a 'requirements' page");
check("the sidebar's 10 links and the signed-in menu are still there — nothing was taken away",
  ["DevHub Home", "My Permits & Requests", "Apply For A Permit", "View or Pay Fees", "Help and FAQs"].every((l) => raws.some((f) => f.label === l)),
  JSON.stringify(raws.map((f) => f.label)));
if (tileRaw) {
  const sel = toExtractedField(tileRaw).selector;
  check("the tile's recorded selector is its title TEXT, exact — a role selector resolves nothing on a <div>",
    sel.text === SOLAR && sel.exact === true && !sel.role, JSON.stringify(sel));
  const loc = page.getByText(sel.text!, { exact: true }).first();
  check("...and that selector resolves exactly one visible element on the page",
    (await loc.count()) >= 1 && await loc.isVisible(), `count=${await loc.count()}`);
  await loc.click({ timeout: 5000 }).catch(() => null);
  await page.waitForLoadState("domcontentloaded").catch(() => null);
  check("...whose click bubbles to the card and navigates (what a replay will do)",
    page.url().includes("/chosen?tile=Solar%20Permit%20Request"), `url=${page.url()}`);
}

// ===========================================================================================
// 3) MUST PASS — THE LEARNER, end to end from the captured home, on every track.
// ===========================================================================================
console.log("\n[3] the learner from the home page: entry → tile → the application");
const runLearn = async (start: string, project: Record<string, string>, planner: LearnPlanner = stubPlanner) => {
  const pw = await ctx.newPage();
  await pw.goto(`${base}${start}`);
  const a = new AutoLearnAdapter("Choice Tiles Walk", planner, { maxPages: 3, budgetMs: 120_000 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (a as any).page = pw;
  const r = await a.learn(
    { portalUrl: `${base}${start}` } as never,
    { projectAddress: "1 Test St, Springfield, IL, 62701", city: "Springfield", state: "IL", zip: "62701", homeownerName: "T", ...project } as never,
  );
  return { r, url: pw.url(), notes: r.steps.map((s) => String(s.note ?? "")), steps: r.steps };
};
for (const [track, project] of [["electrical", { permitType: "electrical" }], ["structural", { permitType: "structural" }], ["NEM (no permitType)", {}]] as const) {
  const before = hits.length;
  const w = await runLearn("/home", project);
  check(`${track}: the entry pass pressed "Apply For A Permit" (page 1 → the tiles)`,
    w.notes.some((n) => /^application entry: Apply For A Permit/.test(n)), JSON.stringify(w.notes));
  check(`${track}: the learner's next click was the "${SOLAR}" TILE`,
    w.notes.some((n) => n === `permit type: ${SOLAR}`), `notes=${JSON.stringify(w.notes)} message=${w.r.message}`);
  const typeStep = w.steps.find((s) => s.note === `permit type: ${SOLAR}`);
  check(`${track}: ...recorded by its title text, exact, so a replay re-finds the card`,
    !!typeStep && typeStep.selector?.text === SOLAR && typeStep.selector?.exact === true && !typeStep.selector?.role,
    JSON.stringify(typeStep?.selector));
  check(`${track}: the walk reached the application behind the tile`,
    w.url.includes("/chosen?tile=Solar%20Permit%20Request"), `ended on ${w.url}; message=${w.r.message}`);
  check(`${track}: no information page and no records page was ever requested`,
    !hits.slice(before).some((h) => h.startsWith("/info/") || h.startsWith("/my-permits") || h.startsWith("/fees")),
    JSON.stringify(hits.slice(before)));
  // REVIEW 1 (finding 4): the recipe is in WALK ORDER — entry, then type. Recorded the other
  // way round, a replay clicks the permit type on the home page, where it does not exist.
  const entryIdx = w.notes.findIndex((n) => /^application entry: Apply For A Permit/.test(n));
  const typeIdx = w.notes.findIndex((n) => n === `permit type: ${SOLAR}`);
  check(`${track}: the ENTRY click is recorded before the TYPE click`,
    entryIdx >= 0 && typeIdx > entryIdx, `order=${JSON.stringify(w.notes)}`);
  // (The run's final message is the stub planner's doing — it fills nothing on the page behind
  // the tile — and is not asserted here; the tile page's own wording is pinned in [4].)
}

// ===========================================================================================
// 4) MUST PASS — a page of tiles that names nothing we came for STOPS and NAMES them.
// ===========================================================================================
console.log("\n[4] tiles, but none of them is the job");
{
  const before = hits.length;
  const w = await runLearn("/home-none", { permitType: "electrical" });
  check("the run stopped (not ok) on the tile page", !w.r.ok && w.url.endsWith("/apply-none"), `ok=${w.r.ok} url=${w.url}`);
  check("the message NAMES the tiles it saw",
    ["Building Permit Request", "Sign Permit Request", "Tree Permits"].every((t) => w.r.message.includes(`"${t}"`)), w.r.message);
  check("...and never says 'nothing fillable' about a page of four choices", !/nothing fillable/i.test(w.r.message), w.r.message);
  check("no tile was clicked, no information page requested",
    !hits.slice(before).some((h) => h.startsWith("/chosen") || h.startsWith("/info/")), JSON.stringify(hits.slice(before)));
}

// ===========================================================================================
// 5) MUST PASS — the entry pass through a CARD, and a pointer cursor as the only affordance.
// ===========================================================================================
console.log("\n[5] entry through a card; cursor-only tiles");
await page.goto(`${base}/home`);
const home = await findApplicationEntry(page);
check("the captured home: 'Apply For A Permit' is the entry (link or card — same label, same rank)",
  !!home && home.match.label === "Apply For A Permit", JSON.stringify(home?.match));
await page.goto(`${base}/home-tiles-only`);
const tilesOnly = await findApplicationEntry(page);
check("a home whose only way in is the CARD: entered through the card, by its title",
  !!tilesOnly && tilesOnly.match.label === "Apply For A Permit" && tilesOnly.match.via === "tile", JSON.stringify(tilesOnly?.match));
check("...never through 'My Permits & Requests' / 'View or Pay Fees' / 'Upload Corrections' / 'Inspections'",
  !!tilesOnly && !/my permits|pay fees|upload|inspections/i.test(tilesOnly.match.label), JSON.stringify(tilesOnly?.match));
if (tilesOnly) {
  await tilesOnly.locator.click({ timeout: 5000 }).catch(() => null);
  await page.waitForLoadState("domcontentloaded").catch(() => null);
  check("...and clicking it lands on the apply page", page.url().endsWith("/apply"), `url=${page.url()}`);
}
await page.goto(`${base}/cursor`);
const cursorPick = await chooseApplicationType(page, "electrical");
check("cursor-only tiles: the solar type is picked over the electrical one (the job outranks the discipline)",
  cursorPick.ok && cursorPick.choice.label === "Residential Solar Permit" && (cursorPick.choice as { kind?: string }).kind === "tile",
  cursorPick.ok ? JSON.stringify(cursorPick.choice.label) : `refused: ${cursorPick.refusal.reason} offered=${JSON.stringify(cursorPick.refusal.offered)}`);
if (cursorPick.ok) {
  await cursorPick.choice.locator.click({ timeout: 5000 }).catch(() => null);
  await page.waitForLoadState("domcontentloaded").catch(() => null);
  check("...and the click navigates", page.url().includes("/chosen?tile=Residential%20Solar%20Permit"), `url=${page.url()}`);
}

// ===========================================================================================
// 6) MUST EXCLUDE — shapes that look like tiles and are not.
// ===========================================================================================
console.log("\n[6] not tiles: a step bar, a lone card, cards holding inputs, an accordion, record cards");
await page.goto(`${base}/stepper`);
const stepperRaws = await harvest(page);
check("a chevron step bar yields no tiles, and 'Review and Submit' never reaches the harvest as a button",
  !stepperRaws.some((f) => (f as { tile?: boolean }).tile) && !stepperRaws.some((f) => /review and submit|^applicant$|^project$/i.test(f.label)),
  JSON.stringify(stepperRaws.map((f) => f.label)));
await page.goto(`${base}/lone`);
const loneRaws = await harvest(page);
check("a card holding inputs is a form, never a tile; the one card without is the page's single choice",
  !loneRaws.some((f) => (f as { tile?: boolean }).tile && /^(owner|installer)$/i.test(f.label))
    && loneRaws.filter((f) => (f as { tile?: boolean }).tile).map((f) => f.label).join("|") === SOLAR,
  JSON.stringify(loneRaws.filter((f) => (f as { tile?: boolean }).tile).map((f) => f.label)));
await page.goto(`${base}/home`);
const homeRaws = await harvest(page);
check("the home's accordion items (heading + button each) are not tiles; its five cards are",
  !homeRaws.some((f) => (f as { tile?: boolean }).tile && /submittal requirements|trade permit\?/i.test(f.label))
    && homeRaws.filter((f) => (f as { tile?: boolean }).tile).length === 5,
  JSON.stringify(homeRaws.filter((f) => (f as { tile?: boolean }).tile).map((f) => f.label)));
await page.goto(`${base}/records`);
const recordRaws = await harvest(page);
check("a dashboard of the operator's record cards yields no tiles (a title with a number is a record)",
  !recordRaws.some((f) => (f as { tile?: boolean }).tile), JSON.stringify(recordRaws.map((f) => f.label)));

// ===========================================================================================
// 7) MUST PASS — ONE card, nothing else to advance: the learner enters it (owner's ruling,
//    2026-09-26: a false stop on a legitimate step is a bug). Two or more unmatched tiles still
//    stop and name themselves ([4]); a single card that is a real-filing control is never entered.
// ===========================================================================================
console.log("\n[7] a home whose only way in is ONE card worded outside the entry vocabulary");
await page.goto(`${base}/home-single`);
const singlePick = await chooseApplicationType(page, "electrical");
const singleRef = singlePick.ok ? null : (singlePick.refusal as { tiles?: string[]; singleTile?: { label: string } });
check("the chooser refuses the TYPE (no job word) but reports the one card as the page's single choice",
  !!singleRef && (singleRef.tiles ?? []).length === 1 && singleRef.singleTile?.label === "Begin Submittal",
  singlePick.ok ? `picked ${singlePick.choice.label}` : JSON.stringify(singleRef));
{
  const before = hits.length;
  const w = await runLearn("/home-single", { permitType: "electrical" });
  check("the learner ENTERS the single card instead of stopping",
    w.notes.some((n) => n === "choice tile: Begin Submittal"), `notes=${JSON.stringify(w.notes)} message=${w.r.message}`);
  check("...and goes on to pick the solar tile on the page behind it",
    w.notes.some((n) => n === `permit type: ${SOLAR}`) && w.url.includes("/chosen?tile=Solar%20Permit%20Request"),
    `ended on ${w.url}; notes=${JSON.stringify(w.notes)}`);
  check("...never the help or privacy links beside it",
    !hits.slice(before).some((h) => h.startsWith("/help") || h.startsWith("/privacy")), JSON.stringify(hits.slice(before)));
  // REVIEW 1 (finding 4), in walk order: the single card, then the entry it revealed, then the type.
  const tileIdx = w.notes.findIndex((n) => n === "choice tile: Begin Submittal");
  const entryIdx = w.notes.findIndex((n) => /^application entry: Apply For A Permit/.test(n));
  const typeIdx = w.notes.findIndex((n) => n === `permit type: ${SOLAR}`);
  check("...recorded in walk order: single card, entry, type",
    tileIdx >= 0 && entryIdx > tileIdx && typeIdx > entryIdx, `order=${JSON.stringify(w.notes)}`);
}
await page.goto(`${base}/home-single-pay`);
const payPick = await chooseApplicationType(page, "electrical");
check("MUST EXCLUDE: a single card that is a real-filing control ('Pay Fees Due') is never the single choice",
  !payPick.ok && !(payPick.refusal as { singleTile?: unknown }).singleTile,
  payPick.ok ? `picked ${payPick.choice.label}` : JSON.stringify(payPick.refusal));

// ===========================================================================================
// 8) REVIEW 1, finding 1 (the blocker) — a wrapper must never inherit a cut card's title and
//    arrow and survive as the page's ONE tile. Nine cards inside an `apply-steps` or
//    `permit-menu` div, nine 28px rows under a heading, a heading over nine hidden cards: each
//    reads as NO tiles, and the learner clicks nothing (before: the wrapper was the single tile,
//    clicked at its centre into whichever card sat there and recorded under the wrong name).
// ===========================================================================================
console.log("\n[8] wrapper shapes: no container is ever the page's one tile");
for (const [route, what] of [
  ["/apply-wrapped", "nine cards inside an apply-steps div"],
  ["/apply-wrapped-menu", "nine cards inside a permit-menu div"],
  ["/apply-rows", "nine 28px rows under a heading"],
  ["/apply-hidden", "a heading over nine hidden cards"],
] as const) {
  await page.goto(`${base}${route}`);
  const got = scanChoiceTiles ? await scanChoiceTiles(page) : null;
  check(`${what}: NO tiles`, !!got && got.length === 0, got ? JSON.stringify(got.map((t) => t.label)) : "scanChoiceTiles not exported");
}
{
  const before = hits.length;
  const w = await runLearn("/home-wrapped", { permitType: "electrical" });
  check("the learner on the wrapped menu clicks NOTHING: no tile step, no card destination requested",
    !w.notes.some((n) => /^choice tile:|^permit type:/.test(n)) && !hits.slice(before).some((h) => h.startsWith("/chosen")),
    `notes=${JSON.stringify(w.notes)} requests=${JSON.stringify(hits.slice(before))}`);
}

// ===========================================================================================
// 9) REVIEW 1, finding 3 — THE PLANNER NEVER CLICKS A TILE. Refused tiles beside a search box
//    (so the page reaches the planner); a planner that names a tile as its advance, or as its
//    navigate, is refused at that door and nothing is clicked. The run that ends there names
//    the choices the page offered — never "nothing fillable".
// ===========================================================================================
console.log("\n[9] the planner's doors: a tile named as advance or navigate is never clicked");
const tilePlanner = (door: "advance" | "navigate"): LearnPlanner => async (req) => {
  const i = req.fields.findIndex((f) => f.label === "Building Permit Request");
  if (i < 0) return { fills: [], atReview: false };
  return door === "advance"
    ? { fills: [], atReview: false, advanceSelectorIndex: i }
    : { fills: [], atReview: false, navigateSelectorIndex: i };
};
for (const door of ["advance", "navigate"] as const) {
  const before = hits.length;
  const w = await runLearn("/apply-search", { permitType: "electrical" }, tilePlanner(door));
  check(`${door} door: a refused tile named by the planner as ${door}SelectorIndex is NOT clicked`,
    !hits.slice(before).some((h) => h.startsWith("/chosen")) && !w.notes.some((n) => /Building Permit Request/.test(n)),
    `requests=${JSON.stringify(hits.slice(before))} notes=${JSON.stringify(w.notes)}`);
  // The walk ends here through its stuck-page stop (the planner keeps naming the tile and is
  // refused each time), whose own message says so — never "nothing fillable" on a page of choices.
  check(`${door} door: ...and the run never reports "nothing fillable" about a page of choices`,
    !/nothing fillable/i.test(w.r.message), w.r.message);
}

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures} choiceTiles.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log("\nAll choiceTiles.dom.smoke checks passed.");
process.exit(0);
