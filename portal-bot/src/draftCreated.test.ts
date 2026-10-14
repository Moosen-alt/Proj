// A SUBMIT THAT MAKES A DRAFT IS NOT THE FILING (#302).
//
// Pins draftCreated.ts in both directions: the two pages PSE's two-part PowerClerk flow showed
// after Part 1's Submit (the draft-created banner and the record page) read as a DRAFT with the
// form to continue to; and every filed or ordinary page — a real confirmation, a review page with
// a "Save Draft" button, a help text that mentions drafts, "unsubmitted changes" — does not.
// All text is synthetic, modelled on the wording quoted in the issue; no real customer.
// Run: tsx portal-bot/src/draftCreated.test.ts
import assert from "node:assert/strict";
import {
  chooseDraftForm, findSiteDraft, isDraftFormRefusal, modificationOnOriginalNotice, readDraftCreated, readsAsUnsubmittedDraft,
} from "./draftCreated";
import type { ProjectFormRow } from "./adapters/correctionForm";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// The page Part 1's Submit produced (issue #302, wording as quoted; number synthetic).
const DRAFT_CREATED_PAGE = `
  Puget Sound Energy — Interconnection
  Your draft application NEM-90017 has been created. Please continue to Interconnection Application - Part 2
  to complete your interconnection application and submit to PSE.
  Return to Program Home
`;
// The record page the account then shows (status + Current Forms).
const DRAFT_RECORD_PAGE = `
  NEM-90017   Status: Application Draft
  Unsubmitted Draft Application started
  Current Forms
  Interconnection Application - Part 2   New Form   Begin
  Previously Submitted Forms
  Interconnection Application Part 1 (Preliminary Validation)   View
`;
// A real filing confirmation (PowerClerk shape) — must never read as a draft.
const FILED_PAGE = `
  Thank you for your application. Your application has been submitted.
  PP - Application Submitted (APP-111681)
`;
// A review page before the filing: "Save Draft" beside "Submit" is a button, not a draft record.
const REVIEW_PAGE = `
  Step 5 of 5: Next Steps
  Please review your application before submitting.
  Save Draft   Submit
`;
const HELP_PAGE = `Drafts are kept for 30 days. You can return to a draft from Program Home at any time.`;
const UNSAVED_PAGE = `You have unsubmitted changes on this page. Save before leaving.`;

check("the draft-created page reads as a draft, with its number and the form to continue to", () => {
  const r = readDraftCreated(DRAFT_CREATED_PAGE);
  assert.equal(r.draft, true);
  assert.equal(r.strength, "created");
  assert.equal(r.applicationNumber, "NEM-90017");
  assert.equal(r.nextForm, "Interconnection Application - Part 2");
  assert.match(r.evidence, /has been created/);
});

check("the same wording without the word 'draft' still reads as a draft when it says to continue and submit", () => {
  const r = readDraftCreated("Your application NEM-90018 has been created. Please continue to Part 2 - System Details to complete the application and submit it.");
  assert.equal(r.draft, true);
  assert.equal(r.strength, "created");
  assert.equal(r.applicationNumber, "NEM-90018");
  assert.equal(r.nextForm, "Part 2 - System Details");
});

check("the record page (Application Draft / Unsubmitted) is not a filing, but only a status-strength reading", () => {
  const r = readDraftCreated(DRAFT_RECORD_PAGE);
  assert.equal(r.draft, true);
  assert.equal(r.strength, "status", "a status alone never heals a recipe step");
  assert.equal(readsAsUnsubmittedDraft(DRAFT_RECORD_PAGE), true);
});

check("a filed confirmation is never a draft", () => {
  assert.equal(readDraftCreated(FILED_PAGE).draft, false);
});

check("a page that says both 'submitted' and 'draft created' is left to the confirmation readers", () => {
  assert.equal(readDraftCreated("Your application has been submitted. Your draft application NEM-1234 has been created.").draft, false);
});

check("a review page with a Save Draft button, a help text and 'unsubmitted changes' are not drafts", () => {
  assert.equal(readDraftCreated(REVIEW_PAGE).draft, false);
  assert.equal(readDraftCreated(HELP_PAGE).draft, false);
  assert.equal(readDraftCreated(UNSAVED_PAGE).draft, false);
  assert.equal(readsAsUnsubmittedDraft(UNSAVED_PAGE), false);
  assert.equal(readDraftCreated("").draft, false);
});

const rows = (...r: Array<[string, string, string]>): ProjectFormRow[] => r.map(([name, action, section], i) => ({ key: `cf${i}`, name, action, section }));

