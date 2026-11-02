// RECORDER TOKENS (issue #433, shared server #429).
//
// The portal recorder CLI runs on a person's own computer and posts to the server; with sign-in on
// it has no cookie, so a signed-in person mints a recorder token in the dashboard. Boots the real
// server on a temp sqlite (staffLogins.test.ts shape), twice: Part 1 with AUTH_ENABLED=true, Part 2
// with sign-in off.
//
// Pinned:
//   REACH      a token authenticates EXACTLY the recorder's four endpoints; on staging, approval,
//              admin, minting, any other recipe route and a variant spelling of a recorder route it
//              401s and nothing changes (hard rule 1: never approves or stages; rule 6: deny by
//              default). Proven with an ADMIN's token, the most a token could ever carry.
//   IDENTITY   audit rows from a recording name the token's person (portal_recipe.recording_started,
//              portal_recipe.steps_saved, via recorder_token); the recipe's created_by is that person,
//              not a body field. The org scope guard sees that person too: another org's project
//              is 404 on staging-field-values and on suggest-bindings (body id).
//   LIFECYCLE  shown once (never in a list, the audit log or the server log; stored as sha256);
//              revoked, expired, or a switched-off login stops it on the next request; default 30
//              days, at most 90; another person's token id is 404 on revoke; no session, no list.
//   AUTH OFF   the recorder works as today with no token; minting says sign-in is off (409).
//   CLI        the requests are built with the CLI's own recorderRequestHeaders, so the header the
//              CLI sends is the header the server reads.
//
// KILL: drop the isRecorderRoute check in requireAuth → every REACH row fails; drop the
// recorderPrincipal read in currentUser → the positive rows 401; drop `u.active = 1` → "a
// switched-off login" fails; drop the expires_at check → "an expired token" fails; drop
// assertRefInScope on suggest-bindings → "another org's project in the body" fails.
//
// Run: tsx backend/test/recorderTokens.test.ts
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recorderRequestHeaders } from "../../portal-bot/src/recordRecipe";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recorder-tokens-test-"));

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

// Synthetic people only. Every token minted is collected so the end can prove none was written anywhere.
const OWNER = { email: "owner@operator.test", password: "owner-test-password-1" };
const OP = { name: "Rec Order", email: "recorder.op@team.test", password: "recorder-op-pass-1" };
const TOKENS = new Set<string>();
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

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
const withCookie = (base: string, cookie = ""): Call => (p, init = {}) => {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(`${base}${p}`, { ...init, headers });
};
/** A request exactly as the recorder CLI makes it: its own header builder, no cookie. */
const withRecorderToken = (base: string, token: string): Call => (p, init = {}) => fetch(`${base}${p}`, {
  ...init,
  headers: { ...recorderRequestHeaders({ token, cfAccessClientId: "", cfAccessClientSecret: "" }, { json: Boolean(init.body) }), ...(init.headers as Record<string, string> | undefined) },
});
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

// Own band: 5880-5889 (staffLogins holds 5840-5859; the others sit below 5760).
const PORT = freePortInBand(5880, 5);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(tmpDir, "auth-on.sqlite");

const tryLogin = async (email: string, password: string): Promise<{ status: number; cookie: string }> => {
  const res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  await res.text();
  return { status: res.status, cookie: String(res.headers.get("set-cookie") || "").split(";")[0] };
};
const loginAs = async (email: string, password: string): Promise<Call> => {
  const { status, cookie } = await tryLogin(email, password);
  assert.equal(status, 200, `login ${email} failed with ${status}`);
  return withCookie(BASE, cookie);
};
// READS ONLY while a server runs (review lesson: a test-process write beside a spawned server on the
// same DB flakes with SQLITE_BUSY). Every fixture that needs a direct write is made before boot.
const readDb = async <T>(dbPath: string, fn: (db: import("../src/db").AppDb) => T): Promise<T> => {
  process.env.AUTOPILOT_DB_PATH = dbPath;
  const { openDatabase } = await import("../src/db");
  const db = await openDatabase();
  try { return fn(db); } finally { db.close(); }
};
const auditRows = (action: string) => readDb(DB_PATH, (db) => db.query<{ actor_name: string; details: string }>(
  "SELECT actor_name, details FROM audit_logs WHERE action = ? ORDER BY created_at ASC, rowid ASC", [action],
));

