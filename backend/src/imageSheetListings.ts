// LISTING MARKS ON IMAGE-ONLY PLAN SHEETS (#532) — the module datasheet read
// (moduleListing.ensureModuleListingAgency) generalised to the racking and the roof attachment.
//
// A revised plan set answered an inspector's "Provide UL listing for the panels, mounting and
// racking hardware" with certificate sheets pasted in as PICTURES: their text layer held only the
// title block (~400 characters), so city.plan.ul-listings-missing read the fixed set exactly like
// the unfixed one. The racking's "UL 2703 Listed System" was on an image page of both.
//
// WHICH PAGES. Only the set's image-only pages (scannedPlanSet.imageOnlyPages: little text beyond
// the title block every page repeats, and a large raster) — a page with a text layer was already
// read. They are ORDERED by the sheet's own name (the title-block-free words: "ATTACHMENT UL
// CERTIFICATE" before "RACKING DATA" before "MICROINVERTER SPECIFICATION"); the order never drops a
// page, the cap does, and every page not read is named with why.
//
// COST. At most MAX_LISTING_VISION_PAGES pages per review, one visionExtract call each, each image
// inside the model's limits (scannedPlanSet's VISION_MAX_* and MAX_IMAGE_BYTES). Nothing is read
// when the text already shows every listing the rule asks for (the caller asks packageListings),
// and the read stops as soon as the missing ones are found.
//
// RULE 2. What is sent is the page image and SHEET_LISTING_VISION_PROMPT — a constant: no project
// field, no extracted text. A page whose text reads as a bill or meter record is withheld before it
// is rendered (scannedPlanSet.looksLikeBillOrMeterPage). The response is never logged; only a quote
// that itself names the listing (listingAffirmed — the rule's own reader, negations refused) is kept.
import type { LLMProvider } from "../../shared/src/types";
import { listingAffirmed, LISTING_PATTERNS_BY_PRODUCT, type ImageSheetListingReading, type ListingProduct } from "./codeReviewRules";
import {
  bodyTokensPerPage, imageOnlyPages, looksLikeBillOrMeterPage, rasterPixelsPerPage,
  MAX_IMAGE_BYTES, VISION_MAX_LONG_EDGE, VISION_MAX_PIXELS,
} from "./scannedPlanSet";

/** At most this many image-only pages are read by vision for listing marks per review. */
export const MAX_LISTING_VISION_PAGES = 6;

export const SHEET_LISTING_VISION_PROMPT = `This image is one page of a solar PV plan set — usually an equipment datasheet, or a listing / certification letter, pasted into the set as a picture.
Report the safety LISTING standards the page prints for these three products only:
- "module": the PV module / panel (for example UL 61730, UL 1703);
- "racking": the racking or mounting system — rails, clamps, splices, bonding (for example UL 2703);
- "attachment": the roof attachment or flashing (for example UL 2703A, "UL Subject 2703A").
Ignore every other product (inverter, microinverter, combiner, disconnect, junction box, wire, battery).
Return ONLY JSON: {"listings": [{"product": "module" | "racking" | "attachment", "standard": "<as printed, e.g. UL 2703>", "quote": "<the exact printed words naming the standard, copied from the page>"}]}
If the page prints no listing for those products, return {"listings": []}. Never guess; never report a standard the page does not print.`;

export interface ImageSheetListingRead {
  /** Accepted readings: the quote names the listing of the product it was read for. */
  readings: ImageSheetListingReading[];
  /** Every image-only page of the set (before withholding and the cap). */
  imagePages: number[];
  /** Pages sent to vision, in the order read. */
  read: number[];
  /** Image-only pages not read, and why. */
  skipped: Array<{ page: number; reason: string }>;
  /** One plain statement of what was and was not read, for the report ("" when no read was needed). */
  coverage: string;
}

