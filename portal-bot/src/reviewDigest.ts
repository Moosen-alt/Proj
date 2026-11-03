// #436 — THE STAGED DRAFT'S REVIEW DIGEST: THE ONE READER.
//
// After a NEM Stage stops at review, a named person will (PR2) approve the draft from a masked
// picture and a list of what its pages say, and a second run will click Submit only on pages that
// still say exactly that. PR1 builds the reading and records it; nothing clicks on it.
//
// WHY A NEW READER. reviewScreenScraper's scrapeReviewScreen cannot be reused: it drops empty values,
// unchecked boxes and repeated rows, keeps only two-cell rows and masks digits. A digest must see
// all of those — an emptied box or an unticked attestation is exactly the change it exists to catch.
//
// WHAT IS READ, PER PAGE (readDigestPageInPage, in the page, read-only):
//   every visible form control, empty ones included; checkboxes as checked / unchecked; each radio
//   group as its chosen option or "(none)"; every ARIA state control (role checkbox / radio / switch,
//   aria-checked / aria-pressed / aria-selected — a styled toggle such as ComEd's mat-button-toggle)
//   with each state it carries, an unknown value kept as written; <dl> pairs; table rows of any
//   width; the visible text lines in order; visible same-origin frames, each read the same way.
//   OPEN SHADOW ROOTS are walked where their hosts stand (controls and text alike). Nothing is
//   excluded by id or class name: only <header>, <nav> and <footer> are skipped, by tag, and only
//   when they hold no control and no label/value row.
// NORMALIZATION: whitespace collapsed; case kept; no NFKC. Repeated labels are counted by ordinal and
//   order is part of the digest. RULING 7 (owner 2026-11-03, "ignore it, don't refuse"): in a text
//   line, <dl> pair or table row that ALSO carries a saved / updated / modified / edited / as-of cue
//   (SELF_CHANGING_CUE), clock-time and date tokens (SELF_CHANGING_TOKEN) are dropped; every other
//   character of that line still counts. A control's value is never touched by it.
// UNREADABLE, BY NAME, NEVER HASHED: the read throws or reads nothing; more than 400 rows or 64 KB;
//   a dialog is open; a visible cross-origin frame; a CLOSED shadow root on the page (found through
//   DevTools — a page script cannot see into one), or no way to check for one; the two reads
//   (DIGEST_READ_GAP_MS apart) disagree.
//   The adapter adds the page-level ones: the page does not read as review, the terminal control is
//   not exactly one or sits in a frame, no draft id.
// MULTI-PAGE (owner ruling 2): the draft's step pages are walked READ-ONLY in a separate page of the
//   run's context — never the window a person submits in — by their step tabs/links only (a GET),
//   never Next / Save / Submit or anything that autosaves. The walk page aborts and counts every
//   request that is not a GET (its own read-only lock; the context's network backstop still judges
//   each GET). A step that cannot be opened by a plain link is named, and the row is unapprovable:
//   a step link the walk will not open (its name or path reads as an action, it opens by a script,
//   it has no name) is NAMED, never dropped; and a walk that opened fewer step pages than the recipe
//   walks (stepsRead + 1 < expectedPages) is refused by that count (the page-count floor).
//   walkStagedDraft takes a DigestNavigator, so a test stubs the whole walk.
// RULE 2: raw values reach Node only to be HMACed here (stagedReviewDigestKey: a scrypt subkey of
//   SESSION_ENCRYPTION_KEY, and the row's own nonce), then dropped. Labels and display values pass
//   redactSecretValues, then redactCaptureText. With no key, nothing is hashed and the row is
//   unapprovable. The draft id and review link are the exception: PR2 binds them, so they are kept
//   EXACTLY as the portal gave them or refused by name (stagedDraftReference: by shape, the link's own
//   id, no project secret, no email) — never masked.
import crypto from "node:crypto";
import fs from "node:fs";
import type { CDPSession, Locator, Page } from "playwright";
import { redactSecretValues } from "../../shared/src/portalSafety";
import type {
  RecipeSelector, StagedReviewAttachment, StagedReviewCapture, StagedReviewFieldReportRow, StagedReviewItem, StagedReviewItemKind, StagedReviewSection,
} from "../../shared/src/types";
import { maskId, redactCaptureText } from "./safeAction";
import { draftReferenceFromUrl } from "./adapters/submissionLedger";
import { stagedDraftReference } from "./stagedDraftReference";
import { dialogsLeftToPerson } from "./personDialogs";
import { recordNumberCandidates } from "./recordNumber";

export const REVIEW_DIGEST_VERSION = 1;
/** More rows than this on one page and the page is refused ("over the cap"), never hashed. */
export const DIGEST_MAX_ROWS = 400;
/** More text than this on one page and the page is refused. */
export const DIGEST_MAX_BYTES = 64 * 1024;
/** The two reads of one page are this far apart (design §2: 1.5 s). */
export const DIGEST_READ_GAP_MS = 1500;
/** More step links than this and the walk is refused (a list of every application is not a draft's tabs). */
export const DIGEST_MAX_STEPS = 25;
/** A label kept in the row is at most this long. */
const LABEL_MAX = 80;

// ---------------------------------------------------------------------------------------------
// RULING 7 — self-changing timestamps. PINNED in reviewDigest.test.ts; the PR lists this pattern.
// ---------------------------------------------------------------------------------------------

/** The cue: a line that says when the page was last saved / updated / modified / edited, or "as of". */
export const SELF_CHANGING_CUE = /\b(?:saved|updated|modified|edited)\b|\bas\s+of\b/i;
const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAY = "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)";
const ISO_DATE = "\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{1,2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})?)?";
const NUMERIC_DATE = "\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}";
const MONTH_DATE = `(?:${WEEKDAY},?\\s+)?${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?`;
const DAY_MONTH = `(?:${WEEKDAY},?\\s+)?\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\.?(?:,?\\s+\\d{4})?`;
const CLOCK = "\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s*[ap]\\.?\\s?m\\.?)?";
const HOUR_AMPM = "\\d{1,2}\\s*[ap]\\.?\\s?m\\.?";
/** The tokens dropped from a cue line: clock times and dates, nothing else. */
export const SELF_CHANGING_TOKEN = new RegExp(`\\b(?:${ISO_DATE}|${NUMERIC_DATE}|${MONTH_DATE}|${DAY_MONTH}|${CLOCK}|${HOUR_AMPM})(?![\\w/:])`, "gi");
/** What a dropped token becomes (so "saved ⟨time⟩" still differs from "saved"). */
export const SELF_CHANGING_PLACEHOLDER = "\u27e8time\u27e9";

