// SHARED SERVER POSTURE — real Chromium, the dashboard's own markup, script and stylesheet (#439).
//
// On a shared server, controls that read the SERVER'S disk (MBOX Import Path, the email-watch path,
// the past-project folder scan) or open a window on it (Launch record session, a track card's
// Open recorder) misled a teammate into reading a file on the server they never meant to.
// GET /api/auth/me now says serverIsShared; this pins what the dashboard does with it:
//
//   MUST PASS (shared, sign-in on) — Import Path, Launch record session and Open recorder are not
//             displayed; the email-watch and folder-scan controls say "on the server", with a plain
//             note each; the record helper names this server's URL and points at the recorder token
//             (#433); the record command's --api is this server.
//   MUST PASS (shared, sign-in off) — the same, minus the token sentence.
//   MUST PASS (not shared) — nothing changes: no body class, every note hidden, every control
//             displayed, placeholders and the Scan Folder label exactly as dashboard.html ships them.
//   MUST PASS (an older server with no /api/auth/me) — same as not shared.
//
// Hermetic: a throwaway static server over frontend/, empty envelopes for the boot /api calls,
// /api/auth/me answered per case, everything else 404. No backend, no database.
// Discovered from disk by scripts/run-dom-smokes.ts. Alone: `npx tsx frontend/sharedServerPosture.dom.smoke.ts`

import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

