// #400 — AFTER A PERSON FILES IN THE REVIEW WINDOW, THE RECORD NUMBER AND THE LINK THAT OPENS IT.
//
// Local fixture portals (127.0.0.1, never a real one). The real RecipeAdapter in real Chromium:
// openSubmission reads the account list the sign-in landed on (the "before"); the SMOKE plays the
// person and clicks the portal's submit; captureSubmissionConfirmation then reads only the page the
// person is left on. Synthetic shapes:
//
//   1. Accela-style completion page whose record number IS the link to CapDetail → that link,
//      with its session ticket dropped.
//   2. PowerClerk-style page carrying APP- → the number, linked by its row.
//   3. Drawer-close portal: the drawer closes and the list re-renders. One new row → that row, with
//      its link. Two new rows → nothing written, both offered as candidates.
//   4. A completion page with no number → nothing, no candidate.
//   5. PSE's draft text → a draft, never a number.
//   And READ ONLY: the capture never navigates, clicks or opens a tab (the page URL, the page count
//   and the server's request log are unchanged across it).
//
// KILL: on main 023ce333 captureSubmissionConfirmation returns no recordRead and the page URL as
// the link, so 1-3 fail; 4-5 pass there too and pin that nothing regresses.
//
//   npx tsx portal-bot/src/adapters/submitCapture.dom.smoke.ts
import http from "node:http";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { chromium, type Page } from "playwright";
const SMOKE_ARTIFACTS = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "submit-capture-smoke-"));
process.env.REPLAY_CAPTURE_DIR = SMOKE_ARTIFACTS;
process.env.REPLAY_RUN_DIR = nodePath.join(SMOKE_ARTIFACTS, "runs");
process.env.PORTAL_SCREENSHOT_DIR = nodePath.join(SMOKE_ARTIFACTS, "screenshots");
import type { PortalRecipe, ProjectRecord } from "../../../shared/src/types";
import type { SubmitRecordRead } from "./submissionLedger";
const { RecipeAdapter } = await import("./recipeAdapter");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const LIST_ROWS = `<tr><td><a href="/rec?ProjectId=42101&sessionToken=s1">PC-0042101</a></td><td>41 Fern Ln</td><td>Submitted</td></tr>
  <tr><td><a href="/rec?ProjectId=42102&sessionToken=s1">PC-0042102</a></td><td>7 Alder Ct</td><td>In review</td></tr>`;
const page = (title: string, body: string): string => `<!doctype html><html><head><title>${title}</title></head><body>
  <header><a href="/help">Call 1-800-555-0100</a></header>${body}</body></html>`;
const listPage = (submitTo: string): string => page("My Applications", `<h1>My Applications</h1>
  <table id="apps"><tbody>${LIST_ROWS}</tbody></table>
  <form method="post" action="${submitTo}"><button type="submit" id="submitBtn">Submit Application</button></form>`);
// The drawer portal: the submit is a button in a drawer over the list; it closes and the list
// re-renders in place (no navigation, no completion page).
const drawerPage = (fresh: number[]): string => page("My Applications", `<h1>My Applications</h1>
  <table id="apps"><tbody>${LIST_ROWS}</tbody></table>
  <div id="drawer" role="dialog"><h2>Review</h2><button type="button" id="submitBtn">Submit</button></div>
  <script>
    document.getElementById("submitBtn").addEventListener("click", () => {
      document.getElementById("drawer").remove();
      const body = document.querySelector("#apps tbody");
      for (const n of ${JSON.stringify(fresh)}) {
        const tr = document.createElement("tr");
        tr.innerHTML = '<td><a href="/rec?ProjectId=' + n + '&sessionToken=s2">PC-00' + n + '</a></td><td>12 Willow Rd</td><td>Submitted</td>';
        body.prepend(tr);
      }
    });
  </script>`);

const AFTER: Record<string, string> = {
  accela: page("Record Issuance", `<h1>Step 5: Record Issuance</h1><p>Your application has been successfully submitted.</p>
    <p>Record Number: <a href="/CitizenAccess/Cap/CapDetail.aspx?Module=Building&TabName=Building&capID1=26CAP&capID2=00000&capID3=00274&agencyCode=EXCITY&ticket=SESSION123">517-26-000274-STR</a></p>
    <p>Questions? Call 541-555-0142.</p>`),
  powerclerk: page("Application Submitted", `<h1>Thank you for your application.</h1><p>Your application has been submitted.</p>
    <table><tbody><tr><td>APP-204411</td><td>12 Willow Rd</td><td><a href="/MvcProjects/EditProject?ProjectId=204411&ProgramId=7&sessionToken=s3">View</a></td></tr></tbody></table>`),
  nonumber: page("Thank you", "<h1>Thank you</h1><p>Your submission is complete. We will contact you within 10 business days.</p>"),
  draft: page("Part 1", "<h1>Interconnection Application - Part 1</h1><p>Your draft application NEM-90017 has been created. Please continue to Interconnection Application - Part 2 to complete your interconnection application and submit to PSE.</p>"),
};

