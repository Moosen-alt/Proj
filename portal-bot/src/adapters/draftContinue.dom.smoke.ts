// A TWO-PART PORTAL'S DRAFT IS CONTINUED, NEVER STARTED AGAIN, AND PART 2'S SUBMIT STILL STOPS FOR REVIEW (#302).
//
// PSE's PowerClerk tenant: Part 1's Submit makes a draft ("Your draft application NEM-… has been
// created. Please continue to Interconnection Application - Part 2 …"); the filing is at the end
// of Part 2. Real Chromium against a synthetic portal (wording from the issue, numbers invented):
//
//   (1) THE DRAFT PAGE IS NOT A FILING. RecipeAdapter.captureSubmissionConfirmation on the real
//       DOM of the draft-created page reports draftCreated (number + next form) and NO record
//       number — the draft's NEM number is not a filing's.
//   (2) THE LEARNER OPENS THE EXISTING DRAFT. Given continueDraft (the project's street, no
//       recorded number — the live project's case), it finds the unsubmitted row on that street in
//       the application list (never the other address's approved record), opens it, picks
//       "Interconnection Application - Part 2" [Begin] (never the Cancellation Form beside it,
//       never Part 1's [View] receipt), and never touches "Start a New Application".
//   (3) PART 2 IS STAGED AND STOPS AT REVIEW. The five Part 2 steps are walked; the run reaches
//       review with Part 2's Submit recorded as the one final step but NOT clicked: 0 POSTs.
//   (4) PSE's red "file as a modification on the original record" notice is a review note in the
//       hand-off, not a stop.
//   (5) A REQUIRED draft that is not on the list stops the run by name before anything is started.
//
// Run: npx tsx portal-bot/src/adapters/draftContinue.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium } from "playwright";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";
import { RecipeAdapter } from "./recipeAdapter";
import type { PortalRecipe } from "../../../shared/src/types";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const shell = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><header><a href="/home">Program Home</a></header><main>${body}</main></body></html>`;
const step = (n: number, title: string, fields: Array<[string, string]>, extra = "") => shell(`Part 2 - ${title}`, `
  <h1>Interconnection Application - Part 2</h1><h2>Step ${n} of 5: ${title}</h2>
  <p>NEM-90017</p>${extra}
  <form action="/p2/${n + 1}" method="get">
    ${fields.map(([id, label]) => `<div><label for="${id}">${label}</label><input id="${id}" name="${id}"></div>`).join("")}
    <button type="submit">Next</button>
  </form>`);

const PAGES: Record<string, string> = {
  "/home": shell("Program Home", `
    <h1>Program Home</h1>
    <a href="/new" class="btn">Start a New Application</a>
    <table><thead><tr><th>Project</th><th>Status</th><th>Customer</th><th>Site</th></tr></thead><tbody>
      <tr><td><a href="/rec/80001">NEM-80001</a></td><td>Approved</td><td>Riley Sample</td><td>77 Other Rd, Lynden</td></tr>
      <tr><td><a href="/rec/90017">NEM-90017</a></td><td>Application Draft</td><td>Jordan Testcase</td><td>1234 N Example St, Lynden</td></tr>
    </tbody></table>`),
  "/rec/90017": shell("NEM-90017", `
    <h1>NEM-90017</h1><p>Status: Application Draft</p><p>1234 N Example St, Lynden</p>
    <div class="card"><div class="card-header">Current Forms</div><table><tbody>
      <tr><td>PSE - Cancellation Form <button type="button" onclick="location.href='/cancel'">Begin</button></td><td>New Form</td></tr>
      <tr><td>Interconnection Application - Part 2 <button type="button" onclick="location.href='/p2/1'">Begin</button></td><td>New Form</td></tr>
    </tbody></table></div>
    <div class="card"><div class="card-header">Previously Submitted Forms</div><table><tbody>
      <tr><td>Interconnection Application Part 1 (Preliminary Validation) <button type="button" onclick="location.href='/p1/view'">View</button></td><td>Submitted</td></tr>
    </tbody></table></div>`),
  "/p2/1": step(1, "Customer Information", [["acct", "PSE Account Number"], ["meter", "Meter Number"], ["cust", "Customer Name"], ["addr", "Service Address"]],
    `<p style="color:red">If an original application exists for this system, this change must be filed as a modification on the original record instead.</p>`),
  "/p2/2": step(2, "Installer", [["inst", "Installer Company"]]),
  "/p2/3": step(3, "System Details", [["kw", "System Size (kW DC)"]]),
  "/p2/4": step(4, "Equipment", [["mods", "Module Model"]]),
  "/p2/5": shell("Part 2 - Next Steps", `
    <h1>Interconnection Application - Part 2</h1><h2>Step 5 of 5: Next Steps</h2>
    <p>Please review your application before submitting.</p>
    <form action="/submit" method="post"><label for="ack">Comments</label><input id="ack" name="ack"><button type="submit">Submit</button></form>`),
  "/draft-created": shell("Application", `
    <div class="alert alert-success">Your draft application NEM-90017 has been created. Please continue to Interconnection Application - Part 2 to complete your interconnection application and submit to PSE.</div>
    <a href="/home">Return to Program Home</a>`),
};
const hits: string[] = [];
const posts: string[] = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  hits.push(url.pathname);
  if (req.method !== "GET" && req.method !== "HEAD") {
    posts.push(url.pathname);
    res.writeHead(200, { "content-type": "text/html" });
    res.end(shell("Submitted", "<p>Your application has been submitted.</p>"));
    return;
  }
  const html = PAGES[url.pathname];
  res.writeHead(html ? 200 : 404, { "content-type": "text/html" });
  res.end(html ?? shell("Not found", `<h1>Not found</h1>`));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// Fill every text box with a synthetic value; advance by "Next"; declare review on "Next Steps" and
// name its Submit as the final submit (recorded, never clicked).
const planner: LearnPlanner = async (req) => {
  const fills = req.fields.map((f, i) => ({ f, i })).filter((x) => x.f.fieldType === "text").map((x) => ({ selectorIndex: x.i, value: "Synthetic" }));
  const atReview = /Step 5 of 5: Next Steps/.test(req.bodyText);
  const next = req.fields.findIndex((f) => f.fieldType === "button" && /^next$/i.test(String(f.label ?? "").trim()));
  const submit = req.fields.findIndex((f) => f.fieldType === "button" && /^submit$/i.test(String(f.label ?? "").trim()));
  if (atReview) return { fills, atReview, ...(submit >= 0 ? { finalSubmitSelectorIndex: submit } : {}) };
  return { fills, atReview, ...(next < 0 ? {} : { advanceSelectorIndex: next }) };
};
const PROJECT = { projectAddress: "1234 North Example Street, Lynden, WA, 98264", city: "Lynden", state: "WA", zip: "98264", homeownerName: "Jordan Testcase" };

const browser = await chromium.launch();
const newPage = async () => {
  const ctx = await browser.newContext();
  ctx.setDefaultTimeout(8000);
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  return { ctx, page: await ctx.newPage() };
};
try {
  // (1) the draft-created page, read by the replay's confirmation reader on the real DOM.
  {
    const { ctx, page } = await newPage();
    await page.goto(`${base}/draft-created`);
    const recipe = { id: "r-smoke", portalUrl: `${base}/home`, steps: [], portalName: "Smoke PowerClerk" } as unknown as PortalRecipe;
    const adapter = new RecipeAdapter(recipe, {}, {}, {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).page = page;
    const r = await adapter.captureSubmissionConfirmation();
    const d = (r.data ?? {}) as { permitNumber?: string; draftCreated?: { applicationNumber?: string; nextForm?: string; strength?: string } };
    check("(1) the draft-created page reports a DRAFT with its number and the form to continue to",
      d.draftCreated?.applicationNumber === "NEM-90017" && d.draftCreated?.nextForm === "Interconnection Application - Part 2" && d.draftCreated?.strength === "created",
      JSON.stringify(r).slice(0, 400));
    check("(1) the draft's number is NOT read as a filing's record number", !d.permitNumber, JSON.stringify(d).slice(0, 300));
    await ctx.close().catch(() => null);
  }

  // (2)–(4) the learner continues the existing draft.
  {
    const { ctx, page } = await newPage();
    await page.goto(`${base}/home`);
    hits.length = 0; posts.length = 0;
    const adapter = new AutoLearnAdapter("Smoke PowerClerk", planner, {
      maxPages: 12,
      continueDraft: { nextForm: "Interconnection Application - Part 2", street: PROJECT.projectAddress, required: true },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).page = page;
    let r: Awaited<ReturnType<AutoLearnAdapter["learn"]>> | null = null;
    let threw = "";
    try { r = await adapter.learn({ portalUrl: `${base}/home` } as never, PROJECT as never); }
    catch (e) { threw = String(e).slice(0, 300); }
    const msg = String(r?.message ?? threw).slice(0, 600);
    check("(2) the learner opened the project's draft and its Part 2 form",
      r?.continuedDraft?.applicationNumber === "NEM-90017" && r?.continuedDraft?.form === "Interconnection Application - Part 2",
      `continued=${JSON.stringify(r?.continuedDraft)} ${msg}`);
    check("(2) never a new application, never the other address's record, never the cancellation form, never Part 1's receipt",
      !hits.includes("/new") && !hits.includes("/rec/80001") && !hits.includes("/cancel") && !hits.includes("/p1/view"), `hits=[${hits.join(",")}]`);
    const walked = ["/p2/1", "/p2/2", "/p2/3", "/p2/4", "/p2/5"].every((p) => hits.includes(p));
    check("(3) all five Part 2 steps were walked and the run reached review", walked && r?.reachedReview === true, `hits=[${hits.join(",")}] reached=${r?.reachedReview} ${msg}`);
    const finals = (r?.steps ?? []).filter((s) => s.isFinalSubmit === true);
    const last = (r?.steps ?? [])[(r?.steps ?? []).length - 1];
    check("(3) Part 2's submit is recorded as the ONE final step, last, and never clicked (0 POSTs)",
      finals.length === 1 && last?.isFinalSubmit === true && /NOT clicked/.test(String(last?.note)) && posts.length === 0 && r?.finalSubmitRecorded === true,
      `finals=${finals.length} posts=[${posts.join(",")}] recorded=${r?.finalSubmitRecorded} last=${JSON.stringify(last).slice(0, 200)}`);
    const notes = ((r as { reviewHandoffNotes?: string[] } | null)?.reviewHandoffNotes ?? []).join(" ");
    check("(4) the modification-on-the-original-record notice is a review note, not a stop",
      /modification on the original record/.test(notes) && r?.stopReason !== "existing_draft_not_opened", `notes=${notes.slice(0, 300)} stop=${r?.stopReason}`);
    await ctx.close().catch(() => null);
  }

  // (5) a required draft that is not on the list: stop by name, start nothing.
  {
    const { ctx, page } = await newPage();
    await page.goto(`${base}/home`);
    hits.length = 0; posts.length = 0;
    const adapter = new AutoLearnAdapter("Smoke PowerClerk", planner, {
      maxPages: 6,
      continueDraft: { nextForm: "Interconnection Application - Part 2", street: "55 Nowhere Ave, Lynden, WA", required: true },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).page = page;
    let r: Awaited<ReturnType<AutoLearnAdapter["learn"]>> | null = null;
    try { r = await adapter.learn({ portalUrl: `${base}/home` } as never, { ...PROJECT, projectAddress: "55 Nowhere Ave, Lynden, WA" } as never); }
    catch { /* reported below */ }
    check("(5) a required draft that is not listed stops the run by name and starts no application",
      r?.ok === false && r?.stopReason === "existing_draft_not_opened" && !hits.includes("/new") && posts.length === 0,
      `ok=${r?.ok} stop=${r?.stopReason} hits=[${hits.join(",")}] ${String(r?.message ?? "").slice(0, 300)}`);
    await ctx.close().catch(() => null);
  }
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} draft-continue check(s) FAILED.`); process.exit(1); }
console.log("\nAll draft-continue checks passed (real Chromium).");
process.exit(0);
