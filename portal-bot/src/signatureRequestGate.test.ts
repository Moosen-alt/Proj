// MAY AUTOMATION CLICK "REQUEST SIGNATURES"? (#308; owner ruling 2026-10-14 on #305: "Auto").
//
// Pins shared/src/signatureRequestGate.ts and the shared predicate every door uses:
//   - never without a named person's approval of THIS run: no approval, a blank approver, an approval
//     for another run all refuse; PORTAL_ALLOW_FINAL_SUBMIT=1 alone refuses (the gate reads no env);
//   - never on a page that is not as staged: Sign and Upload selected, not previewed, a required
//     consent unticked, two request controls, or a request already sent;
//   - isSignatureRequestControl names PowerClerk's "Request Signatures" (and its wording variants) and
//     not a status heading, a column or Preview Document; the recorders block it (classifyRecordedClick);
//   - rule 1 untouched: the final-submit gate still refuses a signature-request approval context.
// Synthetic values only. Run: npx tsx portal-bot/src/signatureRequestGate.test.ts
import assert from "node:assert/strict";
import { classifyRecordedClick, isSignatureRequestControl, mayClickFinalSubmit } from "../../shared/src/portalSafety";
import {
  mayRequestSignatures, signatureRequestRefusals, signatureStatusSaysRequested, type SignatureRequestContext,
} from "../../shared/src/signatureRequestGate";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const READY: SignatureRequestContext = {
  runApproval: { approver: "Pat Approver", runId: "run-1" },
  runId: "run-1",
  page: { requestControls: 1, previewed: true, signatureType: "esign", consentsComplete: true, status: "Previewed" },
};
const withPage = (p: Partial<NonNullable<SignatureRequestContext["page"]>>): SignatureRequestContext => ({ ...READY, page: { ...READY.page!, ...p } });

check("a named person's approval of this run, on a page as staged: allowed", () => {
  assert.deepEqual(signatureRequestRefusals(READY), []);
  assert.equal(mayRequestSignatures(READY), true);
});

check("no approval refuses — and PORTAL_ALLOW_FINAL_SUBMIT=1 alone does not allow it", () => {
  const prev = process.env.PORTAL_ALLOW_FINAL_SUBMIT;
  process.env.PORTAL_ALLOW_FINAL_SUBMIT = "1";
  try {
    const ctx = { ...READY, runApproval: null };
    assert.equal(mayRequestSignatures(ctx), false);
    assert.match(signatureRequestRefusals(ctx).join(" | "), /no named person approved/);
  } finally {
    if (prev === undefined) delete process.env.PORTAL_ALLOW_FINAL_SUBMIT; else process.env.PORTAL_ALLOW_FINAL_SUBMIT = prev;
  }
});

check("a blank approver, or an approval of another run (a burned / refused one is never this run's), refuses", () => {
  assert.match(signatureRequestRefusals({ ...READY, runApproval: { approver: "  ", runId: "run-1" } }).join(" | "), /names no approver/);
  assert.match(signatureRequestRefusals({ ...READY, runApproval: { approver: "Pat Approver", runId: "run-0" } }).join(" | "), /different run/);
  assert.match(signatureRequestRefusals({ ...READY, runId: "" }).join(" | "), /different run/);
  assert.equal(mayRequestSignatures(null), false);
});

check("a page not as staged refuses, each reason named", () => {
  assert.match(signatureRequestRefusals(withPage({ signatureType: "sign_and_upload" })).join(" | "), /Sign and Upload is selected/);
  assert.match(signatureRequestRefusals(withPage({ signatureType: "" })).join(" | "), /eSign is not selected/);
  assert.match(signatureRequestRefusals(withPage({ previewed: false })).join(" | "), /not previewed/);
  assert.match(signatureRequestRefusals(withPage({ consentsComplete: false })).join(" | "), /required consent/);
  assert.match(signatureRequestRefusals(withPage({ requestControls: 2 })).join(" | "), /not exactly one/);
  assert.match(signatureRequestRefusals(withPage({ requestControls: 0 })).join(" | "), /not exactly one/);
  assert.match(signatureRequestRefusals({ ...READY, page: null }).join(" | "), /not read/);
});

check("a request already sent is never sent again; a negated status is not one", () => {
  for (const s of ["Signature Requested", "Requested", "Sent to customer", "Signed", "Completed", "Awaiting Customer Signature"]) {
    assert.equal(signatureStatusSaysRequested(s), true, s);
    assert.equal(mayRequestSignatures(withPage({ status: s })), false, s);
  }
  for (const s of ["Not yet previewed", "Previewed", "Not yet requested", "Unsigned", "", "Ready"]) {
    assert.equal(signatureStatusSaysRequested(s), false, s);
  }
});

check("isSignatureRequestControl: Request Signatures and its wordings, nothing else", () => {
  for (const l of ["Request Signatures", "Request Signature", "request  signatures", "Send for Signature", "Send for eSignature", "Resend DocuSign", "Request eSignature", "Send to Sign"]) {
    assert.equal(isSignatureRequestControl(l), true, l);
  }
  for (const l of ["Signature Request Status", "Requested By", "Preview Document", "Sign and Upload", "Browse", "Submit", "eSign", "Signature", "Request Information", "Send Message", ""]) {
    assert.equal(isSignatureRequestControl(l), false, l);
  }
});

check("the recorders never capture Request Signatures (classifyRecordedClick → blocked), and it is not the filing click", () => {
  assert.equal(classifyRecordedClick("Request Signatures"), "blocked");
  assert.equal(classifyRecordedClick("Request Signatures", { reviewPage: true, readOnlyPage: true }), "blocked");
  assert.equal(classifyRecordedClick("Preview Document"), "capture");
});

check("rule 1 untouched: a signature-request approval context never satisfies the final-submit gate", () => {
  assert.equal(mayClickFinalSubmit({ envAllows: false, runApproval: { approver: "Pat Approver", runId: "run-1" }, runId: "run-1", stepIsTerminalFlagged: false, recipeShapeValid: true } as never), false);
});

if (failures) { console.error(`\n${failures} signatureRequestGate check(s) failed`); process.exit(1); }
console.log("\nsignatureRequestGate: all checks passed");
