// THE INFORMATION-PAGE PASS AT THE NETWORK BACKSTOP, IN REAL CHROMIUM (#344, option B).
//
// The backstop is installed directly on a scrubbed DevHub-like replica (portal-bot/src/adapters/
// infoPageFixture.ts: one multipart SmartGuide form posting to its own path, Previous / Next as
// named submit buttons) — no learner, so each door is pinned on its own:
//   [A] UNVERIFIED: openInfoPagePass refuses ("no verified information page matches") and opens a
//       WATCH; Next's multipart POST is HELD exactly as on main (review-lockdown, document,
//       stopping); the watch observed {POST, the action, multipart, [[t_n…, sha('')]]}; the server
//       saw no POST.
//   [B] VERIFIED (the entry built from [A]'s candidate by verifiedInfoPageFromCandidate — the
//       product's own path): the POST reaches the server ONCE carrying the submitter; one admission,
//       exempted; page.url() at request time is still the information page (R5); a GA-like fetch
//       POST fired from Next's onclick and an on-load fetch POST are still aborted (non-stopping).
//   [R] ROUND 5 — RESERVED AT THE ADMISSION: the backstop awaits the use's reservation the moment it
//       would let the request through (asked then, never at the open); a refusal (an expired
//       verification), a throw, a malformed answer or no reservation at all HOLDS it exactly as on
//       main; an asynchronous reservation is awaited and the request passes once. R6 (Helm's F3):
//       a stopping abort AFTER the pass opened (a page script's filing-shaped POST) closes it — the
//       Next is held at consumption, and no reservation is asked.
//   [H] HIDDEN VALUES (Helm's review of #349): a hidden acctNo=4821 is refused by the shape — no
//       watch, no candidate, nothing hashed into the shared table; a CSRF token still is a candidate.
//   [E] SLOT LIFETIME: an opened slot that is not used within 20 s is gone; a GET reload closes it;
//       a second matching POST after the admission is held (the same page served again: d8).
//       E5 (#417, Helm nit :99 on #378, a GUARD pin): the hand-over closes it — opened, the watch armed,
//       handOverToHuman, then a page script's synthetic el.click() on Next: held (review-lockdown), no
//       admission, no reservation asked. Kill: remove closeInfo() from handOverToHuman.
//   [N] NEAR MISSES with DevHub's entry live, the variant served at the SAME origin + path: every
//       one is HELD, nothing reaches the server, no admission — c1-c28 (c21 under amendment [8]).
//       The toggle INSIDE a <header> landmark is the one mask: c21h passes for another tenant.
//   [D] RUN / BACKSTOP STATE with the exact verified page: a recorded fill, "advance: Yes" (tw), a
//       different permit-type tile (tile B), an own write, the sticky lock, a draft, a signature
//       resume, earlier progress, a prior stopping abort, a near-miss entry (one component off):
//       every one HELD.
//   [X] #358 REDIRECT: the verified Next answered 307 to <p>/payment, <p>/SubmitApplication and the
//       page's own next form: the hop is judged as a fresh request and refused, named, every time.
// Against main's filingBackstop.ts (no openInfoPagePass) [A]'s watch and [B]'s pass FAIL by name
// and every HELD line stays ok: main holds every one of these requests.
//
//   npx tsx portal-bot/src/infoPagePass.dom.smoke.ts
import "./smokeArtifactDirs";
import http from "node:http";
import { chromium, type Page } from "playwright";
import { INFO_PAGE_NO_RESERVATION, backstopFor, installFilingBackstop, isStoppingAbort, type FilingBackstop, type InfoPagePassOpen, type InfoPageReserve } from "./filingBackstop";
import {
  INFO_PAGE_IDENTITY_VERSION, infoPagePrefixOf, infoPageRequestRefusals, sha256Hex, verifiedInfoPageFromCandidate, type InfoPageRunState, type InfoPageRunStep,
} from "../../shared/src/infoPagePass";
import type { VerifiedInfoPage } from "../../shared/src/types";
import {
  ACCOUNT, NEXT_NAME, PERMITTING_INFORMATION, PREV_NAME, PREV_NEXT, bodyNamesOf, cleanRun, devhubPrefix, devhubReplica, entryFromLivePage, nearMissEntry,
  type ReplicaOpts,
} from "./adapters/infoPageFixture";

