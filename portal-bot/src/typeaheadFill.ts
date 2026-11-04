// ---------------------------------------------------------------------------
// FILL A SEARCH-AS-YOU-TYPE BOX BY TYPING AND PICKING THE MATCH (#575).
//
// An editable <input role="combobox" aria-autocomplete="list"> — a city's GIS address search, a
// contractor or parcel lookup — offers its suggestions only AFTER you type, and the form keeps the
// value only once a suggestion is picked. The select path (comboboxFill) was written for the
// opposite widget, PowerClerk's READONLY filtered-select that shows its options on open: on a
// typeahead it opened an empty list, picked nothing, and the value dropped in silence (live
// Cityworks, 2026-11-03: "Location" stayed empty, Next did nothing, the page re-planned until the
// walk gave up).
//
// So, for the learner and the replay alike:
//   1. type the value (an address: house number + street name first, the house number alone only
//      if nothing came back) with real keystrokes — typeaheads listen to key/input events;
//   2. wait, bounded, for the box's OWN list (aria-controls / aria-owns, read document-wide since
//      overlays teleport it to <body>), else a list that was not on screen before typing — never a
//      page-wide row search, which reads the site navigation as suggestions;
//   3. let the one predicate (typeaheadMatch) choose: exactly one match is clicked; a near miss or
//      several equal candidates pick NOTHING and come back as a question for a person;
//   4. read the box back: empty after the pick is a NAMED failure, never a silent drop.
// Never Enter (the form's default button may file); never a containment guess; the box is
// cleared whenever nothing was picked, so no half-typed address is left for the portal to take.
// Every wait has its own bound and the whole fill one deadline; no message says "timeout" (the
// retry wrapper retries on that word and would retype the address four times).
// ---------------------------------------------------------------------------
// Loose typing: adapters hold the Playwright Page/Locator as `any` (see comboboxFill).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { FRESH_POPUP_SELECTORS, clearPopupMarks, markExistingPopups } from "./comboboxFill";
import { withAutomationInput } from "./filingBackstop";
import { addressQueries, chooseAddressSuggestion, chooseExactSuggestion, suggestionText, type TypeaheadSite } from "./typeaheadMatch";

/** What a typeahead fill did. Only "picked" wrote a value the box kept. */
export type TypeaheadOutcome =
  | { outcome: "picked"; picked: string; held: string; typed: string; why: string; adjusted?: string }
  /** A near miss or several equal candidates: nothing picked, the box cleared; ask `question`. */
  | { outcome: "ask"; question: string; offered: string[]; typed: string; why: string }
  | { outcome: "no_suggestions"; why: string; typed: string[] }
  | { outcome: "no_match"; why: string; offered: string[]; typed: string }
  /** A suggestion was clicked and the box does not hold it. */
  | { outcome: "not_held"; why: string; picked: string }
  /** The box cannot be typed into (hidden, read-only, disabled) or there is nothing to type. */
  | { outcome: "unusable"; why: string };

export interface TypeaheadRequest {
  /** The value to enter (the planner's / the recipe's resolved value). */
  value: string;
  /** typeaheadMatch.typeaheadMatchMode: "site" (the job's own address: city/ZIP checked where a
   *  suggestion shows them), "address" (another street address), "exact" (any other lookup). */
  mode: "site" | "address" | "exact";
  /** The job's address for "site" (street, city, ZIP); for "address" only `street` is read. */
  site?: TypeaheadSite;
  /** How long one query waits for its suggestions to settle. Default 5 s. */
  suggestWaitMs?: number;
  /** The whole fill's deadline, every query included. Default 30 s — far inside the walk's stall
   *  watchdog (300 s) and one planner-door click's budget (90 s). */
  budgetMs?: number;
}

const SUGGEST_WAIT_DEFAULT_MS = 5_000;
const TYPEAHEAD_BUDGET_DEFAULT_MS = 30_000;
const NAME_SHIM = "globalThis.__name = globalThis.__name || function (f) { return f; };";

