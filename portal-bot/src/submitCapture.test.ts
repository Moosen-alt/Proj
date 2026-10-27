// AFTER A PERSON FILES IN THE REVIEW WINDOW: WHICH NUMBER, WHICH LINK, OR NEITHER (#400).
//
// Pinned on the pure chooser (submissionLedger.chooseSubmittedRecord) and on the window's capture
// hand-off (index.armSubmitCapture, with a fake adapter), synthetic shapes only:
//   (a) the link preference: the href on the number, then the new row's, then the cleaned page URL;
//       every link cleaned of session material, and never a `javascript:` link;
//   (b) no confident number + EXACTLY ONE new row in the account list → that row is the filing;
//       two new rows, or a different unsure page read → nothing written, candidates instead;
//   (b2) the one new row writes only when it reads as THIS filing: not an unsubmitted draft, and,
//       with a site known, not naming another street (a row naming no address still writes);
//   (c) no diff without a real "before" list the "after" page shares a row with;
//   (d) the hand-off reports an UNSURE read as low confidence with its candidates — main reported
//       every page number as high, so an unconfident read was written as the filing's number.
//
// KILLS (each fails on main 023ce333): chooseSubmittedRecord and armSubmitCapture's recordRead
// branch do not exist there; (d) fails on main's hand-off, which says "high" for any number.
// Run: npx tsx portal-bot/src/submitCapture.test.ts
import assert from "node:assert/strict";
import { chooseSubmittedRecord, safeRecordLink, submitLedgerDiff, type LedgerEntry } from "./adapters/submissionLedger";
import { extractRecordNumber } from "./recordNumber";

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const ACCELA = "https://aca.example-city.test/CitizenAccess";
const BEFORE: LedgerEntry[] = [
  { id: "PC-0042101", href: "https://grid.example.test/Projects/View?ProjectId=42101&sessionToken=abc", row: "PC-0042101 41 Fern Ln Submitted" },
  { id: "PC-0042102", href: "https://grid.example.test/Projects/View?ProjectId=42102", row: "PC-0042102 7 Alder Ct In review" },
];
const row = (n: number): LedgerEntry => ({ id: `PC-00${n}`, href: `https://grid.example.test/Projects/View?ProjectId=${n}&auth=tok${n}`, row: `PC-00${n} 12 Willow Rd Submitted` });
const NO_READ = { value: "", confidence: "low" as const, reason: "No record number found on the page." };

await check("(a) Accela: the number's own link wins, with agencyCode kept and the session ticket dropped", () => {
  const read = extractRecordNumber("Your application has been successfully submitted. Record Number: 517-26-000274-STR");
  const got = chooseSubmittedRecord({
    read,
    numberHref: `${ACCELA}/Cap/CapDetail.aspx?Module=Building&TabName=Building&capID1=26CAP&capID2=00000&capID3=00274&agencyCode=EXCITY&ticket=SESSION123`,
    before: null, after: [],
    pageUrl: `${ACCELA}/Cap/CapCompletion.aspx?stepNumber=6&ticket=SESSION123`,
  });
  assert.equal(got.confidence, "high");
  assert.equal(got.recordNumber, "517-26-000274-STR");
  assert.equal(got.source, "completion_page");
  assert.match(got.recordLink, /CapDetail\.aspx\?/);
  assert.match(got.recordLink, /agencyCode=EXCITY/);
  assert.match(got.recordLink, /capID3=00274/);
  assert.ok(!/ticket|SESSION/i.test(got.recordLink), got.recordLink);
});

await check("(a) no link on the number: the matching new row's link, then the cleaned page URL", () => {
  const read = extractRecordNumber("Thank you for your application. Your application has been submitted. APP-204411");
  const viaRow = chooseSubmittedRecord({
    read, numberHref: "",
    before: BEFORE, after: [...BEFORE, { id: "APP-204411", href: "https://grid.example.test/Projects/View?ProjectId=204411&auth=x", row: "APP-204411" }],
    pageUrl: "https://grid.example.test/Projects/List?sessionToken=zzz",
  });
  assert.equal(viaRow.recordNumber, "APP-204411");
  assert.equal(viaRow.recordLink, "https://grid.example.test/Projects/View?ProjectId=204411");
  const viaPage = chooseSubmittedRecord({ read, numberHref: "", before: null, after: null, pageUrl: "https://grid.example.test/MvcProjects/EditProject?ProjectId=204411&sessionToken=zzz" });
  assert.equal(viaPage.recordLink, "https://grid.example.test/MvcProjects/EditProject?ProjectId=204411");
});

