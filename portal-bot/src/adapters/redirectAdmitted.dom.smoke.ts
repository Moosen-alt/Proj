// THE ADMITTED REQUEST'S OWN REDIRECT STAYS REFUSED, AND IS REPORTED TRUTHFULLY (#358).
//
// The approved final submit (hard rule 1) and the #330 stamped draft submit each admit ONE request.
// When the portal answers that request with a method-keeping redirect, the hop is judged as a
// fresh request and never takes the slot (filingBackstop.ts, judgePaused): no new rule here, the
// hop meets the filing-URL rule or the sticky lock exactly as any other request would. Because the
// first leg DID reach the portal, the run says so: finalSubmitRequestSent stays true, the notes name
// the approved request's own redirect (not "another state-changing request"), and nothing says
// "Nothing was sent". (The verified information page's own redirect is pinned in
// infoPagePass.dom.smoke.ts [X].)
//
// Real Chromium through the real stage path (stageWithRecipe → RecipeAdapter with the backstop)
// against synthetic pages on 127.0.0.1. Every non-GET the SERVER receives is counted.
//
//   approvedFile    — the approved Submit's POST is answered 307 → /api/SubmitApplication: the
//                     filing POST went once, nothing reaches the Location, finalSubmitRequestSent true,
//                     the notes name the approved request's own 307.
//   approvedReceipt — answered 307 → /receipt (a plain path): the sticky lock refuses it; the same.
//   draftSlash      — the stamped draft Submit answered 308 → /p1/submit/ (a trailing slash): refused
//                     by the filing-URL rule — KNOWN COST, listed in the PR: the run stops, never a
//                     draft, never a filing, and it says the request reached the portal.
//   draftBenign     — answered 307 → /p1/created: followed; the page reads as the draft, as on main.
//
// Run: npx tsx portal-bot/src/adapters/redirectAdmitted.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { stageWithRecipe } from "../index";
import { type DraftCreatingStamp, draftTenantKey } from "../draftSubmitGate";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
process.env.AUTOLEARN_SAVE_SETTLE_MS = "1";
process.env.PORTAL_HEADLESS = "true";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const posts: string[] = [];
const NAV = `<nav><a href="/account">My Account</a> <a href="/logout">Sign Out</a></nav>`;
const page = (title: string, body: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${NAV}<main>${body}</main></body></html>`;
const REVIEW = (mode: string): string => page("Review and Submit", `<h1>Step 5: Review and Submit</h1><p>Please review your application before submitting.</p>
  <dl><dt>Applicant</dt><dd>Desmond Yarrowby</dd><dt>Scope</dt><dd>7.2 kW roof-mounted PV</dd></dl>
  <form method="post" action="/m/${mode}/apply/submit"><button type="submit" id="btnSubmit">Submit Application</button></form>`);
const PART1 = (mode: string): string => page("Interconnection Application Part 1", `
  <h1>Interconnection Application Part 1 (Preliminary Validation)</h1>
  <form method="post" action="/m/${mode}/p1/submit">
    <div><label for="appDate">Application Date</label><input id="appDate" name="appDate" type="text"></div>
    <div><label for="appType">Application Type</label><select id="appType" name="appType"><option value="">Select…</option><option>New Solar</option></select></div>
    <button type="submit" id="btnSubmit">Submit</button>
  </form>`);
const DRAFT_PAGE = page("Application", `<div class="alert alert-success">Your draft application NEM-90017 has been created. Please continue to Interconnection Application - Part 2 to complete your interconnection application and submit to PSE.</div><a href="/home">Return to Program Home</a>`);
const COMPLETION = page("Application Received", `<h1>Application Received</h1><p>Thank you. Your application has been submitted.</p><p>Record Number: BLD-26-00123</p>`);
const REDIRECTS: Record<string, [number, string]> = {
  "approvedFile/apply/submit": [307, "/m/approvedFile/api/SubmitApplication"],
  "approvedReceipt/apply/submit": [307, "/m/approvedReceipt/receipt"],
  "draftSlash/p1/submit": [308, "/m/draftSlash/p1/submit/"],
  "draftBenign/p1/submit": [307, "/m/draftBenign/p1/created"],
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);
  const mode = parts[0] === "m" ? parts[1] || "" : "";
  const rest = parts.slice(2).join("/");
  const send = (html: string): void => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); };
  req.resume();
  req.on("end", () => {
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
      posts.push(url.pathname);
      const r = REDIRECTS[`${mode}/${rest}`];
      if (r) { res.writeHead(r[0], { location: r[1] }); res.end(); return; }
      if (rest === "p1/created") { send(DRAFT_PAGE); return; }
      send(COMPLETION);
      return;
    }
    if (rest === "review") { send(REVIEW(mode)); return; }
    if (rest === "part1") { send(PART1(mode)); return; }
    send(page("Program Home", "<h1>Program Home</h1>"));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

let seq = 0;
interface Outcome { r: Record<string, unknown>; posts: string[] }
const msgOf = (r: Record<string, unknown>): string => {
  const steps = Array.isArray(r.steps) ? (r.steps as Array<{ message?: unknown }>) : [];
  const warn = Array.isArray(r.driftWarnings) ? (r.driftWarnings as unknown[]).map(String) : [];
  return [String(r.message ?? ""), ...steps.map((s) => String(s?.message ?? "")), ...warn].filter(Boolean).join(" | ");
};
const brief = (o: Outcome): string => `posts=${JSON.stringify(o.posts)} ok=${String(o.r.ok)} clicked=${String(o.r.finalSubmitClicked)} sent=${String(o.r.finalSubmitRequestSent)} pause=${String(o.r.pauseReason)} draft=${JSON.stringify(o.r.draftCreatedByReplay ?? null)} msg=${msgOf(o.r).slice(0, 900)}`;

async function approved(mode: string): Promise<Outcome> {
  const prev = process.env.PORTAL_ALLOW_FINAL_SUBMIT;
  process.env.PORTAL_ALLOW_FINAL_SUBMIT = "1";
  const before = posts.length;
  try {
    const runId = `run-${mode}-${++seq}`;
    const recipe = {
      id: `redirect-approved-${mode}`, scopeType: "ahj", profileKey: "or|fernhollow|", state: "OR", ahj: "City of Fernhollow", utility: "",
      portalPlatform: "fixture", portalUrl: `${base}/m/${mode}/review`, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
      steps: [
        { action: "goto", value: `${base}/m/${mode}/review`, note: "open the review page" } as RecipeStep,
        { action: "stopForReview" } as RecipeStep,
        { action: "click", selector: { css: "#btnSubmit" }, note: "final submit: Submit Application", isFinalSubmit: true } as RecipeStep,
      ],
    } as PortalRecipe;
    const r = await stageWithRecipe(recipe, { id: `p-${mode}` } as ProjectRecord, {}, {}, [], {
      autoSubmit: true, runApproval: { approver: "A. Operator", runId }, runId, headless: true,
    });
    await new Promise((res) => setTimeout(res, 300));
    return { r, posts: posts.slice(before) };
  } finally {
    if (prev === undefined) delete process.env.PORTAL_ALLOW_FINAL_SUBMIT; else process.env.PORTAL_ALLOW_FINAL_SUBMIT = prev;
  }
}
async function draft(mode: string): Promise<Outcome> {
  const before = posts.length;
  const runId = `run-${mode}-${++seq}`;
  const stamp: DraftCreatingStamp = { stepIndex: 4, tenantKey: draftTenantKey(base), label: "Submit", healedAt: "2026-10-16T00:00:00.000Z" };
  const recipe = {
    id: `redirect-draft-${mode}`, scopeType: "utility", profileKey: "wa||twopart", state: "WA", ahj: "", utility: "Two-Part Utility",
    portalPlatform: "fixture", portalUrl: `${base}/m/${mode}/part1`, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
    steps: [
      { action: "goto", value: `${base}/m/${mode}/part1`, note: "open Part 1" } as RecipeStep,
      { action: "fill", selector: { css: "#appDate", label: "Application Date" }, value: "10/16/2026", note: "Application Date" } as RecipeStep,
      { action: "select", selector: { css: "#appType", label: "Application Type" }, value: "New Solar", note: "Application Type" } as RecipeStep,
      { action: "stopForReview" } as RecipeStep,
      { action: "click", selector: { css: "#btnSubmit", text: "Submit" }, note: "final submit | creates a draft, not the filing (#302)" } as RecipeStep,
    ],
  } as PortalRecipe;
  const r = await stageWithRecipe(recipe, { id: `p-${mode}` } as ProjectRecord, {}, {}, [], { headless: true, runId, draftSubmitStamp: stamp, autoSubmit: false, runApproval: null });
  await new Promise((res) => setTimeout(res, 300));
  return { r, posts: posts.slice(before) };
}

try {
  for (const [mode, to] of [["approvedFile", "/api/SubmitApplication"], ["approvedReceipt", "/receipt"]] as const) {
    const o = await approved(mode);
    const msg = msgOf(o.r);
    check(`${mode}: the approved Submit's POST went once, and its 307 never reached ${to}`,
      o.posts.filter((p) => p.endsWith("/apply/submit")).length === 1 && o.posts.filter((p) => p.endsWith(to)).length === 0, brief(o));
    check(`${mode}: finalSubmitRequestSent stays true (the first leg reached the portal)`, o.r.finalSubmitClicked === true && o.r.finalSubmitRequestSent === true, brief(o));
    check(`${mode}: the run names the approved request's own 307 to ${to}, not "another state-changing request", and never says nothing was sent`,
      /approved click's request with a 307 redirect/.test(msg) && msg.includes(to) && !/1 other state-changing request/.test(msg) && !/Nothing was sent/i.test(msg), brief(o));
  }
  {
    const o = await draft("draftSlash");
    const msg = msgOf(o.r);
    check("draftSlash: the stamped Submit's POST went once, and its 308 to /p1/submit/ never reached the portal",
      o.posts.filter((p) => p.endsWith("/p1/submit")).length === 1 && o.posts.filter((p) => p.endsWith("/p1/submit/")).length === 0, brief(o));
    check("draftSlash (known cost): the run stops — no draft, not filed — and says the request reached the portal",
      o.r.ok === false && !o.r.draftCreatedByReplay && o.r.finalSubmitClicked === false && /reached the portal/.test(msg) && !/Nothing was sent/i.test(msg), brief(o));
  }
  {
    const o = await draft("draftBenign");
    const d = (o.r.draftCreatedByReplay ?? null) as { applicationNumber?: string } | null;
    check("draftBenign: a 307 to a plain path is followed and the page reads as the draft, as on main",
      o.posts.filter((p) => p.endsWith("/p1/submit")).length === 1 && o.posts.filter((p) => p.endsWith("/p1/created")).length === 1 && d?.applicationNumber === "NEM-90017" && o.r.ok === true && o.r.finalSubmitClicked === false, brief(o));
  }
} finally {
  server.close();
}
if (failures) { console.error(`\nredirectAdmitted: ${failures} FAILED`); process.exit(1); }
console.log("\nredirectAdmitted: all checks passed (real Chromium)");
process.exit(0);
