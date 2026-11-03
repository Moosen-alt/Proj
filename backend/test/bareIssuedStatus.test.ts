// AN ISSUED PERMIT READ AS "NEEDS HUMAN REVIEW" (#418).
//
// Coos Bay's issued building and electrical permits (Oregon ePermitting) both sat at "Needs human
// review" (0.45, "did not match a known monitor rule"). Two shapes of issued text reached the
// classifier with no "Record Status:" label: the bare status itself ("Issued", typed or read off a
// list), and a list row whose status cell carries only its column header ("Status: Issued"), which
// is what the status finder now returns for a filing in a list grid. Neither is prose, so both read
// as issued; a bare "issued" inside prose, or in a window of unlabelled cells, still does not.
//   npx tsx backend/test/bareIssuedStatus.test.ts
import assert from "node:assert/strict";
import { classifyPermitStatusText } from "../src/permitMonitor";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const outcome = (text: string) => classifyPermitStatusText(text, "permit").outcome;

check("MUST-PASS a bare stated status reads as issued", () => {
  for (const text of ["Issued", " issued ", "ISSUED", "Finaled", "Permit Finaled"]) assert.equal(outcome(text), "issued", text);
});

check("MUST-PASS a list row labelled by its headers reads as issued", () => {
  assert.equal(outcome("Status: Issued | Date: 10/15/2026 | Record Number: ****0328-STR | Record Type: Residential Structural | Action: Request Inspection"), "issued");
  assert.equal(outcome("Status: Finaled | Record Number: ****1490-ELEC | Record Type: Residential Electrical"), "issued");
});

check("MUST-EXCLUDE 'issued' in prose or in a window of unlabelled cells is not this record's status", () => {
  assert.notEqual(outcome("Permits issued by the city are listed below."), "issued");
  // The old text window: the filing's cell and its neighbours' cells, unlabelled. Its "Issued" may be
  // a neighbouring filing's, so it is not read.
  assert.notEqual(outcome("10/15/2026 ****0328-STR Residential Structural Issued Request Inspection 10/16/2026 ****1491-ELEC In Review"), "issued");
});

check("MUST-EXCLUDE a labelled row that is not issued keeps its own reading", () => {
  assert.equal(outcome("Status: In Review | Date Issued: | Record Number: ****0328-STR"), "waiting");
  assert.equal(outcome("Status: Ready to Issue | Record Number: ****0328-STR"), "ready_for_issue");
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall bare-issued-status checks passed");
