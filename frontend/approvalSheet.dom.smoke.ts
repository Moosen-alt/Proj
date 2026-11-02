// =================================================================================================
// APPROVE & AUTO-SUBMIT SHOWS THE APPROVAL SHEET, AND ITS ANSWER IS THE APPROVAL (#486).
//
// The approve prompt was a fixed paragraph in a native confirm(); it is now a sheet of what will be
// filed (GET /api/projects/:id/approval-sheet), mismatches first. Pinned in real Chromium, on the
// SHIPPED dashboard.html and styles.css (every network request blocked) with the SHIPPED
// confirmApprovalSheet lifted out of dashboard.js and a stubbed api():
//
//   R  the sheet renders as a dialog: the red list above the table, every row, the masked ids as sent.
//   A  the answer: Approve resolves true; Cancel, Escape and a click on the backdrop resolve false; the
//      dialog closes each time and a second opening still answers (no stale listener decides it).
//   E  esc() everything: a hostile value from the server is text, never an element.
//   F  no sheet (an older server / an error): the native confirm decides, as before.
//
// Discovered from disk by scripts/run-dom-smokes.ts: `npm run portal:test:dom`.
// Alone: `npx tsx frontend/approvalSheet.dom.smoke.ts` (APPROVAL_SHEET_SCREENSHOT=<file.png> saves one)
// =================================================================================================
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const read = (f: string): string => fs.readFileSync(path.join(FRONTEND, f), "utf8").replace(/\r\n/g, "\n");
const dashboardJs = read("dashboard.js");
const dashboardHtml = read("dashboard.html");
const styles = read("styles.css");

let passed = 0;
const failures: string[] = [];
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { passed++; console.log(`  ok   - ${label}`); }
  else { failures.push(label); console.log(`  FAIL - ${label}${detail ? `\n         ${detail}` : ""}`); }
};

