// AN ACCELA FILING WITH A NUMBER AND NO LINK IS FOUND THROUGH THE MODULE'S OWN PUBLIC SEARCH (#443).
//
// worker-local measured on 2026-10-31 (#413) that Oregon ePermitting's module search (CapHome.aspx,
// the permit-number box, Search) finds an issued record anonymously and lands on its CapDetail page,
// while the global search and the guessed capID triplet never find Oregon's four-part numbers. A
// filing whose client has no portal login and no recipe got no link, so it was never read.
//
// The portal here is a stub `fetch` serving SYNTHETIC ACA pages (fixtures/accela-search/), shaped like
// ACA's WebForms markup: the session cookie, the __VIEWSTATE round trip, the __doPostBack Search
// control. It answers a search the way ACA does — one record redirects to its CapDetail, several are
// listed, none says so — and it REFUSES (and records) any postback that is not the Search control.
//
//   MUST-FIND    the record by its number: one GET of the search page, ONE postback naming the Search
//                control and nothing else, the GET of the record page; the cleaned CapDetail link and
//                the page's text come back (an async "pageRedirect" answer and a one-row list too)
//   MUST-EXCLUDE a results list with several records; a similar number (…-STR-REV, a longer number
//                that starts with this one); a record page that does not name the number; a page with
//                no record-number search is never posted to; a redirect off the AHJ's tenant
//   MUST-PASS    the module by suffix first (STR → Building, ELEC → Electrical)
//   MUST-PASS    THE SWEEP (runDuePermitChecks, the real one): a permit target on an Accela portal with
//                a number and no link gets the CapDetail as its tracking_url (session material
//                stripped), reads "Record Status: Issued" as issued, and the NEXT sweep reads that link
//                with a plain GET and no search; one search per check, none inside a day of the last
//                lookup, the next module on the next day; never on a NEM target or a target with a link
//
// Run: npx tsx backend/test/accelaRecordSearch.test.ts
import "./_isolate"; // FIRST — generated files land in a temp cwd, never the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("accela-record-search");
const { db, repo } = fx;
process.env.PORTAL_AUTOSEED = "1"; // the live install's mode: an empty read is skipped, not mocked
process.env.PORTAL_FEE_READ = "off"; // the fee reader has its own suite; never the network here
const { searchAccelaRecordByNumber, accelaModulesForNumber } = await import("../src/publicPermitStatus");
const { samePortal, trackSafeUrl } = await import("../src/portalChannel");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const page = (name: string) => fs.readFileSync(path.join(HERE, "fixtures", "accela-search", name), "utf8");
const CAPHOME = page("caphome.html");
const CAPDETAIL = page("capdetail.html");
const RESULTS = page("results.html");

const ORIGIN = "https://aca-test.accela.com";
const TENANT = `${ORIGIN}/TESTCOUNTY`;
const PORTAL = `${TENANT}/Cap/CapHome.aspx?module=Building&TabName=Building`;
const VIEWSTATE = "VS-synthetic-0001";

type Record = { number: string; status: string; cap: [string, string, string] };
type Req = { method: string; url: string; form?: URLSearchParams; cookie: string };
type PortalOpts = {
  records: Record[];
  /** How a one-record search answers: a 302 (ACA's normal), an async "pageRedirect", or a one-row list. */
  oneHit?: "redirect" | "async" | "list";
  /** The record page served for a CapDetail, by capID3 — override to serve another record's page. */
  detailFor?: (r: Record) => string;
  /** Where a one-record redirect points, overriding the record's own CapDetail. */
  redirectTo?: string;
  /** The search page served instead of the fixture (a page with no record-number search). */
  searchPage?: string;
};

const detailUrl = (r: Record, module = "Building") =>
  `${TENANT}/Cap/CapDetail.aspx?Module=${module}&TabName=${module}&capID1=${r.cap[0]}&capID2=${r.cap[1]}&capID3=${r.cap[2]}&agencyCode=TESTCOUNTY`;

