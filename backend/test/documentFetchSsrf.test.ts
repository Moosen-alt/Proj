// THE FORM-FILL TOOL IS NOT A WAY INTO THE LAN (issue #391).
//
// POST /api/tools/form-fill/fetch (and /lookup, and /batch rows with URLs) takes an org API key
// and fetches a caller-supplied URL server-side through fetchPublicDocument. That path checked
// the scheme and nothing else, followed redirects on its own, and on a 403 opened a HEADED
// Chromium. So a key holder could have the server fetch its own loopback API, the cloud-metadata
// address, or a public URL that 302s into the LAN — and open a window on the operator's desktop.
//
// Pinned here:
//   1. the shared predicate (publicUrlGuard) refuses every private spelling, including the IPv6
//      ones that embed a loopback IPv4 address and a bracketed literal;
//   2. fetchPublicDocument refuses a loopback URL, 169.254.169.254, and a redirect from an
//      allowed origin to a private one — and the private stub is NEVER hit (request counter);
//   3. the form-fill tool's fetch options never launch the browser on a 403 (fake launcher,
//      counted), where the default options do;
//   4. the same over real HTTP: the spawned server answers 400 for each refused target with the
//      private stub never hit, and a 403 origin comes back 422 with the browser fallback off.
//
// No real browser runs: the in-process checks use a fake launcher, and the spawned server gets
// an empty PLAYWRIGHT_BROWSERS_PATH, so even a regression could not open a window.
//
// Run: tsx backend/test/documentFetchSsrf.test.ts
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "document-fetch-ssrf-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "inproc.sqlite");
process.env.LOG_LEVEL = "error";
delete process.env.DOCUMENT_FETCH;
delete process.env.DOCUMENT_FETCH_BROWSER;
// No browser can start in this process either: on a tree without the fix the tool path ignores
// the fake launcher and would reach the real one.
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(tmpDir, "no-browsers");

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   - ${name}`);
};

// --- two stub servers: the "public" document host and the private target it points at --------
let publicHits = 0;
let privateHits = 0;
const privateStub = http.createServer((_req, res) => {
  privateHits++;
  res.writeHead(200, { "content-type": "application/pdf" });
  res.end("%PDF-1.4 internal-only bytes");
});
await new Promise<void>((r) => privateStub.listen(0, "127.0.0.1", () => r()));
const PRIVATE = `http://127.0.0.1:${(privateStub.address() as AddressInfo).port}`;

