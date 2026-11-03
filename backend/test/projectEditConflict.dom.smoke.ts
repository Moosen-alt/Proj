// THE CONFLICT, ON SCREEN — real Chromium, the real dashboard, a real server (#440, shared server #429).
//
// projectEditVersion.test.ts proves the server refuses a stale save. This proves the page tells the
// person and loses nothing:
//   1. Editor A opens a project and types a job value into the manual-entry form (unsaved).
//   2. Teammate B saves the same project (a phone number) from elsewhere.
//   3. A clicks Save: the page shows "someone else changed this project", the save wrote nothing,
//      A's typed job value is STILL in the form, and B's phone number is now shown (reloaded).
//   4. A clicks Save again, with B's change in view: it saves, and B's phone number survives.
//
// Discovered by scripts/run-dom-smokes.ts (*.dom.smoke.ts). Direct:
//   npx tsx backend/test/projectEditConflict.dom.smoke.ts
// Synthetic data only; the page is kept off the network (every non-local request is aborted).
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { chromium } from "playwright";
import { REPO } from "./_isolate";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("project-edit-conflict-dom");
const { db, repo } = fx;
const snap = (pid: string) =>
  JSON.parse(db.get<{ parser_json: string }>("SELECT parser_json FROM projects WHERE id = ?", [pid])!.parser_json) as Record<string, unknown>;

const pid = fx.newProject();
repo.updateProject(db, pid, { homeownerPhone: "(503) 555-0001" });

const dbPath = String(process.env.AUTOPILOT_DB_PATH);
const PORT = 5430 + Math.floor(Math.random() * 15); // never 4173 / 4270
const BASE = `http://127.0.0.1:${PORT}`;
const env: Record<string, string | undefined> = {
  ...process.env, AUTOPILOT_DB_PATH: dbPath, PORT: String(PORT), AUTOPILOT_AUTO_START: "0", SEED_TEST_INSTALLER: "false",
  MONITOR_INTERVAL_MINUTES: "0", LOG_LEVEL: "warn", ANTHROPIC_API_KEY: "", CODE_RESEARCH: "off", BACKGROUND_WORKERS: "off",
  SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
  AUTH_ENABLED: "false", NO_PROXY: "*", no_proxy: "*", AUTOPILOT_TEST_SEAMS: "",
  // The isolated cwd has no frontend/: serve the REAL shipped files.
  FRONTEND_DIR: path.join(REPO, "frontend"),
};
delete env.PORTAL_ALLOW_FINAL_SUBMIT;
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
const server = spawn(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "backend/src/server.ts")], {
  env: env as NodeJS.ProcessEnv, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout?.on("data", (d) => { serverLog += String(d); });
server.stderr?.on("data", (d) => { serverLog += String(d); });

const browser = await chromium.launch({ headless: true });
try {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up yet */ }
    if (i === 89) throw new Error(`server never came up:\n${serverLog.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  await ctx.route("**/*", (route) => (route.request().url().startsWith(BASE) ? route.continue() : route.abort()));
  const page = await ctx.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto(`${BASE}/#/project/${pid}`);
  // The project is open once its parsed phone number is in the form.
  try {
    await page.waitForFunction(() => (document.getElementById("manualHomeownerPhone") as HTMLInputElement | null)?.value === "(503) 555-0001", null, { timeout: 60_000 });
  } catch (err) {
    const probe = await page.evaluate(() => ({ hash: location.hash, phone: (document.getElementById("manualHomeownerPhone") as HTMLInputElement | null)?.value, detailHidden: document.getElementById("detailView")?.hidden, msg: document.getElementById("message")?.textContent, body: document.body.innerText.slice(0, 600) }));
    throw new Error(`the project never opened: ${JSON.stringify(probe)} errors=${pageErrors.join(" | ")}`);
  }
  // The form sits inside nested folds (the Submit stage, the record panel, the project-data accordion).
  await page.evaluate(() => {
    for (let d = document.getElementById("manualEntryForm")?.closest("details"); d; d = d.parentElement?.closest("details") ?? null) (d as HTMLDetailsElement).open = true;
  });

  await check("1-3. a stale save shows the conflict, writes nothing, keeps the typed value, and shows the teammate's change", async () => {
    // A types (unsaved) and moves on.
    await page.fill("#manualJobValue", "31500");
    await page.locator("#manualDescription").focus();
    await page.locator("#manualDescription").blur();
    // B saves the same project from elsewhere (no version: as another tab or the parser would).
    const b = await fetch(`${BASE}/api/projects/${pid}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ homeownerPhone: "(503) 555-0777" }) });
    assert.equal(b.status, 200, await b.text());
    // Every text the page banner shows from here on. A later refresh (an SSE refetch of the open
    // project) clears the banner, as it clears any message, so it is read as a history, not polled;
    // the status line beside Save is the one that stays.
    await page.evaluate(() => {
      const el = document.getElementById("message")!;
      const seen: string[] = ((window as unknown as { __bannerSeen: string[] }).__bannerSeen = []);
      new MutationObserver(() => { if (!el.hidden && el.textContent) seen.push(el.textContent); }).observe(el, { childList: true, characterData: true, subtree: true, attributes: true });
    });
    // A saves.
    const conflict = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${pid}`) && r.request().method() === "PUT");
    await page.click("#saveManualEntryBtn");
    assert.equal((await conflict).status(), 409, "A's stale save was not refused by the server");
    await page.waitForFunction(() => /someone else changed this project/.test(document.getElementById("manualEntryStatus")?.textContent || ""), null, { timeout: 30_000 });
    const banners = await page.evaluate(() => (window as unknown as { __bannerSeen: string[] }).__bannerSeen);
    const banner = banners.find((t) => /someone else changed this project/.test(t));
    assert.ok(banner, `the page banner never showed the conflict: ${JSON.stringify(banners)}`);
    assert.match(banner!, /your unsaved entries are still in the form/);
    assert.equal(await page.inputValue("#manualJobValue"), "31500", "A's unsaved job value was lost on reload");
    await page.waitForFunction(() => (document.getElementById("manualHomeownerPhone") as HTMLInputElement | null)?.value === "(503) 555-0777", null, { timeout: 30_000 });
    assert.equal(snap(pid).jobValue === "31500", false, "MUST-EXCLUDE: the refused save wrote A's job value");
    assert.equal(snap(pid).homeownerPhone, "(503) 555-0777", "B's save was overwritten");
  });

  await check("4. saving again, with the teammate's change in view, goes through and keeps both", async () => {
    const saved = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${pid}`) && r.request().method() === "PUT");
    await page.click("#saveManualEntryBtn");
    assert.equal((await saved).status(), 200, "the deliberate re-save was refused");
    await page.waitForFunction(() => (document.getElementById("manualEntryStatus")?.textContent || "") === "Saved.", null, { timeout: 30_000 });
    const s = snap(pid);
    assert.match(String(s.jobValue), /31,?500/, `A's job value did not save: ${s.jobValue}`);
    assert.equal(s.homeownerPhone, "(503) 555-0777", "the re-save threw away B's phone number");
  });

  await check("the page threw no errors", async () => {
    assert.deepEqual(pageErrors, []);
  });
} finally {
  await browser.close().catch(() => null);
  server.kill("SIGTERM");
}

finish("project-edit-conflict-dom");
