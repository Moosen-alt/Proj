// THE INFORMATION-PAGE CARD AND THE VERIFIED-PAGES LIST (#344, option B), rendered by the SHIPPED
// functions lifted out of frontend/dashboard.js (brace-balanced cut, as structuralLetterCardRender
// does). No Chromium. Everything on the card is PORTAL text (title, label, field names, URL, the
// page's own words): every interpolation must be esc()'d.
//
//   (a) an open candidate shows the page, its control, the held request, the text, a screenshot,
//       and "This is an information page — OK to advance" + "Not an information page";
//   (b) a refusal disables the OK button and is listed; with none it is enabled;
//   (c) every portal value is escaped (a hostile title, label, text, field name, URL);
//   (d) the shared list shows place, control, field names and dates, and Withdraw on every row (a
//       withdrawn pass is deleted, so it is never listed); a row with no verification on record says so;
//   (e) the withdraw flow requires a reason and says runs in flight keep the pass; the page wires
//       the card into the project's pinned portal runs and the list beside the recipes.
//
//   npx tsx backend/test/infoPageCardRender.test.ts
import "./_isolate"; // FIRST
import fs from "node:fs";
import path from "node:path";
import { REPO } from "./_isolate";

let failures = 0;
let total = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  total++;
  if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail.slice(0, 600)}` : ""}`); }
  else console.log(`ok   - ${name}`);
};