await check("(a) a javascript: href or an unparseable link is never a record link", () => {
  assert.equal(safeRecordLink("javascript:void(openRecord('517-26-000274-STR'))"), "");
  assert.equal(safeRecordLink("not a url"), "");
  const read = extractRecordNumber("Your application has been successfully submitted. Record Number: 517-26-000274-STR");
  const got = chooseSubmittedRecord({ read, numberHref: "javascript:void(0)", before: null, after: null, pageUrl: `${ACCELA}/Cap/CapCompletion.aspx` });
  assert.equal(got.recordLink, `${ACCELA}/Cap/CapCompletion.aspx`);
});

await check("(b) drawer-close portal: exactly one new row is the filing, with its own cleaned link", () => {
  const got = chooseSubmittedRecord({ read: NO_READ, numberHref: "", before: BEFORE, after: [row(42199), ...BEFORE], pageUrl: "https://grid.example.test/Projects/List" });
  assert.equal(got.confidence, "high");
  assert.equal(got.source, "account_list");
  assert.equal(got.recordNumber, "PC-0042199");
  assert.equal(got.recordLink, "https://grid.example.test/Projects/View?ProjectId=42199");
  assert.deepEqual(got.candidates, []);
});

await check("(b) two new rows write nothing: both are candidates for a person", () => {
  const got = chooseSubmittedRecord({ read: NO_READ, numberHref: "", before: BEFORE, after: [row(42199), row(42200), ...BEFORE], pageUrl: "https://grid.example.test/Projects/List" });
  assert.equal(got.confidence, "low");
  assert.equal(got.recordNumber, "");
  assert.deepEqual(got.candidates.map((c) => c.recordNumber), ["PC-0042199", "PC-0042200"]);
  assert.ok(got.candidates.every((c) => c.source === "account_list" && !/auth=/.test(c.recordLink)));
  assert.match(got.reason, /2 new applications/);
});

await check("(b) an unsure page read that disagrees with the one new row writes nothing", () => {
  const read = extractRecordNumber("Record Number: BLD-26-00123 (draft)"); // labelled, no completion wording → low
  assert.equal(read.confidence, "low");
  const got = chooseSubmittedRecord({ read, numberHref: "", before: BEFORE, after: [row(42199), ...BEFORE], pageUrl: "https://grid.example.test/Projects/List" });
  assert.equal(got.confidence, "low");
  assert.deepEqual(got.candidates.map((c) => c.recordNumber), ["BLD-26-00123", "PC-0042199"]);
});

// THE ONE NEW ROW MUST BE THIS FILING (Helm review on #401): a shared account lists a colleague's
// application for another home; a submit that only made a draft lists one new draft row.
const SITE = { street: "12 Willow Rd", city: "Fernhollow", zip: "97999" };
const newRow = (text: string): LedgerEntry => ({ id: "PC-0042199", href: "https://grid.example.test/Projects/View?ProjectId=42199", row: `PC-0042199 ${text}` });
await check("(b2) one new row reading as a draft writes nothing: a candidate, with the reason", () => {
  const got = chooseSubmittedRecord({ read: NO_READ, numberHref: "", before: BEFORE, after: [newRow("12 Willow Rd Status: Draft"), ...BEFORE], pageUrl: "https://grid.example.test/Projects/List" });
  assert.equal(got.confidence, "low");
  assert.equal(got.recordNumber, "");
  assert.deepEqual(got.candidates.map((c) => c.recordNumber), ["PC-0042199"]);
  assert.match(got.reason, /unsubmitted draft/);
});
await check("(b2) ...and so does an unsure page read that agrees with that draft row", () => {
  const read = extractRecordNumber("Application PC-0042199");
  const got = chooseSubmittedRecord({ read, numberHref: "", before: BEFORE, after: [newRow("12 Willow Rd Status: Draft"), ...BEFORE], pageUrl: "https://grid.example.test/Projects/List" });
  assert.equal(got.recordNumber, "");
  assert.deepEqual(got.candidates.map((c) => c.recordNumber), ["PC-0042199"]);
});
await check("(b2) with a site set, one new row naming another street writes nothing", () => {
  const got = chooseSubmittedRecord({ read: NO_READ, numberHref: "", before: BEFORE, after: [newRow("880 Juniper Ave Fernhollow 97999 Submitted"), ...BEFORE], pageUrl: "https://grid.example.test/Projects/List", site: SITE });
  assert.equal(got.confidence, "low");
  assert.equal(got.recordNumber, "");
  assert.deepEqual(got.candidates.map((c) => c.recordNumber), ["PC-0042199"]);
  assert.match(got.reason, /different site/);
});
await check("(b2) with a site set, one new row naming this site still writes", () => {
  const got = chooseSubmittedRecord({ read: NO_READ, numberHref: "", before: BEFORE, after: [newRow("12 Willow Rd Fernhollow 97999 Submitted"), ...BEFORE], pageUrl: "https://grid.example.test/Projects/List", site: SITE });
  assert.equal(got.confidence, "high");
  assert.equal(got.recordNumber, "PC-0042199");
});
await check("(b2) with a site set, one new row naming no address still writes", () => {
  const got = chooseSubmittedRecord({ read: NO_READ, numberHref: "", before: BEFORE, after: [newRow("Net Metering Submitted 10/27/2026"), ...BEFORE], pageUrl: "https://grid.example.test/Projects/List", site: SITE });
  assert.equal(got.confidence, "high");
  assert.equal(got.recordNumber, "PC-0042199");
});