/** Ruling 7, applied to one line: unchanged unless the line carries the cue. */
export function dropSelfChangingTimestamps(line: string): string {
  const s = String(line ?? "");
  if (!SELF_CHANGING_CUE.test(s)) return s;
  return s.replace(SELF_CHANGING_TOKEN, SELF_CHANGING_PLACEHOLDER);
}

/** Whitespace collapsed and trimmed; case kept; no NFKC. */
export function normalizeDigestText(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------------------------
// The key (rule 2)
// ---------------------------------------------------------------------------------------------

const KEY_PLACEHOLDER = "replace-with-a-long-random-secret";
const KEY_SALT = "solar-autopilot/staged-review-digest/v1";
export interface DigestKey { key: Buffer; keyId: string }
let cachedKey: { secret: string; value: DigestKey } | null = null;

/** The digest's HMAC subkey: scrypt over SESSION_ENCRYPTION_KEY with a fixed salt (a low-entropy
 *  passphrase is not brute-forceable from a leaked row), cached per process. keyId is an HMAC of a
 *  fixed string under the subkey — never a hash of the passphrase. null when the key is unset or
 *  still the .env.example placeholder: nothing is hashed then. */
export function stagedReviewDigestKey(env: Record<string, string | undefined> = process.env): DigestKey | null {
  const secret = String(env.SESSION_ENCRYPTION_KEY ?? "");
  if (!secret || secret === KEY_PLACEHOLDER) return null;
  if (cachedKey && cachedKey.secret === secret) return cachedKey.value;
  const key = crypto.scryptSync(secret, KEY_SALT, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const keyId = crypto.createHmac("sha256", key).update("staged-review-digest key id").digest("hex").slice(0, 16);
  const value = { key, keyId };
  cachedKey = { secret, value };
  return value;
}

/** One MAC: hex HMAC-SHA256 of `input`. The builder's `mac` option replaces it (a test's identity swap). */
export type DigestMac = (input: string) => string;
const hmacWith = (key: Buffer): DigestMac => (input) => crypto.createHmac("sha256", key).update(input, "utf8").digest("hex");
const SEP = "\u0000";

// ---------------------------------------------------------------------------------------------
// What a page read returns (raw — it never leaves this module unhashed)
// ---------------------------------------------------------------------------------------------

export interface DigestPageItem {
  kind: Exclude<StagedReviewItemKind, "draft" | "appno">;
  label: string;
  value: string;
}

export interface RawDigestReading {
  title: string;
  url: string;
  items: DigestPageItem[];
  /** "" = read; otherwise why not, by name. */
  unreadable: string;
}

const unreadableReading = (url: string, why: string): RawDigestReading => ({ title: "", url, items: [], unreadable: why });

interface InPageReading {
  title: string;
  items: Array<{ kind: string; label: string; value: string }>;
  lines: string[];
  dialogOpen: boolean;
}

/** Runs IN THE PAGE (each frame): every visible control, pair, row and text line, raw. Read-only —
 *  it never writes to the document. Needs the __name shim (installed by readDigestPage first). */
export function readDigestPageInPage(): InPageReading {
  const clean = (s: unknown): string => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const shown = (el: Element | null): boolean => {
    if (!el || typeof (el as HTMLElement).getBoundingClientRect !== "function") return false;
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el as HTMLElement);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };
  // EVERY ELEMENT IN TREE ORDER, each OPEN SHADOW ROOT walked where its host stands (a web
  // component's input is a control like any other). A closed shadow root cannot be read from the
  // page at all: readDigestPage finds those through DevTools and refuses the page by name.
  const all: Element[] = [];
  const shadows: ShadowRoot[] = [];
  const collect = (root: Document | ShadowRoot | Element): void => {
    for (const el of Array.from(root.children)) {
      all.push(el);
      const sr = (el as HTMLElement).shadowRoot;
      if (sr) { shadows.push(sr); collect(sr); }
      collect(el);
    }
  };
  collect(document);
  /** The parent, across a shadow boundary (a shadow root's top element → its host). */
  const up = (n: Element): Element | null => n.parentElement || ((n.parentNode as ShadowRoot | null)?.host ?? null);
  const rootOf = (el: Element): Document | ShadowRoot => el.getRootNode() as Document | ShadowRoot;
  const byId = (el: Element, id: string): Element | null => {
    const r = rootOf(el) as { getElementById?: (i: string) => Element | null };
    return typeof r.getElementById === "function" ? r.getElementById(id) : null;
  };
  const labelFor = (el: Element): Element | null => {
    const id = el.getAttribute("id");
    if (!id) return null;
    try { return rootOf(el).querySelector(`label[for="${CSS.escape(id)}"]`); } catch { return null; }
  };
  // ARIA STATE CONTROLS: a styled toggle (role=radio / checkbox / switch, aria-checked, aria-pressed,
  // aria-selected) carries its state in an attribute, not in a native input. Native controls are read
  // natively, never twice.
  const NATIVE = /^(INPUT|SELECT|TEXTAREA|OPTION)$/;
  const ARIA_ROLE = /^(checkbox|radio|switch|menuitemcheckbox|menuitemradio)$/i;
  const isAria = (el: Element): boolean => !NATIVE.test(el.tagName)
    && (el.hasAttribute("aria-checked") || el.hasAttribute("aria-pressed") || el.hasAttribute("aria-selected") || ARIA_ROLE.test(String(el.getAttribute("role") || "").trim()));
  const holdsRow = (e: Element): boolean => /^(INPUT|SELECT|TEXTAREA|DL|TABLE)$/.test(e.tagName) || isAria(e);
  const within = (e: Element, c: Element): boolean => { for (let n = up(e); n; n = up(n)) if (n === c) return true; return false; };
  // <header>/<nav>/<footer> are skipped only when they hold no control and no label/value row
  // (searched across open shadow roots too).
  const holdsCache = new Map<Element, boolean>();
  const chromeOnly = (el: Element): boolean => {
    for (let n: Element | null = el; n && n !== document.body; n = up(n)) {
      const t = n.tagName;
      if (t === "HEADER" || t === "NAV" || t === "FOOTER") {
        let holds = holdsCache.get(n);
        if (holds === undefined) {
          const c = n;
          holds = all.some((e) => e !== c && holdsRow(e) && within(e, c));
          holdsCache.set(n, holds);
        }
        return !holds;
      }
    }
    return false;
  };
  const textOf = (el: Element | null): string => (el ? clean((el as HTMLElement).innerText || el.textContent || "") : "");
  const labelOf = (el: Element): string => {
    let t = textOf(labelFor(el));
    if (!t) t = textOf(el.closest("label"));
    if (!t) {
      const ids = String(el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
      t = clean(ids.map((i) => textOf(byId(el, i))).join(" "));
    }
    if (!t) t = clean(el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("name") || "");
    return t;
  };
  /** An ARIA control's name: aria-labelledby, aria-label, its own text, then the native label rules. */
  const ariaLabelOf = (el: Element): string => {
    const ids = String(el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    let t = clean(ids.map((i) => textOf(byId(el, i))).join(" "));
    if (!t) t = clean(el.getAttribute("aria-label") || "");
    if (!t) t = textOf(el);
    if (!t) t = labelOf(el);
    return t;
  };
  /** Its state, every attribute that carries one; an unknown value is kept as written (never read
   *  as "unchecked", or a "yes" → "no" flip would go unseen). */
  const ariaState = (el: Element): string => {
    const parts: string[] = [];
    const take = (attr: string, on: string, off: string): void => {
      const raw = el.getAttribute(attr);
      if (raw == null) return;
      const v = raw.trim().toLowerCase();
      parts.push(v === "true" ? on : v === "false" ? off : v === "mixed" ? `${attr} mixed` : `${attr} "${clean(raw).slice(0, 24)}"`);
    };
    take("aria-checked", "checked", "unchecked");
    take("aria-pressed", "pressed", "not pressed");
    take("aria-selected", "selected", "not selected");
    return parts.length ? parts.join(", ") : "(no state)";
  };
  const ariaGroupLabel = (el: Element): string => {
    if (!/radio/i.test(String(el.getAttribute("role") || ""))) return "";
    for (let n = up(el); n; n = up(n)) {
      if (n.getAttribute("role") !== "radiogroup") continue;
      const ids = String(n.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
      return clean(ids.map((i) => textOf(byId(n, i))).join(" ")) || clean(n.getAttribute("aria-label") || "") || textOf(n.querySelector("legend"));
    }
    return "";
  };
  const items: Array<{ kind: string; label: string; value: string }> = [];
  const radios = new Map<string, { label: string; chosen: string; at: number }>();
  for (const el of all) {
    const tag = el.tagName;
    if (tag === "DL") {
      if (!shown(el) || chromeOnly(el)) continue;
      let label = "";
      for (const c of Array.from(el.querySelectorAll(":scope > dt, :scope > dd, :scope > div > dt, :scope > div > dd"))) {
        if (c.tagName === "DT") label = textOf(c);
        else items.push({ kind: "pair", label, value: textOf(c) });
      }
      continue;
    }
    if (tag === "TR") {
      if (!shown(el) || chromeOnly(el)) continue;
      const cells = Array.from(el.children).filter((c) => c.tagName === "TD" || c.tagName === "TH").map((c) => textOf(c));
      if (cells.some(Boolean)) items.push({ kind: "row", label: cells[0] || "", value: cells.slice(1).join(" | ") });
      // A selectable row (aria-selected) keeps its cells AND its state.
      if (isAria(el)) items.push({ kind: "check", label: cells[0] || "row", value: ariaState(el) });
      continue;
    }
    if (isAria(el)) {
      if (!shown(el) || chromeOnly(el)) continue;
      const g = ariaGroupLabel(el);
      items.push({ kind: "check", label: `${g ? `${g}: ` : ""}${ariaLabelOf(el)}`, value: ariaState(el) });
      continue;
    }
    if (tag !== "INPUT" && tag !== "SELECT" && tag !== "TEXTAREA") continue;
    const type = String(el.getAttribute("type") || "").toLowerCase();
    if (tag === "INPUT" && (type === "hidden" || type === "submit" || type === "button" || type === "reset" || type === "image" || type === "file" || type === "password")) continue;
    if (chromeOnly(el)) continue;
    if (type === "checkbox" || type === "radio") {
      // A styled box is often the input hidden behind its label: shown when either is.
      const lab = labelFor(el) || el.closest("label");
      if (!shown(el) && !shown(lab)) continue;
      if (type === "checkbox") {
        items.push({ kind: "check", label: labelOf(el), value: (el as HTMLInputElement).checked ? "checked" : "unchecked" });
        continue;
      }
      // A radio group is its name within ITS tree (two web components may both name a group "agg").
      const name = `${shadows.indexOf(rootOf(el) as ShadowRoot) + 1}:${String(el.getAttribute("name") || "") || `radio-${items.length}`}`;
      const fset = el.closest("fieldset");
      const group = el.closest('[role="radiogroup"]');
      const groupLabel = (fset ? textOf(fset.querySelector("legend")) : "") || (group ? clean(group.getAttribute("aria-label") || "") : "") || String(el.getAttribute("name") || "") || `radio-${items.length}`;
      let g = radios.get(name);
      if (!g) {
        g = { label: groupLabel, chosen: "(none)", at: items.length };
        radios.set(name, g);
        items.push({ kind: "radio", label: groupLabel, value: "" });
      }
      if ((el as HTMLInputElement).checked) g.chosen = labelOf(el) || String((el as HTMLInputElement).value || "");
      continue;
    }
    if (!shown(el)) continue;
    let value = "";
    if (tag === "SELECT") value = Array.from((el as HTMLSelectElement).selectedOptions).map((o) => clean(o.text)).join(" | ");
    else value = String((el as HTMLInputElement).value ?? "");
    items.push({ kind: "field", label: labelOf(el), value: clean(value) });
  }
  for (const g of radios.values()) items[g.at] = { kind: "radio", label: g.label, value: g.chosen };
  // The visible text lines, in order — minus the lines of a chrome-only <header>/<nav>/<footer>.
  let lines = String(document.body ? document.body.innerText || "" : "").split("\n").map(clean).filter(Boolean);
  for (const c of Array.from(document.querySelectorAll("header, nav, footer"))) {
    if (!chromeOnly(c)) continue;
    let nested = false;
    for (let p = c.parentElement; p; p = p.parentElement) if (p.tagName === "HEADER" || p.tagName === "NAV" || p.tagName === "FOOTER") nested = true;
    if (nested) continue;
    for (const l of String((c as HTMLElement).innerText || "").split("\n").map(clean).filter(Boolean)) {
      const at = lines.indexOf(l);
      if (at >= 0) lines = lines.slice(0, at).concat(lines.slice(at + 1));
    }
  }
  // OPEN SHADOW ROOTS' TEXT: body.innerText leaves a shadow tree's text out (Chromium), so each open
  // root's rendered text is read too, root by root in tree order (nested roots are roots of their own).
  const shadowText = (n: Node, out: string[], host: Element): void => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === 3) {
        const t = clean(c.textContent);
        const hs = getComputedStyle(host as HTMLElement);
        if (t && hs.display !== "none" && hs.visibility !== "hidden") out.push(t);
        continue;
      }
      if (c.nodeType !== 1) continue;
      const e = c as HTMLElement;
      if (/^(STYLE|SCRIPT|TEMPLATE|LINK|META)$/.test(e.tagName)) continue;
      if (e.tagName === "SLOT" && (e as unknown as HTMLSlotElement).assignedNodes().length) continue; // light DOM, read already
      if (e.tagName === "SLOT" || getComputedStyle(e).display === "contents") { shadowText(e, out, host); continue; }
      if (!shown(e) || chromeOnly(e)) continue;
      for (const l of String(e.innerText || "").split("\n").map(clean).filter(Boolean)) out.push(l);
    }
  };
  for (const sr of shadows) shadowText(sr, lines, sr.host);
  let dialogOpen = false;
  for (const d of all) {
    if (d.matches('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]') && shown(d)) { dialogOpen = true; break; }
  }
  return { title: clean(document.title), items, lines, dialogOpen };
}

/** A page's items as one reading — or refused by name: it reads nothing, or it is over the cap
 *  (more than DIGEST_MAX_ROWS rows, or DIGEST_MAX_BYTES of text). Never hashed then. Pure. */
export function finishDigestReading(url: string, title: string, items: DigestPageItem[]): RawDigestReading {
  if (!items.length) return unreadableReading(url, "the page reads nothing");
  if (items.length > DIGEST_MAX_ROWS) return unreadableReading(url, `the page holds more than ${DIGEST_MAX_ROWS} rows (${items.length})`);
  const bytes = items.reduce((n, it) => n + it.label.length + it.value.length, 0);
  if (bytes > DIGEST_MAX_BYTES) return unreadableReading(url, `the page holds more than ${DIGEST_MAX_BYTES / 1024} KB of text`);
  return { title, url, items, unreadable: "" };
}

const SHIM = "globalThis.__name = globalThis.__name || function (fn) { return fn; };";
const originOf = (u: string): string => { try { return new URL(u).origin; } catch { return ""; } };
const whereOf = (u: string): string => { try { const x = new URL(u); return `${x.origin}${x.pathname}`; } catch { return ""; } };

interface CdpDomNode { shadowRootType?: string; children?: CdpDomNode[]; shadowRoots?: CdpDomNode[]; contentDocument?: CdpDomNode }

/** How many CLOSED shadow roots the page holds (its same-process frames included), through a
 *  short-lived DevTools session: a page script cannot see into one, so neither can the reader. A
 *  browser's own (user-agent) roots — a date input's, a video's — are not counted. null = could not
 *  be checked. Read-only: DOM.getDocument inspects; it dispatches nothing to the page. */
export async function closedShadowRootCount(page: Page): Promise<number | null> {
  let session: CDPSession | null = null;
  try {
    session = await page.context().newCDPSession(page);
    const doc = await session.send("DOM.getDocument", { depth: -1, pierce: true }) as unknown as { root: CdpDomNode };
    let n = 0;
    const stack: CdpDomNode[] = [doc.root];
    while (stack.length) {
      const x = stack.pop()!;
      if (x.shadowRootType === "closed") n++;
      for (const c of x.children ?? []) stack.push(c);
      for (const r of x.shadowRoots ?? []) stack.push(r);
      if (x.contentDocument) stack.push(x.contentDocument);
    }
    return n;
  } catch {
    return null;
  } finally {
    await session?.detach().catch(() => null);
  }
}

/** Read one page for the digest (its main frame and every visible same-origin frame). Never throws:
 *  a failure is an unreadable reading, by name. `dialogSeen` reports a native dialog the walk page
 *  dismissed since its last navigation. A page holding a CLOSED shadow root (or one that cannot be
 *  checked for them) is unreadable: its controls are out of a page script's reach. */
export async function readDigestPage(page: Page, opts: { dialogSeen?: () => boolean } = {}): Promise<RawDigestReading> {
  let url = "";
  try { url = String(page.url() ?? ""); } catch { url = ""; }
  try {
    if (opts.dialogSeen?.()) return unreadableReading(url, "a dialog opened on the page");
    const closed = await closedShadowRootCount(page);
    if (closed === null) return unreadableReading(url, "the page could not be checked for closed shadow roots (no DevTools session)");
    if (closed > 0) return unreadableReading(url, `the page holds ${closed} closed shadow root(s), whose controls a page script cannot read`);
    const mainOrigin = originOf(url);
    const main = page.mainFrame();
    await main.evaluate(SHIM).catch(() => null);
    const r = await main.evaluate(readDigestPageInPage) as InPageReading;
    if (r.dialogOpen) return unreadableReading(url, "a dialog is open on the page");
    const items: DigestPageItem[] = [];
    const take = (src: InPageReading, prefix: string): void => {
      for (const it of src.items) items.push({ kind: it.kind as DigestPageItem["kind"], label: `${prefix}${it.label}`, value: it.value });
      for (const l of src.lines) items.push({ kind: "line", label: prefix, value: l });
    };
    take(r, "");
    let k = 0;
    for (const frame of page.frames()) {
      if (frame === main) continue;
      const fe = await frame.frameElement().catch(() => null);
      const box = fe ? await fe.boundingBox().catch(() => null) : null;
      if (!box || box.width < 2 || box.height < 2) continue;
      const fu = String(frame.url() ?? "");
      if (fu && !/^about:/i.test(fu) && originOf(fu) !== mainOrigin) {
        let host = "";
        try { host = new URL(fu).host; } catch { host = "another site"; }
        return unreadableReading(url, `a cross-origin frame (${host}) is on the page`);
      }
      k++;
      await frame.evaluate(SHIM).catch(() => null);
      const fr = await frame.evaluate(readDigestPageInPage) as InPageReading;
      if (fr.dialogOpen) return unreadableReading(url, "a dialog is open in a frame on the page");
      take(fr, `frame ${k}: `);
    }
    return finishDigestReading(url, r.title, items);
  } catch (e) {
    return unreadableReading(url, `the page could not be read (${String((e as { message?: string })?.message ?? e).replace(/\s+/g, " ").slice(0, 80)})`);
  }
}

// ---------------------------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------------------------

export interface DigestStepLink {
  label: string;
  /** The absolute link ("" when the step opens by a script, not a link). */
  href: string;
  navigable: boolean;
  /** Why it is not navigable (named in the row). */
  why: string;
}

/** Everything the walk does to a browser — stubbed by a test. */
export interface DigestNavigator {
  /** Open the review page by its link (a GET) in the walk page. "" = opened; else why not. */
  openReview(): Promise<string>;
  /** Read the page the walk page is on now. */
  read(): Promise<RawDigestReading>;
  /** The step tabs/links on the page the walk page is on now (read-only). */
  stepLinks(): Promise<DigestStepLink[]>;
  /** Open one step by its link (a GET). "" = opened; else why not. */
  openStep(link: DigestStepLink): Promise<string>;
  /** Requests the walk page tried to send that were not a GET (each aborted). */
  writesBlocked(): number;
  sleep(ms: number): Promise<void>;
  close(): Promise<void>;
  /** Why the walk must not start at all ("" or absent = it may). Named in the row. */
  refusal?(): string;
}

export interface DigestWalkSection {
  step: string;
  where: string;
  first: RawDigestReading;
  second: RawDigestReading | null;
  /** "" = both reads taken; otherwise why the step could not be opened or read. */
  unreadable: string;
}

export interface DigestWalk {
  sections: DigestWalkSection[];
  /** Walk-level reasons the row is not approvable (a step that opens by a script, writes blocked...). */
  reasons: string[];
  stepsFound: number;
  stepsRead: number;
  writesBlocked: number;
  /** The review page's own link (where the walk opened it). */
  reviewUrl: string;
}

/**
 * WALK THE STAGED DRAFT READ-ONLY. Opens the review page by its link, reads it twice, runs
 * `atReview` there (the adapter's page-level checks and the masked picture), then opens each step
 * by its link and reads it twice. A step link the walk will not open is named (never skipped).
 * `expectedPages` is how many pages the recipe walks: a recipe of more than one page whose review
 * page offers no step link cannot be compared beyond the review page, and says so; nor can one
 * whose review page opened fewer step pages than the recipe walked (the page-count floor). Never throws.
 */
export async function walkStagedDraft(nav: DigestNavigator, opts: {
  reviewUrl: string;
  gapMs?: number;
  expectedPages?: number;
  maxSteps?: number;
  atReview?: (reading: RawDigestReading) => Promise<string[]>;
}): Promise<DigestWalk> {
  const gap = Math.max(0, opts.gapMs ?? DIGEST_READ_GAP_MS);
  const reasons: string[] = [];
  const sections: DigestWalkSection[] = [];
  let stepsFound = 0;
  let stepsRead = 0;
  const readTwice = async (step: string, where: string): Promise<DigestWalkSection> => {
    const first = await nav.read();
    if (first.unreadable) return { step, where, first, second: null, unreadable: first.unreadable };
    await nav.sleep(gap);
    const second = await nav.read();
    return { step, where, first, second, unreadable: second.unreadable };
  };
  try {
    const refused = nav.refusal?.() ?? "";
    const opened = refused ? "" : await nav.openReview();
    if (refused) {
      reasons.push(refused);
      sections.push({ step: "review", where: whereOf(opts.reviewUrl), first: unreadableReading(opts.reviewUrl, refused), second: null, unreadable: refused });
    } else if (opened) {
      reasons.push(`the review page does not reopen by its link (${opened})`);
      sections.push({ step: "review", where: whereOf(opts.reviewUrl), first: unreadableReading(opts.reviewUrl, opened), second: null, unreadable: opened });
    } else {
      const review = await readTwice("review", whereOf(opts.reviewUrl));
      sections.push(review);
      if (opts.atReview) {
        try { reasons.push(...await opts.atReview(review.first)); } catch (e) { reasons.push(`the review page's checks could not run (${String((e as { message?: string })?.message ?? e).slice(0, 60)})`); }
      }
      const links = await nav.stepLinks().catch(() => [] as DigestStepLink[]);
      stepsFound = links.length;
      if (links.length > (opts.maxSteps ?? DIGEST_MAX_STEPS)) {
        reasons.push(`the review page offers ${links.length} step links, more than a draft's tabs (${opts.maxSteps ?? DIGEST_MAX_STEPS})`);
      } else {
        if (!links.length && (opts.expectedPages ?? 1) > 1) {
          reasons.push(`the draft's other ${(opts.expectedPages ?? 1) - 1} step page(s) cannot be opened by navigation alone (the review page offers no step links)`);
        }
        for (const link of links) {
          const step = normalizeDigestText(link.label) || "(unnamed step)";
          if (!link.navigable) {
            const why = `step "${step.slice(0, 40)}" cannot be opened by navigation alone (${link.why || "no link"})`;
            reasons.push(why);
            sections.push({ step, where: "", first: unreadableReading("", why), second: null, unreadable: why });
            continue;
          }
          const went = await nav.openStep(link);
          if (went) {
            const why = `step "${step.slice(0, 40)}" did not open by its link (${went})`;
            reasons.push(why);
            sections.push({ step, where: whereOf(link.href), first: unreadableReading(link.href, went), second: null, unreadable: why });
            continue;
          }
          stepsRead++;
          sections.push(await readTwice(step, whereOf(link.href)));
        }
        // THE PAGE-COUNT FLOOR: the recipe walked `expectedPages` pages (the review page among them);
        // fewer step pages opened than that is a draft not read in full, whatever the links said.
        const expected = opts.expectedPages ?? 1;
        if (links.length && stepsRead + 1 < expected) {
          reasons.push(`the recipe walks ${expected} page(s) but only ${stepsRead} step page(s) besides the review page could be opened by navigation alone`);
        }
      }
    }
  } catch (e) {
    reasons.push(`the walk stopped (${String((e as { message?: string })?.message ?? e).replace(/\s+/g, " ").slice(0, 80)})`);
  }
  const writes = nav.writesBlocked();
  if (writes > 0) reasons.push(`the draft's pages tried to send ${writes} request(s) while being read (each was blocked)`);
  await nav.close().catch(() => null);
  return { sections, reasons, stepsFound, stepsRead, writesBlocked: writes, reviewUrl: opts.reviewUrl };
}

// ---------------------------------------------------------------------------------------------
// The digest itself (pure over the walk's readings)
// ---------------------------------------------------------------------------------------------

export interface BuildDigestInput {
  walk: DigestWalk;
  /** The run's known secrets (the project's account / meter numbers and their parser aliases). */
  secrets: readonly string[];
  /** The recipe's bound project fields and this project's values for them ("from <project field>"). */
  boundValues?: ReadonlyArray<{ key: string; value: string }>;
  /** Files this Stage uploaded, with the project file it handed the portal. */
  uploads?: ReadonlyArray<{ fileName: string; docType?: string; filePath?: string }>;
  /** Page-level reasons (from the adapter) beyond the walk's own. */
  reasons?: readonly string[];
  screenshotPath?: string;
  /** TEST SEAMS: the key (null = no key) and the MAC (a test's identity swap). */
  key?: DigestKey | null;
  mac?: DigestMac;
  nonce?: string;
}

/** Labels and display values: the run's secrets first (whole, separators ignored, kept to a last 4),
 *  then the capture redaction (6+ digit runs to their last 4, 5-digit runs whole, emails). */
export function redactDigestText(s: string, secrets: readonly string[], max = LABEL_MAX): string {
  const t = redactSecretValues(String(s ?? ""), secrets, (hit) => maskId(hit.replace(/[^0-9A-Za-z]/g, "")));
  return redactCaptureText(t, 4000).replace(/\s+/g, " ").trim().slice(0, max);
}

const normalizedValue = (it: DigestPageItem): string => {
  const v = normalizeDigestText(it.value);
  if (it.kind === "line" || it.kind === "pair" || it.kind === "row") {
    // Ruling 7: the cue may sit in the label ("Last Updated") and the token in the value.
    const label = normalizeDigestText(it.label);
    return SELF_CHANGING_CUE.test(label) ? v.replace(SELF_CHANGING_TOKEN, SELF_CHANGING_PLACEHOLDER) : dropSelfChangingTimestamps(v);
  }
  return v;
};

const sameValue = (a: string, b: string): boolean => normalizeDigestText(a).toLowerCase() === normalizeDigestText(b).toLowerCase();

/** Build the capture the backend records. Pure over its input (plus fs reads of the uploaded files'
 *  hashes); never throws. */
export function buildStagedReviewCapture(input: BuildDigestInput): StagedReviewCapture {
  const secrets = (input.secrets ?? []).map((s) => String(s ?? "").trim()).filter((s) => s.length >= 4);
  const key = input.key === undefined ? stagedReviewDigestKey() : input.key;
  const why: string[] = [...input.walk.reasons, ...(input.reasons ?? [])];
  const nonce = input.nonce ?? crypto.randomBytes(16).toString("hex");
  const mac: DigestMac | null = input.mac ?? (key ? hmacWith(key.key) : null);
  if (!mac) why.push("SESSION_ENCRYPTION_KEY is not set, so nothing on the draft's pages could be hashed");
  const red = (s: string, max = LABEL_MAX): string => redactDigestText(s, secrets, max);
  // The draft id and link EXACTLY as the portal gave them, or refused by name (never masked): PR2 binds them.
  const own = draftReferenceFromUrl(input.walk.reviewUrl);
  const ref = stagedDraftReference(own.id, own.link, secrets);
  const reviewLink = ref.reviewLink;
  const draftId = ref.draftId;
  if (ref.refused) why.push(ref.refused);

  const sections: StagedReviewSection[] = [];
  const fieldReport: StagedReviewFieldReportRow[] = [];
  const allText: string[] = [];
  const bound = (input.boundValues ?? []).filter((b) => b.key && normalizeDigestText(b.value));
  const itemMacs = (reading: RawDigestReading): StagedReviewItem[] => {
    const seen = new Map<string, number>();
    const out: StagedReviewItem[] = [];
    for (const it of reading.items) {
      const rawLabel = normalizeDigestText(it.label);
      const k = `${it.kind}${SEP}${rawLabel}`;
      const ordinal = (seen.get(k) ?? 0) + 1;
      seen.set(k, ordinal);
      const label = it.kind === "line" ? `${rawLabel ? `${rawLabel} ` : ""}line near "${red(normalizeDigestText(it.value), 30)}"` : rawLabel;
      out.push({ kind: it.kind, label: red(label), ordinal, mac: mac ? mac([nonce, it.kind, rawLabel, String(ordinal), normalizedValue(it)].join(SEP)) : "" });
    }
    return out;
  };
  for (const s of input.walk.sections) {
    const step = red(s.step || "(unnamed step)");
    if (s.unreadable || !s.second) {
      const reason = s.unreadable || "the page was read only once";
      sections.push({ step, where: s.where, digest: "", items: [], unreadable: reason });
      if (!why.some((w) => w.includes(reason))) why.push(`${step}: ${reason}`);
      continue;
    }
    const a = itemMacs(s.first);
    const b = itemMacs(s.second);
    const differ: string[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i]?.mac !== b[i]?.mac) differ.push((a[i] ?? b[i])?.label || "a row");
      if (differ.length >= 5) break;
    }
    if (!mac || differ.length) {
      const reason = !mac ? "nothing could be hashed" : `the page changed between two reads (${differ.join(", ")})`;
      sections.push({ step, where: s.where, digest: "", items: [], unreadable: reason });
      if (mac) why.push(`${step}: ${reason}`);
      continue;
    }
    const items = a;
    if (s.step === "review") {
      // The application number shown on the review page, by its shape (never kept in clear).
      const text = s.first.items.map((it) => it.value).join("\n");
      const appNo = recordNumberCandidates(text)[0]?.value ?? "";
      if (appNo) items.push({ kind: "appno", label: "application number", ordinal: 1, mac: mac([nonce, "appno", "application number", "1", appNo].join(SEP)) });
      if (draftId) items.push({ kind: "draft", label: "draft id", ordinal: 1, mac: mac([nonce, "draft", "draft id", "1", draftId].join(SEP)) });
    }
    const digest = mac([`v${REVIEW_DIGEST_VERSION}`, nonce, "section", normalizeDigestText(s.step), items.map((i) => i.mac).join(",")].join(SEP));
    sections.push({ step, where: s.where, digest, items, unreadable: "" });
    for (const it of s.first.items) {
      allText.push(it.value.toLowerCase());
      if (it.kind === "line") continue;
      if (fieldReport.length >= 200) continue;
      const src = bound.find((bv) => sameValue(bv.value, it.value));
      fieldReport.push({ label: red(it.label), display: red(it.value), source: src ? src.key : "", step });
    }
  }
  const attachments: StagedReviewAttachment[] = (input.uploads ?? []).map((u) => {
    let sha256 = "";
    try { if (u.filePath) sha256 = crypto.createHash("sha256").update(fs.readFileSync(u.filePath)).digest("hex"); } catch { sha256 = ""; }
    const want = String(u.fileName ?? "").toLowerCase();
    return { name: red(String(u.fileName ?? "")), docType: String(u.docType ?? ""), sha256, listed: !!want && allText.some((t) => t.includes(want)) };
  });
  // RULING 3 (a): the approved Stage's uploads are trusted only while the draft's pages still list each.
  for (const a of attachments) if (!a.listed) why.push(`attachment: ${a.name || "(unnamed file)"} is not listed on the draft's pages`);
  const approvable = !!mac && why.length === 0 && sections.length > 0 && sections.every((s) => !s.unreadable);
  const digest = approvable && mac
    ? mac([`v${REVIEW_DIGEST_VERSION}`, nonce, "draft", draftId, sections.map((s) => s.digest).join(",")].join(SEP))
    : "";
  return {
    version: REVIEW_DIGEST_VERSION,
    keyId: key ? key.keyId : "",
    nonce,
    digest,
    sections,
    draftId,
    reviewLink,
    fieldReport,
    attachments,
    screenshotPath: String(input.screenshotPath ?? ""),
    approvable,
    why: Array.from(new Set(why.map((w) => red(w, 200)))).slice(0, 20),
    walk: { stepsFound: input.walk.stepsFound, stepsRead: input.walk.stepsRead, writesBlocked: input.walk.writesBlocked },
  };
}

