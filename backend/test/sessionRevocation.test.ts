// REVOCABLE SIGN-IN SESSIONS (issue #432).
//
// The session cookie is a signed token, so before #432 a copied cookie stayed good until it
// expired (12 h), whatever happened to the login. Now each cookie names the users.session_version
// it was issued under and currentUser refuses it once the column has moved on. Boots the real
// server on a temp sqlite with sign-in on (staffLogins.test.ts shape) and pins one block per bump:
//
//   Sign out everywhere      POST /api/auth/logout-everywhere ends EVERY cookie the user holds,
//                            this one included; no session is 401; a teammate is untouched
//   own password change      POST /api/auth/password ends the other devices' cookies and the old
//                            cookie of this one, and hands this device a fresh cookie that works
//   admin reset              POST /api/staff/logins/:id/password ends the teammate's cookies
//   deactivation             POST /api/staff/logins/:id/active false ends them, and switching the
//                            login back on does NOT revive them; the Team panel's Active box
//                            (PUT /api/users/:id) does the same
//   pre-#432 cookie          a two-field cookie (no version) keeps working, then dies on the
//                            first bump like any other
//   forged shapes            a signed cookie with a non-numeric or extra field is refused
//
// The test process never writes the DB while the server runs (SQLITE_BUSY lesson): every change
// goes through the HTTP API, and the audit check reads after the server has stopped.
//
// KILL: drop the session_version comparison in currentUser → every "stops working" check fails;
// drop the bump from setUserPassword → "own password change" and "admin reset" fail; drop
// issueSessionCookie from POST /api/auth/password → "this device stays signed in" fails; drop the
// bump from setStaffLoginActive or updateUser → the matching "back on does not revive" fails.
//
// Run: tsx backend/test/sessionRevocation.test.ts
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-revocation-test-"));

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

// Synthetic people, passwords and secret only.
const AUTH_SECRET = "session-revocation-test-secret-not-real";
const OWNER = { email: "owner@revoke.test", password: "owner-revoke-pass-1" };

// Own band: 5870-5879 (staffLogins.test.ts holds 5840-5859; the other server suites sit lower).
const PORT = freePortInBand(5870, 10);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(tmpDir, "revoke.sqlite");

function boot(): { server: ChildProcess; log: () => string } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    AUTOPILOT_DB_PATH: DB_PATH,
    PROJECT_DOCS_DIR: path.join(tmpDir, "docs"),
    BACKUP_DIR: path.join(tmpDir, "backups"),
    AUTOPILOT_AUTO_START: "0",
    PORT: String(PORT),
    SEED_TEST_INSTALLER: "false",
    MONITOR_INTERVAL_MINUTES: "0",
    LOG_LEVEL: "info",
    ANTHROPIC_API_KEY: "",
    SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
    AUTH_SECRET,
    AUTH_ENABLED: "true",
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

