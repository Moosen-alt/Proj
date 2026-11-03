// ---------------------------------------------------------------------------
// Standalone form-filler tool — deliberately decoupled from projects/DB/LLM.
// Upload any flat AHJ/utility form (PDF, or DOCX converted via LibreOffice),
// place text values by coordinate, and download the filled PDF. Reuses pdf-lib
// (already a dependency); the browser does rendering + placement, the server
// does DOCX→PDF conversion and the final overlay draw (kept server-side so the
// coordinate math is unit-tested).
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { PDFDocument, PDFTextField, StandardFonts, rgb } from "pdf-lib";
import {
  FIELD_SYNONYMS, normLabel, checkboxLabels, extractLabels, captionsForRect, calibrateCaptionSide, primaryCaption, captionAgreesWithName,
  type WidgetCaptions, type WidgetRect,
} from "./formTextLayer";
import { partyOfSlot, pickSlots, sectionHeaders, sectionOf, type Slot } from "./formFillSlots";

/** A single text value drawn on a page. Coordinates are PDF points with the
 *  ORIGIN AT THE BOTTOM-LEFT (pdf-lib's native convention); the browser converts
 *  from its top-left screen space before sending. page is 0-indexed. */
export interface Placement {
  page: number;
  x: number;
  y: number;
  text: string;
  size?: number;
}

const PDF_MAGIC = Buffer.from("%PDF-");

export function isPdf(bytes: Buffer | Uint8Array): boolean {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return b.length > 5 && b.subarray(0, 5).equals(PDF_MAGIC);
}

/** Inspect an uploaded PDF: page count + per-page point dimensions, so the
 *  browser can render at a matching scale and map clicks back to PDF points. */
export async function inspectPdf(bytes: Uint8Array): Promise<{ pageCount: number; pages: { width: number; height: number }[] }> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = doc.getPages().map((p) => ({ width: p.getWidth(), height: p.getHeight() }));
  return { pageCount: pages.length, pages };
}

/** Draw the placements onto the PDF and return the filled bytes. Out-of-range
 *  pages and non-finite coordinates are skipped rather than throwing, so one bad
 *  placement can never nuke the whole fill. */
export async function overlayText(bytes: Uint8Array, placements: Placement[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  for (const p of placements) {
    if (!Number.isInteger(p.page) || p.page < 0 || p.page >= pages.length) continue;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const text = String(p.text ?? "");
    if (!text) continue;
    const size = Number.isFinite(p.size) && (p.size as number) > 0 ? (p.size as number) : 11;
    pages[p.page].drawText(text, { x: p.x, y: p.y, size, font, color: rgb(0.06, 0.06, 0.06) });
  }
  return doc.save();
}

/** List a PDF's AcroForm fields (name + kind). Empty for flat forms. */
export async function listAcroFields(bytes: Uint8Array): Promise<{ name: string; kind: string }[]> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    return doc.getForm().getFields().map((f) => ({ name: f.getName(), kind: f.constructor.name }));
  } catch { return []; }
}

export interface FieldMatch { key: string; field: string; value: string }
export interface CheckMatch { phrase: string; field: string }

// Words too generic to help match a reason phrase to a checkbox field name.
const CHECKBOX_STOP = new Set(["permit","permits","the","of","in","by","no","not","explain","check","box","for","and","or","is","request","requested","requesting","refund","reason","please","was","this","application","fee","fees"]);
const kwTokens = (s: string) => new Set(normLabel(s).split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !CHECKBOX_STOP.has(w)));

/** Best checkbox field for a reason/type phrase, by keyword overlap with the
 *  field NAME (e.g. "permit canceled by applicant" → "Permit canceled by
 *  Applicant"). Returns null when nothing shares a meaningful keyword. */
function matchCheckbox(fields: { name: string; norm: string; kind: string; labelText?: string }[], phrase: string, used: Set<string>): string | null {
  const pt = kwTokens(phrase);
  if (!pt.size) return null;
  let best: string | null = null;
  let bestScore = 0;
  for (const f of fields) {
    if (f.kind !== "PDFCheckBox" || used.has(f.name)) continue;
    // Match against the field name AND any descriptive text beside the box, so
    // generic names ("Check Box6" / "Applicant cancelled permit") still resolve.
    const ft = kwTokens(`${f.name} ${f.labelText ?? ""}`);
    let overlap = 0;
    for (const t of pt) if (ft.has(t)) overlap++;
    if (overlap > bestScore) { best = f.name; bestScore = overlap; }
  }
  return bestScore >= 1 ? best : null;
}

/** Auto-fill an AcroForm by matching provided data keys (name/street/city/…) to its text boxes.
 *  WHICH box (issue #428): what the box IS on the printed page — its printed caption when the form's
 *  captions disagree with its widget name (BCD 5952's city box is NAMED "State  Oregon"; the
 *  Waltham shape, formTextLayer.calibrateCaptionSide), else its name and caption together — and
 *  the party it sits in (formFillSlots.pickSlots: whole words, never an office-use/fee box, the
 *  homeowner in the owner block, the company in the contractor block, one combined
 *  City/State/ZIP). A form with no text layer is matched by widget names alone, as before.
 *  Returns the filled bytes plus which fields matched and the full field list. */
