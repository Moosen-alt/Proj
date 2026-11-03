// Fill AHJ blanks the way the Form Filler tool does, then read every filled page back with vision
// and print one table per form (issue #428): printed label, intended value, what vision read, under
// which label, verdict (right / wrong box / missing / clipped / overlapping print).
//
//   npx tsx scripts/verify-form-fill.ts                      # the repo's public sample blanks
//   npx tsx scripts/verify-form-fill.ts my-ahj-form.pdf ...  # any AHJ blank you downloaded
//   npx tsx scripts/verify-form-fill.ts --data row.json --out .probe/form-fill a.pdf
//
// --data   a JSON object of Form Filler keys (name, street, city, state, zip, date, installer,
//          mailingAddress, phone, email, permitNumber). Default: one SYNTHETIC row — never a real
//          customer. Never put an account or meter number in it.
// --out    where the filled PDFs and report.md go (default .probe/verify-form-fill, git-ignored).
// --no-vision  fill and write the PDFs + the intended table only (no model call).
//
// Cost: one vision call per page that carries a value, only when this is run. Needs
// ANTHROPIC_API_KEY; without it every page is listed as not checked and nothing is sent.
// Nothing here writes a template, a map or the database: it reports (hard rule 4).
import fs from "node:fs";
import path from "node:path";
import { autoFillByFieldName, listAcroFields, overlayText } from "../backend/src/formFiller";
import { autoPlaceFromData, extractLabels, hasTextLayer } from "../backend/src/formTextLayer";
import { fillReportMarkdown, intendedFromAcroForm, verifyFilledForm, type FillVerifyReport, type IntendedValue } from "../backend/src/formFillVision";
import { createLLMProvider } from "../backend/src/llm";

const SAMPLE = [
  "tigard-building.pdf", "tigard-electrical.pdf", "coos-electrical.pdf", "marion-b-01s.pdf", "marion-e-01.pdf",
  "bcd-5952-2024.pdf", "valencia-multi-purpose-permit-application.pdf", "yamhill-building-application.pdf", "abq-eplan-application.pdf",
].map((f) => path.join("backend", "test", "fixtures", f));

const SYNTHETIC_ROW: Record<string, string> = {
  name: "Jordan Samplehouse", permitNumber: "TEST-428-001", street: "1428 Example Ave", city: "Sampleton", state: "OR", zip: "97999",
  date: "10/31/2026", installer: "Example Solar Co LLC", mailingAddress: "500 Vendor Way", phone: "(555) 010-4280", email: "permits@example-solar.test",
};

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = (name: string): boolean => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const dataPath = opt("--data");
const outDir = opt("--out") ?? path.join(".probe", "verify-form-fill");
const noVision = flag("--no-vision");
const files = args.length ? args : SAMPLE;
const row = dataPath ? JSON.parse(fs.readFileSync(dataPath, "utf8")) as Record<string, string> : SYNTHETIC_ROW;
fs.mkdirSync(outDir, { recursive: true });

const llm = createLLMProvider();
const sections: string[] = [`# Form Filler read-back — ${new Date().toISOString().slice(0, 16)}Z`, ""];
for (const file of files) {
  const blank = new Uint8Array(fs.readFileSync(file));
  let filled: Uint8Array;
  let intended: IntendedValue[];
  if ((await listAcroFields(blank)).length) {
    filled = (await autoFillByFieldName(blank, row)).filled;
    intended = await intendedFromAcroForm(filled);
  } else {
    const items = await extractLabels(blank);
    const placements = hasTextLayer(items) ? autoPlaceFromData(items, row) : [];
    filled = await overlayText(blank, placements);
    intended = placements.map((p) => ({ page: p.page, label: p.label, value: p.text }));
  }
  const stem = path.basename(file).replace(/\.pdf$/i, "");
  fs.writeFileSync(path.join(outDir, `${stem}.filled.pdf`), filled);
  const report: FillVerifyReport = noVision
    ? { provider: "", calls: 0, checkedPages: [], skippedPages: [], unexpected: [], rows: intended.map((r) => ({ ...r, intended: r.value, read: "", readUnder: "", verdict: "not checked" as const })) }
    : await verifyFilledForm(llm, filled, intended);
  const md = fillReportMarkdown(stem, report);
  sections.push(md, "");
  console.log(`${md}\n`);
}
fs.writeFileSync(path.join(outDir, "report.md"), sections.join("\n"));
console.log(`Filled PDFs and report.md are in ${outDir}`);