const publicStub = http.createServer((req, res) => {
  publicHits++;
  if (req.url === "/to-private") {
    res.writeHead(302, { location: `${PRIVATE}/secret.pdf` });
    res.end();
    return;
  }
  if (req.url === "/to-metadata") {
    res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
    res.end();
    return;
  }
  if (req.url === "/walled.pdf") {
    // The Akamai shape: 403, empty body. The ladder's cue to open a real window.
    res.writeHead(403, { "content-type": "text/html", server: "AkamaiGHost" });
    res.end("");
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((r) => publicStub.listen(0, "127.0.0.1", () => r()));
const PUBLIC = `http://127.0.0.1:${(publicStub.address() as AddressInfo).port}`;
// The stub stands in for a public host. Only its exact origin is let through; the private stub,
// on the same address but another port, is not.
process.env.DOCUMENT_FETCH_ALLOW_ORIGINS = PUBLIC;

// Dynamic imports so this file runs to the end on a tree without the fix and reports each
// failure, rather than dying on the first missing export.
const guard = await import("../src/publicUrlGuard").catch(() => null) as null | typeof import("../src/publicUrlGuard");
const { fetchPublicDocument } = await import("../src/documentFetch");
const ahjFormAuto = await import("../src/ahjFormAuto");
const toolFetch = (ahjFormAuto as { FORM_FILL_TOOL_FETCH?: { allowBrowser?: boolean } }).FORM_FILL_TOOL_FETCH;

// --- 1. the predicate -------------------------------------------------------------------------
check("1. publicUrlGuard exists (one predicate for both fetch doors)", !!guard);
if (guard) {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "::1", "::", "fe80::1", "fd00::5", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe", "2002:7f00:1::"]) {
    check(`1. private: ${ip}`, guard.ipIsPrivate(ip) === true);
  }
  for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::6810:84e5"]) check(`1. public: ${ip}`, guard.ipIsPrivate(ip) === false);
  for (const u of ["http://[::1]:9/x.pdf", "http://[::ffff:127.0.0.1]:9/x.pdf", "http://169.254.169.254/latest/meta-data/", "http://2130706433/x.pdf", "file:///etc/passwd"]) {
    const why = await guard.publicUrlRefusal(u).catch((e: Error) => `threw: ${e.message}`);
    check(`1. refused without a DNS lookup: ${u}`, !!why && !why.startsWith("threw"), String(why));
  }
  check("1. the allowed origin passes", (await guard.publicUrlRefusal(`${PUBLIC}/x.pdf`)) === null);
  check("1. the same host on another port does not", (await guard.publicUrlRefusal(`${PRIVATE}/x.pdf`)) !== null);
}

// --- 2. fetchPublicDocument, every hop ----------------------------------------------------------
{
  privateHits = 0;
  const got = await fetchPublicDocument(`${PRIVATE}/secret.pdf`, { allowBrowser: false });
  check("2. loopback URL refused", !got.ok && !!(got as { privateTarget?: string }).privateTarget, got.reason);
  check("2. loopback URL: the private stub was never hit", privateHits === 0, `hits=${privateHits}`);
}
{
  const t0 = Date.now();
  const got = await fetchPublicDocument("http://169.254.169.254/latest/meta-data/", { allowBrowser: false, timeoutMs: 3_000 });
  check("2. metadata address refused before any request", !got.ok && got.status === 0 && /refus/i.test(got.reason)
    && !!(got as { privateTarget?: string }).privateTarget, got.reason);
  check("2. metadata address: refused at once, not after a connect timeout", Date.now() - t0 < 1_500, `${Date.now() - t0}ms`);
}
{
  privateHits = 0;
  publicHits = 0;
  const got = await fetchPublicDocument(`${PUBLIC}/to-private`, { allowBrowser: false });
  check("2. public → 302 → private: refused", !got.ok && (got as { privateTarget?: string }).privateTarget === `${PRIVATE}/secret.pdf`, got.reason);
  check("2. public → 302 → private: the public host was asked once", publicHits === 1, `hits=${publicHits}`);
  check("2. public → 302 → private: the private stub was NEVER hit", privateHits === 0, `hits=${privateHits}`);
  check("2. the refusal names the redirect", /redirected to/i.test(got.reason), got.reason);
}
{
  const got = await fetchPublicDocument(`${PUBLIC}/to-metadata`, { allowBrowser: false, timeoutMs: 3_000 });
  check("2. public → 302 → 169.254.169.254: refused", !got.ok && /169\.254\.169\.254/.test(String((got as { privateTarget?: string }).privateTarget)), got.reason);
}

// --- 3. the tool's options never launch the browser ----------------------------------------------
{
  let launches = 0;
  const launcher = async () => { launches++; throw new Error("fake launcher: no browser in this test"); };
  const control = await ahjFormAuto.fetchPdfOutcome(`${PUBLIC}/walled.pdf`, { launcher } as never);
  check("3. control: default options on a 403 DO reach the browser rung", launches === 1, `launches=${launches} reason=${control.reason ?? ""}`);
  launches = 0;
  const tool = await ahjFormAuto.fetchPdfOutcome(`${PUBLIC}/walled.pdf`, { ...(toolFetch || {}), launcher } as never);
  check("3. FORM_FILL_TOOL_FETCH exists and forbids the browser", toolFetch?.allowBrowser === false);
  check("3. a 403 under the tool's options never launches Chromium", launches === 0 && !tool.bytes, `launches=${launches}`);
}

// --- 4. over real HTTP, through /api/tools/form-fill/* -------------------------------------------
function freePortInBand(start: number, count: number): number {
  for (let i = 0; i < count; i++) {
    const candidate = start + i;
    try {
      execFileSync(process.execPath, ["-e", `require("net").createServer().listen(${candidate},"0.0.0.0",function(){this.close()}).on("error",()=>process.exit(1))`], { stdio: "ignore" });
      return candidate;
    } catch { /* held — try the next */ }
  }
  return start + Math.floor(Math.random() * count);
}
const PORT = freePortInBand(5420, 20);
const BASE = `http://127.0.0.1:${PORT}`;
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const env: Record<string, string | undefined> = {
  ...process.env,
  AUTOPILOT_DB_PATH: path.join(tmpDir, "server.sqlite"),
  BACKUP_DIR: path.join(tmpDir, "backups"),
  DATA_DIR: path.join(tmpDir, "data"),
  PORT: String(PORT),
  SEED_TEST_INSTALLER: "false",
  AUTOPILOT_AUTO_START: "0",
  MONITOR_INTERVAL_MINUTES: "0",
  LOG_LEVEL: "warn",
  ANTHROPIC_API_KEY: "",
  SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
  DOCUMENT_FETCH_ALLOW_ORIGINS: PUBLIC,
  // Belt and braces: even if a route forgot allowBrowser:false, Playwright finds no browser here
  // and the launch fails — the test can never open a window. The reason it reports differs, and
  // that difference is what check 4 reads.
  PLAYWRIGHT_BROWSERS_PATH: path.join(tmpDir, "no-browsers"),
  NO_PROXY: "*",
  no_proxy: "*",
};
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "DOCUMENT_FETCH", "DOCUMENT_FETCH_BROWSER", "AUTH_ENABLED"]) delete env[k];

