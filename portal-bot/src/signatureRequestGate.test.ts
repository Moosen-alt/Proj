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
// Helm review of PR #331 (fix round): every wording a portal uses for the request ("Request Customer
// Signature", "Sign & Send", "Send Envelope"…) is a request control and "Submit and Sign" (the filing)
// is not; the gate clicks only when EVERY status read says, positively, not yet requested
// ("Pending Signature", a misread table header, a second signer's "Requested" refuse); a box is
// ticked only when required on itself / its label / its own row, or consent-worded, never "(optional)".
// Synthetic values only. Run: npx tsx portal-bot/src/signatureRequestGate.test.ts
import assert from "node:assert/strict";
import { classifyRecordedClick, isSignatureRequestControl, mayClickFinalSubmit } from "../../shared/src/portalSafety";
import {
  mayRequestSignatures, signatureRequestRefusals, signatureStatusReadsUnrequested, signatureStatusSaysRequested, type SignatureRequestContext,
} from "../../shared/src/signatureRequestGate";
import { consentMustBeTicked, type SignatureConsent } from "./adapters/signatureRequestStep";

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

// ---- Helm review of PR #331: the shapes its probes found ----

check("isSignatureRequestControl: every request wording a portal uses (unapproved runs emailed the homeowner on these)", () => {
  for (const l of [
    "Request Customer Signature", "Request Homeowner Signature", "Request Account Holder Signature", "Request Signature from Customer",
    "Email for Signature", "E-mail for Signature", "Email Customer for eSignature", "Send to Customer for Signature",
    "Send Application for Signature", "Get Signatures", "Get eSignature", "Collect Signatures", "Sign & Send", "Sign and Send",
    "Submit for Signature", "Send Envelope", "Send the DocuSign", "Start DocuSign", "Signature Request", "eSign Request",
    "Initiate Signing", "Start Signing", "Invite Signers", "Notify Signer", "Route for Signature", "Forward for Signature",
    "Resend Signature Request", "Re-send for eSignature",
  ]) assert.equal(isSignatureRequestControl(l), true, l);
});

check("isSignatureRequestControl: sign-off, sign-in, signing officer, signed copies and a sign permit are not requests", () => {
  for (const l of [
    "Request Sign-off", "Request Sign off", "Send Sign In Link", "Request Sign-up Link", "Get Sign-on Help", "Signing Officer",
    "Upload Signed Application", "Request Signed Copy", "Download Signed Agreement", "Request Sign Permit", "Signer Email", "Signature Status",
    "Sign In",
  ]) assert.equal(isSignatureRequestControl(l), false, l);
});

check("\"Submit and Sign\" is the filing, never a signature request: rule 1's gate decides it, as on main", () => {
  for (const l of ["Submit and Sign", "Submit & Sign", "Submit & eSign"]) {
    assert.equal(isSignatureRequestControl(l), false, l);
    assert.notEqual(classifyRecordedClick(l, { reviewPage: true }), "capture", l);
  }
  assert.equal(isSignatureRequestControl("Submit for Signature"), true);
});

check("the gate clicks only when EVERY status read says, positively, not yet requested", () => {
  for (const statuses of [["Not yet previewed"], ["Previewed"], ["Previewed by Pat Approver"], ["Document Previewed"], ["Preview complete"],
    ["Ready for eSignature"], ["Ready to Send"], ["Not requested"], ["Not sent"], ["Unsent"], ["Draft"], ["Pending Preview"],
    ["Previewed - ready to request signatures"], ["Not yet requested", "Not yet requested"]]) {
    assert.deepEqual(signatureRequestRefusals(withPage({ status: statuses.join("; "), statuses })), [], JSON.stringify(statuses));
  }
  for (const statuses of [["Pending Signature"], ["Viewed"], ["Waiting for signer"], ["Signer Email"], ["Unknown"], [],
    ["Not yet requested", "Requested"], ["Previewed", "Requested on 10/12/2026"], ["Jordan Testcase jt@example.test Requested"],
    ["Request emailed to the account holder"], ["Declined"]]) {
    const why = signatureRequestRefusals(withPage({ status: statuses.join("; "), statuses })).join(" | ");
    assert.match(why, /signature status/, JSON.stringify(statuses));
    assert.equal(mayRequestSignatures(withPage({ status: statuses.join("; "), statuses })), false, JSON.stringify(statuses));
  }
  assert.equal(signatureStatusSaysRequested("Preview complete"), false);
  assert.equal(signatureStatusReadsUnrequested("Pending Signature"), false);
  assert.equal(signatureStatusReadsUnrequested(""), false);
  // An empty single status (nothing read) refuses: the old deny-list let it through.
  assert.match(signatureRequestRefusals(withPage({ status: "" })).join(" | "), /could not be read/);
});

check("consentMustBeTicked: required on the box / label / row, or consent-worded; never when marked optional", () => {
  const c = (x: Partial<SignatureConsent>): SignatureConsent => ({ i: 0, id: "", name: "", label: "", tag: "input", type: "checkbox", text: "", checked: false, required: false, money: false, ...x });
  assert.equal(consentMustBeTicked(c({ required: true })), true);
  assert.equal(consentMustBeTicked(c({ consent: true })), true);
  assert.equal(consentMustBeTicked(c({ required: true, optional: true })), false);
  assert.equal(consentMustBeTicked(c({ consent: true, optional: true })), false);
  assert.equal(consentMustBeTicked(c({})), false, "a box neither required nor consent-worded (Net Meter Aggregation) is a person's choice");
});

if (failures) { console.error(`\n${failures} signatureRequestGate check(s) failed`); process.exit(1); }
console.log("\nsignatureRequestGate: all checks passed");
