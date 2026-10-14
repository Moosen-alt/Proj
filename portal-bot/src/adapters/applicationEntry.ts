// Portal-AGNOSTIC "where do I start an application?" finder.
//
// After login, every permit portal has one control that begins a NEW application, and every
// vendor names it differently: Accela "Create an Application", Tyler EnerGov "Apply",
// OpenGov "Apply for a permit", SmartGov "Apply Online", Citizenserve "Apply for a Permit",
// BS&A "Apply for a Permit". The learn loop previously found this only via an LLM planner
// call (or, for Accela, a hardcoded pass), so an unknown portal burned tokens — and could
// wander — on a step that is deterministic.
//
// THE DANGEROUS PART IS WHAT IT MUST NOT CLICK. A logged-in portal home is full of controls
// that lead into the OPERATOR'S REAL FILINGS: "Resume Application", "Pay Fees Due",
// "Search Applications", "Renew", "Upload Documents", "My Records". Clicking one of those
// operates on a live submitted permit belonging to a real customer. Exclusions are therefore
// checked FIRST and win over any positive match.

import type { Page, Frame, Locator } from "playwright";

export interface ApplicationEntryMatch {
  /** The visible label of the control we would click. */
  label: string;
  /** How it was matched, for diagnostics/telemetry. "tile" is a choice card clicked whole,
   *  labelled by its title (see markChoiceTilesInPage). */
  via: "text" | "href" | "tile";
  /** The href when the control is a link (absolute or portal-relative). */
  href?: string;
}

// "SUBMIT AN APPLICATION" IS A DOOR; "SUBMIT APPLICATION" IS THE FILE BUTTON.
//
// These are two different questions wearing one word, and the difference is grammatical
// rather than cosmetic. A start-here link NAMES the thing you are beginning — a determiner
// plus a noun, "Submit an Application/Request". A final submit is an imperative acting on
// the form already filled — "Submit", "Submit Application", "Submit Form". Measured on this
// fleet rather than assumed:
//
//   - Banked recipe ca8cacd0 (Frederick County MD, planningandpermitting.frederickcountymd.gov,
//     Momentum/CIVICS) records "Submit an Application/Request" as step 1, phase "open", note
//     "application entry" — and the walk went on to fill 3 fields and click "Save & Continue"
//     AFTER clicking it. A final submit ENDS a run; this one began one. The recipe is
//     needs_rerecord, so the exclusion was not blocking a hypothetical portal: it was
//     blocking the re-learn that jurisdiction needs, at step 1, with "No 'start an
//     application' control found on this page."
//   - Every isFinalSubmit label banked across all 76 recipes is determiner-less: "Submit",
//     "SUBMIT APPLICATION", "Submit Form", "submit_form", "Complete Application",
//     "Continue Application »". Not one carries "a"/"an" + a noun.
//   - permiteyes.us, the incident that created the exclusion below (a25311d), files with
//     <input type=submit value="Submit Application">. No determiner. Still refused, and its
//     smoke (enterSubmitGuard.dom.smoke) still asserts the form is never submitted.
//
// END-ANCHORED on purpose: the phrase must BE the whole label, so "Submit an Application Fee"
// (a payment) and "Submit an Application Status Search" cannot ride in on it. The slash tail
// is Frederick's own wording and is allowed only between these same start nouns.
//
// This admits a label; it does not admit a PAGE. The structural half of the guard lives in
// findApplicationEntry, which refuses any submit-worded candidate on a form-shaped page.
const SUBMIT_START_PHRASE =
  /\bsubmit (?:a|an) (?:new )?(?:application|permit|request|submittal)(?:\s*\/\s*(?:application|permit|request|submittal))?\s*$/i;

// Controls that begin a NEW application. Ordered most-specific → most-generic so the
// diagnostic label is the meaningful one when several match.
const ENTRY_PATTERNS: RegExp[] = [
  /\bcreate an application\b/i,                        // Accela ACA
  /\bapply for (a |an )?(new )?(permit|license|application)\b/i, // OpenGov / SmartGov / Citizenserve / BS&A
  /\bstart (a |an )?(new )?(application|permit)\b/i,
  // "New <qualifier> Application" — the utility/interconnection phrasing. Ameren Illinois
  // offers "New Interconnection Application" (verified live), and a fixed
  // "new (permit|building) application" list would miss every vendor's own noun. Up to two
  // words between, so this stays a button label rather than a sentence.
  /\bnew\s+(?:[a-z-]+\s+){0,2}application\b/i,
  // REQUIRES "new". "Submit a new application" is a dashboard START control; a bare
  // "Submit Application" is the FINAL SUBMIT on a filled form, and the entry pass runs before
  // any fill — so on a portal whose landing page IS the form (permiteyes.us, single-page
  // apps) the un-qualified pattern clicked the file button and submitted. Safety rule #1:
  // automation never clicks final submit.
  /\bsubmit (a |an )?new (application|permit)\b/i,
  // The determiner-led start phrase — Frederick County MD's "Submit an Application/Request".
  // See SUBMIT_START_PHRASE above for why an article separates a door from a file button.
  // A positive pattern was needed as well as the exclusion carve-out: measured, NONE of the
  // other eight patterns matches this label, so relaxing the exclusion alone left it refused.
  SUBMIT_START_PHRASE,
  /\bapply online\b/i,                                  // SmartGov
  /\bcreate (a |an )?(new )?(permit|record|case)\b/i,
  /\bpermit application\b/i,
  /^\s*apply\s*(here|now|online)?\s*$/i,                 // EnerGov's bare "Apply" tile; Momentum's "Apply Here"
];

// NEVER click these, even when they also match a pattern above. These lead into the
// operator's real, already-filed records — or into payment.
const EXCLUDE_PATTERNS: RegExp[] = [
  /\bresume\b/i,                 // "Resume Application" — an existing draft/filing
  /\bpay\b|\bfees? due\b|\bpayment\b|\bcart\b|\bcheckout\b/i,
  /\bsearch\b|\blook ?up\b/i,    // "Search Applications"
  /\brenew\b/i,
  /\bmy (records|permits|applications|account)\b/i,
  /\bview\b|\bstatus\b|\btrack\b/i,
  /\bupload\b|\battach\b/i,
  /\binspection\b/i,
  /\bschedule\b/i,
  /\bcancel\b|\bwithdraw\b|\bdelete\b/i,
  /\bexisting\b|\bdraft\b/i,
  /\bregister\b|\bsign ?up\b|\bcreate an account\b/i, // account creation, not an application
  // A PRE-application is a different, usually paid, product — an optional engineering study
  // that does not file anything. Ameren Illinois lists "New Pre-Application" right beside
  // the real "New Interconnection Application", so the broadened new-application pattern
  // above must not swallow it.
  /\bpre-?application\b/i,
  // LEGAL AND CONSENT PAGES ARE NEVER PART OF AN APPLICATION, AND EVERY PORTAL HAS THEM.
  //
  // Des Moines WA (PermitTrax) logged in, found and clicked the right entry — the run's own
  // event says application_entry_pass ok:true, label "Click to Apply Online" — and then
  // spent every remaining page on /citizen/CookiePolicy/, twice, before its budget ran out.
  // Nothing in the exclusion list stopped it, because "Cookie Policy" reads like an
  // ordinary link, and a consent banner puts one in front of the content on first visit.
  //
  // These sit in the footer of essentially every government portal, so this is worth
  // exactly one line and saves a page of budget on all of them.
  // Note what is NOT here: bare "terms" (a Short Terms Rental permit is a real permit) and
  // bare "consent" (an Owner Consent Form is a real document). Only the banner's own
  // phrasings, which is all that was ever wandered into.
  /\bcookie\b|\bprivacy\b|\bterms of (use|service)\b|\bdisclaimer\b|\baccessibility\b|\bcopyright\b|\bsite ?map\b/i,
  /\bconsent (preferences|settings)\b|\bmanage consent\b|\bmanage preferences\b/i,
  // A DOCUMENT *ABOUT* APPLYING IS NOT THE WAY TO APPLY. Found by sweeping the engine's own
  // finder across 66 live portals: Lynnwood's SmartGov portal offers "Permit Application
  // Checklist" — a PDF — and it matched /\bpermit application\b/ exactly, so the entry pass
  // would have opened a handout instead of starting an application, then reported that it
  // had entered the flow. Every portal publishes this class of link beside the real one.
  /\bchecklist\b|\binstructions?\b|\bguide(lines?)?\b|\bhandout\b|\bbrochure\b/i,
  /\bsample\b|\bexample\b|\btemplate\b|\bfaq\b|\btutorial\b|\brequirements?\b/i,
];

