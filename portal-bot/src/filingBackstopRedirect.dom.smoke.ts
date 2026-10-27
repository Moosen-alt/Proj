// THE NETWORK BACKSTOP, ON A REDIRECT (#358, #371, hard rule 1).
//
// Handed on to the network, an allowed POST answered 307 / 308 is re-sent, body included, to the
// Location by Chromium — and Playwright never routes that second leg, so the payment rule and the
// filing-URL rule never saw where the data went. The backstop now pauses every response at the
// DevTools response stage (joinRedirectGuard) and judges every method-keeping hop's Location as a
// fresh request before Chromium follows it; Chromium keeps doing the follow (cookies, the body,
// the committed URL stay its own). Without that (judgePaused answering "continue" for every leg),
// every MUST-EXCLUDE cell below turns red: the target counts a hit.
//
// MUST-EXCLUDE (the target gets 0 hits, the refusal names the target):
//   pay307      — a "Next" form POST to /step/pay307, answered 307 → /payment (a fee payment)
//   file307     — the same, 307 → /SubmitApplication
//   file308     — the same, 308 → /api/SubmitApplication
//   chain       — 307 → /hop/a → 307 → /hop/b → 307 → /checkout/pay (every hop is judged)
//   xhrPay      — a fetch POST answered 307 → /payment/charge
//   put301      — a fetch PUT answered 301 (a PUT keeps its method) → /SubmitApplication
//   loop        — 307 to itself: followed MAX_REDIRECT_HOPS times, then refused (named, stopping)
//   ownWriteFile— the run's own write on a review page: its autosave answered 307 → /SubmitApplication
//   emptyFile   — a fetch POST with NO body (form media type) answered 307 → /SubmitApplication
//   upload      — an <input type=file> multipart upload answered 307 → /SubmitApplication (#371)
//   xhrPdf      — an XHR PUT of a picked PDF answered 307 → /SubmitApplication (#371)
//   unpicked    — a multipart form with an optional file input left empty, 307 → /SubmitApplication
//   xorigin     — a 307 to another origin's /SubmitApplication
//   popup       — a form posted into a target=_blank popup, 307 → /SubmitApplication
//   iframe      — a form in a cross-origin iframe, 307 → that origin's /SubmitApplication
//   (popup and iframe again on a persistent-profile launch)
//   drainFile   — the run's own save drain (openDrain): its XHR answered 307 → /SubmitApplication
//   lock        — the run's own write is sent, the run locks the page, then its 307 arrives
//   review307   — a 307 to /review: the review page's own POST is held by 4(b) (it lives at /review)
//   nonHttp     — a 307 to ftp: and to data: — refused, where = the scheme only (a data: payload
//                 never lands in the record); an unparseable http://[::1 is failed by Chromium itself
//   crossDoc    — BLOCKING 1: a slow own-write keepalive POST is answered 307 → /api/SubmitApplication
//                 only after the page moved to review, locked and opened the approved slot: the hop
//                 never takes the slot; the approved click files exactly once
//   crossDocPlain — the same with a plain Location: the hop does not take the slot, the click files
//   replay      — a recipe's "Next" that 307s to /payment: the replay STOPS, named, and says the
//                 first request reached the portal
//   preloaded*  — #394: the page is loaded BEFORE the backstop is installed (the learner's
//                 post-login page): its own autosave → /SubmitApplication, a fetch → /payment/charge,
//                 a 307 loop (each hop counted once), a cross-origin iframe's form and fetch
// MUST-PASS:
//   ok307       — 307 → /next-step: the body arrives there, the page is the next step
//   see303      — 303 → /next-step: the browser follows it as a GET
//   ownWriteOk  — the run's own write on a review page, autosave 307 → /Project/Autosave2: passes
//   lateAutosave— the same, the 307 arriving after the own-write grace closed: still passes
//   drainOk     — the run's own save drain, XHR 307 → /Project/Drain2 (drain closed first): passes
//   uploadOk    — an upload answered 307 → /upload2: its bytes arrive there (Chromium re-sends them)
//   xoriginOk   — a 307 to another origin: neither the first origin's cookie nor Authorization goes
//   rotate      — a 307 that rotates a cookie: the hop carries the new value
//   x308        — a 308 to /x/: the page commits at /x/, its relative action posts under /x/
//   fixtureRoute— a route below the backstop (a smoke's own fixture) still answers the POST
//
// Run: npx tsx portal-bot/src/filingBackstopRedirect.dom.smoke.ts
import "./smokeArtifactDirs";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../shared/src/types";
import { RecipeAdapter } from "./adapters/recipeAdapter";
import { type FilingBackstop, installFilingBackstop, MAX_REDIRECT_HOPS, withOwnWriteWindow } from "./filingBackstop";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