let failures = 0;
let total = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  total++;
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// ------------------------------------------------------------------------------------------
// The server: every scenario under its own prefix; the information page at <p>/permits/sfjsp.
// ------------------------------------------------------------------------------------------
type Variant = { html: (p: string) => string; next?: "form" | "same" | "filed"; redirect?: [number, string] };
const VARIANTS: Record<string, Variant> = {};
const hits: Array<{ method: string; path: string; names: string[]; ct: string }> = [];
const PROJECT_FORM = (p: string): string => devhubReplica({ p, title: "Project Information", content: `<div class="form-group"><label for="addr">Site Address</label><input id="addr" name="addr" type="text"></div>` });
const server = http.createServer((q, r) => {
  const chunks: Buffer[] = [];
  q.on("data", (c: Buffer) => chunks.push(c));
  q.on("end", () => {
    const url = q.url || "/";
    const method = String(q.method || "GET").toUpperCase();
    const pathOnly = url.split("?")[0];
    const ct = String(q.headers["content-type"] || "");
    const body = Buffer.concat(chunks);
    const p = Object.keys(VARIANTS).find((x) => pathOnly.startsWith(`${x}/`)) ?? "";
    hits.push({ method, path: pathOnly, names: method === "GET" ? [] : bodyNamesOf(ct, body), ct });
    const send = (html: string, status = 200): void => { r.writeHead(status, { "Content-Type": "text/html" }); r.end(html); };
    if (method !== "GET" && /\/g\/collect$|\/autosave$|\/beacon$/.test(pathOnly)) { r.writeHead(204); r.end(); return; }
    if (!p) { send("<html><body><h1>Unknown</h1></body></html>"); return; }
    const v = VARIANTS[p];
    if (method === "GET" && /\/permits\/sfjsp2?$/.test(pathOnly)) { send(v.html(p)); return; }
    if (method !== "GET" && /\/permits\/next-page$/.test(pathOnly)) { send(PROJECT_FORM(p)); return; }
    if (method !== "GET" && /\/permits\/sfjsp2?$/.test(pathOnly)) {
      const names = bodyNamesOf(ct, body);
      if (!names.includes(NEXT_NAME)) { send(v.html(p)); return; }
      if (v.redirect) { r.writeHead(v.redirect[0], { Location: `${p}${v.redirect[1]}` }); r.end(); return; }
      if (v.next === "same") { send(v.html(p)); return; }
      if (v.next === "filed") { send("<!doctype html><html><body><h1>Application filed</h1></body></html>"); return; }
      send(PROJECT_FORM(p));
      return;
    }
    if (/\/file$/.test(pathOnly)) { send("<!doctype html><html><body><h1>Application filed</h1></body></html>"); return; }
    send(`<!doctype html><html><body><h1>${pathOnly.replace(/[<>&]/g, "")}</h1><p>Automation must never land here.</p></body></html>`);
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();

const NEXT = `button[name="${NEXT_NAME}"]`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const stateChangingTo = (p: string): Array<{ method: string; path: string; names: string[] }> =>
  hits.filter((h) => h.method !== "GET" && h.path.startsWith(`${p}/`) && !/\/g\/collect$|\/autosave$|\/beacon$/.test(h.path));

interface Outcome {
  open: InfoPagePassOpen | null;
  hasDoor: boolean;
  posts: Array<{ method: string; path: string; names: string[] }>;
  admissions: Array<{ entryId: string; where: string; exempted: boolean }>;
  aborts: Array<{ rule: string; method: string; where: string; resourceType: string; stopping: boolean; why: string }>;
  pageTitle: string;
  urlAtPost: string;
  urlBefore: string;
  finalUrl: string;
  candidate: ReturnType<FilingBackstop["takeInfoPageCandidate"]> | null;
  allHits: Array<{ method: string; path: string; names: string[] }>;
}
interface Run {
  p: string;
  html: (p: string) => string;
  next?: Variant["next"];
  /** #358: the server answers the verified Next with this redirect (status, path under the prefix). */
  redirect?: Variant["redirect"];
  entries: VerifiedInfoPage[];
  run?: (startUrl: string) => InfoPageRunState;
  query?: string;
  host?: string;
  selector?: string;
  clickSelector?: string;
  before?: (page: Page, bs: FilingBackstop) => Promise<void>;
  /** Between the open and the click. */
  between?: (page: Page, bs: FilingBackstop) => Promise<void>;
  waitBeforeOpenMs?: number;
  /** Round 5: the reservation the backstop awaits at the admission (default: always reserved,
   *  recorded in `reserveCalls`); null = none given. */
  reserve?: InfoPageReserve | null;
}
const startUrlOf = (p: string): string => `${base}${p}/permits/sfjsp?interviewID=Home`;
// Round 5: every reservation the default (always-OK) reserve was asked for: [entryId, where].
const reserveCalls: Array<[string, string]> = [];
const okReserve: InfoPageReserve = (entryId, where) => { reserveCalls.push([entryId, where]); return []; };
async function go(o: Run): Promise<Outcome> {
  VARIANTS[o.p] = { html: o.html, next: o.next, redirect: o.redirect };
  const before = hits.length;
  const ctx = await browser.newContext();
  await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const page = await ctx.newPage();
  const bs = await installFilingBackstop(page, "info-page smoke");
  if (!bs) throw new Error("no backstop");
  let urlAtPost = "";
  page.on("request", (rq) => { if (rq.method() === "POST" && rq.isNavigationRequest() && !urlAtPost) urlAtPost = page.url(); });
  const url = `${o.host ? o.host.replace("PORT", String(port)) : base}${o.p}/permits/sfjsp${o.query ?? ""}`;
  await page.goto(url);
  await page.waitForLoadState("load");
  await sleep(o.waitBeforeOpenMs ?? 400);
  if (o.before) await o.before(page, bs);
  const urlBefore = page.url();
  const door = bs as FilingBackstop & { openInfoPagePass?: FilingBackstop["openInfoPagePass"] };
  const hasDoor = typeof door.openInfoPagePass === "function";
  const run = (o.run ?? ((s: string) => cleanRun(devhubPrefix(s))))(startUrlOf(o.p));
  const reserve = o.reserve === null ? undefined : (o.reserve ?? okReserve);
  const open = hasDoor ? await door.openInfoPagePass(page, page.locator(o.selector ?? NEXT), { entries: o.entries, run, reserve }) : null;
  if (o.between) await o.between(page, bs);
  await page.locator(o.clickSelector ?? o.selector ?? NEXT).first().click({ timeout: 5000 }).catch(() => null);
  await page.waitForLoadState("load").catch(() => null);
  await sleep(900);
  const candidate = typeof (bs as Partial<FilingBackstop>).takeInfoPageCandidate === "function" ? bs.takeInfoPageCandidate() : null;
  const out: Outcome = {
    open, hasDoor,
    posts: stateChangingTo(o.p).filter((h) => hits.indexOf(h as never) >= before),
    admissions: [...((bs as Partial<FilingBackstop>).infoPageAdmissions ?? [])],
    aborts: bs.aborts.map((a) => ({ rule: a.rule, method: a.method, where: a.where.replace(base, ""), resourceType: a.resourceType, stopping: isStoppingAbort(a), why: a.why })),
    urlAtPost, urlBefore, finalUrl: page.url(), candidate,
    pageTitle: String(await page.locator(".page-title").first().textContent({ timeout: 1500 }).catch(() => "") ?? "").trim(),
    allHits: hits.slice(before),
  };
  await bs.dispose().catch(() => null);
  await ctx.close().catch(() => null);
  return out;
}
const held = (o: Outcome): boolean => o.posts.length === 0 && o.admissions.filter((a) => a.exempted).length === 0;
const brief = (o: Outcome): string => JSON.stringify({ open: o.open, posts: o.posts, admissions: o.admissions, aborts: o.aborts.slice(0, 4) }).slice(0, 900);

// ===========================================================================================
// [A] unverified: held as on main, the held request observed for a candidate.
// ===========================================================================================
console.log("\n[A] UNVERIFIED: the replica's Next is held exactly as on main, and observed");
const A = await go({ p: "/A", html: (p) => devhubReplica({ p }), entries: [] });
check("[A] the door says no verified page matches, and opens a watch (candidateWatch)",
  A.hasDoor && !!A.open && A.open.opened === false && A.open.candidateWatch === true && A.open.refusals.length === 1 && /no verified information page matches/.test(A.open.refusals[0]),
  JSON.stringify(A.open));
check("[A] Next's POST never reached the server", A.posts.length === 0, JSON.stringify(A.posts));
check("[A] it was held by the review lockdown as a stopping document abort (main's hold)",
  A.aborts.some((a) => a.rule === "review-lockdown" && a.method === "POST" && /\/A\/permits\/sfjsp$/.test(a.where) && a.resourceType === "document" && a.stopping), JSON.stringify(A.aborts));
const Aobs = A.candidate?.observed;
check("[A] the watch observed {POST, the page's own path, multipart, [[t_n…, sha('')]]}",
  !!Aobs && Aobs.method === "POST" && /\/A\/permits\/sfjsp$/.test(Aobs.where) && Aobs.media === "multipart/form-data"
  && JSON.stringify(Aobs.body) === JSON.stringify([[NEXT_NAME, sha256Hex("")]]) && Aobs.hasFilenamePart === false, JSON.stringify(Aobs));
check("[A] what was observed is exactly what the identity said the control sends",
  !!A.candidate && infoPageRequestRefusals(A.candidate.digest.expected, A.candidate.observed).length === 0,
  A.candidate ? JSON.stringify(infoPageRequestRefusals(A.candidate.digest.expected, A.candidate.observed)) : "no candidate");
check("[A] the candidate's prefix is DevHub's [goto, application entry, permit type]",
  !!A.candidate && JSON.stringify(A.candidate.prefix.map((s) => s[0])) === JSON.stringify(["goto", "click", "click"]), JSON.stringify(A.candidate?.prefix));
check("[A] the in-page identity was read at version " + INFO_PAGE_IDENTITY_VERSION + " with no fillable control and no mask (the toggle sits in a plain div)",
  !!A.candidate && A.candidate.digest.version === INFO_PAGE_IDENTITY_VERSION && A.candidate.digest.shape.fillableCount === 0 && A.candidate.digest.shape.masked === 0,
  JSON.stringify(A.candidate?.digest.shape));
check("[A] the tenant name is in the page text the identity read (amendment [8]: not in a landmark, not masked)",
  !!A.candidate && A.candidate.material.text.includes(ACCOUNT));

// The entry a person's verification of [A]'s candidate writes (the product's own builder).
const DEVHUB: VerifiedInfoPage | null = A.candidate
  ? { id: "pass-devhub", verifiedAt: "2026-10-15T12:00:00.000Z", ...verifiedInfoPageFromCandidate({ identityVersion: A.candidate.digest.version, identitySha256: A.candidate.digest.identitySha256, digest: A.candidate.digest, prefix: A.candidate.prefix }) }
  : null;
// Every later scenario serves its page under its OWN prefix, so the verified entry for "the same
// page at the same origin + path" is read live from that scenario's replica with DevHub's prefix.
const devhubEntryAt = async (p: string, prefix?: InfoPageRunStep[]): Promise<VerifiedInfoPage | null> => {
  VARIANTS[p] = { html: (pp) => devhubReplica({ p: pp }) };
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${base}${p}/permits/sfjsp`);
  const e = await entryFromLivePage(page, NEXT, prefix ?? devhubPrefix(startUrlOf(p)), `pass${p.replace(/\//g, "-")}`);
  await ctx.close();
  return e;
};
// INFO_PAGE_SMOKE_ONLY=A,B,D runs only those sections (a kill check's quick pass); default: all.
const ONLY = String(process.env.INFO_PAGE_SMOKE_ONLY || "").split(",").map((x) => x.trim()).filter(Boolean);
const want = (section: string): boolean => !ONLY.length || ONLY.includes(section);

// ===========================================================================================
// [B] verified: exactly one request passes.
// ===========================================================================================
console.log("\n[B] VERIFIED: Next's POST passes once, exactly as the verified control sends it");
{
  // GA's event-callback shape: Next's click first sends its beacon by fetch, THEN submits the form
  // with Next as the submitter (requestSubmit(submitter) sends the same body a plain click does).
  const onclick = `<script>document.querySelector('button[name="${NEXT_NAME}"]').addEventListener('click', function (e) { if (window.__sent) return; e.preventDefault(); var b = e.currentTarget; fetch('/g/collect', { method: 'POST', body: 'v=2&en=click' }).catch(function () {}).then(function () { window.__sent = true; document.getElementById('smartguide_ApplyForAPermit').requestSubmit(b); }); });
setTimeout(function () { fetch('autosave', { method: 'POST', body: 'x=1' }).catch(function () {}); }, 200);</script>`;
  // [A]'s entry is for /A; [B] serves the same page at /A again (the candidate's own place).
  const reservedBefore = reserveCalls.length;
  const B = await go({ p: "/A", html: (p) => devhubReplica({ p, script: onclick }), entries: DEVHUB ? [DEVHUB] : [] });
  const bReserved = reserveCalls.slice(reservedBefore);
  check("[B] round 5: the use was RESERVED once, at the admission, for the verified entry and the request's own where",
    bReserved.length === 1 && bReserved[0][0] === "pass-devhub" && /\/A\/permits\/sfjsp$/.test(bReserved[0][1]), JSON.stringify(bReserved));
  // The script changes nothing the identity reads (scripts are skipped), so [A]'s entry matches.
  check("[B] the door opens the pass for the verified page", !!B.open && B.open.opened === true && B.open.entryId === "pass-devhub", JSON.stringify(B.open));
  const next = B.posts.filter((h) => /\/A\/permits\/sfjsp$/.test(h.path));
  check("[B] Next's POST reached the server exactly once, carrying the submitter",
    next.length === 1 && next[0].names.includes(NEXT_NAME) && B.posts.length === 1, JSON.stringify(B.posts));
  check("[B] one admission, exempted from 4(b) by the pass", B.admissions.length === 1 && B.admissions[0].exempted === true && B.admissions[0].entryId === "pass-devhub", JSON.stringify(B.admissions));
  check("[B] the walk landed on the form page behind it", B.pageTitle === "Project Information" && B.finalUrl.endsWith("/A/permits/sfjsp"), `${B.pageTitle} @ ${B.finalUrl}`);
  check("[B] R5: page.url() at request time was still the information page", B.urlAtPost === B.urlBefore, `${B.urlAtPost} vs ${B.urlBefore}`);
  check("[B] the GA-like onclick fetch and the on-load fetch POST were still aborted, non-stopping",
    B.aborts.some((a) => /\/g\/collect$/.test(a.where) && !a.stopping) && B.aborts.some((a) => /\/autosave$/.test(a.where) && !a.stopping) && !B.aborts.some((a) => a.stopping),
    JSON.stringify(B.aborts));
}

// ===========================================================================================
// [R] round 5: the use is RESERVED AT THE ADMISSION (verification round 4's B1). The pass opens
//     (the verification read live when the run was handed it); the backstop then awaits the
//     reservation at the moment it would let the request through. Refused, thrown, malformed or
//     absent: HELD exactly as on main. Kill: admit without awaiting the reservation and R1-R3 pass
//     their POST.
// ===========================================================================================
console.log("\n[R] ROUND 5: THE USE IS RESERVED AT THE ADMISSION");
if (want("R")) {
  const EXPIRED = "verification expired — a person re-verifies (a verification is authority for 30 days; this one is older)";
  const stoppingHold = (o: Outcome, re: RegExp): boolean => held(o) && o.admissions.length === 0
    && o.aborts.some((a) => a.rule === "review-lockdown" && a.resourceType === "document" && a.stopping && re.test(a.why));
  // R1: the verification expired while the run was in flight — the reservation refuses.
  const e1 = await devhubEntryAt("/R1");
  const calls1: Array<[string, string]> = [];
  let atOpen1 = -1;
  const r1 = await go({
    p: "/R1", html: (p) => devhubReplica({ p }), entries: e1 ? [e1] : [],
    reserve: (id, where) => { calls1.push([id, where]); return [EXPIRED]; },
    between: async () => { atOpen1 = calls1.length; },
  });
  check("[R1] premise: the door OPENED the pass (the run was handed a live verification)", !!r1.open?.opened, brief(r1));
  check("[R1] the reservation is asked at the ADMISSION, not at the open: none after the open, one at the click (the entry, the request's own where)",
    atOpen1 === 0 && calls1.length === 1 && calls1[0][0] === e1?.id && /\/R1\/permits\/sfjsp$/.test(calls1[0][1]), JSON.stringify({ atOpen1, calls1 }));
  check("[R1] REFUSED at the admission ('verification expired'): HELD exactly as on main — nothing reached the server, no admission, the stopping review-lockdown abort names why",
    stoppingHold(r1, /verification expired — a person re-verifies/), brief(r1));
  // R2: the reservation throws (the ledger could not be written).
  const e2 = await devhubEntryAt("/R2");
  const r2 = await go({ p: "/R2", html: (p) => devhubReplica({ p }), entries: e2 ? [e2] : [], reserve: () => { throw new Error("database is locked"); } });
  check("[R2] a reservation that THROWS: HELD, and the abort says the use could not be reserved", !!r2.open?.opened && stoppingHold(r2, /could not be reserved \(database is locked\)/), brief(r2));
  // R3: a malformed answer (not a list of refusals).
  const e3 = await devhubEntryAt("/R3");
  const r3 = await go({ p: "/R3", html: (p) => devhubReplica({ p }), entries: e3 ? [e3] : [], reserve: (() => "ok") as unknown as InfoPageReserve });
  check("[R3] a malformed reservation answer: HELD", !!r3.open?.opened && stoppingHold(r3, /could not be reserved \(no answer\)/), brief(r3));
  // R4: no reservation at all — nothing opens.
  const e4 = await devhubEntryAt("/R4");
  const r4 = await go({ p: "/R4", html: (p) => devhubReplica({ p }), entries: e4 ? [e4] : [], reserve: null });
  check("[R4] no reservation given: the pass does not open (fail closed) and the Next is HELD",
    !!r4.open && !r4.open.opened && r4.open.refusals.includes(INFO_PAGE_NO_RESERVATION) && held(r4), brief(r4));
  // R5 (positive control): an asynchronous reservation that answers after 600 ms is AWAITED — the
  // request waits for it, then passes once.
  const e5 = await devhubEntryAt("/R5");
  let answeredAt = 0;
  const r5 = await go({ p: "/R5", html: (p) => devhubReplica({ p }), entries: e5 ? [e5] : [], reserve: async () => { await sleep(600); answeredAt = Date.now(); return []; } });
  check("[R5] (positive control) an asynchronous reservation is AWAITED: the Next waits for it and passes ONCE, exempted",
    !!r5.open?.opened && answeredAt > 0 && r5.posts.length === 1 && r5.admissions.filter((a) => a.exempted).length === 1, brief(r5));
  // R6 — F3 (Helm's review of #349): AFTER the pass opened, a page script sends a filing-shaped POST
  // (held: a STOPPING abort — the run is stopping). The slot it opened must not then let Next through.
  // Kill: without the consumption check, Next passes once, exempted.
  const e6 = await devhubEntryAt("/R6");
  const calls6: Array<[string, string]> = [];
  const r6 = await go({
    p: "/R6", html: (p) => devhubReplica({ p }), entries: e6 ? [e6] : [],
    reserve: (id, where) => { calls6.push([id, where]); return []; },
    between: async (page) => { await page.evaluate("fetch('submitApplication', { method: 'POST', body: 'x=1' }).catch(function () { return null; })"); await sleep(400); },
  });
  check("[R6] premise: the pass OPENED, then a page script's filing-shaped POST was held as a STOPPING abort (filing-url)",
    !!r6.open?.opened && r6.aborts.some((a) => a.rule === "filing-url" && /\/R6\/permits\/submitApplication$/.test(a.where) && a.stopping), brief(r6));
  check("[R6] F3: the slot does not let Next through after the run met a stopping abort — HELD as on main, no reservation asked, the abort names why",
    stoppingHold(r6, /stopping abort/) && calls6.length === 0, `${brief(r6)} calls=${JSON.stringify(calls6)}`);
}

// ===========================================================================================
// [H] Helm's review of #349 — A HIDDEN VALUE A PLAIN HASH DOES NOT PROTECT: the replica's form carries
//     a hidden account number (acctNo=4821). With no verified page, main holds the Next; the door
//     now refuses the SHAPE, so NO watch opens and no candidate is kept (its request-body hash of
//     "4821" never reaches the shared table). The positive control: a CSRF token (__csrf=abc123)
//     still yields a candidate. Kill: without the shape rule, H1 opens a watch and keeps a candidate.
// ===========================================================================================
console.log("\n[H] HIDDEN VALUES: a digit-run or secret-like hidden input is never captured for verification");
if (want("H")) {
  const h1 = await go({ p: "/H1", html: (p) => devhubReplica({ p, formExtra: `<input type="hidden" name="acctNo" value="4821">` }), entries: [] });
  check("[H1] a hidden acctNo=4821: the door REFUSES the shape (named), opens NO watch, keeps no candidate — and the Next is held as on main",
    !!h1.open && !h1.open.opened && !h1.open.candidateWatch && h1.open.refusals.some((r) => /hidden input\(s\) whose value looks like an account, meter or other number/.test(r) && /acctNo/.test(r))
    && !h1.candidate && h1.posts.length === 0, brief(h1));
  const h2 = await go({ p: "/H2", html: (p) => devhubReplica({ p, formExtra: `<input type="hidden" name="__csrf" value="abc123">` }), entries: [] });
  check("[H2] (positive control) a hidden CSRF token (__csrf=abc123): no verified page matches, a WATCH opens and the held request is kept as a candidate",
    !!h2.open && !h2.open.opened && h2.open.candidateWatch === true && !!h2.candidate?.observed && h2.posts.length === 0, brief(h2));
}

// ===========================================================================================
// [E] slot lifetime.
// ===========================================================================================
console.log("\n[E] SLOT LIFETIME");
if (want("E")) {
  const e = await devhubEntryAt("/E1");
  const late = await go({ p: "/E1", html: (p) => devhubReplica({ p }), entries: e ? [e] : [], between: async () => { await sleep(20_600); } });
  check("[E] opened, unused for 20 s, then clicked: HELD (the slot is gone)", !!late.open?.opened && held(late), brief(late));
  const e2 = await devhubEntryAt("/E2");
  const reload = await go({ p: "/E2", html: (p) => devhubReplica({ p }), entries: e2 ? [e2] : [], between: async (page) => { await page.reload(); await page.waitForLoadState("load"); await sleep(300); } });
  check("[E] opened, then the page reloaded by GET: HELD (a GET navigation / a new document closes the slot)", !!reload.open?.opened && held(reload), brief(reload));
  const e3 = await devhubEntryAt("/E3");
  const d8 = await go({
    p: "/E3", html: (p) => devhubReplica({ p }), next: "same", entries: e3 ? [e3] : [],
    between: async () => undefined,
  });
  check("[E] premise: the first Next passed and the server served the same page again", d8.posts.length === 1, brief(d8));
  // The second round on the same run: the same backstop, the same verified page, admitted once.
  {
    const e4 = await devhubEntryAt("/E4");
    VARIANTS["/E4"] = { html: (p) => devhubReplica({ p }), next: "same" };
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const bs = await installFilingBackstop(page, "d8");
    await page.goto(`${base}/E4/permits/sfjsp`);
    await page.waitForLoadState("load");
    await sleep(400);
    const before = hits.length;
    const run = cleanRun(devhubPrefix(startUrlOf("/E4")));
    const first = bs && typeof bs.openInfoPagePass === "function" ? await bs.openInfoPagePass(page, page.locator(NEXT), { entries: e4 ? [e4] : [], run, reserve: okReserve }) : null;
    await page.locator(NEXT).click().catch(() => null);
    await page.waitForLoadState("load").catch(() => null);
    await sleep(600);
    const run2 = cleanRun([...devhubPrefix(startUrlOf("/E4")), { action: "click", note: "advance: Next", admitted: true }]);
    const second = bs && typeof bs.openInfoPagePass === "function" ? await bs.openInfoPagePass(page, page.locator(NEXT), { entries: e4 ? [e4] : [], run: run2, reserve: okReserve }) : null;
    await page.locator(NEXT).click().catch(() => null);
    await page.waitForLoadState("load").catch(() => null);
    await sleep(600);
    const posts = hits.slice(before).filter((h) => h.method === "POST" && h.path.startsWith("/E4/"));
    check("[E] d8: the same verified page served again after its admitted Next: the second open is refused and its POST HELD",
      !!first?.opened && !!second && !second.opened && posts.length === 1, JSON.stringify({ first, second, posts }));
    await bs?.dispose();
    await ctx.close();
  }
  // E5 (#417, Helm nit :99 on #378 — GUARD pin, green before by design): the hand-over closes the
  // information-page pass. A pass opened on the run's page must not outlive handOverToHuman: from there
  // only a person's own input lifts the lockdown. The pass opens on the exact verified page, the input
  // watch is armed (the CDP isolated-world arm) and the page handed over; then a page script's SYNTHETIC
  // el.click() on Next (no input event of a person's): its POST never reaches the server, it is held by
  // the review lockdown, no admission is recorded and no reservation is asked. Kill: remove closeInfo()
  // from handOverToHuman (the still-open slot admits the Next).
  {
    const e5 = await devhubEntryAt("/E5");
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const bs = await installFilingBackstop(page, "e5 hand-over");
    await page.goto(`${base}/E5/permits/sfjsp`);
    await page.waitForLoadState("load");
    await sleep(400);
    const before = hits.length;
    const reservedBefore = reserveCalls.length;
    const run = cleanRun(devhubPrefix(startUrlOf("/E5")));
    const open = bs ? await bs.openInfoPagePass(page, page.locator(NEXT), { entries: e5 ? [e5] : [], run, reserve: okReserve }) : null;
    const armed = bs ? await bs.watchHumanInput() : false;
    const handed = bs ? bs.handOverToHuman("e5 smoke") : false;
    await page.evaluate((sel) => { (document.querySelector(sel) as HTMLElement | null)?.click(); }, NEXT);
    await page.waitForLoadState("load").catch(() => null);
    await sleep(900);
    const posts = hits.slice(before).filter((h) => h.method === "POST" && h.path.startsWith("/E5/permits/"));
    const aborts = (bs?.aborts ?? []).map((a) => ({ rule: a.rule, where: a.where.replace(base, ""), stopping: isStoppingAbort(a), human: !!a.humanInput }));
    check("[E] E5 premise: the pass opened on the verified page, the input watch armed, and the hand-over was accepted",
      !!open?.opened && armed === true && handed === true, JSON.stringify({ open, armed, handed }));
    check("[E] E5 the hand-over closes the pass: a page script's synthetic el.click() on Next sends nothing (0 POSTs), held by the review lockdown",
      posts.length === 0 && aborts.some((a) => a.rule === "review-lockdown" && /\/E5\/permits\/sfjsp$/.test(a.where) && !a.human), JSON.stringify({ posts, aborts }));
    check("[E] E5 …no admission is recorded and no reservation is asked",
      (bs?.infoPageAdmissions ?? []).length === 0 && reserveCalls.length === reservedBefore, JSON.stringify({ admissions: bs?.infoPageAdmissions, reserve: reserveCalls.slice(reservedBefore) }));
    await bs?.dispose();
    await ctx.close();
  }
}

// ===========================================================================================
// [N] near misses: DevHub's entry live, the variant served at the SAME origin + path.
// ===========================================================================================
console.log("\n[N] NEAR MISSES: each variant HELD, nothing sent, no admission");
const card = "Your card on file will be charged $350 now.";
const NEAR: Array<{ id: string; what: string; opts?: Partial<ReplicaOpts>; query?: string; host?: string; selector?: string; clickSelector?: string; script?: string; waitBeforeOpenMs?: number; between?: Run["between"] }> = [
  { id: "c1", what: "a field inside the form", opts: { formExtra: `<input type="text" name="addr" value="">` } },
  { id: "c2", what: "a field outside the form", opts: { outsideForm: `<input type="text" name="q" value="">` } },
  { id: "c3", what: "a <dl> summary inside the form", opts: { formExtra: `<dl><dt>Permit Type</dt><dd>Solar</dd></dl>` } },
  { id: "c4", what: "a <dl> summary outside the form", opts: { outsideForm: `<dl><dt>Permit Type</dt><dd>Solar</dd></dl>` } },
  { id: "c5", what: "action sfjsp2", opts: { action: "sfjsp2" } },
  { id: "c6", what: "the submitter renamed", opts: { nav: `<button type="submit" name="${PREV_NAME}" class="btn btn-primary">Previous</button><button type="submit" name="t_n9" class="btn btn-primary ms-auto ">Next</button>` }, selector: `button[name="t_n9"]` },
  { id: "c7", what: "a submitter value added", opts: { nav: `<button type="submit" name="${PREV_NAME}" class="btn btn-primary">Previous</button><button type="submit" name="${NEXT_NAME}" value="go" class="btn btn-primary ms-auto ">Next</button>` } },
  { id: "c8", what: `"${card}" added`, opts: { formExtra: `<p>${card}</p>` } },
  { id: "c9", what: "the m7 sentence in place of the information prose", opts: { content: `<p>Staff will review your application within 5 business days. Click Next to send it to the city.</p>` } },
  { id: "c10", what: "urlencoded enctype", opts: { enctype: "" } },
  { id: "c11", what: "a hidden input added", opts: { formExtra: `<input type="hidden" name="__csrf" value="abc123">` } },
  { id: "c12", what: "?x=1 on the page URL", query: "?x=1" },
  { id: "c13", what: "another host (localhost vs 127.0.0.1)", host: "http://localhost:PORT" },
  { id: "c14", what: "form target=_blank", opts: { target: "_blank" } },
  { id: "c15", what: "Next as an <a>", opts: { nav: `<button type="submit" name="${PREV_NAME}" class="btn btn-primary">Previous</button><a href="sfjsp?step=next" class="btn btn-primary ms-auto">Next</a>` }, selector: "a.ms-auto" },
  { id: "c16", what: "onclick rewrites form.action to /file", script: `<script>document.querySelector('button[name="${NEXT_NAME}"]').addEventListener('click', function () { document.getElementById('smartguide_ApplyForAPermit').setAttribute('action', 'file'); });</script>` },
  { id: "c17", what: "onclick preventDefault + requestSubmit() with no submitter", script: `<script>document.querySelector('button[name="${NEXT_NAME}"]').addEventListener('click', function (e) { e.preventDefault(); document.getElementById('smartguide_ApplyForAPermit').requestSubmit(); });</script>` },
  { id: "c18", what: "a hidden input added between the identity read and the click", between: async (page) => { await page.evaluate(() => { const i = document.createElement("input"); i.type = "hidden"; i.name = "addr"; i.value = "1 Test St"; document.getElementById("smartguide_ApplyForAPermit")!.appendChild(i); }); } },
  { id: "c18f", what: "formaction set on the Next between the identity read and the click (request substitution)", between: async (page) => { await page.evaluate((n) => { document.querySelector(`button[name="${n}"]`)!.setAttribute("formaction", "sfjsp2"); }, NEXT_NAME); } },
  { id: "c18v", what: "the Next's value changed between the identity read and the click", between: async (page) => { await page.evaluate((n) => { document.querySelector(`button[name="${n}"]`)!.setAttribute("value", "go"); }, NEXT_NAME); } },
  { id: "c19", what: "preventDefault + fetch POST (not a navigation)", script: `<script>document.querySelector('button[name="${NEXT_NAME}"]').addEventListener('click', function (e) { e.preventDefault(); fetch('sfjsp', { method: 'POST', body: new FormData(document.getElementById('smartguide_ApplyForAPermit'), e.target) }).catch(function () {}); });</script>` },
  { id: "c20", what: "a banner 'Application ready to file' outside the form", opts: { outsideForm: `<div class="alert">Application ready to file</div>` } },
  { id: "c21", what: "the same page with the toggle label 'Other Tenant LLC' (amendment [8]: no landmark, no mask — HELD)", opts: { toggleLabel: "Other Tenant LLC" } },
  { id: "c22", what: "identical chrome / form / submitter, 'Review and Submit' step content", opts: { title: "Review and Submit", content: `<p>Review your request below, then press Next to submit it.</p>` } },
  { id: "c23", what: "an element named 'action' inside the form (clobbering)", opts: { formExtra: `<input type="hidden" name="action" value="file">` } },
  { id: "c24", what: "an open shadow root", script: `<script>document.getElementById('breadcrumb').attachShadow({ mode: 'open' }).innerHTML = '<slot></slot>';</script>` },
  { id: "c25", what: "a script that rewrites the step text 500 ms after load", script: `<script>setTimeout(function () { document.getElementById('div_d_1685049573552').lastChild.textContent = ' Your application is ready. Press Next to submit it.'; }, 500);</script>`, waitBeforeOpenMs: 1200 },
  { id: "c26", what: "a popover with text present at the read", opts: { outsideForm: `<div class="popover new-feature-popper" role="tooltip">New: pay your intake fee online</div>` } },
  { id: "c27", what: "the same page with a different heading", opts: { h1: "Development Hub Fixture — Submit" } },
  { id: "c28", what: "a step frame composed into the page (an iframe beside the prose)", opts: { content: `${PERMITTING_INFORMATION}<iframe src="about:blank" width="600" height="200" title="step"></iframe>` } },
  { id: "c16p", what: "onclick rewrites form.action to a payment URL (rule 1 aborts the slot's request)", script: `<script>document.querySelector('button[name="${NEXT_NAME}"]').addEventListener('click', function () { document.getElementById('smartguide_ApplyForAPermit').setAttribute('action', 'payment'); });</script>` },
  { id: "c16s", what: "onclick rewrites form.action to /submitApplication (rule 2 aborts the slot's request)", script: `<script>document.querySelector('button[name="${NEXT_NAME}"]').addEventListener('click', function () { document.getElementById('smartguide_ApplyForAPermit').setAttribute('action', 'submitApplication'); });</script>` },
];
// Each variant twice: (i) NO verified entry — exactly main's behaviour (no slot can open), and
// (ii) DevHub's entry live. The pass must change nothing: no admission, and what reached the server
// is what (i) let through. Every variant but c14 is held in both (c14's form posts into a new tab,
// which has no reading of its own: main's 4(b) does not hold it either — a named residual of main).
const MAIN_LETS_THROUGH = new Set(["c14"]);
for (const n of want("N") ? NEAR : []) {
  const p = `/${n.id}`;
  const html = (pp: string): string => devhubReplica({ p: pp, ...(n.opts ?? {}), script: n.script });
  const common = { p, html, query: n.query, host: n.host, selector: n.selector, between: n.between, waitBeforeOpenMs: n.waitBeforeOpenMs };
  const none = await go({ ...common, entries: [] });
  const e = await devhubEntryAt(p);
  const o = await go({ ...common, entries: e ? [e] : [] });
  const shape = (x: Outcome): string => JSON.stringify(x.posts.map((h) => `${h.method} ${h.path} ${h.names.join(",")}`));
  check(`[N] ${n.id} ${n.what}: with DevHub's entry live the pass admits nothing, and the server saw exactly what it sees with no entry`,
    !!e && o.admissions.length === 0 && shape(o) === shape(none), `entry=${!!e} with=${brief(o)} none=${shape(none)}`);
  if (!MAIN_LETS_THROUGH.has(n.id)) check(`[N] ${n.id} HELD in both — nothing state-changing reached the server`, held(o) && held(none), `with=${shape(o)} none=${shape(none)}`);
  else console.log(`  note - ${n.id}: main lets this request through (${shape(none)}); with the entry: ${shape(o)}`);
  if (n.id === "c16p" || n.id === "c16s") check(`[N] ${n.id} the slot's request met the filing-URL rule first`, o.aborts.some((a) => a.rule === "filing-url"), JSON.stringify(o.aborts));
  const named = o.open ? o.open.refusals.join("; ") : "(no door)";
  if (o.open && !o.open.opened) console.log(`         ${n.id} refused: ${named.slice(0, 200)}`);
  else if (o.open?.opened) console.log(`         ${n.id} opened (the request binding held it): ${JSON.stringify(o.aborts.map((a) => a.why)).slice(0, 200)}`);
}
// The ONE mask: the toggle inside a <header> landmark — one verification serves another tenant.
if (want("N")) {
  const p = "/c21h";
  VARIANTS[p] = { html: (pp) => devhubReplica({ p: pp, toggleInHeader: true }) };
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${base}${p}/permits/sfjsp`);
  const e = await entryFromLivePage(page, NEXT, devhubPrefix(startUrlOf(p)), "pass-c21h");
  await ctx.close();
  const o = await go({ p, html: (pp) => devhubReplica({ p: pp, toggleInHeader: true, toggleLabel: "Other Tenant LLC" }), entries: e ? [e] : [] });
  check("[N] c21h PASSES ON PURPOSE: the toggle inside a <header> landmark is masked, so another tenant's label matches the same verification",
    !!o.open?.opened && o.posts.length === 1 && o.admissions.filter((a) => a.exempted).length === 1, brief(o));
}

// ===========================================================================================
// [D] run / backstop state with the exact verified page.
// ===========================================================================================
console.log("\n[D] RUN AND BACKSTOP STATE: the exact verified page, every one HELD");
const TW_PREFIX = (s: string): InfoPageRunStep[] => [...devhubPrefix(s), { action: "click", note: "advance: Yes" }];
const FILL_PREFIX = (s: string): InfoPageRunStep[] => [...devhubPrefix(s), { action: "fill", note: "Site Address" }];
const DCASES: Array<{ id: string; what: string; run?: (s: string) => InfoPageRunState; before?: Run["before"]; entry?: (e: VerifiedInfoPage) => VerifiedInfoPage; entryPrefix?: (s: string) => InfoPageRunStep[] }> = [
  { id: "d1", what: "a fill recorded earlier", run: (s) => cleanRun(FILL_PREFIX(s)) },
  { id: "d2", what: "'advance: Yes' recorded (tw)", run: (s) => cleanRun(TW_PREFIX(s)) },
  // The same two with the page VERIFIED ON THAT VERY PREFIX (an entry the product cannot build —
  // its watch never opens after an answer — so only the run-state whitelist stands in the way).
  { id: "d1x", what: "a fill recorded earlier, the entry verified on that same prefix", run: (s) => cleanRun(FILL_PREFIX(s)), entryPrefix: FILL_PREFIX },
  { id: "d2x", what: "'advance: Yes' recorded (tw), the entry verified on that same prefix", run: (s) => cleanRun(TW_PREFIX(s)), entryPrefix: TW_PREFIX },
  { id: "d3", what: "withOwnWriteWindow used earlier (everWrote)", before: async (_p, bs) => { const close = bs.openOwnWrite(_p, "a fill"); close(); } },
  { id: "d4", what: "lockReview armed (4a aborts before any exemption)", before: async (_p, bs) => { bs.lockReview("smoke"); } },
  { id: "d5", what: "a continued draft", run: (s) => cleanRun(devhubPrefix(s), { continuedDraft: true }) },
  { id: "d6", what: "a signature resume", run: (s) => cleanRun(devhubPrefix(s), { signatureCheck: true }) },
  { id: "d7", what: "a prior stopping abort on the run (a page script's filing-URL POST)", before: async (page) => { await page.evaluate(() => fetch("submitApplication", { method: "POST", body: "x=1" }).catch(() => null)); await sleep(600); } },
  { id: "d11", what: "tile B: the same page after a DIFFERENT permit-type tile", run: (s) => cleanRun(devhubPrefix(s, "Trade Permits")) },
  { id: "d12", what: "earlier progress of this project on this portal (priorProgress)", run: (s) => cleanRun(devhubPrefix(s), { priorProgress: true }) },
  { id: "d13", what: "the project's own street on the page", run: (s) => cleanRun(devhubPrefix(s), { projectValues: ["Permit Tech"] }) },
  { id: "d14", what: "a near-miss entry (the text hash one off)", entry: (e) => nearMissEntry(e, "textSha") },
  { id: "d15", what: "a near-miss entry (the request hash one off)", entry: (e) => nearMissEntry(e, "requestSha") },
  { id: "d16", what: "an entry of an older identity version", entry: (e) => ({ ...e, identityVersion: INFO_PAGE_IDENTITY_VERSION - 1 }) },
  // MOVED RECORD (proposal §5): the verified entry itself moved to another host, tenant path,
  // control, request or step sequence — never this page's pass.
  { id: "mv1", what: "MOVED RECORD: the entry moved to another host", entry: (e) => ({ ...e, origin: e.origin.replace("127.0.0.1", "localhost") }) },
  { id: "mv2", what: "MOVED RECORD: the entry moved to another tenant path", entry: (e) => ({ ...e, path: `/agency-b${e.path}` }) },
  { id: "mv3", what: "MOVED RECORD: the entry moved to another control", entry: (e) => ({ ...e, controlName: PREV_NAME, controlLabel: "Previous" }) },
  { id: "mv4", what: "MOVED RECORD: the entry moved to another request", entry: (e) => ({ ...e, request: { ...e.request, where: `${e.request.where}2` } }) },
  { id: "mv5", what: "MOVED RECORD: the entry moved to another step sequence (another tile)", entry: (e) => ({ ...e, prefix: e.prefix.map((s, i) => (i === 2 ? [s[0], "permit type: Trade Permits", s[2]] : s) as [string, string, string]) }) },
];
for (const c of want("D") ? DCASES : []) {
  const p = `/${c.id}`;
  const e = await devhubEntryAt(p, c.entryPrefix ? c.entryPrefix(startUrlOf(p)) : undefined);
  const o = await go({ p, html: (pp) => devhubReplica({ p: pp }), entries: e ? [c.entry ? c.entry(e) : e] : [], run: c.run, before: c.before });
  check(`[D] ${c.id} ${c.what}: HELD — nothing sent, no admission`, held(o), brief(o));
  if (o.open && !o.open.opened) console.log(`         ${c.id} refused: ${o.open.refusals.join("; ").slice(0, 200)}`);
}
// Sanity on the fixture: with nothing off, the same harness passes (so every HELD above is the door).
{
  const e = await devhubEntryAt("/ok");
  const o = await go({ p: "/ok", html: (pp) => devhubReplica({ p: pp }), entries: e ? [e] : [] });
  check("[D] control: the exact verified page on the exact prefix with nothing entered PASSES in the same harness", !!o.open?.opened && o.posts.length === 1, brief(o));
  check("[D] control: the prefix the entry was verified with is DevHub's", !!e && JSON.stringify(e.prefix.map((s) => s[1])) === JSON.stringify(["entry url", "application entry: Apply For A Permit", "permit type: Solar Permit Request"]),
    JSON.stringify(e?.prefix));
  check("[D] control: infoPagePrefixOf keeps goto's place by query KEYS only", JSON.stringify(infoPagePrefixOf(devhubPrefix(startUrlOf("/ok")))[0][2]).endsWith("sfjsp?interviewID\""));
}

// ===========================================================================================
// [X] #358 — THE VERIFIED REQUEST'S OWN REDIRECT. The pass admits ONE request; when the portal answers
//     it 307, the hop is judged as a fresh request and never takes the slot (it closed at the
//     admission): a payment or filing Location meets those rules, and even the page's own next form
//     meets the proof hold (3b), which names the redirect. Premises: the pass opened, one use was
//     reserved, the first leg arrived once (kill the admission and these go red).
// ===========================================================================================
console.log("\n[X] #358: THE VERIFIED REQUEST'S OWN REDIRECT IS JUDGED, NEVER ADMITTED");
if (want("X")) {
  for (const [id, to, rule, why] of [
    ["x1", "/payment", "filing-url", /fee-payment/],
    ["x2", "/SubmitApplication", "filing-url", /filing endpoint/],
    ["x3", "/permits/next-page", "review-lockdown", /PROOF OF PROGRESS[^]*307 redirect/],
  ] as const) {
    const p = `/${id}`;
    const e = await devhubEntryAt(p);
    const reservedBefore = reserveCalls.length;
    const o = await go({ p, html: (pp) => devhubReplica({ p: pp }), entries: e ? [e] : [], redirect: [307, to] });
    const first = o.allHits.filter((h) => h.method === "POST" && h.path === `${p}/permits/sfjsp`);
    check(`[X] ${id} premise: the pass opened, one use was reserved, the verified Next arrived once`,
      !!o.open?.opened && reserveCalls.length - reservedBefore === 1 && first.length === 1 && o.admissions.length === 1 && o.admissions[0].exempted, brief(o));
    check(`[X] ${id}: its 307 to ${p}${to} is refused (${rule}) and nothing reaches it`,
      o.allHits.filter((h) => h.path === `${p}${to}`).length === 0 && o.aborts.some((a) => a.rule === rule && a.where === `${p}${to}` && a.stopping && why.test(a.why)), `${brief(o)} hits=${JSON.stringify(o.allHits.map((h) => `${h.method} ${h.path}`))}`);
  }
}
void backstopFor; void PERMITTING_INFORMATION; void PREV_NEXT;

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures}/${total} infoPagePass.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log(`\nAll ${total}/${total} infoPagePass.dom.smoke checks passed.`);
process.exit(0);