const requests: string[] = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  requests.push(`${req.method} ${url.pathname}`);
  res.writeHead(200, { "content-type": "text/html" });
  if (req.method === "POST" && url.pathname === "/submit") { res.end(AFTER[url.searchParams.get("kind") || "nonumber"] ?? AFTER.nonumber); return; }
  if (url.pathname === "/drawer") { res.end(drawerPage((url.searchParams.get("fresh") || "").split(",").filter(Boolean).map(Number))); return; }
  res.end(listPage(`/submit?kind=${url.searchParams.get("kind") || "nonumber"}`));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const recipe: PortalRecipe = {
  id: "submit-capture-smoke", scopeType: "ahj", profileKey: "or|fernhollow|", state: "OR", ahj: "City of Fernhollow", utility: "",
  portalPlatform: "fixture", portalUrl: `${base}/`, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
  steps: [{ action: "stopForReview" }],
};

const browser = await chromium.launch();
/** Land on `landing` (the sign-in's list), openSubmission reads it, the PERSON clicks submit,
 *  and the capture reads what is left. */
async function file(landing: string): Promise<{ data: Record<string, unknown>; read: SubmitRecordRead | undefined; readOnly: string }> {
  const ctx = await browser.newContext();
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  const pg: Page = await ctx.newPage();
  await pg.goto(`${base}${landing}`);
  const adapter = new RecipeAdapter(recipe, {}, {});
  (adapter as unknown as { page: unknown }).page = pg;
  await adapter.openSubmission({} as ProjectRecord);
  // The person's own click, in their window.
  await Promise.all([pg.waitForLoadState("domcontentloaded"), pg.click("#submitBtn")]);
  await pg.waitForTimeout(300);
  const urlBefore = pg.url();
  const pagesBefore = ctx.pages().length;
  const requestsBefore = requests.length;
  const result = await adapter.captureSubmissionConfirmation();
  const readOnly = [
    pg.url() === urlBefore ? "" : `navigated to ${pg.url()}`,
    ctx.pages().length === pagesBefore ? "" : "opened a tab",
    requests.length === requestsBefore ? "" : `sent ${requests.slice(requestsBefore).join(", ")}`,
  ].filter(Boolean).join("; ");
  await ctx.close();
  const data = (result.data ?? {}) as Record<string, unknown>;
  return { data, read: data.recordRead as SubmitRecordRead | undefined, readOnly };
}

console.log("\n1. Accela-style: the record number is the link to CapDetail");
{
  const r = await file("/?kind=accela");
  check("a confident read of the number", r.read?.confidence === "high" && r.read.recordNumber === "517-26-000274-STR", JSON.stringify(r.read));
  check("the link is the number's own (CapDetail), not the completion page",
    /\/CitizenAccess\/Cap\/CapDetail\.aspx\?/.test(String(r.read?.recordLink)) && /agencyCode=EXCITY/.test(String(r.read?.recordLink)), String(r.read?.recordLink));
  check("no session ticket is kept", !/ticket|SESSION/i.test(String(r.read?.recordLink)) && !/ticket|SESSION/i.test(String(r.data.recordLink)), `${r.read?.recordLink} | ${r.data.recordLink}`);
  check("read only", r.readOnly === "", r.readOnly);
}

console.log("\n2. PowerClerk-style: APP- with the row's link");
{
  const r = await file("/?kind=powerclerk");
  check("APP- read with high confidence", r.read?.confidence === "high" && r.read.recordNumber === "APP-204411", JSON.stringify(r.read));
  check("linked by its row (ProjectId/ProgramId kept, session dropped)",
    r.read?.recordLink === `${base}/MvcProjects/EditProject?ProjectId=204411&ProgramId=7`, String(r.read?.recordLink));
}

console.log("\n3. Drawer-close portal: before/after lists");
{
  const one = await file("/drawer?fresh=42199");
  check("one new row is the filing", one.read?.confidence === "high" && one.read.source === "account_list" && one.read.recordNumber === "PC-0042199", JSON.stringify(one.read));
  check("with its own link", one.read?.recordLink === `${base}/rec?ProjectId=42199`, String(one.read?.recordLink));
  check("read only", one.readOnly === "", one.readOnly);
  const two = await file("/drawer?fresh=42199,42200");
  check("two new rows write nothing", two.read?.confidence === "low" && two.read.recordNumber === "", JSON.stringify(two.read));
  check("both reach the panel as candidates", JSON.stringify(two.read?.candidates.map((c) => c.recordNumber).sort()) === JSON.stringify(["PC-0042199", "PC-0042200"]), JSON.stringify(two.read?.candidates));
}

console.log("\n4. A completion page with no number");
{
  const r = await file("/?kind=nonumber");
  check("nothing written and no candidate", (r.read?.recordNumber ?? "") === "" && (r.read?.candidates.length ?? 0) === 0 && !r.data.permitNumber, JSON.stringify(r.data));
}

console.log("\n5. PSE's draft text");
{
  const r = await file("/?kind=draft");
  check("a draft, never a record number", Boolean((r.data.draftCreated as { draft?: boolean } | undefined)?.draft) && !r.data.permitNumber && !r.read, JSON.stringify(r.data).slice(0, 300));
}

await browser.close();
server.close();
nodeFs.rmSync(SMOKE_ARTIFACTS, { recursive: true, force: true });
if (failures) { console.error(`\nsubmitCapture: ${failures} check(s) FAILED`); process.exit(1); }
console.log("\nsubmitCapture: all checks passed (real Chromium, local fixture)");
process.exit(0);
