// TEAM MODAL SIGN-INS (issue #431) — real Chromium, the dashboard's own markup, script and stylesheet.
//
//   MUST PASS — admin, sign-in on: selecting a teammate shows whether they can sign in; Set/Reset
//               password posts ONLY to /api/staff/logins/<id>/password, refuses a short password
//               without a request, and clears the box; Deactivate asks first and posts active:false;
//               a NEW member given a password goes to POST /api/staff/logins with the chosen role
//               (Admin opens only then); Change my password refuses a mismatch without a request
//               and posts current + new to /api/auth/password; the admin's own entry offers no reset.
//   MUST PASS — a name carrying markup renders as text (no injected element).
//   MUST PASS — operator, sign-in on: no admin controls ("Only an admin…"), Change my password works.
//   MUST PASS — sign-in off: both sections say sign-in is off and show no controls; a new member
//               has no password box.
//   MUST PASS — at 1280 and 390: no input overflows the editor pane; no horizontal page scroll.
//
// Hermetic: a throwaway static server over frontend/ with stubbed /api/auth/me, /api/users and
// /api/staff/logins (synthetic people, synthetic passwords), everything else 404. No backend,
// no database. Discovered from disk by scripts/run-dom-smokes.ts.
// Alone: `npx tsx frontend/staffSignIn.dom.smoke.ts`

import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const FRONTEND = path.resolve(process.env.STAFF_SMOKE_FRONTEND || path.dirname(fileURLToPath(import.meta.url)));
const failures: string[] = [];
const check = (ok: boolean, label: string, detail = ""): void => {
  if (ok) console.log(`  PASS  ${label}`);
  else { failures.push(detail ? `${label} — ${detail}` : label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};

type Mode = "admin" | "operator" | "off";
const ME_ADMIN = { id: "u-admin", name: "Admin Person", email: "admin@team.test", role: "admin", orgId: "org-default" };
const ME_OPERATOR = { id: "u-op", name: "Op Person", email: "op@team.test", role: "operator", orgId: "org-default" };
const USERS = [
  { id: "u-admin", name: "Admin Person", email: "admin@team.test", role: "admin", color: "#6366f1", active: true, createdAt: "2026-10-01", orgId: "org-default" },
  { id: "u-op", name: "Op Person", email: "op@team.test", role: "operator", color: "#0ea5e9", active: true, createdAt: "2026-10-02", orgId: "org-default" },
  { id: "u-x", name: "<img src=x id=injected>", email: "x@team.test", role: "operator", color: "#22c55e", active: true, createdAt: "2026-10-03", orgId: "org-default" },
];
const LOGINS = USERS.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, active: u.active, hasLogin: u.id !== "u-x", createdAt: u.createdAt }));

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".woff2": "font/woff2" };

