// HAS THE PAGE FINISHED COMPUTING? — ONE ANSWER, FOR THE LEARNER AND THE REPLAY (issue #352).
//
// A "Calculate" / "Update Totals" button computes the system's ratings from the equipment just
// entered, and a portal may then SHOW questions that depend on the result. PacifiCorp's PowerClerk
// shows "AC Disconnect Switch Required" as a formula of the computed rating, and only when it turns
// true does it render a required section: "Disconnect Switch Manufacturer" *, "Disconnect Switch
// Model" *, the knife-blade question and the distance-to-meter question.
//
// Both walks clicked Calculate and read the page before the result came back:
//   - the replay went straight on to the advance. Its required-field sweep ran with the button still
//     spinning — the live run's own page shot (2026-10-15, West Lincoln County) shows "Needs to be
//     recalculated" beside a spinner on Calculate — so the section was never seen, the report said
//     `requiredStillEmpty: []`, and Next left four required controls blank;
//   - the learner waited for network idle and its select counts, re-scanned, found nothing new, and
//     stopped; the section rendered a moment later and was swept as required_never_filled.
//
// So "the click returned" is not "the page computed". This waits on what the page itself says:
//   - a short visible marker that the totals are stale ("Needs to be recalculated", "Calculating…");
//   - a visible busy indicator (aria-busy, a spinner, a sized loader);
//   - then the shared settle probe (no fetch/XHR in flight, no DOM mutation for a moment), which is
//     what lets the questions the result reveals finish rendering.
// Bounded: a page whose marker or spinner never clears costs at most `timeoutMs`, and the caller is
// told it did not settle (it reports that, it never treats it as fatal). A page with no marker and no
// spinner costs one read plus the settle's quiet window.
import type { Page } from "playwright";
import { installSettleProbe, waitForSettled } from "./settle";

/** A recorded click that computes totals — the learner records it as "compute totals: <label>"
 *  (autoLearnAdapter clickComputeButton). The replay reads the same words. */
export function isComputeTotalsStep(step: { action?: string | null; note?: string | null }): boolean {
  return step?.action === "click" && /^compute totals\b/i.test(String(step.note ?? "").trim());
}

/** Install the page-side request/mutation probe BEFORE the compute click, so the request the click
 *  starts is counted as in flight. Never throws. */
export async function prepareComputeSettle(page: Page): Promise<void> {
  if (!page || typeof page.evaluate !== "function" || typeof page.addInitScript !== "function") return;
  await installSettleProbe(page).catch(() => null);
}

export interface ComputeSettleResult {
  settled: boolean;
  waitedMs: number;
  /** What was still showing at the timeout, or what was waited on. */
  reason: string;
}

/** What still says "computing" on the page right now: "" when nothing does. Page-side, no closures
 *  over Node values (a plain function the evaluate serializes). Exported for the unit test. */
export function computePendingInPage(): string {
  const shown = (el: Element): boolean => {
    const r = (el as HTMLElement).getBoundingClientRect?.();
    if (!r || r.width <= 4 || r.height <= 4) return false;
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) >= 0.05;
  };
  // THE PORTAL'S OWN WORDS THAT ITS TOTALS ARE STALE. Short own-text only: a paragraph that merely
  // mentions recalculation is prose, not a status.
  const STALE = /^(needs?\s+to\s+be\s+re-?calculated|re-?calculation\s+(is\s+)?(required|needed)|not\s+(yet\s+)?calculated|calculating)\b[\s.…!]*$/i;
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = String(n.nodeValue || "").replace(/\s+/g, " ").trim();
    if (!t || t.length > 40 || !STALE.test(t)) continue;
    const el = n.parentElement;
    if (el && shown(el)) return `"${t}"`;
  }
  // A BUSY INDICATOR. aria-busy and the common spinner classes, matched as whole class TOKENS (a
  // numeric box's "k-spinner-increase" arrows are not a spinner); a "loader" / "loading" box counts
  // only while it holds something (PowerClerk's Calculate loader is an empty, zero-height box when
  // idle). Never a progress bar: a wizard's step progress is always showing.
  for (const el of Array.from(document.querySelectorAll("[aria-busy='true'], .spinner-border, .spinner-grow, .spinner, .fa-spin, .loading-spinner, .loader, .loading"))) {
    if (!shown(el)) continue;
    const cls = String((el as HTMLElement).className || "");
    const box = /(^|\s)(loader|loading)(\s|$)/.test(cls) && !/(^|\s)(spinner|spinner-border|spinner-grow|fa-spin|loading-spinner)(\s|$)/.test(cls);
    if (box && !el.children.length && !((el as HTMLElement).innerText || "").trim()) continue;
    return `busy indicator <${el.tagName.toLowerCase()} class="${cls.slice(0, 60)}">`;
  }
  return "";
}

/**
 * Wait until the page no longer says it is computing, then until it is still. `prepareComputeSettle`
 * should have run before the click. Never throws.
 */
export async function waitForComputeSettled(page: Page, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<ComputeSettleResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const pollMs = opts.pollMs ?? 250;
  const started = Date.now();
  if (!page || typeof page.evaluate !== "function") return { settled: true, waitedMs: 0, reason: "no page to read" };
  // The __name shim: a bundler-named helper inside the page function would otherwise throw, and a
  // throw reads as "not computing" below — the wait would silently do nothing.
  await page.evaluate("globalThis.__name = globalThis.__name || function (f) { return f; };").catch(() => null);
  let pending = "";
  let sawPending = "";
  // A Vue/React click handler shows its spinner on the next tick: one short beat before the first
  // read, so "nothing showing yet" is not read as "already done".
  await new Promise((r) => setTimeout(r, 150));
  for (;;) {
    const read = await page.evaluate(computePendingInPage).catch(() => null);
    // Strict string only: unreadable (a navigation swapping the document, a test fake) is not busy.
    pending = typeof read === "string" ? read : "";
    if (pending && !sawPending) sawPending = pending;
    if (!pending || Date.now() - started >= timeoutMs) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  if (pending) {
    return { settled: false, waitedMs: Date.now() - started, reason: `still showing ${pending} after ${Math.round((Date.now() - started) / 100) / 10}s` };
  }
  // The result is in; let what it reveals finish rendering (and any request it started finish).
  const remaining = Math.max(1_000, Math.min(8_000, timeoutMs - (Date.now() - started)));
  const quiet = typeof page.addInitScript === "function"
    ? await waitForSettled(page, { timeoutMs: remaining, quietMs: 400, maxRequestAgeMs: 20_000 }).catch(() => null)
    : null;
  return {
    settled: true,
    waitedMs: Date.now() - started,
    reason: `${sawPending ? `waited for ${sawPending} to clear` : "nothing showed as computing"}${quiet && !quiet.settled ? `; the page was still changing (${quiet.reason})` : ""}`,
  };
}