/** A capture that says only why nothing could be read (the walk itself failed to start). */
export function unapprovableStagedReview(why: string, reviewUrl = ""): StagedReviewCapture {
  return buildStagedReviewCapture({
    walk: { sections: [], reasons: [why], stepsFound: 0, stepsRead: 0, writesBlocked: 0, reviewUrl },
    secrets: [], key: null,
  });
}

// ---------------------------------------------------------------------------------------------
// The Playwright navigator: a separate page of the run's context, its own read-only lock.
// ---------------------------------------------------------------------------------------------

/** Runs IN THE PAGE: the step tabs / links of a wizard. Only links inside a step-shaped container (a
 *  tablist, or a container whose class or id names steps / a wizard / progress / tabs) that point at
 *  this draft (same origin, and the same path, or a shared query parameter such as PowerClerk's
 *  ProjectId) are candidates; the link to the page being read is that page, already read.
 *  EVERY OTHER CANDIDATE IS RETURNED — none is dropped. One the walk will not open is returned
 *  `navigable: false` with its reason, so the row names it and is not approvable (ruling 2: every step
 *  page is read, or the row says which one was not): a name that reads as an action on a GET (sign
 *  out, delete, withdraw, cancel, new, copy, print, request... and any Next / Save / Submit — even
 *  "Interconnection Request" or "Battery Back-up", which may well be steps: the walk never guesses),
 *  a link whose path names an action, a step that opens by a script or has no link or no name.
 *  What the walk OPENS is unchanged by this: only a named, plain, same-draft link that reads as no
 *  action. Open shadow roots are searched too. */
