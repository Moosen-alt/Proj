// "VERIFY FILL WITH VISION" (issue #428): the read-back compares what vision reads on each filled
// page with what the fill intended, one call per page with a value, labels only in the prompt
// (hard rule 2), never a page that prints a secret field, and it never changes the form (rule 4).
// The vision model is a local fake: no network, no key.
//
//   npx tsx backend/test/formFillVision.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { autoFillByFieldName } from "../src/formFiller";
import { compareReadBack, fillVerifyPrompt, intendedFromAcroForm, sameLabel, verifyFilledForm, fillReportMarkdown } from "../src/formFillVision";

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures");
const ROW = {
  name: "Jordan Samplehouse", street: "1428 Example Ave", city: "Sampleton", state: "OR", zip: "97999",
  installer: "Example Solar Co LLC", mailingAddress: "500 Vendor Way", phone: "(555) 010-4280", email: "permits@example-solar.test",
};

await check("verdicts: right, wrong box (same caption, other section), missing, clipped, overlapping print, not intended", () => {
  const intended = [
    { page: 0, label: "PROPERTY OWNER - Name:", value: "Jordan Samplehouse" },
    { page: 0, label: "CONTRACTOR - Phone:", value: "(555) 010-4280" },
    { page: 0, label: "CONTRACTOR - E-mail:", value: "permits@example-solar.test" },
    { page: 0, label: "JOB SITE - City/State/ZIP:", value: "Sampleton, OR 97999" },
    { page: 0, label: "Job site address:", value: "1428 Example Ave" },
  ];
  const { rows, unexpected } = compareReadBack(0, intended, [
    { label: "PROPERTY OWNER - Name", value: "Jordan Samplehouse", overlapsPrint: false, clipped: false },
    { label: "PROPERTY OWNER - Phone", value: "(555) 010-4280", overlapsPrint: false, clipped: false },
    { label: "City/State/Zip", value: "Sampleton, OR", overlapsPrint: false, clipped: false },
    { label: "Job site address", value: "1428 Example Ave", overlapsPrint: true, clipped: false },
    { label: "Permit #", value: "B-2026-0001", overlapsPrint: false, clipped: false },
  ]);
  assert.deepEqual(rows.map((r) => r.verdict), ["right", "wrong box", "missing", "clipped", "overlapping print"]);
  assert.equal(rows[1].readUnder, "PROPERTY OWNER - Phone");
  assert.deepEqual(unexpected.map((u) => u.read), ["B-2026-0001"]);
  assert.equal(sameLabel("CONTRACTOR INFORMATION - E-mail:", "Contractor information - Email"), true);
  assert.equal(sameLabel("Phone:", "PROPERTY OWNER - Phone"), true, "no section on one side: the caption decides");
});

await check("one vision call per filled page, the prompt carries printed labels and never a filled value (rule 2)", async () => {
  const filled = (await autoFillByFieldName(new Uint8Array(fs.readFileSync(path.join(FIXTURES, "marion-e-01.pdf"))), ROW)).filled;
  const intended = await intendedFromAcroForm(filled);
  assert.ok(intended.some((r) => r.label === "CONTRACTOR INFORMATION - Phone:" && r.value === ROW.phone), JSON.stringify(intended));
  const calls: Array<{ prompt: string; imageBase64: string; mimeType: string }> = [];
  const fake = {
    async visionExtract(input: { imageBase64: string; mimeType: "image/png" | "image/jpeg" | "image/webp"; prompt: string }) {
      calls.push(input);
      return { entries: intended.map((r) => ({ label: r.label, value: r.value, overlapsPrint: false, clipped: false })) };
    },
  };
  const before = Buffer.from(filled).toString("base64");
  const report = await verifyFilledForm(fake, filled, intended);
  assert.equal(calls.length, 1, "Marion E-01 is one page");
  assert.equal(report.calls, 1);
  assert.equal(calls[0].mimeType, "image/jpeg");
  assert.ok(calls[0].imageBase64.length > 10_000, "a rendered page image");
  // (the two-letter state is a printed word on the form too — "OR" in "OREGON" — so it is not a tell)
  for (const v of Object.values(ROW).filter((x) => x.length > 2)) assert.ok(!calls[0].prompt.includes(v), `prompt must not carry "${v}"`);
  assert.ok(calls[0].prompt.includes("Business name"), "printed labels are offered");
  assert.ok(report.rows.length === intended.length && report.rows.every((r) => r.verdict === "right"), JSON.stringify(report.rows));
  assert.equal(Buffer.from(filled).toString("base64"), before, "the caller's PDF is never changed (rule 4)");
  assert.match(fillReportMarkdown("marion-e-01", report), /\| 1 \| CONTRACTOR INFORMATION - Phone: \| \(555\) 010-4280 \|/);
});

await check("a page that prints an account or meter field is never sent; a page with no value costs no call", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p0 = doc.addPage([612, 792]);
  p0.drawText("Utility account number:", { x: 40, y: 700, size: 10, font });
  p0.drawText("Jordan Samplehouse", { x: 160, y: 700, size: 10, font });
  doc.addPage([612, 792]); // page 2 — nothing filled
  const p2 = doc.addPage([612, 792]);
  p2.drawText("Owner name:", { x: 40, y: 700, size: 10, font });
  p2.drawText("Jordan Samplehouse", { x: 120, y: 700, size: 10, font });
  const bytes = await doc.save();
  let calls = 0;
  const fake = { async visionExtract() { calls++; return { entries: [{ label: "Owner name", value: "Jordan Samplehouse" }] }; } };
  const report = await verifyFilledForm(fake, bytes, [
    { page: 0, label: "Utility account number:", value: "Jordan Samplehouse" },
    { page: 2, label: "Owner name:", value: "Jordan Samplehouse" },
  ]);
  assert.equal(calls, 1, "only page 3 is sent");
  assert.deepEqual(report.checkedPages, [2]);
  assert.equal(report.skippedPages[0].page, 0);
  assert.match(report.skippedPages[0].reason, /never goes to a model/);
  assert.deepEqual(report.rows.map((r) => r.verdict), ["not checked", "right"]);
});

await check("no vision model on this install: nothing is checked, and the table says so", async () => {
  const filled = (await autoFillByFieldName(new Uint8Array(fs.readFileSync(path.join(FIXTURES, "bcd-5952-2024.pdf"))), ROW)).filled;
  const report = await verifyFilledForm({ async visionExtract() { return { provider: "stub", confidence: 0 }; } }, filled, await intendedFromAcroForm(filled));
  assert.equal(report.calls, 0);
  assert.ok(report.rows.length > 0 && report.rows.every((r) => r.verdict === "not checked"));
  assert.match(report.skippedPages[0].reason, /no vision model/);
});

await check("the prompt is the instruction plus the page's labels, deduplicated and bounded", () => {
  const p = fillVerifyPrompt(["Name:", "Name:", "Phone:"]);
  assert.equal((p.match(/"Name:"/g) ?? []).length, 1);
  assert.ok(fillVerifyPrompt(Array.from({ length: 200 }, (_, i) => `Label ${i}`)).split('"Label ').length - 1 <= 60);
});

console.log(`\nformFillVision: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
