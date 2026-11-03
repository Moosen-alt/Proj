// THE PROJECT'S PERMIT-PROCESS LOOKUP OVER HTTP (#560): GET / PUT verify / POST refresh under
// /api/projects/:id, on a real server process over a temp database (auth off, no model key, no network).
//
//   - GET returns the row for the project's own AHJ; an unknown project is a 404.
//   - PUT .../verify needs a NAMED person (auth off: the name sent; blank is a 400 that writes nothing);
//     a named verify lands 'verified' with verified_by, and a replacement's list is what the row says.
//   - POST .../refresh is a 409 for a verified row (research never overwrites it — rule 3) and a 503
//     where no model key is set (the job could only fail); it never writes the row.
// Tenancy: these sit under /api/projects/:id, so the scope guard covers them (routeScope.test).
//
//   npx tsx backend/test/permitProcessRoute.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "permit-process-route-"));
const dbPath = path.join(tmpDir, "t.sqlite");

let failures = 0;
const run = async (label: string, fn: () => Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const AHJ = "City of Route Hollow";
const DEAD = "https://www.routehollow-ut.gov/DocumentCenter/View/152";
const LIVE = "https://www.routehollow-ut.gov/220/Obtaining-a-Building-Permit";

/** A project in the AHJ, and a stale SEEDED lookup row for it, through the real write paths. */
async function fixture(): Promise<{ projectId: string; otherId: string }> {
  process.env.AUTOPILOT_DB_PATH = dbPath;
  process.env.SEED_TEST_INSTALLER = "false";
  process.env.AUTOPILOT_AUTO_START = "0";
  process.env.PERMIT_PROCESS_LOOKUP = "off";
  process.env.ANTHROPIC_API_KEY = "";
  process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
  process.env.BACKUP_DIR = path.join(tmpDir, "backups");
  const { openDatabase } = await import("../src/db");
  const { createClient } = await import("../src/clients");
  const { createProject } = await import("../src/repository");
  const pp = await import("../src/permitProcess");
  const db = await openDatabase();
  try {
    const client = createClient(db, { companyName: "Route Test Solar", ccbLicenseNumber: "560561" });
    const mk = (ahj: string) => createProject(db, { clientId: client.id, owner: "Synthetic Owner", street: "1 Test Way", city: "Route Hollow", state: "UT", zip: "99999", ahj, utility: "Synthetic Power" } as never).project.id;
    const projectId = mk(AHJ);
    const otherId = mk("City of Route Bench");
    for (const ahj of [AHJ, "City of Route Bench"]) {
      pp.savePermitProcessLookup(db, {
        state: "UT", ahj, lookedUpAt: "2026-10-06T15:00:00.000Z", model: "test-model",
        issuingAgency: { value: ahj, sourceUrl: LIVE, quote: `${ahj} issues building permits`, origin: "lookup" },
        permitStructure: { value: "combo", sourceUrl: LIVE, quote: "one combination permit", origin: "lookup" },
        permits: [{ discipline: "combo", label: "Residential solar",
          issuingAgency: { value: ahj, sourceUrl: LIVE, quote: `${ahj} issues building permits`, origin: "lookup" },
          portalUrl: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "none" },
          recordType: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "none" },
          documents: { value: ["2 plan sets", "a disk"], sourceUrl: DEAD, quote: "Submit 2 plan sets and a disk.", origin: "lookup" },
          fee: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "none" } }],
      });
    }
    return { projectId, otherId };
  } finally { db.close(); }
}

function stop(server: ChildProcess): void {
  try { process.kill(-server.pid!, "SIGKILL"); } catch { try { server.kill("SIGKILL"); } catch { /* already gone */ } }
}

async function boot(port: number): Promise<ChildProcess> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    AUTOPILOT_DB_PATH: dbPath,
    BACKUP_DIR: path.join(tmpDir, `backups-${port}`),
    PROJECT_DOCS_DIR: path.join(tmpDir, "docs"),
    AUTOPILOT_AUTO_START: "0",
    PORT: String(port),
    SEED_TEST_INSTALLER: "false",
    MONITOR_INTERVAL_MINUTES: "0",
    LOG_LEVEL: "warn",
    ANTHROPIC_API_KEY: "",
    PERMIT_PROCESS_LOOKUP: "off",
    CODE_RESEARCH: "off",
    SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
    AUTH_ENABLED: "false",
    NO_PROXY: "*",
    no_proxy: "*",
  };
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
  const server = spawn(process.execPath, [path.join(repoRoot, "node_modules/tsx/dist/cli.mjs"), path.join(repoRoot, "backend/src/server.ts")], {
    env: env as NodeJS.ProcessEnv, cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  let log = "";
  server.stdout?.on("data", (d) => { log += String(d); });
  server.stderr?.on("data", (d) => { log += String(d); });
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return server; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  stop(server);
  throw new Error(`server never came up. log tail:\n${log.slice(-2000)}`);
}

const readRow = (ahj: string) => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT confidence, verified_by, verified_at, payload_json FROM permit_process_lookups WHERE ahj = ?").get(ahj) as
      { confidence: string; verified_by: string | null; verified_at: string | null; payload_json: string };
  } finally { db.close(); }
};