check("the named next form is chosen by name; the receipt row and a cancellation row are never chosen", () => {
  const c = chooseDraftForm(rows(
    ["PSE - Cancellation Form", "Begin", "Current Forms"],
    ["Interconnection Application - Part 2", "Begin", "Current Forms"],
    ["Interconnection Application Part 1 (Preliminary Validation)", "View", "Previously Submitted Forms"],
  ), "Interconnection Application - Part 2");
  assert.ok(!isDraftFormRefusal(c), JSON.stringify(c));
  if (!isDraftFormRefusal(c)) assert.equal(c.row.name, "Interconnection Application - Part 2");
});

check("without a named form, the one openable non-cancellation form is chosen; two are refused", () => {
  const one = chooseDraftForm(rows(["Interconnection Application - Part 2", "Begin", "Current Forms"], ["PSE - Withdraw Application", "Begin", "Current Forms"]), "");
  assert.ok(!isDraftFormRefusal(one));
  const two = chooseDraftForm(rows(["Part 2 - Customer", "Begin", "Current Forms"], ["Part 2 - Installer", "Begin", "Current Forms"]), "");
  assert.ok(isDraftFormRefusal(two));
});

check("a named form the record does not offer is refused, never swapped for another", () => {
  const c = chooseDraftForm(rows(["Meter Request", "Begin", "Current Forms"]), "Interconnection Application - Part 2");
  assert.ok(isDraftFormRefusal(c));
});

const entries = [
  { id: "NEM-90017", href: "https://utility.example.test/p/1", row: "NEM-90017 Application Draft Jordan Testcase 1234 N Example St Lynden" },
  { id: "NEM-80001", href: "https://utility.example.test/p/2", row: "NEM-80001 Approved Riley Sample 77 Other Rd Lynden" },
  { id: "NEM-80002", href: "https://utility.example.test/p/3", row: "NEM-80002 Unsubmitted Draft Riley Sample 77 Other Rd Lynden" },
];

check("the project's draft is found by its recorded number, else by an unsubmitted row on its street", () => {
  const byNumber = findSiteDraft(entries, { applicationNumber: "nem-90017" });
  assert.ok(byNumber.found && byNumber.entry.id === "NEM-90017");
  const byStreet = findSiteDraft(entries, { street: "1234 North Example Street" });
  assert.ok(byStreet.found && byStreet.entry.id === "NEM-90017", JSON.stringify(byStreet));
});

check("a filed record on the same street is not a draft, and two drafts on one street are refused", () => {
  assert.equal(findSiteDraft(entries.slice(1, 2), { street: "77 Other Rd" }).found, false);
  const two = findSiteDraft([...entries, { id: "NEM-80003", href: "", row: "NEM-80003 Application Draft 77 Other Rd" }], { street: "77 Other Rd" });
  assert.ok(!two.found && two.ambiguous);
  assert.equal(findSiteDraft(entries, { street: "" }).found, false);
  assert.equal(findSiteDraft(entries, { applicationNumber: "NEM-99999" }).found, false);
});

// THE STREET MATCH NEVER CLAIMS ANOTHER HOUSE (Helm review of PR #325, blocker). A false claim is
// recorded for this project and the next stage fills that stranger's Part 2 with this project's data.
const draftRow = (id: string, address: string, extra = "") => ({ id, href: `https://utility.example.test/p/${id}`, row: `${id} Application Draft Jordan Testcase ${address}${extra ? ` ${extra}` : ""}` });
const site = (street: string, city = "", zip = "", siblingAtSameStreet = false) => ({ street, city, zip, siblingAtSameStreet });

check("another house's draft is never claimed: a different ordinal street, another city, another unit", () => {
  const ordinal = findSiteDraft([draftRow("NEM-91001", "15 1st Ave, Lynden")], site("15 3rd Ave, Bellingham", "Bellingham"));
  assert.equal(ordinal.found, false, ordinal.why);
  const city = findSiteDraft([draftRow("NEM-91002", "1234 Main St, Seattle")], site("1234 Main St, Lynden", "Lynden"));
  assert.equal(city.found, false, city.why);
  const unit = findSiteDraft([draftRow("NEM-91003", "1234 Main St Unit A, Lynden")], site("1234 Main St Unit B, Lynden", "Lynden"));
  assert.equal(unit.found, false, unit.why);
  // The house number as a DAY in a date column, on an avenue with another name.
  const date = findSiteDraft([draftRow("NEM-91004", "88 Elm Ave, Lynden", "10/15/2026")], site("15 Oak Ave, Lynden", "Lynden"));
  assert.equal(date.found, false, date.why);
});