const loose = (s: string): string => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Runs IN THE PAGE. The visible suggestion rows of the box's list, in order, each marked
 * data-al-sugg="<its index>" so the row that was read is the row that is clicked. The list is the
 * one the box names (aria-controls / aria-owns), else the last list that was not on screen before
 * typing (comboboxFill's fresh-popup stamp). No nested functions (esbuild keepNames → __name).
 */
export function readSuggestionsInPage(args: { controlsId: string; fresh: string }): string[] {
  const out: string[] = [];
  const marked = document.querySelectorAll("[data-al-sugg]");
  for (let i = 0; i < marked.length; i++) marked[i].removeAttribute("data-al-sugg");
  const lists: Element[] = [];
  if (args.controlsId) {
    for (const id of args.controlsId.split(/\s+/)) {
      const own = id ? document.getElementById(id) : null;
      if (own) lists.push(own);
    }
  }
  if (!lists.length && args.fresh) {
    const fresh = Array.from(document.querySelectorAll(args.fresh));
    for (let i = fresh.length - 1; i >= 0; i--) lists.push(fresh[i]);
  }
  for (const list of lists) {
    const lr = (list as HTMLElement).getBoundingClientRect();
    const ls = getComputedStyle(list as HTMLElement);
    if (lr.width <= 0 || lr.height <= 0 || ls.visibility === "hidden" || ls.display === "none") continue;
    let rows: Element[] = Array.from(list.querySelectorAll('[role="option"]'));
    if (!rows.length) rows = Array.from(list.querySelectorAll("li"));
    if (!rows.length) rows = Array.from(list.children);
    for (const row of rows) {
      const r = (row as HTMLElement).getBoundingClientRect();
      const s = getComputedStyle(row as HTMLElement);
      if (r.width <= 0 || r.height <= 0 || s.visibility === "hidden" || s.display === "none") continue;
      if (row.getAttribute("aria-disabled") === "true") continue;
      const text = String((row as HTMLElement).innerText || row.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      row.setAttribute("data-al-sugg", String(out.length));
      out.push(text.slice(0, 300));
      if (out.length >= 50) break;
    }
    if (out.length) break; // the first list with rows is the box's list
  }
  return out;
}

/**
 * Runs IN THE PAGE. Whether the box's suggestion panel shows that it is still loading: a visible
 * progress bar, spinner or aria-busy in the list the box names (and up to three of its ancestors,
 * the overlay pane it sits in) or around the box itself. A list that is still loading is not an
 * empty one — a city's GIS search showed its progress bar for longer than the per-query wait, and
 * the fill gave up on a list that was about to answer (#575, live). No nested functions.
 */
export function suggestionsLoadingInPage(args: { controlsId: string }): boolean {
  const roots: Element[] = [];
  if (args.controlsId) {
    for (const id of args.controlsId.split(/\s+/)) {
      let el: Element | null = id ? document.getElementById(id) : null;
      for (let i = 0; i < 4 && el; i++) { roots.push(el); el = el.parentElement; }
    }
  }
  let box: Element | null = document.activeElement;
  for (let i = 0; i < 4 && box && box !== document.body; i++) { roots.push(box); box = box.parentElement; }
  const SEL = '[role="progressbar"], mat-progress-bar, mat-spinner, mat-progress-spinner, [aria-busy="true"], [class*="progress"], [class*="spinner"], [class*="loading"]';
  for (const root of roots) {
    if (root.getAttribute("aria-busy") === "true") return true;
    const found = root.querySelectorAll(SEL);
    for (let i = 0; i < found.length; i++) {
      const el = found[i] as HTMLElement;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0") return true;
    }
  }
  return false;
}

/** Poll until the suggestions hold still (two equal reads in a row) or the wait ends. Returns the
 *  last read, raw (indexes line up with the data-al-sugg marks); [] when nothing real was offered.
 *  While the panel shows it is still loading (suggestionsLoadingInPage) the wait carries on past
 *  its own length, never past the fill's deadline. */
async function settledSuggestions(page: any, controlsId: string, waitMs: number, deadline: number): Promise<string[]> {
  const until = Math.min(Date.now() + waitMs, deadline);
  let prev = "";
  let last: string[] = [];
  let loading = false;
  while (Date.now() < until || (loading && Date.now() < deadline)) {
    await page.waitForTimeout?.(250).catch(() => null);
    const read = await page.evaluate(readSuggestionsInPage, { controlsId, fresh: FRESH_POPUP_SELECTORS }).catch(() => [] as string[]);
    const rows = Array.isArray(read) ? read.map((t) => String(t ?? "")) : [];
    const sig = JSON.stringify(rows);
    if (rows.some((t) => suggestionText(t)) && sig === prev) return rows;
    prev = sig;
    last = rows;
    loading = rows.some((t) => suggestionText(t))
      ? false
      : Boolean(await page.evaluate(suggestionsLoadingInPage, { controlsId }).catch(() => false));
  }
  return last.some((t) => suggestionText(t)) ? last : [];
}

/** Empty the box, and close a list it left open. Never Enter. */
async function clearBox(page: any, loc: any, controlsId: string): Promise<void> {
  await loc.fill("", { timeout: 2000 }).catch(() => null);
  await page.waitForTimeout?.(200).catch(() => null);
  const open = await page.evaluate(readSuggestionsInPage, { controlsId, fresh: FRESH_POPUP_SELECTORS }).catch(() => [] as string[]);
  if (Array.isArray(open) && open.length && typeof loc.press === "function") await loc.press("Escape", { timeout: 1000 }).catch(() => null);
  await page.evaluate(() => { document.querySelectorAll("[data-al-sugg]").forEach((n) => n.removeAttribute("data-al-sugg")); }).catch(() => null);
}

/** The document the box lives in: its own frame (an application rendered in an iframe keeps its
 *  list there too), else the page. Reads, marks and the pick's click all happen in it. */
async function ownerScope(page: any, loc: any): Promise<any> {
  try {
    const h = typeof loc.elementHandle === "function" ? await loc.elementHandle({ timeout: 1500 }) : null;
    const f = h && typeof h.ownerFrame === "function" ? await h.ownerFrame() : null;
    await h?.dispose?.().catch(() => null);
    if (f && typeof f.evaluate === "function" && typeof f.locator === "function") return f;
  } catch { /* the page, as before */ }
  return page;
}

/** Type with real keystrokes (typeaheads listen to key and input events), inside the backstop's
 *  automation fence. Bounded. */
async function typeInto(page: any, loc: any, text: string): Promise<boolean> {
  if (typeof loc.pressSequentially === "function") {
    return withAutomationInput(page, () => loc.pressSequentially(text, { delay: 40, timeout: 10_000 })).then(() => true).catch(() => false);
  }
  return loc.fill(text, { timeout: 4000 }).then(() => true).catch(() => false);
}

/**
 * Fill one typeahead box. Never throws; every outcome but "picked" leaves the box empty.
 */
export async function fillTypeahead(page: any, loc: any, req: TypeaheadRequest): Promise<TypeaheadOutcome> {
  const budgetMs = req.budgetMs && req.budgetMs > 0 ? req.budgetMs : TYPEAHEAD_BUDGET_DEFAULT_MS;
  const deadline = Date.now() + budgetMs;
  const waitMs = req.suggestWaitMs && req.suggestWaitMs > 0 ? req.suggestWaitMs : SUGGEST_WAIT_DEFAULT_MS;
  const value = String(req.value ?? "").replace(/\s+/g, " ").trim();
  if (!page || !loc) return { outcome: "unusable", why: "the box could not be located" };
  if (!value) return { outcome: "unusable", why: "there is no value to type" };
  const visible = await loc.isVisible().catch(() => false);
  const editable = visible && await loc.isEditable({ timeout: 1500 }).catch(() => false);
  if (!editable) return { outcome: "unusable", why: visible ? "the box is read-only or disabled" : "the box is not visible" };
  const controlsId = String((await loc.getAttribute("aria-controls", { timeout: 1500 }).catch(() => null))
    || (await loc.getAttribute("aria-owns", { timeout: 1500 }).catch(() => null)) || "").trim();
  const street = req.site?.street ?? value;
  const queries = req.mode === "exact" ? [value] : addressQueries(street);
  if (!queries.length) return { outcome: "unusable", why: "there is no address to type" };
  const doc = await ownerScope(page, loc);
  await doc.evaluate(NAME_SHIM).catch(() => null);

  const typed: string[] = [];
  let rows: string[] = [];
  let usedQuery = "";
  try {
    for (const q of queries) {
      if (Date.now() >= deadline) break;
      await clearBox(doc, loc, controlsId);
      // Whatever list is on screen now is not this box's answer to what we are about to type.
      await markExistingPopups(doc);
      typed.push(q);
      if (!(await typeInto(page, loc, q))) continue;
      rows = await settledSuggestions(doc, controlsId, waitMs, deadline);
      if (rows.length) { usedQuery = q; break; }
    }
    if (!rows.length) {
      await clearBox(doc, loc, controlsId);
      const over = Date.now() >= deadline ? ` (its ${Math.round(budgetMs / 1000)} s budget ran out)` : "";
      return { outcome: "no_suggestions", why: `typed ${typed.map((t) => `"${t}"`).join(" then ") || "nothing"} and the box offered no suggestions${over}`, typed };
    }
    const offered = rows.map(suggestionText).filter(Boolean);
    const site: TypeaheadSite = req.mode === "site"
      ? { street, city: req.site?.city, zip: req.site?.zip }
      : { street };
    const choice = req.mode === "exact" ? chooseExactSuggestion(rows, value) : chooseAddressSuggestion(rows, site);
    if (choice.kind === "ask") {
      await clearBox(doc, loc, controlsId);
      return { outcome: "ask", question: choice.question, offered, typed: usedQuery, why: choice.why };
    }
    if (choice.kind === "none") {
      await clearBox(doc, loc, controlsId);
      return { outcome: "no_match", why: choice.why, offered, typed: usedQuery };
    }
    // THE ROW THAT WAS READ IS THE ROW THAT IS CLICKED: by its mark, and only while it still says
    // what it said when it was chosen (a list that re-rendered under us is read again, not guessed).
    const row = doc.locator(`[data-al-sugg="${choice.index}"]`).first();
    const now = suggestionText(await row.textContent({ timeout: 1500 }).catch(() => ""));
    if (now !== choice.text || Date.now() >= deadline) {
      await clearBox(doc, loc, controlsId);
      return { outcome: "no_match", why: `the suggestion list changed while it was being read ("${choice.text}" is no longer the row chosen)`, offered, typed: usedQuery };
    }
    const clicked = await withAutomationInput(page, () => row.click({ timeout: 4000 })).then(() => true).catch(() => false);
    if (!clicked) {
      await clearBox(doc, loc, controlsId);
      return { outcome: "not_held", why: `"${choice.text}" could not be clicked in the list`, picked: choice.text };
    }
    // The box holds the pick (as clicked, or re-worded as the same address / the same value). A GIS
    // widget may write the box only after its own round trip (a geocode, a map zoom), so it is read
    // back for up to 2 s before it is judged: a slow but good pick is not called a miss.
    const holds = (h: string): boolean => !!h && (loose(h) === loose(choice.text)
      || (req.mode === "exact" ? loose(h) === loose(value) : chooseAddressSuggestion([h], site).kind === "pick"));
    let held = "";
    const readUntil = Date.now() + 2000;
    for (;;) {
      await page.waitForTimeout?.(200).catch(() => null);
      held = String((await loc.inputValue({ timeout: 1000 }).catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
      if (holds(held) || Date.now() >= readUntil) break;
    }
    if (!held) return { outcome: "not_held", why: `picked "${choice.text}" and the box is empty afterwards`, picked: choice.text };
    const same = holds(held);
    if (!same) {
      await clearBox(doc, loc, controlsId);
      return { outcome: "not_held", why: `picked "${choice.text}" and the box then showed "${held.slice(0, 120)}" — cleared`, picked: choice.text };
    }
    // Commit the way every fill commits (a per-field save on blur).
    if (typeof loc.blur === "function") await loc.blur().catch(() => null);
    return { outcome: "picked", picked: choice.text, held, typed: usedQuery, why: choice.why, ...(choice.kind === "pick" && choice.adjusted ? { adjusted: choice.adjusted } : {}) };
  } finally {
    await clearPopupMarks(doc);
    await doc.evaluate(() => { document.querySelectorAll("[data-al-sugg]").forEach((n) => n.removeAttribute("data-al-sugg")); }).catch(() => null);
  }
}

/** A replay's stop on a typeahead question (#575): never retried, healed or skipped as optional — a
 *  retry re-asks the same list the same question, and a skip would advance without the address. */
export class TypeaheadStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypeaheadStop";
  }
}

/** One operator-readable line for an outcome that picked nothing ("" for "picked"). */
export function typeaheadFailureLine(label: string, o: TypeaheadOutcome): string {
  const name = `"${String(label || "search box").slice(0, 60)}"`;
  switch (o.outcome) {
    case "picked": return "";
    case "ask": return `${name}: ${o.question} Nothing was picked; a person answers this before the application goes on.`;
    case "no_suggestions": return `${name}: ${o.why} — nothing was picked and the box was left empty.`;
    case "no_match": return `${name}: ${o.why} — nothing was picked and the box was left empty.`;
    case "not_held": return `${name}: ${o.why}.`;
    case "unusable": return `${name}: ${o.why} — nothing was typed.`;
  }
}
