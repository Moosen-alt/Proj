// THE NETWORK BACKSTOP, ON A REDIRECT (#358, hard rule 1).
//
// Handed on to the network, an allowed POST answered 307 / 308 is re-sent, body included, to the
// Location by the browser — and Playwright never routes that second leg, so the payment rule and
// the filing-URL rule never saw where the data went. The backstop now sends an allowed request
// itself (maxRedirects 0) and judges every method-keeping hop's Location as a fresh request.
// Without that (forward in filingBackstop.ts handing on with fallback()), every MUST-EXCLUDE cell
// below turns red: the target counts a hit.
//
// MUST-EXCLUDE (the target gets 0 hits, the abort names the target):
//   pay307      — a "Next" form POST to /step/pay307, answered 307 → /payment (a fee payment)
//   file307     — the same, 307 → /SubmitApplication
//   file308     — the same, 308 → /api/SubmitApplication
//   chain       — 307 → /hop/a → 307 → /hop/b → 307 → /checkout/pay (every hop is judged)
//   xhrPay      — a fetch POST answered 307 → /payment/charge
//   put301      — a fetch PUT answered 301 (a PUT keeps its method) → /SubmitApplication
//   loop        — 307 to itself: followed MAX_REDIRECT_HOPS times, then aborted (named, stopping)
//   ownWriteFile— the run's own write on a review page: its autosave answered 307 → /SubmitApplication
//   dies        — the server drops the connection: the request is ABORTED, never re-sent unjudged
//   replay      — a recipe's "Next" that 307s to /payment: the replay STOPS, named
// MUST-PASS:
//   ok307       — 307 → /next-step: the body arrives there, the page is the next step
//   see303      — 303 → /next-step: the browser follows it as a GET
//   ownWriteOk  — the run's own write on a review page, autosave 307 → /Project/Autosave2: passes
//   upload      — an <input type=file> multipart upload arrives with its bytes (handed on as before)
//   fixtureRoute— a route below the backstop (a smoke's own fixture) still answers the POST
//
// Run: npx tsx portal-bot/src/filingBackstopRedirect.dom.smoke.ts
import "./smokeArtifactDirs";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../shared/src/types";
import { RecipeAdapter } from "./adapters/recipeAdapter";
import { installFilingBackstop, MAX_REDIRECT_HOPS, withOwnWriteWindow } from "./filingBackstop";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const hits: Array<{ method: string; path: string; bytes: number }> = [];
const hitsOn = (p: string): number => hits.filter((h) => h.path === p).length;
const REDIRECTS: Record<string, [number, string]> = {
  "/step/pay307": [307, "/payment"],
  "/step/file307": [307, "/SubmitApplication"],
  "/step/file308": [308, "/api/SubmitApplication"],
  "/step/chain": [307, "/hop/a"],
  "/hop/a": [307, "/hop/b"],
  "/hop/b": [307, "/checkout/pay"],
  "/step/xhrPay": [307, "/payment/charge"],
  "/step/put301": [301, "/SubmitApplication"],
  "/step/loop": [307, "/step/loop"],
  "/step/ok307": [307, "/next-step"],
  "/step/see303": [303, "/next-step"],
  "/Project/AutosaveOk": [307, "/Project/Autosave2"],
  "/Project/AutosaveFile": [307, "/SubmitApplication"],
};
const NEXT_PAGE = "<!doctype html><html><body><h1>Step 4: Additional Information</h1><input id='x' aria-label='Notes'></body></html>";
const formPage = (action: string, extra = ""): string => `<!doctype html><html><head><title>Portal</title></head><body>
  <h1>Step 3: Contacts</h1><label for="nm">Contact Name</label><input id="nm">
  <form id="hf" method="post" action="${action}" ${extra}><input name="a" value="synthetic-1"></form>
  <a id="next" href="#" onclick="document.getElementById('hf').submit();return false;">Next</a></body></html>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    if (req.method !== "GET") hits.push({ method: String(req.method), path: url.pathname, bytes: Buffer.concat(chunks).length });
    else if (url.pathname === "/next-step") hits.push({ method: "GET", path: url.pathname, bytes: 0 });
    const r = REDIRECTS[url.pathname];
    if (r && req.method !== "GET") { res.writeHead(r[0], { location: r[1] }); res.end(); return; }
    if (url.pathname === "/step/dies") { req.socket.destroy(); return; }
    if (url.pathname === "/form") {
      const m = url.searchParams.get("m") || "";
      res.writeHead(200, { "content-type": "text/html" });
      if (m === "upload") res.end(formPage("/upload", `enctype="multipart/form-data"`).replace("</form>", `<input type="file" name="plans"></form>`));
      else if (m === "review") res.end(`<!doctype html><html><body><h1>Step 5: Review and Submit</h1><p>Please review your application before submitting.</p>
        <div><input type="checkbox" id="terms"> <label for="terms">I accept the terms and conditions</label></div></body></html>`);
      else if (m === "xhr") res.end(`<!doctype html><html><body><h1>Step 3: Project Details</h1><p>Contacts</p></body></html>`);
      else res.end(formPage(`/step/${m}`));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(NEXT_PAGE);
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const browser = await chromium.launch();
try {
  // The backstop layer itself, on a fresh context; `act` drives the page.
  const run = async (m: string, act: (page: Page) => Promise<unknown>, before?: (ctx: import("playwright").BrowserContext) => Promise<void>) => {
    const ctx = await browser.newContext();
    ctx.setDefaultTimeout(8000);
    if (before) await before(ctx);
    const page = await ctx.newPage();
    const bs = (await installFilingBackstop(page, "redirect smoke"))!;
    hits.length = 0;
    await page.goto(`${base}/form?m=${m}`);
    hits.length = 0;
    let actResult: unknown = null;
    try { actResult = await act(page); } catch (e) { actResult = `threw ${String(e).slice(0, 160)}`; }
    await page.waitForTimeout(400);
    const out = {
      hits: hits.slice(), url: page.url(), body: await page.textContent("body").catch(() => "") ?? "",
      aborts: bs.aborts.slice(), stopping: bs.stoppingAborts().slice(), failures: bs.forwardFailures.slice(), actResult,
    };
    await bs.dispose();
    await ctx.close().catch(() => null);
    return out;
  };
  const clickNext = async (page: Page) => { await Promise.all([page.waitForLoadState("load").catch(() => null), page.click("#next")]); await page.waitForTimeout(600); };
  const show = (o: { hits: Array<{ method: string; path: string }>; aborts: Array<{ where: string; why: string }>; url: string }) =>
    `hits=[${o.hits.map((h) => `${h.method} ${h.path}`).join(",")}] aborts=[${o.aborts.map((a) => `${a.where} ${a.why}`).join(" | ")}] url=${o.url}`;

  for (const [m, target] of [["pay307", "/payment"], ["file307", "/SubmitApplication"], ["file308", "/api/SubmitApplication"], ["chain", "/checkout/pay"]] as const) {
    const o = await run(m, clickNext);
    check(`MUST-EXCLUDE ${m}: nothing reaches ${target}`, hitsOn(target) === 0 && !o.hits.some((h) => h.path === target), show(o));
    check(`MUST-EXCLUDE ${m}: the abort names ${target} and stops the run`, o.stopping.some((a) => a.where.endsWith(target)), show(o));
  }
  {
    const o = await run("chain", clickNext);
    check("chain: each hop before the payment was judged and sent (/step/chain, /hop/a, /hop/b), once each", ["/step/chain", "/hop/a", "/hop/b"].every((p) => o.hits.filter((h) => h.path === p).length === 1), show(o));
  }
  {
    const o = await run("xhr", (page) => page.evaluate(() => fetch("/step/xhrPay", { method: "POST", body: "x=1" }).then((r) => `status ${r.status}`, () => "rejected")));
    check("MUST-EXCLUDE xhrPay: a fetch POST's 307 never reaches /payment/charge, and the fetch fails", hitsOn("/payment/charge") === 0 && o.actResult === "rejected" && o.stopping.some((a) => a.where.endsWith("/payment/charge")), `${show(o)} act=${o.actResult}`);
  }
  {
    const o = await run("xhr", (page) => page.evaluate(() => fetch("/step/put301", { method: "PUT", body: "x=1" }).then((r) => `status ${r.status}`, () => "rejected")));
    check("MUST-EXCLUDE put301: a PUT keeps its method on a 301, so the hop is judged: nothing reaches /SubmitApplication", hitsOn("/SubmitApplication") === 0 && o.stopping.some((a) => a.where.endsWith("/SubmitApplication")), `${show(o)} act=${o.actResult}`);
  }
  {
    const o = await run("loop", clickNext);
    const sent = o.hits.filter((h) => h.path === "/step/loop").length;
    check(`MUST-EXCLUDE loop: a 307 to itself is followed ${MAX_REDIRECT_HOPS} times, then aborted (named, stopping)`, sent === MAX_REDIRECT_HOPS + 1 && o.stopping.some((a) => /past \d+ hops/.test(a.why)), `sent=${sent} ${show(o)}`);
  }
  {
    // THE RUN'S OWN WRITE ON A REVIEW PAGE: its autosave passes 4(b) through the own-write window —
    // and so does its redirect's hop, judged as a fresh request in the same window; a hop to a filing
    // endpoint meets the filing-URL rule.
    const write = (to: string) => (page: Page) => withOwnWriteWindow(page, "Accept terms", () => page.evaluate((u) => fetch(u, { method: "POST", body: "terms=on" }).then((r) => `status ${r.status}`, () => "rejected"), to));
    const ok = await run("review", write("/Project/AutosaveOk"));
    check("MUST-PASS ownWriteOk: the run's own autosave on a review page, 307 → /Project/Autosave2, reaches it and nothing is aborted", hitsOn("/Project/Autosave2") === 1 && ok.aborts.length === 0 && ok.actResult === "status 200", `${show(ok)} act=${ok.actResult}`);
    const bad = await run("review", write("/Project/AutosaveFile"));
    check("MUST-EXCLUDE ownWriteFile: the same autosave 307 → /SubmitApplication never reaches it (filing-URL rule on the hop)", hitsOn("/SubmitApplication") === 0 && bad.stopping.some((a) => a.where.endsWith("/SubmitApplication")), `${show(bad)} act=${bad.actResult}`);
  }
  {
    const o = await run("dies", clickNext);
    check("MUST-EXCLUDE dies: a send that fails is aborted and recorded — sent once, never handed on unjudged", hitsOn("/step/dies") === 1 && o.failures.some((f) => f.where.endsWith("/step/dies")), `${show(o)} failures=${JSON.stringify(o.failures)}`);
  }
  {
    const o = await run("ok307", clickNext);
    const leg = o.hits.find((h) => h.path === "/next-step");
    check("MUST-PASS ok307: an ordinary step's 307 is followed — the POST and its body reach /next-step, the page is the next step, no abort",
      !!leg && leg.method === "POST" && leg.bytes === "a=synthetic-1".length && /Step 4: Additional Information/.test(o.body) && o.aborts.length === 0, show(o));
  }
  {
    const o = await run("see303", clickNext);
    check("MUST-PASS see303: a 303 is followed by the browser as a GET to /next-step, no abort",
      o.hits.some((h) => h.method === "GET" && h.path === "/next-step") && /\/next-step$/.test(o.url) && o.aborts.length === 0, show(o));
  }
  {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bs358-")), "plans.pdf");
    fs.writeFileSync(file, Buffer.alloc(200_000, 0x25));
    const o = await run("upload", async (page) => { await page.setInputFiles("input[type=file]", file); await clickNext(page); });
    const up = o.hits.find((h) => h.path === "/upload");
    check("MUST-PASS upload: an <input type=file> upload reaches the server with its bytes (Chromium does not give interception the file, so it is handed on as before)",
      !!up && up.bytes > 200_000 && o.aborts.length === 0, `upload bytes=${up?.bytes} ${show(o)}`);
  }
  {
    let fixtureAnswered = 0;
    const o = await run("ok307", clickNext, async (ctx) => {
      await ctx.route("**/step/ok307", (route) => { fixtureAnswered++; return route.fulfill({ contentType: "text/html", body: NEXT_PAGE }); });
    });
    check("MUST-PASS fixtureRoute: a route below the backstop still answers the allowed POST (nothing reaches the server)",
      fixtureAnswered === 1 && o.hits.length === 0 && /Step 4: Additional Information/.test(o.body), `fixture=${fixtureAnswered} ${show(o)}`);
  }
  {
    // A REPLAY whose recorded "Next" posts to a step that 307s to the fee payment (/payment).
    const recipe = {
      id: "redirect", scopeType: "ahj", profileKey: "or|x|", state: "OR", ahj: "X", utility: "",
      portalPlatform: "fixture", portalUrl: `${base}/form?m=pay307`, status: "complete", version: 1, createdBy: "s", createdAt: "", updatedAt: "", notes: "",
      steps: [
        { action: "goto", value: `${base}/form?m=pay307`, note: "open" },
        { action: "click", selector: { css: "#next", role: "link", name: "Next" }, note: "advance: Next" },
        { action: "stopForReview" },
      ] as RecipeStep[],
    } as unknown as PortalRecipe;
    const ctx = await browser.newContext();
    ctx.setDefaultTimeout(5000);
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await ctx.newPage();
    const adapter = new RecipeAdapter(recipe, {}, {}, {} as never);
    (adapter as unknown as { page: unknown }).page = page;
    hits.length = 0;
    let ok = false;
    let msg = "";
    try { const r = await adapter.fillApplication({} as ProjectRecord); ok = r.ok; msg = String(r.message).slice(0, 400); }
    catch (e) { msg = `threw ${String(e).slice(0, 200)}`; }
    await page.waitForTimeout(400);
    check("MUST-EXCLUDE replay: a recipe's Next that 307s to /payment — nothing reaches /payment, the replay STOPS named",
      hitsOn("/payment") === 0 && !ok && /STOPPED BY THE NETWORK BACKSTOP/.test(msg) && msg.includes("/payment"), `ok=${ok} hits=[${hits.map((h) => h.path).join(",")}] ${msg}`);
    await ctx.close().catch(() => null);
  }
} finally {
  await browser.close().catch(() => null);
  server.close();
}

if (failures) { console.error(`\nfilingBackstopRedirect: ${failures} FAILED`); process.exit(1); }
console.log("\nfilingBackstopRedirect: all checks passed");