// THE SHEET'S NAME, for ORDER only. A listing word (UL, certificate…) and a listed product's word
// (module, racking, attachment…) move a page up; another product's word (inverter, disconnect…)
// moves it down — "AC DISCONNECT UL CERTIFICATION" is not the module's listing. Never an exclusion.
const LISTING_WORDS = new Set(["UL", "ETL", "CSA", "INTERTEK", "LISTING", "LISTINGS", "LISTED", "CERTIFICATE", "CERTIFICATES", "CERTIFICATION", "CERTIFICATIONS", "CERT", "CERTS"]);
const LISTED_PRODUCT_WORDS = new Set(["MODULE", "MODULES", "RACKING", "RAIL", "RAILS", "MOUNT", "MOUNTING", "ATTACHMENT", "ATTACHMENTS", "FLASHING", "FLASHINGS", "STANDOFF", "STANDOFFS", "CLAMP", "CLAMPS"]);
const OTHER_PRODUCT_WORDS = new Set(["INVERTER", "INVERTERS", "MICROINVERTER", "MICROINVERTERS", "COMBINER", "DISCONNECT", "JUNCTION", "WIRING", "WIRE", "CONDUIT", "BATTERY", "BATTERIES", "GATEWAY", "OPTIMIZER", "OPTIMIZERS"]);

/** `pages` (1-based) best-first by their sheet names; ties keep page order. Drops nothing. */
export function orderListingCandidates(pages: number[], pageTexts: string[]): number[] {
  const body = bodyTokensPerPage(pageTexts);
  const score = (page: number): number => {
    const words = new Set(body[page - 1] ?? []);
    const has = (set: Set<string>) => [...words].some((w) => set.has(w));
    return (has(LISTING_WORDS) ? 2 : 0) + (has(LISTED_PRODUCT_WORDS) ? 2 : 0) - (has(OTHER_PRODUCT_WORDS) ? 2 : 0);
  };
  return pages.map((page, i) => ({ page, i, s: score(page) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.page);
}

/** The readings a vision answer supports: a known product, and a quote that itself affirms that
 *  product's listing. Tolerates any shape (the stub's {provider:"stub"} reads as none). */
export function acceptedListingReadings(page: number, raw: unknown): ImageSheetListingReading[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { listings?: unknown }).listings) ? (raw as { listings: unknown[] }).listings : [];
  const out: ImageSheetListingReading[] = [];
  const seen = new Set<string>();
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const product = String(o.product ?? "").trim().toLowerCase();
    if (!(product in LISTING_PATTERNS_BY_PRODUCT)) continue;
    const quote = String(o.quote ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!quote || !listingAffirmed(product as ListingProduct, quote)) continue;
    const key = `${product}|${quote.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ page, product: product as ListingProduct, quote });
  }
  return out;
}

function pageList(pages: number[]): string {
  return `page${pages.length > 1 ? "s" : ""} ${pages.join(", ")}`;
}

/** The plain statement the report carries: which image-only sheets were read and which were not. */
export function describeListingCoverage(r: Pick<ImageSheetListingRead, "imagePages" | "read" | "skipped">, cap: number): string {
  if (!r.imagePages.length) return "No sheet of the plan set is image-only, so its text layer was the whole read.";
  const parts: string[] = [];
  if (r.read.length) parts.push(`Image-only sheets read by vision for listing marks (at most ${cap} per review): ${pageList(r.read)}.`);
  else parts.push(`The plan set's image-only sheets (${pageList(r.imagePages)}) were not read for listing marks.`);
  if (r.skipped.length) {
    const byReason = new Map<string, number[]>();
    for (const s of r.skipped) byReason.set(s.reason, [...(byReason.get(s.reason) ?? []), s.page]);
    parts.push(`Not read: ${[...byReason.entries()].map(([reason, ps]) => `${pageList([...ps].sort((a, b) => a - b))} (${reason})`).join("; ")}.`);
  }
  return parts.join(" ");
}

type Renderer = Awaited<ReturnType<typeof import("./pageImages").openPdfForVisionRender>>;

