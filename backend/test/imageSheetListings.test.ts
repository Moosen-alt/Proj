// LISTING MARKS ON IMAGE-ONLY PLAN SHEETS, AND EVERY PAGE OF THE PLAN TEXT (#532).
//
// A revised plan set answered an inspector's "Provide UL listing for the panels, mounting and
// racking hardware" with certificate sheets pasted in as PICTURES — their text layer was only the
// title block — and the review gate reported city.plan.ul-listings-missing exactly as it did on the
// unfixed set. Two more limits hid the back of the set: the plan-text checks read only the first
// 20,000 characters, and the page cap was 40.
//
// The fixtures are SYNTHETIC PDFs built here (no names, addresses or plan-set prose from a real
// job). The vision call is a FAKE that records what it was sent — no model, no spend. Pinned:
//   1. the reader: image-only pages only, ordered by sheet name, capped (and the cap stated), early
//      stop, a bill/meter page withheld, a quote that does not name its product's listing dropped,
//      the prompt a constant (rule 2), no vision model = nothing rendered and the report says so;
//   2. the rule: a racking reading clears the racking half only; UL 2703A (attachment) is shown,
//      never a pass; the coverage statement replaces "cut sheets whose pages are images are not read";
//   3. the gate end to end (runStandaloneReview): an image page as the ONLY UL 2703 evidence clears
//      the racking half; a listing on a text page past character 20,000 counts with no vision call
//      while the AI prompt's text stays capped; a set longer than the page cap names its unread pages.
// Sections 3a, 3b and 3d fail on the base branch (#533's head) — see the PR for the red run.
//
// Run: npx tsx backend/test/imageSheetListings.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { JurisdictionCodeProfile, LLMProvider, ProjectRecord, ReviewerFinding, ReviewSubject } from "../../shared/src/types";

process.env.SKIP_CODE_RESEARCH = "1"; // no research jobs from the gate's first-contact hook

const listings = await import("../src/imageSheetListings");
const rules = await import("../src/codeReviewRules");
const { buildCodeContext } = await import("../src/codeProfiles");
const { extractPdfPages } = await import("../src/batchImport");
const { runStandaloneReview, REVIEW_AI_TEXT_CHARS, REVIEW_TEXT_MAX_PAGES } = await import("../src/reviewSubject");
const { StubLLMProvider } = await import("../src/llm");
const db = await (await import("../src/db")).openDatabase();
const { createCanvas } = await import("@napi-rs/canvas" as string);

let failures = 0; let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};

// ---------------------------------------------------------------------------------------------
// Synthetic plan sets
// ---------------------------------------------------------------------------------------------

type Sheet = { text: string[]; name: string } | { image: true; name: string };
const FILLER = ["CONDUCTOR", "BREAKER", "RAFTER", "SETBACK", "AZIMUTH", "BUSBAR"];
/** `count` lines of plan prose for sheet `i`, varied so no line repeats across sheets. */
const prose = (i: number, count: number): string[] =>
  Array.from({ length: count }, (_, r) => `SHEET ${i} NOTE ${r}: ${FILLER[r % 6]} ${i * 100 + r} PER DETAIL ${i}-${r} ROOF MOUNT ARRAY ON RAFTERS AT ${16 + (r % 3) * 8} IN OC`);

/** A plan set of 11x17 sheets, each with the same title block; image sheets are a large raster
 *  carrying only the title block and the sheet's name as text (a cut sheet pasted in as a picture). */
async function planSet(sheets: Sheet[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const cv = createCanvas(1200, 800);
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 1200, 800); ctx.fillStyle = "#000"; ctx.font = "26px sans-serif";
  for (let y = 60; y < 800; y += 44) ctx.fillText(`SYNTHETIC EQUIPMENT DATASHEET ROW ${y} RATING ${y % 9} MODEL SYN-${y}`, 30, y);
  const raster = await doc.embedPng(cv.toBuffer("image/png"));
  sheets.forEach((sheet, idx) => {
    const i = idx + 1;
    const p = doc.addPage([1224, 792]);
    p.drawText(`CONTRACTOR: SYNTHETIC SOLAR CO  ADDRESS: 1 EXAMPLE WAY ANYTOWN  SHEET SIZE ANSI B 11 X 17  SHEET NUMBER DS ${i}  SHEET NAME ${sheet.name}`, { x: 30, y: 20, size: 8, font });
    if ("image" in sheet) {
      p.drawImage(raster, { x: 30, y: 60, width: 1100, height: 700 });
    } else {
      sheet.text.forEach((line, r) => p.drawText(line, { x: 40, y: 750 - r * 13, size: 9, font }));
    }
  });
  return Buffer.from(await doc.save());
}

