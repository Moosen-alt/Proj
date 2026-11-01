// ---------------------------------------------------------------------------
// "VERIFY FILL WITH VISION" (issue #428). Reads a FILLED form back the way a person checks it:
// render each filled page, ask the vision model what is written on it and under which printed
// label, and compare that to what the fill meant to put where. One table row per intended value:
// right / wrong box / missing / clipped / overlapping print.
//
// Opt-in and bounded: it runs only when an operator clicks "Verify fill with vision" (the Form
// Filler tool, a project's filled-form card) or runs scripts/verify-form-fill.ts — never on a
// schedule — and makes at most ONE model call per page that carries a value.
//
// It REPORTS, it never corrects (hard rule 4): nothing here writes a form, a map or a template.
//
// Hard rule 2: the prompt carries printed LABELS only, never the values the fill intended (the
// comparison is done here, locally). A page whose printed words name an account, meter, SSN, ESI /
// SA id or other secret field (infoPagePass.isSecretLikeFieldName, read word by word) is not
// rendered and not sent; the table says so.
// ---------------------------------------------------------------------------

import { PDFDocument, PDFTextField } from "pdf-lib";
import type { LLMProvider } from "../../shared/src/types";
import { isSecretLikeFieldName } from "../../shared/src/infoPagePass";
import { openPdfForVisionRender } from "./pageImages";
import { calibrateCaptionSide, captionsForRect, extractLabels, primaryCaption, captionAgreesWithName, type LabelItem } from "./formTextLayer";
import { partyOfWords, sectionHeaders, sectionTitleOf, slotTokens } from "./formFillSlots";

/** What the fill meant: this value, under this printed label, on this page (0-based). An empty
 *  label means the fill does not know it (a drawn value read off the page); vision's label is then
 *  reported for a person to judge. */
export interface IntendedValue { page: number; label: string; value: string }

export type FillVerdict = "right" | "wrong box" | "missing" | "clipped" | "overlapping print" | "read (no intended label)" | "not checked";

export interface FillReadRow {
  page: number;
  label: string;
  intended: string;
  /** What vision read for this value ("" when it found nothing). */
  read: string;
  /** The printed label vision says the value sits in or beside. */
  readUnder: string;
  verdict: FillVerdict;
}

export interface FillVerifyReport {
  provider: string;
  /** Vision calls answered by a model: one per page checked (a stub install answers none). */
  calls: number;
  checkedPages: number[];
  /** Pages not sent, with why (a secret field on the page, a render failure, no model). */
  skippedPages: Array<{ page: number; reason: string }>;
  rows: FillReadRow[];
  /** Entries vision read that no intended value accounts for (pre-printed text it mistook, or a
   *  value the fill put somewhere it did not say). */
  unexpected: Array<{ page: number; label: string; read: string }>;
}

export const FILL_VERIFY_PROMPT_HEAD = "This image is ONE page of a FILLED government permit application form. List every value that was typed or written INTO the form — not the form's own printed words, headings or instructions. For each value give the printed label of the box or line it sits in or beside, copied as printed, and when the form prints a section heading above that box (PROPERTY OWNER, CONTRACTOR, APPLICANT…) put it first as \"HEADING - Label\". Set overlapsPrint true when the value is drawn over printed words; set clipped true when it is cut off by its box. Reply with JSON only: {\"entries\":[{\"label\":\"...\",\"value\":\"...\",\"overlapsPrint\":false,\"clipped\":false}]}.";

/** The prompt for one page: the instruction and the page's printed labels to look under. Labels
 *  only — never an intended value (rule 2). */