check("one side naming a unit, a foreign city word, or a city-less row with another record on the line stops as ambiguous", () => {
  const oneUnit = findSiteDraft([draftRow("NEM-92001", "1234 Main St, Lynden")], site("1234 Main St Unit B, Lynden", "Lynden"));
  assert.ok(!oneUnit.found && oneUnit.ambiguous, oneUnit.why);
  const foreign = findSiteDraft([draftRow("NEM-92002", "1234 Main St Ferndale")], site("1234 Main St, Lynden", "Lynden"));
  assert.ok(!foreign.found && foreign.ambiguous, foreign.why);
  const twoOnLine = findSiteDraft([
    draftRow("NEM-92003", "1234 Main St"),
    { id: "NEM-92004", href: "", row: "NEM-92004 Approved Riley Sample 1234 Main St" },
  ], site("1234 Main St, Lynden", "Lynden"));
  assert.ok(!twoOnLine.found && twoOnLine.ambiguous, twoOnLine.why);
  const sibling = findSiteDraft([draftRow("NEM-92005", "1234 Main St")], site("1234 Main St, Lynden", "Lynden", "", true));
  assert.ok(!sibling.found && sibling.ambiguous, sibling.why);
  const unconfirmed = findSiteDraft([draftRow("NEM-92006", "1234 Main St")], site("1234 Main St, Lynden", "Lynden"));
  assert.ok(unconfirmed.found, `with no sibling and nothing else on the line, the one city-less draft is the project's: ${unconfirmed.why}`);
});

check("the one real draft is still found past dates, fees, sizes, ZIP+4, long house numbers, suffix-less streets and a unit after the ZIP", () => {
  const cases: Array<[string, ReturnType<typeof site>]> = [
    ["1234 N Example St, Lynden 10/15/2026 $125.00 7.2 kW", site("1234 North Example Street, Lynden, WA 98264", "Lynden", "98264")],
    ["1234 N Example St Lynden WA 98264-1234", site("1234 N Example St, Lynden, WA 98264", "Lynden", "98264")],
    ["12345 Example Rd, Lynden", site("12345 Example Rd, Lynden, WA", "Lynden")],
    ["1234 Broadway, Lynden", site("1234 Broadway, Lynden, WA 98264", "Lynden", "98264")],
    ["1234 Main St Lynden WA 98264 Unit B", site("1234 Main St Unit B, Lynden, WA 98264", "Lynden", "98264")],
  ];
  for (const [address, s] of cases) {
    const r = findSiteDraft([draftRow("NEM-93001", address), { id: "NEM-93999", href: "", row: "NEM-93999 Approved 77 Other Rd Lynden" }], s);
    assert.ok(r.found && r.entry.id === "NEM-93001", `"${address}": ${r.why}`);
  }
});

check("a recorded draft whose row now reads filed is not continued; a 'Not Submitted' row still is", () => {
  const filed = findSiteDraft([{ id: "NEM-94001", href: "", row: "NEM-94001 Submitted 1234 Main St Lynden" }], { applicationNumber: "NEM-94001" });
  assert.equal(filed.found, false, filed.why);
  const notSubmitted = findSiteDraft([{ id: "NEM-94002", href: "", row: "NEM-94002 Not Submitted 1234 Main St Lynden" }], { applicationNumber: "NEM-94002" });
  assert.ok(notSubmitted.found, notSubmitted.why);
});

check("a status-only tell on a page that still asks for the submit is not a draft; the record page's help text still is", () => {
  const stillAsks = "NEM-90017 Status: Application Draft  Step 5 of 5. Please review your application before submitting.  Submit";
  assert.equal(readDraftCreated(stillAsks).draft, false);
  const helpText = `${DRAFT_RECORD_PAGE} This application has not yet been submitted. To submit your application, complete the forms below and click Submit to file.`;
  const r = readDraftCreated(helpText);
  assert.equal(r.draft, true);
  assert.equal(r.strength, "status");
  // The "created" wording wins even on a page that also asks.
  assert.equal(readDraftCreated(`${DRAFT_CREATED_PAGE} Please review your application before submitting.`).draft, true);
});

check("PSE's modification-on-the-original-record notice is read as a review note, digits masked", () => {
  const note = modificationOnOriginalNotice("Application Type: Change to an existing Net Metered System. If an original application exists, this change must be filed as a modification on the original record 4413100 instead. Next");
  assert.match(note, /modification on the original record/);
  assert.doesNotMatch(note, /4413100/);
  assert.equal(modificationOnOriginalNotice(REVIEW_PAGE), "");
});

if (failures) { console.error(`\n${failures} draftCreated check(s) failed`); process.exit(1); }
console.log("\ndraftCreated: all checks passed");