/** The per-page text the gate extracts (written to a temp file: the extractor reads a path). */
async function pagesOf(pdf: Buffer): Promise<string[]> {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "isl-")), "set.pdf");
  fs.writeFileSync(f, pdf);
  return extractPdfPages(f, 400);
}

type VisionInput = { imageBase64: string; mimeType: string; prompt: string };
/** A fake model: `answer(n)` is what the n-th vision call (0-based) returns. Records every call. */
function fakeLlm(answer: (n: number) => unknown = () => ({ listings: [] })) {
  const visionCalls: VisionInput[] = [];
  const visionKeys: string[][] = [];
  const aiCalls: Array<{ extractedText: string; images: number }> = [];
  const llm = {
    async visionExtract(input: VisionInput) {
      visionCalls.push(input);
      visionKeys.push(Object.keys(input).sort());
      return answer(visionCalls.length - 1);
    },
    async reviewPlanSetGeneral(input: { extractedText?: string; pageImagesBase64: string[] }) {
      aiCalls.push({ extractedText: String(input.extractedText ?? ""), images: input.pageImagesBase64.length });
      return { provider: "claude" as const, findings: [], summary: "fake second opinion", confidence: "low" as const, notes: "" };
    },
  };
  return { llm, visionCalls, visionKeys, aiCalls };
}
const reading = (product: string, quote: string) => ({ listings: [{ product, standard: quote, quote }] });

const LISTINGS = "city.plan.ul-listings-missing";
const get = (list: ReviewerFinding[], id: string) => list.find((f) => f.id === id);

// ---------------------------------------------------------------------------------------------
// 1. The reader
// ---------------------------------------------------------------------------------------------
console.log("1. readImageSheetListings");

// A set shaped like the real one: text sheets first, then a run of pictured cut sheets and
// certificates whose only text is the title block and the sheet's name.
const CUT_SHEETS = [
  "PV MODULE SPECIFICATION", "MICROINVERTER SPECIFICATION", "AC DISCONNECT UL CERTIFICATION", "WIRING SPECIFICATION",
  "RACKING DATA", "MOUNTING DATA", "SPLICE KIT DATA", "MODULE CERTIFICATE", "FIRE CLASS DATA",
  "ATTACHMENT UL CERTIFICATE",
];
const realShaped = await planSet([
  { name: "COVER SHEET", text: prose(1, 30) },
  { name: "SITE PLAN", text: prose(2, 30) },
  { name: "ELECTRICAL", text: prose(3, 30) },
  ...CUT_SHEETS.map((name) => ({ image: true as const, name })),
]);
const realPages = await pagesOf(realShaped);