export function stepLinksInPage(): Array<{ label: string; href: string; navigable: boolean; why: string }> {
  const clean = (s: unknown): string => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const here = new URL(location.href);
  const hereParams = new Set<string>();
  here.searchParams.forEach((v, k) => { if (v) hereParams.add(`${k.toLowerCase()}=${v}`); });
  const hereDir = here.pathname.replace(/\/[^/]*$/, "/");
  const ACTS = /\b(log\s*-?\s*(out|off)|sign\s*-?\s*out|delete|remove|withdraw|cancel|discard|submit|save|next|continue|back|previous|pay|new|create|copy|clone|duplicate|print|download|export|request|send|e-?sign)\b/i;
  const ACT_PATH = /logout|logoff|signout|sign-out|delete|remove|withdraw|cancel|discard|copy|clone/i;
  const STEPPY = /(^|[\s_-])(steps|stepper|step-?nav|step-?list|wizard|progress|tabs|tablist|form-?nav|form-?steps)([\s_-]|$)/i;
  // Every element in tree order, open shadow roots included (a step list inside a web component).
  const all: Element[] = [];
  const collect = (root: Document | ShadowRoot | Element): void => {
    for (const el of Array.from(root.children)) {
      all.push(el);
      const sr = (el as HTMLElement).shadowRoot;
      if (sr) collect(sr);
      collect(el);
    }
  };
  collect(document);
  const containers = all.filter((el) => el.getAttribute("role") === "tablist" || STEPPY.test(String(el.getAttribute("class") || "")) || STEPPY.test(String(el.getAttribute("id") || "")));
  const out: Array<{ label: string; href: string; navigable: boolean; why: string }> = [];
  const seen = new Set<Element>();
  const hrefs = new Set<string>();
  const hereNoHash = new URL(location.href);
  hereNoHash.hash = "";
  const ACTION_WHY = "its name or its link reads as an action, so the walk never opens it";
  for (const c of containers) {
    for (const a of Array.from(c.querySelectorAll('a, [role="tab"]'))) {
      if (seen.has(a)) continue;
      seen.add(a);
      const r = (a as HTMLElement).getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const label = clean((a as HTMLElement).innerText || a.getAttribute("aria-label") || a.getAttribute("title") || "");
      const raw = a.getAttribute("href");
      const scripted = raw == null || raw === "" || /^\s*#/.test(raw) || /^\s*javascript:/i.test(raw);
      let href = "";
      let actPath = false;
      if (!scripted) {
        let u: URL;
        try { u = new URL(String(raw), location.href); } catch { out.push({ label: label || "(unnamed step)", href: "", navigable: false, why: "its link does not parse" }); continue; }
        // Not this draft's page: another site, another scheme, a path and query that share nothing.
        if (!/^https?:$/.test(u.protocol) || u.origin !== here.origin) continue;
        let shares = u.pathname === here.pathname || u.pathname.replace(/\/[^/]*$/, "/") === hereDir;
        u.searchParams.forEach((v, k) => { if (v && hereParams.has(`${k.toLowerCase()}=${v}`)) shares = true; });
        if (!shares) continue;
        u.hash = "";
        href = u.toString();
        // The page being read IS this page (the review page's own "Review and Submit" tab): read already.
        if (href === hereNoHash.toString() || hrefs.has(href)) continue;
        hrefs.add(href);
        actPath = ACT_PATH.test(u.pathname);
      }
      if (ACTS.test(label) || actPath) { out.push({ label: label || "(unnamed step)", href: "", navigable: false, why: ACTION_WHY }); continue; }
      if (!label) { out.push({ label: "(unnamed step)", href: "", navigable: false, why: "it has no name, so the walk never opens it" }); continue; }
      if (scripted) { out.push({ label, href: "", navigable: false, why: raw && /javascript:/i.test(raw) ? "it opens by a script" : "it has no link" }); continue; }
      out.push({ label, href, navigable: true, why: "" });
    }
  }
  return out;
}

