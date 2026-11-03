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
//   1. the reader: title-block-only pages (a picture OR a vector drawing — the test is the text
//      layer alone), ordered by sheet name then picture-first, capped (and the cap stated), early
//      stop, a bill/meter page withheld, a quote that does not name its product's listing dropped,
//      the prompt a constant (rule 2), no vision model = nothing rendered and the report says so;
//      what the coverage says when nothing could be tested or nothing qualified — never "the text
//      layer was the whole read" (a raster count or a render that fails is said, not hidden);
//   2. the rule: a racking reading clears the racking half only; UL 2703A (attachment) is shown,
//      never a pass; the coverage statement replaces "cut sheets whose pages are images are not read";
//   3. the gate end to end (runStandaloneReview): an image page — or a vector-drawn certificate — as
//      the ONLY UL 2703 evidence clears the racking half; a listing on a text page past character
//      20,000 counts with no vision call while the AI prompt's text stays capped; a set longer than
//      the page cap names its unread pages (counted by pdf.js); a set whose text cannot be extracted
//      says no page was read.
// Fails without the fix: with the base gate (reviewSubject.ts) e0-e4 fail — the image page is never
// read, the text past character 20,000 is never read, no page is named as unread; with the base
// rule's reading (text and module datasheet only) u1-u4, e1 and e3 fail. Against the first cut of
// this fix (3beef7c9: image-only = a large raster, and "No sheet of the plan set is image-only, so
// its text layer was the whole read") r8, r10, r11, r12, e7, e8 and e9 fail.
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
const reviewSubjectModule = await import("../src/reviewSubject");
const { runStandaloneReview } = reviewSubjectModule;
// The two caps, as numbers (the fixtures are sized against them; (e0) pins the module's values).
const AI_TEXT_CHARS = 20_000;
const TEXT_PAGE_CAP = 200;
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

type Sheet = { text: string[]; name: string } | { image: true; name: string } | { vector: true; name: string };
const FILLER = ["CONDUCTOR", "BREAKER", "RAFTER", "SETBACK", "AZIMUTH", "BUSBAR"];
/** `count` lines of plan prose for sheet `i`, varied so no line repeats across sheets. */
const prose = (i: number, count: number): string[] =>
  Array.from({ length: count }, (_, r) => `SHEET ${i} NOTE ${r}: ${FILLER[r % 6]} ${i * 100 + r} PER DETAIL ${i}-${r} ROOF MOUNT ARRAY ON RAFTERS AT ${16 + (r % 3) * 8} IN OC`);

/** A plan set of 11x17 sheets, each with the same title block; image sheets are a large raster
 *  carrying only the title block and the sheet's name as text (a cut sheet pasted in as a picture);
 *  vector sheets carry the same text and NO raster — their content is drawn as rectangles and lines
 *  (a certificate exported as outlines). */
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
    } else if ("vector" in sheet) {
      p.drawRectangle({ x: 30, y: 60, width: 1100, height: 700, borderWidth: 2 });
      for (let y = 100; y < 740; y += 30) p.drawRectangle({ x: 60, y, width: 200 + ((y * 7) % 700), height: 12 });
    } else {
      sheet.text.forEach((line, r) => p.drawText(line, { x: 40, y: 750 - r * 13, size: 9, font }));
    }
  });
  return Buffer.from(await doc.save());
}

