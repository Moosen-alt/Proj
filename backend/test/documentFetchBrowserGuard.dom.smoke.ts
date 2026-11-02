// THE WINDOW ASKS BEFORE IT FOLLOWS (issue #407), in a real Chromium.
//
// documentFetchSsrf.test.ts pins browserAttempt's side of the browser rung with a fake window.
// This smoke pins the launcher's side: chromiumDocumentLauncher's DevTools hook (guardBrowserHops)
// really pauses Chromium's own requests and redirects and fails a private one before Chromium
// sends or follows it. Headless, because a container has no display; the hook is the same one
// the headed production launcher installs.
//
// Two stubs on 127.0.0.1: a "public" one (let through by DOCUMENT_FETCH_ALLOW_ORIGINS, exactly
// that origin) and a "private" one on another port, which nothing may reach (request counter).
// The public stub walls the plain rung (403, Akamai shape) and answers the window (whose
// User-Agent says HeadlessChrome) with:
//   - /walled-redirect.pdf   302 into the private stub          → refused, named, never hit
//   - /walled-jsnav          a page whose script navigates there → refused, named, never hit
//   - /walled-img            a page with an <img> there          → page returned, img blocked
//   - /walled-ok.pdf         the document                        → retrieved through the window
//
// Run: tsx backend/test/documentFetchBrowserGuard.dom.smoke.ts
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "document-fetch-browser-guard-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "smoke.sqlite");
process.env.LOG_LEVEL = "error";
delete process.env.DOCUMENT_FETCH;
delete process.env.DOCUMENT_FETCH_BROWSER;

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   - ${name}`);
};

let privateHits = 0;
const privateStub = http.createServer((_req, res) => {
  privateHits++;
  res.writeHead(200, { "content-type": "application/pdf" });
  res.end("%PDF-1.4 internal-only bytes");
});
await new Promise<void>((r) => privateStub.listen(0, "127.0.0.1", () => r()));
const PRIVATE = `http://127.0.0.1:${(privateStub.address() as AddressInfo).port}`;

const publicStub = http.createServer((req, res) => {
  // The plain rung sends a desktop-Chrome User-Agent; this headless window says so in its own.
  const fromWindow = /HeadlessChrome/.test(String(req.headers["user-agent"] || ""));
  const url = String(req.url || "");
  if (url === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end("<html><body>home</body></html>"); return; }
  if (url === "/favicon.ico") { res.writeHead(404); res.end(); return; }
  if (!fromWindow) {
    res.writeHead(403, { "content-type": "text/html", server: "AkamaiGHost" });
    res.end("");
    return;
  }
  if (url === "/walled-redirect.pdf") { res.writeHead(302, { location: `${PRIVATE}/secret.pdf` }); res.end(); return; }
  if (url === "/walled-jsnav") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><body>moving<script>location.href = ${JSON.stringify(`${PRIVATE}/secret.html`)};</script></body></html>`);
    return;
  }
  if (url === "/walled-img") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><body><h1>Fee schedule index</h1><img src="${PRIVATE}/pixel.png"></body></html>`);
    return;
  }
  if (url === "/walled-ok.pdf") { res.writeHead(200, { "content-type": "application/pdf" }); res.end("%PDF-1.4 public bytes"); return; }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((r) => publicStub.listen(0, "127.0.0.1", () => r()));
const PUBLIC = `http://127.0.0.1:${(publicStub.address() as AddressInfo).port}`;
process.env.DOCUMENT_FETCH_ALLOW_ORIGINS = PUBLIC;

const { fetchPublicDocument, chromiumDocumentLauncher } = await import("../src/documentFetch");
const launcher = chromiumDocumentLauncher(true);
const opts = { launcher, browserTimeoutMs: 30_000 };

try {
  {
    privateHits = 0;
    const got = await fetchPublicDocument(`${PUBLIC}/walled-redirect.pdf`, opts);
    check("in-page fetch 302 → private: refused at the response stage, named",
      !got.ok && got.via === "browser" && got.privateTarget === `${PRIVATE}/secret.pdf` && /redirected to/i.test(got.reason), `${got.reason} privateTarget=${got.privateTarget}`);
    check("in-page fetch 302 → private: the private stub was NEVER hit", privateHits === 0, `hits=${privateHits}`);
  }
  {
    privateHits = 0;
    const got = await fetchPublicDocument(`${PUBLIC}/walled-redirect.pdf`, { ...opts, render: true });
    check("navigation 302 → private (render mode): refused, named",
      !got.ok && got.via === "browser" && got.privateTarget === `${PRIVATE}/secret.pdf`, `${got.reason} privateTarget=${got.privateTarget}`);
    check("navigation 302 → private: the private stub was NEVER hit", privateHits === 0, `hits=${privateHits}`);
  }
  {
    privateHits = 0;
    const got = await fetchPublicDocument(`${PUBLIC}/walled-jsnav`, { ...opts, render: true });
    check("a page's own script navigating into the LAN: refused at the request stage, named",
      !got.ok && got.privateTarget === `${PRIVATE}/secret.html` && /sent to/i.test(got.reason), `${got.reason} privateTarget=${got.privateTarget}`);
    check("script navigation: the private stub was NEVER hit", privateHits === 0, `hits=${privateHits}`);
  }
  {
    privateHits = 0;
    const got = await fetchPublicDocument(`${PUBLIC}/walled-img`, { ...opts, render: true });
    check("a private <img> on a public page: the page is still returned", got.ok && got.via === "browser" && /Fee schedule index/.test(String(got.text)), got.reason);
    check("a private <img>: blocked, the private stub was NEVER hit", privateHits === 0, `hits=${privateHits}`);
  }
  {
    privateHits = 0;
    const got = await fetchPublicDocument(`${PUBLIC}/walled-ok.pdf`, opts);
    check("control: a public document behind a wall comes through the window", got.ok && got.via === "browser" && !got.privateTarget
      && new TextDecoder().decode(got.bytes).startsWith("%PDF"), got.reason);
  }
} catch (err) {
  failures++;
  console.error(`FAIL - smoke threw: ${err instanceof Error ? err.stack || err.message : String(err)}`);
} finally {
  publicStub.close();
  privateStub.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\ndocumentFetchBrowserGuard: all checks passed.");
process.exit(0);
