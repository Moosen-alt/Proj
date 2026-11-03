// #436 PR1 — THE STAGED DRAFT'S READ-ONLY WALK, IN A REAL BROWSER (reviewDigest.ts).
//
// A PowerClerk-like replica on 127.0.0.1 (never a real portal): a draft of four step pages and a
// review page, each listing the draft's steps in a `form-steps` list beside site chrome (My Account,
// Sign Out) and a GET "Delete Draft" link; the review page carries Next / Save / Submit buttons and a
// "Last saved <time>" line that changes on every request. The server COUNTS every request it gets
// (and every WebSocket upgrade); "nothing was posted" is what the server saw, not what the run claims.
//
//   MUST-PASS  stage: stageWithRecipe (the real stage path: RecipeAdapter at its review stop, its network
//              backstop installed and LOCKED before the walk) reads the review page and EVERY step (5
//              sections, in order) — approvable, the server got 0 non-GET requests, Sign Out and Delete
//              Draft were never requested, the run's own window was never navigated off the review page,
//              the masked picture was written, the synthetic account number is nowhere in the reading.
//   MUST-PASS  stable: two walks of the same draft (same key, same nonce) give the same digest even
//              though "Last saved" changed between them (ruling 7); each page is LOADED twice per walk.
//   MUST-EXCL  changed: a value changed on step 4 (the server's own state) → a different digest, in
//              that step's section only.
//   MUST-EXCL  each refused by name, 0 non-GET at the server: a step tab that opens by a script
//              (__doPostBack); a cross-origin frame on a step (and that site is never even requested);
//              a dialog open on the review page; a step page the server renders differently on each
//              request; a native dialog opened on a step page (noted by the CDP watch, never answered by
//              product code).
//   MUST-EXCL  actionTabs: a step list of real step names that carry an action word ("Interconnection
//              Request", "Battery Back-up", "New Construction Details", "Print Copy of Agreement") and
//              a GET "Delete Draft" link inside it, a nameless icon tab and a link that does not
//              parse: each NAMED as a step the walk will not open, none requested, the row unapprovable.
//   SKEPTIC ROUND 3 — THE WALK PAGE RUNS NO SCRIPT (blockers 1 and 3), in a fresh context whose portal
//              registered a service worker (from the run's own window, on a landing page) that POSTs
//              whenever it sees a step page load: every step page saves on pagehide by sendBeacon AND a
//              keepalive fetch, beacons on visibilitychange, POSTs on load, opens a WebSocket that sends
//              on open, and holds a same-origin iframe whose own script POSTs. MUST: the server saw 0
//              non-GET requests and 0 WebSocket upgrades during the walk, the row reads the server's
//              pages (approvable), and every step was still read.
//   SKEPTIC ROUND 3 — A GET THE FILING PREDICATE CALLS A FILING IS NEVER SENT (blocker 2): a "Finish"
//              tab to /MvcProjects/SubmitProject (named, never requested); a step tab that 302s there (the
//              hop is blocked, named); a step page whose <meta refresh> goes there (blocked, named). The
//              server never saw a request for SubmitProject.
//   SKEPTIC ROUND 3 — THE MASKED PICTURE (stage path): the account shown ONLY inside a same-origin
//              iframe and inside a declarative open shadow root is masked (the picture's pixels there are
//              the mask colour); a review value only a script fills is named (the scriptless reading
//              misses it), and the row is unapprovable.
//
// Kill (each turns this red, by hand): openPlaywrightDigestNavigator without
// Emulation.setScriptExecutionDisabled and its scriptsOffInPage checks → "scripted" sees the beacon /
// keepalive / on-load / iframe POSTs and the WebSocket at the server. Without
// Network.setBypassServiceWorker → "scripted" sees the service worker's POST. The Fetch handler
// continuing every request → "redirectSubmit" and "metaSubmit" GET /MvcProjects/SubmitProject.
// maskedFullPageScreenshot tagging the main frame only → "maskFrame" has no mask pixels in the frame.
// The adapter without shownOnlyWithScripts → "scriptValue" reads approvable.
//
//   npx tsx portal-bot/src/adapters/stagedReviewWalk.dom.smoke.ts
import "../smokeArtifactDirs";
import fs from "node:fs";
import http from "node:http";
import { chromium, type Page } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep, StagedReviewCapture } from "../../../shared/src/types";
import { stageWithRecipe } from "../index";
import { buildStagedReviewCapture, openPlaywrightDigestNavigator, walkStagedDraft, type DigestKey } from "../reviewDigest";
import { secretMaskPatterns, tagSecretsInPage, clearSecretTags } from "../secretMask";
import { stagedReviewShotsDir } from "../../../backend/src/statePaths";
import crypto from "node:crypto";