const { projectId, otherId } = await fixture();
const PORT = 5780 + Math.floor(Math.random() * 15); // its own band
const BASE = `http://127.0.0.1:${PORT}`;
const server = await boot(PORT);
const json = (method: string, url: string, body?: unknown) => fetch(`${BASE}${url}`, {
  method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
try {
  await run("GET returns the project's own AHJ row; an unknown project is a 404", async () => {
    const res = await json("GET", `/api/projects/${projectId}/permit-process`);
    const text = await res.text();
    assert.equal(res.status, 200, text.slice(0, 300));
    const body = JSON.parse(text);
    assert.equal(body.ahj, AHJ);
    assert.equal(body.lookup.confidence, "seeded");
    assert.deepEqual(body.lookup.permits[0].documents.value, ["2 plan sets", "a disk"]);
    const missing = await json("GET", "/api/projects/no-such-project/permit-process");
    assert.equal(missing.status, 404, await missing.text());
  });

  await run("PUT verify with no name, or a blank one, is a 400 and the row stays seeded", async () => {
    const none = await json("PUT", `/api/projects/${projectId}/permit-process/verify`, {});
    assert.equal(none.status, 400, await none.text());
    const blank = await json("PUT", `/api/projects/${projectId}/permit-process/verify`, { verifiedBy: "   " });
    assert.equal(blank.status, 400, await blank.text());
    assert.equal(readRow(AHJ).confidence, "seeded");
    assert.equal(readRow(AHJ).verified_by, null);
  });

  await run("PUT verify: a fact without its http(s) page is a 400 that writes nothing", async () => {
    const res = await json("PUT", `/api/projects/${projectId}/permit-process/verify`, { verifiedBy: "Pat Synthetic", permits: [{ discipline: "combo", documents: { value: ["Plans"], sourceUrl: "the city told me" } }] });
    assert.equal(res.status, 400, await res.text());
    assert.equal(readRow(AHJ).confidence, "seeded");
  });

  await run("PUT verify by a named person replacing the list: 200, verified_by stamped, the stated list is the row's", async () => {
    const res = await json("PUT", `/api/projects/${projectId}/permit-process/verify`, {
      verifiedBy: "  Pat Synthetic  ",
      permits: [{ discipline: "combo", documents: { value: ["Plans and specifications"], sourceUrl: LIVE, quote: "Plans and specification are required with all applications." } }],
    });
    const text = await res.text();
    assert.equal(res.status, 200, text.slice(0, 300));
    const row = readRow(AHJ);
    assert.equal(row.confidence, "verified");
    assert.equal(row.verified_by, "Pat Synthetic");
    assert.ok(row.verified_at);
    const payload = JSON.parse(row.payload_json);
    assert.deepEqual(payload.permits[0].documents.value, ["Plans and specifications"]);
    assert.equal(payload.permits[0].documents.sourceUrl, LIVE);
  });

  await run("POST refresh on the verified row is a 409 (research never overwrites it) and writes nothing", async () => {
    const before = readRow(AHJ).payload_json;
    const res = await json("POST", `/api/projects/${projectId}/permit-process/refresh`, {});
    const text = await res.text();
    assert.equal(res.status, 409, text);
    assert.match(text, /never overwrites/);
    assert.equal(readRow(AHJ).payload_json, before);
  });

  await run("POST refresh where no model key is set is a 503 (said, not queued)", async () => {
    const res = await json("POST", `/api/projects/${otherId}/permit-process/refresh`, {});
    assert.equal(res.status, 503, await res.text());
    assert.equal(readRow("City of Route Bench").confidence, "seeded");
  });
} finally {
  stop(server);
}

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\npermitProcessRoute: all checks passed");
process.exit(0);
