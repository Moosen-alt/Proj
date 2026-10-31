// STAFF LOGINS FROM THE DASHBOARD (issue #431).
//
// An admin creates, resets and deactivates teammates' logins; anyone signed in changes their
// own password. Boots the real server on a temp sqlite (kbEntryDelete.test.ts shape), twice:
// Part 1 with AUTH_ENABLED=true, Part 2 with sign-in off.
//
// Pinned, one block per route:
//   GET  /api/staff/logins               lists the admin's OWN org only; operators get 403
//   POST /api/staff/logins               makes a login that can sign in; operator|admin only;
//                                        audited with the actor's email; duplicate email 409
//   POST /api/staff/logins/:id/password  resets; another org's id is 404 (rule 6), never 403;
//                                        not your own; not a superadmin's (unless you are one)
//   POST /api/staff/logins/:id/active    off kills an OPEN session on the next request; not
//                                        your own; back on works; audited
//   POST /api/auth/password              no session 401; wrong current password 400 and
//                                        throttled; the new one works and the old one doesn't
//   sign-in off                          every route says so (409 auth_disabled) instead of
//                                        writing passwords nothing uses
// And across all of it: no password reaches audit_logs or the server log.
//
// KILL: drop requireAdmin from requireStaffAdmin → "an operator gets 403" fails; drop the
// org_id predicate in loginInOrg → "another org's id is 404" fails; drop the !AUTH_ENABLED
// check → Part 2 fails; drop the current-password check → "a wrong current password" fails.
//
// Run: tsx backend/test/staffLogins.test.ts
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "staff-logins-test-"));

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

let failures = 0;
const run = async (label: string, fn: () => Promise<void> | void) => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// Synthetic people and passwords only. Every password used is collected so the end of the
// test can prove none of them was written anywhere.
const OWNER = { email: "owner@operator.test", password: "owner-test-password-1" };
const PASSWORDS = new Set<string>([OWNER.password]);
const pw = (p: string) => { PASSWORDS.add(p); return p; };

function boot(port: number, dbPath: string, authOn: boolean): { server: ChildProcess; log: () => string } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    AUTOPILOT_DB_PATH: dbPath,
    PROJECT_DOCS_DIR: path.join(tmpDir, "docs"),
    BACKUP_DIR: path.join(tmpDir, "backups"),
    AUTOPILOT_AUTO_START: "0",
    PORT: String(port),
    SEED_TEST_INSTALLER: "false",
    MONITOR_INTERVAL_MINUTES: "0",
    LOG_LEVEL: "info",
    ANTHROPIC_API_KEY: "",
    SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
    AUTH_ENABLED: authOn ? "true" : "",
    ADMIN_EMAIL: OWNER.email,
    ADMIN_PASSWORD: OWNER.password,
    NO_PROXY: "*",
    no_proxy: "*",
  };
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
  const server = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "backend/src/server.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout?.on("data", (d) => { log += String(d); });
  server.stderr?.on("data", (d) => { log += String(d); });
  return { server, log: () => log };
}

