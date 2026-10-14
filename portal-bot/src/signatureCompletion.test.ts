// HAS THE HOMEOWNER SIGNED? (#310: resume after the homeowner signs).
//
// Pins shared/src/signatureCompletion.ts, the one reader the resume asks before it goes on to step 5:
//   - a status counts as signed only on a positive match ("Signed", "Completed", "Fully Signed",
//     "All signatures received", with an on/by/date tail); "Preview Completed", "Partially Signed",
//     "Signed by 1 of 2", "Not signed", "Declined", "Voided" and trailing words never do;
//   - requested ("Requested", "Sent", "Pending Signature", "Out for Signature") and not yet requested
//     ("Not yet previewed", "Previewed") are told apart from each other and from signed;
//   - EVERY status is read: one signer signed and one requested is not signed; an unfamiliar status,
//     the application's own status, or no status at all is "unreadable" and names why.
// KILL TESTS: let SIGNED match any status containing "signed" → the "Partially Signed" / "1 of 2" checks
// fail; read only the first status → the two-signer check fails; return "signed" for [] → the empty check
// fails; put back the any-48-characters on/by/at tail or the old NOT_DONE → the "partial, another party's"
// check fails. Synthetic values only. Run: npx tsx portal-bot/src/signatureCompletion.test.ts
import assert from "node:assert/strict";
import { readSignatureStatus, signatureCompletion } from "../../shared/src/signatureCompletion";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

check("signed only on a positive match", () => {
  for (const s of ["Signed", "Completed", "Completed on 10/12/2026", "Signed by Jordan Testcase", "Signed - 10/12/2026 3:14 PM", "Fully Signed", "All signatures received", "Signature Complete", "Envelope Completed"]) {
    assert.equal(readSignatureStatus(s), "signed", s);
  }
});

check("near misses are never signed", () => {
  for (const s of ["Preview Completed", "Completed Preview", "Partially Signed", "Signed by 1 of 2", "Not signed", "Unsigned", "Declined", "Voided", "Signing declined", "Signed but not submitted"]) {
    assert.notEqual(readSignatureStatus(s), "signed", s);
  }
});

check("a partial, another party's or a placeholder tail never reads signed (Helm review of PR #332)", () => {
  for (const s of [
    "Signed by owner, co-owner to sign", "Signed by Jordan Testcase, sent to Alex Testcase", "Signed by owner - co-owner in progress",
    "Signed by installer", "Completed by sender", "Signed by 1/2 signers", "Completed - 1 / 2", "Signed: 0 / 2",
    "Signed on --/--/----", "Completed on hold", "Completed by 1 signer", "Executed by utility", "Signed by contractor",
    "Signature outstanding", "Signed, countersignature required", "Completed, 1 remaining",
  ]) {
    assert.notEqual(readSignatureStatus(s), "signed", s);
  }
  for (const s of ["Signed - 10/12/2026 3:14 PM", "Completed by Jordan Testcase", "Signed on 10/12/2026", "Completed at 2026-10-12", "Signed 10/12/2026"]) {
    assert.equal(readSignatureStatus(s), "signed", s);
  }
});

check("requested and not-yet-requested are told apart", () => {
  for (const s of ["Requested", "Signature Requested", "Sent", "Delivered", "Pending Signature", "Out for Signature", "Awaiting Customer Signature", "Requested on 10/12/2026"]) {
    assert.equal(readSignatureStatus(s), "requested", s);
  }
  for (const s of ["Not yet previewed", "Previewed", "Not yet requested", "Preview Completed"]) {
    assert.equal(readSignatureStatus(s), "not_requested", s);
  }
});

check("the application's own status and unknown words are unfamiliar", () => {
  for (const s of ["Application Draft", "Unsubmitted Draft", "Processing", "On hold", ""]) {
    assert.equal(readSignatureStatus(s), "unfamiliar", JSON.stringify(s));
  }
});

check("the three record-page states, and an unreadable fourth", () => {
  assert.deepEqual(
    { r: signatureCompletion(["Not yet previewed"]).reading, s: signatureCompletion(["Not yet previewed"]).signed },
    { r: "not_requested", s: false },
  );
  const requested = signatureCompletion(["Signature Requested"]);
  assert.equal(requested.reading, "requested");
  assert.equal(requested.signed, false);
  assert.match(requested.why, /has not signed yet/);
  const signed = signatureCompletion(["Signed"]);
  assert.equal(signed.reading, "signed");
  assert.equal(signed.signed, true);
  const odd = signatureCompletion(["Processing"]);
  assert.equal(odd.reading, "unreadable");
  assert.equal(odd.signed, false);
  assert.match(odd.why, /"Processing"/);
});

check("every status is read: one signer signed and one requested is not signed", () => {
  const two = signatureCompletion(["Signed", "Requested"]);
  assert.equal(two.signed, false);
  assert.equal(two.reading, "requested");
  assert.match(two.why, /"Requested"/);
  assert.equal(signatureCompletion(["Signed", "Completed on 10/12/2026"]).signed, true);
  assert.equal(signatureCompletion(["Signed", "Declined"]).reading, "unreadable");
});

check("nothing read is never signed, and names why", () => {
  for (const empty of [[], [""], ["  "], null, undefined]) {
    const r = signatureCompletion(empty as never);
    assert.equal(r.signed, false);
    assert.equal(r.reading, "unreadable");
    assert.match(r.why, /no signature status/);
  }
});

if (failures) { console.error(`\n${failures} signatureCompletion check(s) failed.`); process.exit(1); }
console.log("\nAll signatureCompletion checks passed.");
