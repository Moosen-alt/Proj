// ---------------------------------------------------------------------------
// WHICH BOX A FORM FILLER VALUE BELONGS IN (issue #428). The standalone Form Filler
// (/tools/form-filler: "Auto-fill from my data" and Batch) matched each data key to the FIRST box
// whose name or printed label CONTAINED one of the key's words. Read back page by page on eight
// public AHJ blanks (Tigard building + electrical, Coos County electrical, Marion County B-01S and
// E-01, BCD 440-5952, Valencia County, Yamhill County, City of Albuquerque E-Plan), that put:
//  - the permit number in Marion E-01's TOTAL PERMIT FEE box and in Tigard's FOR OFFICE USE box,
//    and the date in Coos County's "Date of Approval" (characters matched inside other words, and
//    nothing kept the operator's data out of office-use and fee boxes);
//  - "OR" and "97999" alone in the owner's and the contractor's City/State/ZIP boxes, and the job
//    site's City/State/ZIP with the city only (one combined box read as three separate keys);
//  - the COMPANY's phone, email and mailing address in the PROPERTY OWNER block of five forms, and
//    the homeowner's name in Yamhill's CONTRACTOR "Name:" (the first match on the page won,
//    whatever block it sat in);
//  - "OR" in BCD 5952's City box, whose widget is NAMED "State  Oregon" (the name, not the printed
//    caption, was read — the Waltham shape, formFieldChecks.ts).
// This module answers the question once for both of the tool's doors (AcroForm boxes by name and
// caption, flat forms by printed label) with general rules — never a form by name:
//  1. a label matches a synonym by WHOLE WORDS (every synonym word printed), not by substring;
//  2. no operator value goes in an office-use, approval or fee box (by the box's own words, or the
//     printed section it sits in);
//  3. each box belongs to a PARTY read off the page: the party its own label names ("Owner name",
//     "Business name"), else a party named earlier on its own line ("Owner signature: ___ Date:"),
//     else the printed section header above it ("PROPERTY OWNER", "CONTRACTOR", "FOR OFFICE USE
//     ONLY"). The row's homeowner/site values go to the owner or job-site party; the company
//     boilerplate (installer, its phone, email, mailing address) to the contractor/applicant/agent
//     party; a box with no party read stays open to both;
//  4. a combined City/State/ZIP box gets the combined value, once, and the single keys never write
//     into it.
// Geometry and printed words only: no model, no project data.
// ---------------------------------------------------------------------------

/** The party (or office/fee area) a box belongs to on the printed form. */
export type Party = "owner" | "site" | "contractor" | "applicant" | "agent" | "office" | "fees";

/** A printed text item, the subset of formTextLayer.LabelItem this module reads. */
export interface TextItem { page: number; str: string; x: number; y: number; width: number; height: number; angle?: number; blank?: boolean }

const STOP = new Set(["of", "the", "and", "a", "an", "to", "for", "s", "or", "if", "any"]);

/** A label's words: camelCase split ("CityStateZIP"), a repeat suffix dropped ("Phone number_2"), a
 *  possessive dropped ("Contractor’s name"),
 *  "#"/"number"/"num" read as "no", "telephone" as "phone", "e-mail" as "email". */