// Fixtures written BEFORE boot: a second operator holding an EXPIRED token and a REVOKED one.
const EXPIRED = "rt_test-expired-token-not-real-0000000000000";
const REVOKED = "rt_test-revoked-token-not-real-0000000000000";
{
  process.env.AUTOPILOT_DB_PATH = DB_PATH;
  const { openDatabase } = await import("../src/db");
  const db = await openDatabase();
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO users (id, name, email, role, color, active, created_at, org_id) VALUES ('user-old', 'Old Hand', 'old.hand@team.test', 'operator', '#000000', 1, ?, 'org-default')",
    [now],
  );
  db.run(
    "INSERT INTO recorder_tokens (id, user_id, name, token_hash, created_at, expires_at) VALUES ('rt-expired', 'user-old', 'old', ?, ?, ?)",
    [sha256(EXPIRED), "2026-01-01T00:00:00.000Z", "2026-01-31T00:00:00.000Z"],
  );
  db.run(
    "INSERT INTO recorder_tokens (id, user_id, name, token_hash, created_at, expires_at, revoked_at, revoked_by) VALUES ('rt-revoked', 'user-old', 'old', ?, ?, ?, ?, 'old.hand@team.test')",
    [sha256(REVOKED), now, new Date(Date.now() + 86_400_000).toISOString(), now],
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
  const anon = withCookie(BASE);

  // People and data: an operator in the default org, a second org with its own project.
  let opId = "";
  let projOwn = "";
  let projOther = "";
  await run("setup: an operator, a project in the default org, and another org's project", async () => {
    const made = await owner("/api/staff/logins", json("POST", { name: OP.name, email: OP.email, role: "operator", password: OP.password }));
    const madeText = await made.text();
    assert.equal(made.status, 201, madeText);
    opId = (JSON.parse(madeText) as { login: { id: string } }).login.id;
    const project = async (call: Call, owner: string, street: string): Promise<string> => {
      const c = await call("/api/clients", json("POST", { companyName: `${owner} Installers` }));
      const cText = await c.text();
      assert.equal(c.status, 201, cText.slice(0, 300));
      const p = await call("/api/projects", json("POST", { owner, street, city: "Salem", state: "OR", zip: "97301", ahj: "City of Salem", utility: "PGE", dcKw: "7.5", clientId: JSON.parse(cText).id }));
      const pText = await p.text();
      assert.equal(p.status, 201, pText.slice(0, 300));
      return (JSON.parse(pText) as { project: { id: string } }).project.id;
    };
    projOwn = await project(owner, "Own Owner", "1 Own Way");
    const org = await owner("/api/orgs", json("POST", { name: "Other Solar", edition: "full", products: ["autopilot"] }));
    const orgText = await org.text();
    assert.equal(org.status, 201, orgText.slice(0, 300));
    const orgId = (JSON.parse(orgText) as { org: { id: string } }).org.id;
    const u = await owner(`/api/orgs/${orgId}/users`, json("POST", { name: "Other Staff", email: "staff@other.test", password: "other-pass-12345" }));
    assert.equal(u.status, 201, (await u.text()).slice(0, 300));
    projOther = await project(await loginAs("staff@other.test", "other-pass-12345"), "Other Owner", "2 Other Rd");
    assert.ok(opId && projOwn && projOther);
  });
  const operator = await loginAs(OP.email, OP.password);

  // --- minting ----------------------------------------------------------------
  const mint = async (call: Call, body: Record<string, unknown> = {}): Promise<{ status: number; token: string; id: string; expiresAt: string; text: string }> => {
    const res = await call("/api/auth/recorder-tokens", json("POST", body));
    const text = await res.text();
    const parsed = res.status === 201 ? JSON.parse(text) as { token: string; recorderToken: { id: string; expiresAt: string } } : null;
    if (parsed?.token) TOKENS.add(parsed.token);
    return { status: res.status, token: parsed?.token ?? "", id: parsed?.recorderToken.id ?? "", expiresAt: parsed?.recorderToken.expiresAt ?? "", text };
  };

  await run("no session: minting and listing are 401", async () => {
    assert.equal((await anon("/api/auth/recorder-tokens", json("POST", {}))).status, 401);
    assert.equal((await anon("/api/auth/recorder-tokens")).status, 401);
  });
  await run("days outside 1..90 are refused (400) and nothing is stored", async () => {
    for (const days of [0, 91, 2.5, "lots"]) {
      const r = await mint(operator, { days });
      assert.equal(r.status, 400, `days=${String(days)}: ${r.text}`);
    }
    assert.equal(Number((await readDb(DB_PATH, (db) => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM recorder_tokens WHERE user_id = ?", [opId])))?.n), 0);
  });

  let opToken = "";
  let opTokenId = "";
  await run("a signed-in operator mints a token: shown once, 30 days by default, stored as sha256, audited", async () => {
    const r = await mint(operator, { name: "laptop" });
    assert.equal(r.status, 201, r.text);
    assert.match(r.token, /^rt_[A-Za-z0-9_-]{40,}$/);
    opToken = r.token;
    opTokenId = r.id;
    const days = (Date.parse(r.expiresAt) - Date.now()) / 86_400_000;
    assert.ok(days > 29.9 && days <= 30.01, `expiry ${r.expiresAt} is ${days} days out`);
    const row = await readDb(DB_PATH, (db) => db.get<{ token_hash: string; user_id: string }>("SELECT token_hash, user_id FROM recorder_tokens WHERE id = ?", [opTokenId]));
    assert.equal(row?.user_id, opId);
    assert.equal(row?.token_hash, sha256(opToken));
    const audit = (await auditRows("recorder_token.created")).at(-1);
    assert.equal(audit?.actor_name, OP.email);
    assert.equal((JSON.parse(String(audit?.details)) as { tokenId: string }).tokenId, opTokenId);
  });
  await run("the list shows the caller's own tokens without the token or its hash", async () => {
    const res = await operator("/api/auth/recorder-tokens");
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const list = (JSON.parse(text) as { tokens: Array<{ id: string; live: boolean }> }).tokens;
    assert.deepEqual(list.map((t) => t.id), [opTokenId]);
    assert.equal(list[0].live, true);
    assert.ok(!text.includes(opToken) && !text.includes(sha256(opToken)) && !/token_hash/.test(text), "the list leaked token material");
    const ownerList = await (await owner("/api/auth/recorder-tokens")).json() as { tokens: unknown[] };
    assert.deepEqual(ownerList.tokens, [], "the admin sees another person's token");
  });

  // --- what the token reaches ---------------------------------------------------
  const opRec = withRecorderToken(BASE, opToken);
  let recipeId = "";
  await run("the token starts a recording AS its person: audited with the operator's email, created_by is them", async () => {
    const res = await opRec("/api/portal-recipes/record", json("POST", { scopeType: "ahj", ahj: "City of Salem", state: "OR", createdBy: "Somebody Else" }));
    const text = await res.text();
    assert.equal(res.status, 201, text);
    recipeId = (JSON.parse(text) as { id: string }).id;
    const audit = (await auditRows("portal_recipe.recording_started")).at(-1);
    assert.equal(audit?.actor_name, OP.email);
    const details = JSON.parse(String(audit?.details)) as { recipeId: string; via: string };
    assert.equal(details.recipeId, recipeId);
    assert.equal(details.via, "recorder_token");
    const row = await readDb(DB_PATH, (db) => db.get<{ created_by: string }>("SELECT created_by FROM portal_recipes WHERE id = ?", [recipeId]));
    assert.equal(row?.created_by, OP.name, "a body createdBy outranked the signed-in person");
  });
  await run("the token reads its own org's recording field values, and another org's project is 404", async () => {
    const own = await opRec(`/api/projects/${projOwn}/staging-field-values`);
    const ownText = await own.text();
    assert.equal(own.status, 200, ownText.slice(0, 300));
    assert.ok("fieldValues" in (JSON.parse(ownText) as object));
    const other = await opRec(`/api/projects/${projOther}/staging-field-values`);
    assert.equal(other.status, 404, (await other.text()).slice(0, 300));
  });
  await run("the token asks for binding suggestions; another org's project in the body is 404", async () => {
    const steps = [{ action: "click", selector: { role: "button", name: "Next" } }];
    const ok = await opRec(`/api/portal-recipes/${recipeId}/suggest-bindings`, json("POST", { steps, projectId: projOwn }));
    assert.equal(ok.status, 200, (await ok.text()).slice(0, 300));
    const other = await opRec(`/api/portal-recipes/${recipeId}/suggest-bindings`, json("POST", { steps, projectId: projOther }));
    assert.equal(other.status, 404, (await other.text()).slice(0, 300));
  });
  await run("the token saves the captured steps, audited with the operator's email; last_used_at is stamped", async () => {
    const steps = [
      { action: "goto", url: "https://example.test/portal" },
      { action: "fill", selector: { label: "Job address" }, field: "projectAddress" },
      { action: "stopForReview" },
    ];
    const res = await opRec(`/api/portal-recipes/${recipeId}/steps`, json("PUT", { steps, status: "recording" }));
    assert.equal(res.status, 200, (await res.text()).slice(0, 300));
    const audit = (await auditRows("portal_recipe.steps_saved")).at(-1);
    assert.equal(audit?.actor_name, OP.email);
    assert.equal((JSON.parse(String(audit?.details)) as { via: string; recipeId: string }).via, "recorder_token");
    const used = await readDb(DB_PATH, (db) => db.get<{ last_used_at: string }>("SELECT last_used_at FROM recorder_tokens WHERE id = ?", [opTokenId]));
    assert.ok(Date.parse(String(used?.last_used_at)) > Date.now() - 60_000, `last_used_at=${used?.last_used_at}`);
  });

  // --- what it never reaches: an ADMIN's token, the most a token could carry -----
  const ownerMint = await mint(owner, { name: "owner desk" });
  const ownerRec = withRecorderToken(BASE, ownerMint.token);
  await run("the admin's token works on a recorder route (so the 401s below are the route rule, not a dud token)", async () => {
    assert.equal(ownerMint.status, 201, ownerMint.text);
    const res = await ownerRec(`/api/projects/${projOwn}/staging-field-values`);
    assert.equal(res.status, 200, (await res.text()).slice(0, 300));
  });
  await run("a token 401s on staging, approval, admin, minting and every other route; nothing changes", async () => {
    const auditBefore = Number((await readDb(DB_PATH, (db) => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE project_id = ?", [projOwn])))?.n);
    const runsBefore = Number((await readDb(DB_PATH, (db) => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM portal_runs")))?.n);
    const denied: Array<[string, string, unknown?]> = [
      // staging + approval (hard rule 1)
      ["POST", `/api/projects/${projOwn}/autopilot/start`, {}],
      ["POST", `/api/projects/${projOwn}/autopilot/approve`, { approvedBy: "Rec Order" }],
      ["POST", `/api/projects/${projOwn}/prepare-submission`, {}],
      ["POST", `/api/projects/${projOwn}/submittal-tracks/nem/mark-submitted`, {}],
      ["POST", `/api/projects/${projOwn}/payment/waive`, { reason: "x" }],
      ["POST", `/api/projects/${projOwn}/launch-record`, {}],
      ["POST", `/api/projects/${projOwn}/auto-learn`, {}],
      // admin
      ["GET", "/api/staff/logins"],
      ["POST", "/api/staff/logins", { name: "X", email: "x@team.test", role: "admin", password: "xxxxxxxxxxxx" }],
      ["POST", "/api/orgs", { name: "Sneaky", edition: "full", products: ["autopilot"] }],
      // a token never mints, lists or revokes tokens
      ["POST", "/api/auth/recorder-tokens", {}],
      ["GET", "/api/auth/recorder-tokens"],
      ["DELETE", `/api/auth/recorder-tokens/${ownerMint.id}`],
      // reads and the other recipe routes
      ["GET", `/api/projects/${projOwn}`],
      ["GET", "/api/projects"],
      ["GET", "/api/portal-recipes"],
      ["GET", `/api/portal-recipes/${recipeId}`],
      ["POST", `/api/portal-recipes/${recipeId}/finish`, {}],
      ["POST", `/api/portal-recipes/${recipeId}/rerecord`, {}],
      ["PUT", `/api/portal-recipes/${recipeId}/auto-submit`, { enabled: false }],
      ["DELETE", `/api/portal-recipes/${recipeId}`],
      // a recorder route under the wrong method, and variant spellings Express would still route
      ["GET", "/api/portal-recipes/record"],
      ["POST", `/api/projects/${projOwn}/staging-field-values`, {}],
      ["POST", "/api/portal-recipes/record/", { scopeType: "ahj", ahj: "City of Salem", state: "OR" }],
      ["POST", "/API/portal-recipes/record", { scopeType: "ahj", ahj: "City of Salem", state: "OR" }],
      ["PUT", `/api/portal-recipes/${recipeId}/steps/`, { steps: [] }],
    ];
    const versionBefore = Number((await readDb(DB_PATH, (db) => db.get<{ version: number }>("SELECT version FROM portal_recipes WHERE id = ?", [recipeId])))?.version);
    for (const [method, p, body] of denied) {
      const init: RequestInit = body === undefined ? { method } : json(method, body);
      const res = await ownerRec(p, { ...init, redirect: "manual" });
      const text = await res.text();
      // An upper-case /API/ path is not an /api/ path to the sign-in gate, so it answers the way it
      // answers every page: a redirect to /login. Refused either way; never the handler.
      const refused = res.status === 401 || (res.status === 302 && res.headers.get("location") === "/login");
      assert.ok(refused, `${method} ${p}: ${res.status} ${text.slice(0, 200)}`);
    }
    const versionAfter = Number((await readDb(DB_PATH, (db) => db.get<{ version: number }>("SELECT version FROM portal_recipes WHERE id = ?", [recipeId])))?.version);
    assert.equal(versionAfter, versionBefore, "a denied variant spelling of the record route reset the recipe");
    const auditAfter = Number((await readDb(DB_PATH, (db) => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE project_id = ?", [projOwn])))?.n);
    const runsAfter = Number((await readDb(DB_PATH, (db) => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM portal_runs")))?.n);
    assert.equal(auditAfter, auditBefore, "a denied request wrote to the project's audit trail");
    assert.equal(runsAfter, runsBefore, "a denied request started a portal run");
    const recipe = await readDb(DB_PATH, (db) => db.get<{ status: string }>("SELECT status FROM portal_recipes WHERE id = ?", [recipeId]));
    assert.equal(recipe?.status, "recording", "a denied request changed the recipe");
    assert.ok(!(await readDb(DB_PATH, (db) => db.get("SELECT 1 FROM users WHERE email = 'x@team.test'"))), "a token created a login");
    assert.ok(!(await readDb(DB_PATH, (db) => db.get("SELECT 1 FROM orgs WHERE name = 'Sneaky'"))), "a token created an org");
    const ownerTokens = await readDb(DB_PATH, (db) => db.query<{ revoked_at: string }>("SELECT revoked_at FROM recorder_tokens WHERE user_id = (SELECT id FROM users WHERE email = ?)", [OWNER.email]));
    assert.deepEqual(ownerTokens.map((t) => t.revoked_at), [""], "a token minted or revoked a token");
  });
  await run("a token beside a valid session cookie still cannot reach past the recorder routes as anything more", async () => {
    // The cookie is the operator's; the request still answers as the cookie's person, never escalated by the admin token.
    const opCookie = (await tryLogin(OP.email, OP.password)).cookie;
    const res = await fetch(`${BASE}/api/staff/logins`, { headers: { cookie: opCookie, "x-recorder-token": ownerMint.token } });
    assert.equal(res.status, 403, `${res.status} ${(await res.text()).slice(0, 200)}`);
  });

  // --- lifecycle ------------------------------------------------------------------
  await run("an expired token and a revoked token are 401 on a recorder route", async () => {
    for (const t of [EXPIRED, REVOKED]) {
      const res = await withRecorderToken(BASE, t)(`/api/projects/${projOwn}/staging-field-values`);
      assert.equal(res.status, 401, `${t}: ${res.status}`);
    }
    const unknown = await withRecorderToken(BASE, "rt_not-a-token")(`/api/projects/${projOwn}/staging-field-values`);
    assert.equal(unknown.status, 401);
  });
  await run("another person's token id is 404 on revoke, and the token keeps working", async () => {
    const res = await operator(`/api/auth/recorder-tokens/${ownerMint.id}`, { method: "DELETE" });
    assert.equal(res.status, 404, (await res.text()).slice(0, 200));
    assert.equal((await ownerRec(`/api/projects/${projOwn}/staging-field-values`)).status, 200);
  });
  await run("revoking stops the token on its next request, audited", async () => {
    const res = await operator(`/api/auth/recorder-tokens/${opTokenId}`, { method: "DELETE" });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    assert.ok((JSON.parse(text) as { recorderToken: { revokedAt: string; live: boolean } }).recorderToken.revokedAt);
    const after = await opRec(`/api/projects/${projOwn}/staging-field-values`);
    assert.equal(after.status, 401);
    const audit = (await auditRows("recorder_token.revoked")).at(-1);
    assert.equal(audit?.actor_name, OP.email);
  });
  await run("switching off a login stops its token on the next request", async () => {
    const fresh = await mint(operator, { name: "desk", days: 7 });
    assert.equal(fresh.status, 201, fresh.text);
    const days = (Date.parse(fresh.expiresAt) - Date.now()) / 86_400_000;
    assert.ok(days > 6.9 && days <= 7.01, `days=7 gave ${days}`);
    const rec = withRecorderToken(BASE, fresh.token);
    assert.equal((await rec(`/api/projects/${projOwn}/staging-field-values`)).status, 200);
    const off = await owner(`/api/staff/logins/${opId}/active`, json("POST", { active: false }));
    assert.equal(off.status, 200, (await off.text()).slice(0, 200));
    assert.equal((await rec(`/api/projects/${projOwn}/staging-field-values`)).status, 401);
  });

  await run("no token reaches the audit log, a recipe row or the server log", async () => {
    assert.ok(TOKENS.size >= 3);
    const audit = await readDb(DB_PATH, (db) => db.query<{ details: string; actor_name: string }>("SELECT details, actor_name FROM audit_logs"));
    const recipes = await readDb(DB_PATH, (db) => db.query<Record<string, unknown>>("SELECT * FROM portal_recipes"));
    const haystack = JSON.stringify(audit) + JSON.stringify(recipes) + one.log();
    for (const t of TOKENS) assert.ok(!haystack.includes(t), "a recorder token was written somewhere");
  });
} finally {
  one.server.kill();
}

// ---------------------------------------------------------------------------
// Part 2: sign-in off. The recorder works as today; there is nothing to mint.
// ---------------------------------------------------------------------------
const PORT2 = freePortInBand(5885, 5);
const BASE2 = `http://127.0.0.1:${PORT2}`;
const DB2 = path.join(tmpDir, "auth-off.sqlite");
const two = boot(PORT2, DB2, false);
try {
  await waitForServer(BASE2, two.log);
  const anyone = withCookie(BASE2);
  await run("sign-in off: the recorder starts and saves a recording with no token, as today", async () => {
    const start = await anyone("/api/portal-recipes/record", json("POST", { scopeType: "utility", utility: "PGE", state: "OR" }));
    const text = await start.text();
    assert.equal(start.status, 201, text.slice(0, 300));
    const id = (JSON.parse(text) as { id: string }).id;
    const save = await anyone(`/api/portal-recipes/${id}/steps`, json("PUT", { steps: [{ action: "stopForReview" }], status: "recording" }));
    assert.equal(save.status, 200, (await save.text()).slice(0, 300));
  });
  await run("sign-in off: listing says authEnabled false; minting is 409 auth_disabled", async () => {
    const list = await (await anyone("/api/auth/recorder-tokens")).json() as { authEnabled: boolean; tokens: unknown[] };
    assert.equal(list.authEnabled, false);
    assert.deepEqual(list.tokens, []);
    const res = await anyone("/api/auth/recorder-tokens", json("POST", {}));
    const body = await res.json() as { details: { code?: string } };
    assert.equal(res.status, 409);
    assert.equal(body.details.code, "auth_disabled");
    assert.equal(Number((await readDb(DB2, (db) => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM recorder_tokens")))?.n), 0);
  });
} finally {
  two.server.kill();
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0 ? "\nrecorderTokens: all checks passed" : `\nrecorderTokens: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