type Hit = { host: string; method: string; path: string; bytes: number; cookie: string; auth: string };
const hits: Hit[] = [];
const hitsOn = (p: string, host?: string): number => hits.filter((h) => h.path === p && (!host || h.host === host)).length;
// [status, Location, delay before answering (ms), extra headers]
const REDIRECTS: Record<string, [number, string, number?, Record<string, string>?]> = {
  "/step/pay307": [307, "/payment"],
  "/step/file307": [307, "/SubmitApplication"],
  "/step/file308": [308, "/api/SubmitApplication"],
  "/step/chain": [307, "/hop/a"],
  "/hop/a": [307, "/hop/b"],
  "/hop/b": [307, "/checkout/pay"],
  "/step/xhrPay": [307, "/payment/charge"],
  "/step/put301": [301, "/SubmitApplication"],
  "/step/loop": [307, "/step/loop"],
  "/step/emptyFile": [307, "/SubmitApplication"],
  "/step/ok307": [307, "/next-step"],
  "/step/see303": [303, "/next-step"],
  "/Project/AutosaveOk": [307, "/Project/Autosave2"],
  "/Project/AutosaveFile": [307, "/SubmitApplication"],
  "/Project/AutosaveLate": [307, "/Project/Autosave2", 2600],
  "/Project/AutosaveSlow": [307, "/Project/Autosave2", 900],
  "/Project/Drain": [307, "/Project/Drain2", 700],
  "/Project/DrainFile": [307, "/SubmitApplication", 700],
  "/upload": [307, "/SubmitApplication"],
  "/upload-ok": [307, "/upload2"],
  "/xhr-upload": [307, "/SubmitApplication"],
  "/step/unpicked": [307, "/SubmitApplication"],
  "/step/popup": [307, "/SubmitApplication"],
  "/step/iframe": [307, "/SubmitApplication"],
  "/step/rotate": [307, "/next-step", 0, { "set-cookie": "sess=rotated; Path=/" }],
  "/step/x308": [308, "/x/"],
  "/step/review307": [307, "/review"],
  "/step/ftp": [307, "ftp://127.0.0.1/drop"],
  "/step/data": [307, "data:text/plain,SYNTHETIC-PAYLOAD-358"],
  "/step/badurl": [307, "http://[::1"],
  "/Project/KeepFile": [307, "/api/SubmitApplication", 900],
  "/Project/KeepPlain": [307, "/Project/Saved", 900],
};
const NEXT_PAGE = "<!doctype html><html><body><h1>Step 4: Additional Information</h1><input id='x' aria-label='Notes'></body></html>";
const formPage = (action: string, extra = "", inner = ""): string => `<!doctype html><html><head><title>Portal</title></head><body>
  <h1>Step 3: Contacts</h1><label for="nm">Contact Name</label><input id="nm">
  <form id="hf" method="post" action="${action}" ${extra}><input name="a" value="synthetic-1">${inner}</form>
  <a id="next" href="#" onclick="document.getElementById('hf').submit();return false;">Next</a></body></html>`;
const REVIEW_PAGE = `<!doctype html><html><body><h1>Step 5: Review and Submit</h1><p>Please review your application before submitting.</p>
  <div><input type="checkbox" id="terms"> <label for="terms">I accept the terms and conditions</label></div>
  <form id="fs" method="post" action="/SubmitApplication"><input name="final" value="synthetic"></form>
  <button id="submit" onclick="setTimeout(() => document.getElementById('fs').submit(), 1500)">Submit Application</button></body></html>`;
