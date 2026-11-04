// THE CLIENT-EMAIL SWITCH IS ONE ANSWER, WITH A TEST-CLIENT EXCEPTION (owner, 2026-11-03).
//
// CLIENT_NOTIFICATIONS=off silences every client email. Four modules used to read the variable
// with their own copy of the regex. CLIENT_NOTIFICATIONS_ALLOW_CLIENTS now lets named clients (a
// test client) through while it is off, so email can be tested end to end while the real clients
// stay silent. And the intake reply never shows a client a raw field key ("roofMaterial").
//
//   npx tsx backend/test/clientEmailSwitch.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "client-email-switch-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { clientEmailsOffFor, clientUpdatesSilenced } = await import("../src/clientNotifier");
const { clientRequestAutoSendEnabled } = await import("../src/clientRequestLinks");
const { intakeFieldLabel, PARSER_PROJECT_FIELDS } = await import("../src/emailIntake");
const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const withEnv = (vars: Record<string, string | undefined>, fn: () => void): void => {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { fn(); } finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

const real = createClient(db, { companyName: "Real Client Solar", ccbLicenseNumber: "900001" });
const test = createClient(db, { companyName: "Email Test Client", ccbLicenseNumber: "900002" });
// clientUpdatesSilenced reads the project row only for archived_at; an id with no row is a live,
// unarchived project, so the switch alone decides.
const project = (clientId: string) => ({ id: `no-such-project-${clientId}`, clientId });
const realProject = project(real.id);
const testProject = project(test.id);

console.log("1. THE SWITCH");
check("unset: every client may be emailed", () => withEnv({ CLIENT_NOTIFICATIONS: undefined, CLIENT_NOTIFICATIONS_ALLOW_CLIENTS: undefined }, () => {
  assert.equal(clientEmailsOffFor(real.id), false);
  assert.equal(clientUpdatesSilenced(db, realProject), false);
}));
for (const v of ["off", "OFF", "0", "false"]) {
  check(`CLIENT_NOTIFICATIONS=${v} with no exception: every client is silenced`, () => withEnv({ CLIENT_NOTIFICATIONS: v, CLIENT_NOTIFICATIONS_ALLOW_CLIENTS: undefined }, () => {
    assert.equal(clientEmailsOffFor(real.id), true);
    assert.equal(clientEmailsOffFor(test.id), true);
    assert.equal(clientUpdatesSilenced(db, realProject), true);
    assert.equal(clientRequestAutoSendEnabled(test.id), false);
  }));
}

console.log("2. THE TEST-CLIENT EXCEPTION");
check("off + the test client allowed: the test client is mailed, the real client stays silent", () => withEnv({ CLIENT_NOTIFICATIONS: "off", CLIENT_NOTIFICATIONS_ALLOW_CLIENTS: `  ${test.id} ` }, () => {
  assert.equal(clientEmailsOffFor(test.id), false);
  assert.equal(clientEmailsOffFor(real.id), true);
  assert.equal(clientUpdatesSilenced(db, testProject), false);
  assert.equal(clientUpdatesSilenced(db, realProject), true);
  assert.equal(clientRequestAutoSendEnabled(test.id), true);
  assert.equal(clientRequestAutoSendEnabled(real.id), false);
}));
check("a list of several ids, any separator", () => withEnv({ CLIENT_NOTIFICATIONS: "off", CLIENT_NOTIFICATIONS_ALLOW_CLIENTS: `other-id;${test.id}, third` }, () => {
  assert.equal(clientEmailsOffFor(test.id), false);
  assert.equal(clientEmailsOffFor(real.id), true);
}));
check("no client named: off, never widened to an unknown recipient", () => withEnv({ CLIENT_NOTIFICATIONS: "off", CLIENT_NOTIFICATIONS_ALLOW_CLIENTS: test.id }, () => {
  assert.equal(clientEmailsOffFor(null), true);
  assert.equal(clientEmailsOffFor(""), true);
  assert.equal(clientRequestAutoSendEnabled(), false);
}));
check("the exception never turns emails on when the switch is on (it only narrows an off)", () => withEnv({ CLIENT_NOTIFICATIONS: undefined, CLIENT_NOTIFICATIONS_ALLOW_CLIENTS: test.id }, () => {
  assert.equal(clientEmailsOffFor(real.id), false);
}));
check("CLIENT_REQUEST_AUTO_SEND=off still stops request links for the allowed test client", () => withEnv({ CLIENT_NOTIFICATIONS: "off", CLIENT_NOTIFICATIONS_ALLOW_CLIENTS: test.id, CLIENT_REQUEST_AUTO_SEND: "off" }, () => {
  assert.equal(clientRequestAutoSendEnabled(test.id), false);
}));

console.log("3. ONE PREDICATE");
check("no module but clientNotifier.ts reads CLIENT_NOTIFICATIONS itself", () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "src");
  const readers = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))
    .filter((f) => /process\.env\.CLIENT_NOTIFICATIONS\b/.test(fs.readFileSync(path.join(dir, f), "utf8")));
  assert.deepEqual(readers, ["clientNotifier.ts"]);
});

console.log("4. FIELD NAMES IN THE INTAKE REPLY");
check("roofMaterial reads 'Roof material'", () => assert.equal(intakeFieldLabel("roofMaterial"), "Roof material"));
check("every parser field has a words label, never raw camelCase", () => {
  // An identifier-shaped word (two or more lower-case letters then a capital: "roofMaterial"); a
  // unit such as "kW" is not one.
  const raw = [...PARSER_PROJECT_FIELDS].filter((k) => /\b[a-z]{2,}[A-Z]/.test(intakeFieldLabel(k)) || intakeFieldLabel(k) === k);
  assert.deepEqual(raw, []);
});

try { (db as { close?: () => void }).close?.(); } catch { /* best effort */ }
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows may hold the file */ }
if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log("\nAll client-email switch checks passed.");