/** How many controls the recipe's recorded selector matches on `page` (main frame), by the replay's
 *  own strategy order (role + name, label, placeholder, testId, text, css), then its fallbacks: the
 *  first strategy that finds anything decides. "The terminal control is exactly one" reads this. */
export async function countRecordedControl(page: Page, sel: RecipeSelector | null | undefined): Promise<number> {
  const strategies = (s: RecipeSelector): Array<() => Locator> => {
    const out: Array<() => Locator> = [];
    const exact = s.exact === true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (s.role && s.name) out.push(() => page.getByRole(s.role as any, { name: s.name, exact }));
    if (s.label) out.push(() => page.getByLabel(String(s.label), { exact }));
    if (s.placeholder) out.push(() => page.getByPlaceholder(String(s.placeholder), { exact }));
    if (s.testId) out.push(() => page.getByTestId(String(s.testId)));
    if (s.text) out.push(() => page.getByText(String(s.text), { exact }));
    if (s.css) out.push(() => page.locator(String(s.css)));
    return out;
  };
  if (!sel) return 0;
  const all = [...strategies(sel), ...((sel.fallbacks ?? []) as RecipeSelector[]).flatMap(strategies)];
  for (const make of all) {
    const n = await make().count().catch(() => 0);
    if (n > 0) return n;
  }
  return 0;
}

