// THE STAMPED DRAFT CLICK ONLY HAPPENS ON THE PAGE THE STAMP SAW (#362).
//
// Owner ruling 2026-10-17 ("Stop for me"): before the stamped draft-creating Submit (#330/#354, the
// CLAUDE.md rule 1 carve-out), if automation filled anything on that page the recorded steps never
// fill, it fills it and STOPS like a review stop — the answers stay on the page, a person checks them
// and clicks Submit, the stamp is kept, and it is not an incident. Found re-checking PR #353: a stub
// planner doing what the gap-fill prompt says (acknowledgments AGREE, a required Yes/No MUST be
// answered) got one POST each with the draft created — and, on a page where the dropdown's Yes turns
// the Submit into a filing, one FILING POST with no approval.
//
// Real Chromium through the real stage path (stageWithRecipe → runAdapter → RecipeAdapter with the
// network backstop and the LLM gap-fill enabled) against synthetic Part 1 pages on 127.0.0.1 (never a
// real portal). Every non-GET the SERVER receives is counted. The planner is a stub that answers every
// control it is offered (a select with "Yes", a text box from the project), as the gap-fill prompt asks.
//
//   MUST-STOP     filled: an unrecorded required select ("Do you agree to the terms of the Net Metering
//                 (kWh) Agreement?") the stub answers Yes → 0 POSTs; the run ends at review (not an
//                 incident, no draft) and the stop names the control; the answer stays on the page.
//   MUST-STOP     inPage: the gap-fill answers the select before a recorded IN-PAGE click that reveals a
//                 control (the page's identity changes, the page was not left) → still 0 POSTs.
//   MUST-EXCLUDE  submitIntent: "Are you ready to submit your Net Metering (kWh) application?" is never
//                 offered to the planner (which IS asked, for the page's Installer Company) and never
//                 answered → 0 POSTs.
//   MUST-PASS     earlierPage: the gap-fill filled a box on an EARLIER page, and nothing on the Part 1
//                 page → the stamped Submit is clicked once and reads as the draft (as on main).
//   MUST-PASS     clean: a planner enabled with nothing to answer → one click, a draft (as on main).
//
// Run: npx tsx portal-bot/src/adapters/draftSubmitFilled.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { stageWithRecipe } from "../index";
import type { DraftCreatingStamp } from "../draftSubmitGate";
import { draftTenantKey } from "../draftSubmitGate";
import type { LearnPlanRequest, LearnPlanResponse } from "./autoLearnAdapter";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
process.env.AUTOLEARN_SAVE_SETTLE_MS = "1";
process.env.PORTAL_HEADLESS = "true";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const AGREE = "Do you agree to the terms of the Net Metering (kWh) Agreement?";
const READY = "Are you ready to submit your Net Metering (kWh) application?";
const posts: Array<{ mode: string; path: string; body: string }> = [];
const NAV = `<header><a href="/home">Program Home</a> <a href="/logout">Sign Out</a></header>`;
const page = (title: string, body: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${NAV}<main>${body}</main></body></html>`;
const yesNo = (id: string, label: string): string => `<div><label for="${id}">${label}</label><select id="${id}" name="${id}" required><option value="">Select…</option><option>Yes</option><option>No</option></select></div>`;
// The unrecorded control each mode puts on the Part 1 page (none for earlierPage / clean).
const extra = (mode: string): string => mode === "filled" ? yesNo("agree", AGREE)
  : mode === "submitIntent" ? `${yesNo("ready", READY)}<div><label for="installer">Installer Company</label><input id="installer" name="installer" type="text" required></div>`
  : mode === "inPage" ? `${yesNo("agree", AGREE)}<button type="button" id="btnMore" onclick="document.getElementById('more').style.display='block'">Show contact preferences</button><div id="more" style="display:none"><label for="pref">Preferred contact</label><input id="pref" name="pref" type="text"></div>`
  : "";
const PART1 = (mode: string): string => page("Interconnection Application Part 1", `
  <h1>Interconnection Application Part 1 (Preliminary Validation)</h1>
  <form method="post" action="/m/${mode}/p1/submit">
    <div><label for="appDate">Application Date</label><input id="appDate" name="appDate" type="text"></div>
    <div><label for="appType">Application Type</label><select id="appType" name="appType"><option value="">Select…</option><option>New Solar</option></select></div>
    ${extra(mode)}
    <button type="submit" id="btnSubmit">Submit</button>
  </form>`);
// earlierPage: a page BEFORE Part 1 with a required box the recipe never recorded (the gap-fill fills it).
const CONTACT = (mode: string): string => page("Installer", `
  <h1>Installer Information</h1>
  <form method="get" action="/m/${mode}/part1">
    <div><label for="installer">Installer Company</label><input id="installer" name="installer" type="text" required></div>
    <div><label for="contactName">Contact Name</label><input id="contactName" name="contactName" type="text"></div>
    <button type="submit" id="btnNext">Next</button>
  </form>`);
const DRAFT_PAGE = page("Application", `<div class="alert alert-success">Your draft application NEM-90017 has been created. Please continue to Interconnection Application - Part 2 to complete your interconnection application and submit to PSE.</div><a href="/home">Return to Program Home</a>`);

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);
  const mode = parts[0] === "m" ? parts[1] || "" : "";
  const rest = parts.slice(2).join("/");
  const send = (html: string): void => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); };
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    let body = "";
    req.on("data", (c) => { body += String(c); });
    req.on("end", () => {
      posts.push({ mode, path: url.pathname, body });
      send(rest === "p1/submit" ? DRAFT_PAGE : page("OK", "<p>ok</p>"));
    });
    return;
  }
  if (rest === "part1") { send(PART1(mode)); return; }
  if (rest === "contact") { send(CONTACT(mode)); return; }
  send(page("Program Home", "<h1>Program Home</h1>"));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const TENANT = draftTenantKey(base);

// THE STUB PLANNER: answers every control it is offered, the way the gap-fill prompt asks (a required
// Yes/No MUST be answered, an acknowledgment AGREES). Every label it was offered is kept.
const offered: string[] = [];
const planner = async (req: LearnPlanRequest): Promise<LearnPlanResponse> => {
  const fills: LearnPlanResponse["fills"] = [];
  req.fields.forEach((f, i) => {
    offered.push(String(f.label ?? ""));
    if (f.fieldType === "select" && (f.options ?? []).includes("Yes")) fills.push({ selectorIndex: i, value: "Yes" });
    else if (/installer company/i.test(String(f.label ?? ""))) fills.push({ selectorIndex: i, value: "Acme Solar", field: "installerCompany" });
  });
  return { fills, atReview: false };
};
const GAP_FIELDS = { installerCompany: "Acme Solar" };

const submitStep: RecipeStep = { action: "click", selector: { css: "#btnSubmit", text: "Submit" }, note: "final submit | creates a draft, not the filing (#302)" } as RecipeStep;
const part1Steps = (mode: string): RecipeStep[] => [
  { action: "fill", selector: { css: "#appDate", label: "Application Date" }, value: "10/16/2026", note: "Application Date" } as RecipeStep,
  { action: "select", selector: { css: "#appType", label: "Application Type" }, value: "New Solar", note: "Application Type" } as RecipeStep,
  ...(mode === "inPage" ? [{ action: "click", selector: { css: "#btnMore", text: "Show contact preferences" }, note: "contact preferences: Show contact preferences" } as RecipeStep] : []),
  { action: "stopForReview" } as RecipeStep,
  submitStep,
];
const recipeFor = (mode: string): PortalRecipe => {
  const steps: RecipeStep[] = mode === "earlierPage"
    ? [
      { action: "goto", value: `${base}/m/${mode}/contact`, note: "open the first page" } as RecipeStep,
      { action: "fill", selector: { css: "#contactName", label: "Contact Name" }, value: "Pat Example", note: "Contact Name" } as RecipeStep,
      { action: "click", selector: { css: "#btnNext", text: "Next" }, note: "advance: Next" } as RecipeStep,
      ...part1Steps(mode),
    ]
    : [{ action: "goto", value: `${base}/m/${mode}/part1`, note: "open Part 1" } as RecipeStep, ...part1Steps(mode)];
  return {
    id: `draft-filled-${mode}`, scopeType: "utility", profileKey: "wa||twopart", state: "WA", ahj: "", utility: "Two-Part Utility",
    portalPlatform: "fixture", portalUrl: steps[0].value, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
    steps,
  } as PortalRecipe;
};

let seq = 0;
interface Outcome { r: Record<string, unknown>; posts: Array<{ path: string; body: string }>; offered: string[] }
async function stage(mode: string): Promise<Outcome> {
  const recipe = recipeFor(mode);
  const stamp: DraftCreatingStamp = { stepIndex: recipe.steps.length - 1, tenantKey: TENANT, label: "Submit", healedAt: "2026-10-16T00:00:00.000Z" };
  const before = posts.length;
  const offeredBefore = offered.length;
  const runId = `run-${mode}-${++seq}`;
  const r = await stageWithRecipe(recipe, { id: `p-${mode}` } as ProjectRecord, {}, {}, [], {
    headless: true, runId, draftSubmitStamp: stamp, autoSubmit: false, runApproval: null,
    gapFillPlanner: planner, gapFillFields: GAP_FIELDS,
  });
  await new Promise((res) => setTimeout(res, 300));
  return { r, posts: posts.slice(before), offered: offered.slice(offeredBefore) };
}
const msgOf = (r: Record<string, unknown>): string => {
  const steps = Array.isArray(r.steps) ? (r.steps as Array<{ message?: unknown; data?: { agingNotes?: unknown } }>) : [];
  const notes = [r.agingNotes, ...steps.map((s) => s?.data?.agingNotes)].flatMap((n) => (Array.isArray(n) ? n.map(String) : []));
  return [String(r.message ?? ""), ...steps.map((s) => String(s?.message ?? "")), ...notes].filter(Boolean).join(" | ");
};
const gapFilled = (r: Record<string, unknown>): string[] => {
  const steps = Array.isArray(r.steps) ? (r.steps as Array<{ data?: { gapFill?: { filled?: string[] } } }>) : [];
  const own = (r.gapFill as { filled?: string[] } | undefined)?.filled ?? [];
  return [...own, ...steps.flatMap((s) => s?.data?.gapFill?.filled ?? [])];
};
const brief = (o: Outcome): string => `posts=${JSON.stringify(o.posts.map((p) => p.path))} ok=${String(o.r.ok)} clicked=${String(o.r.finalSubmitClicked)} pause=${String(o.r.pauseReason)} draft=${JSON.stringify(o.r.draftCreatedByReplay ?? null)} incident=${JSON.stringify(o.r.draftSubmitUnexpected ?? null)} gapFilled=${JSON.stringify(gapFilled(o.r))} offered=${JSON.stringify(o.offered)} msg=${msgOf(o.r).slice(0, 700)}`;
const submits = (o: Outcome): number => o.posts.filter((p) => /\/p1\/submit$/.test(p.path)).length;
const notAnIncident = (o: Outcome): boolean => o.r.pauseReason !== "draft_submit_unexpected" && !o.r.draftSubmitUnexpected && !o.r.draftCreatedByReplay && o.r.finalSubmitClicked === false;

try {
  {
    const o = await stage("filled");
    check("filled: the gap-fill answered the unrecorded select, and the stamped Submit was NOT clicked (0 POSTs)", submits(o) === 0 && o.posts.length === 0, brief(o));
    check("filled: the stop is a review stop, not an incident: no draft, no incident, nothing clicked", notAnIncident(o), brief(o));
    check("filled: the stop names the control automation filled", msgOf(o.r).includes(AGREE.slice(0, 40)) && /recorded steps never fill/.test(msgOf(o.r)), brief(o));
    check("filled: the answer stays on the page for a person (the gap-fill reports it filled)", gapFilled(o.r).some((l) => l.includes(AGREE.slice(0, 40))), brief(o));
  }
  {
    const o = await stage("inPage");
    check("inPage: an in-page click that reveals a control after the gap-fill does not clear what it wrote — 0 POSTs", submits(o) === 0 && notAnIncident(o) && msgOf(o.r).includes(AGREE.slice(0, 40)), brief(o));
  }
  {
    const o = await stage("submitIntent");
    // The page's other required gap (Installer Company) makes the planner call real.
    check("submitIntent: a control reading as submit intent is never offered to the gap-fill planner", o.offered.some((l) => /installer company/i.test(l)) && !o.offered.some((l) => l.includes("ready to submit")), brief(o));
    check("submitIntent: never answered, so the stamped Submit is not clicked (0 POSTs) and nothing reads as filed", submits(o) === 0 && notAnIncident(o) && !gapFilled(o.r).some((l) => /ready to submit/i.test(l)), brief(o));
  }
  {
    const o = await stage("earlierPage");
    check("earlierPage: the gap-fill filled a box on the EARLIER page (the planner was asked there)", gapFilled(o.r).some((l) => /installer company/i.test(l)), brief(o));
    const d = (o.r.draftCreatedByReplay ?? null) as { applicationNumber?: string } | null;
    check("earlierPage: nothing extra on the Part 1 page, so the stamped Submit is clicked once and reads as the draft (as on main)", submits(o) === 1 && d?.applicationNumber === "NEM-90017" && o.r.finalSubmitClicked === false, brief(o));
  }
  {
    const o = await stage("clean");
    const d = (o.r.draftCreatedByReplay ?? null) as { applicationNumber?: string } | null;
    check("clean: gap-fill enabled with nothing to answer — one click, the draft (as on main)", submits(o) === 1 && d?.applicationNumber === "NEM-90017" && o.r.finalSubmitClicked === false && o.r.ok === true, brief(o));
  }
} finally {
  server.close();
}
if (failures) { console.error(`\n${failures} draft-submit filled-page check(s) FAILED.`); process.exit(1); }
console.log("\nAll draft-submit filled-page checks passed (real Chromium).");
process.exit(0);