/** The per-page text the gate extracts (written to a temp file: the extractor reads a path). */
async function pagesOf(pdf: Buffer): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-test-isl-"));
  try {
    const f = path.join(dir, "set.pdf");
    fs.writeFileSync(f, pdf);
    return await extractPdfPages(f, 400);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  assert.deepEqual(listings.titleBlockOnlyPages(realPages), [4, 5, 6, 7, 8, 9, 10, 11, 12, 13], "the reader's own test (text only) finds the same pages");
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
  assert.deepEqual(r.titleBlockOnlyPages, [3, 4]);
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

await check("(r6) no vision model: nothing is rendered or sent, and the coverage says the title-block-only sheets were not read", async () => {
  const r = await listings.readImageSheetListings(null, realShaped, realPages, { want: { module: true, racking: true } });
  assert.deepEqual(r.read, []);
  assert.equal(r.skipped.length, 10);
  assert.match(r.coverage, /title-block-only sheets \(pages 4, 5, 6, 7, 8, 9, 10, 11, 12, 13\) were not read for listing marks/);
  assert.match(r.coverage, /no vision model is configured/);
});

await check("(r7) nothing wanted (the text showed both listings): no page is read and nothing is stated", async () => {
  const fake = fakeLlm();
  const r = await listings.readImageSheetListings(fake.llm, realShaped, realPages, { want: { module: false, racking: false } });
  assert.equal(fake.visionCalls.length, 0);
  assert.equal(r.coverage, "");
});

// A certificate exported as vector art / outlined text: the title block is its only text and it
// paints NO raster. A "large raster" test skipped it — and then said the set had no image page.
const withVector = await planSet([
  { name: "COVER SHEET", text: prose(1, 30) },
  { name: "SITE PLAN", text: prose(2, 30) },
  { name: "ELECTRICAL", text: prose(3, 30) },
  { vector: true, name: "RACKING UL CERTIFICATE" },
  { image: true, name: "PV MODULE SPECIFICATION" },
]);
const vectorPages = await pagesOf(withVector);

await check("(r8) a title-block-only sheet with NO raster (vector art) is a candidate and is read", async () => {
  const { rasterPixelsPerPage } = await import("../src/scannedPlanSet");
  const raster = await rasterPixelsPerPage(withVector);
  assert.equal(raster[3], 0, "fixture: the vector sheet paints no raster");
  const fake = fakeLlm((n) => (n === 0 ? reading("racking", "LISTED TO UL 2703") : { listings: [] }));
  const r = await listings.readImageSheetListings(fake.llm, withVector, vectorPages, { want: { module: false, racking: true } });
  assert.deepEqual(r.read, [4], "the vector certificate (listing + product words) is read first, and answers");
  assert.deepEqual(r.titleBlockOnlyPages, [4, 5]);
  assert.deepEqual(r.readings, [{ page: 4, product: "racking", quote: "LISTED TO UL 2703" }]);
  assert.doesNotMatch(r.coverage, /whole read/);
});

await check("(r9) the raster count failing loses only the order's tie-break: every title-block-only page stays a candidate", async () => {
  const fake = fakeLlm();
  const r = await listings.readImageSheetListings(fake.llm, withVector, vectorPages, {
    want: { module: true, racking: true },
    countRaster: async () => { throw new Error("injected: raster count failed"); },
  });
  assert.deepEqual(r.titleBlockOnlyPages, [4, 5]);
  assert.deepEqual([...r.read].sort(), [4, 5], "both read although the raster count failed");
  assert.equal(fake.visionCalls.length, 2);
  assert.match(r.coverage, /^Title-block-only sheets \(pictures, or drawings with no text of their own\) read by vision for listing marks \(at most 6 per review\): pages 4, 5\.$/);
});

await check("(r10) bytes no parser can open (the raster count AND the render fail): the pages are named as not read, never 'no image page'", async () => {
  // The skeptic's probe: the extracted text of a real set, with bytes neither pdf-lib nor pdf.js opens.
  const fake = fakeLlm();
  const r = await listings.readImageSheetListings(fake.llm, Buffer.from("%PDF-1.7 truncated, not a document"), realPages, { want: { module: true, racking: true } });
  assert.equal(fake.visionCalls.length, 0);
  assert.doesNotMatch(r.coverage, /whole read|No sheet/i, r.coverage);
  assert.deepEqual(r.titleBlockOnlyPages, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13], "candidates come from the text, which was read");
  assert.match(r.coverage, /^The plan set's title-block-only sheets \(pages 4, 5, 6, 7, 8, 9, 10, 11, 12, 13\) were not read for listing marks\./);
  assert.match(r.coverage, /the plan set could not be rendered/);
  assert.match(r.coverage, /over the 6-page cap/, "the cap is still applied and named");
});

await check("(r11) no title-block-only sheet: the coverage states the test that was run and what it leaves unread — never 'the whole read'", async () => {
  const allText = await planSet([
    { name: "COVER SHEET", text: prose(1, 30) },
    { name: "SITE PLAN", text: prose(2, 30) },
    { name: "ELECTRICAL", text: prose(3, 30) },
  ]);
  const fake = fakeLlm();
  const r = await listings.readImageSheetListings(fake.llm, allText, await pagesOf(allText), { want: { module: true, racking: true } });
  assert.equal(fake.visionCalls.length, 0);
  assert.doesNotMatch(r.coverage, /whole read/);
  assert.equal(r.coverage, "No sheet was sent to vision for listing marks: every sheet's text layer held 150 or more letters and digits beyond the title block the sheets share, and only title-block-only sheets (pictures, or drawings with no text of their own) are read that way. A listing printed inside a picture on a sheet that also carries text is not read.");
});

await check("(r12) under 3 sheets the title block cannot be told apart: the coverage says the whole text was tested", async () => {
  const two = await planSet([{ name: "COVER SHEET", text: prose(1, 20) }, { name: "SITE PLAN", text: prose(2, 20) }]);
  const r = await listings.readImageSheetListings(fakeLlm().llm, two, await pagesOf(two), { want: { module: true, racking: true } });
  assert.match(r.coverage, /^No sheet was sent to vision for listing marks: with fewer than 3 sheets the title block cannot be told apart from a sheet's own text, and every sheet's whole text layer held 150 or more letters and digits\. A listing printed inside a picture on a sheet that also carries text is not read\.$/);
});

await check("(r13) order: at an equal sheet-name score a page that paints a large picture goes first; unknown raster = page order", () => {
  // PV MODULE SPECIFICATION (4) and RACKING DATA (8) both score 2 by name.
  const raster = Array.from({ length: realPages.length }, (_, i) => (i === 3 ? 0 : 2_000_000));
  assert.deepEqual(listings.orderListingCandidates([4, 8], realPages, raster), [8, 4]);
  assert.deepEqual(listings.orderListingCandidates([4, 8], realPages, null), [4, 8]);
  // The name still wins over the picture: ATTACHMENT UL CERTIFICATE (13) with no raster before RACKING DATA (8).
  const no13 = raster.map((v, i) => (i === 12 ? 0 : v));
  assert.deepEqual(listings.orderListingCandidates([8, 13], realPages, no13), [13, 8]);
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
const readings = (rs: Array<{ page: number; product: string; quote: string }>, coverage = "Title-block-only sheets (pictures, or drawings with no text of their own) read by vision for listing marks (at most 6 per review): pages 7, 8.") =>
  ({ [rules.IMAGE_SHEET_LISTING_READINGS_KEY]: JSON.stringify(rs), [rules.IMAGE_SHEET_LISTING_COVERAGE_KEY]: coverage });

await check("(u0) control: no readings — both halves missing, the old sentence about image pages stands", () => {
  const f = get(evaluate(ruleProject({})), LISTINGS);
  assert.ok(f);
  assert.match(f.message, /No module listing \(UL 61730 or UL 1703\) or racking\/mounting listing \(UL 2703\) was found in the package text that could be read \(cut sheets whose pages are images are not read\)\./);
});

await check("(u1) a racking reading from an image sheet clears the racking half — and only it; the page is the evidence", () => {
  const f = get(evaluate(ruleProject(readings([{ page: 8, product: "racking", quote: "UL 2703 LISTED SYSTEM" }]))), LISTINGS);
  assert.ok(f, "the module half is still missing");
  assert.match(f.message, /^No module listing \(UL 61730 or UL 1703\) was found in the package text or on any title-block-only sheet read by vision\. Title-block-only sheets \(pictures, or drawings with no text of their own\) read by vision/);
  assert.doesNotMatch(f.message, /cut sheets whose pages are images are not read/);
  assert.deepEqual(f.evidenceNeeded, ["Module listing (UL 61730 or UL 1703) on the plan set or an attached cut sheet/certificate"]);
  assert.equal(f.evidenceStatus, "weak");
  const ev = f.evidenceFound?.find((e) => e.label === "Listing stated");
  assert.equal(ev?.source, "Plan page 8 (title-block-only sheet, read by vision)");
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
  assert.match(f.message, /A roof-attachment listing \(UL 2703A, Plan page 9 \(title-block-only sheet, read by vision\)\) was found; it lists the attachment\/flashing, not the racking\/mounting\./);
  assert.equal(f.evidenceStatus, "missing");
  assert.ok(f.evidenceFound?.some((e) => e.kind === "absence_check"), "the absence is still evidence");
  assert.ok(f.evidenceFound?.some((e) => e.label === "Attachment listing (UL 2703A)" && /Plan page 9/.test(e.source)));
});

await check("(u4) a reading counts only for the product it was read for (a module reading's UL 2703 words clear nothing)", () => {
  const f = get(evaluate(ruleProject(readings([{ page: 7, product: "module", quote: "UL 61730 MODULE FOR UL 2703 RACKING" }]))), LISTINGS);
  assert.ok(f);
  assert.match(f.message, /^No racking\/mounting listing \(UL 2703\) was found/);
});

await check("(u6) one suffix test splits UL 2703 (racking) from UL 2703A (attachment): hyphen and spaced capital A are the attachment's, the article 'a' is not", () => {
  const racking = (t: string) => rules.listingAffirmed("racking", t);
  const attachment = (t: string) => rules.listingAffirmed("attachment", t);
  for (const t of ["UL 2703A", "UL 2703-A", "UL 2703 A", "UL SUBJECT 2703A:2022", "ul subject 2703a", "UL Subject 2703 - A"]) {
    assert.equal(attachment(t), true, `attachment: ${t}`);
    assert.equal(racking(t), false, `never the racking's: ${t}`);
  }
  for (const t of ["UL 2703", "ul 2703 listed", "UL 2703 a listed system", "UL 2703 AND UL 61730", "UL-2703 (2023)", "UL2703"]) {
    assert.equal(racking(t), true, `racking: ${t}`);
    assert.equal(attachment(t), false, `not an attachment listing: ${t}`);
  }
});

await check("(u7) in the package text: 'UL 2703-A' alone never clears the racking half; 'UL 2703 a listed system' adds no attachment row", () => {
  const hyphen = get(evaluate(ruleProject({ planSetExtractedText: "ROOF MOUNT ARRAY ON RAFTERS. FLASHING: SYN-FOOT, LISTED TO UL 2703-A. MODULES LISTED TO UL 61730." })), LISTINGS);
  assert.ok(hyphen, "the racking half is still missing");
  assert.match(hyphen.message, /^No racking\/mounting listing \(UL 2703\) was found/);
  assert.match(hyphen.message, /A roof-attachment listing \(UL 2703A, .*\) was found/);
  const article = evaluate(ruleProject({ planSetExtractedText: "ROOF MOUNT ARRAY ON RAFTERS. RACKING: SYN-RAIL, UL 2703 a listed system. MODULES LISTED TO UL 61730." }));
  assert.equal(get(article, LISTINGS), undefined, "the racking listing is read and both halves clear");
  assert.equal(rules.packageListings(ruleProject({ planSetExtractedText: "RACKING: SYN-RAIL, UL 2703 a listed system." })).attachment, null, "no spurious attachment listing");
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

await check("(e0) the caps: the AI second opinion keeps 20,000 characters; the text checks read up to 200 pages", () => {
  const caps = reviewSubjectModule as unknown as { REVIEW_AI_TEXT_CHARS?: number; REVIEW_TEXT_MAX_PAGES?: number };
  assert.equal(caps.REVIEW_AI_TEXT_CHARS, AI_TEXT_CHARS);
  assert.equal(caps.REVIEW_TEXT_MAX_PAGES, TEXT_PAGE_CAP);
});

await check("(e1) RED ON BASE: a plan set whose only UL 2703 evidence is an image page clears the racking half", async () => {
  const pdf = await planSet([
    { name: "COVER SHEET", text: prose(1, 30) },
    { name: "SITE PLAN", text: prose(2, 30) },
    { name: "ELECTRICAL", text: [...prose(3, 30), "INVERTER: SYN-MICRO UL 1741 SB LISTED"] },
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
  assert.match(f.message, /^No module listing \(UL 61730 or UL 1703\) was found in the package text or on any title-block-only sheet read by vision\./);
  assert.doesNotMatch(f.message, /racking\/mounting listing \(UL 2703\)/, "the racking half is cleared");
  assert.match(f.message, /pages 4, 5, 6\./);
  assert.equal(f.evidenceFound?.find((e) => e.label === "Listing stated")?.source, "Plan page 5 (title-block-only sheet, read by vision)");
  assert.equal(fake.visionCalls.length, 3);
  assert.ok(fake.visionCalls.every((c) => c.prompt === listings.SHEET_LISTING_VISION_PROMPT), "rule 2: the constant prompt only");
});

await check("(e2) RED ON BASE: a listing on a text page past character 20,000 counts — no vision call — and the AI prompt's text stays capped", async () => {
  const sheets: Sheet[] = Array.from({ length: 9 }, (_, k) => ({ name: `PLAN SHEET ${k + 1}`, text: prose(k + 1, 50) }));
  sheets.push({ name: "EQUIPMENT NOTES", text: ["PV MODULES: SYN-400, LISTED TO UL 61730.", "RACKING: SYN-RAIL SYSTEM, LISTED TO UL 2703.", ...prose(10, 10)] });
  const pdf = await planSet(sheets);
  const full = (await pagesOf(pdf)).join("\n");
  assert.ok(full.indexOf("UL 2703") > AI_TEXT_CHARS && full.indexOf("UL 61730") > AI_TEXT_CHARS, `fixture: the listings sit past character ${AI_TEXT_CHARS} (at ${full.indexOf("UL 61730")})`);
  const fake = fakeLlm();
  const { report } = await review(pdf, fake.llm);
  assert.equal(get(report.findings, LISTINGS), undefined, "both listings read from the back of the text");
  assert.equal(fake.visionCalls.length, 0, "the text showed both: no image read is paid for");
  assert.equal(fake.aiCalls.length, 1);
  assert.ok(fake.aiCalls[0].extractedText.length <= AI_TEXT_CHARS, "the AI second opinion's text is still capped — nothing new sent");
  assert.doesNotMatch(fake.aiCalls[0].extractedText, /UL 2703/);
});

await check("(e3) no vision model (stub provider): the report says the title-block-only sheets were not read, and the racking half stays", async () => {
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
  assert.match(f.message, /The plan set's title-block-only sheets \(page 4\) were not read for listing marks\. Not read: page 4 \(no vision model is configured\)\./);
});

await check(`(e4) RED ON BASE: a set longer than the ${TEXT_PAGE_CAP}-page text cap names the pages it did not read`, async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const total = TEXT_PAGE_CAP + 3;
  for (let i = 1; i <= total; i++) doc.addPage([612, 792]).drawText(`SHEET ${i} ROOF MOUNT NOTE ${i * 7}`, { x: 40, y: 700, size: 12, font });
  const { report } = await review(Buffer.from(await doc.save()), fakeLlm().llm);
  const f = get(report.findings, "reviewer.plan.text-pages-not-read");
  assert.ok(f, "the unread pages are on the report");
  assert.equal(f.severity, "callout");
  assert.match(f.message, new RegExp(`The plan set has ${total} pages; the text checks read pages 1–${TEXT_PAGE_CAP}\\. Pages ${TEXT_PAGE_CAP + 1}–${total} were not read`));
});

await check("(e5) a set inside the cap carries no unread-pages finding", async () => {
  const pdf = await planSet([{ name: "COVER SHEET", text: prose(1, 10) }, { name: "SITE PLAN", text: prose(2, 10) }]);
  const { report } = await review(pdf, fakeLlm().llm);
  assert.equal(get(report.findings, "reviewer.plan.text-pages-not-read"), undefined);
});

await check("(e6) a caller cannot hand the gate its own 'vision readings': only the read writes them", async () => {
  const forged = { [rules.IMAGE_SHEET_LISTING_READINGS_KEY]: JSON.stringify([{ page: 1, product: "racking", quote: "UL 2703" }]), [rules.IMAGE_SHEET_LISTING_COVERAGE_KEY]: "Every sheet was read." };
  const { report } = await runStandaloneReview(db, "default", subject({ ...forged, splitPagesText: "ROOF MOUNT ARRAY ON RAFTERS. MODULES LISTED TO UL 61730." }), undefined, { llm: fakeLlm().llm as unknown as LLMProvider });
  const f = get(report.findings, LISTINGS);
  assert.ok(f, "the racking half is still missing");
  assert.match(f.message, /^No racking\/mounting listing \(UL 2703\) was found in the package text that could be read/);
  assert.doesNotMatch(f.message, /Every sheet was read/);
});

await check("(e7) a plan set whose only UL 2703 evidence is a VECTOR-drawn certificate (no raster) clears the racking half", async () => {
  const pdf = await planSet([
    { name: "COVER SHEET", text: prose(1, 30) },
    { name: "SITE PLAN", text: prose(2, 30) },
    { name: "ELECTRICAL", text: [...prose(3, 30), "INVERTER: SYN-MICRO UL 1741 SB LISTED"] },
    { vector: true, name: "RACKING UL CERTIFICATE" },
  ]);
  const fake = fakeLlm((n) => (n === 0 ? reading("racking", "UL 2703 LISTED SYSTEM") : { listings: [] }));
  const { report } = await review(pdf, fake.llm);
  const f = get(report.findings, LISTINGS);
  assert.ok(f, "the module half is still missing");
  assert.doesNotMatch(f.message, /racking\/mounting listing \(UL 2703\)/, "the racking half is cleared by the vector sheet");
  assert.doesNotMatch(f.message, /whole read/);
  assert.equal(f.evidenceFound?.find((e) => e.label === "Listing stated")?.source, "Plan page 4 (title-block-only sheet, read by vision)");
  assert.equal(fake.visionCalls.length, 1);
});

await check("(e8) a plan set whose text cannot be extracted: the report says no page was read", async () => {
  const { report } = await review(Buffer.from("%PDF-1.7 truncated, not a document"), fakeLlm().llm);
  const f = get(report.findings, "reviewer.plan.text-pages-not-read");
  assert.ok(f, "the unread plan set is on the report");
  assert.equal(f.title, "Plan set text not read");
  assert.match(f.message, /could not be extracted, so the text checks read none of its pages/);
});

await check("(e9) a set with no title-block-only sheet: the finding says what was tested, not that the text was the whole read", async () => {
  const pdf = await planSet([
    { name: "COVER SHEET", text: prose(1, 30) },
    { name: "SITE PLAN", text: prose(2, 30) },
    { name: "ELECTRICAL", text: prose(3, 30) },
  ]);
  const fake = fakeLlm();
  const { report } = await review(pdf, fake.llm);
  const f = get(report.findings, LISTINGS);
  assert.ok(f);
  assert.equal(fake.visionCalls.length, 0);
  assert.doesNotMatch(f.message, /whole read/);
  assert.match(f.message, /No sheet was sent to vision for listing marks: every sheet's text layer held 150 or more letters and digits beyond the title block the sheets share.*A listing printed inside a picture on a sheet that also carries text is not read\./);
});

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) { console.error(`\n${failures} imageSheetListings test(s) failed.`); process.exit(1); }
process.exit(0);