async function waitForServer(base: string, log: () => string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server never answered ${base}/health within 60s\nlog tail:\n${log().slice(-2000)}`);
}

type Call = (p: string, init?: RequestInit) => Promise<Response>;
const client = (base: string, cookie = ""): Call => (p, init = {}) => {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(`${base}${p}`, { ...init, headers });
};
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

// Own band: 5840-5859 (the other server-booting suites sit below 5760).
const PORT = freePortInBand(5840, 10);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(tmpDir, "auth-on.sqlite");

const tryLogin = async (base: string, email: string, password: string): Promise<{ status: number; cookie: string }> => {
  const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  await res.text();
  return { status: res.status, cookie: String(res.headers.get("set-cookie") || "").split(";")[0] };
};
const loginAs = async (email: string, password: string): Promise<Call> => {
  const { status, cookie } = await tryLogin(BASE, email, password);
  assert.equal(status, 200, `login ${email} failed with ${status}`);
  return client(BASE, cookie);
};
const readDb = async <T>(dbPath: string, fn: (db: import("../src/db").AppDb) => T): Promise<T> => {
  process.env.AUTOPILOT_DB_PATH = dbPath;
  const { openDatabase } = await import("../src/db");
  const db = await openDatabase();
  try { return fn(db); } finally { db.close(); }
};
const lastAudit = (action: string) => readDb(DB_PATH, (db) => db.get<{ actor_name: string; details: string }>(
  "SELECT actor_name, details FROM audit_logs WHERE action = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", [action],
));

// Seed before boot: a superadmin in the default org (the owner's own top login) with no password.
{
  process.env.AUTOPILOT_DB_PATH = DB_PATH;
  const { openDatabase } = await import("../src/db");
  const db = await openDatabase();
  db.run(
    "INSERT INTO users (id, name, email, role, color, active, created_at, org_id) VALUES ('user-super', 'Super Person', 'super@operator.test', 'superadmin', '#000000', 1, ?, 'org-default')",
    [new Date().toISOString()],
  );
  db.close();
}

// ---------------------------------------------------------------------------
// Part 1: sign-in on.
// ---------------------------------------------------------------------------
const one = boot(PORT, DB_PATH, true);
try {
  await waitForServer(BASE, one.log);
  const owner = await loginAs(OWNER.email, OWNER.password);
  const anon = client(BASE);

  // --- POST /api/staff/logins ------------------------------------------------
  let opId = "";
  const OP = { email: "operator.one@team.test", password: pw("operator-pass-1234") };
  await run("POST /api/staff/logins refuses a password under 10 characters", async () => {
    const res = await owner("/api/staff/logins", post({ name: "Op One", email: OP.email, role: "operator", password: pw("short") }));
    assert.equal(res.status, 400, await res.text());
  });
  await run("POST /api/staff/logins refuses the superadmin role", async () => {
    const res = await owner("/api/staff/logins", post({ name: "Nope", email: "nope@team.test", role: "superadmin", password: pw("long-enough-pass") }));
    assert.equal(res.status, 400, await res.text());
    assert.ok(!(await readDb(DB_PATH, (db) => db.get("SELECT 1 FROM users WHERE email = 'nope@team.test'"))), "a superadmin row was created");
  });
  await run("POST /api/staff/logins makes an operator login that can sign in, audited with the actor's email", async () => {
    const res = await owner("/api/staff/logins", post({ name: "Op One", email: OP.email, role: "operator", password: OP.password }));
    const text = await res.text();
    assert.equal(res.status, 201, text);
    const login = (JSON.parse(text) as { login: { id: string; role: string; hasLogin: boolean; active: boolean } }).login;
    assert.equal(login.role, "operator");
    assert.equal(login.hasLogin, true);
    assert.equal(login.active, true);
    assert.ok(!text.includes(OP.password), "the response echoed the password");
    assert.ok(!/password_hash|salt/i.test(text), "the response carried hash material");
    opId = login.id;
    assert.equal((await tryLogin(BASE, OP.email, OP.password)).status, 200);
    const audit = await lastAudit("staff.login_created");
    assert.equal(audit?.actor_name, OWNER.email);
    assert.equal((JSON.parse(String(audit?.details)) as { userId: string }).userId, opId);
  });
  await run("POST /api/staff/logins can make an admin", async () => {
    const res = await owner("/api/staff/logins", post({ name: "Ad Min", email: "admin.two@team.test", role: "admin", password: pw("admin-two-pass-1") }));
    const text = await res.text();
    assert.equal(res.status, 201, text);
    assert.equal((JSON.parse(text) as { login: { role: string } }).login.role, "admin");
  });
  await run("POST /api/staff/logins refuses an email already in use (409)", async () => {
    const res = await owner("/api/staff/logins", post({ name: "Dup", email: OP.email.toUpperCase(), role: "operator", password: pw("another-pass-12") }));
    assert.equal(res.status, 409, await res.text());
  });

  // --- the gate --------------------------------------------------------------
  const operator = await loginAs(OP.email, OP.password);
  await run("an operator gets 403 on every admin route, and nothing changes", async () => {
    for (const [p, init] of [
      ["/api/staff/logins", {}],
      ["/api/staff/logins", post({ name: "X", email: "x@team.test", role: "operator", password: "xxxxxxxxxxxx" })],
      [`/api/staff/logins/${opId}/password`, post({ password: "xxxxxxxxxxxx" })],
      ["/api/staff/logins/user-super/active", post({ active: false })],
    ] as Array<[string, RequestInit]>) {
      const res = await operator(p, init);
      assert.equal(res.status, 403, `${init.method || "GET"} ${p}: ${res.status} ${await res.text()}`);
    }
    assert.ok(!(await readDb(DB_PATH, (db) => db.get("SELECT 1 FROM users WHERE email = 'x@team.test'"))), "an operator created a login");
  });
  await run("no session gets 401 on the admin routes", async () => {
    assert.equal((await anon("/api/staff/logins")).status, 401);
    assert.equal((await anon("/api/staff/logins", post({}))).status, 401);
  });

  // --- another org (rule 6) --------------------------------------------------
  let foreignId = "";
  await run("set-up: another org with its own login", async () => {
    const org = await owner("/api/orgs", post({ name: "Other Co (TEST)", edition: "full", products: ["autopilot"] }));
    const orgId = (JSON.parse(await org.text()) as { org: { id: string } }).org.id;
    const user = await owner(`/api/orgs/${orgId}/users`, post({ name: "Foreign", email: "foreign@other.test", password: pw("foreign-pass-1234") }));
    const text = await user.text();
    assert.equal(user.status, 201, text);
    foreignId = (JSON.parse(text) as { user: { id: string } }).user.id;
    // The org-users route now writes its hash through setUserPassword: that login still works.
    assert.equal((await tryLogin(BASE, "foreign@other.test", "foreign-pass-1234")).status, 200);
  });

  // --- GET /api/staff/logins -------------------------------------------------
  await run("GET /api/staff/logins lists the admin's own org only, with who can sign in, never a hash", async () => {
    const res = await owner("/api/staff/logins");
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const body = JSON.parse(text) as { authEnabled: boolean; logins: Array<{ id: string; email: string; hasLogin: boolean }> };
    assert.equal(body.authEnabled, true);
    const emails = body.logins.map((l) => l.email);
    assert.ok(emails.includes(OWNER.email) && emails.includes(OP.email), emails.join(","));
    assert.ok(!emails.includes("foreign@other.test"), "another org's login is listed");
    assert.equal(body.logins.find((l) => l.email === "super@operator.test")?.hasLogin, false);
    assert.ok(!/password_hash|"[0-9a-f]{32}:[0-9a-f]{64,}"/.test(text), "hash material in the list");
  });

  // --- POST /api/staff/logins/:id/password -----------------------------------
  await run("reset: another org's id is 404, never 403, and its password is untouched", async () => {
    const res = await owner(`/api/staff/logins/${foreignId}/password`, post({ password: pw("hijacked-pass-123") }));
    assert.equal(res.status, 404, await res.text());
    assert.equal((await tryLogin(BASE, "foreign@other.test", "foreign-pass-1234")).status, 200);
  });
  await run("reset: an unknown id is 404", async () => {
    assert.equal((await owner("/api/staff/logins/no-such-user/password", post({ password: "whatever-long-1" }))).status, 404);
  });
  await run("reset: the admin can't reset their own password this way (no current-password check)", async () => {
    const me = await (await owner("/api/auth/me")).json() as { user: { id: string } };
    const res = await owner(`/api/staff/logins/${me.user.id}/password`, post({ password: pw("self-reset-pass-1") }));
    assert.equal(res.status, 400, await res.text());
  });
  await run("reset: an org admin can't reset a superadmin's password (403)", async () => {
    const res = await owner("/api/staff/logins/user-super/password", post({ password: pw("super-reset-pass-1") }));
    assert.equal(res.status, 403, await res.text());
  });
  const OP_RESET = pw("operator-reset-5678");
  await run("reset: the new password works, the old one doesn't, audited as staff.password_reset", async () => {
    const res = await owner(`/api/staff/logins/${opId}/password`, post({ password: OP_RESET }));
    assert.equal(res.status, 200, await res.text());
    assert.equal((await tryLogin(BASE, OP.email, OP.password)).status, 401);
    assert.equal((await tryLogin(BASE, OP.email, OP_RESET)).status, 200);
    const audit = await lastAudit("staff.password_reset");
    assert.equal(audit?.actor_name, OWNER.email);
    assert.equal((JSON.parse(String(audit?.details)) as { userId: string }).userId, opId);
  });
  await run("reset gives a passwordless Team entry its first login", async () => {
    const dir = await owner("/api/users", post({ name: "Dir Entry", email: "dir.entry@team.test" }));
    const dirId = (JSON.parse(await dir.text()) as { id: string }).id;
    const clash = await owner("/api/staff/logins", post({ name: "Dir Entry", email: "dir.entry@team.test", role: "operator", password: pw("dir-entry-pass-1") }));
    const clashText = await clash.text();
    assert.equal(clash.status, 409, clashText);
    assert.match(clashText, /Set password/);
    const res = await owner(`/api/staff/logins/${dirId}/password`, post({ password: "dir-entry-pass-1" }));
    assert.equal(res.status, 200, await res.text());
    assert.equal((await tryLogin(BASE, "dir.entry@team.test", "dir-entry-pass-1")).status, 200);
    const audit = await lastAudit("staff.login_created");
    assert.equal((JSON.parse(String(audit?.details)) as { userId: string }).userId, dirId);
  });

  // --- POST /api/staff/logins/:id/active -------------------------------------
  await run("deactivate: refuses a non-boolean, your own login, and another org's id (404)", async () => {
    assert.equal((await owner(`/api/staff/logins/${opId}/active`, post({ active: "no" }))).status, 400);
    const me = await (await owner("/api/auth/me")).json() as { user: { id: string } };
    assert.equal((await owner(`/api/staff/logins/${me.user.id}/active`, post({ active: false }))).status, 400);
    assert.equal((await owner(`/api/staff/logins/${foreignId}/active`, post({ active: false }))).status, 404);
    assert.equal((await tryLogin(BASE, "foreign@other.test", "foreign-pass-1234")).status, 200);
  });
  await run("deactivate: an OPEN session stops working on its next request, and sign-in is refused", async () => {
    const live = await loginAs(OP.email, OP_RESET);
    assert.equal((await live("/api/users")).status, 200);
    const res = await owner(`/api/staff/logins/${opId}/active`, post({ active: false }));
    assert.equal(res.status, 200, await res.text());
    assert.equal((await live("/api/users")).status, 401);
    assert.equal((await tryLogin(BASE, OP.email, OP_RESET)).status, 401);
    const audit = await lastAudit("staff.login_deactivated");
    assert.equal(audit?.actor_name, OWNER.email);
  });
  await run("reactivate: sign-in works again, audited", async () => {
    const res = await owner(`/api/staff/logins/${opId}/active`, post({ active: true }));
    assert.equal(res.status, 200, await res.text());
    assert.equal((await tryLogin(BASE, OP.email, OP_RESET)).status, 200);
    assert.equal((await lastAudit("staff.login_reactivated"))?.actor_name, OWNER.email);
  });

  // --- POST /api/auth/password -----------------------------------------------
  await run("self-change: no session is 401", async () => {
    const res = await anon("/api/auth/password", post({ currentPassword: OP_RESET, newPassword: "whatever-long-1" }));
    assert.equal(res.status, 401, await res.text());
  });
  const self = await loginAs(OP.email, OP_RESET);
  await run("self-change: a wrong current password is refused and nothing changes", async () => {
    const res = await self("/api/auth/password", post({ currentPassword: pw("not-my-password"), newPassword: pw("operator-new-9999") }));
    assert.equal(res.status, 400, await res.text());
    assert.equal((await tryLogin(BASE, OP.email, OP_RESET)).status, 200);
  });
  await run("self-change: a too-short new password is refused", async () => {
    const res = await self("/api/auth/password", post({ currentPassword: OP_RESET, newPassword: pw("tiny") }));
    assert.equal(res.status, 400, await res.text());
  });
  const OP_NEW = pw("operator-new-9999");
  await run("self-change: the new password works, the old one doesn't, audited with the user's email", async () => {
    const res = await self("/api/auth/password", post({ currentPassword: OP_RESET, newPassword: OP_NEW }));
    assert.equal(res.status, 200, await res.text());
    assert.equal((await tryLogin(BASE, OP.email, OP_RESET)).status, 401);
    assert.equal((await tryLogin(BASE, OP.email, OP_NEW)).status, 200);
    assert.equal((await lastAudit("user.password_changed"))?.actor_name, OP.email);
  });
  await run("self-change: wrong current passwords are throttled (429 after 5)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await self("/api/auth/password", post({ currentPassword: `wrong-guess-${i}`, newPassword: "never-applied-123" }))).status);
    }
    assert.deepEqual(statuses, [400, 400, 400, 400, 400, 429]);
    // Even the right password is held off while locked.
    assert.equal((await self("/api/auth/password", post({ currentPassword: OP_NEW, newPassword: "never-applied-123" }))).status, 429);
    assert.equal((await tryLogin(BASE, OP.email, OP_NEW)).status, 200);
  });

  // --- nothing written anywhere ----------------------------------------------
  await run("no password reaches audit_logs or the server log", async () => {
    const audits = await readDb(DB_PATH, (db) => db.query<{ details: string; actor_name: string }>("SELECT details, actor_name FROM audit_logs"));
    const haystack = audits.map((a) => `${a.actor_name} ${a.details}`).join("\n") + "\n" + one.log();
    const leaked = [...PASSWORDS].filter((p) => haystack.includes(p));
    assert.deepEqual(leaked, [], "password(s) written to the audit log or the server log");
  });
} finally {
  one.server.kill();
}

// ---------------------------------------------------------------------------
// Part 2: sign-in off. The routes say so instead of writing passwords nothing uses.
// ---------------------------------------------------------------------------
const PORT2 = freePortInBand(5850, 10);
const BASE2 = `http://127.0.0.1:${PORT2}`;
const DB2 = path.join(tmpDir, "auth-off.sqlite");
const two = boot(PORT2, DB2, false);
try {
  await waitForServer(BASE2, two.log);
  const anyone = client(BASE2);
  await run("sign-in off: GET says authEnabled false and lists nobody", async () => {
    const res = await anyone("/api/staff/logins");
    const body = await res.json() as { authEnabled: boolean; logins: unknown[] };
    assert.equal(res.status, 200);
    assert.equal(body.authEnabled, false);
    assert.deepEqual(body.logins, []);
  });
  await run("sign-in off: every write is 409 auth_disabled and no password is stored", async () => {
    for (const [p, body] of [
      ["/api/staff/logins", { name: "Off", email: "off@team.test", role: "operator", password: "off-mode-pass-1" }],
      ["/api/staff/logins/whoever/password", { password: "off-mode-pass-1" }],
      ["/api/staff/logins/whoever/active", { active: false }],
      ["/api/auth/password", { currentPassword: "a", newPassword: "off-mode-pass-1" }],
    ] as Array<[string, unknown]>) {
      const res = await anyone(p, post(body));
      const json = await res.json() as { error: string; details: { code?: string } };
      assert.equal(res.status, 409, `${p}: ${res.status}`);
      assert.equal(json.details.code, "auth_disabled", p);
      assert.match(json.error, /Sign-in is off/);
    }
    const stored = await readDb(DB2, (db) => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE password_hash <> ''"));
    assert.equal(Number(stored?.n), 0);
  });
} finally {
  two.server.kill();
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0 ? "\nstaffLogins: all checks passed" : `\nstaffLogins: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
