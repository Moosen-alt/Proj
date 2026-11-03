// #425 — A CLIENT'S ONLY LOGIN IS NEVER TRIED ON A PORTAL NOTHING SAYS IT BELONGS TO.
//
// getDecryptedCredentialAny falls back to the client's single stored credential. It already
// refused a single login stored for a DIFFERENT host when both URLs parsed, but anything it
// could not read fell through to "use it anyway": an empty target (a utility with no portal on
// file), an unparseable target, or a login stored with no address at all. A client whose one
// login is their city's permit portal could then have it typed into a utility's PowerClerk —
// an attempt burned on the wrong site that reads as "credentials rejected".
//
//   MUST-EXCLUDE: empty target, unparseable target, and a no-address login on a named target.
//   MUST-PASS:    the only login on its own host (and a known alias host); a caller that names
//                 no target at all keeps the single-credential behaviour.
//
//   npx tsx backend/test/singleCredentialFailClosed.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "single-credential-fail-closed-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret";
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createPortalCredential, getDecryptedCredentialAny, getDecryptedCredentialForPortal } = await import("../src/portalCredentials");
const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const CITY = "https://cityworks.example-city-ut.gov/publicaccess/login";
const POWERCLERK = "https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login";

const city = createClient(db, { companyName: "Only A City Login Solar", ccbLicenseNumber: "425001" });
createPortalCredential(db, city.id, { portalType: "AHJ", portalUrl: CITY, username: "city-user", password: "city-pw" });

check("MUST-EXCLUDE (guard, held before too): the city login is not used for PowerClerk", () => {
  assert.equal(getDecryptedCredentialAny(db, city.id, POWERCLERK), null);
});
check("MUST-EXCLUDE: an EMPTY target (a utility with no portal on file) gets no login", () => {
  assert.equal(getDecryptedCredentialAny(db, city.id, ""), null);
});
check("MUST-EXCLUDE: an unparseable target gets no login", () => {
  assert.equal(getDecryptedCredentialAny(db, city.id, "pacificorp net metering portal"), null);
});
check("MUST-EXCLUDE: through the public lookup the learn uses, an empty utility target gets nothing", () => {
  assert.equal(getDecryptedCredentialForPortal(db, city.id, "utility", ""), null);
});

const noAddr = createClient(db, { companyName: "No Address Login Solar", ccbLicenseNumber: "425002" });
createPortalCredential(db, noAddr.id, { portalType: "AHJ", portalUrl: "", username: "noaddr-user", password: "noaddr-pw" });
check("MUST-EXCLUDE: a login stored with NO address is not typed into a named portal", () => {
  assert.equal(getDecryptedCredentialAny(db, noAddr.id, POWERCLERK), null);
  assert.equal(getDecryptedCredentialForPortal(db, noAddr.id, "utility", POWERCLERK), null);
});

check("MUST-PASS: the only login still works on its own host", () => {
  assert.equal(getDecryptedCredentialAny(db, city.id, "https://cityworks.example-city-ut.gov/publicaccess/case/create")?.username, "city-user");
});
const alias = createClient(db, { companyName: "Alias Host Solar", ccbLicenseNumber: "425003" });
createPortalCredential(db, alias.id, { portalType: "utility", portalUrl: "https://www.pacificpower.net/", username: "pp-user", password: "pp-pw" });
check("MUST-PASS: a known alias host still matches (pacificpower.net → PacifiCorp's PowerClerk)", () => {
  assert.equal(getDecryptedCredentialAny(db, alias.id, POWERCLERK)?.username, "pp-user");
});
check("MUST-PASS: a caller that names no target keeps the single-credential behaviour", () => {
  assert.equal(getDecryptedCredentialAny(db, city.id)?.username, "city-user");
});

try { (db as { close?: () => void }).close?.(); } catch { /* best effort */ }
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows may hold the file */ }
if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log("\nAll single-credential fail-closed checks passed.");