export function fillVerifyPrompt(labels: string[]): string {
  const list = [...new Set(labels.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, 60);
  return list.length ? `${FILL_VERIFY_PROMPT_HEAD}\nPrinted labels on this page include: ${list.map((l) => JSON.stringify(l)).join(", ")}.` : FILL_VERIFY_PROMPT_HEAD;
}

const loose = (s: string): string => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

interface ReadEntry { label: string; value: string; overlapsPrint: boolean; clipped: boolean }

/** Read the model's reply defensively: anything not shaped as entries is no entries. */
export function parseReadEntries(raw: Record<string, unknown> | null | undefined): ReadEntry[] {
  const list = Array.isArray(raw?.entries) ? (raw!.entries as unknown[]) : [];
  return list.flatMap((e) => {
    if (!e || typeof e !== "object") return [];
    const o = e as Record<string, unknown>;
    const value = String(o.value ?? "").trim();
    if (!value) return [];
    return [{ label: String(o.label ?? "").trim(), value, overlapsPrint: o.overlapsPrint === true, clipped: o.clipped === true }];
  });
}

/** "CONTRACTOR INFORMATION - Phone:" → its section and its caption. */
export function splitSectionLabel(label: string): { section: string; caption: string } {
  const m = /^(.*\S)\s+[-–—>]\s+(\S.*)$/.exec(String(label ?? "").trim());
  return m ? { section: m[1], caption: m[2] } : { section: "", caption: String(label ?? "").trim() };
}

/** Do two printed captions name the same kind of box? Word overlap, so "E-mail:" and "Email"
 *  agree and "City/State/ZIP:" agrees with "City/State/Zip". */
function sameCaption(a: string, b: string): boolean {
  const x = new Set(slotTokens(a));
  const y = slotTokens(b);
  if (!x.size || !y.length) return loose(a) === loose(b) && Boolean(loose(a));
  const shared = y.filter((w) => x.has(w)).length;
  return shared >= Math.min(x.size, y.length) || shared >= 2;
}

/** The same box: the same caption and — when both name one — the same section. "Phone:" under
 *  PROPERTY OWNER is not "Phone:" under CONTRACTOR, the exact confusion #428 found. */
export function sameLabel(intended: string, read: string): boolean {
  const a = splitSectionLabel(intended), b = splitSectionLabel(read);
  if (!sameCaption(a.caption, b.caption)) return false;
  if (!a.section || !b.section) return true;
  const pa = partyOfWords(slotTokens(a.section)), pb = partyOfWords(slotTokens(b.section));
  if (pa || pb) return pa === pb;
  const x = new Set(slotTokens(a.section));
  return slotTokens(b.section).some((w) => x.has(w));
}

/**
 * Compare one page's intended values with what vision read there. Pure: the unit tests and the
 * script call it with a fixed reply.
 */
export function compareReadBack(page: number, intended: IntendedValue[], entries: ReadEntry[]): { rows: FillReadRow[]; unexpected: FillVerifyReport["unexpected"] } {
  const used = new Set<number>();
  const rows: FillReadRow[] = [];
  for (const want of intended) {
    const v = loose(want.value);
    if (!v) continue;
    // The entry carrying this value: exact first, then one containing it or contained in it.
    let at = entries.findIndex((e, i) => !used.has(i) && loose(e.value) === v);
    if (at < 0) at = entries.findIndex((e, i) => !used.has(i) && (loose(e.value).includes(v) || (loose(e.value).length >= 3 && v.includes(loose(e.value)))));
    if (at < 0) { rows.push({ page, label: want.label, intended: want.value, read: "", readUnder: "", verdict: "missing" }); continue; }
    used.add(at);
    const e = entries[at];
    const r = loose(e.value);
    const verdict: FillVerdict = e.overlapsPrint ? "overlapping print"
      : e.clipped || (r.length < v.length && v.includes(r)) ? "clipped"
      : !want.label ? "read (no intended label)"
      : sameLabel(want.label, e.label) ? "right" : "wrong box";
    rows.push({ page, label: want.label, intended: want.value, read: e.value, readUnder: e.label, verdict });
  }
  const unexpected = entries.filter((_, i) => !used.has(i)).map((e) => ({ page, label: e.label, read: e.value }));
  return { rows, unexpected };
}

/**
 * What a filled AcroForm says it holds: every text box with a value, under the caption printed
 * beside it (the form's calibrated caption side — formTextLayer), else its widget name, prefixed
 * with the printed section header it sits under ("CONTRACTOR INFORMATION - Phone:"). This is the
 * fill's own record of field → value → printed label for a fillable form.
 */
export async function intendedFromAcroForm(filled: Uint8Array): Promise<IntendedValue[]> {
  const doc = await PDFDocument.load(filled, { ignoreEncryption: true });
  const pages = doc.getPages();
  const items = await extractLabels(filled);
  const widgets: Array<{ name: string; value: string; page: number; rect: { x: number; y: number; width: number; height: number }; captions: ReturnType<typeof captionsForRect> }> = [];
  for (const f of doc.getForm().getFields()) {
    if (!(f instanceof PDFTextField)) continue;
    const value = (f.getText() ?? "").trim();
    for (const w of f.acroField.getWidgets()) {
      const at = pages.findIndex((p) => p.ref === w.P());
      const page = at < 0 ? 0 : at;
      const rect = w.getRectangle();
      widgets.push({ name: f.getName(), value, page, rect, captions: captionsForRect(items, page, rect) });
    }
  }
  const side = calibrateCaptionSide(widgets);
  const headers = sectionHeaders(items);
  return widgets.filter((w) => w.value).map((w) => {
    const caption = primaryCaption(w.captions, side);
    const label = caption && !captionAgreesWithName(w.name, caption) ? caption : caption || w.name.replace(/_\d+$/, "");
    const section = sectionTitleOf(headers, { page: w.page, ...w.rect, label });
    return { page: w.page, value: w.value, label: section ? `${section} - ${label}` : label };
  });
}

/**
 * What an OVERLAY fill drew: the text items on the filled page that the blank does not print.
 * The fill does not record which label each was meant for, so the label is left empty and the
 * report shows where vision read it.
 */
export async function intendedFromOverlay(blank: Uint8Array, filled: Uint8Array): Promise<IntendedValue[]> {
  const key = (i: LabelItem) => `${i.page}|${Math.round(i.x)}|${Math.round(i.y)}|${i.str.trim()}`;
  const before = new Set((await extractLabels(blank)).map(key));
  return (await extractLabels(filled)).filter((i) => i.str.trim() && !before.has(key(i))).map((i) => ({ page: i.page, label: "", value: i.str.trim() }));
}

/** The printed words of each page that make it a page not to send (rule 2). */
function sensitivePages(items: LabelItem[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const i of items) {
    if (!out.has(i.page) && isSecretLikeFieldName(i.str)) out.set(i.page, i.str.trim().slice(0, 60));
  }
  return out;
}

/**
 * Verify a filled PDF: one vision call per page that carries an intended value. AcroForm values
 * are flattened into a copy first so the rendered page shows them; the caller's bytes are never
 * changed. No model on this install = nothing sent, every page listed as skipped.
 */
export async function verifyFilledForm(
  llm: Pick<LLMProvider, "visionExtract">,
  filled: Uint8Array,
  intended: IntendedValue[],
  opts: { provider?: string } = {},
): Promise<FillVerifyReport> {
  const report: FillVerifyReport = { provider: opts.provider ?? "", calls: 0, checkedPages: [], skippedPages: [], rows: [], unexpected: [] };
  const pages = [...new Set(intended.filter((r) => r.value.trim()).map((r) => r.page))].sort((a, b) => a - b);
  if (!pages.length) return report;
  const items = await extractLabels(filled);
  const secret = sensitivePages(items);
  let flat = filled;
  try {
    const doc = await PDFDocument.load(filled, { ignoreEncryption: true });
    if (doc.getForm().getFields().length) { doc.getForm().flatten(); flat = await doc.save(); }
  } catch { /* render as it is: an overlay fill already shows its values */ }
  const pdf = await openPdfForVisionRender(flat);
  try {
    for (const page of pages) {
      const want = intended.filter((r) => r.page === page);
      const notChecked = (reason: string): void => {
        report.skippedPages.push({ page, reason });
        report.rows.push(...want.map((w): FillReadRow => ({ page, label: w.label, intended: w.value, read: "", readUnder: "", verdict: "not checked" })));
      };
      if (secret.has(page)) { notChecked(`not sent: the page prints "${secret.get(page)}", a field that never goes to a model`); continue; }
      let raw: Record<string, unknown>;
      try {
        const img = await pdf.render(page + 1, { maxLongEdge: 1800, maxPixels: 2_400_000, quality: 85 });
        const labels = items.filter((i) => i.page === page && /[a-z]/i.test(i.str) && i.str.trim().length <= 40).map((i) => i.str);
        raw = await llm.visionExtract({ imageBase64: img.bytes.toString("base64"), mimeType: "image/jpeg", prompt: fillVerifyPrompt(labels) });
      } catch (err) {
        notChecked(`not checked: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (!report.provider && typeof raw?.provider === "string") report.provider = raw.provider;
      if (raw?.provider === "stub") { notChecked("not checked: no vision model is configured on this install (ANTHROPIC_API_KEY)"); continue; }
      report.calls++;
      report.checkedPages.push(page);
      const cmp = compareReadBack(page, want, parseReadEntries(raw));
      report.rows.push(...cmp.rows);
      report.unexpected.push(...cmp.unexpected);
    }
  } finally {
    await pdf.close();
  }
  return report;
}

/** The report as a Markdown table (the script's output, the PR's before/after table). */
export function fillReportMarkdown(title: string, report: FillVerifyReport): string {
  const cell = (s: string) => String(s ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim() || "—";
  const lines = [`### ${title}`, "", "| Page | Printed label | Intended | Vision read | Read under | Verdict |", "| --- | --- | --- | --- | --- | --- |"];
  for (const r of report.rows) lines.push(`| ${r.page + 1} | ${cell(r.label)} | ${cell(r.intended)} | ${cell(r.read)} | ${cell(r.readUnder)} | ${r.verdict} |`);
  for (const u of report.unexpected) lines.push(`| ${u.page + 1} | — | — | ${cell(u.read)} | ${cell(u.label)} | not intended |`);
  for (const s of report.skippedPages) lines.push(`| ${s.page + 1} | — | — | — | — | ${cell(s.reason)} |`);
  return lines.join("\n");
}