/** One top-level declaration out of the shipped dashboard.js, bracket-matched. */
function cut(kind: "function" | "const", name: string): string {
  const needle = kind === "function" ? (dashboardJs.includes(`\nasync function ${name}(`) ? `\nasync function ${name}(` : `\nfunction ${name}(`) : `\nconst ${name} = `;
  const at = dashboardJs.indexOf(needle);
  if (at < 0) throw new Error(`${name} is gone from dashboard.js — re-point this smoke`);
  if (kind === "const" && dashboardJs[at + needle.length] === "\"") return dashboardJs.slice(at + 1, dashboardJs.indexOf("\";\n", at) + 2);
  const rel = dashboardJs.slice(at).search(kind === "function" ? /\)\s*\{/ : /[{[(]/);
  const openAt = at + rel + (kind === "function" ? dashboardJs.slice(at + rel).indexOf("{") : 0);
  const open = dashboardJs[openAt];
  const close = open === "{" ? "}" : open === "[" ? "]" : ")";
  let depth = 0;
  for (let j = openAt; j < dashboardJs.length; j++) {
    if (dashboardJs[j] === open) depth++;
    else if (dashboardJs[j] === close && --depth === 0) return dashboardJs.slice(at + 1, j + 1) + (kind === "const" ? ";" : "");
  }
  throw new Error(`unbalanced reading ${name}`);
}
const bundle = [
  "const state = { selectedProjectId: 'p-under-test' };",
  "let __sheet = null; let __confirms = [];",
  "async function api(p) { if (!__sheet) throw new Error('404'); return { sheet: __sheet }; }",
  "function confirm(t) { __confirms.push(t); return globalThis.__confirmAnswer; }",
  cut("function", "esc"),
  cut("function", "humanize"),
  cut("const", "APPROVE_AUTO_SUBMIT_LEDE"),
  cut("function", "approvalSheetHtml"),
  cut("function", "confirmApprovalSheet"),
  "globalThis.__setSheet = (s) => { __sheet = s; }; globalThis.__confirms = () => __confirms;",
].join("\n\n");

// The shape the server sends (backend/src/approvalSheet.ts), synthetic values.
const SHEET = {
  projectId: "p-under-test", track: "nem", category: "utility",
  rows: [
    { key: "applicant", label: "Applicant (the bill's account holder)", value: "Casey Different", source: "bill", sourceLabel: "Utility bill (account holder)" },
    { key: "homeowner", label: "Property owner", value: "Pat Example", source: "project", sourceLabel: "Project record" },
    { key: "address", label: "Service address", value: "101 Solar Way, Portland OR 97201", source: "project", sourceLabel: "Project record", check: "mismatch", checkNote: "the utility bill's service address reads \"77 Elsewhere Rd\"." },
    { key: "utility", label: "Utility", value: "PGE", source: "project", sourceLabel: "Project record" },
    { key: "account", label: "Utility account number", value: "•••• 7890", masked: true, source: "bill", sourceLabel: "Utility bill (matches the bill's reading)", check: "match", checkNote: "Matches the number read from the utility bill." },
    { key: "meter", label: "Meter number", value: "", masked: true, source: "project", sourceLabel: "Project record", check: "missing" },
    { key: "acKw", label: "System size (AC)", value: "7.6 kW", source: "plan_set", sourceLabel: "Plan set (as saved on the project)", check: "mismatch", checkNote: "the plan set's inverters add up to 6.5 kW (20 × 325 W), not 7.6 kW." },
    { key: "client", label: "Submitting company", value: "Example Solar LLC", source: "client", sourceLabel: "Submitting company's record" },
  ],
  issues: [
    { kind: "mismatch", rowKey: "address", text: "Service address: the utility bill's service address reads \"77 Elsewhere Rd\"." },
    { kind: "mismatch", rowKey: "acKw", text: "System size (AC): the plan set's inverters add up to 6.5 kW (20 × 325 W), not 7.6 kW." },
    { kind: "missing", rowKey: "meter", text: "Meter number: not on file — it is read from the customer's utility bill." },
    { kind: "note", rowKey: "signer", text: "No authorized signer is on the submitting company's record." },
  ],
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await ctx.newPage();
await page.route("**/*", (route: { abort(): Promise<void> }) => route.abort());
await page.setContent(dashboardHtml, { waitUntil: "domcontentloaded" });
await page.addStyleTag({ content: styles });
await page.evaluate((src: string) => {
  const lib = new Function(`${src}\nreturn { confirmApprovalSheet };`)();
  (globalThis as unknown as { __lib: unknown }).__lib = lib;
}, bundle);

/** Open the sheet; `act` then answers it; returns what confirmApprovalSheet resolved to. */
const open = (sheet: unknown) => page.evaluate((s: unknown) => {
  const g = globalThis as unknown as { __setSheet(s: unknown): void; __lib: { confirmApprovalSheet(t: string, who?: string): Promise<boolean> }; __answer?: Promise<boolean> };
  g.__setSheet(s);
  g.__answer = g.__lib.confirmApprovalSheet("nem", "Pat Approver");
}, sheet);
const answer = () => page.evaluate(() => (globalThis as unknown as { __answer: Promise<boolean> }).__answer);
const modalHidden = () => page.evaluate(() => { const m = document.getElementById("approvalSheetModal"); return !m || m.hidden; });

try {
  console.log("\n[R] the sheet renders as a dialog");
  await open(SHEET);
  await page.waitForSelector("#approvalSheetModal:not([hidden]) [data-approval-approve]");
  const probe = await page.evaluate(() => {
    const m = document.getElementById("approvalSheetModal")!;
    const body = m.querySelector(".modal-body")!;
    const red = m.querySelector("[data-approval-mismatches]");
    const table = m.querySelector("table");
    return {
      role: m.getAttribute("role"),
      visible: (m as HTMLElement).offsetParent !== null || getComputedStyle(m).display !== "none",
      redFirst: Boolean(red && table && (red.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING)),
      redText: (red?.textContent || "").replace(/\s+/g, " "),
      rows: Array.from(m.querySelectorAll("tr[data-approval-row]")).map((tr) => (tr as HTMLElement).dataset.approvalRow),
      account: (m.querySelector('tr[data-approval-row="account"] td')?.textContent || "").replace(/\s+/g, " "),
      meter: (m.querySelector('tr[data-approval-row="meter"] td')?.textContent || "").trim(),
      notes: (m.querySelector("[data-approval-notes]")?.textContent || "").replace(/\s+/g, " "),
      recordedAs: /Recorded as:\s*Pat Approver/.test(body.textContent || ""),
    };
  });
  check("a dialog, shown", probe.role === "dialog" && probe.visible, JSON.stringify(probe));
  check("the red list sits above the table and names each mismatch and the missing meter",
    probe.redFirst && /3 things disagree or are missing/.test(probe.redText) && /77 Elsewhere Rd/.test(probe.redText) && /not 7\.6 kW/.test(probe.redText) && /Meter number: not on file/.test(probe.redText), probe.redText);
  check("every row the server sent, in its order", probe.rows.join(",") === SHEET.rows.map((r) => r.key).join(","), JSON.stringify(probe.rows));
  check("the account shows as sent (last 4), the missing meter says so", /•••• 7890/.test(probe.account) && /Matches the number read/.test(probe.account) && probe.meter === "Not on file", `${probe.account} | ${probe.meter}`);
  check("notes are listed apart from the red items, and the approver's name is shown", /No authorized signer/.test(probe.notes) && !/No authorized signer/.test(probe.redText) && probe.recordedAs, probe.notes);
  if (process.env.APPROVAL_SHEET_SCREENSHOT) await page.screenshot({ path: process.env.APPROVAL_SHEET_SCREENSHOT, fullPage: false });

  console.log("\n[A] the answer");
  await page.click("[data-approval-approve]");
  check("Approve resolves true and closes the dialog", (await answer()) === true && await modalHidden());
  await open(SHEET);
  await page.click("[data-approval-cancel]");
  check("Cancel resolves false and closes the dialog", (await answer()) === false && await modalHidden());
  await open(SHEET);
  await page.keyboard.press("Escape");
  check("Escape resolves false", (await answer()) === false && await modalHidden());
  await open(SHEET);
  await page.mouse.click(5, 5);
  check("a click on the backdrop resolves false", (await answer()) === false && await modalHidden());
  await open(SHEET);
  await page.click("[data-approval-approve]");
  check("a later opening still answers by its own buttons (no stale listener)", (await answer()) === true);

  console.log("\n[E] esc() everything");
  await open({ ...SHEET, rows: [{ ...SHEET.rows[0], label: `<img src=x onerror="document.title='pwned'">`, value: "<b>bold</b>", sourceLabel: "<i>i</i>" }], issues: [{ kind: "mismatch", rowKey: "x", text: "<img src=y>" }] });
  const tags = await page.evaluate(() => Array.from(document.querySelectorAll("#approvalSheetModal *")).map((el) => el.tagName.toLowerCase()));
  check("a hostile label, value, source and issue stay text", !tags.includes("img") && !tags.includes("b") && !tags.includes("i") && (await page.title()) !== "pwned", JSON.stringify([...new Set(tags)]));
  await page.click("[data-approval-cancel]");
  await answer();

  console.log("\n[F] no sheet");
  for (const want of [true, false]) {
    await page.evaluate((w: boolean) => { (globalThis as unknown as { __confirmAnswer: boolean }).__confirmAnswer = w; }, want);
    await open(null);
    const got = await answer();
    const asked = await page.evaluate(() => (globalThis as unknown as { __confirms(): string[] }).__confirms());
    check(`the native confirm decides (${want}) and says the sheet could not be loaded`, got === want && /approval sheet could not be loaded/.test(asked[asked.length - 1] || "") && await modalHidden(), JSON.stringify(asked));
  }
} finally {
  await browser.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