const dashboard = fs.readFileSync(path.join(REPO, "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
const html = fs.readFileSync(path.join(REPO, "frontend", "dashboard.html"), "utf8");
const cut = (name: string): string => {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(dashboard);
  if (!m) throw new Error(`dashboard.js: could not find function ${name}`);
  let depth = 0, end = -1;
  for (let j = dashboard.indexOf("{", m.index); j < dashboard.length; j++) {
    if (dashboard[j] === "{") depth++;
    else if (dashboard[j] === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return dashboard.slice(m.index, end);
};
const cards = new Function(`${cut("esc")}\n${cut("infoPageCandidateCardsHtml")}\nreturn infoPageCandidateCardsHtml;`)() as (c: unknown[], projectId: string) => string;
const rows = new Function(`${cut("esc")}\n${cut("infoPagePassRowsHtml")}\nreturn infoPagePassRowsHtml;`)() as (p: unknown[]) => string;

const H = `<img src=x onerror=alert(1)>`;
const candidate = (o: Record<string, unknown> = {}) => ({
  id: "cand-1", projectId: "proj-1", learnRunId: "run-1", firstSeenAt: "2026-10-15T10:00:00Z", lastSeenAt: "2026-10-15T11:00:00Z", seenCount: 2,
  origin: "https://permits.example.test", path: "/permits/sfjsp", queryKeys: [], identityVersion: 1, identitySha256: "a".repeat(64),
  controlLabel: "Next", controlName: "t_n1", request: { method: "POST", where: "https://permits.example.test/permits/sfjsp", media: "multipart/form-data", fieldNames: ["t_n1"] },
  evidence: { title: "Development Hub", headings: [["1", "Development Hub"]], forms: [{ method: "post", enctype: "multipart/form-data", actionWhere: "https://permits.example.test/permits/sfjsp", fields: [["button", "submit", "t_n1"]] }], frames: [], controlLabels: ["Next"], text: "A Permit Tech will review your submission." },
  hasScreenshot: true, status: "open", decidedBy: "", decidedAt: "", passId: "", passLive: false, refusals: [], warnings: ["The text uses review wording."], ...o,
});

const ok = cards([candidate()], "proj-1");
check("(a) the card names the page, its control and the held request", ok.includes("https://permits.example.test/permits/sfjsp") && ok.includes("<strong>Next</strong>") && ok.includes("POST https://permits.example.test/permits/sfjsp · multipart/form-data · fields: t_n1"), ok);
check("(a) …shows the page's text and the screenshot route", ok.includes("A Permit Tech will review your submission.") && ok.includes(`src="/api/projects/proj-1/info-page-candidates/cand-1/screenshot"`), ok);
check("(a) …and the two decisions", ok.includes("This is an information page — OK to advance") && ok.includes("Not an information page") && ok.includes(`data-identity="${"a".repeat(64)}"`), ok);
check("(b) with no refusal the OK button is enabled", !/data-info-verify="cand-1"[^>]*disabled/.test(ok), ok);
const refused = cards([candidate({ refusals: ["the page shows a summary (<dl> / <th> table)"] })], "proj-1");
check("(b) a refusal disables OK and is listed (escaped)", /data-info-verify="cand-1"[^>]*disabled/.test(refused) && refused.includes("Cannot be marked") && refused.includes("&lt;dl&gt;"), refused);
check("(b2) no screenshot: says to re-run the learn", cards([candidate({ hasScreenshot: false })], "p").includes("No screenshot"));
const hostile = cards([candidate({
  origin: H, path: H, controlLabel: H, queryKeys: [H],
  request: { method: H, where: H, media: H, fieldNames: [H] },
  evidence: { title: H, headings: [["1", H]], forms: [{ method: H, enctype: H, actionWhere: H, fields: [["input", "hidden", H]] }], frames: [[H, H]], controlLabels: [H], text: H },
  warnings: [H], refusals: [H], decidedBy: H,
})], `p"${H}`);
check("(c) every portal value is escaped: no raw <img anywhere", !hostile.includes("<img src=x") && hostile.includes("&lt;img src=x onerror=alert(1)&gt;"), hostile);
const decided = cards([candidate({ status: "verified", decidedBy: H, decidedAt: "2026-10-15T12:00:00Z" })], "p");
check("(c2) a decided candidate is a line, not a card, and its decider is escaped", !decided.includes("data-info-verify") && decided.includes("verified, since withdrawn by &lt;img") && !decided.includes("<img src=x"), decided);
check("(c2) a verified candidate whose pass still exists reads 'verified'", cards([candidate({ status: "verified", passLive: true, decidedBy: "Pat", decidedAt: "2026-10-15T12:00:00Z" })], "p").includes(": verified by Pat"));

const pass = (o: Record<string, unknown> = {}) => ({ id: "pass-1", origin: "https://permits.example.test", path: "/permits/sfjsp", queryKeys: [], controlLabel: "Next", controlName: "t_n1",
  request: { method: "POST", where: "https://permits.example.test/permits/sfjsp", media: "multipart/form-data", fieldNames: ["t_n1"] }, identityPrefix: "abcdef012345",
  verifiedAt: "2026-10-15T12:00:00Z", live: true, ...o });
const live = rows([pass()]);
check("(d) a live row: place, control, field names, date, identity prefix, Withdraw", live.includes("https://permits.example.test/permits/sfjsp") && live.includes("fields: t_n1") && live.includes("Verified 2026-10-15") && live.includes("abcdef012345") && live.includes(`data-info-withdraw="pass-1"`), live);
const unrecorded = rows([pass({ live: false, controlLabel: H })]);
check("(d) a row with no person's verification on record says it is never used (Withdraw still offered) and is escaped",
  unrecorded.includes("no verification on record") && unrecorded.includes(`data-info-withdraw="pass-1"`) && !unrecorded.includes("<img src=x"), unrecorded);
check("(d) an empty list says how a page gets here", rows([]).includes("No information page is verified"));

const loader = cut("loadInfoPagePasses");
check("(e) withdraw needs a reason, says the pass is deleted and that a run in progress keeps it", loader.includes("A reason is required") && loader.includes("The pass is deleted") && loader.includes("a run already in progress keeps the pass"), loader.slice(0, 400));
check("(e) the card is wired into the pinned portal runs and the list beside the recipes",
  cut("renderPortalRuns").includes(`<div id="infoPageCandidates"`) && cut("renderPortalRuns").includes("loadInfoPageCandidates(") && cut("loadProjects").includes("loadInfoPagePasses()")
  && html.includes(`id="infoPagePassesAccordion"`) && html.includes(`id="infoPagePasses"`));
check("(e) verify goes through authForDecision + namedPersonConsent and sends the card's identity",
  cut("bindInfoPageCandidateButtons").includes("namedPersonConsent(auth") && cut("bindInfoPageCandidateButtons").includes("identitySha256: button.dataset.identity"));

if (failures) { console.error(`\n${failures}/${total} infoPageCardRender check(s) FAILED.`); process.exit(1); }
console.log(`\nAll ${total}/${total} infoPageCardRender checks passed.`);
process.exit(0);