/** The stub portal. Every request is logged; a postback that is not the Search control is a FAILURE. */
function stubPortal(opts: PortalOpts) {
  const log: Req[] = [];
  const violations: string[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const form = method === "POST" ? new URLSearchParams(String(init?.body ?? "")) : undefined;
    log.push({ method, url, form, cookie: headers.get("cookie") ?? "" });
    if (init?.redirect !== "manual") violations.push(`${url} fetched with automatic redirects (hops not judged)`);
    const u = new URL(url);
    const module = u.searchParams.get("module") ?? u.searchParams.get("Module") ?? "Building";
    const html = (body: string, extra: Record<string, string> = {}) =>
      new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...extra } });
    if (/\/Cap\/CapHome\.aspx$/i.test(u.pathname) && method === "GET") {
      return html((opts.searchPage ?? CAPHOME).replaceAll("{{MODULE}}", module).replaceAll("{{VIEWSTATE}}", VIEWSTATE),
        { "set-cookie": "ASP.NET_SessionId=synthsession01; path=/; HttpOnly" });
    }
    if (/\/Cap\/CapHome\.aspx$/i.test(u.pathname) && method === "POST") {
      // RULE 1, as the portal sees it: the Search control, the session, the page's own state.
      if (form!.get("__EVENTTARGET") !== "ctl00$PlaceHolderMain$btnNewSearch") violations.push(`postback to ${form!.get("__EVENTTARGET")}`);
      for (const k of form!.keys()) if (/btnPayFees|btnCreateApplication|btnResetSearch|Login/i.test(k)) violations.push(`sent ${k}`);
      if (!/ASP\.NET_SessionId=synthsession01/.test(headers.get("cookie") ?? "")) violations.push("postback without the session cookie");
      if (form!.get("__VIEWSTATE") !== VIEWSTATE || form!.get("__EVENTVALIDATION") !== `EV-${VIEWSTATE}`) violations.push("postback without the page's view state");
      if (form!.get("ctl00$PlaceHolderMain$generalSearchForm$txtGSStartDate") !== "01/01/2024") violations.push("the date range the page rendered was not sent");
      if (form!.has("ctl00$PlaceHolderMain$generalSearchForm$chkGSShowExpired")) violations.push("an unchecked box was sent");
      const q = String(form!.get("ctl00$PlaceHolderMain$generalSearchForm$txtGSPermitNumber") ?? "").trim().toUpperCase();
      // ACA's record-number search matches records that BEGIN with what was typed.
      const hits = q ? opts.records.filter((r) => r.number.toUpperCase().startsWith(q)) : [];
      const row = (r: Record) => `<tr><td>10/16/2026</td><td><a href="${new URL(detailUrl(r, module)).pathname}${new URL(detailUrl(r, module)).search}"><strong><span>${r.number}</span></strong></a></td><td>Residential</td><td>${r.status}</td></tr>`;
      if (hits.length === 0) return html(RESULTS.replaceAll("{{MODULE}}", module).replace("{{ROWS}}", "") + "<p>Your search returned no results.</p>");
      if (hits.length > 1 || opts.oneHit === "list") return html(RESULTS.replaceAll("{{MODULE}}", module).replace("{{ROWS}}", hits.map(row).join("\n")));
      const target = opts.redirectTo ?? `${detailUrl(hits[0]!, module)}&ticket=SESSION-xyz789&culture=en-US`;
      if (opts.oneHit === "async") return html(`1|#||4|25|pageRedirect||${encodeURIComponent(new URL(target).pathname + new URL(target).search)}|`);
      return new Response("", { status: 302, headers: { location: target } });
    }
    if (/\/Cap\/CapDetail\.aspx$/i.test(u.pathname) && method === "GET") {
      const r = opts.records.find((x) => x.cap[2] === u.searchParams.get("capID3"));
      if (!r) return html("<html><body><p>An error has occurred. We are experiencing technical difficulties.</p></body></html>");
      return html(opts.detailFor ? opts.detailFor(r) : CAPDETAIL.replace("{{NUMBER}}", r.number).replace("{{STATUS}}", r.status));
    }
    violations.push(`${method} ${url} is not a search or record page`);
    return new Response("not here", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, log, violations };
}

/** The guard the sweep hands in: a permit track, this AHJ's own portal and tenant (rule 5). */
const allowUrl = (u: string) => Boolean(trackSafeUrl("permit", u)) && samePortal(u, PORTAL);
const ISSUED: Record = { number: "24-001234-STR", status: "Issued", cap: ["24TMP", "00000", "01234"] };
const search = (portal: ReturnType<typeof stubPortal>, num: string, module = "Building") =>
  searchAccelaRecordByNumber(PORTAL, num, { module, allowUrl, fetchImpl: portal.fetchImpl });