export function isExcludedEntryLabel(label: string): boolean {
  const text = (label || "").replace(/\s+/g, " ").trim();
  if (!text) return true;
  // FINAL-SUBMIT CONTROLS ARE NEVER ENTRY. "Submit Application" / "Submit" / "File" /
  // "Finish" files the form; entering the flow never requires one. Excluded outright UNLESS
  // the label carries "new" (an unambiguous "start a new application"), which a final-submit
  // button never does — or IS the determiner-led start phrase, which one never is either
  // (checked against every isFinalSubmit label this fleet has banked; see
  // SUBMIT_START_PHRASE). "file"/"finish"/"finalize" get no such carve-out: nothing in the
  // KB shows them naming a door, and a rule widened past its evidence is how this one broke
  // Frederick County in the first place.
  // Safety rule #1 — the entry pass runs before any fill, so on a portal whose landing page
  // is the form itself this is the last LABEL guard before an accidental filing; the page
  // guard in findApplicationEntry is the structural one behind it.
  if (/\b(submit|file|finish|finalize)\b/i.test(text) && !/\bnew\b/i.test(text) && !SUBMIT_START_PHRASE.test(text)) return true;
  return EXCLUDE_PATTERNS.some((re) => re.test(text));
}

export function matchesEntryLabel(label: string): boolean {
  const text = (label || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 60) return false;      // a paragraph is not a button
  if (isExcludedEntryLabel(text)) return false;
  return ENTRY_PATTERNS.some((re) => re.test(text));
}

// Rank a match so the most specific label wins when a page offers several.
function entryRank(label: string): number {
  const text = label.replace(/\s+/g, " ").trim();
  const i = ENTRY_PATTERNS.findIndex((re) => re.test(text));
  return i < 0 ? ENTRY_PATTERNS.length : i;
}

// ---------------------------------------------------------------------------
// SITE CHROME AND THE INSTALLER'S OWN ACCOUNT — never a permit type, never a tile (#328).
//
// Live Portland DevHub (2026-10-14, after #319): the learner read all nine tiles, then stopped
// AMBIGUOUS between "Solar Permit Request" and the signed-in installer's account button in the
// page header —
//
//   <div id="signin-menu" class="ms-auto">
//     <button id="signedin-menu-btn" class="dropdown-toggle" data-bs-toggle="dropdown"
//       aria-expanded="false"><i class="bi bi-person-fill"></i><div>{company name}</div></button>
//     <ul class="dropdown-menu" aria-labelledby="userMenuButton"> My Profile · Sign Out </ul>
//
// — because the company's name contains "Solar", and #319 made a type that names the job
// outrank the discipline. Nearly every client's name contains "Solar". The header is a
// <div id="top-header">, not a <header>, so a frame rule alone does not see it: what gives the
// button away is that it OPENS A MENU, and the menu holds Sign Out.
//
// ONE RESOLVER, READ BY EVERY DOOR. markSiteChromeInPage stamps data-al-chrome="<kind>" (the
// data-al-activescope precedent: one element marked, consumers read rather than re-decide):
//
//   account — a menu toggle whose menu holds an account action (sign/log out|off, my profile,
//             my account, update profile — loginFlow's words for an account menu), or whose own
//             label names a user/account menu; that menu; any account-action control; and the
//             nearest small container NAMED for sign-in/user/account/profile around one of them
//             (at most three visible controls, so a page wrapper called #userContent is never
//             swallowed). Anchored on the action, never on a name alone.
//   toggle  — any other dropdown/popup opener (data-bs-toggle/data-toggle="dropdown",
//             .dropdown-toggle, aria-haspopup true|menu|listbox, or aria-expanded on a control
//             whose controlled element IS a menu). A toggle opens a choice; it is never one. An
//             accordion's aria-expanded (it controls a collapse, not a menu) is not a toggle.
//   frame   — the page's frame: nav/header/footer and their landmark roles, menus, navbars,
//             breadcrumbs, and the step-bar vocabulary portalSafety cuts.
//
// Which door reads which kind, and why they differ:
//   - the tile scan and the permit-type chooser refuse ALL kinds: a type is never in the frame,
//     never a menu opener, never the installer's own account;
//   - the entry finder refuses ACCOUNT only. Entries legitimately live in navigation —
//     openCollapsedNav exists precisely to reach one inside a shut menu, and DevHub's own
//     "Apply For A Permit" sits in <nav role="navigation"> — and an entry can be a dropdown
//     ("New Application ▾"); cutting either would stop the walk at its first page.
//
// <body>/<html> are never stamped: a page-state class ("menu-open") is not chrome.
//
// Runs INSIDE the page: self-contained, no module references, no named inner functions.
// ---------------------------------------------------------------------------

