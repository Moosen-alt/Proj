// A REPLAY CLICKS A KNOWN DRAFT-CREATING SUBMIT ITSELF, AND PROVES IT ONLY MADE A DRAFT (#330).
//
// Owner ruling 2026-10-16 ("Yes to PSE"): PSE's PowerClerk Part 1 Submit only creates a draft
// ("Your draft application NEM-… has been created. Please continue to Interconnection Application -
// Part 2 …"). Once that page has been seen after a click of the recipe's last step, the backend
// heals and stamps it (portalDraft.ts); the replay may then click it itself (draftSubmitGate.ts).
//
// Real Chromium through the real stage path (stageWithRecipe → runAdapter → RecipeAdapter with the
// network backstop installed) against a synthetic Part 1 page on 127.0.0.1 (never a real portal).
// Every non-GET the SERVER receives is counted.
//
//   MUST-PASS     draft: the stamped Submit is clicked once (1 POST), the page reads as draft-created,
//                 the run reports draftCreatedByReplay (number + next form), finalSubmitClicked false,
//                 no record number captured. With PORTAL_ALLOW_FINAL_SUBMIT unset and no approval.
//   MUST-PASS     draftApproved: the switch on, autoSubmit on and a named approval for the run change
//                 nothing — still one POST, still a draft, still finalSubmitClicked false.
//   MUST-EXCLUDE  (0 POSTs each) neverHealed: the same Submit unstamped, with the switch on, autoSubmit
//                 and an approval; otherTenant: stamped for another host; notEnabled: the run not
//                 enabled (another track / a borrowed recipe); flagged: stamped AND isFinalSubmit with
//                 no approval (the final-submit gate refuses; this path never takes it).
//   MUST-STOP     receipt: the page after the click reads as a FILING → one POST, paused
//                 draft_submit_unexpected, draftSubmitUnexpected.verdict "filed", finalSubmitClicked
//                 false, NO record number captured, no draft reported.
//   MUST-STOP     error: an error page after the click → paused draft_submit_unexpected, "not_a_draft".
//
// Run: npx tsx portal-bot/src/adapters/draftSubmitClick.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { stageWithRecipe } from "../index";
import { draftTenantKey } from "../draftSubmitGate";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
process.env.AUTOLEARN_SAVE_SETTLE_MS = "1";
process.env.PORTAL_HEADLESS = "true";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const posts: Array<{ mode: string; path: string }> = [];
const NAV = `<header><a href="/home">Program Home</a> <a href="/logout">Sign Out</a></header>`;
const page = (title: string, body: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${NAV}<main>${body}</main></body></html>`;
const PART1 = (mode: string): string => page("Interconnection Application Part 1", `
  <h1>Interconnection Application Part 1 (Preliminary Validation)</h1>
  <form method="post" action="/m/${mode}/p1/submit">
    <div><label for="appDate">Application Date</label><input id="appDate" name="appDate" type="text"></div>
    <div><label for="appType">Application Type</label><select id="appType" name="appType"><option value="">Select…</option><option>New Solar</option></select></div>
    <button type="submit" id="btnSubmit">Submit</button>
  </form>`);
const DRAFT_PAGE = page("Application", `<div class="alert alert-success">Your draft application NEM-90017 has been created. Please continue to Interconnection Application - Part 2 to complete your interconnection application and submit to PSE.</div><a href="/home">Return to Program Home</a>`);
const RECEIPT = page("Application Received", `<h1>Application Received</h1><p>Thank you. Your application has been submitted.</p><p>Record Number: NEM-90017</p>`);
const ERROR = page("Error", `<h1>Error</h1><p>An error has occurred. Please try again later.</p>`);

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);
  const mode = parts[0] === "m" ? parts[1] || "" : "";
  const rest = parts.slice(2).join("/");
  const send = (html: string): void => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); };
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    posts.push({ mode, path: url.pathname });
    if (rest === "p1/submit") { send(mode === "receipt" ? RECEIPT : mode === "error" ? ERROR : DRAFT_PAGE); return; }
    send(page("OK", "<p>ok</p>"));
    return;
  }
  if (rest === "part1") { send(PART1(mode)); return; }
  send(page("Program Home", "<h1>Program Home</h1>"));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const TENANT = draftTenantKey(base);

const stamp = (tenantKey = TENANT) => ({ tenantKey, label: "Submit", healedAt: "2026-10-16T00:00:00.000Z" });
const submitStep = (over: Partial<RecipeStep> = {}): RecipeStep => ({
  action: "click", selector: { css: "#btnSubmit", text: "Submit" }, note: "final submit | creates a draft, not the filing (#302)", ...over,
} as RecipeStep);
const recipeFor = (mode: string, last: RecipeStep): PortalRecipe => ({
  id: `draft-submit-${mode}`, scopeType: "utility", profileKey: "wa||twopart", state: "WA", ahj: "", utility: "Two-Part Utility",
  portalPlatform: "fixture", portalUrl: `${base}/m/${mode}/part1`, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
  steps: [
    { action: "goto", value: `${base}/m/${mode}/part1`, note: "open Part 1" } as RecipeStep,
    { action: "fill", selector: { css: "#appDate", label: "Application Date" }, value: "10/16/2026", note: "Application Date" } as RecipeStep,
    { action: "select", selector: { css: "#appType", label: "Application Type" }, value: "New Solar", note: "Application Type" } as RecipeStep,
    { action: "stopForReview" } as RecipeStep,
    last,
  ],
} as PortalRecipe);

let seq = 0;
interface Outcome { r: Record<string, unknown>; posts: string[] }
async function stage(mode: string, last: RecipeStep, opts: { env?: string; draftSubmitClick?: boolean; autoSubmit?: boolean; approve?: boolean } = {}): Promise<Outcome> {
  const prev = process.env.PORTAL_ALLOW_FINAL_SUBMIT;
  if (opts.env === undefined) delete process.env.PORTAL_ALLOW_FINAL_SUBMIT; else process.env.PORTAL_ALLOW_FINAL_SUBMIT = opts.env;
  const before = posts.length;
  try {
    const runId = `run-${mode}-${++seq}`;
    const r = await stageWithRecipe(recipeFor(mode, last), { id: `p-${mode}` } as ProjectRecord, {}, {}, [], {
      headless: true, runId, draftSubmitClick: opts.draftSubmitClick !== false,
      autoSubmit: opts.autoSubmit === true, runApproval: opts.approve ? { approver: "A. Operator", runId } : null,
    });
    await new Promise((res) => setTimeout(res, 300));
    return { r, posts: posts.slice(before).map((p) => p.path) };
  } finally {
    if (prev === undefined) delete process.env.PORTAL_ALLOW_FINAL_SUBMIT; else process.env.PORTAL_ALLOW_FINAL_SUBMIT = prev;
  }
}
const msgOf = (r: Record<string, unknown>): string => {
  const steps = Array.isArray(r.steps) ? (r.steps as Array<{ message?: unknown }>) : [];
  return [String(r.message ?? ""), ...steps.map((s) => String(s?.message ?? ""))].filter(Boolean).join(" | ");
};
const brief = (o: Outcome): string => `posts=${JSON.stringify(o.posts)} ok=${String(o.r.ok)} clicked=${String(o.r.finalSubmitClicked)} pause=${String(o.r.pauseReason)} permit=${String(o.r.capturedPermitNumber)} draft=${JSON.stringify(o.r.draftCreatedByReplay ?? null)} incident=${JSON.stringify(o.r.draftSubmitUnexpected ?? null)} msg=${msgOf(o.r).slice(0, 500)}`;
const submits = (o: Outcome): number => o.posts.filter((p) => /\/p1\/submit$/.test(p)).length;
const draftOf = (o: Outcome) => (o.r.draftCreatedByReplay ?? null) as { applicationNumber?: string; nextForm?: string; tenantKey?: string; clickedLabel?: string } | null;
const incidentOf = (o: Outcome) => (o.r.draftSubmitUnexpected ?? null) as { verdict?: string } | null;

try {
  {
    const o = await stage("draft", submitStep({ draftCreatingSubmit: stamp() } as Partial<RecipeStep>));
    const d = draftOf(o);
    check("draft: the stamped Submit is clicked ONCE and the page reads as the draft it made", submits(o) === 1 && d?.applicationNumber === "NEM-90017" && d?.nextForm === "Interconnection Application - Part 2", brief(o));
    check("draft: nothing reads as filed — finalSubmitClicked false, no record number, the run staged ok", o.r.finalSubmitClicked === false && !o.r.capturedPermitNumber && !o.r.capturedConfirmationNumber && o.r.ok === true && !o.r.pauseReason, brief(o));
    check("draft: the draft carries the tenant it was made on and the label clicked", d?.tenantKey === TENANT && d?.clickedLabel === "Submit", brief(o));
  }
  {
    const o = await stage("draftApproved", submitStep({ draftCreatingSubmit: stamp() } as Partial<RecipeStep>), { env: "1", autoSubmit: true, approve: true });
    check("draftApproved: the switch, autoSubmit and an approval change nothing — one click, a draft, never a filing", submits(o) === 1 && draftOf(o)?.applicationNumber === "NEM-90017" && o.r.finalSubmitClicked === false, brief(o));
  }
  {
    const o = await stage("neverHealed", submitStep(), { env: "1", autoSubmit: true, approve: true });
    check("neverHealed: a Submit never healed is never clicked (switch on, autoSubmit, approval: 0 POSTs)", submits(o) === 0 && !draftOf(o) && o.r.finalSubmitClicked === false, brief(o));
  }
  {
    const o = await stage("otherTenant", submitStep({ draftCreatingSubmit: stamp("another-utility.powerclerk.example") } as Partial<RecipeStep>));
    check("otherTenant: a stamp seen on another tenant is never clicked here (0 POSTs)", submits(o) === 0 && !draftOf(o), brief(o));
  }
  {
    const o = await stage("notEnabled", submitStep({ draftCreatingSubmit: stamp() } as Partial<RecipeStep>), { draftSubmitClick: false });
    check("notEnabled: a run the backend did not enable never clicks it (0 POSTs) and stops for a person", submits(o) === 0 && !draftOf(o) && /left for a person/.test(JSON.stringify(o.r.steps ?? "")), brief(o));
  }
  {
    const o = await stage("flagged", submitStep({ isFinalSubmit: true, draftCreatingSubmit: stamp() } as Partial<RecipeStep>));
    check("flagged: a stamped step still flagged isFinalSubmit goes only to the final-submit gate, which refuses (0 POSTs)", submits(o) === 0 && !draftOf(o) && o.r.finalSubmitClicked === false, brief(o));
  }
  {
    const o = await stage("receipt", submitStep({ draftCreatingSubmit: stamp() } as Partial<RecipeStep>));
    check("receipt: a filing page after the click stops the run as the incident", submits(o) === 1 && o.r.pauseReason === "draft_submit_unexpected" && incidentOf(o)?.verdict === "filed", brief(o));
    check("receipt: the track does not read as filed — finalSubmitClicked false, no record number, no draft", o.r.finalSubmitClicked === false && !o.r.capturedPermitNumber && !o.r.capturedConfirmationNumber && !draftOf(o) && o.r.ok === false, brief(o));
    check("receipt: the run says the portal may have filed and a person must check", /MAY HAVE FILED/.test(msgOf(o.r)), brief(o));
  }
  {
    const o = await stage("error", submitStep({ draftCreatingSubmit: stamp() } as Partial<RecipeStep>));
    check("error: an error page after the click stops the run as the incident (not a draft)", submits(o) === 1 && o.r.pauseReason === "draft_submit_unexpected" && incidentOf(o)?.verdict === "not_a_draft" && o.r.finalSubmitClicked === false && !draftOf(o), brief(o));
  }
} finally {
  server.close();
}
if (failures) { console.error(`\n${failures} draft-submit click check(s) FAILED.`); process.exit(1); }
console.log("\nAll draft-submit click checks passed (real Chromium).");
process.exit(0);