await check("(s1) MUST-FIND the record by its number: GET, ONE postback naming the Search control, GET of the record page", async () => {
  const portal = stubPortal({ records: [ISSUED] });
  const r = await search(portal, "24-001234-STR");
  assert.deepEqual(portal.violations, [], portal.violations.join("; "));
  assert.ok(r.found, `not found: ${!r.found ? r.reason : ""}`);
  assert.deepEqual(portal.log.map((x) => x.method), ["GET", "POST", "GET"], "the search was not one page, one postback, one record page");
  assert.equal(portal.log[1]!.url, PORTAL, "the postback did not go to the search page itself");
  assert.equal(portal.log[2]!.cookie.includes("ASP.NET_SessionId=synthsession01"), true, "the record page was fetched without the session");
  assert.match(r.found ? r.link : "", /\/TESTCOUNTY\/Cap\/CapDetail\.aspx\?Module=Building&TabName=Building&capID1=24TMP&capID2=00000&capID3=01234&agencyCode=TESTCOUNTY/);
  assert.match(r.found ? r.text : "", /Record Status: Issued/);
});

await check("(s2) MUST-FIND an async pageRedirect answer, and a list of exactly one record naming the number", async () => {
  for (const oneHit of ["async", "list"] as const) {
    const portal = stubPortal({ records: [ISSUED], oneHit });
    const r = await search(portal, "24-001234-STR");
    assert.deepEqual(portal.violations, []);
    assert.ok(r.found, `${oneHit}: not found: ${!r.found ? r.reason : ""}`);
    assert.match(r.found ? r.link : "", /capID3=01234/);
  }
});

await check("(s3) MUST-EXCLUDE a results list with several records", async () => {
  const portal = stubPortal({ records: [ISSUED, { number: "24-001234-STR-REV", status: "In Review", cap: ["24TMP", "00000", "01235"] }] });
  const r = await search(portal, "24-001234-STR");
  assert.equal(r.found, false, "a record was picked out of a list of several");
  assert.match(!r.found ? r.reason : "", /listed 2 records/);
  assert.deepEqual(portal.log.map((x) => x.method), ["GET", "POST"], "a record page of a several-record list was opened");
});

await check("(s4) MUST-EXCLUDE a similar number: …-STR-REV, or a longer number that starts with this one", async () => {
  for (const other of ["24-001234-STR-REV", "24-001234-STR1"]) {
    const portal = stubPortal({ records: [{ number: other, status: "Issued", cap: ["24TMP", "00000", "07777"] }] });
    const r = await search(portal, "24-001234-STR");
    assert.equal(r.found, false, `${other} was taken for 24-001234-STR`);
    assert.match(!r.found ? r.reason : "", /is not 24-001234-STR/);
  }
  // …and on a one-row list, the row's own number is judged before its page is opened.
  const portal = stubPortal({ records: [{ number: "24-001234-STR-REV", status: "Issued", cap: ["24TMP", "00000", "07777"] }], oneHit: "list" });
  const r = await search(portal, "24-001234-STR");
  assert.equal(r.found, false);
  assert.deepEqual(portal.log.map((x) => x.method), ["GET", "POST"]);
});

await check("(s5) MUST-EXCLUDE a record page that does not name the number", async () => {
  const blank = `<html><body><form id="aspnetForm"><div class="cap_detail"><span>Record Status: Issued</span><span>Expiration Date: 04/16/2027</span><p>Residential Solar, 100 Example Lane</p></div></form></body></html>`;
  for (const detailFor of [() => blank, () => CAPDETAIL.replace("{{NUMBER}}", "24-009999-STR").replace("{{STATUS}}", "Issued")]) {
    const portal = stubPortal({ records: [ISSUED], detailFor });
    const r = await search(portal, "24-001234-STR");
    assert.equal(r.found, false, "a record page that is not this number's was read as its record");
  }
  const portal = stubPortal({ records: [] });
  const none = await search(portal, "24-001234-STR");
  assert.equal(none.found, false);
  assert.match(!none.found ? none.reason : "", /found no record/);
});