/** Stamp the page's chrome — account, toggle, frame — for every door to read. Returns counts. */
export function markSiteChromeInPage(): { account: number; toggle: number; frame: number } {
  for (const prev of Array.from(document.querySelectorAll("[data-al-chrome]"))) prev.removeAttribute("data-al-chrome");
  const FRAME = "nav, header, footer, [role='navigation'], [role='banner'], [role='contentinfo'], [role='tablist'], "
    + "[role='menu'], [role='menubar'], [aria-label*='step' i], [class*='stepper'], [class*='steps'], [class*='stepNav'], "
    + "[class*='step-nav'], [class*='step-header'], [class*='progress'], [class*='breadcrumb'], [class*='navbar'], [class*='menu']";
  const MENU = ".dropdown-menu, [role='menu'], [role='menubar'], [role='listbox']";
  const CONTROL = "a, button, [role='button'], input[type='button'], input[type='submit']";
  // An account ACTION: loginFlow's sign-out words, plus the profile/account entries an account
  // menu carries. Whole words, so "Profiles of Solar Installations" never reads as one.
  const ACCOUNT_ACTION = /(log|sign)\s?-?\s?(out|off)\b|\bmy\s+(profile|account)\b|\b(update|edit|view|manage)\s+(my\s+)?(profile|account)\b|\baccount\s+settings\b|^\s*(profile|my account|account)\s*$/i;
  // A toggle's OWN label naming a user/account menu (EnerGov: "User dropdown menu to update
  // profile, view invoices, or logout"; "Signed in as …").
  const ACCOUNT_LABEL = /\b(user|account|profile)\b[^.]{0,40}\b(menu|dropdown)\b|\b(menu|dropdown)\b[^.]{0,40}\b(user|account|profile)\b|\bsigned\s+in\s+as\b/i;
  // id/class tokens that NAME a sign-in/user/account/profile container (camelCase split).
  const ACCOUNT_TOKEN = /^(signin|signedin|login|loggedin|logon|user|users|usermenu|account|accounts|myaccount|accountmenu|profile)$/;
  const counts = { account: 0, toggle: 0, frame: 0 };
  const root = document.documentElement;
  const body = document.body;

  const anchors: Element[] = [];
  // Toggles first: decide "account" or "toggle" by what the menu they open holds.
  for (const t of Array.from(document.querySelectorAll("[data-bs-toggle='dropdown'], [data-toggle='dropdown'], .dropdown-toggle, [aria-haspopup], [aria-expanded]"))) {
    if (t === root || t === body) continue;
    let menu: Element | null = null;
    const ctl = (t.getAttribute("aria-controls") || "").split(/\s+/).filter(Boolean)[0];
    if (ctl) menu = document.getElementById(ctl);
    if (!menu || !menu.matches(MENU)) {
      menu = null;
      let s = t.nextElementSibling;
      for (let k = 0; s && k < 3 && !menu; k++) { if (s.matches(MENU)) menu = s; s = s.nextElementSibling; }
    }
    const pop = (t.getAttribute("aria-haspopup") || "").toLowerCase();
    const declared = t.matches("[data-bs-toggle='dropdown'], [data-toggle='dropdown'], .dropdown-toggle")
      || pop === "true" || pop === "menu" || pop === "listbox";
    if (!declared && !menu) continue; // aria-expanded alone — an accordion, a disclosure — is not a toggle
    const ownLabel = `${t.getAttribute("aria-label") || ""} ${t.getAttribute("title") || ""}`;
    const accountish = (menu !== null && ACCOUNT_ACTION.test(menu.textContent || ""))
      || ACCOUNT_LABEL.test(ownLabel);
    if (accountish) {
      t.setAttribute("data-al-chrome", "account");
      if (menu) menu.setAttribute("data-al-chrome", "account");
      anchors.push(t);
      counts.account++;
    } else if (!t.hasAttribute("data-al-chrome")) {
      t.setAttribute("data-al-chrome", "toggle");
      counts.toggle++;
    }
  }
  // An account-action control on its own (a plain "Sign Out" link beside the name).
  for (const c of Array.from(document.querySelectorAll(CONTROL))) {
    const own = (c.textContent || (c as HTMLInputElement).value || "").replace(/\s+/g, " ").trim();
    if (!own || own.length > 40 || !ACCOUNT_ACTION.test(own)) continue;
    if (c.getAttribute("data-al-chrome") !== "account") { c.setAttribute("data-al-chrome", "account"); counts.account++; }
    anchors.push(c);
  }
  // Widen each anchor to the nearest small container NAMED for the account.
  for (const a of anchors) {
    let node: Element | null = a.parentElement;
    for (let hop = 0; node && hop < 4; hop++) {
      if (node === root || node === body || node.matches("main, form, [role='main']")) break;
      const tokens = `${node.id || ""} ${typeof node.className === "string" ? node.className : ""}`
        .replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const named = tokens.some((tk) => ACCOUNT_TOKEN.test(tk))
        || tokens.join(" ").includes("sign in") || tokens.join(" ").includes("signed in") || tokens.join(" ").includes("log in");
      if (named) {
        let visible = 0;
        for (const c of Array.from(node.querySelectorAll(CONTROL))) {
          const r = c.getBoundingClientRect();
          if (r.width > 2 && r.height > 2) visible++;
        }
        if (visible <= 3) {
          if (node.getAttribute("data-al-chrome") !== "account") { node.setAttribute("data-al-chrome", "account"); counts.account++; }
        }
        break;
      }
      node = node.parentElement;
    }
  }
  // The frame last, never over an account mark (the entry finder reads that one).
  for (const f of Array.from(document.querySelectorAll(FRAME))) {
    if (f === root || f === body || f.hasAttribute("data-al-chrome")) continue;
    f.setAttribute("data-al-chrome", "frame");
    counts.frame++;
  }
  return counts;
}

/** Stamp the chrome in ONE scope. Never throws: an unreadable page is simply unmarked, which
 *  leaves every door exactly as it was before this existed. */
export async function markSiteChrome(scope: Page | Frame): Promise<void> {
  if (!scope || typeof (scope as Frame).evaluate !== "function") return;
  try { await (scope as Frame).evaluate(markSiteChromeInPage); } catch { /* fail open */ }
}

// ---------------------------------------------------------------------------
// THE INSTALLER'S OWN NAME IS NEVER A PERMIT TYPE — belt and braces for a portal that renders
// the signed-in company outside any chrome the resolver can see. The names come from the
// project's CLIENT RECORD (company, legal business name, DBA — backend learnClientNames),
// never from the page.
//
// A name is usable only when it can be told apart from a type: after the corporate suffix is
// dropped, at least one of its words must lie outside the job/type vocabulary. A client
// literally called "Solar Systems Inc" would otherwise erase "Solar Systems Permit".
// ---------------------------------------------------------------------------
const CORPORATE_SUFFIX = new Set(["inc", "incorporated", "llc", "co", "corp", "corporation", "company", "ltd", "limited", "lp", "llp", "pllc", "pc", "plc", "dba"]);
const TYPE_WORDS = new Set([
  "solar", "pv", "photovoltaic", "photovoltaics", "energy", "renewable", "renewables", "power", "electric", "electrical",
  "electrician", "electricians", "permit", "permits", "request", "requests", "system", "systems", "service", "services",
  "solutions", "installation", "installations", "installer", "installers", "residential", "commercial", "home", "homes",
  "roof", "roofing", "construction", "contractor", "contractors", "building", "battery", "storage", "interconnection",
  "the", "and", "of", "a", "an",
]);