process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "smoke-only-key-not-a-secret";
delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// Synthetic only.
const ACCOUNT = "7720419385";
const requests: Array<{ method: string; path: string }> = [];
let upgrades = 0;
const state: Record<string, string> = { capacity: "" };
let xoBase = "";
let perRequest = 0;

const STEPS: Array<[number, string]> = [[1, "Customer Information"], [2, "Equipment"], [3, "Attachments"], [4, "Aggregation"]];
// "actionTabs": the skeptic's step list — real step names that carry an action word, and a GET
// "Delete Draft" link INSIDE the list. None may be opened, and none may be dropped unnamed.
const ACTION_TABS: Array<[string, string]> = [
  ["Interconnection Request", "FormId=2"], ["Battery Back-up", "FormId=3"], ["New Construction Details", "FormId=4"], ["Print Copy of Agreement", "FormId=5"],
];
const nav = (pid: number, mode: string): string => {
  const tabs = mode === "actionTabs"
    ? `<li><a href="/MvcProjects/EditForm?ProjectId=${pid}&FormId=1">Customer Information</a></li>${ACTION_TABS.map(([label, q]) => `<li><a href="/MvcProjects/EditForm?ProjectId=${pid}&${q}">${label}</a></li>`).join("")}<li><a href="/MvcProjects/DeleteProject?ProjectId=${pid}">Delete Draft</a></li>`
      // A nameless step link (an icon tab) and one whose link does not parse: named, never opened.
      + `<li><a href="/MvcProjects/EditForm?ProjectId=${pid}&FormId=6" style="display:inline-block;width:14px;height:14px;background:#888"></a></li><li><a href="http://[bad">Utility Review</a></li>`
    : STEPS.map(([n, label]) => {
      const href = mode === "scriptTab" && n === 2 ? "javascript:__doPostBack('step2','')"
        : mode === "redirectSubmit" && n === 2 ? `/MvcProjects/GoToStep?ProjectId=${pid}&FormId=2`
          : `/MvcProjects/EditForm?ProjectId=${pid}&FormId=${n}`;
      return `<li><a href="${href}">${label}</a></li>`;
    }).join("") + (mode === "submitTab" ? `<li><a href="/MvcProjects/SubmitProject?ProjectId=${pid}">Finish</a></li>` : "");
  // The review page's own tab ("Review and Submit" — the page being read) sits in the list; the GET
  // Delete Draft link sits OUTSIDE it in every mode but actionTabs.
  return `<ul class="form-steps">${tabs}<li><a href="/MvcProjects/EditForm?ProjectId=${pid}&FormId=9">Review and Submit</a></li></ul>`
    + (mode === "actionTabs" ? "" : `<p class="draft-actions"><a href="/MvcProjects/DeleteProject?ProjectId=${pid}">Delete Draft</a></p>`);
};
const CHROME = `<nav><a href="/account">My Account</a> <a href="/logout">Sign Out</a></nav>`;
const page = (title: string, pid: number, mode: string, body: string, head = ""): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${CHROME}<aside>${nav(pid, mode)}</aside><main><h1>${title}</h1>${body}</main></body></html>`;
const MODES: Record<number, string> = {
  4417: "clean", 4418: "scriptTab", 4419: "crossFrame", 4420: "dialog", 4421: "serverChanging", 4423: "nativeDialog", 4424: "actionTabs",
  4425: "scripted", 4426: "submitTab", 4427: "redirectSubmit", 4428: "metaSubmit", 4431: "maskFrame", 4432: "scriptValue",
};

/** Every way a page writes by itself (skeptic round 3) — on a STEP page only (the run's own window never opens one). */
const WRITES_BY_ITSELF = (pid: number, n: number): string => `<iframe src="/frame/poster?ProjectId=${pid}&FormId=${n}" width="40" height="20"></iframe>
  <script>
    addEventListener("pagehide", function () {
      try { navigator.sendBeacon("/MvcProjects/AutoSave?ProjectId=${pid}&via=beacon&f=${n}", "autosave=1"); } catch (e) {}
      try { fetch("/MvcProjects/AutoSave?ProjectId=${pid}&via=keepalive&f=${n}", { method: "POST", body: "autosave=1", keepalive: true }); } catch (e) {}
    });
    document.addEventListener("visibilitychange", function () { try { navigator.sendBeacon("/MvcProjects/AutoSave?ProjectId=${pid}&via=visibility&f=${n}", "x=1"); } catch (e) {} });
    fetch("/MvcProjects/OnLoadSave?ProjectId=${pid}&f=${n}", { method: "POST", body: "autosave=1" }).catch(function () {});
    try { var ws = new WebSocket("ws://" + location.host + "/ws?ProjectId=${pid}"); ws.onopen = function () { ws.send("save"); }; } catch (e) {}
    document.getElementById("cap") && (document.getElementById("cap").value = "set-by-script");
  </script>`;

const stepBody = (n: number, pid: number, mode: string): string => {
  const writes = mode === "scripted" ? WRITES_BY_ITSELF(pid, n) : "";
  if (n === 1) return `<label for="cn">Customer Name</label><input id="cn" value="Avery Fenwick">
    <label for="acct">Utility Account Number</label><input id="acct" value="${ACCOUNT}">
    <label><input type="checkbox" id="nb"> Customer is not the account holder</label>${writes}`;
  if (n === 2) return `<table><tr><th>Component</th><th>Model</th><th>Qty</th></tr><tr><td>Module</td><td>Q.TRON BLK M-G2+ 430</td><td>20</td></tr><tr><td>Inverter</td><td>IQ8M</td><td>20</td></tr></table>
    <iframe src="${mode === "crossFrame" ? xoBase : ""}/frame/meter?ProjectId=${pid}" width="420" height="90"></iframe>
    ${mode === "serverChanging" ? `<p>Queue position ${++perRequest}</p>` : ""}${writes}`;
  if (n === 3) return `<p>Documents on this application:</p><ul><li>site-plan.pdf</li><li>one-line.pdf</li></ul>
    ${mode === "nativeDialog" ? `<script>alert("Your session will expire soon.");</script>` : ""}${writes}`;
  return `<fieldset><legend>Meter aggregation</legend><label><input type="radio" name="agg" value="y"> Yes</label><label><input type="radio" name="agg" value="n"> No</label></fieldset>
    <label for="cap">Aggregated capacity (kW)</label><input id="cap" value="${state.capacity}">
    <label><input type="checkbox" checked> I am authorized to submit this application</label>${writes}`;
};
const reviewBody = (pid: number, mode: string): string => {
  const saved = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
  const account = mode === "maskFrame"
    // The account ONLY inside a same-origin iframe and a declarative open shadow root (the skeptic's mask probe).
    // Placed at fixed spots so the picture's pixels there can be read: the frame at (10, 600), the shadow root at (10, 700).
    ? `<iframe src="/frame/account?ProjectId=${pid}" width="420" height="60" style="position:absolute;left:10px;top:600px;border:0"></iframe><div id="host" style="position:absolute;left:10px;top:700px;width:420px"><template shadowrootmode="open"><p style="font-size:20px;margin:0">Shadow account ${ACCOUNT}</p></template></div>`
    : `<dt>Account</dt><dd>${ACCOUNT}</dd>`;
  return `<p>Please review your application before submitting.</p>
    <dl><dt>Customer</dt><dd>Avery Fenwick</dd>${mode === "maskFrame" ? "" : account}<dt>System Size (kW DC)</dt><dd id="size">${mode === "scriptValue" ? "" : "8.6"}</dd></dl>
    ${mode === "maskFrame" ? account : ""}
    ${mode === "scriptValue" ? `<script>document.getElementById("size").textContent = "8.6";</script>` : ""}
    <p>Last saved ${saved}</p>
    ${mode === "dialog" ? `<div role="dialog" style="border:1px solid #000;padding:8px">Your session will expire soon.</div>` : ""}
    <button type="button" id="btnSave">Save</button> <button type="button" id="btnNext">Next</button>
    <form method="post" action="/MvcProjects/SubmitProject?ProjectId=${pid}"><button type="submit" id="btnSubmit">Submit Application</button></form>`;
};
// The portal's service worker: passes every fetch through, and POSTs whenever it sees a step page load.
const SW = `self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function (e) {
  if (e.request.mode === "navigate" && /ProjectId=4425&FormId=[1-4]/.test(e.request.url)) fetch("/MvcProjects/SwSave?ProjectId=4425", { method: "POST", body: "x=1" });
  e.respondWith(fetch(e.request));
});`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  requests.push({ method: String(req.method), path: `${url.pathname}${url.search}` });
  const send = (html: string, status = 200, headers: Record<string, string> = {}): void => { res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers }); res.end(html); };
  if (req.method !== "GET" && req.method !== "HEAD") { send("<p>saved</p>"); return; }
  const pid = Number(url.searchParams.get("ProjectId") || 0);
  const mode = MODES[pid] || "clean";
  if (url.pathname === "/sw.js") { res.writeHead(200, { "content-type": "application/javascript" }); res.end(SW); return; }
  if (url.pathname === "/MvcProjects/Landing") {
    send(`<!doctype html><html><head><title>Welcome</title></head><body><p>Welcome</p><script>navigator.serviceWorker.register("/sw.js").then(function () { return navigator.serviceWorker.ready; }).then(function () { document.title = "ready"; });</script></body></html>`);
    return;
  }
  if (url.pathname === "/frame/meter") { send(`<!doctype html><html><body><label for="ml">Meter Location</label><input id="ml" value="North wall"></body></html>`); return; }
  if (url.pathname === "/frame/account") { send(`<!doctype html><html><body style="margin:0"><p id="fa" style="font-size:20px;margin:0">Frame account ${ACCOUNT}</p></body></html>`); return; }
  if (url.pathname === "/frame/poster") { send(`<!doctype html><html><body><p>.</p><script>fetch("/MvcProjects/FrameSave?ProjectId=${pid}", { method: "POST", body: "x=1" }).catch(function () {});</script></body></html>`); return; }
  if (url.pathname === "/MvcProjects/GoToStep") { send("", 302, { location: `/MvcProjects/SubmitProject?ProjectId=${pid}` }); return; }
  if (url.pathname === "/MvcProjects/SubmitProject") { send(page("Thank you", pid, mode, "<p>Application submitted.</p>")); return; }
  if (url.pathname === "/MvcProjects/EditForm") {
    const form = Number(url.searchParams.get("FormId") || 0);
    if (form === 9) { send(page("Review and Submit", pid, mode, reviewBody(pid, mode))); return; }
    const step = STEPS.find(([n]) => n === form);
    const head = mode === "metaSubmit" && form === 3 ? `<meta http-equiv="refresh" content="0;url=/MvcProjects/SubmitProject?ProjectId=${pid}">` : "";
    if (step) { send(page(step[1], pid, mode, stepBody(step[0], pid, mode), head)); return; }
  }
  send("<h1>Not found</h1>", 404);
});
server.on("upgrade", (_req, socket) => { upgrades++; socket.destroy(); });
// The cross-origin host (localhost vs 127.0.0.1) serves the same frame.
const xo = http.createServer((req, res) => {
  requests.push({ method: String(req.method), path: `xo:${req.url}` });
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><html><body><label for="ml">Meter Location</label><input id="ml" value="North wall"></body></html>`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
await new Promise<void>((r) => xo.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
xoBase = `http://localhost:${(xo.address() as { port: number }).port}`;
const reviewOf = (pid: number) => `${base}/MvcProjects/EditForm?ProjectId=${pid}&FormId=9`;
const nonGet = (from: number) => requests.slice(from).filter((r) => r.method !== "GET" && r.method !== "HEAD");
const hit = (from: number, re: RegExp) => requests.slice(from).filter((r) => re.test(r.path));
const leaks = (c: unknown): boolean => new RegExp(ACCOUNT.split("").join("[\\s\\-.#/]*")).test(JSON.stringify(c));
const stageRecipe = (pid: number): PortalRecipe => ({
  id: `staged-review-walk-smoke-${pid}`, scopeType: "utility", profileKey: "or||fixture utility", state: "OR", ahj: "", utility: "Fixture Utility",
  portalPlatform: "fixture", portalUrl: reviewOf(pid), status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
  steps: [
    { action: "goto", value: reviewOf(pid), note: "open the draft's review page" } as RecipeStep,
    { action: "stopForReview" } as RecipeStep,
    { action: "click", selector: { css: "#btnSubmit" }, note: "final submit: Submit Application", isFinalSubmit: true } as RecipeStep,
  ],
} as PortalRecipe);
const stage = async (pid: number) => {
  const r = await stageWithRecipe(stageRecipe(pid), { id: `p-staged-walk-${pid}` } as ProjectRecord, { accountNumber: ACCOUNT }, {}, [], {
    runId: `smoke-staged-walk-${pid}`, headless: true, stagedReview: { secrets: [ACCOUNT], gapMs: 400 },
  });
  return { r, c: r.stagedReview as StagedReviewCapture | undefined };
};
/** Pixels of the mask colour (Playwright's default #FF00FF) in a PNG's rectangle, read through a canvas. */
const maskPixels = async (pg: Page, file: string, r: { x: number; y: number; w: number; h: number }): Promise<number> => {
  const b64 = fs.readFileSync(file).toString("base64");
  await pg.setContent(`<img id="i" src="data:image/png;base64,${b64}">`);
  await pg.waitForFunction(() => (document.getElementById("i") as HTMLImageElement).complete);
  return pg.evaluate((rect) => {
    const img = document.getElementById("i") as HTMLImageElement;
    const cv = document.createElement("canvas");
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const g = cv.getContext("2d")!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(rect.x, rect.y, rect.w, rect.h).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 240 && d[i + 1] < 20 && d[i + 2] > 240) n++;
    return n;
  }, r);
};