await check("(s6) MUST-EXCLUDE rule 1: a page with no record-number search is never posted to", async () => {
  const noSearch = CAPHOME.replace(/<input name="ctl00\$PlaceHolderMain\$generalSearchForm\$txtGSPermitNumber"[^>]*>/, "");
  const portal = stubPortal({ records: [ISSUED], searchPage: noSearch });
  const r = await search(portal, "24-001234-STR");
  assert.equal(r.found, false);
  assert.deepEqual(portal.log.map((x) => x.method), ["GET"], "a page with no record-number search was posted to");
  // A "Search" control that posts back to anything else is not the Search control.
  const renamed = CAPHOME.replace("__doPostBack('ctl00$PlaceHolderMain$btnNewSearch','')", "__doPostBack('ctl00$PlaceHolderMain$btnCreateApplication','')");
  const portal2 = stubPortal({ records: [ISSUED], searchPage: renamed });
  assert.equal((await search(portal2, "24-001234-STR")).found, false);
  assert.deepEqual(portal2.log.map((x) => x.method), ["GET"], "a control posting back elsewhere was clicked");
});

await check("(s7) MUST-EXCLUDE rule 5: a redirect off this AHJ's tenant is not followed", async () => {
  for (const redirectTo of [`${ORIGIN}/OTHERCOUNTY/Cap/CapDetail.aspx?capID1=24TMP&capID2=00000&capID3=01234`,
    "https://pacificorpnetmetering.powerclerk.com/MvcProjects/EditProject?ProjectId=99"]) {
    const portal = stubPortal({ records: [ISSUED], redirectTo });
    const r = await search(portal, "24-001234-STR");
    assert.equal(r.found, false, `${redirectTo} was followed`);
    assert.deepEqual(portal.log.map((x) => x.method), ["GET", "POST"], `${redirectTo} was fetched`);
  }
});

await check("(s8) MUST-PASS the module by suffix first: STR → Building, ELEC → Electrical", () => {
  assert.equal(accelaModulesForNumber("24-001234-STR", PORTAL)[0], "Building");
  assert.equal(accelaModulesForNumber("519-26-001666-ELEC", PORTAL)[0], "Electrical");
  assert.deepEqual(accelaModulesForNumber("519-26-001666-ELEC", PORTAL).slice(0, 2), ["Electrical", "Building"]);
  assert.equal(accelaModulesForNumber("26-000001", `${TENANT}/Cap/CapHome.aspx?module=Planning`)[0], "Planning", "an unknown suffix does not start at the portal's own module");
});

// ── THE SWEEP ─────────────────────────────────────────────────────────────────────────────────────
let portal = stubPortal({ records: [] });
let publicText: string | null = null;
const fetched: string[] = [];
repo.setStatusCheckSeamsForTests({
  checkStatus: (async () => { throw new Error("no signed-in read is expected in this suite"); }) as never,
  publicCheck: (async (url: string) => { fetched.push(url); return publicText; }) as never,
  // The real search, on the stub portal; the guard (allowUrl) and the module are the sweep's own.
  recordSearch: ((url: string, num: string, o: Parameters<typeof searchAccelaRecordByNumber>[2]) =>
    searchAccelaRecordByNumber(url, num, { ...o, fetchImpl: portal.fetchImpl })) as never,
});
const target = (input: { targetType: "permit" | "nem"; permitNumber?: string; applicationNumber?: string; trackingUrl?: string; portalUrl?: string; permitType?: string }) => {
  const projectId = fx.newProject({ ahj: "Searchcounty", utility: "Nowhere Power Co" });
  repo.createPermitCheckTarget(db, projectId, { portalUrl: PORTAL, jurisdiction: "Searchcounty", portalName: "", ...input } as never);
  const id = db.get<{ id: string }>("SELECT id FROM permit_check_targets WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", [projectId])!.id;
  if (input.trackingUrl) db.run("UPDATE permit_check_targets SET tracking_url = ? WHERE id = ?", [input.trackingUrl, id]);
  return id;
};
const row = (id: string) => db.get<{ tracking_url: string; link_lookup_at: string | null; latest_outcome: string | null }>(
  "SELECT tracking_url, link_lookup_at, latest_outcome FROM permit_check_targets WHERE id = ?", [id])!;