export function slotTokens(s: string): string[] {
  return String(s ?? "")
    .replace(/_\d+\s*$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[’']s\b/gi, "")
    .replace(/[’']/g, "")
    .toLowerCase()
    .replace(/\be-mail\b/g, "email")
    .replace(/#/g, " no ")
    .split(/[^a-z0-9]+/)
    .map((w) => (w === "number" || w === "num" || w === "nbr" ? "no" : w === "telephone" ? "phone" : w === "lic" ? "license" : w))
    .filter((w) => w && !STOP.has(w));
}

/** Words that make a printed item a FIELD caption, not a section header ("PROPERTY OWNER NAME"
 *  labels a box; "PROPERTY OWNER" heads a block) — and, beyond a synonym's own, another field. */
const FIELD_WORDS = new Set(["name", "address", "phone", "fax", "email", "city", "state", "zip", "license", "no", "date", "signature", "sign", "print", "printed", "lot", "parcel", "subdivision", "value", "description"]);

/** Rule 1: every word of the synonym is printed in the label. null = no match, else how many
 *  OTHER words the label prints (fewer = closer). A label of more than four extra words is a
 *  sentence, not a caption. */
export function matchSynonym(synonym: string, label: string, opts: { printed?: boolean } = {}): number | null {
  const want = new Set(slotTokens(synonym));
  const have = new Set(slotTokens(label));
  if (!want.size || !have.size) return null;
  for (const w of want) if (!have.has(w)) return null;
  const extra = [...have].filter((w) => !want.has(w));
  if (extra.length > 4) return null;
  // One word says little: "permit" is not "Building Permit Application", and "<word> of <name>" is a
  // name or another thing ("City of Albuquerque", "Date of Approval").
  if (want.size === 1 && (extra.length > 1 || /\bof\b/i.test(label))) return null;
  // On a flat page a one-word synonym with another word beside it is a caption only when printed as
  // one ("Owner name:"), not a phrase in running text ("Sewer permit.").
  if (opts.printed && want.size === 1 && extra.length && !/[:#?]\s*$/.test(label.trim())) return null;
  // An extra FIELD word makes it another field: "contractor" is not "Contractor CCB license #",
  // "phone" is not "Phone / Fax". A bare party synonym still means its name ("Contractor's name").
  const wantsField = [...want].some((w) => FIELD_WORDS.has(w));
  if (extra.some((w) => FIELD_WORDS.has(w) && w !== "no" && !(w === "name" && !wantsField))) return null;
  return extra.length;
}

/** Rule 2: words that make a box the AUTHORITY's (office use, approval, fees), never the
 *  applicant's. */
const AUTHORITY_WORDS = new Set(["fee", "fees", "total", "subtotal", "surcharge", "amount", "paid", "receipt", "balance", "valuation", "approval", "approved", "received", "reviewed", "staff", "office", "official"]);
export const isAuthorityLabel = (label: string): boolean => slotTokens(label).some((w) => AUTHORITY_WORDS.has(w));

/** The party a run of words names, if any. Office/fees outrank a party (a "PERMIT FEES" header). */
export function partyOfWords(words: string[]): Party | null {
  const has = (w: string) => words.includes(w);
  if (has("office") || has("staff") || has("official") || (has("use") && has("department")) || has("approval")) return "office";
  if (has("fee") || has("fees")) return "fees";
  if (has("owner") || has("homeowner") || has("owners")) return "owner";
  if (has("contractor") || has("contractors") || has("installer") || has("business") || has("company")) return "contractor";
  if (has("applicant")) return "applicant";
  if (has("agent") || has("contact")) return "agent";
  if ((has("job") && has("site")) || has("location")) return "site";
  return null;
}

const SENTENCE_WORDS = new Set(["must", "will", "shall", "provide", "below", "above", "please", "is", "are", "be", "being", "by", "this", "that"]);

/** A section header: in capitals with no figures, names a party, prints no field word, at most six
 *  words, not a sentence, and —
 *  if it ends in a colon — is that party word alone ("OWNER:", "CONTRACTOR:"; not "Approved by:"). */
export function headerParty(str: string): Party | null {
  // A header is printed as one: in capitals, with no figures ("OFFICE 505-924-3964" is the
  // agency's phone line; "A. Fee for branch circuits" a fee-table row).
  const letters = str.replace(/[^A-Za-z]/g, "");
  if (/\d/.test(str) || !letters || letters.replace(/[^A-Z]/g, "").length < letters.length * 0.7) return null;
  const words = slotTokens(str);
  if (!words.length || words.length > 6) return null;
  if (words.some((w) => FIELD_WORDS.has(w) || SENTENCE_WORDS.has(w))) return null;
  if (/:\s*$/.test(str.trim()) && words.length > 1) return null;
  return partyOfWords(words);
}

/** The printed section headers of a form (rule 3's last resort). */
export function sectionHeaders(items: TextItem[]): Array<{ item: TextItem; party: Party }> {
  const out: Array<{ item: TextItem; party: Party }> = [];
  for (const item of items) {
    if (item.angle || item.blank) continue;
    const party = headerParty(item.str);
    if (party) out.push({ item, party });
  }
  return out;
}

/** The box a value may go in: an AcroForm widget or a printed label, in PDF points. */
export interface Slot {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** What the box IS on the printed page: the label (flat), or the caption/name (AcroForm). */
  label: string;
  /** The text item the label came from (flat), excluded from its own line's party scan. */
  item?: TextItem;
  party: Party | null;
  /** The printed section header the box sits under (sectionOf), "" when none. */
  section?: string;
}

/** THE PAGE HANDED TO THE APPLICANT FROM A LINE DOWN (issue #446). City of Albuquerque's E-Plan
 *  application prints "APPLICANT TO PROVIDE ALL INFORMATION BELOW:" under its letterhead; the
 *  "PERMIT #" and "ADDITIONAL PERMIT #S" lines above it are the city's own, marked by that banner
 *  alone (no office-use header, no office word in their labels). A banner is one printed line that
 *  names the applicant, what they do (provide / complete / fill in the information) and "below". */
const BANNER_ACTION = new Set(["provide", "provided", "complete", "completed", "fill", "filled", "information", "info"]);
export function isApplicantBanner(str: string): boolean {
  const words = slotTokens(str);
  return words.length <= 12 && words.includes("below") && (words.includes("applicant") || words.includes("applicants"))
    && words.some((w) => BANNER_ACTION.has(w));
}

/** The banners of a form, read once per text layer (partyOfSlot runs once per box). */
const bannerCache = new WeakMap<TextItem[], TextItem[]>();
function applicantBanners(items: TextItem[]): TextItem[] {
  let got = bannerCache.get(items);
  if (!got) {
    got = items.filter((i) => !i.angle && !i.blank && isApplicantBanner(i.str));
    bannerCache.set(items, got);
  }
  return got;
}

/** Rule 3: the party of a box — its own label's, else a party named to its LEFT on its own line
 *  (a baseline inside the box's band: a widget's rectangle, a label's own text height),
 *  else the nearest section header above it in its column. Above an applicant banner, the office's. */
export function partyOfSlot(items: TextItem[], headers: Array<{ item: TextItem; party: Party }>, s: Omit<Slot, "party" | "id">): Party | null {
  // Above an "applicant to provide all information below" banner, on its page, is the agency's
  // (issue #446): the banner hands the applicant only what follows it, whatever a box's label says.
  if (applicantBanners(items).some((b) => b.page === s.page && b !== s.item && s.y > b.y + Math.max(b.height, 4) * 0.75)) return "office";
  const own = partyOfWords(slotTokens(s.label));
  if (own) return own;
  const line = items
    .filter((i) => i.page === s.page && i !== s.item && !i.blank && !i.angle && i.y >= s.y - 3 && i.y <= s.y + Math.max(3, s.height * 0.6) && i.x + i.width <= s.x + 2)
    .sort((a, b) => b.x - a.x);
  for (const i of line) {
    const p = partyOfWords(slotTokens(i.str));
    if (p === "owner" || p === "contractor" || p === "applicant" || p === "agent") return p;
  }
  return headerAbove(headers, s)?.party ?? null;
}

/** The nearest section header above a box, in its column (within 450pt). */
function headerAbove(headers: Array<{ item: TextItem; party: Party }>, s: Omit<Slot, "party" | "id">): { item: TextItem; party: Party } | undefined {
  // A header heads the column it starts in: it may sit left of a box further along its row
  // ("CONTRACTOR:" over "ZIP ____ PHONE ____"), never right of it.
  const reach = Math.max(s.width, 150);
  return headers
    .filter((h) => h.item.page === s.page && h.item !== s.item && h.item.y > s.y + 1 && h.item.y - s.y <= 450
      && h.item.x <= s.x + reach && h.item.x + h.item.width >= s.x - 220)
    .sort((a, b) => a.item.y - b.item.y)[0];
}

/** The printed words of the section header a box sits under ("" when none). */
export function sectionTitleOf(headers: Array<{ item: TextItem; party: Party }>, s: Omit<Slot, "party" | "id">): string {
  return headerAbove(headers, s)?.item.str.replace(/\s+/g, " ").trim() ?? "";
}

/** Which printed section a box sits in, as a stable id ("" = none) — so the company's phone,
 *  email and address land in the SAME block as its name, not one in APPLICANT and one in CONTRACTOR. */
export function sectionOf(headers: Array<{ item: TextItem; party: Party }>, s: Omit<Slot, "party" | "id">): string {
  const h = headerAbove(headers, s);
  return h ? `${h.item.page}:${Math.round(h.item.x)}:${Math.round(h.item.y)}` : "";
}

/** Which side of the form a data key is: the row's homeowner/site, the company's boilerplate, or
 *  neither (a permit number, a date, a reason, a custom key). */
const ROW_KEYS = new Set(["name", "street", "city", "state", "zip"]);
const COMPANY_KEYS = new Set(["installer", "mailingAddress", "phone", "email"]);
/** Synonyms too generic to use outside a party that owns them ("Address:" alone is the company's
 *  address only inside the contractor block). */
const SECTION_ONLY: Record<string, Record<string, Party[]>> = {
  street: { address: ["site", "owner"] },
  // A contact or agent row's "NAME" is a person's; the company goes in its "Company" box.
  installer: { name: ["contractor", "applicant"] },
  mailingAddress: { address: ["contractor", "applicant", "agent"] },
};

export function keyAllowsParty(key: string, party: Party | null, synonym: string): boolean {
  if (party === "office" || party === "fees") return false;
  const only = SECTION_ONLY[key]?.[synonym];
  if (only) return party != null && only.includes(party);
  // A synonym that names the party itself ("applicant name") is the box it means.
  if (party && partyOfWords(slotTokens(synonym)) === party) return true;
  if (ROW_KEYS.has(key)) return party == null || party === "owner" || party === "site";
  if (COMPANY_KEYS.has(key)) return party == null || party === "contractor" || party === "applicant" || party === "agent";
  // The owner signs and dates their own block; the operator's date never does it for them.
  if (key === "date") return party !== "owner";
  return true;
}

function partyRank(key: string, party: Party | null): number {
  if (ROW_KEYS.has(key)) return party === "owner" || party === "site" ? 0 : 1;
  if (COMPANY_KEYS.has(key)) return party === "contractor" ? 0 : party === "applicant" ? 1 : party === "agent" ? 2 : 3;
  return 0;
}

/** Rule 4: a combined "City/State/ZIP" box (two or more of the three words). */
export function isCombinedCityStateZip(label: string): boolean {
  const w = new Set(slotTokens(label));
  return ["city", "state", "zip"].filter((k) => w.has(k)).length >= 2;
}

/** "Sampleton, OR 97999" from whichever of city/state/zip the data carries. */
export function combinedCityStateZip(data: Record<string, string>): string {
  const city = String(data.city ?? "").trim();
  const tail = [String(data.state ?? "").trim(), String(data.zip ?? "").trim()].filter(Boolean).join(" ");
  return [city, tail].filter(Boolean).join(", ");
}

export interface SlotPick { key: string; value: string; slot: Slot; synonym: string }

/**
 * Pick one box per data key (the company's values once more in each further company block, #447 below).
 * Candidates rank by synonym order (the most specific label the form
 * prints wins: "Construction address:" over a bare "Address:"), then — for the company's values —
 * the block its first value went in, then party fit (the contractor's "Phone:" over an unlabelled
 * one), then fewest extra words, then reading order (page, top to bottom, left to right). `accept`
 * may refuse a pick (a flat placement that would overprint the form); the next candidate is tried.
 */
export function pickSlots(
  slots: Slot[],
  data: Record<string, string>,
  synonyms: Record<string, string[]>,
  accept: (pick: SlotPick) => boolean = () => true,
): SlotPick[] {
  const used = new Set<string>();
  const picks: SlotPick[] = [];
  let combinedFilled = false;
  // The block the first company value landed in; the rest of the company's values prefer it.
  let companySection: string | null = null;
  /** The boxes a key's value may go in, best first; `inSection` keeps them to one printed block. */
  const candidates = (key: string, inSection?: string): Array<{ slot: Slot; synonym: string }> => {
    const cands = synonyms[key] ?? [key];
    const ranked: Array<{ slot: Slot; synonym: string; rank: number[] }> = [];
    for (const slot of slots) {
      if (used.has(slot.id) || isAuthorityLabel(slot.label)) continue;
      if (inSection != null && (slot.section ?? "") !== inSection) continue;
      const combined = isCombinedCityStateZip(slot.label);
      if (combined && key !== "city") continue;
      let best: { i: number; extra: number } | null = null;
      if (combined) best = { i: 0, extra: 0 };
      else {
        for (let i = 0; i < cands.length; i++) {
          const extra = matchSynonym(cands[i], slot.label, { printed: Boolean(slot.item) });
          if (extra == null || !keyAllowsParty(key, slot.party, cands[i])) continue;
          // A date label with more words is another date ("Expiration date", "Date of birth").
          if (key === "date" && extra > 0) continue;
          best = { i, extra };
          break;
        }
      }
      if (!best) continue;
      if (combined && !keyAllowsParty(key, slot.party, "city")) continue;
      ranked.push({ slot, synonym: combined ? "city/state/zip" : cands[best.i], rank: [best.i, COMPANY_KEYS.has(key) && companySection != null && (slot.section ?? "") !== companySection ? 1 : 0, partyRank(key, slot.party), best.extra, slot.page, -slot.y, slot.x] });
    }
    ranked.sort((a, b) => {
      for (let i = 0; i < a.rank.length; i++) if (a.rank[i] !== b.rank[i]) return a.rank[i] - b.rank[i];
      return 0;
    });
    return ranked;
  };
  /** Fill the first candidate `accept` takes; null when none. */
  const take = (key: string, value: string, ranked: Array<{ slot: Slot; synonym: string }>): SlotPick | null => {
    for (const r of ranked) {
      const combined = isCombinedCityStateZip(r.slot.label);
      const pick: SlotPick = { key, value: combined ? combinedCityStateZip(data) : value, slot: r.slot, synonym: r.synonym };
      if (!accept(pick)) continue;
      used.add(r.slot.id);
      picks.push(pick);
      if (combined) combinedFilled = true;
      return pick;
    }
    return null;
  };
  for (const [key, raw] of Object.entries(data)) {
    const value = String(raw ?? "").trim();
    if (!value) continue;
    if ((key === "state" || key === "zip") && combinedFilled) continue;
    const pick = take(key, value, candidates(key));
    if (pick && COMPANY_KEYS.has(key) && companySection == null) companySection = pick.slot.section ?? "";
  }
  // MORE THAN ONE COMPANY BLOCK (issue #447). City of Tigard prints an APPLICANT block and a
  // CONTRACTOR block, each asking for a "Business name:", an address and a phone; the company is
  // both, so both get its values. Another printed block is the company's only when its own name
  // box reads as the contractor's — a business/company/contractor name by its label, or a "Name:"
  // under a CONTRACTOR header. A bare "Name:" under APPLICANT (Yamhill County) may be the
  // homeowner's, so that block stays as the operator left it. Owner, office and fee blocks never
  // take a company value (keyAllowsParty), and each value stays inside the block its name went in.
  if (companySection && String(data.installer ?? "").trim()) {
    const order = [...slots].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
    const blocks = [...new Set(order.map((s) => s.section ?? ""))].filter((b) => b && b !== companySection);
    for (const block of blocks) {
      // The block's own header ("CONTRACTOR:") is printed in the block above it, not a box there.
      const company = candidates("installer", block).filter((r) => r.slot.party === "contractor" && !headerParty(r.slot.label));
      if (!company.length || !take("installer", String(data.installer).trim(), company)) continue;
      for (const [key, raw] of Object.entries(data)) {
        const value = String(raw ?? "").trim();
        if (key === "installer" || !COMPANY_KEYS.has(key) || !value) continue;
        take(key, value, candidates(key, block));
      }
    }
  }
  return picks;
}
