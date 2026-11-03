// #436 PR1 — THE STAGED DRAFT'S READ-ONLY WALK, IN A REAL BROWSER (reviewDigest.ts).
//
// A PowerClerk-like replica on 127.0.0.1 (never a real portal): a draft of four step pages and a
// review page, each listing the draft's steps in a `form-steps` list beside site chrome (My Account,
// Sign Out) and a GET "Delete Draft" link; the review page carries Next / Save / Submit buttons and a
// "Last saved <time>" line that changes on every request. The server COUNTS every request it gets;
// "nothing was posted" is what the server saw, not what the run claims.
//
//   MUST-PASS  stage: stageWithRecipe (the real stage path: RecipeAdapter at its review stop) reads the
//              review page and EVERY step (5 sections, in order) — the walk is approvable, the server
//              got 0 non-GET requests, Sign Out and Delete Draft were never requested, the run's own
//              window was never navigated off the review page, the masked picture was written, and the
//              synthetic account number is nowhere in the reading.
//   MUST-PASS  stable: two walks of the same draft (same key, same nonce) give the same digest even
//              though "Last saved" changed between them (ruling 7); the account on the review page is
//              tagged for the picture's mask.
//   MUST-EXCL  changed: a value changed on step 4 (the server's own state) → a different digest, in
//              that step's section only.
//   MUST-EXCL  each refused by name, 0 non-GET at the server: a step tab that opens by a script
//              (__doPostBack); a cross-origin frame on a step; a dialog open on the review page; a
//              step page that changes itself between the two reads; a step page that POSTs on load
//              (the POST is blocked: 0 at the server, and the row is unapprovable, named); a NATIVE
//              alert() on a step page (noted by the CDP watch, never answered by product code).
//
// Kill: openPlaywrightDigestNavigator's route → route.fallback() for every method → "onLoadPost" sees
// a POST at the server. stepLinksInPage: drop the ACTS / ACT_PATH exclusion → Delete Draft is requested.
// The CDP dialog watch: never note Page.javascriptDialogOpening → "nativeDialog" reads approvable.
//
//   npx tsx portal-bot/src/adapters/stagedReviewWalk.dom.smoke.ts
import "../smokeArtifactDirs";
import fs from "node:fs";
import http from "node:http";
import { chromium } from "playwright";
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
const state: Record<string, string> = { capacity: "" };
let xoBase = "";