/** One page as a JPEG inside the model's limits: lower quality, then fewer pixels, before giving up. */
async function renderForVision(renderer: Renderer, page: number) {
  const full = { maxLongEdge: VISION_MAX_LONG_EDGE, maxPixels: VISION_MAX_PIXELS };
  let img = await renderer.render(page, { ...full, quality: 85 });
  if (img.bytes.length > MAX_IMAGE_BYTES) img = await renderer.render(page, { ...full, quality: 65 });
  if (img.bytes.length > MAX_IMAGE_BYTES) img = await renderer.render(page, { maxLongEdge: 2000, maxPixels: 2_000_000, quality: 65 });
  if (img.bytes.length > MAX_IMAGE_BYTES) throw new Error(`over the ${MAX_IMAGE_BYTES}-byte per-image cap`);
  return img;
}

/**
 * Read the listing marks the plan set's IMAGE-ONLY sheets print, for the listings the text did not
 * show (`want`). `llm` null = no vision model: nothing is rendered or sent, and the coverage says so.
 */
export async function readImageSheetListings(
  llm: Pick<LLMProvider, "visionExtract"> | null,
  pdfBytes: Uint8Array,
  pageTexts: string[],
  opts: { want: { module: boolean; racking: boolean }; rasterPixels?: number[]; cap?: number },
): Promise<ImageSheetListingRead> {
  const cap = Math.max(1, Math.floor(opts.cap ?? MAX_LISTING_VISION_PAGES));
  const result: ImageSheetListingRead = { readings: [], imagePages: [], read: [], skipped: [], coverage: "" };
  if (!opts.want.module && !opts.want.racking) return result;
  let raster = opts.rasterPixels;
  if (!raster) {
    try { raster = await rasterPixelsPerPage(pdfBytes); } catch { raster = []; }
  }
  result.imagePages = imageOnlyPages(pageTexts, raster);
  const candidates: number[] = [];
  for (const page of result.imagePages) {
    if (looksLikeBillOrMeterPage(pageTexts[page - 1] ?? "")) result.skipped.push({ page, reason: "withheld: its text reads as a bill or meter record" });
    else candidates.push(page);
  }
  if (!llm) {
    for (const page of candidates) result.skipped.push({ page, reason: "no vision model is configured" });
    result.coverage = describeListingCoverage(result, cap);
    return result;
  }
  const ordered = orderListingCandidates(candidates, pageTexts);
  for (const page of ordered.slice(cap)) result.skipped.push({ page, reason: `over the ${cap}-page cap` });
  const toRead = ordered.slice(0, cap);
  const found = { module: false, racking: false };
  const done = () => (!opts.want.module || found.module) && (!opts.want.racking || found.racking);
  if (toRead.length) {
    const { openPdfForVisionRender } = await import("./pageImages");
    let renderer: Renderer | null = null;
    try {
      renderer = await openPdfForVisionRender(pdfBytes);
    } catch (err) {
      for (const page of toRead) result.skipped.push({ page, reason: `the plan set could not be rendered (${String((err as Error)?.message ?? err).slice(0, 60)})` });
    }
    if (renderer) {
      try {
        for (const page of toRead) {
          if (done()) { result.skipped.push({ page, reason: "not needed: the missing listings were already found" }); continue; }
          let img: Awaited<ReturnType<typeof renderForVision>>;
          try { img = await renderForVision(renderer, page); } catch (err) {
            result.skipped.push({ page, reason: `could not be rendered (${String((err as Error)?.message ?? err).slice(0, 60)})` });
            continue;
          }
          let raw: unknown;
          try {
            raw = await llm.visionExtract({ imageBase64: img.bytes.toString("base64"), mimeType: img.mimeType, prompt: SHEET_LISTING_VISION_PROMPT });
          } catch {
            result.skipped.push({ page, reason: "the vision read failed" });
            continue;
          }
          result.read.push(page);
          for (const reading of acceptedListingReadings(page, raw)) {
            result.readings.push(reading);
            if (reading.product === "module") found.module = true;
            if (reading.product === "racking") found.racking = true;
          }
        }
      } finally {
        await renderer.close();
      }
    }
  }
  result.coverage = describeListingCoverage(result, cap);
  return result;
}