async function waitForServer(log: () => string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server never answered ${BASE}/health within 60s\nlog tail:\n${log().slice(-2000)}`);
}

const cookieOf = (res: Response) => String(res.headers.get("set-cookie") || "").split(";")[0];

async function call(cookie: string, p: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(`${BASE}${p}`, { ...init, headers });
}
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const put = (body: unknown): RequestInit => ({ method: "PUT", body: JSON.stringify(body) });

async function signIn(email: string, password: string): Promise<string> {
  const res = await call("", "/api/auth/login", post({ email, password }));
  const text = await res.text();
  assert.equal(res.status, 200, `login ${email}: ${res.status} ${text}`);
  const cookie = cookieOf(res);
  assert.match(cookie, /^sa_session=/, "login set no session cookie");
  return cookie;
}

/** Whether this cookie is a live session: /api/auth/me names the user AND a gated route answers. */
async function isSignedIn(cookie: string): Promise<boolean> {
  const me = await (await call(cookie, "/api/auth/me")).json() as { user: { id: string } | null };
  const gated = await call(cookie, "/api/users");
  await gated.text();
  assert.equal(Boolean(me.user), gated.status !== 401, `me and the gate disagree (me=${JSON.stringify(me.user)}, gate=${gated.status})`);
  return Boolean(me.user);
}

/** A cookie in exactly the server's format, signed with the test's AUTH_SECRET. */
function mintCookie(fields: string[]): string {
  const payload = Buffer.from(fields.join("|")).toString("base64url");
  const sig = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("base64url");
  return `sa_session=${encodeURIComponent(`${payload}.${sig}`)}`;
}
const inAnHour = () => String(Date.now() + 3600_000);

// Seed BEFORE boot (the test process never writes while the server runs): a login that already
// existed before #432, i.e. a row sitting at the column's default version 0 with a password, the
// state every real login is in on the morning of the deploy. setUserPassword now bumps the version
// (a fresh login starts at 1), so the fixture puts the row back to 0 the way the migration finds it.
const PAT = { id: "user-pat-pre-432", email: "pat@revoke.test", password: "pat-first-password-1" };
{
  process.env.AUTOPILOT_DB_PATH = DB_PATH;
  const { openDatabase } = await import("../src/db");
  const { setUserPassword } = await import("../src/auth");
  const db = await openDatabase();
  db.run(
    "INSERT INTO users (id, name, email, role, color, active, created_at, org_id) VALUES (?, 'Pat', ?, 'operator', '#000000', 1, ?, 'org-default')",
    [PAT.id, PAT.email, new Date().toISOString()],
  );
  setUserPassword(db, PAT.id, PAT.password);
  db.run("UPDATE users SET session_version = 0 WHERE id = ?", [PAT.id]);
  // The admin too: with a password already on Pat, the ADMIN_EMAIL seed would not run.
  db.run(
    "INSERT INTO users (id, name, email, role, color, active, created_at, org_id) VALUES ('user-owner', 'Owner', ?, 'admin', '#000000', 1, ?, 'org-default')",
    [OWNER.email, new Date().toISOString()],
  );
  setUserPassword(db, "user-owner", OWNER.password);
  db.close();
}

const one = boot();
const mates: Record<string, { id: string; email: string; password: string }> = {};
try {
  await waitForServer(one.log);
  const owner = await signIn(OWNER.email, OWNER.password);

  // Teammates, made through the API (never a DB write from this process while the server runs).
  for (const [key, email] of [["ana", "ana@revoke.test"], ["ben", "ben@revoke.test"], ["cy", "cy@revoke.test"], ["di", "di@revoke.test"], ["ed", "ed@revoke.test"]]) {
    const password = `${key}-first-password-1`;
    const res = await call(owner, "/api/staff/logins", post({ name: key, email, role: "operator", password }));
    const text = await res.text();
    assert.equal(res.status, 201, text);
    mates[key] = { id: (JSON.parse(text) as { login: { id: string } }).login.id, email, password };
  }

  // --- the pre-#432 cookie ----------------------------------------------------------------------
  await run("a pre-#432 cookie (no version field) still signs in after the deploy", async () => {
    assert.equal(await isSignedIn(mintCookie([PAT.id, inAnHour()])), true);
  });
  await run("a pre-#432 cookie dies on the user's first bump, like any other", async () => {
    const legacy = mintCookie([PAT.id, inAnHour()]);
    const current = await signIn(PAT.email, PAT.password);
    const res = await call(current, "/api/auth/logout-everywhere", post({}));
    assert.equal(res.status, 200, await res.text());
    assert.equal(await isSignedIn(legacy), false, "the pre-#432 cookie survived Sign out everywhere");
    assert.equal(await isSignedIn(current), false);
  });
  await run("a signed cookie whose version is not a plain number is refused", async () => {
    assert.equal(await isSignedIn(mintCookie([mates.ana.id, inAnHour(), "0x0"])), false);
    assert.equal(await isSignedIn(mintCookie([mates.ana.id, inAnHour(), "-1"])), false);
    assert.equal(await isSignedIn(mintCookie([mates.ana.id, inAnHour(), ""])), false);
  });
  await run("a signed cookie with an extra field is refused", async () => {
    assert.equal(await isSignedIn(mintCookie([mates.ana.id, inAnHour(), "0", "0"])), false);
  });
  await run("a cookie naming a version the user is not at yet is refused", async () => {
    assert.equal(await isSignedIn(mintCookie([mates.ana.id, inAnHour(), "99"])), false);
  });

  // --- Sign out everywhere ----------------------------------------------------------------------
  await run("Sign out everywhere ends every session the user has, this one included", async () => {
    const laptop = await signIn(mates.ana.email, mates.ana.password);
    const phone = await signIn(mates.ana.email, mates.ana.password);
    const mate = await signIn(mates.ben.email, mates.ben.password);
    for (const c of [laptop, phone]) assert.equal(await isSignedIn(c), true, "not signed in before");

    const res = await call(phone, "/api/auth/logout-everywhere", post({}));
    assert.equal(res.status, 200, await res.text());
    assert.match(String(res.headers.get("set-cookie") || ""), /sa_session=;/, "the response did not clear this browser's cookie");

    assert.equal(await isSignedIn(laptop), false, "the other device is still signed in");
    assert.equal(await isSignedIn(phone), false, "the device that pressed it is still signed in");
    assert.equal(await isSignedIn(mate), true, "a teammate was signed out too");
    // And signing in again works, at the new version.
    assert.equal(await isSignedIn(await signIn(mates.ana.email, mates.ana.password)), true);
  });
  await run("Sign out everywhere with no session is 401", async () => {
    const res = await call("", "/api/auth/logout-everywhere", post({}));
    assert.equal(res.status, 401, await res.text());
  });
  await run("a correctly signed cookie at the user's OLD version stays refused after the bump", async () => {
    // ana started at 1 (her password was set when the login was made) and is at 2 now.
    assert.equal(await isSignedIn(mintCookie([mates.ana.id, inAnHour(), "1"])), false);
    assert.equal(await isSignedIn(mintCookie([mates.ana.id, inAnHour(), "2"])), true, "the fixture's version arithmetic is off");
  });

  // --- own password change ----------------------------------------------------------------------
  await run("changing my own password signs out my other devices and keeps this one signed in", async () => {
    const here = await signIn(mates.ben.email, mates.ben.password);
    const elsewhere = await signIn(mates.ben.email, mates.ben.password);
    const next = "ben-second-password-1";
    const res = await call(here, "/api/auth/password", post({ currentPassword: mates.ben.password, newPassword: next }));
    assert.equal(res.status, 200, await res.text());
    const fresh = cookieOf(res);
    assert.match(fresh, /^sa_session=.+/, "the change did not hand this device a fresh cookie");
    assert.equal(await isSignedIn(fresh), true, "this device was signed out by its own change");
    assert.equal(await isSignedIn(elsewhere), false, "the other device is still signed in");
    assert.equal(await isSignedIn(here), false, "the cookie from before the change still works");
    mates.ben.password = next;
  });

  // --- admin reset ------------------------------------------------------------------------------
  await run("an admin's password reset ends the teammate's open sessions", async () => {
    const session = await signIn(mates.cy.email, mates.cy.password);
    assert.equal(await isSignedIn(session), true);
    const next = "cy-reset-password-12";
    const res = await call(owner, `/api/staff/logins/${mates.cy.id}/password`, post({ password: next }));
    assert.equal(res.status, 200, await res.text());
    assert.equal(await isSignedIn(session), false, "the teammate's session survived the reset");
    assert.equal(await isSignedIn(owner), true, "the admin who reset it was signed out");
    assert.equal(await isSignedIn(await signIn(mates.cy.email, next)), true);
  });

  // --- deactivation, both doors -----------------------------------------------------------------
  await run("deactivating a login ends its sessions, and switching it back on does not revive them", async () => {
    const session = await signIn(mates.di.email, mates.di.password);
    let res = await call(owner, `/api/staff/logins/${mates.di.id}/active`, post({ active: false }));
    assert.equal(res.status, 200, await res.text());
    assert.equal(await isSignedIn(session), false);
    res = await call(owner, `/api/staff/logins/${mates.di.id}/active`, post({ active: true }));
    assert.equal(res.status, 200, await res.text());
    assert.equal(await isSignedIn(session), false, "switching the login back on revived the old cookie");
    assert.equal(await isSignedIn(await signIn(mates.di.email, mates.di.password)), true);
  });
  await run("the Team panel's Active box (PUT /api/users/:id) does the same", async () => {
    const session = await signIn(mates.ed.email, mates.ed.password);
    let res = await call(owner, `/api/users/${mates.ed.id}`, put({ active: false }));
    assert.equal(res.status, 200, await res.text());
    assert.equal(await isSignedIn(session), false);
    res = await call(owner, `/api/users/${mates.ed.id}`, put({ active: true }));
    assert.equal(res.status, 200, await res.text());
    assert.equal(await isSignedIn(session), false, "ticking Active again revived the old cookie");
    assert.equal(await isSignedIn(await signIn(mates.ed.email, mates.ed.password)), true);
  });
  await run("an edit that leaves Active alone signs nobody out", async () => {
    const session = await signIn(mates.ed.email, mates.ed.password);
    const res = await call(owner, `/api/users/${mates.ed.id}`, put({ name: "Ed Renamed" }));
    assert.equal(res.status, 200, await res.text());
    assert.equal(await isSignedIn(session), true);
  });
} finally {
  one.server.kill();
  await new Promise((r) => setTimeout(r, 500));
}

// After the server has stopped: the action is in the audit log with who pressed it.
await run("Sign out everywhere is audit-logged with the user's email", async () => {
  process.env.AUTOPILOT_DB_PATH = DB_PATH;
  const { openDatabase } = await import("../src/db");
  const db = await openDatabase();
  try {
    const row = db.get<{ actor_name: string; details: string }>(
      "SELECT actor_name, details FROM audit_logs WHERE action = 'user.signed_out_everywhere' ORDER BY rowid DESC LIMIT 1",
    );
    assert.equal(row?.actor_name, mates.ana.email);
    assert.equal((JSON.parse(String(row?.details)) as { userId: string }).userId, mates.ana.id);
  } finally { db.close(); }
});

// The migration (v52) is safe to replay: a database that runs it again keeps the column and every
// user's version, so a replay never signs anyone back in or out.
await run("replaying migration v52 keeps the column and the users' versions", async () => {
  process.env.AUTOPILOT_DB_PATH = DB_PATH;
  const { openDatabase } = await import("../src/db");
  let db = await openDatabase();
  const before = db.get<{ v: number }>("SELECT session_version AS v FROM users WHERE id = ?", [mates.ana.id])?.v;
  db.run("DELETE FROM schema_meta WHERE version >= 52");
  db.close();
  db = await openDatabase();
  try {
    assert.equal(db.get<{ v: number }>("SELECT session_version AS v FROM users WHERE id = ?", [mates.ana.id])?.v, before);
    assert.ok(Number(before) >= 2, `ana's version is ${before}`);
    assert.ok(db.get("SELECT 1 FROM schema_meta WHERE version = 52"), "v52 was not recorded again");
  } finally { db.close(); }
});

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0 ? "\nsessionRevocation: all checks passed" : `\nsessionRevocation: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