// One handler for both origins (127.0.0.1 and 127.0.0.2), so a cross-origin hop is counted where it lands.
const handle = (host: string) => (req: http.IncomingMessage, res: http.ServerResponse): void => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const rec = (): void => { hits.push({ host, method: String(req.method), path: url.pathname, bytes: Buffer.concat(chunks).length, cookie: String(req.headers.cookie || ""), auth: String(req.headers.authorization || "") }); };
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": String(req.headers.origin || "*"), "access-control-allow-methods": "POST, PUT", "access-control-allow-headers": "authorization, content-type", "access-control-allow-credentials": "true" });
      res.end();
      return;
    }
    if (req.method !== "GET" || url.pathname === "/next-step") rec();
    const cors = req.headers.origin ? { "access-control-allow-origin": String(req.headers.origin), "access-control-allow-credentials": "true" } : {};
    const r = REDIRECTS[url.pathname];
    if (r && req.method !== "GET") {
      setTimeout(() => { res.writeHead(r[0], { location: r[1], ...cors, ...(r[3] || {}) }); res.end(); }, r[2] || 0);
      return;
    }
    res.writeHead(200, { "content-type": "text/html", ...cors });
    if (url.pathname === "/form") {
      const m = url.searchParams.get("m") || "";
      if (m === "upload" || m === "upload-ok") res.end(formPage(`/${m}`, `enctype="multipart/form-data"`, `<input type="file" name="plans">`));
      else if (m === "unpicked") res.end(formPage("/step/unpicked", `enctype="multipart/form-data"`, `<label>Optional attachment <input type="file" name="extra"></label>`));
      else if (m === "popup") res.end(formPage("/step/popup", `target="_blank"`));
      else if (m === "review") res.end(REVIEW_PAGE);
      else if (m === "xhr") res.end(`<!doctype html><html><body><h1>Step 3: Project Details</h1><p>Contacts</p></body></html>`);
      else if (m === "iframe") res.end(`<!doctype html><html><body><h1>Step 3: Contacts</h1><iframe id="f" src="${url.searchParams.get("src")}"></iframe></body></html>`);
      else res.end(formPage(`/step/${m}`));
      return;
    }
    if (url.pathname === "/frame") { res.end(formPage("/step/iframe")); return; }
    if (url.pathname === "/x/") { res.end(`<!doctype html><html><body><h1>Step 4: Site</h1><form id="hf" method="post" action="rel"><input name="b" value="2"></form></body></html>`); return; }
    if (url.pathname === "/review") {
      res.end(`<!doctype html><html><body><h1>Your application</h1><p>Name: Synthetic Person</p>
        <script>setTimeout(() => fetch("/Project/Track", { method: "POST", body: "seen=1" }).catch(() => null), 500);</script></body></html>`);
      return;
    }
    res.end(NEXT_PAGE);
  });
};
const server = http.createServer(handle("127.0.0.1"));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const server2 = http.createServer(handle("127.0.0.2"));
await new Promise<void>((r) => server2.listen(0, "127.0.0.2", () => r()));
const base2 = `http://127.0.0.2:${(server2.address() as { port: number }).port}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bs358-"));
const pdf = (name: string, n: number): string => { const f = path.join(tmp, name); fs.writeFileSync(f, Buffer.alloc(n, 0x25)); return f; };

const browser = await chromium.launch();
let persistent: BrowserContext | null = null;
try {
  type Out = { hits: Hit[]; url: string; body: string; aborts: FilingBackstop["aborts"]; stopping: FilingBackstop["aborts"]; actResult: unknown; judged: boolean; drainRequests: string[]; ownWriteRequests: string[]; approvedAdmissions: FilingBackstop["approvedAdmissions"] };
  // The backstop layer itself, on a fresh context (or the persistent-profile one); `act` drives it.
  // installAfter (#394): the page is loaded FIRST and the backstop installed on it after — the
  // learner's post-login page, the correction reopen's landing page.
  const run = async (m: string, act: (page: Page, bs: FilingBackstop) => Promise<unknown>, opts: { before?: (ctx: BrowserContext) => Promise<void>; ctx?: BrowserContext; formUrl?: string; installAfter?: boolean } = {}): Promise<Out> => {
    const ctx = opts.ctx ?? await browser.newContext();
    ctx.setDefaultTimeout(8000);
    if (opts.before) await opts.before(ctx);
    const page = await ctx.newPage();
    const url = opts.formUrl ?? `${base}/form?m=${m}`;
    let bs: FilingBackstop;
    if (opts.installAfter) {
      await page.goto(url);
      bs = (await installFilingBackstop(page, "redirect smoke"))!;
    } else {
      bs = (await installFilingBackstop(page, "redirect smoke"))!;
      await page.goto(url);
    }
    hits.length = 0;
    let actResult: unknown = null;
    try { actResult = await act(page, bs); } catch (e) { actResult = `threw ${String(e).slice(0, 160)}`; }
    await page.waitForTimeout(400);
    const out: Out = {
      hits: hits.slice(), url: page.url(), body: await page.textContent("body").catch(() => "") ?? "",
      aborts: bs.aborts.slice(), stopping: bs.stoppingAborts().slice(), actResult, judged: bs.redirectsJudged,
      drainRequests: bs.drainRequests.slice(), ownWriteRequests: bs.ownWriteRequests.slice(), approvedAdmissions: bs.approvedAdmissions.slice(),
    };
    await bs.dispose();
    if (opts.ctx) { for (const p of ctx.pages()) await p.close().catch(() => null); }
    else await ctx.close().catch(() => null);
    return out;
  };
  const clickNext = async (page: Page) => { await Promise.all([page.waitForLoadState("load").catch(() => null), page.click("#next")]); await page.waitForTimeout(600); };
  const show = (o: Pick<Out, "hits" | "aborts" | "url">) =>
    `hits=[${o.hits.map((h) => `${h.method} ${h.host === "127.0.0.2" ? "[2]" : ""}${h.path}`).join(",")}] aborts=[${o.aborts.map((a) => `${a.where} ${a.why}${a.redirect ? ` (via ${a.redirect.status} from ${a.redirect.from})` : ""}`).join(" | ")}] url=${o.url}`;
  const hopStop = (o: Out, target: string): boolean => o.stopping.some((a) => a.where.endsWith(target) && !!a.redirect);

  for (const [m, target] of [["pay307", "/payment"], ["file307", "/SubmitApplication"], ["file308", "/api/SubmitApplication"], ["chain", "/checkout/pay"]] as const) {
    const o = await run(m, clickNext);
    if (m === "pay307") check("the run's redirects are judged (the DevTools response pause joined)", o.judged);
    check(`MUST-EXCLUDE ${m}: nothing reaches ${target}`, hitsOn(target) === 0, show(o));
    check(`MUST-EXCLUDE ${m}: the refusal names ${target}, is a redirect of the request that went, and stops the run`, hopStop(o, target) && hitsOn(`/step/${m}`) === 1, show(o));
  }
  {
    const o = await run("chain", clickNext);
    check("chain: each hop before the payment was judged and sent (/step/chain, /hop/a, /hop/b), once each", ["/step/chain", "/hop/a", "/hop/b"].every((p) => o.hits.filter((h) => h.path === p).length === 1), show(o));
    check("chain: the refusal says it was redirect 3 in a row, from /hop/b", o.stopping.some((a) => a.redirect?.hop === 3 && a.redirect.from.endsWith("/hop/b")), show(o));
  }
  {
    const o = await run("xhr", (page) => page.evaluate(() => fetch("/step/xhrPay", { method: "POST", body: "x=1" }).then((r) => `status ${r.status}`, () => "rejected")));
    check("MUST-EXCLUDE xhrPay: a fetch POST's 307 never reaches /payment/charge, and the fetch fails", hitsOn("/payment/charge") === 0 && o.actResult === "rejected" && hopStop(o, "/payment/charge"), `${show(o)} act=${o.actResult}`);
  }
  {
    const o = await run("xhr", (page) => page.evaluate(() => fetch("/step/put301", { method: "PUT", body: "x=1" }).then((r) => `status ${r.status}`, () => "rejected")));
    check("MUST-EXCLUDE put301: a PUT keeps its method on a 301, so the hop is judged: nothing reaches /SubmitApplication", hitsOn("/SubmitApplication") === 0 && hopStop(o, "/SubmitApplication"), `${show(o)} act=${o.actResult}`);
  }
  {
    const o = await run("xhr", (page) => page.evaluate(() => fetch("/step/emptyFile", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" } }).then((r) => `status ${r.status}`, () => "rejected")));
    check("MUST-EXCLUDE emptyFile: a POST with no body is re-sent as an empty request, so its 307 is judged: nothing reaches /SubmitApplication", hitsOn("/SubmitApplication") === 0 && hitsOn("/step/emptyFile") === 1 && hopStop(o, "/SubmitApplication"), `${show(o)} act=${o.actResult}`);
  }
  {
    const o = await run("loop", clickNext);
    const sent = o.hits.filter((h) => h.path === "/step/loop").length;
    check(`MUST-EXCLUDE loop: a 307 to itself is followed ${MAX_REDIRECT_HOPS} times, then refused (named, stopping, not read as a filing)`,
      sent === MAX_REDIRECT_HOPS + 1 && o.stopping.some((a) => /more than \d+ redirects in a row/.test(a.why) && !/filing endpoint/.test(a.why)), `sent=${sent} ${show(o)}`);
  }
  {
    // THE RUN'S OWN WRITE ON A REVIEW PAGE: its autosave passes 4(b) through the own-write window —
    // and so does its redirect's hop, which keeps the exemption its first leg had; a hop to a filing
    // endpoint meets the filing-URL rule.
    const write = (to: string) => (page: Page) => withOwnWriteWindow(page, "Accept terms", () => page.evaluate((u) => fetch(u, { method: "POST", body: "terms=on" }).then((r) => `status ${r.status}`, () => "rejected"), to));
    const ok = await run("review", write("/Project/AutosaveOk"));
    check("MUST-PASS ownWriteOk: the run's own autosave on a review page, 307 → /Project/Autosave2, reaches it and nothing is aborted", hitsOn("/Project/Autosave2") === 1 && ok.aborts.length === 0 && ok.actResult === "status 200", `${show(ok)} act=${ok.actResult}`);
    const bad = await run("review", write("/Project/AutosaveFile"));
    check("MUST-EXCLUDE ownWriteFile: the same autosave 307 → /SubmitApplication never reaches it (filing-URL rule on the hop)", hitsOn("/SubmitApplication") === 0 && hopStop(bad, "/SubmitApplication"), `${show(bad)} act=${bad.actResult}`);
    // The 307 arrives 2.6 s later — after the 1.5 s own-write grace closed. The hop keeps its first
    // leg's exemption (Should-fix 1); judged live it would be held by 4(b) and the autosave lost.
    const late = await run("review", async (page) => {
      const t0 = Date.now();
      await withOwnWriteWindow(page, "Accept terms", async () => { await page.evaluate(() => { void fetch("/Project/AutosaveLate", { method: "POST", body: "terms=on" }).then((r) => { (globalThis as { __late?: string }).__late = `status ${r.status}`; }, () => { (globalThis as { __late?: string }).__late = "rejected"; }); }); });
      const closedAfter = Date.now() - t0;
      await page.waitForFunction(() => !!(globalThis as { __late?: string }).__late, null, { timeout: 8000 }).catch(() => null);
      return { closedAfter, result: await page.evaluate(() => (globalThis as { __late?: string }).__late) };
    });
    const lr = late.actResult as { closedAfter: number; result: string } | string;
    check("MUST-PASS lateAutosave: the window closed before the 307 came back (premise)", typeof lr === "object" && lr.closedAfter < 2400, JSON.stringify(lr));
    check("MUST-PASS lateAutosave: its 307 → /Project/Autosave2 still passes (the hop keeps its first leg's own-write exemption)",
      typeof lr === "object" && lr.result === "status 200" && hitsOn("/Project/Autosave2") === 1 && late.aborts.length === 0 && late.ownWriteRequests.length === 2, `${show(late)} act=${JSON.stringify(lr)} own=${late.ownWriteRequests.join(",")}`);
  }
  {
    // THE RUN'S OWN SAVE DRAIN on a review page (dryrun-0928 B3): the save goes through openDrain —
    // no own-write window — and the drain closes before its 307 comes back. The hop keeps the drain
    // exemption its first leg had; a hop to a filing endpoint meets the filing-URL rule.
    const drained = (to: string) => async (page: Page, bs: FilingBackstop) => {
      const close = bs.openDrain(page, "smoke drain");
      await page.evaluate((u) => { void fetch(u, { method: "POST", body: "batch=1" }).then((r) => { (globalThis as { __d?: string }).__d = `status ${r.status}`; }, () => { (globalThis as { __d?: string }).__d = "rejected"; }); }, to);
      await page.waitForTimeout(150);
      close();
      await page.waitForFunction(() => !!(globalThis as { __d?: string }).__d, null, { timeout: 8000 }).catch(() => null);
      return page.evaluate(() => (globalThis as { __d?: string }).__d);
    };
    const ok = await run("review", drained("/Project/Drain"));
    check("MUST-PASS drainOk: the drain's XHR, 307 → /Project/Drain2 after the drain closed, reaches it; both legs are drain requests, nothing aborted",
      ok.actResult === "status 200" && hitsOn("/Project/Drain2") === 1 && ok.aborts.length === 0 && ok.drainRequests.length === 2 && ok.drainRequests[1].endsWith("/Project/Drain2"), `${show(ok)} act=${ok.actResult} drain=${ok.drainRequests.join(",")}`);
    const bad = await run("review", drained("/Project/DrainFile"));
    check("MUST-EXCLUDE drainFile: the drain's XHR 307 → /SubmitApplication never reaches it", hitsOn("/SubmitApplication") === 0 && hitsOn("/Project/DrainFile") === 1 && hopStop(bad, "/SubmitApplication") && bad.drainRequests.length === 1, `${show(bad)} drain=${bad.drainRequests.join(",")}`);
  }
  {
    // THE STICKY LOCK (4a) on a hop: the run's own write goes out on an ordinary page, the run then
    // locks (it reached review), and only then does the write's 307 come back.
    const o = await run("xhr", async (page, bs) => {
      await withOwnWriteWindow(page, "Contact name", async () => { await page.evaluate(() => { void fetch("/Project/AutosaveSlow", { method: "POST", body: "n=1" }).catch(() => null); }); }, 100);
      await page.waitForTimeout(200);
      bs.lockReview("smoke reached review");
      await page.waitForTimeout(1200);
    });
    check("MUST-EXCLUDE lock: the first leg went before the lock (premise), its 307 after the lock never reaches /Project/Autosave2",
      hitsOn("/Project/AutosaveSlow") === 1 && hitsOn("/Project/Autosave2") === 0 && o.aborts.some((a) => a.rule === "review-lockdown" && a.where.endsWith("/Project/Autosave2") && !!a.redirect), show(o));
  }
  {
    const o = await run("ok307", clickNext);
    const leg = o.hits.find((h) => h.path === "/next-step");
    check("MUST-PASS ok307: an ordinary step's 307 is followed — the POST and its body reach /next-step, the page is the next step, no abort",
      !!leg && leg.method === "POST" && leg.bytes === "a=synthetic-1".length && /Step 4: Additional Information/.test(o.body) && /\/next-step$/.test(o.url) && o.aborts.length === 0, show(o));
  }
  {
    const o = await run("see303", clickNext);
    check("MUST-PASS see303: a 303 is followed by the browser as a GET to /next-step, no abort",
      o.hits.some((h) => h.method === "GET" && h.path === "/next-step") && /\/next-step$/.test(o.url) && o.aborts.length === 0, show(o));
  }
  {
    // #371: a picked file's bytes never reach interception — the redirect is still judged, because
    // the judging happens on the response, not on a re-sent body.
    const file = pdf("plans.pdf", 200_000);
    const o = await run("upload", async (page) => { await page.setInputFiles("input[type=file]", file); await clickNext(page); });
    const up = o.hits.find((h) => h.path === "/upload");
    check("MUST-EXCLUDE upload: an <input type=file> upload reaches /upload with its bytes, and its 307 never reaches /SubmitApplication",
      !!up && up.bytes > 200_000 && hitsOn("/SubmitApplication") === 0 && hopStop(o, "/SubmitApplication"), `upload bytes=${up?.bytes} ${show(o)}`);
    const okRun = await run("upload-ok", async (page) => { await page.setInputFiles("input[type=file]", file); await clickNext(page); });
    const up2 = okRun.hits.find((h) => h.path === "/upload2");
    check("MUST-PASS uploadOk: an upload's 307 → /upload2 is followed by Chromium with the file's bytes", !!up2 && up2.bytes > 200_000 && okRun.aborts.length === 0, `upload2 bytes=${up2?.bytes} ${show(okRun)}`);
  }
  {
    const file = pdf("plans2.pdf", 150_000);
    const o = await run("upload", async (page) => {
      await page.setInputFiles("input[type=file]", file);
      return page.evaluate(() => new Promise<string>((r) => { const x = new XMLHttpRequest(); x.open("PUT", "/xhr-upload"); x.onloadend = () => r(`status ${x.status}`); x.send((document.querySelector("input[type=file]") as HTMLInputElement).files![0]); }));
    });
    const up = o.hits.find((h) => h.path === "/xhr-upload");
    check("MUST-EXCLUDE xhrPdf: an XHR PUT of a picked PDF reaches /xhr-upload with its bytes, and its 307 never reaches /SubmitApplication",
      !!up && up.bytes === 150_000 && hitsOn("/SubmitApplication") === 0 && hopStop(o, "/SubmitApplication"), `upload bytes=${up?.bytes} act=${o.actResult} ${show(o)}`);
  }
  {
    const o = await run("unpicked", clickNext);
    check("MUST-EXCLUDE unpicked: a multipart form with an empty optional file input, 307 → /SubmitApplication: nothing reaches it",
      hitsOn("/step/unpicked") === 1 && hitsOn("/SubmitApplication") === 0 && hopStop(o, "/SubmitApplication"), show(o));
  }
  {
    // ANOTHER ORIGIN. A benign hop is followed by Chromium as on main: the first origin's HttpOnly
    // session cookie and the page's Authorization header never travel to 127.0.0.2.
    const withCookie = async (ctx: BrowserContext) => { await ctx.addCookies([{ name: "sess", value: "first-origin-secret", url: base, httpOnly: true }]); };
    REDIRECTS["/step/xorigin"] = [307, `${base2}/landing`];
    REDIRECTS["/step/xoriginFetch"] = [307, `${base2}/api/collect`];
    REDIRECTS["/step/xoriginFile"] = [307, `${base2}/SubmitApplication`];
    const nav = await run("xorigin", clickNext, { before: withCookie });
    const land = nav.hits.find((h) => h.host === "127.0.0.2" && h.path === "/landing");
    const first = nav.hits.find((h) => h.path === "/step/xorigin");
    check("MUST-PASS xoriginOk: the form POST's 307 to another origin arrives there, without the first origin's session cookie",
      !!first && /first-origin-secret/.test(first.cookie) && !!land && land.method === "POST" && !/first-origin-secret/.test(land.cookie) && nav.aborts.length === 0, `${show(nav)} cookies first=${first?.cookie} landing=${land?.cookie}`);
    const xhr = await run("xhr", (page) => page.evaluate(() => fetch("/step/xoriginFetch", { method: "POST", body: "x=1", headers: { authorization: "Bearer synthetic-358" }, credentials: "include" }).then((r) => `status ${r.status}`, () => "rejected")), { before: withCookie });
    const col = xhr.hits.filter((h) => h.host === "127.0.0.2" && h.path === "/api/collect");
    const firstX = xhr.hits.find((h) => h.path === "/step/xoriginFetch");
    check("MUST-PASS xoriginOk: a fetch's 307 to another origin carries neither the Authorization header nor the first origin's cookie",
      !!firstX && firstX.auth === "Bearer synthetic-358" && col.every((h) => h.auth === "" && !/first-origin-secret/.test(h.cookie)) && xhr.aborts.length === 0, `${show(xhr)} act=${xhr.actResult} collect=${JSON.stringify(col.map((h) => ({ m: h.method, a: h.auth, c: h.cookie })))}`);
    const bad = await run("xoriginFile", clickNext);
    check("MUST-EXCLUDE xorigin: a 307 to another origin's /SubmitApplication never reaches it", hitsOn("/SubmitApplication", "127.0.0.2") === 0 && hopStop(bad, "/SubmitApplication"), show(bad));
  }
  {
    const o = await run("rotate", clickNext, { before: async (ctx) => { await ctx.addCookies([{ name: "sess", value: "stale", url: base }]); } });
    const leg = o.hits.find((h) => h.path === "/next-step");
    check("MUST-PASS rotate: a 307 that sets a new cookie — the hop carries the new value, not the stale one",
      !!leg && /sess=rotated/.test(leg.cookie) && !/sess=stale/.test(leg.cookie) && o.aborts.length === 0, `${show(o)} cookie=${leg?.cookie}`);
  }
  {
    const o = await run("x308", async (page) => {
      await clickNext(page);
      const at = page.url();
      await Promise.all([page.waitForLoadState("load").catch(() => null), page.evaluate(() => (document.getElementById("hf") as HTMLFormElement).submit())]);
      await page.waitForTimeout(400);
      return at;
    });
    check("MUST-PASS x308: the page a 308 led to commits at /x/, and its relative action posts to /x/rel",
      /\/x\/$/.test(String(o.actResult)) && hitsOn("/x/rel") === 1 && o.aborts.length === 0, `${show(o)} committed=${o.actResult}`);
  }
  {
    const o = await run("review307", async (page) => { await clickNext(page); await page.waitForTimeout(900); });
    check("MUST-EXCLUDE review307: the page a 307 led to lives at /review, so its own POST is held by 4(b)",
      /\/review$/.test(o.url) && hitsOn("/Project/Track") === 0 && o.aborts.some((a) => a.rule === "review-lockdown" && a.where.endsWith("/Project/Track")), show(o));
  }
  {
    for (const [m, where] of [["ftp", "ftp:"], ["data", "data:"]] as const) {
      const o = await run(m, clickNext);
      const a = o.stopping.find((x) => !!x.redirect);
      check(`MUST-EXCLUDE nonHttp ${m}: the redirect is refused as one that cannot be judged, its where is ${where} only`,
        !!a && /cannot be judged/.test(a.why) && !/filing endpoint/.test(a.why) && a.where === where && !JSON.stringify(o.aborts).includes("SYNTHETIC-PAYLOAD"), show(o));
    }
    // An unparseable Location (http://[::1) never reaches the response pause as a redirect: Chromium
    // fails the response itself (net::ERR_INVALID_REDIRECT), so nothing is followed and no leg pauses
    // with a status to judge. Pinned so a Chromium that starts handing it over shows up here.
    const bad = await run("badurl", clickNext);
    check("MUST-EXCLUDE nonHttp badurl: an unparseable Location is not followed (Chromium fails it before any status reaches the pause)",
      bad.hits.length === 1 && bad.hits[0].path === "/step/badurl" && /^chrome-error:/.test(bad.url) && bad.aborts.every((a) => /cannot be judged/.test(a.why)), show(bad));
  }
  // POPUPS AND CROSS-ORIGIN FRAMES: the response pause is browser-wide, so their legs pause too.
  const popupCell = async (label: string, ctx?: BrowserContext) => {
    const o = await run("popup", async (page) => {
      const pop = page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null);
      await page.click("#next");
      const p = await pop;
      await page.waitForTimeout(900);
      return p ? "popup opened" : "no popup";
    }, { ctx });
    check(`MUST-EXCLUDE popup${label}: a form posted into a target=_blank popup, 307 → /SubmitApplication: nothing reaches it`,
      o.actResult === "popup opened" && hitsOn("/step/popup") === 1 && hitsOn("/SubmitApplication") === 0 && hopStop(o, "/SubmitApplication"), `${show(o)} act=${o.actResult}`);
  };
  const iframeCell = async (label: string, ctx?: BrowserContext) => {
    const o = await run("iframe", async (page) => {
      const frame = page.frames().find((f) => f.url().startsWith(base2));
      if (!frame) return "no frame";
      await frame.evaluate(() => (document.getElementById("hf") as HTMLFormElement).submit());
      await page.waitForTimeout(900);
      return "posted";
    }, { ctx, formUrl: `${base}/form?m=iframe&src=${encodeURIComponent(`${base2}/frame`)}` });
    check(`MUST-EXCLUDE iframe${label}: a cross-origin iframe's form, 307 → its /SubmitApplication: nothing reaches it`,
      o.actResult === "posted" && hitsOn("/step/iframe", "127.0.0.2") === 1 && hitsOn("/SubmitApplication", "127.0.0.2") === 0 && hopStop(o, "/SubmitApplication"), `${show(o)} act=${o.actResult}`);
  };
  await popupCell("");
  await iframeCell("");
  persistent = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "bs358-profile-")));
  check("persistent profile: context.browser() is there to pause on", !!persistent.browser());
  await popupCell(" (persistent profile)", persistent);
  await iframeCell(" (persistent profile)", persistent);
  {
    // BLOCKING 1 — A HOP NEVER TAKES THE APPROVED SLOT. The run's own keepalive autosave on step 3 is
    // answered 307 only after the page moved to review, the run locked it and opened the approved
    // slot: judged while the slot is open, the hop must not take it (it is not the clicked page's
    // request), so it meets the filing-URL rule / the lock; the person's own Submit, ~1.5 s after the
    // click, files exactly once.
    for (const [variant, first, target] of [["crossDoc", "/Project/KeepFile", "/api/SubmitApplication"], ["crossDocPlain", "/Project/KeepPlain", "/Project/Saved"]] as const) {
      const o = await run("xhr", async (page, bs) => {
        await withOwnWriteWindow(page, "Contact name", async () => { await page.evaluate((u) => { void fetch(u, { method: "POST", body: "street=synthetic", keepalive: true }).catch(() => null); }, first); }, 50);
        await page.goto(`${base}/form?m=review`);
        bs.lockReview("smoke at review");
        bs.allowApprovedFiling(10_000, { page });
        await page.click("#submit");
        await page.waitForURL(/\/SubmitApplication$/, { timeout: 6000 }).catch(() => null);
        await page.waitForTimeout(300);
      });
      check(`MUST-EXCLUDE ${variant}: the keepalive's first leg went (premise) and its 307 came back while the slot was open — nothing reaches ${target}`,
        hitsOn(first) === 1 && hitsOn(target) === 0 && o.aborts.some((a) => a.where.endsWith(target) && !!a.redirect), show(o));
      check(`MUST-PASS ${variant}: the approved click files exactly once, and the slot went to it`,
        hitsOn("/SubmitApplication") === 1 && o.approvedAdmissions.length === 1 && o.approvedAdmissions[0].where.endsWith("/SubmitApplication") && o.approvedAdmissions[0].navigation, `${show(o)} admitted=${JSON.stringify(o.approvedAdmissions)}`);
    }
  }
  {
    // #394 — A DOCUMENT LOADED BEFORE THE BACKSTOP. The browser-level response pause never re-binds
    // a document that had already committed, so the fetch / XHR of the page a run is handed already
    // loaded (the learner's post-login page) was followed unjudged. Each page open at install now
    // gets its own response pause too; without it every MUST-EXCLUDE cell here turns red.
    const write = (to: string) => (page: Page) => withOwnWriteWindow(page, "Accept terms", () => page.evaluate((u) => fetch(u, { method: "POST", body: "terms=on" }).then((r) => `status ${r.status}`, () => "rejected"), to));
    const bad = await run("review", write("/Project/AutosaveFile"), { installAfter: true });
    check("preloaded: the install page's already-loaded document is covered (redirectsJudged)", bad.judged, show(bad));
    check("MUST-EXCLUDE preloadedOwnWriteFile: on a review page loaded before install, the run's own autosave 307 → /SubmitApplication never reaches it",
      hitsOn("/Project/AutosaveFile") === 1 && hitsOn("/SubmitApplication") === 0 && hopStop(bad, "/SubmitApplication"), `${show(bad)} act=${bad.actResult}`);
    const pay = await run("xhr", (page) => page.evaluate(() => fetch("/step/xhrPay", { method: "POST", body: "x=1" }).then((r) => `status ${r.status}`, () => "rejected")), { installAfter: true });
    check("MUST-EXCLUDE preloadedXhrPay: a fetch POST of a page loaded before install, 307 → /payment/charge: nothing reaches it, the fetch fails",
      hitsOn("/step/xhrPay") === 1 && hitsOn("/payment/charge") === 0 && pay.actResult === "rejected" && hopStop(pay, "/payment/charge"), `${show(pay)} act=${pay.actResult}`);
    const ok = await run("review", write("/Project/AutosaveOk"), { installAfter: true });
    check("MUST-PASS preloadedOwnWriteOk: the same autosave 307 → /Project/Autosave2 reaches it once, nothing aborted",
      hitsOn("/Project/Autosave2") === 1 && ok.aborts.length === 0 && ok.actResult === "status 200", `${show(ok)} act=${ok.actResult}`);
    const loop = await run("xhr", (page) => page.evaluate(() => fetch("/step/loop", { method: "POST", body: "x=1" }).then((r) => `status ${r.status}`, () => "rejected")), { installAfter: true });
    const sent = hits.filter((h) => h.path === "/step/loop").length;
    check(`MUST-EXCLUDE preloadedLoop: a 307 to itself is followed ${MAX_REDIRECT_HOPS} times, then refused (every hop counted once)`,
      sent === MAX_REDIRECT_HOPS + 1 && loop.stopping.some((a) => /more than \d+ redirects in a row/.test(a.why)), `sent=${sent} ${show(loop)}`);
    const frame = await run("iframe", async (page) => {
      const f = page.frames().find((x) => x.url().startsWith(base2));
      if (!f) return "no frame";
      await f.evaluate(() => (document.getElementById("hf") as HTMLFormElement).submit());
      await page.waitForTimeout(900);
      return "posted";
    }, { installAfter: true, formUrl: `${base}/form?m=iframe&src=${encodeURIComponent(`${base2}/frame`)}` });
    check("MUST-EXCLUDE preloadedIframe: a cross-origin iframe loaded before install, its form 307 → its /SubmitApplication: nothing reaches it",
      frame.actResult === "posted" && hitsOn("/step/iframe", "127.0.0.2") === 1 && hitsOn("/SubmitApplication", "127.0.0.2") === 0 && hopStop(frame, "/SubmitApplication"), `${show(frame)} act=${frame.actResult}`);
    const xhrFrame = await run("iframe", async (page) => {
      const f = page.frames().find((x) => x.url().startsWith(base2));
      if (!f) return "no frame";
      return f.evaluate(() => fetch("/step/xhrPay", { method: "POST", body: "x=1" }).then((r) => `status ${r.status}`, () => "rejected"));
    }, { installAfter: true, formUrl: `${base}/form?m=iframe&src=${encodeURIComponent(`${base2}/frame`)}` });
    check("MUST-EXCLUDE preloadedIframeXhr: a fetch POST in a cross-origin iframe loaded before install, 307 → /payment/charge: nothing reaches it",
      hitsOn("/step/xhrPay", "127.0.0.2") === 1 && hitsOn("/payment/charge", "127.0.0.2") === 0 && xhrFrame.actResult === "rejected" && hopStop(xhrFrame, "/payment/charge"), `${show(xhrFrame)} act=${xhrFrame.actResult}`);
  }
  {
    let fixtureAnswered = 0;
    const o = await run("ok307", clickNext, { before: async (ctx) => {
      await ctx.route("**/step/ok307", (route) => { fixtureAnswered++; return route.fulfill({ contentType: "text/html", body: NEXT_PAGE }); });
    } });
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
    try { const r = await adapter.fillApplication({} as ProjectRecord); ok = r.ok; msg = String(r.message).slice(0, 600); }
    catch (e) { msg = `threw ${String(e).slice(0, 200)}`; }
    await page.waitForTimeout(400);
    check("MUST-EXCLUDE replay: a recipe's Next that 307s to /payment — nothing reaches /payment, the replay STOPS named",
      hitsOn("/payment") === 0 && !ok && /STOPPED BY THE NETWORK BACKSTOP/.test(msg) && msg.includes("/payment"), `ok=${ok} hits=[${hits.map((h) => h.path).join(",")}] ${msg}`);
    check("replay: the stop names the request that reached the portal (/step/pay307) and never says nothing was sent",
      msg.includes("/step/pay307") && /reached the portal/.test(msg) && !/Nothing was sent/i.test(msg), msg);
    await ctx.close().catch(() => null);
  }
} finally {
  await persistent?.close().catch(() => null);
  await browser.close().catch(() => null);
  server.close();
  server2.close();
}

if (failures) { console.error(`\nfilingBackstopRedirect: ${failures} FAILED`); process.exit(1); }
console.log("\nfilingBackstopRedirect: all checks passed");