const STEPS: Array<[number, string]> = [[1, "Customer Information"], [2, "Equipment"], [3, "Attachments"], [4, "Aggregation"]];
const nav = (pid: number, mode: string): string => `<ul class="form-steps">${STEPS.map(([n, label]) => {
  const href = mode === "scriptTab" && n === 2 ? "javascript:__doPostBack('step2','')" : `/MvcProjects/EditForm?ProjectId=${pid}&FormId=${n}`;
  return `<li><a href="${href}">${label}</a></li>`;
}).join("")}<li><a href="/MvcProjects/EditForm?ProjectId=${pid}&FormId=9">Review and Submit</a></li><li><a href="/MvcProjects/DeleteProject?ProjectId=${pid}">Delete Draft</a></li></ul>`;
const CHROME = `<nav><a href="/account">My Account</a> <a href="/logout">Sign Out</a></nav>`;
const page = (title: string, pid: number, mode: string, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${CHROME}<aside>${nav(pid, mode)}</aside><main><h1>${title}</h1>${body}</main></body></html>`;
const MODES: Record<number, string> = { 4417: "clean", 4418: "scriptTab", 4419: "crossFrame", 4420: "dialog", 4421: "selfChanging", 4422: "onLoadPost", 4423: "nativeDialog" };

const stepBody = (n: number, pid: number, mode: string): string => {
  if (n === 1) return `<label for="cn">Customer Name</label><input id="cn" value="Avery Fenwick">
    <label for="acct">Utility Account Number</label><input id="acct" value="${ACCOUNT}">
    <label><input type="checkbox" id="nb"> Customer is not the account holder</label>`;
  if (n === 2) return `<table><tr><th>Component</th><th>Model</th><th>Qty</th></tr><tr><td>Module</td><td>Q.TRON BLK M-G2+ 430</td><td>20</td></tr><tr><td>Inverter</td><td>IQ8M</td><td>20</td></tr></table>
    <iframe src="${mode === "crossFrame" ? xoBase : ""}/frame/meter?ProjectId=${pid}" width="420" height="90"></iframe>
    ${mode === "selfChanging" ? `<p id="tick">Queue position 1</p><script>var q = 1; setInterval(function(){ q++; document.getElementById("tick").textContent = "Queue position " + q; }, 150);</script>` : ""}`;
  if (n === 3) return `<p>Documents on this application:</p><ul><li>site-plan.pdf</li><li>one-line.pdf</li></ul>
    ${mode === "onLoadPost" ? `<script>fetch("/MvcProjects/SaveChanges?ProjectId=${pid}", { method: "POST", body: "autosave=1" }).catch(function(){});</script>` : ""}
    ${mode === "nativeDialog" ? `<script>alert("Your session will expire soon.");</script>` : ""}`;
  return `<fieldset><legend>Meter aggregation</legend><label><input type="radio" name="agg" value="y"> Yes</label><label><input type="radio" name="agg" value="n"> No</label></fieldset>
    <label for="cap">Aggregated capacity (kW)</label><input id="cap" value="${state.capacity}">
    <label><input type="checkbox" checked> I am authorized to submit this application</label>`;
};
const reviewBody = (pid: number, mode: string): string => {
  const saved = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
  return `<p>Please review your application before submitting.</p>
    <dl><dt>Customer</dt><dd>Avery Fenwick</dd><dt>Account</dt><dd>${ACCOUNT}</dd><dt>System Size (kW DC)</dt><dd>8.6</dd></dl>
    <p>Last saved ${saved}</p>
    ${mode === "dialog" ? `<div role="dialog" style="border:1px solid #000;padding:8px">Your session will expire soon.</div>` : ""}
    <button type="button" id="btnSave">Save</button> <button type="button" id="btnNext">Next</button>
    <form method="post" action="/MvcProjects/SubmitProject?ProjectId=${pid}"><button type="submit" id="btnSubmit">Submit Application</button></form>`;
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  requests.push({ method: String(req.method), path: `${url.pathname}${url.search}` });
  const send = (html: string, status = 200): void => { res.writeHead(status, { "content-type": "text/html; charset=utf-8" }); res.end(html); };
  if (req.method !== "GET" && req.method !== "HEAD") { send("<p>saved</p>"); return; }
  const pid = Number(url.searchParams.get("ProjectId") || 0);
  const mode = MODES[pid] || "clean";
  if (url.pathname === "/frame/meter") { send(`<!doctype html><html><body><label for="ml">Meter Location</label><input id="ml" value="North wall"></body></html>`); return; }
  if (url.pathname === "/MvcProjects/EditForm") {
    const form = Number(url.searchParams.get("FormId") || 0);
    if (form === 9) { send(page("Review and Submit", pid, mode, reviewBody(pid, mode))); return; }
    const step = STEPS.find(([n]) => n === form);
    if (step) { send(page(step[1], pid, mode, stepBody(step[0], pid, mode))); return; }
  }
  send("<h1>Not found</h1>", 404);
});
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

try {
  // ── 1. the real stage path ─────────────────────────────────────────────────────────────────
  console.log("\n1. MUST-PASS: a Stage at its review stop reads every step, read-only");
  {
    const before = requests.length;
    const recipe = {
      id: "staged-review-walk-smoke", scopeType: "utility", profileKey: "or||fixture utility", state: "OR", ahj: "", utility: "Fixture Utility",
      portalPlatform: "fixture", portalUrl: reviewOf(4417), status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
      steps: [
        { action: "goto", value: reviewOf(4417), note: "open the draft's review page" } as RecipeStep,
        { action: "stopForReview" } as RecipeStep,
        { action: "click", selector: { css: "#btnSubmit" }, note: "final submit: Submit Application", isFinalSubmit: true } as RecipeStep,
      ],
    } as PortalRecipe;
    const r = await stageWithRecipe(recipe, { id: "p-staged-walk" } as ProjectRecord, { accountNumber: ACCOUNT }, {}, [], {
      runId: "smoke-staged-walk-1", headless: true, stagedReview: { secrets: [ACCOUNT], gapMs: 400 },
    });
    const c = r.stagedReview as StagedReviewCapture | undefined;
    const brief = `ok=${String(r.ok)} why=${JSON.stringify(c?.why)} sections=${JSON.stringify(c?.sections.map((s) => [s.step, s.items.length, s.unreadable]))}`;
    check("stage: the result carries the staged reading (top-level, from the adapter)", !!c, brief);
    check("stage: every step is read — review, then the four tabs in order", JSON.stringify(c?.sections.map((s) => s.step)) === JSON.stringify(["review", "Customer Information", "Equipment", "Attachments", "Aggregation"]), brief);
    check("stage: the reading is approvable (every page read twice and agreeing; one recorded Submit; a draft id)", c?.approvable === true && c?.draftId === "4417", brief);
    check("stage: the same-origin frame's field is read (step 2)", !!c?.sections[2]?.items.some((i) => /^frame 1: Meter Location$/.test(i.label)), brief);
    check("stage: an empty box and an unchecked box are rows (step 4, step 1)",
      !!c?.sections[4]?.items.some((i) => i.label === "Aggregated capacity (kW)") && !!c?.sections[1]?.items.some((i) => i.kind === "check"), brief);
    check("stage: NOTHING was posted while the draft was read (the server saw 0 non-GET requests)", nonGet(before).length === 0, JSON.stringify(nonGet(before)));
    check("stage: Sign Out and Delete Draft were never requested", hit(before, /logout|DeleteProject/i).length === 0, JSON.stringify(hit(before, /logout|DeleteProject/i)));
    check("stage: the run's own window stayed on the review page (its draft reference is the review link)",
      JSON.stringify((r as { draftReference?: unknown }).draftReference) === JSON.stringify({ link: `${base}/MvcProjects/EditForm?ProjectId=4417&FormId=9`, id: "4417" }), JSON.stringify((r as { draftReference?: unknown }).draftReference));
    const shot = String(c?.screenshotPath ?? "");
    check("stage: the masked picture was written, inside the staged-review folder", !!shot && shot.startsWith(stagedReviewShotsDir()) && fs.existsSync(shot)
      && fs.readFileSync(shot).subarray(0, 4).toString("latin1") === "\x89PNG", shot);
    check("stage: the synthetic account number is nowhere in the reading", !leaks(c), "");
  }

  // ── 2. stable across two walks; 3. a real change is seen ───────────────────────────────────
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    const runPage = await ctx.newPage();
    const KEY: DigestKey = { key: crypto.createHash("sha256").update("smoke-digest-key").digest(), keyId: "5050505050505050" };
    const NONCE = "abcdefabcdefabcdefabcdefabcdef00";
    const walkOnce = async (pid: number) => {
      await runPage.goto(reviewOf(pid));
      const navr = await openPlaywrightDigestNavigator(runPage, reviewOf(pid));
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
    const refusedCase = async (label: string, pid: number, want: RegExp) => {
      const from = requests.length;
      const c = await walkOnce(pid);
      check(`${label}: not approvable, named`, !c.approvable && c.why.some((w) => want.test(w)), JSON.stringify(c.why));
      check(`${label}: 0 non-GET at the server`, nonGet(from).length === 0, JSON.stringify(nonGet(from)));
    };
    await refusedCase("scriptTab", 4418, /step "Equipment" cannot be opened by navigation alone \(it opens by a script\)/);
    // (The host's 5-digit port is itself redacted in the reason, as every 5-digit run is.)
    await refusedCase("crossFrame", 4419, /a cross-origin frame \(localhost:[\d*]+\) is on the page/);
    await refusedCase("dialog", 4420, /a dialog is open on the page/);
    await refusedCase("selfChanging", 4421, /Equipment: the page changed between two reads/);
    await refusedCase("onLoadPost", 4422, /tried to send 1 request\(s\) while being read/);
    // A NATIVE alert() on a step page: seen by the CDP watch only (no `dialog` listener answers it).
    await refusedCase("nativeDialog", 4423, /Attachments: a dialog opened on the page/);
  } finally {
    await browser.close().catch(() => null);
  }
} finally {
  server.close();
  xo.close();
}

console.log(failures === 0 ? "\nAll stagedReviewWalk checks passed." : `\n${failures} stagedReviewWalk check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