/** Lower-case words, diacritics off, "&" read as "and", dots dropped ("L.L.C." -> "llc"). */
export function identityWords(text: string): string[] {
  return String(text ?? "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/&/g, " and ").replace(/[.'’]/g, "")
    .split(/[^a-z0-9]+/).filter(Boolean);
}

/** True when `label` IS, or contains, one of the client's own names (whole words, in order). */
export function isOwnIdentityLabel(label: string, names: readonly string[] | undefined): boolean {
  if (!names || !names.length) return false;
  const hay = ` ${identityWords(label).filter((w) => !CORPORATE_SUFFIX.has(w)).join(" ")} `;
  if (!hay.trim()) return false;
  for (const name of names) {
    const words = identityWords(name).filter((w) => !CORPORATE_SUFFIX.has(w));
    if (!words.length || words.every((w) => TYPE_WORDS.has(w))) continue; // cannot be told apart from a type
    if (hay.includes(` ${words.join(" ")} `)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// CHOICE TILES — a page whose controls are CARDS, not links or buttons.
//
// Portland DevHub (live, 2026-10-13) answers "Apply For A Permit" with a column of tiles:
//
//   <div class="card-h card-l card">
//     <div class="card-body">
//       <div class="card-title">Solar Permit Request</div>
//       <div class="card-text">… <a onclick="event.stopPropagation()">See more information…</a></div>
//     </div>
//     <div class="card-next"><i class="fa fa-chevron-right"></i></div>
//   </div>
//
// The whole card is the control — a click handler bound in script; no onclick attribute, no
// role, no <button>, no <a> around it. The only anchors inside are information links, which
// stop propagation. Field discovery collects buttons and links, so it saw 35 controls and no
// tile; the entry pass found nothing; the planner's one candidate was the information link,
// which the rule-5 guard rightly refused; and the run died "nothing fillable" standing on a
// page of plainly labelled choices, telling the operator to record the portal by hand.
//
// A tile is recognised by its SHAPE, never by a class name or a host:
//   - a block container with a short, heading-like TITLE of its own;
//   - an AFFORDANCE that says "this goes somewhere": a right/forward arrow icon or glyph, a
//     click handler, a role, or a pointer cursor that STARTS on the tile (cursor inherits, so
//     the card's body would otherwise qualify as a tile inside the tile);
//   - no fillable control and no button of its own (those would be the control);
//   - REPEATED as alike siblings — one card is content, a row of them is a menu;
//   - a LEAF: it holds no other such block. A section that holds tiles "has" the first tile's
//     title and icon, and a panel may carry its own heading and chevron over them; neither is
//     a tile, and the cuts (size, chrome, hidden) are applied only after that is settled.
// Its LABEL is its title. The inner information links keep their own labels and stay exactly
// as off-limits as they were.
//
// Never inside page chrome: a chevron-separated step bar is a row of "heading + arrow"
// siblings — a tile's shape to the letter — and its "Review and Submit" item would reach the
// review classifier as a button-typed field. Chrome is what markSiteChromeInPage stamped (one
// resolver for every door: the frame, menu toggles, the installer's own account); the tile scan
// adds two cuts of its own shape — a table row and an aria-hidden subtree are never a card.
//
// Runs INSIDE the page (page.evaluate): self-contained, no module references, and no named
// inner functions (esbuild's keepNames wraps those in __name, which a raw page lacks — see
// markActiveScopeInPage). Stamps every tile with a transient data-al-tile key (precedent:
// data-al-prog, data-al-resultrow) so a caller clicks the element that was scanned, and
// returns the RAW title: Node turns it into a label in choiceTileLabel, the one place that
// derivation lives.
// ---------------------------------------------------------------------------

/** One tile as the in-page scan reports it: its transient key and the title's raw text. */
export interface ChoiceTileRaw {
  key: string;
  title: string;
}

export function markChoiceTilesInPage(): ChoiceTileRaw[] {
  for (const prev of Array.from(document.querySelectorAll("[data-al-tile], [data-al-tile-label]"))) {
    prev.removeAttribute("data-al-tile");
    prev.removeAttribute("data-al-tile-label");
  }
  const TITLE = "h1, h2, h3, h4, h5, h6, [class*='title'], [class*='heading'], [class*='header'], strong, b, dt, legend";
  // Chrome is READ from markSiteChromeInPage's stamps (scanChoiceTiles runs it first); the two
  // cuts below are the tile scan's own: shapes that are never a card, whatever the page is.
  const CHROME = "[data-al-chrome], table, [aria-hidden='true']";
  const FILLABLE = "input:not([type='hidden']), select, textarea, [contenteditable='true']";
  const OWN_CONTROL = "button, input[type='button'], input[type='submit'], [role='button']";
  // Material / icon-font ligatures and bare glyphs that draw a forward arrow.
  const ICON_LIGATURE = /^(chevron_right|arrow_forward|arrow_forward_ios|arrow_right|arrow_right_alt|navigate_next|keyboard_arrow_right|east|arrow_circle_right|double_arrow|last_page)$/;
  const ARROW_GLYPH = /^[\s›»→➔➜➝➞❯⟩⇒⟶▶▸►>]+$/;
  // A class token that names a forward arrow ("fa-chevron-right", "bi-arrow-right-circle",
  // "card-next", "navigate_next") — and never a down/up/left one (accordion carets, back arrows).
  const ARROW_TOKEN = /(?:^|[-_])(?:chevron|arrow|caret|angle|triangle)(?:[-_]|$)/i;
  const NEXT_TOKEN = /(?:^|[-_])(?:next|forward)(?:[-_]|$)/i;
  const NOT_FORWARD = /(?:^|[-_])(?:down|up|left|back|prev|previous|collapse|expand)(?:[-_]|$)/i;

  // STAGE 1 — SHAPE. Every block with a title and a forward affordance of its own, BEFORE
  // any cut. A block the cuts below would drop (hidden, too small, inside chrome, its title
  // a link) still counts here, because the bug this guards against is a CONTAINER inheriting
  // a cut descendant's title or arrow: the scan asked "does this element hold a title and an
  // arrow?" and a section around nine cards does — it holds the first card's. Cut the cards
  // first and the section is the page's one "tile", labelled by a card it is not, clicked at
  // its centre into whichever card sits there (a Demolition request, recorded as Building).
  const shaped: Array<{ el: Element; title: string; titleEl: Element; affEl: Element | null }> = [];
  for (const el of Array.from(document.querySelectorAll("div, li, section, article"))) {
    if (el.closest("button")) continue;
    if (el.querySelector(FILLABLE) || el.querySelector(OWN_CONTROL)) continue;
    const titleEl = el.querySelector(TITLE);
    if (!titleEl) continue;
    const title = (titleEl.textContent || "").replace(/\s+/g, " ").trim();
    if (title.length < 3 || title.length > 120) continue;

    let affordance = el.hasAttribute("onclick") || el.hasAttribute("data-href") || el.hasAttribute("data-url")
      || /^(button|link|option|menuitem)$/.test(el.getAttribute("role") || "")
      || (el.hasAttribute("tabindex") && Number(el.getAttribute("tabindex")) >= 0);
    if (!affordance) {
      const parent = el.parentElement;
      affordance = window.getComputedStyle(el).cursor === "pointer"
        && !(parent && window.getComputedStyle(parent).cursor === "pointer");
    }
    let affEl: Element | null = null;
    if (!affordance) {
      for (const d of Array.from(el.querySelectorAll("*"))) {
        // An inner link's own icon is not the tile's affordance.
        const inner = d.closest("a, button");
        if (inner && el.contains(inner)) continue;
        // An arrow nobody can see (the cards of a collapsed section) is not one either.
        const dr = d.getBoundingClientRect();
        if (dr.width === 0 && dr.height === 0) continue;
        let hit = false;
        for (const tok of String(d.getAttribute("class") || "").split(/\s+/)) {
          if (!tok || NOT_FORWARD.test(tok)) continue;
          if (ARROW_TOKEN.test(tok) || NEXT_TOKEN.test(tok)) { hit = true; break; }
        }
        if (!hit && d.children.length === 0) {
          const txt = (d.textContent || "").trim();
          if (txt && (ICON_LIGATURE.test(txt) || ARROW_GLYPH.test(txt))) hit = true;
        }
        if (hit) { affEl = d; break; }
      }
      affordance = affEl !== null;
    }
    if (!affordance) continue;
    shaped.push({ el, title, titleEl, affEl });
  }

  // STAGE 2 — A TILE IS A LEAF. A shaped block that holds another shaped block is the section,
  // panel or list AROUND tiles, never one of them — whether it borrowed its title and arrow
  // from a card inside it or carries its own ("Permit Applications ›" as a panel heading over
  // the menu). It is dropped even when every card inside it is cut below: the cards still say
  // what it is. Leaves never nest, so the click lands on the element that was scanned.
  const leaves = shaped.filter((c) => !shaped.some((o) => o !== c && c.el.contains(o.el)));

  // STAGE 3 — THE CUTS, on leaves only: too small to be a card, a title nobody can see,
  // inside chrome, or a title that IS a link (the link is its control and has a label of its
  // own). A chrome match on <body> or <html> is a page-state class ("menu-open"), not chrome.
  const candidates = leaves.filter((c) => {
    const r = c.el.getBoundingClientRect();
    if (r.width < 80 || r.height < 32) return false;
    const tr = c.titleEl.getBoundingClientRect();
    if (tr.width === 0 && tr.height === 0) return false;
    const chrome = c.el.closest(CHROME);
    if (chrome && chrome !== document.body && chrome !== document.documentElement) return false;
    const titleLink = c.titleEl.closest("a, button");
    if (titleLink && c.el.contains(titleLink)) return false;
    return true;
  });

  // STAGE 4 — REPETITION, OR SOLITUDE: alike siblings under one parent are a menu; a card
  // that is the page's ONLY candidate is its one choice — the learner enters it when nothing
  // else on the page advances (the adapter's single-tile rule; owner's ruling 2026-09-26: a
  // false stop on a legitimate step is a bug). Two unalike cards in different places are
  // content.
  const tiles: Array<{ el: Element; title: string }> = [];
  for (const c of candidates) {
    const parent = c.el.parentElement;
    if (!parent) continue;
    const alike = candidates.filter((o) => o.el.parentElement === parent && o.el.tagName === c.el.tagName);
    if (alike.length >= 2 || candidates.length === 1) tiles.push({ el: c.el, title: c.title });
  }

  const out: ChoiceTileRaw[] = [];
  let n = 0;
  for (const c of tiles) {
    const key = "t" + String(n++);
    c.el.setAttribute("data-al-tile", key);
    out.push({ key, title: c.title });
  }
  return out;
}

/**
 * THE LABEL OF A CHOICE TILE, from its title's raw text — the one place this is decided.
 * Null means "a card, not a choice": a title that reads as a record (a number, an address,
 * a date), or as a page's way forward / a step bar's last item, is never offered as a
 * navigation candidate.
 */
export function choiceTileLabel(raw: string): string | null {
  let t = String(raw ?? "").replace(/\s+/g, " ").trim();
  // A trailing arrow drawn as text ("Solar Permit Request ›") is the affordance, not the name.
  t = t.replace(/[\s›»→➔➜➝➞❯⟩⇒⟶▶▸►>]+$/, "").trim();
  if (t.length < 3 || t.length > 120) return null;
  // Three digits in a row is a record number, a street number or a year: a thing that exists,
  // not a kind of thing to apply for. A record card on a dashboard must never read as a type.
  // A digit run that names a SIZE TIER ("Solar PV Systems up to 100 kW") is the one exception:
  // a unit right after it makes it a kind of thing again. Anchored on both sides so "1000 kW"
  // cannot backtrack into "100" + "0".
  if (/(?<!\d)\d{3,}(?!\d)(?!\s*(?:kw|kva|mw|mva|va|w|a|v|%|sq\.?\s?ft|sf)\b)/i.test(t)) return null;
  // Advance / submit wording whole: a step bar's items and a button face, never a choice.
  if (/^(next|continue|proceed|back|previous|cancel|close|submit|save|finish|done|ok)(\s+(step|now|application|form|page))?$/i.test(t)) return null;
  if (/^review(\s*(and|&)\s*submit)?$/i.test(t)) return null;
  return t;
}

/** A choice tile with its derived label, stamped in the page as data-al-tile / data-al-tile-label. */
export interface ChoiceTile {
  key: string;
  label: string;
}

/**
 * Scan ONE scope (page or frame) for choice tiles, derive each label, and stamp the label
 * back onto the element so the field harvest (extractFieldsInPage) reads it rather than
 * re-deriving it. Never throws; an unreadable page simply has no tiles. The shape of what the
 * page returns is checked rather than trusted — a test's fake page answers every evaluate
 * with one canned object.
 */
export async function scanChoiceTiles(scope: Page | Frame): Promise<ChoiceTile[]> {
  if (!scope || typeof (scope as Frame).evaluate !== "function") return [];
  // The chrome the tile scan cuts is the chrome every door reads — stamped here, first.
  await markSiteChrome(scope);
  let raws: unknown;
  try { raws = await (scope as Frame).evaluate(markChoiceTilesInPage); } catch { return []; }
  if (!Array.isArray(raws)) return [];
  const tiles: ChoiceTile[] = [];
  for (const r of raws as Array<Partial<ChoiceTileRaw> | null>) {
    if (!r || typeof r.key !== "string" || !/^t\d+$/.test(r.key) || typeof r.title !== "string") continue;
    const label = choiceTileLabel(r.title);
    if (label) tiles.push({ key: r.key, label });
  }
  if (!tiles.length) return [];
  try {
    await (scope as Frame).evaluate((pairs: Array<[string, string]>) => {
      for (const pair of pairs) {
        const el = document.querySelector(`[data-al-tile="${pair[0]}"]`);
        if (el) el.setAttribute("data-al-tile-label", pair[1]);
      }
    }, tiles.map((t): [string, string] => [t.key, t.label]));
  } catch { return []; }
  return tiles;
}

/**
 * Find the control that starts a NEW application, searching the main document and every
 * same-origin frame. Returns the best candidate WITHOUT clicking it (callers decide), or
 * null when the page offers none. Never returns an excluded control.
 */
export async function findApplicationEntry(page: Page): Promise<{ locator: Locator; match: ApplicationEntryMatch } | null> {
  const scopes: Array<Page | Frame> = typeof page.frames === "function" ? page.frames() : [page];
  let best: { locator: Locator; match: ApplicationEntryMatch; rank: number } | null = null;

  for (const scope of scopes) {
    let scan: { candidates: Array<{ label: string; href: string; index: number; fromText: boolean }>; fillable: number } =
      { candidates: [], fillable: 0 };
    // The installer's own ACCOUNT controls are never the way in (#328). Only that kind: an entry
    // legitimately lives in navigation and may be a dropdown — see markSiteChromeInPage.
    await markSiteChrome(scope);
    try {
      scan = await (scope as Frame).evaluate(() => {
        const vis = (el: Element) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        // HOW MANY FIELDS THIS PAGE WANTS FILLED — the structural half of the submit guard
        // below. Counted here, in the same pass as the candidates, so it describes the exact
        // frame the candidate was found in rather than the top document.
        const fillable = (Array.from(document.querySelectorAll("input, select, textarea")) as HTMLElement[])
          .filter(vis)
          .filter((el) => !/^(button|submit|reset|hidden|image)$/i.test((el as HTMLInputElement).type || ""))
          .length;
        // THE VISIBLE TEXT IS OFTEN NOT THE NAME. Newer portals put the entry on a floating
        // action button whose content is "+" or an icon-font ligature, with the real name in
        // aria-label or a hover tooltip (title) — ComEd's interconnection portal is exactly
        // this: a purple "+" that only says "New Application" once you hover it. Reading
        // textContent alone made that button unfindable. So: use the visible text when it
        // actually says something, otherwise fall back to the accessible name and then the
        // tooltip. Order matters — a normal button's visible text still wins, because that
        // is what a person reads.
        const meaningful = (t: string): boolean => t.length >= 3 && !/^[+\-–—·•*]+$/.test(t) && !/^[a-z][a-z0-9_]{1,24}$/.test(t);
        const candidates = (Array.from(document.querySelectorAll("a, button, input[type=button], input[type=submit], [role=button]")) as HTMLElement[])
          .filter(vis)
          .filter((el) => !el.closest("[data-al-chrome='account']"))
          .map((el, index) => {
            const own = ((el as HTMLInputElement).value || el.textContent || "").replace(/\s+/g, " ").trim();
            const aria = (el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
            const title = (el.getAttribute("title") || el.getAttribute("data-tooltip") || "").replace(/\s+/g, " ").trim();
            const useOwn = meaningful(own);
            return {
              label: useOwn ? own : (aria || title || own),
              fromText: useOwn,           // how the label was derived decides how we re-find it
              href: el.getAttribute("href") || "",
              index,
            };
          })
          .filter((c) => c.label);
        return { candidates, fillable };
      });
    } catch { continue; } // cross-origin frame
    // THE PAGE HAS TO LOOK LIKE A DASHBOARD, NOT LIKE THE FORM ITSELF.
    //
    // The article in SUBMIT_START_PHRASE is a grammar argument; this is a structural one, and
    // hard rule #1 deserves both rather than either. The incident that created the submit
    // exclusion (a25311d) was permiteyes.us, whose LANDING PAGE IS a 176-field single-page
    // application — the entry pass runs before anything has been filled and cannot tell from
    // a label alone which kind of page it is standing on. So a submit-worded candidate is
    // refused outright wherever the frame carries more than a handful of fillable controls,
    // and both halves would have to be wrong at once for the pass to press a file button.
    //
    // Same threshold and the same reasoning as pressEnterInLastFilledField's (>5): a
    // dashboard's search box is one or two controls, an application is dozens. Only
    // submit-worded labels are gated — a portal is perfectly free to put "Create an
    // Application" or "Apply Here" beside a filter panel, and those keep working.
    const formShaped = scan.fillable > 5;
    for (const c of scan.candidates) {
      if (!matchesEntryLabel(c.label)) continue;
      if (formShaped && /\bsubmit\b/i.test(c.label)) continue;
      const rank = entryRank(c.label);
      if (best && rank >= best.rank) continue;
      // Re-locate the way the label was DERIVED. A label taken from aria-label or a tooltip
      // is not on the page as text, so locating it by text finds nothing — which is how an
      // icon/FAB entry stayed unclickable even once it was correctly identified.
      const byText = (scope as Frame).getByText(c.label, { exact: true }).first();
      const loc = c.fromText
        ? byText
        : (scope as Frame).locator(`[aria-label="${c.label.replace(/"/g, '\\"')}"], [title="${c.label.replace(/"/g, '\\"')}"]`).first();
      best = { locator: loc as Locator, match: { label: c.label, via: c.href ? "href" : "text", href: c.href || undefined }, rank };
    }
    // THE SAME QUESTION, ASKED OF THE PAGE'S CHOICE TILES. A home that offers "Apply for a
    // Permit" as a card (DevHub's home does, beside its sidebar link) is entered through the
    // card, by its title, under the same exclusions and the same rank — and a tie keeps the
    // control found first, so a link with the same label still wins. "My Permits", "View or
    // Pay Fees" tiles are refused exactly as the links would be.
    for (const t of await scanChoiceTiles(scope)) {
      if (!matchesEntryLabel(t.label)) continue;
      if (formShaped && /\bsubmit\b/i.test(t.label)) continue;
      const rank = entryRank(t.label);
      if (best && rank >= best.rank) continue;
      const loc = (scope as Frame).locator(`[data-al-tile="${t.key}"]`).first();
      best = { locator: loc as Locator, match: { label: t.label, via: "tile" }, rank };
    }
  }
  return best ? { locator: best.locator, match: best.match } : null;
}

// MODULE tabs that a portal files applications under. On Accela the logged-in home offers
// only "Home | Permits | Licensing | Planning and Zoning …" — "Create an Application" lives
// one hop inside the module (verified live on Anne Arundel County). Ordered so a solar
// permit lands in the building/permits module, never in Licensing or Enforcement.
const MODULE_PATTERNS: RegExp[] = [
  /^\s*permits?\s*$/i,
  /^\s*building\s*(permits?|department)?\s*$/i,
  /^\s*(building )?safety\s*$/i,
  /^\s*development\s*$/i,
  /^\s*planning( and zoning)?\s*$/i,
];
export function matchesModuleLabel(label: string): boolean {
  const text = (label || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 40 || isExcludedEntryLabel(text)) return false;
  return MODULE_PATTERNS.some((re) => re.test(text));
}

/**
 * Find the application entry, following ONE module hop when the landing page doesn't offer
 * it directly. Returns the match plus whether a hop was needed; the page is left wherever
 * the search ended (a module home is a harmless read-only listing page).
 * Bounded to `maxModules` hops so a portal that never offers an entry can't be walked
 * indefinitely, and module candidates are exclusion-filtered like everything else.
 */
// Collapsed navigation. Mobile-first portals hide the whole menu — application entry
// included — behind a hamburger toggle, so a logged-in home can legitimately offer nothing
// but "Open Navigation Menu" (measured live on Momentum). Opening it is safe: a toggle
// reveals links, it never submits or mutates anything.
// Deliberately NARROW: it must name itself a menu/navigation toggle. A generic
// "[aria-controls][aria-expanded=false]" also matches every accordion on the page, and
// clicking one on Accela mutated the home enough to break the module walk that had just
// worked — an over-eager opener costs more than a missed menu.
const NAV_TOGGLE_SELECTORS = [
  "button[aria-label*='navigation menu' i]",
  "button[aria-label*='main menu' i]",
  "button[aria-label*='open menu' i]",
  "button[aria-label*='toggle navigation' i]",
  ".navbar-toggler",
  "button.hamburger, .hamburger-menu",
  "[class*='menu-toggle'], [id*='menu-toggle']",
];
async function openCollapsedNav(page: Page): Promise<boolean> {
  // A PAGE CAN BE BUSY AND STILL HAVE ITS NAV SHUT.
  //
  // This used to refuse unless the page was SPARSE (>12 visible links → give up), reasoning
  // that a portal already showing a full navigation has no menu to open. That conflates two
  // independent things. Prince George's County (Momentum/CIVICS) shows a records table of
  // 131 buttons and 33 links WITH the primary nav collapsed: the "Apply Here" link exists in
  // the DOM, inside a shut sidebar, at zero size. The gate saw a busy page, declined to
  // open anything, and the learn reported the portal had no way in.
  //
  // Nothing needs protecting by this point: openCollapsedNav is only reached after the
  // direct search has already failed, so there is no entry control to accidentally cover.
  // And the caller reloads home when the toggle reveals nothing, which undoes a stray click.
  for (const sel of NAV_TOGGLE_SELECTORS) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) === 0 || !(await loc.isVisible().catch(() => false))) continue;
      await loc.click({ timeout: 5000 });
      await page.waitForTimeout?.(1200);
      return true;
    } catch { /* try the next toggle shape */ }
  }
  return false;
}

/**
 * How long the LEARN will keep looking for the way into an application before giving up.
 *
 * Generous on purpose. A learn runs once per portal and every replay afterwards follows the
 * recorded steps, so this budget is spent exactly once and never again — while giving up
 * early costs a person sitting down to record the portal by hand. Live on Prince George's
 * County (Momentum/CIVICS) the dashboard's "Apply Here" painted several seconds after the
 * search had already concluded there was none.
 *
 * This cannot slow a replay: recipeAdapter never calls the entry finder.
 *
 * Read at CALL time, not import time: the browser-free tests set ENTRY_SETTLE_MS before the
 * first learn, and an ES module's static imports run before any statement of the importer —
 * a constant captured at import never saw it, so every review-bound walk on autoLearnAdapter's
 * fake page (no waitForTimeout, no entry control) spun here the full 30 s (#6).
 */
function entrySettleMs(): number {
  return Math.max(0, Number(process.env.ENTRY_SETTLE_MS ?? 30000));
}

export async function findApplicationEntryDeep(
  page: Page,
  opts: { maxModules?: number } = {},
): Promise<{ match: ApplicationEntryMatch; viaModule?: string } | null> {
  // SETTLE FIRST. Called straight after a login, the page is often still mid-redirect: a
  // transitional page has almost no links, which reads as "sparse home with a collapsed
  // menu" and sends the whole search down the wrong path. Wait for the real page.
  await page.waitForLoadState?.("networkidle", { timeout: 8000 }).catch(() => null);
  await page.waitForTimeout?.(1200);

  // The page we return to between module hops — never a login URL. Navigating a logged-in
  // session back to Login.aspx yields a blank/redirect page and the search dead-ends there.
  const current = typeof page.url === "function" ? page.url() : "";
  const home = /login|sign-?in|logon/i.test(current) ? "" : current;

  // LOOK MORE THAN ONCE. A single read decides the whole search, and on a client-rendered
  // dashboard the nav is routinely painted after the wait above has expired — networkidle
  // never settles on a portal that polls, so the 8s cap is spent and the DOM is read while
  // the shell is still filling in.
  //
  // Live on Prince George's County (Momentum/CIVICS): logged in at 5.3s, this search
  // concluded "no entry control" at ~14.5s, and the page capture written at 20.0s contains
  // <a>Apply Here</a>, visible, 144x84. The finder was right about the DOM it was shown and
  // wrong about when to look. Same shape as the login form's settle budget, same cure.
  // The budget is deliberately generous. A learn runs ONCE per portal and every replay
  // afterwards is free, so seconds here are the cheapest thing in the system — while giving
  // up early costs a human sitting down to record the portal by hand. Patience is worth
  // more than speed on a first run.
  const directDeadline = Date.now() + entrySettleMs();
  let direct = await findApplicationEntry(page);
  while (!direct && Date.now() < directDeadline) {
    await page.waitForTimeout?.(1500);
    direct = await findApplicationEntry(page);
  }
  if (direct) return { match: direct.match };

  // Nothing visible — the menu may simply be collapsed. Open it and look again before
  // walking modules. If that reveals nothing, RELOAD the home first: a toggle click can
  // leave an open drawer covering the module tabs, and a stale overlay silently breaks the
  // module walk below (observed on Accela, where the walk had just succeeded).
  if (await openCollapsedNav(page)) {
    const afterNav = await findApplicationEntry(page);
    if (afterNav) return { match: afterNav.match, viaModule: "navigation menu" };
    if (home) {
      try { await page.goto(home, { waitUntil: "domcontentloaded", timeout: 20000 }); await page.waitForTimeout?.(1200); } catch { /* keep going with the page as-is */ }
    }
  }

  const maxModules = opts.maxModules ?? 3;
  let moduleLabels: string[] = [];
  try {
    moduleLabels = await page.evaluate(() => {
      const vis = (el: Element) => { const r = (el as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      return (Array.from(document.querySelectorAll("a, button, [role=button], [role=tab]")) as HTMLElement[])
        .filter(vis)
        .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
    });
  } catch { return null; }

  const seen = new Set<string>();
  const modules = moduleLabels.filter((l) => matchesModuleLabel(l) && !seen.has(l) && seen.add(l)).slice(0, maxModules);
  for (const label of modules) {
    try {
      await page.getByText(label, { exact: true }).first().click({ timeout: 8000 });
      await page.waitForLoadState?.("networkidle", { timeout: 12000 }).catch(() => null);
      await page.waitForTimeout?.(1200);
    } catch { continue; }
    const found = await findApplicationEntry(page);
    if (found) return { match: found.match, viaModule: label };
    // Nothing here — go back and try the next module. With no safe home to return to, stop
    // rather than wander: module tabs usually persist, but a blind retry is not worth it.
    if (!home) break;
    try { await page.goto(home, { waitUntil: "domcontentloaded", timeout: 20000 }); await page.waitForTimeout?.(1000); } catch { break; }
  }
  return null;
}

/**
 * Click into the application flow. Returns where it landed. Does NOT fill or submit
 * anything — starting an application is a navigation, and the caller (learn loop / probe)
 * takes it from there.
 */
/** Whitespace-collapsed, case-insensitive form used to compare entry labels across passes. */
/** WHICH PERMIT TO FILE, CHOSEN WITHOUT THE PLANNER.
 *
 *  permiteyes.us answers "New Application" with a menu of ~50 permit types. Handing that
 *  page to the field planner cost 16.6k input tokens and 7-8k output PER CALL at 25-96
 *  seconds each, hit the 8192-token ceiling once and came back as unparseable JSON, and two
 *  learn runs were cut off mid-page with nothing saved. Fifty permit types is fifty
 *  navigation candidates; an LLM is the wrong instrument for a lookup.
 *
 *  It is also the wrong instrument for the DECISION. Filing the wrong permit type is the
 *  most expensive mistake this system can make — worse than filing nothing — and this
 *  project has already shipped a Residential Mechanical permit on a solar job and learned a
 *  Permit EXTENSION Request as if it were a new permit.
 *
 *  So: curated patterns keyed to the track being filed, the same shape as the application
 *  entry finder above, and the same refusal. Nothing matches -> stop and say what was
 *  offered. Several match -> stop and say which. A permit type is never guessed.
 */
export interface PermitTypeChoice {
  /** The chosen control, ready to click. */
  locator: Locator;
  label: string;
  /** A link/button carrying the label, or a choice tile labelled by its title and clicked
   *  whole (see markChoiceTilesInPage). Decides how the step is recorded for replay. */
  kind: "control" | "tile";
}

/** What the page offered, for the message when we refuse. */
export interface PermitTypeRefusal {
  reason: "none" | "ambiguous";
  offered: string[];
  matched: string[];
  /** The choice tiles the page offered (their titles; a subset of `offered`), so a refusal
   *  can NAME the choices a person has to make — never "nothing fillable" on a page of ten. */
  tiles: string[];
  /** Set when the page offered exactly ONE tile and its title is not a real-filing control
   *  (the entry vocabulary's exclusions): not a type we can name, but the page's single
   *  choice, which the learner enters when nothing else on the page advances. */
  singleTile?: PermitTypeChoice;
}

// WHICH VOCABULARY LEADS. A type that names the JOB — solar / photovoltaic / PV / renewable
// energy / interconnection — outranks a type that names the track's DISCIPLINE, on every
// track. The record-type guard in autoLearnAdapter (RECORD_TYPE_LABEL) already answers this
// question that way: "a solar/PV-specific type is always allowed: that IS the right answer
// wherever an AHJ offers one". Portland DevHub is the live proof — its tile says "The new
// Solar Permit Request includes the Renewable Energy Electrical Permit", so an electrical-
// track run that took "Trade Permits", or a structural-track run that took "Building Permit
// Request", would file the wrong permit. The discipline vocabulary is the SECOND tier: it
// decides at an AHJ with no solar-specific type, where a solar job files as an electrical
// permit plus a building permit.
//
// Deliberately not one "solar-ish" regex over the exclusions: on an AHJ menu "Commercial
// Solar Permit" and "Residential Solar Permit" both contain solar, and choosing between them
// by position is how the wrong permit gets filed — the commercial twin is excluded below.
const JOB_PATTERNS: RegExp[] = [/\bsolar\b/i, /photovoltaic/i, /\bpv\b/i, /renewable\s+energy/i, /net\s*-?\s*meter/i, /interconnect/i];
const DISCIPLINE_PATTERNS: Record<string, RegExp[]> = {
  electrical: [/\belectric(al)?\b/i],
  structural: [/\bstructural\b/i, /\bbuilding\b/i],
};

// Never a permit type for a residential rooftop solar job, however well it matches above.
const TYPE_EXCLUDE: RegExp[] = [
  /\bcommercial\b/i,          // the residential twin is the one we file
  /\bpre-?application\b/i,
  /\bextension\b/i,           // a Permit Extension Request is not a permit
  /\brenew(al)?\b/i,
  /\brevision\b/i,
  /\bamend(ment)?\b/i,
  /\binspection\b/i,
  /\blook ?up\b|\bsearch\b/i,
  /\bdemolition\b/i,
  /\btemporary\b/i,
  // "Renewable Energy Rebate" matches the job vocabulary and files nothing — the trap
  // PROGRAM_EXCLUDE (applicationProgram.ts) already guards for programme choices.
  /\brebate\b|\bincentive\b/i,
  // "Solar Permit Fees" / "Invoices" / "Payments" are the operator's money, not a kind of
  // permit — the same door the dashboard guard shuts on a link so labelled (isPayFee).
  /\bfees?\b|\binvoices?\b|\bpayments?\b/i,
];

export function permitTypeCandidates(
  labels: string[],
  track: string,
  /** `ownNames`: the client's company / legal / DBA names, from the client record (#328). */
  opts: { ownNames?: readonly string[] } = {},
): string[] {
  const eligible = labels.filter((raw) => {
    const label = (raw || "").replace(/\s+/g, " ").trim();
    if (!label || label.length > 80) return false;
    if (TYPE_EXCLUDE.some((re) => re.test(label))) return false;
    if (isExcludedEntryLabel(label)) return false;
    // The installer's own name is never a permit type, however "Solar" it reads.
    if (isOwnIdentityLabel(label, opts.ownNames)) return false;
    return true;
  });
  // First tier with a hit wins; several hits in that tier is the caller's ambiguity.
  for (const tier of [JOB_PATTERNS, DISCIPLINE_PATTERNS[track] ?? []]) {
    const hits = eligible.filter((raw) => tier.some((re) => re.test(raw)));
    if (hits.length) return hits;
  }
  return [];
}

/** Pick the permit type for this track, or refuse and say why. Never guesses. */
export async function chooseApplicationType(
  page: Page,
  track: string,
  /** `ownNames`: the client's company / legal / DBA names from the CLIENT RECORD — never read
   *  off the page. A candidate that is, or contains, one of them is never a permit type. */
  opts: { ownNames?: readonly string[] } = {},
): Promise<{ ok: true; choice: PermitTypeChoice } | { ok: false; refusal: PermitTypeRefusal }> {
  const scopes: Array<Page | Frame> = typeof page.frames === "function" ? page.frames() : [page];
  const offeredAll: string[] = [];
  const tilesAll: string[] = [];
  const tileChoices: Array<{ label: string; locator: Locator }> = [];
  for (const scope of scopes) {
    // A permit type offered as a CARD is a candidate by its title — same vocabulary, same
    // exclusions, same refusals as a link. The information links inside the cards are in
    // `labels` below, under their own text, and the exclusion list refuses them there.
    // Scanned FIRST: scanChoiceTiles stamps the page's chrome, which the label pool reads.
    const tiles = await scanChoiceTiles(scope);
    let labels: string[] = [];
    try {
      labels = await (scope as Frame).evaluate(() => {
        const vis = (el: Element): boolean => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        // NEVER CHROME (#328): not the frame, not a menu toggle, not the installer's own
        // account. Live DevHub's account button reads the company's name, which contains
        // "Solar", and tied with "Solar Permit Request" as the job's type.
        return (Array.from(document.querySelectorAll("a, button, [role=button], input[type=button]")) as HTMLElement[])
          .filter(vis)
          .filter((el) => !el.closest("[data-al-chrome]"))
          .map((el) => ((el as HTMLInputElement).value || el.textContent || "").replace(/\s+/g, " ").trim())
          .filter((t) => t.length >= 3);
      });
    } catch { labels = []; }
    const tileLabels = tiles.map((t) => t.label);
    if (!labels.length && !tiles.length) continue;
    for (const l of [...labels, ...tileLabels]) if (!offeredAll.includes(l)) offeredAll.push(l);
    for (const l of tileLabels) if (!tilesAll.includes(l)) tilesAll.push(l);
    for (const t of tiles) tileChoices.push({ label: t.label, locator: (scope as Frame).locator(`[data-al-tile="${t.key}"]`).first() as Locator });

    const matched = [...new Set(permitTypeCandidates([...labels, ...tileLabels], track, { ownNames: opts.ownNames }))];
    if (matched.length === 1) {
      const label = matched[0];
      // A link/button that carries the label is the control; a tile is the control only when
      // no link or button says the same thing (a card whose title is also a link is entered by
      // the link, as it always was).
      if (labels.includes(label)) {
        const loc = (scope as Frame).getByRole("link", { name: label, exact: true })
          .or((scope as Frame).getByRole("button", { name: label, exact: true })).first();
        if (await loc.count().catch(() => 0)) return { ok: true, choice: { locator: loc, label, kind: "control" } };
      }
      const tile = tiles.find((t) => t.label === label);
      if (tile) {
        const loc = (scope as Frame).locator(`[data-al-tile="${tile.key}"]`).first();
        if (await loc.count().catch(() => 0)) return { ok: true, choice: { locator: loc, label, kind: "tile" } };
      }
    }
    if (matched.length > 1) {
      return { ok: false, refusal: { reason: "ambiguous", offered: offeredAll.slice(0, 40), matched, tiles: tilesAll } };
    }
  }
  // ONE card and nothing else: not a type we can name, but the page's single choice. Offered
  // to the caller as such — never when its title is a real-filing control ("Pay Fees Due",
  // "My Permits", "Resume …"), which the entry vocabulary refuses.
  const singleTile: PermitTypeChoice | undefined = tileChoices.length === 1 && !isExcludedEntryLabel(tileChoices[0].label)
    && !isOwnIdentityLabel(tileChoices[0].label, opts.ownNames)
    ? { locator: tileChoices[0].locator, label: tileChoices[0].label, kind: "tile" }
    : undefined;
  return { ok: false, refusal: { reason: "none", offered: offeredAll.slice(0, 40), matched: [], tiles: tilesAll, singleTile } };
}
export function normalizeEntryLabel(label: string): string {
  return String(label ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export async function enterApplicationFlow(
  page: Page,
  opts: {
    /**
     * Labels already clicked this run. A portal whose entry opens a DRAWER IN PLACE still
     * looks like a dashboard afterwards, so this pass finds the same control again and
     * clicks it — which TOGGLES the drawer shut (or resets it), throwing away the form that
     * was already open, and records the click a second time so every future replay resets
     * the drawer too. Checked BEFORE the click, not after: the previous guard ran on the
     * result and the damage was already done.
     */
    skipLabels?: Iterable<string>;
  } = {},
): Promise<{ ok: boolean; message: string; url: string; label?: string; viaModule?: string; alreadyClicked?: boolean }> {
  // DEEP by design. Accela's logged-in home offers only module tabs — the entry is one hop
  // inside Permits — so a shallow look finds nothing and the caller falls through to the LLM
  // planner, which is exactly the path that drifted into the records module on a live run.
  const deep = await findApplicationEntryDeep(page);
  if (!deep) {
    return { ok: false, message: "No 'start an application' control found on this page.", url: typeof page.url === "function" ? page.url() : "" };
  }
  // findApplicationEntryDeep leaves the page wherever the entry was found; re-resolve the
  // control there so the click targets what it actually located.
  const found = await findApplicationEntry(page);
  if (!found) {
    return { ok: false, message: `Found "${deep.match.label}" but it was gone when the click was attempted.`, url: typeof page.url === "function" ? page.url() : "", label: deep.match.label };
  }
  const before = typeof page.url === "function" ? page.url() : "";
  const skip = new Set(Array.from(opts.skipLabels ?? [], normalizeEntryLabel));
  if (skip.has(normalizeEntryLabel(found.match.label))) {
    return {
      ok: false,
      alreadyClicked: true,
      message: `Already entered the application flow via "${found.match.label}" — not clicking it again.`,
      url: before,
      label: found.match.label,
    };
  }
  try {
    await found.locator.click({ timeout: 10000 });
    await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => null);
    await page.waitForTimeout?.(1500);
  } catch (err) {
    return { ok: false, message: `Found "${found.match.label}" but the click failed: ${err instanceof Error ? err.message : String(err)}`, url: before, label: found.match.label };
  }
  const after = typeof page.url === "function" ? page.url() : "";
  return {
    ok: true,
    message: `Entered the application flow via "${found.match.label}"${deep.viaModule ? ` (one hop through "${deep.viaModule}")` : ""}.`,
    url: after,
    label: found.match.label,
    viaModule: deep.viaModule,
  };
}
