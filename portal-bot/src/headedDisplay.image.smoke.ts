// #434 — THE SERVER IMAGE CAN OPEN A HEADED WINDOW, AND THAT WINDOW IS STILL AUTOMATION'S.
//
// Some portals answer only a real browser window (coosbayor.gov: 403 headless, 200 headed), so
// staging and auto-learn retry ONCE headed on a bot block. The Docker image had no display server,
// so on Linux that launch failed before it started. The image now starts Xvfb from its entrypoint
// (scripts/docker-entrypoint.sh) and exports DISPLAY.
//
// Run INSIDE the built image (CI job "Server image", .github/workflows/ci.yml), through the image's
// own entrypoint, so the display under test is the one production gets:
//   docker run --rm <image> npx tsx portal-bot/src/headedDisplay.image.smoke.ts
// Also runs on any machine with a display (`xvfb-run npx tsx …` on Linux). It is not a *.dom.smoke.ts
// or a *.test.ts on purpose: neither runner may assume a display. scripts/run-dom-smokes.ts lists it
// in NOT_DOM_SMOKES, so the DOM suite reports it as skipped (with that reason), not unclassified.
//
//   [D] THE DISPLAY AND THE DEFAULT
//     D1  DISPLAY is set (the entrypoint started the virtual display).
//     D2  PORTAL_HEADLESS still defaults to headless: resolveHeadless() with no explicit value is
//         true. Only the bot-block retry asks for a window.
//   [H] A HEADED LAUNCH OPENS AND CLOSES CLEANLY
//     H1  chromium.launch({ headless: false }) opens, renders a page, is a real window (no
//         HeadlessChrome in its user agent), and closes.
//     H2  the retry's own door: openPortal({ headless: false, userDataDir }) — a persistent profile,
//         as staging uses — opens, loads a page, and closePortal releases it.
//   [S] RULE 1 UNDER THE VIRTUAL DISPLAY: THE #333 HAND-OVER STILL FAILS CLOSED
//   A headed window on Xvfb is automation's window: no person can see or click it. Each case runs on
//   a HEADED page on this display, against a local fixture portal on 127.0.0.1 that counts every
//   non-GET request it receives (so "0 POSTs" is what the server saw).
//     S1  (control) the input watch arms on the headed page, and a trusted input after the hand-over
//         lets that page's filing POST through — so S2-S4 holding is the backstop, not a dead page.
//     S2  automation's (fenced) click on Submit after the hand-over: aborted, 0 POSTs, not recorded
//         as a person's request.
//     S3  nobody touches the display for 5 s after the hand-over, then a page script posts the
//         filing: aborted, 0 POSTs, and personActedSinceHandOver is false (Xvfb makes no input).
//     S4  the input watch never armed: handOverToHuman refuses, and a trusted click is aborted.
//     S5  (#381) after the hand-over the portal's Submit asks confirm(): the dialog waits for a person
//         (personDialogs: automation never answers one), nobody on the virtual display answers it, so
//         it is still open 3 s later and nothing reached the portal.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { closePortal, openPortal, resolveHeadless } from "./browser";
import { installFilingBackstop, isStoppingAbort, type FilingBackstop } from "./filingBackstop";
import { dialogOpenOn, dialogsLeftToPerson } from "./personDialogs";

let failures = 0;
let total = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  total++;
  if (ok) console.log(`ok   - ${label}`);
  else { failures++; console.log(`FAIL - ${label}${detail ? `\n       ${detail}` : ""}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** A step that must finish: a hung launch or close is a failure, not a wait forever. */
async function within<T>(label: string, ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${label}: no answer in ${ms} ms`)), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}

