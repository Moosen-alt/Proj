// THE CLOUDFLARE ACCESS BYPASS LIST CANNOT DRIFT FROM THE APP'S OWN SIGN-IN GATE (#437).
//
// backend/src/accessBypass.ts lists the paths Cloudflare Access lets through without a Google
// sign-in. The app's requireAuth (auth.ts) is the gate behind it. This drives the REAL requireAuth
// (AUTH_ENABLED=true, no cookie, no API key) over every route path server.ts registers and every
// file the dashboard serves, and checks both directions:
//
//   MUST-EXCLUDE (hard rule 6)  everything a bypass entry MIGHT cover (case folded, plain paths as
//                bare prefixes, `*` spanning slashes) is already open in the app. A bypass that
//                reaches a gated /api/* route, or a gated page, fails here.
//   MUST-PASS    everything the app serves without a login is either SURELY bypassed (a customer
//                link works through Access) or named in OPEN_IN_APP_BEHIND_ACCESS (staff-only, kept
//                behind Access on purpose). A new public path added to requireAuth fails here until
//                it is classified.
//   DOC          docs/OPERATIONS_LINUX.md carries exactly renderAccessBypassTable().
//
// Run: npx tsx backend/test/accessBypass.test.ts
import { REPO, ISOLATED_CWD } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";

process.env.AUTOPILOT_DB_PATH = path.join(ISOLATED_CWD, "access-bypass.sqlite");
process.env.AUTH_ENABLED = "true"; // read once, at auth.ts import
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.ADMIN_EMAIL;
delete process.env.ADMIN_PASSWORD;

const { openDatabase } = await import("../src/db");
const { requireAuth, AUTH_ENABLED } = await import("../src/auth");
const {
  ACCESS_BYPASS_PATHS, OPEN_IN_APP_BEHIND_ACCESS, accessPathMayCover, accessPathSurelyCovers, renderAccessBypassTable,
} = await import("../src/accessBypass");

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const db = await openDatabase();
const gate = requireAuth(db);

/** "open" when requireAuth lets an anonymous request through, else what it answered. */
function probe(urlPath: string): "open" | string {
  let outcome = "no answer";
  const req = { path: urlPath, headers: {}, ip: "203.0.113.9", socket: {} } as unknown as Request;
  const res = {
    status(code: number) { outcome = `status ${code}`; return this; },
    json() { return this; },
    redirect(to: string) { outcome = `redirect ${to}`; return this; },
  } as unknown as Response;
  gate(req, res, (() => { outcome = "open"; }) as NextFunction);
  return outcome;
}