try {
  // ── 1. the real stage path ─────────────────────────────────────────────────────────────────
  console.log("\n1. MUST-PASS: a Stage at its review stop reads every step, read-only");
  {
    const before = requests.length;
    const { r, c } = await stage(4417);
    const brief = `ok=${String(r.ok)} why=${JSON.stringify(c?.why)} sections=${JSON.stringify(c?.sections.map((s) => [s.step, s.items.length, s.unreadable]))}`;
    check("stage: the result carries the staged reading (top-level, from the adapter)", !!c, brief);
    check("stage: every step is read — review, then the four tabs in order", JSON.stringify(c?.sections.map((s) => s.step)) === JSON.stringify(["review", "Customer Information", "Equipment", "Attachments", "Aggregation"]), brief);
    check("stage: the reading is approvable (every page loaded twice and agreeing; one recorded Submit; a draft id; the window shows nothing the scriptless reading lacks)", c?.approvable === true && c?.draftId === "4417", brief);
    check("stage: the same-origin frame's field is read (step 2)", !!c?.sections[2]?.items.some((i) => /^frame 1: Meter Location$/.test(i.label)), brief);
    check("stage: an empty box and an unchecked box are rows (step 4, step 1)",
      !!c?.sections[4]?.items.some((i) => i.label === "Aggregated capacity (kW)") && !!c?.sections[1]?.items.some((i) => i.kind === "check"), brief);
    check("stage: NOTHING was posted while the draft was read (the server saw 0 non-GET requests)", nonGet(before).length === 0, JSON.stringify(nonGet(before)));
    check("stage: Sign Out and Delete Draft were never requested", hit(before, /logout|DeleteProject/i).length === 0, JSON.stringify(hit(before, /logout|DeleteProject/i)));
    check("stage: each step page was loaded twice (two loads, not two looks)", hit(before, /ProjectId=4417&FormId=1$/).length === 2, JSON.stringify(hit(before, /ProjectId=4417&FormId=1$/)));
    check("stage: the run's own window stayed on the review page (its draft reference is the review link)",
      JSON.stringify((r as { draftReference?: unknown }).draftReference) === JSON.stringify({ link: `${base}/MvcProjects/EditForm?ProjectId=4417&FormId=9`, id: "4417" }), JSON.stringify((r as { draftReference?: unknown }).draftReference));
    const shot = String(c?.screenshotPath ?? "");
    check("stage: the masked picture was written, inside the staged-review folder", !!shot && shot.startsWith(stagedReviewShotsDir()) && fs.existsSync(shot)
      && fs.readFileSync(shot).subarray(0, 4).toString("latin1") === "\x89PNG", shot);
    check("stage: the synthetic account number is nowhere in the reading", !leaks(c), "");
  }

  // ── 1b. the masked picture and the scriptless reading (stage path) ─────────────────────────
  console.log("\n1b. SKEPTIC ROUND 3: the picture masks a frame's and a shadow root's account; a value only a script shows is named");
  {
    const { c } = await stage(4431);
    const shot = String(c?.screenshotPath ?? "");
    check("maskFrame: approvable (the account is only in a frame and a shadow root; both readings agree)", c?.approvable === true, JSON.stringify(c?.why));
    check("maskFrame: the frame's and the shadow root's text are read (redacted)", !!c?.sections[0]?.items.some((i) => /^frame 1: /.test(i.label)) && !leaks(c), JSON.stringify(c?.sections[0]?.items.map((i) => i.label)));
    const b = await chromium.launch({ headless: true });
    try {
      const pg = await b.newPage();
      // A masked 20px line is a mask-colour box of well over 1000 pixels where it stands.
      const inFrame = shot && fs.existsSync(shot) ? await maskPixels(pg, shot, { x: 10, y: 600, w: 420, h: 60 }) : -1;
      const inShadow = shot && fs.existsSync(shot) ? await maskPixels(pg, shot, { x: 10, y: 700, w: 420, h: 40 }) : -1;
      check("maskFrame: the picture's account INSIDE THE FRAME is masked (mask-colour pixels where it stands)", inFrame > 1000, `mask pixels=${inFrame} shot=${shot}`);
      check("maskFrame: the picture's account INSIDE THE SHADOW ROOT is masked (mask-colour pixels where it stands)", inShadow > 1000, `mask pixels=${inShadow} shot=${shot}`);
    } finally { await b.close().catch(() => null); }
    const sv = await stage(4432);
    check("scriptValue: a review value only a script fills is named, and the row is unapprovable",
      sv.c?.approvable === false && !!sv.c?.why.some((w) => /the review page shows 1 value\(s\) only while the portal's scripts run \(System Size \(kW DC\)\)/.test(w)), JSON.stringify(sv.c?.why));
  }

  // ── 2. stable across two walks; 3. a real change is seen ───────────────────────────────────
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    const runPage = await ctx.newPage();
    const KEY: DigestKey = { key: crypto.createHash("sha256").update("smoke-digest-key").digest(), keyId: "5050505050505050" };
    const NONCE = "abcdefabcdefabcdefabcdefabcdef00";
    const walkOnce = async (pid: number, rp: Page = runPage, mutate?: (n: Awaited<ReturnType<typeof openPlaywrightDigestNavigator>>) => void) => {
      await rp.goto(reviewOf(pid));
      const navr = await openPlaywrightDigestNavigator(rp, reviewOf(pid));
      mutate?.(navr);
      const walk = await walkStagedDraft(navr, { reviewUrl: reviewOf(pid), gapMs: 400 });
      return buildStagedReviewCapture({ walk, secrets: [ACCOUNT], key: KEY, nonce: NONCE });
    };
    console.log("\n2. MUST-PASS: the digest is stable across two reads of the same draft");
    const before = requests.length;
    const a = await walkOnce(4417);
    await new Promise((res) => setTimeout(res, 1100)); // "Last saved" moves on
    const b = await walkOnce(4417);
    check("stable: both walks approvable", a.approvable && b.approvable, `${a.why.join("; ")} / ${b.why.join("; ")}`);
    check("stable: the same digest across two walks (the self-changing 'Last saved' time is ignored)", a.digest !== "" && a.digest === b.digest, `${a.digest} vs ${b.digest}`);
    check("stable: 0 non-GET at the server across both walks", nonGet(before).length === 0, JSON.stringify(nonGet(before)));
    {
      await runPage.goto(reviewOf(4417));
      const tagged = await tagSecretsInPage(runPage, secretMaskPatterns([ACCOUNT]));
      const accountTagged = await runPage.locator("dd[data-al-secret]").count();
      await clearSecretTags(runPage);
      check("stable: the account on the review page is tagged for the picture's mask", tagged > 0 && accountTagged === 1, `tagged=${tagged} dd=${accountTagged}`);
    }

    console.log("\n3. MUST-EXCLUDE: a changed value on a step page changes the digest, in that section only");
    state.capacity = "11.2";
    const changed = await walkOnce(4417);
    state.capacity = "";
    check("changed: a different digest", changed.digest !== a.digest, changed.digest);
    check("changed: only the Aggregation section changed", changed.sections.map((s, i) => s.digest === a.sections[i].digest).join(",") === "true,true,true,true,false",
      changed.sections.map((s, i) => `${s.step}:${s.digest === a.sections[i].digest}`).join(","));

    console.log("\n4. MUST-EXCLUDE: each refused by name, nothing posted");
    const refusedCase = async (label: string, pid: number, want: RegExp, mutate?: Parameters<typeof walkOnce>[2]) => {
      const from = requests.length;
      const c = await walkOnce(pid, runPage, mutate);
      check(`${label}: not approvable, named`, !c.approvable && c.why.some((w) => want.test(w)), JSON.stringify(c.why));
      check(`${label}: 0 non-GET at the server`, nonGet(from).length === 0, JSON.stringify(nonGet(from)));
      return from;
    };
    await refusedCase("scriptTab", 4418, /step "Equipment" cannot be opened by navigation alone \(it opens by a script\)/);
    // (The host's 5-digit port is itself redacted in the reason, as every 5-digit run is.)
    const xoFrom = await refusedCase("crossFrame", 4419, /a cross-origin frame \(localhost:[\d*]+\) is on the page/);
    check("crossFrame: the other site was never even requested (the walk page loads no other site's document)", hit(xoFrom, /^xo:/).length === 0, JSON.stringify(hit(xoFrom, /^xo:/)));
    await refusedCase("dialog", 4420, /a dialog is open on the page/);
    await refusedCase("serverChanging", 4421, /Equipment: the page changed between two reads/);
    // A NATIVE dialog on a step page: the page's own alert() never runs (no script), so one is opened
    // from outside on the Attachments step — the CDP watch notes it; no product code answers it.
    await refusedCase("nativeDialog", 4423, /Attachments: a dialog opened on the page/, (n) => {
      const read0 = n.read.bind(n);
      let fired = false;
      n.read = async () => {
        if (!fired && /FormId=3/.test(n.landedUrl())) { fired = true; await n.page.evaluate(() => alert("Your session will expire soon.")).catch(() => null); }
        return read0();
      };
    });

    console.log("\n5. MUST-EXCLUDE: step links the walk will not open are NAMED, never dropped (and never opened)");
    {
      const from = requests.length;
      const c = await walkOnce(4424);
      check("actionTabs: not approvable", !c.approvable, JSON.stringify(c.why));
      for (const label of [...ACTION_TABS.map(([l]) => l), "Delete Draft"]) {
        check(`actionTabs: "${label}" is named as a step the walk will not open`,
          c.why.some((w) => w.includes(`step "${label}" cannot be opened by navigation alone (its name or its link reads as an action`)), JSON.stringify(c.why));
      }
      check("actionTabs: a nameless step link is named, never opened",
        c.why.some((w) => w.includes('step "(unnamed step)" cannot be opened by navigation alone (it has no name, so the walk never opens it)')), JSON.stringify(c.why));
      check("actionTabs: a step link that does not parse is named",
        c.why.some((w) => w.includes('step "Utility Review" cannot be opened by navigation alone (its link does not parse)')), JSON.stringify(c.why));
      check("actionTabs: the one plain step is still read (review, Customer Information)",
        JSON.stringify(c.sections.filter((s) => !s.unreadable).map((s) => s.step)) === JSON.stringify(["review", "Customer Information"]), JSON.stringify(c.sections.map((s) => [s.step, s.unreadable])));
      check("actionTabs: none of them was requested (FormId=2..6, DeleteProject)", hit(from, /ProjectId=4424&FormId=[2-6]|DeleteProject/).length === 0, JSON.stringify(hit(from, /ProjectId=4424&FormId=[2-6]|DeleteProject/)));
      check("actionTabs: 0 non-GET at the server", nonGet(from).length === 0, JSON.stringify(nonGet(from)));
      check("actionTabs: the review page's own tab is the page read, not a step to name", !c.why.some((w) => /Review and Submit/.test(w)), JSON.stringify(c.why));
    }

    console.log("\n6. SKEPTIC ROUND 3: a GET the filing predicate calls a filing is never sent");
    for (const [label, pid, want] of [
      ["submitTab", 4426, /step "Finish" cannot be opened by navigation alone \(its link reads as a filing or a payment/],
      ["redirectSubmit", 4427, /the walk blocked \d+ page load\(s\) whose link reads as a filing or a payment/],
      ["metaSubmit", 4428, /the walk blocked \d+ page load\(s\) whose link reads as a filing or a payment/],
    ] as Array<[string, number, RegExp]>) {
      const from = await refusedCase(label, pid, want);
      check(`${label}: the server never saw a request for SubmitProject`, hit(from, /SubmitProject/).length === 0, JSON.stringify(hit(from, /SubmitProject/)));
    }
  } finally {
    await browser.close().catch(() => null);
  }

  // ── 7. the walk page runs no script ────────────────────────────────────────────────────────
  console.log("\n7. SKEPTIC ROUND 3: the walk page runs no script — no beacon, keepalive, on-load save, WebSocket, frame post or service-worker post reaches the server");
  {
    const b2 = await chromium.launch({ headless: true });
    try {
      const ctx = await b2.newContext();
      const runPage = await ctx.newPage();
      // The portal registers its service worker from the run's own window (scripts on), on a landing page.
      await runPage.goto(`${base}/MvcProjects/Landing?ProjectId=4425`);
      await runPage.waitForFunction(() => document.title === "ready", undefined, { timeout: 10_000 }).catch(() => null);
      const swOn = await runPage.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length)).catch(() => 0);
      check("scripted: fixture — the portal's service worker is registered", swOn > 0, `registrations=${swOn}`);
      await runPage.goto(reviewOf(4425));
      await runPage.waitForTimeout(300);
      const from = requests.length;
      const upFrom = upgrades;
      const navr = await openPlaywrightDigestNavigator(runPage, reviewOf(4425));
      const walk = await walkStagedDraft(navr, { reviewUrl: reviewOf(4425), gapMs: 400 });
      await new Promise((res) => setTimeout(res, 1500)); // anything sent as the walk page closed has arrived
      const K = Buffer.alloc(32, 9);
      const N = "00000000000000000000000000000001";
      const c = buildStagedReviewCapture({ walk, secrets: [ACCOUNT], key: { key: K, keyId: "9999999999999999" }, nonce: N });
      check("scripted: the server saw 0 non-GET requests during the walk (beacon, keepalive, on-load, visibilitychange, frame, service worker)", nonGet(from).length === 0, JSON.stringify(nonGet(from)));
      check("scripted: the server saw 0 WebSocket upgrades during the walk", upgrades === upFrom, `upgrades=${upgrades - upFrom}`);
      check("scripted: every step was still read, from the server's pages (approvable)", c.approvable === true && c.sections.length === 5, `${JSON.stringify(c.why)} ${JSON.stringify(c.sections.map((s) => [s.step, s.unreadable]))}`);
      // The box's mac is the HMAC of the server's empty value — not of "set-by-script", which the page's
      // own script writes into it when scripts run.
      const capItem = c.sections[4]?.items.find((i) => i.label === "Aggregated capacity (kW)");
      const macOf = (v: string) => crypto.createHmac("sha256", K).update([N, "field", "Aggregated capacity (kW)", "1", v].join("\u0000"), "utf8").digest("hex");
      check("scripted: the step page's own script never ran (its box reads the server's value, not 'set-by-script')",
        !!capItem && capItem.mac === macOf("") && capItem.mac !== macOf("set-by-script"), JSON.stringify(capItem));
      check("scripted: the walk page's step loads went past no service worker (the worker never saw them: no SwSave)", hit(from, /SwSave/).length === 0, JSON.stringify(hit(from, /SwSave/)));
    } finally {
      await b2.close().catch(() => null);
    }
  }
} finally {
  server.close();
  xo.close();
}

console.log(failures === 0 ? "\nAll stagedReviewWalk checks passed." : `\n${failures} stagedReviewWalk check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