await check("(r0) the fixture's cut sheets are image-only: title block + name in the text layer, a large raster", async () => {
  const { imageOnlyPages, rasterPixelsPerPage } = await import("../src/scannedPlanSet");
  assert.deepEqual(imageOnlyPages(realPages, await rasterPixelsPerPage(realShaped)), [4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
});

await check("(r1) order: by the sheet's own name, listing + listed-product words first, other equipment last — nothing dropped", () => {
  const ordered = listings.orderListingCandidates([4, 5, 6, 7, 8, 9, 10, 11, 12, 13], realPages);
  // MODULE CERTIFICATE (11) and ATTACHMENT UL CERTIFICATE (13) first; then PV MODULE SPEC (4),
  // RACKING DATA (8), MOUNTING DATA (9); then the unnamed-product sheets; MICROINVERTER (5) and
  // WIRING (7) last. AC DISCONNECT UL CERTIFICATION (6) is a listing of another product.
  assert.deepEqual(ordered.slice(0, 5), [11, 13, 4, 8, 9]);
  assert.deepEqual([...ordered].sort((a, b) => a - b), [4, 5, 6, 7, 8, 9, 10, 11, 12, 13], "every candidate kept");
  assert.ok(ordered.indexOf(5) > ordered.indexOf(6) && ordered.indexOf(7) > ordered.indexOf(6), "inverter / wiring after the disconnect certificate");
});

await check("(r2) the cap: at most 6 pages read, the rest named with the cap; the prompt is the constant (rule 2)", async () => {
  const fake = fakeLlm();
  const r = await listings.readImageSheetListings(fake.llm, realShaped, realPages, { want: { module: true, racking: true } });
  assert.equal(listings.MAX_LISTING_VISION_PAGES, 6);
  assert.equal(fake.visionCalls.length, 6);
  assert.deepEqual(r.read, [11, 13, 4, 8, 9, r.read[5]]);
  assert.equal(r.skipped.length, 4);
  assert.ok(r.skipped.every((s) => s.reason === "over the 6-page cap"), JSON.stringify(r.skipped));
  assert.match(r.coverage, /at most 6 per review\): pages 11, 13, 4, 8, 9, \d+\./);
  assert.match(r.coverage, /Not read: pages [\d, ]+ \(over the 6-page cap\)\./);
  for (const [i, call] of fake.visionCalls.entries()) {
    assert.equal(call.prompt, listings.SHEET_LISTING_VISION_PROMPT, "nothing appended to the prompt");
    assert.equal(call.mimeType, "image/jpeg");
    assert.deepEqual(fake.visionKeys[i], ["imageBase64", "mimeType", "prompt"], "the image and the prompt, nothing else");
    assert.ok(Buffer.from(call.imageBase64, "base64").length <= 3_500_000, "inside the per-image byte cap");
  }
  assert.doesNotMatch(listings.SHEET_LISTING_VISION_PROMPT, /EXAMPLE WAY|SYNTHETIC SOLAR/i, "no project text in the prompt");
});

await check("(r3) early stop: once the missing listing is found, no further page is sent", async () => {
  // Only the racking is wanted; the 4th page read (RACKING DATA, page 8) answers it.
  const fake = fakeLlm((n) => (n === 3 ? reading("racking", "UL 2703 LISTED SYSTEM") : { listings: [] }));
  const r = await listings.readImageSheetListings(fake.llm, realShaped, realPages, { want: { module: false, racking: true } });
  assert.equal(fake.visionCalls.length, 4);
  assert.deepEqual(r.read, [11, 13, 4, 8]);
  assert.deepEqual(r.readings, [{ page: 8, product: "racking", quote: "UL 2703 LISTED SYSTEM" }]);
  assert.match(r.coverage, /not needed: the missing listings were already found/);
});

await check("(r4) a page whose text reads as a bill or meter record is withheld before it is rendered, and named", async () => {
  const withBill = await planSet([
    { name: "COVER SHEET", text: prose(1, 30) },
    { name: "SITE PLAN", text: prose(2, 30) },
    { image: true, name: "UTILITY BILL" },
    { image: true, name: "RACKING DATA" },
  ]);
  const pages = await pagesOf(withBill);
  const fake = fakeLlm();
  const r = await listings.readImageSheetListings(fake.llm, withBill, pages, { want: { module: true, racking: true } });
  assert.deepEqual(r.imagePages, [3, 4]);
  assert.deepEqual(r.read, [4], "only the racking sheet was sent");
  assert.equal(fake.visionCalls.length, 1);
  assert.deepEqual(r.skipped, [{ page: 3, reason: "withheld: its text reads as a bill or meter record" }]);
  assert.match(r.coverage, /page 3 \(withheld: its text reads as a bill or meter record\)/);
});

await check("(r5) only a quote that names ITS product's listing is kept: wrong product, IEC-only, negated and invented answers drop", () => {
  const raw = { listings: [
    { product: "racking", quote: "UL 2703 LISTED SYSTEM" },                   // kept
    { product: "attachment", quote: "Conforms to UL Subject 2703A" },         // kept
    { product: "module", quote: "UL 61730-1 / UL 61730-2" },                  // kept
    { product: "racking", quote: "for use with modules listed to UL 61730" }, // a module mark, read for the racking
    { product: "module", quote: "IEC 61215 / IEC 61730" },                    // IEC is not the UL listing
    { product: "racking", quote: "NOT UL 2703 LISTED" },                      // negated
    { product: "racking", quote: "" },                                        // no printed words
    { product: "inverter", quote: "UL 1741 SB" },                             // not a product the rule reads
    { product: "racking", quote: "UL 2703A" },                                // the attachment's outline, read as racking
    "UL 2703",                                                                // not an object
  ] };
  assert.deepEqual(listings.acceptedListingReadings(9, raw), [
    { page: 9, product: "racking", quote: "UL 2703 LISTED SYSTEM" },
    { page: 9, product: "attachment", quote: "Conforms to UL Subject 2703A" },
    { page: 9, product: "module", quote: "UL 61730-1 / UL 61730-2" },
  ]);
  // The stub provider's answer, and an unparsed model reply, read as nothing.
  assert.deepEqual(listings.acceptedListingReadings(9, { provider: "stub", confidence: 0, notes: "No ANTHROPIC_API_KEY configured." }), []);
  assert.deepEqual(listings.acceptedListingReadings(9, { provider: "claude-vision", raw: "UL 2703" }), []);
});

await check("(r6) no vision model: nothing is rendered or sent, and the coverage says the image-only sheets were not read", async () => {
  const r = await listings.readImageSheetListings(null, realShaped, realPages, { want: { module: true, racking: true } });
  assert.deepEqual(r.read, []);
  assert.equal(r.skipped.length, 10);
  assert.match(r.coverage, /image-only sheets \(pages 4, 5, 6, 7, 8, 9, 10, 11, 12, 13\) were not read for listing marks/);
  assert.match(r.coverage, /no vision model is configured/);
});

await check("(r7) nothing wanted (the text showed both listings): no page is read and nothing is stated", async () => {
  const fake = fakeLlm();
  const r = await listings.readImageSheetListings(fake.llm, realShaped, realPages, { want: { module: false, racking: false } });
  assert.equal(fake.visionCalls.length, 0);
  assert.equal(r.coverage, "");
});

// ---------------------------------------------------------------------------------------------
// 2. The rule reads the readings
// ---------------------------------------------------------------------------------------------
console.log("2. city.plan.ul-listings-missing with image-sheet readings");

const ruleProject = (snapshot: Record<string, unknown>): ProjectRecord => ({
  id: "image-sheet-listings-test", clientId: "c", state: "OR", ahj: "City of Testport", utility: "Test Power",
  homeownerName: "Test Owner", projectAddress: "1 Test St", interconnectionMethod: "Load-side breaker", status: "pending",
  parserSnapshot: { mounting: "Roof mount", planSetExtractedText: "ROOF MOUNT ARRAY ON RAFTERS. MODULES: SYN-400. INVERTER UL 1741 SB.", ...snapshot },
} as unknown as ProjectRecord);
const profile = (): JurisdictionCodeProfile => ({
  key: "or|city of testport|unknown", state: "OR", ahj: "City of Testport", confidence: "seeded",
  adoptedCodes: [{ code: "ORSC", edition: "2023" }, { code: "OESC", edition: "2023" }, { code: "NEC", edition: "2023" }],
  amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
  researchedAt: "2026-09-01T00:00:00.000Z",
});
const evaluate = (p: ProjectRecord) => rules.evaluateDesignCodeFindings(p, null, buildCodeContext("OR", "City of Testport", profile()), [], []);
const readings = (rs: Array<{ page: number; product: string; quote: string }>, coverage = "Image-only sheets read by vision for listing marks (at most 6 per review): pages 7, 8.") =>
  ({ [rules.IMAGE_SHEET_LISTING_READINGS_KEY]: JSON.stringify(rs), [rules.IMAGE_SHEET_LISTING_COVERAGE_KEY]: coverage });

await check("(u0) control: no readings — both halves missing, the old sentence about image pages stands", () => {
  const f = get(evaluate(ruleProject({})), LISTINGS);
  assert.ok(f);
  assert.match(f.message, /No module listing \(UL 61730 or UL 1703\) or racking\/mounting listing \(UL 2703\) was found in the package text that could be read \(cut sheets whose pages are images are not read\)\./);
});

await check("(u1) a racking reading from an image sheet clears the racking half — and only it; the page is the evidence", () => {
  const f = get(evaluate(ruleProject(readings([{ page: 8, product: "racking", quote: "UL 2703 LISTED SYSTEM" }]))), LISTINGS);
  assert.ok(f, "the module half is still missing");
  assert.match(f.message, /^No module listing \(UL 61730 or UL 1703\) was found in the package text or on the image-only sheets read for listing marks\. Image-only sheets read by vision/);
  assert.doesNotMatch(f.message, /cut sheets whose pages are images are not read/);
  assert.deepEqual(f.evidenceNeeded, ["Module listing (UL 61730 or UL 1703) on the plan set or an attached cut sheet/certificate"]);
  assert.equal(f.evidenceStatus, "weak");
  const ev = f.evidenceFound?.find((e) => e.label === "Listing stated");
  assert.equal(ev?.source, "Plan page 8 (image-only sheet, read by vision)");
  assert.equal(ev?.excerpt, "UL 2703");
});

await check("(u2) both halves read from image sheets: no finding", () => {
  const found = evaluate(ruleProject(readings([
    { page: 7, product: "module", quote: "UL 61730-1 / UL 61730-2" },
    { page: 8, product: "racking", quote: "UL 2703 LISTED SYSTEM" },
  ])));
  assert.equal(get(found, LISTINGS), undefined);
});

await check("(u3) UL 2703A alone (the attachment's flashing listing) is shown, never a pass for the racking", () => {
  const f = get(evaluate(ruleProject(readings([{ page: 9, product: "attachment", quote: "Conforms to UL Subject 2703A" }]))), LISTINGS);
  assert.ok(f);
  assert.match(f.message, /racking\/mounting listing \(UL 2703\)/);
  assert.match(f.message, /A roof-attachment listing \(UL 2703A, Plan page 9 \(image-only sheet, read by vision\)\) was found; it lists the attachment\/flashing, not the racking\/mounting\./);
  assert.equal(f.evidenceStatus, "missing");
  assert.ok(f.evidenceFound?.some((e) => e.kind === "absence_check"), "the absence is still evidence");
  assert.ok(f.evidenceFound?.some((e) => e.label === "Attachment listing (UL 2703A)" && /Plan page 9/.test(e.source)));
});

await check("(u4) a reading counts only for the product it was read for (a module reading's UL 2703 words clear nothing)", () => {
  const f = get(evaluate(ruleProject(readings([{ page: 7, product: "module", quote: "UL 61730 MODULE FOR UL 2703 RACKING" }]))), LISTINGS);
  assert.ok(f);
  assert.match(f.message, /^No racking\/mounting listing \(UL 2703\) was found/);
});

await check("(u5) the readings key is written by the read, not trusted blindly: malformed JSON reads as none", () => {
  const f = get(evaluate(ruleProject({ [rules.IMAGE_SHEET_LISTING_READINGS_KEY]: "{not json" })), LISTINGS);
  assert.ok(f);
  assert.match(f.message, /module listing .* or racking\/mounting listing/);
});

// ---------------------------------------------------------------------------------------------
// 3. The gate, end to end (runStandaloneReview with a fake model)
// ---------------------------------------------------------------------------------------------
console.log("3. runStandaloneReview");

const subject = (fields: Record<string, string> = {}): ReviewSubject => ({
  workType: "solar_pv_residential",
  state: "OR",
  ahj: "City of Testport",
  utility: "Test Power",
  applicant: { name: "Test Owner", address: "1 Example Way", city: "Anytown", zip: "97000" },
  system: { sizeDcKw: 6.4, sizeAcKw: 5, interconnectionMethod: "Load-side breaker" },
  fields: { mounting: "Roof mount", ...fields },
} as unknown as ReviewSubject);
const review = async (pdf: Buffer, llm: unknown) =>
  runStandaloneReview(db, "default", subject(), { buffer: pdf, filename: "set.pdf" }, { llm: llm as LLMProvider });

await check("(e1) RED ON BASE: a plan set whose only UL 2703 evidence is an image page clears the racking half", async () => {
  const pdf = await planSet([
    { name: "COVER SHEET", text: prose(1, 30) },
    { name: "SITE PLAN", text: prose(2, 30) },
    { name: "ELECTRICAL", text: [...prose(3, 20), "INVERTER: SYN-MICRO UL 1741 SB LISTED"] },
    { image: true, name: "PV MODULE SPECIFICATION" },
    { image: true, name: "RACKING DATA" },
    { image: true, name: "MICROINVERTER SPECIFICATION" },
  ]);
  // Read in sheet-name order: module spec (4), racking data (5), microinverter (6). The module
  // sheet prints only IEC marks; the racking sheet prints UL 2703.
  const fake = fakeLlm((n) => (n === 0 ? reading("module", "IEC 61215 / IEC 61730") : n === 1 ? reading("racking", "UL 2703 LISTED SYSTEM") : { listings: [] }));
  const { report } = await review(pdf, fake.llm);
  const f = get(report.findings, LISTINGS);
  assert.ok(f, "the module half is still missing (IEC is not the UL listing)");
  assert.match(f.message, /^No module listing \(UL 61730 or UL 1703\) was found in the package text or on the image-only sheets read for listing marks\./);
  assert.doesNotMatch(f.message, /racking\/mounting listing \(UL 2703\)/, "the racking half is cleared");
  assert.match(f.message, /pages 4, 5, 6\./);
  assert.equal(f.evidenceFound?.find((e) => e.label === "Listing stated")?.source, "Plan page 5 (image-only sheet, read by vision)");
  assert.equal(fake.visionCalls.length, 3);
  assert.ok(fake.visionCalls.every((c) => c.prompt === listings.SHEET_LISTING_VISION_PROMPT), "rule 2: the constant prompt only");
});

await check("(e2) RED ON BASE: a listing on a text page past character 20,000 counts — no vision call — and the AI prompt's text stays capped", async () => {
  const sheets: Sheet[] = Array.from({ length: 9 }, (_, k) => ({ name: `PLAN SHEET ${k + 1}`, text: prose(k + 1, 50) }));
  sheets.push({ name: "EQUIPMENT NOTES", text: ["PV MODULES: SYN-400, LISTED TO UL 61730.", "RACKING: SYN-RAIL SYSTEM, LISTED TO UL 2703.", ...prose(10, 10)] });
  const pdf = await planSet(sheets);
  const full = (await pagesOf(pdf)).join("\n");
  assert.ok(full.indexOf("UL 2703") > REVIEW_AI_TEXT_CHARS && full.indexOf("UL 61730") > REVIEW_AI_TEXT_CHARS, `fixture: the listings sit past character ${REVIEW_AI_TEXT_CHARS} (at ${full.indexOf("UL 61730")})`);
  const fake = fakeLlm();
  const { report } = await review(pdf, fake.llm);
  assert.equal(get(report.findings, LISTINGS), undefined, "both listings read from the back of the text");
  assert.equal(fake.visionCalls.length, 0, "the text showed both: no image read is paid for");
  assert.equal(fake.aiCalls.length, 1);
  assert.ok(fake.aiCalls[0].extractedText.length <= REVIEW_AI_TEXT_CHARS, "the AI second opinion's text is still capped — nothing new sent");
  assert.doesNotMatch(fake.aiCalls[0].extractedText, /UL 2703/);
});

await check("(e3) no vision model (stub provider): the report says the image-only sheets were not read, and the racking half stays", async () => {
  const pdf = await planSet([
    { name: "COVER SHEET", text: prose(1, 30) },
    { name: "SITE PLAN", text: prose(2, 30) },
    { name: "ELECTRICAL", text: prose(3, 30) },
    { image: true, name: "RACKING DATA" },
  ]);
  const { report } = await review(pdf, new StubLLMProvider());
  const f = get(report.findings, LISTINGS);
  assert.ok(f);
  assert.match(f.message, /racking\/mounting listing \(UL 2703\)/);
  assert.match(f.message, /The plan set's image-only sheets \(page 4\) were not read for listing marks\. Not read: page 4 \(no vision model is configured\)\./);
});

await check(`(e4) RED ON BASE: a set longer than the ${REVIEW_TEXT_MAX_PAGES}-page text cap names the pages it did not read`, async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const total = REVIEW_TEXT_MAX_PAGES + 3;
  for (let i = 1; i <= total; i++) doc.addPage([612, 792]).drawText(`SHEET ${i} ROOF MOUNT NOTE ${i * 7}`, { x: 40, y: 700, size: 12, font });
  const { report } = await review(Buffer.from(await doc.save()), fakeLlm().llm);
  const f = get(report.findings, "reviewer.plan.text-pages-not-read");
  assert.ok(f, "the unread pages are on the report");
  assert.equal(f.severity, "callout");
  assert.match(f.message, new RegExp(`The plan set has ${total} pages; the text checks read pages 1–${REVIEW_TEXT_MAX_PAGES}\\. Pages ${REVIEW_TEXT_MAX_PAGES + 1}–${total} were not read`));
});

await check("(e5) a set inside the cap carries no unread-pages finding", async () => {
  const pdf = await planSet([{ name: "COVER SHEET", text: prose(1, 10) }, { name: "SITE PLAN", text: prose(2, 10) }]);
  const { report } = await review(pdf, fakeLlm().llm);
  assert.equal(get(report.findings, "reviewer.plan.text-pages-not-read"), undefined);
});

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) { console.error(`\n${failures} imageSheetListings test(s) failed.`); process.exit(1); }
process.exit(0);