export interface PlaywrightDigestNavigator extends DigestNavigator {
  /** The walk page itself (the adapter's review-page checks and the masked picture run on it). */
  page: Page;
}

/** The walk page: a NEW page of `runPage`'s context (never the window a person submits in). Every
 *  request that is not a GET / HEAD is aborted and counted; a GET falls back to the context's own
 *  routes (the network backstop still judges it).
 *  A NATIVE DIALOG IS NOTED, NEVER ANSWERED HERE (#381; personDialogs.test pins that product code
 *  answers a dialog only in the approved click's slot, and registers no other `dialog` listener). The
 *  walk page registers none, so Playwright's own default answers a dialog exactly as it does on every
 *  page before a hand-over on main; a CDP session only OBSERVES Page.javascriptDialogOpening (never
 *  Page.handleJavaScriptDialog), and the page it opened on reads as unreadable, by name. A walk whose
 *  dialogs cannot be watched, or whose window already leaves dialogs to a person (one would stall
 *  every read), is refused before it opens anything. */
export async function openPlaywrightDigestNavigator(runPage: Page, reviewUrl: string, opts: { navTimeoutMs?: number } = {}): Promise<PlaywrightDigestNavigator> {
  const ctx = runPage.context();
  const walk = await ctx.newPage();
  let blocked = 0;
  let dialog = false;
  let refusal = dialogsLeftToPerson(runPage)
    ? "the run's window already leaves its dialogs to a person, so a dialog on the draft's pages would stall the walk"
    : "";
  await walk.route("**/*", (route) => {
    const m = route.request().method().toUpperCase();
    if (m === "GET" || m === "HEAD") return route.fallback();
    blocked++;
    return route.abort("blockedbyclient");
  });
  let cdp: { detach(): Promise<void> } | null = null;
  if (!refusal) {
    try {
      const session = await ctx.newCDPSession(walk);
      await session.send("Page.enable");
      session.on("Page.javascriptDialogOpening", () => { dialog = true; });
      cdp = session;
    } catch {
      refusal = "native dialogs on the draft's pages could not be watched (no DevTools session), so the walk did not start";
    }
  }
  const timeout = opts.navTimeoutMs ?? 20_000;
  const go = async (url: string): Promise<string> => {
    dialog = false;
    try {
      const res = await walk.goto(url, { waitUntil: "load", timeout });
      await walk.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => null);
      if (res && res.status() >= 400) return `the portal answered ${res.status()}`;
      return "";
    } catch (e) {
      return String((e as { message?: string })?.message ?? e).split("\n")[0].slice(0, 80);
    }
  };
  return {
    openReview: () => go(reviewUrl),
    read: () => readDigestPage(walk, { dialogSeen: () => dialog }),
    stepLinks: async () => {
      await walk.mainFrame().evaluate(SHIM).catch(() => null);
      return (await walk.evaluate(stepLinksInPage).catch(() => [])) as DigestStepLink[];
    },
    openStep: (link) => go(link.href),
    writesBlocked: () => blocked,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    close: async () => {
      await cdp?.detach().catch(() => null);
      await walk.close().catch(() => null);
      await runPage.bringToFront().catch(() => null);
    },
    refusal: () => refusal,
    page: walk,
  };
}