const sweep = async (...ids: string[]) => {
  db.run("UPDATE permit_check_targets SET active = 0");
  for (const t of ids) db.run("UPDATE permit_check_targets SET active = 1, next_check_at = NULL WHERE id = ?", [t]);
  portal.log.length = 0;
  fetched.length = 0;
  await repo.runDuePermitChecks(db, "all");
};
const audited = (action: string, targetId: string) => fx.audits(action).map((a) => JSON.parse(a.details)).filter((d) => d.targetId === targetId);
const posts = () => portal.log.filter((x) => x.method === "POST");

await check("(w1) MUST-PASS a permit filing with a number and no link gets its CapDetail as tracking_url; the next sweep is a plain GET", async () => {
  portal = stubPortal({ records: [ISSUED] });
  const t = target({ targetType: "permit", permitNumber: "24-001234-STR" });
  await sweep(t);
  assert.deepEqual(portal.violations, []);
  assert.equal(posts().length, 1, "not exactly one search");
  const clean = detailUrl(ISSUED);
  assert.equal(row(t).tracking_url, clean, "the CapDetail link was not stored, or kept session material");
  assert.equal(row(t).latest_outcome, "issued", `the record page read as ${row(t).latest_outcome}`);
  assert.ok(row(t).link_lookup_at, "the lookup was not stamped");
  assert.equal(audited("permit_target.status_link_found", t)[0]?.from, "the AHJ portal's public record search");
  assert.deepEqual(audited("permit_target.status_link_search", t).map((a) => [a.module, a.found]), [["Building", true]]);

  publicText = "Record 24-001234-STR: Residential Solar Record Status: Finaled";
  await sweep(t);
  publicText = null;
  assert.equal(portal.log.length, 0, "a filing with a link was searched again");
  assert.deepEqual(fetched, [clean], "the stored link was not the one read");
});

await check("(w2) MUST-PASS one search per check, none inside a day, the next module on the next day", async () => {
  portal = stubPortal({ records: [] });
  const t = target({ targetType: "permit", permitNumber: "519-26-001666-ELEC" });
  await sweep(t);
  assert.equal(posts().length, 1, "not exactly one search in the first check");
  assert.match(posts()[0]!.url, /module=Electrical/, "the ELEC record was not searched in the electrical module first");
  assert.equal(row(t).tracking_url, "");
  await sweep(t);
  assert.equal(portal.log.length, 0, "searched twice inside a day");
  db.run("UPDATE permit_check_targets SET link_lookup_at = ? WHERE id = ?", [new Date(Date.now() - 25 * 3600_000).toISOString(), t]);
  await sweep(t);
  assert.equal(posts().length, 1);
  assert.match(posts()[0]!.url, /module=Building/, "the next day did not try the next module");
});

await check("(w3) MUST-EXCLUDE never on a NEM filing, a filing with a link, or a portal that is not Accela", async () => {
  portal = stubPortal({ records: [ISSUED] });
  const nem = target({ targetType: "nem", applicationNumber: "24-001234-STR", permitType: "nem" });
  const linked = target({ targetType: "permit", permitNumber: "24-001234-STR", trackingUrl: detailUrl({ ...ISSUED, cap: ["24TMP", "00000", "05555"] }) });
  const other = target({ targetType: "permit", permitNumber: "24-001234-STR", portalUrl: "https://permits.example-city.gov/apply" });
  await sweep(nem, linked, other);
  assert.equal(portal.log.length, 0, "a NEM filing, a linked filing or a non-Accela portal was searched");
  assert.equal(row(linked).tracking_url, detailUrl({ ...ISSUED, cap: ["24TMP", "00000", "05555"] }), "a link was replaced");
});

await check("(w4) MUST-EXCLUDE a several-record list or a similar number stores nothing and reads no status", async () => {
  portal = stubPortal({ records: [{ number: "24-004321-STR-REV", status: "Issued", cap: ["24TMP", "00000", "04322"] }] });
  const t = target({ targetType: "permit", permitNumber: "24-004321-STR" });
  await sweep(t);
  assert.equal(row(t).tracking_url, "", "a similar number's record was kept as this filing's link");
  // (A never-checked filing that read nothing records the honest "manual check required"; never the
  // other record's Issued.)
  assert.notEqual(row(t).latest_outcome, "issued", "a similar number's status was recorded");
  assert.equal(audited("permit_target.status_link_search", t)[0]?.found, false);
});

repo.setStatusCheckSeamsForTests(null);
finish("accelaRecordSearch");