await check("(c) no diff without a before list, or when the after page shares no row with it", () => {
  assert.equal(submitLedgerDiff(null, [row(42199)]), null);
  assert.equal(submitLedgerDiff([], [row(42199)]), null);
  assert.equal(submitLedgerDiff(BEFORE, [row(42199)]), null, "an unrelated page's ids read as new");
  const got = chooseSubmittedRecord({ read: NO_READ, numberHref: "", before: BEFORE, after: [row(42199)], pageUrl: "https://grid.example.test/Done" });
  assert.equal(got.confidence, "low");
  assert.deepEqual(got.candidates, []);
});

await check("(c) a completion page with no number and no list: nothing, and no candidate", () => {
  const read = extractRecordNumber("Thank you. Your submission is complete. We will contact you within 10 business days.");
  const got = chooseSubmittedRecord({ read, numberHref: "", before: BEFORE, after: [], pageUrl: "https://grid.example.test/Done" });
  assert.equal(got.recordNumber, "");
  assert.deepEqual(got.candidates, []);
});

// ── The window's hand-off (index.armSubmitCapture) ────────────────────────────────────────
// The real function, its 4 s settle included, with an adapter whose watch fires at once.
const { armSubmitCapture } = await import("./index");
type Captured = { recordNumber: string; confidence: string; source: string; recordLink: string; candidates?: Array<{ recordNumber: string }>; draftCreated?: unknown };
async function handOff(data: Record<string, unknown>): Promise<Captured> {
  let got: Captured | null = null;
  const adapter = {
    armSubmitWatch: async (cb: (label?: string) => void) => { cb("Submit"); return true; },
    captureSubmissionConfirmation: async () => ({ ok: true, message: "captured", data }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await armSubmitCapture(adapter as any, { onSubmitCaptured: (c: Captured) => { got = c; } } as any);
  for (let i = 0; i < 100 && !got; i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(got, "the hand-off never reported");
  return got!;
}

await check("(d) an unsure page read is handed off LOW with its candidates, never as the number", async () => {
  // A PowerClerk-shaped number on a page that never says the filing went through.
  const read = extractRecordNumber("Application APP-204411 — Status: Draft");
  const recordRead = chooseSubmittedRecord({ read, numberHref: "", before: null, after: null, pageUrl: "https://grid.example.test/Projects/View?ProjectId=204411" });
  const got = await handOff({ permitNumber: read.value, confirmationNumber: read.value, recordLink: recordRead.candidates[0]?.recordLink ?? "", recordRead });
  assert.equal(got.confidence, "low");
  assert.equal(got.recordNumber, "");
  assert.deepEqual((got.candidates ?? []).map((c) => c.recordNumber), ["APP-204411"]);
});

await check("(d) a confident read is handed off HIGH with the chosen link and source", async () => {
  const recordRead = chooseSubmittedRecord({ read: NO_READ, numberHref: "", before: BEFORE, after: [row(42199), ...BEFORE], pageUrl: "https://grid.example.test/Projects/List" });
  const got = await handOff({ permitNumber: "", recordLink: recordRead.recordLink, recordRead });
  assert.equal(got.confidence, "high");
  assert.equal(got.recordNumber, "PC-0042199");
  assert.equal(got.source, "account_list");
  assert.equal(got.recordLink, "https://grid.example.test/Projects/View?ProjectId=42199");
  assert.equal(got.candidates, undefined);
});

await check("(d) a draft-created click is still a draft (#302), never a number", async () => {
  const got = await handOff({ permitNumber: "", recordLink: "", draftCreated: { draft: true, applicationNumber: "NEM-90017", nextForm: "Part 2", evidence: "x", strength: "created" } });
  assert.equal(got.recordNumber, "");
  assert.ok(got.draftCreated, "the draft was not reported");
});

if (failures) { console.error(`\n${failures} submitCapture test(s) failed.`); process.exit(1); }
console.log("\nAll submitCapture tests passed.");
process.exit(0);
