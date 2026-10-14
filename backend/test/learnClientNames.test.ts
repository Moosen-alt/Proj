// #328 — THE INSTALLER'S OWN NAMES COME FROM ITS CLIENT RECORD, AND ONLY FROM THERE.
//
// Live Portland DevHub (2026-10-14) showed the signed-in company's name in its header; the name
// contains "Solar", and the permit-type chooser read it as a solar permit type. The chooser now
// refuses any candidate that is, or contains, one of the client's own names — company name,
// legal business name, DBA — read here from the client row itself (learnClientNames), not from
// projectFields (which layers plan-set data under the client overlay), and never from the page.
//
//   MUST-PASS:    a client's company, legal and DBA names, whitespace tidied, de-duplicated
//                 case-insensitively (written through createClient / updateClient, the real
//                 write path).
//   MUST-EXCLUDE: a project with no client -> []; another client's names are never returned;
//                 an empty legal name / DBA adds nothing; a DBA cleared on the client is gone.
//
//   npx tsx backend/test/learnClientNames.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-client-names-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret";
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { createClient, updateClient } = await import("../src/clients");
const { learnClientNames } = await import("../src/autoLearn");
const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const full = createClient(db, { companyName: "  Keel   Test Solar ", legalBusinessName: "Keel Test Solar Holdings, LLC", dba: "KEEL TEST SOLAR" });
const other = createClient(db, { companyName: "Other Solar", legalBusinessName: "Other Solar Inc", dba: "Other Sun" });
const plain = createClient(db, { companyName: "Plain Name Solar" });

check("MUST-PASS company, legal business name and DBA, tidied, case-insensitive duplicates dropped", () => {
  assert.deepEqual(learnClientNames(db, { clientId: full.id }), ["Keel Test Solar", "Keel Test Solar Holdings, LLC"]);
});
check("MUST-EXCLUDE an empty legal name / DBA adds nothing", () => {
  assert.deepEqual(learnClientNames(db, { clientId: plain.id }), ["Plain Name Solar"]);
});
check("MUST-EXCLUDE a project with no client has no names", () => {
  assert.deepEqual(learnClientNames(db, { clientId: null } as never), []);
  assert.deepEqual(learnClientNames(db, { clientId: "no-such-client" }), []);
});
check("MUST-EXCLUDE another client's names are never returned", () => {
  const mine = learnClientNames(db, { clientId: full.id });
  for (const n of ["Other Solar", "Other Solar Inc", "Other Sun"]) assert.equal(mine.includes(n), false, `leaked ${n}`);
  assert.deepEqual(learnClientNames(db, { clientId: other.id }), ["Other Solar", "Other Solar Inc", "Other Sun"]);
});
check("MUST-EXCLUDE a DBA changed on the client is read fresh, the old one gone", () => {
  updateClient(db, other.id, { dba: "" });
  assert.deepEqual(learnClientNames(db, { clientId: other.id }), ["Other Solar", "Other Solar Inc"]);
});

if (failures) { console.error(`\n${failures} learn-client-names check(s) FAILED.`); process.exit(1); }
console.log("\nAll learn-client-names checks passed.");
process.exit(0);
