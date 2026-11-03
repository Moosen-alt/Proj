// AN ADVANCE WHOSE CONTROL IS NOT ON THE PAGE DID NOTHING — IT DOES NOT END THE RUN (#556).
//
// #556 taught clickResilient to name a control its selector cannot find in seconds ("the control is
// not on the page") instead of timing out on it for minutes. That error is not a timeout, so the
// advance door's hard stop for a failed click took it — where main, after its 90 s budget, had
// landed in the did-nothing path (ban the control, try the results row, re-plan) and walked on.
// A skeptic proved the regression on this exact shape: main reached review in 116 s, the branch
// stopped on page 1 in 28 s with the planner asked once.
//
// The shape: a button whose spoken name is not its text (aria-label "Proceed to details", text
// "Next", no id): the scrape labels it "Proceed to details" but builds its role selector from the
// text (name "Next", exact), which matches nothing. Beside it, a working "Continue". The stub
// planner names "Proceed to details" first and Continue when asked again.
//
// MUST: the walk reaches page 2 and its review; the absent advance is named (advance_control_absent)
// and recovered from as an advance that did nothing (advance_did_nothing, a second plan of page 1),
// never as a timeout; the decoy is never clicked; and the recipe does not record a click on a
// control that was never clicked.
//
// Run: npx tsx portal-bot/src/adapters/advanceAbsentControl.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { AutoLearnAdapter, type LearnPlanner, type LearnPlanRequest, type LearnPlanResponse } from "./autoLearnAdapter";
import type { ProjectRecord, RecipeStep } from "../../../shared/src/types";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
process.env.ENTRY_SETTLE_MS = "0";
process.env.PORTAL_SECTION_READY_MS = "2000";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// Every click on a page button is logged in sessionStorage, so the smoke can say what was CLICKED.
const LOG = `function logClick(what) { var l = JSON.parse(sessionStorage.getItem("absentSmoke") || "[]"); l.push(what); sessionStorage.setItem("absentSmoke", JSON.stringify(l)); }`;
const STEP1 = `<!doctype html><html><head><title>Sample Application - Applicant</title></head><body>
  <h1>Sample Application</h1>
  <h2>Step 1 of 2: Applicant</h2>
  <form onsubmit="return false">
    <label for="projName">Project Name</label><input id="projName" type="text">
    <div class="actions">
      <button type="button" aria-label="Proceed to details" onclick="logClick('decoy'); location.href='/apply/details';">Next</button>
      <button type="button" onclick="logClick('continue'); location.href='/apply/details';">Continue</button>
    </div>
  </form>
  <script>${LOG}</script>
</body></html>`;
const STEP2 = `<!doctype html><html><head><title>Sample Application - Details</title></head><body>
  <h1>Sample Application</h1>
  <h2>Step 2 of 2: Details</h2>
  <form onsubmit="return false">
    <label for="desc">Description of Work</label><textarea id="desc"></textarea>
  </form>
  <script>${LOG} logClick('details_shown');</script>
</body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://127.0.0.1");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(u.pathname === "/apply/details" ? STEP2 : STEP1);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const norm = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();
/** Healthy here is ~30-40 s (two looks at the absent control, ~18 s, then a re-plan); the
 *  regression stops in ~28 s, and main's timeout path took ~116 s. */
const DEADLINE_S = 150;

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
const page: Page = await ctx.newPage();

type Call = { url: string; chose: string; hint: string };
const calls: Call[] = [];
let step1Calls = 0;
const planner: LearnPlanner = async (req: LearnPlanRequest): Promise<LearnPlanResponse> => {
  const at = (re: RegExp, type?: string): number => req.fields.findIndex((f) => (!type || f.fieldType === type) && re.test(norm(f.label)));
  const call: Call = { url: new URL(req.url).pathname, chose: "", hint: norm(req.recoveryHint) };
  calls.push(call);
  const desc = at(/description of work/i);
  if (desc >= 0) { call.chose = "review"; return { fills: [{ selectorIndex: desc, value: "Sample scope of work" }], atReview: true }; }
  const name = at(/^project name$/i);
  const fills = name >= 0 ? [{ selectorIndex: name, value: "Sample Project" }] : [];
  step1Calls++;
  const next = at(/^proceed to details$/i, "button");
  const cont = at(/^continue$/i, "button");
  // The decoy first (the control whose selector matches nothing), Continue when asked again.
  const pickI = step1Calls === 1 && next >= 0 ? next : cont;
  call.chose = pickI >= 0 ? norm(req.fields[pickI].label) : "-";
  return { fills, atReview: false, ...(pickI >= 0 ? { advanceSelectorIndex: pickI } : {}) };
};

let r: Awaited<ReturnType<AutoLearnAdapter["learn"]>> | null = null;
let thrown = "";
let hung = false;
const T0 = Date.now();
try {
  await page.goto(`${base}/apply/applicant`);
  const adapter = new AutoLearnAdapter("Absent Advance Smoke", planner, { maxPages: 6 });
  (adapter as unknown as { page: unknown }).page = page;
  const learning = adapter.learn({} as never, {} as ProjectRecord).then((x) => { r = x; }, (e) => { thrown = String(e).slice(0, 300); });
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([learning, new Promise<void>((resolve) => { deadlineTimer = setTimeout(() => { hung = true; resolve(); }, DEADLINE_S * 1000); })]);
  if (deadlineTimer) clearTimeout(deadlineTimer);
  const tookS = Math.round((Date.now() - T0) / 1000);
  const clicked: string[] = page.isClosed() ? [] : await Promise.race([
    page.evaluate(() => JSON.parse(sessionStorage.getItem("absentSmoke") || "[]")).catch(() => []),
    new Promise<string[]>((res) => setTimeout(() => res([]), 3000)),
  ]) as string[];
  if (hung) { await browser.close().catch(() => null); await Promise.race([learning, new Promise((res) => setTimeout(res, 30_000))]); }
  const res = r as Awaited<ReturnType<AutoLearnAdapter["learn"]>> | null;
  const steps: RecipeStep[] = res?.steps ?? [];
  const events: Array<Record<string, unknown>> = (() => {
    try {
      return fs.readFileSync(path.join(adapter.debug?.dir ?? "", "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  })();
  const evTypes = events.map((e) => String(e.type));
  const absentEv = events.find((e) => e.type === "advance_control_absent");
  const trace = `took=${tookS}s clicked=${JSON.stringify(clicked)} calls=${JSON.stringify(calls.map((c) => `${c.url} -> ${c.chose}${c.hint ? ` [hint: ${c.hint.slice(0, 80)}]` : ""}`))} ` +
    `steps=${JSON.stringify(steps.map((s) => `${s.action}:${norm(s.note).slice(0, 40)}`))} ok=${res?.ok} reachedReview=${res?.reachedReview} stopReason=${res?.stopReason ?? "-"} message=${norm(res?.message ?? thrown).slice(0, 240)}`;

  // Without this the smoke passes vacuously: a planner that never names the decoy walks straight on.
  check("precondition: page 1's first plan named the decoy",
    calls[0]?.url === "/apply/applicant" && calls[0]?.chose === "Proceed to details", trace);
  check(`the walk ends on its own within ${DEADLINE_S} s`, !hung, trace);
  check("an absent advance control does not end the run (no 'Failed to click the advance button')",
    !/Failed to click the advance button/i.test(String(res?.message ?? thrown)), trace);
  check("the walk reaches page 2 and its review", !!res && res.ok === true && res.reachedReview === true && calls.some((c) => c.url === "/apply/details" && c.chose === "review"), trace);
  check("the absent control is NAMED as absent, never as a timeout",
    !!absentEv && /^Proceed to details$/.test(String(absentEv.label)) && !evTypes.includes("advance_timed_out"), `events=${JSON.stringify(evTypes)} | ${trace}`);
  check(`...in seconds, not at the click budget (${Number(absentEv?.tookMs ?? -1)} ms; bound 45 s)`,
    !!absentEv && Number(absentEv.tookMs) >= 0 && Number(absentEv.tookMs) <= 45_000, trace);
  check("it is recovered from as an advance that did nothing: banned, and page 1 planned again (Continue)",
    evTypes.includes("advance_did_nothing") && calls.filter((c) => c.url === "/apply/applicant").length >= 2 && calls.some((c) => c.url === "/apply/applicant" && c.chose === "Continue"),
    `events=${JSON.stringify(evTypes)} | ${trace}`);
  check("the decoy was never clicked; Continue was", !clicked.includes("decoy") && clicked.includes("continue") && clicked.includes("details_shown"), trace);
  const advNotes = steps.filter((s) => /^advance:/.test(norm(s.note))).map((s) => norm(s.note));
  check("the recipe records no click on the control that was never clicked, and one on Continue",
    !advNotes.includes("advance: Proceed to details") && advNotes.filter((n) => n === "advance: Continue").length === 1, trace);
  console.log(`  (took ${tookS} s)`);
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} absent-advance check(s) FAILED.`); process.exit(1); }
console.log("\nAll absent-advance checks passed (real Chromium, real AutoLearnAdapter.learn).");
process.exit(0);