// Every path the server can answer: the literal route paths in server.ts (":param" → a token-like
// segment) and every file express.static serves out of frontend/.
const serverSrc = fs.readFileSync(path.join(REPO, "backend", "src", "server.ts"), "utf8");
const routePaths = new Set<string>();
for (const m of serverSrc.matchAll(/\bapp\.(?:get|post|put|patch|delete|all|use)\(\s*["'`](\/[^"'`]*)["'`]/g)) {
  routePaths.add(m[1].replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "tok-123"));
}
const staticPaths = new Set<string>();
const walk = (dir: string, rel: string): void => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = `${rel}/${ent.name}`;
    if (ent.isDirectory()) walk(path.join(dir, ent.name), r);
    else staticPaths.add(r);
  }
};
walk(path.join(REPO, "frontend"), "");
// Concrete children of each bypass entry, so a wildcard entry with no literal route still gets probed.
const entrySamples = ACCESS_BYPASS_PATHS.map((e) => e.path.replace(/\*/g, "tok-123"));
const everyPath = [...new Set([...routePaths, ...staticPaths, ...entrySamples])].sort();

console.log("access bypass: the probe itself is sound");
check("auth is ON for this process (the gate is not a no-op)", () => assert.equal(AUTH_ENABLED, true));
check("the route scan found the server's routes (a broken regex would make every check vacuous)", () => {
  assert.ok(routePaths.size > 100, `only ${routePaths.size} route paths found`);
  assert.ok(routePaths.has("/api/public/status/tok-123") && routePaths.has("/api/projects"), "expected routes missing");
});
check("a gated API route answers 401 and a gated page redirects to /login", () => {
  assert.equal(probe("/api/projects"), "status 401");
  assert.equal(probe("/dashboard"), "redirect /login");
});

// The one excuse, checked rather than assumed: `/status.html` is gated by requireAuth, but it is
// the very file the public `/status` route sends (registered BEFORE the gate). If Access reads
// `/status` as a bare prefix and lets `/status.html` through, the stranger gets a page that is
// public anyway. Allowed only when server.ts shows exactly that, above `app.use(requireAuth`.
const gateAt = serverSrc.indexOf("app.use(requireAuth(db))");
function sameFileAsPublicPage(entryPath: string, p: string): boolean {
  if (p !== `${entryPath}.html` || entryPath.includes("*")) return false;
  const name = entryPath.slice(1);
  const route = serverSrc.indexOf(`app.get("${entryPath}", (_req, res) => res.sendFile(path.join(frontendDir, "${name}.html")));`);
  return route >= 0 && gateAt > 0 && route < gateAt;
}

console.log("access bypass: MUST-EXCLUDE - a bypass never covers anything the app gates (rule 6)");
check("the requireAuth mount is where this test looks for it", () => assert.ok(gateAt > 0));
for (const entry of ACCESS_BYPASS_PATHS) {
  const covered = everyPath.filter((p) => accessPathMayCover(entry.path, p));
  check(`${entry.path} covers only paths the app already serves without a login (${covered.length} probed)`, () => {
    assert.ok(covered.length > 0, "covers nothing the server serves - a stale entry");
    const gated = covered.filter((p) => probe(p) !== "open" && !sameFileAsPublicPage(entry.path, p)).map((p) => `${p} (${probe(p)})`);
    assert.deepEqual(gated, []);
  });
}
check("MUST-EXCLUDE: the .html excuse does not stretch to a gated page", () => {
  assert.equal(sameFileAsPublicPage("/review", "/review.html"), false); // /review is registered AFTER the gate
  assert.equal(sameFileAsPublicPage("/status", "/status.js"), false);
});
check("no bypass entry is a blanket /api/ or the whole host", () => {
  for (const e of ACCESS_BYPASS_PATHS) {
    assert.ok(!["/", "/*", "/api", "/api/*", "/api/public", "/api/public/*"].includes(e.path), e.path);
  }
});
check("MUST-EXCLUDE: the over-approximation is really wider (case, bare prefix, multi-segment *)", () => {
  assert.ok(accessPathMayCover("/status", "/STATUSX"));
  assert.ok(accessPathMayCover("/vendor/*", "/vendor/a/b.js"));
  assert.ok(accessPathMayCover("/api/public/status/*", "/api/public/status"));
  assert.ok(!accessPathSurelyCovers("/status", "/statusx"));
  assert.ok(!accessPathSurelyCovers("/vendor/*", "/vendor"));
});
check("the staff-only entries really are open in the app (else they belong nowhere)", () => {
  for (const e of OPEN_IN_APP_BEHIND_ACCESS) {
    const sample = e.path.replace(/\*/g, "me");
    assert.equal(probe(sample), "open", sample);
  }
});
check("no path is both bypassed and kept behind Access", () => {
  for (const s of OPEN_IN_APP_BEHIND_ACCESS) {
    for (const b of ACCESS_BYPASS_PATHS) {
      assert.ok(!accessPathMayCover(b.path, s.path.replace(/\*/g, "me")), `${b.path} would bypass staff-only ${s.path}`);
    }
  }
});

console.log("access bypass: MUST-PASS - every path the app leaves open is classified");
check("every anonymously-open route and file is surely bypassed or deliberately behind Access", () => {
  const open = everyPath.filter((p) => probe(p) === "open");
  assert.ok(open.includes("/api/public/status/tok-123") && open.includes("/intake"), "expected open paths missing");
  const unclassified = open.filter((p) =>
    !ACCESS_BYPASS_PATHS.some((e) => accessPathSurelyCovers(e.path, p))
    && !OPEN_IN_APP_BEHIND_ACCESS.some((e) => accessPathSurelyCovers(e.path, p)));
  assert.deepEqual(unclassified, [], "open in the app but neither bypassed nor listed as staff-only");
});
check("each customer link page and its data API is bypassed", () => {
  for (const p of ["/status", "/intake", "/credentials", "/portal", "/api/public/status/t", "/api/intake/t",
    "/api/public/credential-request/t", "/api/public/portal/t", "/api/public/review/t", "/styles.css",
    "/assets/brand/keel-symbol-64.png", "/vendor/manrope-latin.woff2"]) {
    assert.ok(ACCESS_BYPASS_PATHS.some((e) => accessPathSurelyCovers(e.path, p)), p);
  }
});

console.log("access bypass: the runbook carries the generated list");
check("docs/OPERATIONS_LINUX.md has exactly renderAccessBypassTable() between its markers", () => {
  const doc = fs.readFileSync(path.join(REPO, "docs", "OPERATIONS_LINUX.md"), "utf8");
  const m = doc.match(/<!-- access-bypass:begin[^>]*-->\r?\n([\s\S]*?)\r?\n<!-- access-bypass:end -->/);
  assert.ok(m, "markers not found");
  assert.equal(m[1].replace(/\r\n/g, "\n"), renderAccessBypassTable(),
    "run `npx tsx scripts/ops/linux/access-bypass.ts` and paste its output between the markers");
});

db.close();
if (failures) { console.error(`\n${failures} access-bypass check(s) FAILED.`); process.exit(1); }
console.log("\nAll access-bypass checks passed.");