export async function autoFillByFieldName(
  bytes: Uint8Array,
  data: Record<string, string>,
): Promise<{ filled: Uint8Array; matched: FieldMatch[]; checked: CheckMatch[]; fieldNames: string[] }> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = doc.getForm();
  const fields = form.getFields().map((f) => ({ name: f.getName(), norm: normLabel(f.getName()), kind: f.constructor.name }));
  const items = await extractLabels(bytes);
  const headers = sectionHeaders(items);
  const pages = doc.getPages();
  const widgets: Array<{ name: string; page: number; rect: WidgetRect; captions: WidgetCaptions }> = [];
  for (const f of form.getFields()) {
    if (!(f instanceof PDFTextField)) continue;
    const w = f.acroField.getWidgets()[0];
    if (!w) { widgets.push({ name: f.getName(), page: 0, rect: { x: 0, y: 0, width: 0, height: 0 }, captions: {} }); continue; }
    const at = pages.findIndex((p) => p.ref === w.P());
    const page = at < 0 ? 0 : at;
    const rect = w.getRectangle();
    widgets.push({ name: f.getName(), page, rect, captions: captionsForRect(items, page, rect) });
  }
  const side = calibrateCaptionSide(widgets);
  const slots: Slot[] = widgets.map((w) => {
    const caption = primaryCaption(w.captions, side);
    const label = caption && !captionAgreesWithName(w.name, caption) ? caption : caption ? `${w.name} ${caption}` : w.name;
    const base = { page: w.page, x: w.rect.x, y: w.rect.y, width: w.rect.width, height: w.rect.height, label };
    return { id: w.name, ...base, party: items.length ? partyOfSlot(items, headers, base) : null, section: sectionOf(headers, base) };
  });
  const matched: FieldMatch[] = [];
  const used = new Set<string>();
  for (const pick of pickSlots(slots, data, FIELD_SYNONYMS)) {
    try {
      form.getTextField(pick.slot.id).setText(pick.value);
      used.add(pick.slot.id);
      matched.push({ key: pick.key, field: pick.slot.id, value: pick.value });
    } catch { /* not settable as text — skip */ }
  }
  // Checkboxes: a `reason` (why the refund) and/or `permitType` (residential/
  // commercial) phrase ticks the best-matching checkbox by keyword overlap.
  const checked: CheckMatch[] = [];
  const wantCheck = (data.reason ?? "").trim() || (data.permitType ?? "").trim();
  // Recover descriptive text beside generically-named boxes (only if we'll use it).
  const cbLabels = wantCheck ? await checkboxLabels(bytes) : {};
  const cbFields = fields.map((f) => ({ ...f, labelText: cbLabels[f.name] || "" }));
  for (const key of ["reason", "permitType"]) {
    const phrase = (data[key] ?? "").trim();
    if (!phrase) continue;
    const name = matchCheckbox(cbFields, phrase, used);
    if (name) {
      used.add(name);
      try { form.getCheckBox(name).check(); checked.push({ phrase, field: name }); } catch { /* not a checkbox */ }
    }
  }
  const filled = await doc.save();
  return { filled, matched, checked, fieldNames: fields.map((f) => f.name) };
}

const SOFFICE_BIN = process.env.SOFFICE_BIN || "soffice";

/** Convert a DOCX/DOC buffer to PDF via LibreOffice headless. Throws a clear,
 *  actionable error (never a raw spawn failure) when LibreOffice isn't available
 *  so the UI can tell the operator to upload a PDF instead. Requires `soffice`
 *  on the host (added to the Docker image); verify on the real deploy. */
export async function convertDocxToPdf(docxBytes: Uint8Array): Promise<Uint8Array> {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "formfill-"));
  const inPath = path.join(workdir, "in.docx");
  const outPath = path.join(workdir, "in.pdf");
  fs.writeFileSync(inPath, docxBytes);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        SOFFICE_BIN,
        // pathToFileURL yields a correct file:// URL on every OS (Windows drive
        // paths become file:///C:/… — a hand-built "file://" + backslash path is
        // malformed and makes soffice silently fail).
        ["--headless", `-env:UserInstallation=${pathToFileURL(path.join(workdir, "profile")).href}`, "--convert-to", "pdf", "--outdir", workdir, inPath],
        { timeout: 120_000 },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    if (!fs.existsSync(outPath)) {
      throw new Error("conversion produced no PDF");
    }
    return new Uint8Array(fs.readFileSync(outPath));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `DOCX→PDF conversion failed (${msg}). LibreOffice (soffice) must be installed on the server; otherwise save the form as PDF and upload that instead.`,
    );
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}
