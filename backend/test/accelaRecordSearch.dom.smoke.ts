// DOES A PLAIN HTTP POSTBACK REPRODUCE THE BROWSER'S SEARCH? (#443) — settled against the fixture.
//
// searchAccelaRecordByNumber (publicPermitStatus.ts) finds an Accela record by its number with no
// browser: it GETs the module's CapHome search page and posts the form back the way a click on its
// Search control does. This smoke serves the SYNTHETIC ACA search page (fixtures/accela-search/) on a
// local server, has real Chromium type the number and click Search, then runs the HTTP search against
// the same server, and compares what each POSTED: the same field set (every name and value, the
// Search control as __EVENTTARGET, no other button) and the same session cookie, and both land on the
// record page. A difference means the HTTP search no longer sends what a browser sends.
//
// What this cannot settle: whether a live ACA tenant answers the postback the same way (scripts that
// set fields at runtime, an UpdatePanel's async headers, bot screening). That proof is local-only.
//
// Run: npx tsx backend/test/accelaRecordSearch.dom.smoke.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { searchAccelaRecordByNumber } from "../src/publicPermitStatus";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => fs.readFileSync(path.join(HERE, "fixtures", "accela-search", name), "utf8");
const CAPHOME = fixture("caphome.html").replaceAll("{{MODULE}}", "Building").replaceAll("{{VIEWSTATE}}", "VS-smoke-1");
const DETAIL = fixture("capdetail.html").replace("{{NUMBER}}", "24-001234-STR").replace("{{STATUS}}", "Issued");

type Post = { fields: string[]; cookie: string };
const posts: Post[] = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://127.0.0.1");
  if (/\/Cap\/CapHome\.aspx$/i.test(u.pathname) && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": "ASP.NET_SessionId=smoke01; path=/; HttpOnly" });
    res.end(CAPHOME);
    return;
  }
  if (/\/Cap\/CapHome\.aspx$/i.test(u.pathname) && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      posts.push({ fields: [...new URLSearchParams(body)].map(([k, v]) => `${k}=${v}`).sort(), cookie: String(req.headers.cookie ?? "") });
      res.writeHead(302, { location: "/TESTCOUNTY/Cap/CapDetail.aspx?Module=Building&TabName=Building&capID1=24TMP&capID2=00000&capID3=01234&agencyCode=TESTCOUNTY" });
      res.end();
    });
    return;
  }
  if (/\/Cap\/CapDetail\.aspx$/i.test(u.pathname)) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(DETAIL);
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const port = (server.address() as { port: number }).port;
const searchPage = `http://127.0.0.1:${port}/TESTCOUNTY/Cap/CapHome.aspx?module=Building&TabName=Building`;

let failed = 0;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(searchPage);
  await page.fill("#ctl00_PlaceHolderMain_generalSearchForm_txtGSPermitNumber", "24-001234-STR");
  await Promise.all([page.waitForURL(/CapDetail\.aspx/), page.click("#ctl00_PlaceHolderMain_btnNewSearch")]);
  assert.match(await page.textContent("body") ?? "", /Record Status:\s*Issued/, "the browser's search did not land on the record");

  const result = await searchAccelaRecordByNumber(searchPage, "24-001234-STR", { module: "Building", allowUrl: (u) => u.startsWith(`http://127.0.0.1:${port}/TESTCOUNTY/`) });
  assert.equal(result.found, true, `the HTTP search did not land on the record: ${!result.found ? result.reason : ""}`);
  assert.equal(posts.length, 2, `expected one postback from each, saw ${posts.length}`);
  const [byBrowser, byHttp] = posts as [Post, Post];
  assert.ok(byBrowser.fields.includes("__EVENTTARGET=ctl00$PlaceHolderMain$btnNewSearch"), "the browser's click did not post back the Search control");
  assert.deepEqual(byHttp.fields, byBrowser.fields, "the HTTP postback's field set differs from the browser's");
  assert.equal(byHttp.cookie, byBrowser.cookie, "the HTTP postback did not carry the session cookie the browser did");
  console.log("  ok   - a plain HTTP postback sends exactly the browser's search (same fields, same session) and lands on the record");
} catch (err) {
  failed += 1;
  console.log(`  FAIL - ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await browser.close();
  server.close();
}
if (failed) {
  console.log("accelaRecordSearch.dom.smoke FAILED");
  process.exit(1);
}
console.log("accelaRecordSearch.dom.smoke passed");