const server = spawn(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "backend/src/server.ts")], { env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout?.on("data", (d) => { serverLog += String(d); });
server.stderr?.on("data", (d) => { serverLog += String(d); });

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server never answered ${BASE}/health (port ${PORT}).\n${serverLog.slice(-2000)}`);
}

const post = (p: string, body: unknown) => fetch(`${BASE}${p}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

try {
  await waitForServer();
  for (const [label, url] of [
    ["loopback", `${PRIVATE}/secret.pdf`],
    ["link-local metadata", "http://169.254.169.254/latest/meta-data/"],
    ["public host that 302s to a private one", `${PUBLIC}/to-private`],
  ] as const) {
    privateHits = 0;
    const res = await post("/api/tools/form-fill/fetch", { url });
    const text = await res.text();
    check(`4. /fetch ${label}: 400`, res.status === 400, `status=${res.status} ${text.slice(0, 200)}`);
    check(`4. /fetch ${label}: the private stub was never hit`, privateHits === 0, `hits=${privateHits}`);
  }
  {
    privateHits = 0;
    const res = await post("/api/tools/form-fill/batch", { rows: [{ url: `${PUBLIC}/to-private`, data: {} }] });
    const body = await res.json() as { results?: Array<{ ok: boolean; error?: string }> };
    const row = body.results?.[0];
    check("4. /batch row with a redirect to a private host: refused", !!row && !row.ok && /refus/i.test(String(row.error)), JSON.stringify(row));
    check("4. /batch: the private stub was never hit", privateHits === 0, `hits=${privateHits}`);
  }
  {
    const res = await post("/api/tools/form-fill/fetch", { url: `${PUBLIC}/walled.pdf` });
    const text = await res.text();
    check("4. /fetch on a 403 origin: 422", res.status === 422, `status=${res.status}`);
    check("4. /fetch on a 403 origin: the browser fallback was OFF, not merely unable to start",
      /browser fallback is switched off/i.test(text) && !/could not start/i.test(text), text.slice(0, 300));
  }
} catch (err) {
  failures++;
  console.error(`FAIL - server checks: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  server.kill();
  publicStub.close();
  privateStub.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\ndocumentFetchSsrf: all checks passed.");
process.exit(0);