type Posted = { path: string; body: Record<string, unknown> };
const startServer = async (mode: Mode, posted: Posted[]): Promise<{ base: string; close: () => Promise<void> }> => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname.startsWith("/api/")) {
      let raw = "";
      req.on("data", (c) => { raw += String(c); });
      req.on("end", () => {
        const p = url.pathname;
        if (req.method === "POST") posted.push({ path: p, body: raw ? JSON.parse(raw) as Record<string, unknown> : {} });
        if (p === "/api/auth/me") return json(200, mode === "off" ? { enabled: false, user: null } : { enabled: true, user: mode === "admin" ? ME_ADMIN : ME_OPERATOR });
        if (p === "/api/users" && req.method === "GET") return json(200, USERS);
        if (p === "/api/staff/logins" && req.method === "GET") {
          if (mode === "off") return json(200, { authEnabled: false, logins: [] });
          if (mode === "operator") return json(403, { error: "Admin access required." });
          return json(200, { authEnabled: true, logins: LOGINS });
        }
        if (p === "/api/staff/logins" && req.method === "POST") return json(201, { login: { id: "u-new", name: "New", email: "new@team.test", role: "admin", active: true, hasLogin: true } });
        if (/^\/api\/staff\/logins\/[^/]+\/(password|active)$/.test(p)) return json(200, { login: LOGINS[1] });
        if (p === "/api/auth/password") return json(200, { ok: true });
        return json(404, { error: "not stubbed" });
      });
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Page = any;
const visible = (page: Page, id: string): Promise<boolean> => page.evaluate((i: string) => {
  const el = document.getElementById(i);
  return Boolean(el && (el as HTMLElement).offsetParent !== null && el.getBoundingClientRect().height > 0);
}, id);
const text = (page: Page, id: string): Promise<string> => page.evaluate((i: string) => document.getElementById(i)?.textContent || "", id);
const settle = (page: Page) => page.waitForTimeout(250);
const selectUser = async (page: Page, id: string) => { await page.click(`#usersList [data-user-id="${id}"]`); await settle(page); };

async function openTeam(browser: Page, mode: Mode, width: number, height: number) {
  const posted: Posted[] = [];
  const { base, close } = await startServer(mode, posted);
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addInitScript("globalThis.__name = (f) => f;");
  const page = await ctx.newPage();
  page.on("dialog", (d: { accept(): Promise<void> }) => d.accept());
  await page.route("**://*/**", (route: { request(): { url(): string }; abort(): Promise<void>; continue(): Promise<void> }) =>
    route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.goto(`${base}/#/dashboard`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(400);
  await page.evaluate(() => (document.getElementById("openUsersBtn") as HTMLButtonElement).click());
  await page.waitForSelector("#usersList [data-user-id]", { timeout: 15000 });
  await settle(page);
  return { page, posted, done: async () => { await ctx.close(); await close(); } };
}

async function layout(page: Page, tag: string) {
  const g = await page.evaluate(() => {
    const pane = document.querySelector("#usersModal .users-editor-pane")!.getBoundingClientRect();
    const overflow: string[] = [];
    document.querySelectorAll("#usersModal .users-editor-pane input:not([type=hidden]), #usersModal .users-editor-pane select").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.left < pane.left - 1 || r.right > pane.right + 1)) overflow.push(el.id);
    });
    return { overflow, hScroll: document.documentElement.scrollWidth > innerWidth, children: document.querySelector("#usersModal .modal-body")!.children.length };
  });
  check(g.children === 2, `${tag}: the modal body keeps two columns (list + one editor pane)`, String(g.children));
  check(g.overflow.length === 0, `${tag}: no input overflows the editor pane`, g.overflow.join(","));
  check(!g.hScroll, `${tag}: no horizontal page scroll`);
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    // ---- admin, sign-in on -------------------------------------------------
    console.log("\nADMIN, SIGN-IN ON (1280)");
    {
      const { page, posted, done } = await openTeam(browser, "admin", 1280, 800);
      check(!(await page.evaluate(() => document.getElementById("injected"))), "a name carrying markup renders as text");
      await selectUser(page, "u-admin");
      check((await text(page, "staffSignInState")).includes("This is you"), "the admin's own entry offers no reset", await text(page, "staffSignInState"));
      check(!(await visible(page, "sl_setPasswordBtn")), "no Set password button on your own entry");

      await selectUser(page, "u-op");
      check((await text(page, "staffSignInState")).includes("can sign in"), "a teammate with a login reads 'can sign in'", await text(page, "staffSignInState"));
      check((await text(page, "sl_setPasswordBtn")).includes("Reset password"), "the button says Reset password");
      check(await visible(page, "sl_toggleActiveBtn"), "Deactivate login is offered");

      await page.fill("#sl_password", "short");
      await page.click("#sl_setPasswordBtn"); await settle(page);
      check(posted.length === 0, "a short password is refused without a request", JSON.stringify(posted));
      check((await text(page, "staffSignInStatus")).includes("at least 10"), "and says why");

      await page.fill("#sl_password", "synthetic-reset-pass-1");
      await page.click("#sl_setPasswordBtn"); await settle(page);
      const reset = posted.find((p) => p.path === "/api/staff/logins/u-op/password");
      check(Boolean(reset) && reset!.body.password === "synthetic-reset-pass-1", "Reset password posts to the teammate's password route", JSON.stringify(posted));
      check((await page.inputValue("#sl_password")) === "", "the password box is cleared after");
      check(!(await page.evaluate(() => document.body.innerText.includes("synthetic-reset-pass-1"))), "the password is never shown back");

      await page.click("#sl_toggleActiveBtn"); await settle(page);
      const off = posted.find((p) => p.path === "/api/staff/logins/u-op/active");
      check(Boolean(off) && off!.body.active === false, "Deactivate posts active:false after the confirm", JSON.stringify(posted));

      await selectUser(page, "u-x");
      check((await text(page, "staffSignInState")).includes("no sign-in yet"), "a passwordless entry reads 'no sign-in yet'", await text(page, "staffSignInState"));
      check((await text(page, "sl_setPasswordBtn")).includes("Set password"), "and offers Set password");
      check(!(await visible(page, "sl_toggleActiveBtn")), "and no Deactivate (nothing to switch off)");

      // A new member with a password becomes a login; Admin opens only then.
      await page.click("#newUserBtn"); await settle(page);
      check(await visible(page, "u_password"), "a new member offers a sign-in password box");
      const adminDisabledBefore = await page.evaluate(() => (document.querySelector('#u_role option[value="admin"]') as HTMLOptionElement).disabled);
      check(adminDisabledBefore, "Admin is shut for a plain new member");
      await page.fill("#u_name", "New Teammate");
      await page.fill("#u_email", "new@team.test");
      await page.fill("#u_password", "synthetic-new-pass-1");
      const adminDisabledAfter = await page.evaluate(() => (document.querySelector('#u_role option[value="admin"]') as HTMLOptionElement).disabled);
      check(!adminDisabledAfter, "Admin opens once a sign-in password is given");
      await page.selectOption("#u_role", "admin");
      await page.evaluate(() => (document.querySelector('#userForm button[type="submit"]') as HTMLButtonElement).click());
      await settle(page);
      const created = posted.find((p) => p.path === "/api/staff/logins");
      check(Boolean(created) && created!.body.role === "admin" && created!.body.password === "synthetic-new-pass-1" && created!.body.email === "new@team.test",
        "Save posts the new member to POST /api/staff/logins with the role", JSON.stringify(created));
      check(!posted.some((p) => p.path === "/api/users"), "and not to the passwordless POST /api/users");

      // Change my password.
      await page.fill("#mp_current", "synthetic-current-1");
      await page.fill("#mp_new", "synthetic-next-pass-1");
      await page.fill("#mp_repeat", "synthetic-next-pass-2");
      await page.click("#mp_saveBtn"); await settle(page);
      check(!posted.some((p) => p.path === "/api/auth/password"), "a mismatched repeat is refused without a request");
      await page.fill("#mp_repeat", "synthetic-next-pass-1");
      await page.click("#mp_saveBtn"); await settle(page);
      const mine = posted.find((p) => p.path === "/api/auth/password");
      check(Boolean(mine) && mine!.body.currentPassword === "synthetic-current-1" && mine!.body.newPassword === "synthetic-next-pass-1",
        "Change my password posts current + new to /api/auth/password", JSON.stringify(mine));
      check((await page.inputValue("#mp_current")) === "" && (await page.inputValue("#mp_new")) === "", "the password boxes are cleared after");

      await selectUser(page, "u-op");
      // STAFF_SMOKE_SHOT=<dir> keeps a picture of the modal for a reviewer.
      if (process.env.STAFF_SMOKE_SHOT) await page.screenshot({ path: path.join(process.env.STAFF_SMOKE_SHOT, "team-signin-admin-1280.png") });
      await layout(page, "1280px admin");
      await done();
    }

    console.log("\nADMIN, SIGN-IN ON (390)");
    {
      const { page, done } = await openTeam(browser, "admin", 390, 844);
      await selectUser(page, "u-op");
      await layout(page, "390px admin");
      await done();
    }

    // ---- operator, sign-in on ----------------------------------------------
    console.log("\nOPERATOR, SIGN-IN ON");
    {
      const { page, done } = await openTeam(browser, "operator", 1280, 800);
      await selectUser(page, "u-admin");
      check((await text(page, "staffSignInState")).includes("Only an admin"), "an operator sees no admin controls", await text(page, "staffSignInState"));
      check(!(await visible(page, "sl_setPasswordBtn")), "no Set password button for an operator");
      check(await visible(page, "mp_saveBtn"), "an operator can still change their own password");
      await done();
    }

    // ---- sign-in off ---------------------------------------------------------
    console.log("\nSIGN-IN OFF");
    {
      const { page, posted, done } = await openTeam(browser, "off", 1280, 800);
      await selectUser(page, "u-op");
      check((await text(page, "staffSignInState")).includes("Sign-in is off"), "the Sign-in section says sign-in is off", await text(page, "staffSignInState"));
      check((await text(page, "myPasswordState")).includes("Sign-in is off"), "Change my password says sign-in is off");
      check(!(await visible(page, "sl_setPasswordBtn")) && !(await visible(page, "mp_saveBtn")), "no password controls are shown");
      await page.click("#newUserBtn"); await settle(page);
      check(!(await visible(page, "u_password")), "a new member has no password box");
      check(!posted.some((p) => p.path.startsWith("/api/staff") || p.path === "/api/auth/password"), "nothing was posted to the sign-in routes");
      await layout(page, "1280px off");
      await done();
    }
  } finally {
    await browser.close();
  }
  console.log(failures.length ? `\nSTAFF SIGN-IN: ${failures.length} FAILED\n  ${failures.join("\n  ")}` : "\nSTAFF SIGN-IN: all checks passed.");
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