// The fixture portal: a review page whose Submit posts a filing URL. Every non-GET is counted.
const posts: Array<{ k: string; path: string }> = [];
const REVIEW = (k: string): string => `<!doctype html><html><head><title>Review and Submit</title></head><body>
<h1>Step 4: Review and Submit</h1><p>Review your application before you submit it.</p>
<form method="post" action="/h/${k}/apply/submit"><button type="submit" id="btnSubmit" style="width:220px;height:60px">Submit Application</button></form>
</body></html>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);
  const k = parts[0] === "h" ? parts[1] || "" : "";
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") posts.push({ k, path: url.pathname });
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(req.method === "POST" ? "<h1>Thank you</h1><p>Your application has been submitted.</p>" : REVIEW(k));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const postsFor = (k: string, from: number): Array<{ k: string; path: string }> => posts.slice(from).filter((p) => p.k === k);

console.log("\n[D] THE DISPLAY AND THE DEFAULT");
check("D1 DISPLAY is set (the entrypoint started the virtual display)", !!process.env.DISPLAY, `DISPLAY=${process.env.DISPLAY ?? "(unset)"}`);
check("D2 PORTAL_HEADLESS still defaults to headless: resolveHeadless() is true", resolveHeadless() === true,
  `PORTAL_HEADLESS=${process.env.PORTAL_HEADLESS ?? "(unset)"}`);

console.log("\n[H] A HEADED LAUNCH OPENS AND CLOSES CLEANLY");
{
  let detail = "";
  let ok = false;
  try {
    const browser = await within("launch", 60_000, chromium.launch({ headless: false }));
    const page = await browser.newPage();
    await page.goto(`${base}/h/H1/review`);
    const ua = await page.evaluate(() => navigator.userAgent);
    const heading = await page.locator("h1").textContent();
    detail = `ua=${ua} heading=${heading}`;
    await within("close", 30_000, browser.close());
    ok = !/HeadlessChrome/i.test(ua) && /Review and Submit/.test(heading || "") && !browser.isConnected();
  } catch (e) { detail = String((e as Error)?.message ?? e).split("\n").slice(0, 8).join(" | "); }
  check("H1 chromium.launch({ headless: false }) opens a real window, renders, and closes", ok, detail);
}
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "headed-display-smoke-"));
{
  let detail = "";
  let ok = false;
  try {
    const opened = await within("openPortal", 60_000, openPortal({ headless: false, userDataDir: path.join(profileRoot, "h2") }));
    await opened.page.goto(`${base}/h/H2/review`);
    const ua = await opened.page.evaluate(() => navigator.userAgent);
    detail = `ua=${ua}`;
    await within("closePortal", 30_000, closePortal(opened));
    ok = !/HeadlessChrome/i.test(ua);
  } catch (e) { detail = String((e as Error)?.message ?? e).split("\n").slice(0, 8).join(" | "); }
  check("H2 openPortal({ headless: false, userDataDir }) — the retry's door — opens headed and closes", ok, detail);
}

console.log("\n[S] RULE 1 UNDER THE VIRTUAL DISPLAY: THE HAND-OVER STILL FAILS CLOSED");
const browser = await chromium.launch({ headless: false }).catch((e: unknown) => {
  check("S0 a headed browser launches for the hand-over cases", false, String((e as Error)?.message ?? e).split("\n")[0]);
  console.error(`\n${failures}/${total} headedDisplay.image.smoke check(s) FAILED.`);
  process.exit(1);
});
interface Bed { page: Page; bs: FilingBackstop; armed: boolean; close: () => Promise<void> }
/** A headed page at review, with the backstop installed before it loads, locked as a run locks it. */
async function bed(k: string, opts: { arm?: boolean } = {}): Promise<Bed> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const bs = await installFilingBackstop(page, `headed-display ${k}`);
  if (!bs) throw new Error("no backstop");
  await page.goto(`${base}/h/${k}/review`);
  bs.lockReview(`smoke ${k} at review`);
  let armed = false;
  if (opts.arm !== false) {
    armed = await bs.watchHumanInput();
    if (armed) bs.handOverToHuman(`smoke ${k}`);
  }
  return { page, bs, armed, close: async () => { await bs.dispose().catch(() => null); await ctx.close().catch(() => null); } };
}
/** A trusted click at the control's centre, with no fence: the shape of a person's click. */
async function rawClick(page: Page): Promise<void> {
  const box = await page.locator("#btnSubmit").boundingBox();
  if (!box) throw new Error("no box for #btnSubmit");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
const brief = (b: Bed, k: string, from: number): string => JSON.stringify({
  armed: b.armed, posts: postsFor(k, from).map((p) => p.path),
  aborts: b.bs.aborts.map((a) => ({ rule: a.rule, where: a.where.replace(base, ""), human: !!a.humanInput })),
  humanRequests: b.bs.humanRequests.map((r) => r.where.replace(base, "")),
}).slice(0, 600);
{
  const from = posts.length;
  const b = await bed("S1");
  await rawClick(b.page);
  await sleep(900);
  check("S1 (control) the watch arms on a headed page, and a trusted input after the hand-over lets its filing POST through",
    b.armed && postsFor("S1", from).filter((p) => /\/apply\/submit$/.test(p.path)).length === 1, brief(b, "S1", from));
  await b.close();
}
{
  const from = posts.length;
  const b = await bed("S2");
  await b.bs.withAutomationInput(b.page, () => b.page.locator("#btnSubmit").click());
  await sleep(900);
  check("S2 automation's (fenced) click after the hand-over on the virtual display: aborted, 0 POSTs, not the person's",
    b.armed && postsFor("S2", from).length === 0 && b.bs.aborts.some((a) => isStoppingAbort(a) && !a.humanInput)
      && b.bs.humanRequests.length === 0, brief(b, "S2", from));
  await b.close();
}
{
  const from = posts.length;
  const b = await bed("S3");
  await sleep(5_000);
  const acted = b.bs.personActedSinceHandOver(b.page);
  await b.page.evaluate(() => { void fetch("apply/submit", { method: "POST", body: "auto=1" }).catch(() => null); });
  await sleep(900);
  check("S3 nobody can touch the virtual display: no input in 5 s, and a page script's filing POST is aborted",
    b.armed && !acted && postsFor("S3", from).length === 0 && b.bs.aborts.length > 0 && b.bs.humanRequests.length === 0,
    `acted=${acted} ${brief(b, "S3", from)}`);
  await b.close();
}
{
  const from = posts.length;
  const b = await bed("S4", { arm: false });
  const handed = b.bs.handOverToHuman("smoke S4");
  await rawClick(b.page);
  await sleep(900);
  check("S4 the input watch never armed: handOverToHuman refuses, and a trusted click is aborted",
    handed === false && postsFor("S4", from).length === 0, `handed=${handed} ${brief(b, "S4", from)}`);
  await b.close();
}

{
  const from = posts.length;
  const b = await bed("S5");
  // The portal's own confirm-then-submit, as a page script runs it (a timer, so evaluate returns
  // before the dialog blocks the page).
  await b.page.evaluate(() => {
    setTimeout(() => { if (window.confirm("Submit this application?")) (document.forms[0] as HTMLFormElement).submit(); }, 0);
  });
  await sleep(3_000);
  const open = dialogOpenOn(b.page);
  check("S5 a confirm() after the hand-over waits for a person: still open 3 s later on the virtual display, 0 POSTs",
    b.armed && dialogsLeftToPerson(b.page) && open && postsFor("S5", from).length === 0,
    `leftToPerson=${dialogsLeftToPerson(b.page)} open=${open} ${brief(b, "S5", from)}`);
  await b.close();
}

await browser.close().catch(() => null);
server.close();
try { fs.rmSync(profileRoot, { recursive: true, force: true }); } catch { /* best effort */ }
if (failures) { console.error(`\n${failures}/${total} headedDisplay.image.smoke check(s) FAILED.`); process.exit(1); }
console.log(`\nAll ${total} headedDisplay.image.smoke checks passed.`);
process.exit(0);