// SHARED_SMOKE_FRONTEND points a kill run at another copy of frontend/ (never edit the live one to test).
const FRONTEND = path.resolve(process.env.SHARED_SMOKE_FRONTEND || path.dirname(fileURLToPath(import.meta.url)));
const failures: string[] = [];
const check = (ok: boolean, label: string, detail = ""): void => {
  if (ok) console.log(`  PASS  ${label}`);
  else { failures.push(detail ? `${label} — ${detail}` : label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".woff2": "font/woff2" };
const API_STUBS: Array<[RegExp, string]> = [
  [/^\/api\/projects$/, '{"projects":[],"total":0}'],
  [/^\/api\/clients/, '{"clients":[]}'],
  [/^\/api\/users/, '{"users":[]}'],
];
// What /api/auth/me answers in the current case; null = 404 (an older server).
let authMe: Record<string, unknown> | null = null;

const startServer = async (): Promise<{ base: string; close: () => Promise<void> }> => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/health") { res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'); return; }
    if (url.pathname === "/api/auth/me") {
      if (!authMe) { res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}'); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(authMe));
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const hit = API_STUBS.find(([re]) => re.test(url.pathname));
      if (!hit) { res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not stubbed"}'); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(hit[1]);
      return;
    }
    const name = url.pathname === "/" ? "dashboard.html" : url.pathname.replace(/^\/+/, "");
    const file = path.join(FRONTEND, name);
    if (file.startsWith(FRONTEND) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" }).end(fs.readFileSync(file));
      return;
    }
    res.writeHead(404).end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
};

// The shipped placeholders and label, read from dashboard.html itself so "nothing changes" is
// measured against the file, not against a copy of it in this smoke.
const HTML = fs.readFileSync(path.join(FRONTEND, "dashboard.html"), "utf8");
const shippedPlaceholder = (id: string): string => (HTML.match(new RegExp(`id="${id}"[^>]*placeholder="([^"]*)"`)) || [])[1] || "";

type Reading = {
  bodyShared: boolean;
  display: Record<string, string>;
  notes: Record<string, { display: string; text: string }>;
  placeholders: Record<string, string>;
  scanLabel: string;
  origin: string;
};

async function readPage(page: { evaluate<T>(fn: () => T): Promise<T> }): Promise<Reading> {
  return page.evaluate(() => {
    // A track card's Open recorder button is rendered per project; the CSS rule is what hides it.
    const probe = document.createElement("button");
    probe.setAttribute("data-track-open-recorder", "nem");
    probe.id = "probeOpenRecorder";
    document.body.appendChild(probe);
    const disp = (sel: string): string => { const el = document.querySelector(sel); return el ? getComputedStyle(el).display : "missing"; };
    const out = {
      bodyShared: document.body.classList.contains("server-shared"),
      display: {
        importPath: disp(".mbox-path-form"),
        launchRecord: disp("#launchRecordBtn"),
        openRecorder: disp("#probeOpenRecorder"),
        downloadBat: disp("#downloadRecordBatBtn"),
        copyCmd: disp("#copyRecordCmdBtn"),
        mboxDrop: disp("#mboxDropZone"),
        emailWatch: disp(".email-watch-form"),
        batchForm: disp(".batch-import-form"),
      },
      notes: Object.fromEntries(["recordSharedNote", "recordCmdSharedNote", "emailWatchSharedNote", "batchFolderSharedNote"].map((id) => {
        const el = document.getElementById(id);
        return [id, { display: el ? getComputedStyle(el).display : "missing", text: el?.textContent || "" }];
      })),
      placeholders: {
        batchFolderPath: (document.getElementById("batchFolderPath") as HTMLInputElement | null)?.placeholder || "",
        emailWatchPath: (document.getElementById("emailWatchPath") as HTMLInputElement | null)?.placeholder || "",
      },
      scanLabel: document.querySelector("#startBatchScanBtn span")?.textContent || "",
      origin: window.location.origin,
    };
    probe.remove();
    return out;
  });
}

async function main(): Promise<void> {
  const { base, close } = await startServer();
  const browser = await chromium.launch({ headless: true });
  const cases: Array<{ name: string; me: Record<string, unknown> | null; shared: boolean; token: boolean }> = [
    { name: "shared server, sign-in on", me: { enabled: true, user: { id: "u1", name: "Pat Tester", email: "pat@example.test", role: "admin" }, serverIsShared: true }, shared: true, token: true },
    { name: "shared server, sign-in off (SERVER_IS_SHARED=1)", me: { enabled: false, user: null, serverIsShared: true }, shared: true, token: false },
    { name: "the owner's own PC (not shared)", me: { enabled: false, user: null, serverIsShared: false }, shared: false, token: false },
    { name: "an older server with no /api/auth/me", me: null, shared: false, token: false },
  ];
  try {
    for (const c of cases) {
      console.log(`\nCASE ${c.name}`);
      authMe = c.me;
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ctx.addInitScript("globalThis.__name = (f) => f;");
      const page = await ctx.newPage();
      await page.route("**://*/**", (route: { request(): { url(): string }; abort(): Promise<void>; continue(): Promise<void> }) =>
        route.request().url().startsWith(base) ? route.continue() : route.abort());
      // The board's /api/projects call is made AFTER the posture is applied at boot.
      const booted = page.waitForRequest((r: { url(): string }) => /\/api\/projects(\?|$)/.test(r.url()), { timeout: 30000 });
      await page.goto(`${base}/#/dashboard`, { waitUntil: "load", timeout: 30000 });
      await booted;
      await page.waitForTimeout(300);
      const r = await readPage(page);

      if (c.shared) {
        check(r.bodyShared, "body carries server-shared");
        for (const k of ["importPath", "launchRecord", "openRecorder"] as const) {
          check(r.display[k] === "none", `${k} is hidden (it reads or opens a window on the server)`, r.display[k]);
        }
        for (const k of ["downloadBat", "copyCmd", "mboxDrop", "emailWatch", "batchForm"] as const) {
          check(r.display[k] !== "none" && r.display[k] !== "missing", `${k} stays (browser upload / your own computer)`, r.display[k]);
        }
        check(/on the server/i.test(r.placeholders.batchFolderPath), "the folder path box says it is a path on the server", r.placeholders.batchFolderPath);
        check(/on the server/i.test(r.placeholders.emailWatchPath), "the email-watch box says it is a path on the server", r.placeholders.emailWatchPath);
        check(/server/i.test(r.scanLabel), "the Scan button says it scans a server folder", r.scanLabel);
        for (const id of ["emailWatchSharedNote", "batchFolderSharedNote", "recordSharedNote", "recordCmdSharedNote"]) {
          check(r.notes[id].display !== "none" && r.notes[id].text.trim().length > 0, `${id} is shown with words`, JSON.stringify(r.notes[id]));
        }
        for (const id of ["recordSharedNote", "recordCmdSharedNote"]) {
          check(r.notes[id].text.includes(r.origin), `${id} names this server's URL (${r.origin})`, r.notes[id].text);
          check(r.notes[id].text.includes("#433") === c.token && /recorder token/.test(r.notes[id].text) === c.token,
            c.token ? `${id} points at the recorder token (#433) because sign-in is on` : `${id} asks for no token with sign-in off`, r.notes[id].text);
        }
      } else {
        check(!r.bodyShared, "body does not carry server-shared");
        for (const [k, v] of Object.entries(r.display)) check(v !== "none" && v !== "missing", `${k} is displayed as before`, v);
        for (const [id, n] of Object.entries(r.notes)) check(n.display === "none", `${id} is not shown`, JSON.stringify(n));
        for (const id of ["batchFolderPath", "emailWatchPath"] as const) {
          check(r.placeholders[id] === shippedPlaceholder(id) && r.placeholders[id].length > 0, `${id} placeholder is exactly what dashboard.html ships`, `${r.placeholders[id]} vs ${shippedPlaceholder(id)}`);
        }
        check(r.scanLabel === "Scan Folder", "the Scan Folder label is unchanged", r.scanLabel);
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    await close();
  }
  console.log(failures.length ? `\nSHARED SERVER POSTURE: ${failures.length} FAILED\n  ${failures.join("\n  ")}` : "\nSHARED SERVER POSTURE: all checks passed.");
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
