// Public (unauthenticated) permit-status fetchers for the most common AHJ portal platforms.
//
// These run as plain HTTP requests — no Playwright, no login required. They complement
// the authenticated browser scrape (checkStatus on adapters) and the email tracker.
// Failure is silent: if the fetch fails or returns nothing useful, the caller falls back
// to the next strategy.
//
// Platform detection is by URL pattern so the operator only needs to paste the portal URL
// when setting up a permit_check_target — no manual platform selection required.
//
// SAFETY: read-only fetches only. Never submits, modifies, or pays.

export type PortalPlatform =
  | "accela"
  | "energov"
  | "projectdox"
  | "opengov"
  | "civicplus"
  | "solarapp"
  | "public_url" // generic — strip HTML and return text
  | "unknown";

/** Detect which platform a portal URL belongs to. */
export function detectPlatform(portalUrl: string): PortalPlatform {
  const u = portalUrl.toLowerCase();
  if (u.includes("accela.com") || u.includes("/Cap/Cap")) return "accela";
  if (u.includes("energov") || u.includes("tyler") || u.includes("selfservice#/permit")) return "energov";
  if (u.includes("projectdox") || u.includes("avolve")) return "projectdox";
  if (u.includes("opengov.com") || u.includes("ogov.com")) return "opengov";
  if (u.includes("civicplus") || u.includes("mgoconnect") || u.includes("mycivil")) return "civicplus";
  if (u.includes("gosolarapp") || u.includes("solarapp")) return "solarapp";
  if (u.startsWith("http")) return "public_url";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Accela Citizen Access (ACA) — most common in OR/WA/CA
// ---------------------------------------------------------------------------
// Permit numbers on Oregon ePermitting look like: 24-001234-STR, 24-001234-RS, etc.
// Accela's capID URL format splits the number into three parts.
// For jurisdictions that store the direct CapDetail link in portal_url, a plain
// GET is enough. For ones that only have the base URL, we attempt a search POST.

function parseAccelaCapId(permitNumber: string): { capID1: string; capID2: string; capID3: string } | null {
  // Try three-part dash split: "24CAP-00000-03DS7" → capID1=24CAP, capID2=00000, capID3=03DS7
  const parts = permitNumber.trim().split("-");
  if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
    return { capID1: parts[0], capID2: parts[1], capID3: parts[2] };
  }
  // Oregon format "24-001234-STR": capID1=24, capID2=001234, capID3=STR
  if (parts.length === 3) {
    return { capID1: parts[0], capID2: parts[1], capID3: parts[2] };
  }
  return null;
}

function accelaBaseUrl(portalUrl: string): string {
  // Extract the base up to the agency path segment, e.g.
  // "https://aca-oregon.accela.com/oregon/Cap/CapHome.aspx?..."
  // → "https://aca-oregon.accela.com/oregon"
  try {
    const u = new URL(portalUrl);
    const segs = u.pathname.split("/").filter(Boolean);
    const agencyIdx = segs.findIndex((s) => /^[A-Z_]{2,20}$/i.test(s));
    const agencyPath = agencyIdx >= 0 ? "/" + segs.slice(0, agencyIdx + 1).join("/") : "";
    return `${u.protocol}//${u.host}${agencyPath}`;
  } catch {
    return portalUrl.replace(/\/Cap\/.*$/, "").replace(/\?.*$/, "");
  }
}

async function fetchAccelaStatus(portalUrl: string, applicationNumbers: string[]): Promise<string | null> {
  const base = accelaBaseUrl(portalUrl);

  // Strategy 1: if the tracking URL IS the CapDetail page, fetch it directly.
  // This is the best path — the operator pasted the exact public record link.
  // Preserve the full query string (includes agencyCode, TabName, Module, capIDs).
  if (portalUrl.toLowerCase().includes("capdetail.aspx")) {
    const text = await htmlToText(portalUrl);
    if (text && text.length > 40) return text;
  }

  // Strategy 2: construct a CapDetail URL from the application/permit number.
  // Try to extract agencyCode from the portalUrl if present.
  let agencyCodeParam = "";
  try {
    const u = new URL(portalUrl);
    const code = u.searchParams.get("agencyCode");
    if (code) agencyCodeParam = `&agencyCode=${encodeURIComponent(code)}`;
  } catch { /* ignore */ }

  for (const num of applicationNumbers) {
    if (!num) continue;
    const capId = parseAccelaCapId(num);
    if (capId) {
      const detailUrl = `${base}/Cap/CapDetail.aspx?Module=Building&TabName=Building&capID1=${encodeURIComponent(capId.capID1)}&capID2=${encodeURIComponent(capId.capID2)}&capID3=${encodeURIComponent(capId.capID3)}${agencyCodeParam}`;
      const text = await htmlToText(detailUrl);
      // Same relevance rule as the search strategies below: a guessed capID that
      // resolves to an error page or someone else's record must not pass as status.
      if (text && text.length > 100 && text.replace(/[\s-]+/g, "").toUpperCase().includes(num.replace(/[\s-]+/g, "").toUpperCase())) return text;
    }
  }

  // A SEARCH PAGE'S OWN CHROME IS NOT A STATUS. CapHome/GlobalSearch responses are
  // full ACA pages ("Create a New Portfolio... General Search...") that sail past a
  // bare length check and reach the classifier as if they were status text (live
  // Mockdata check, 2026-09-21). A page that never mentions the number we asked
  // about answered a different question — reject it and fall through to the honest
  // "no status text" default.
  const mentionsAnyNumber = (text: string): boolean => {
    const flat = text.replace(/[\s-]+/g, "").toUpperCase();
    return applicationNumbers.some((num) => num && flat.includes(num.replace(/[\s-]+/g, "").toUpperCase()));
  };

  // Strategy 3: the global search page — server-rendered, works anonymously, and
  // takes the DISPLAY number verbatim (capID construction needs the internal
  // triplet, which Oregon's 4-part city numbers like 187-26-000328-STR don't map
  // to). Proven against aca-oregon: an indexed record comes back as a result row
  // naming the number; an unindexed one says "returned no results". The no-results
  // test runs on the RAW HTML — the extracted fragment can omit that sentence while
  // the search box's echo of the query still satisfies the number check.
  for (const num of applicationNumbers) {
    if (!num) continue;
    const globalUrl = `${base}/Cap/GlobalSearchResults.aspx?QueryText=${encodeURIComponent(num)}`;
    const html = await fetchHtml(globalUrl);
    if (!html || /returned no results/i.test(html)) continue;
    const text = await extractVisibleText(html);
    if (text && text.length > 100 && mentionsAnyNumber(text)) return text;
  }

  // Strategy 4: public record search page (works on some ACA configurations).
  for (const num of applicationNumbers) {
    if (!num) continue;
    const searchUrl = `${base}/Cap/CapHome.aspx?module=Building&TabName=Building&capCapId=${encodeURIComponent(num)}`;
    const text = await htmlToText(searchUrl);
    if (text && text.length > 100 && mentionsAnyNumber(text)) return text;
  }

  return null;
}

// ---------------------------------------------------------------------------
// ACCELA: FIND A FILING'S RECORD BY ITS NUMBER THROUGH THE MODULE'S OWN SEARCH (#443)
// ---------------------------------------------------------------------------
// A permit filing with a record number but no status link (no recipe, no portal login, filed before
// #400 captured links) was never read: the global search and the guessed capID triplet above never
// find Oregon's four-part numbers (187-26-000328-STR). The module's general search does, anonymously
// (worker-local, live, 2026-10-31 on #413): CapHome.aspx?module=Building, the permit-number box, the
// Search control — and a number that names exactly one record lands on that record's CapDetail page.
// The caller (runDuePermitChecks) stores that page's link as the target's tracking_url, so every later
// check is the plain GET of strategy 1 above.
//
// HOW (settled against the fixture, backend/test/accelaRecordSearch.test.ts): a plain HTTP postback,
// no browser. CapHome is an ASP.NET WebForms page; its Search control is a __doPostBack link, so a
// browser's click submits the form with __EVENTTARGET naming the control and every other field as the
// page rendered it. This sends exactly that form data set (HTML's own rules: hidden fields, the boxes'
// values, each select's chosen option; no other button), with the session cookie the GET set.
// Whether the live ACA answers a postback with no JS-set fields the same way is the local-only proof.
//
// RULE 1 — a query, never a filing. Two kinds of request only: GETs of the search page and of the
// record page it lands on, and ONE postback whose event target is the module's Search control
// (named …btnNewSearch, reading "Search"). Nothing that opens, modifies, pays or resubmits: a page
// with no such control is not searched, and no other button's name is ever sent.
// RULE 5 — the caller hands in `allowUrl` (a permit track, the target's own AHJ portal and tenant:
// trackSafeUrl + samePortal); every URL this fetches, each redirect hop included, is asked first.
//
// A RECORD IS FOUND ONLY WHEN IT IS THE ONE THE NUMBER NAMES. The record page's own number
// (…lblPermitNumber, or "Record <number>:") must equal the number searched, whole: a similar number
// (…-STR-REV, a longer number starting with this one) is a different record. A results list naming
// several records is not guessed from.

/** The ACA module a record number's suffix belongs to (Oregon ePermitting: 24-001234-STR is
 *  Building, 519-26-001666-ELEC electrical). "" for a suffix this does not know. */
const ACCELA_SUFFIX_MODULE: Array<[RegExp, string]> = [
  [/^(?:STR|RS|RES|BLD|BLDG|BP|COM|SOLAR|SLR|PV)$/, "Building"],
  [/^(?:ELEC|ELE|EL|EP)$/, "Electrical"],
  [/^(?:PLMB|PLB|PLUM)$/, "Plumbing"],
  [/^(?:MECH|MEC)$/, "Mechanical"],
];
const ACCELA_DEFAULT_MODULES = ["Building", "Electrical", "Plumbing", "Mechanical"];

/** Modules to search, in order: the number's own by suffix, then the portal URL's module, then the
 *  rest. One search per check (the caller picks one from this list per check, in turn). */
export function accelaModulesForNumber(recordNumber: string, portalUrl: string): string[] {
  const suffix = String(recordNumber || "").trim().toUpperCase().split("-").filter(Boolean).pop() ?? "";
  const bySuffix = ACCELA_SUFFIX_MODULE.find(([re]) => re.test(suffix))?.[1] ?? "";
  let fromUrl = "";
  try {
    const u = new URL(portalUrl);
    for (const [k, v] of u.searchParams) if (k.toLowerCase() === "module" && /^[A-Za-z]{2,30}$/.test(v)) fromUrl = v;
  } catch { /* no module on the URL */ }
  const out: string[] = [];
  for (const m of [bySuffix, fromUrl, ...ACCELA_DEFAULT_MODULES]) {
    if (m && !out.some((o) => o.toLowerCase() === m.toLowerCase())) out.push(m);
  }
  return out;
}

export type AccelaRecordSearch =
  | { found: true; link: string; text: string; module: string }
  | { found: false; module: string; reason: string };

/** The record number, compared whole: case and whitespace only (dashes are part of the number). */
const sameRecordNumber = (a: string, b: string): boolean =>
  Boolean(a) && a.replace(/\s+/g, "").toUpperCase() === b.replace(/\s+/g, "").toUpperCase();

/** Does this record page name exactly this number as ITS record? The page's own number label when
 *  the page has one; otherwise its "Record <number>:" heading, the number bounded on both sides. */
async function recordPageNamesNumber(html: string, recordNumber: string): Promise<boolean> {
  const { load } = await import("cheerio");
  const $ = load(html);
  const label = $("[id$='lblPermitNumber']").first();
  if (label.length) return sameRecordNumber(label.text(), recordNumber);
  $("script, style, noscript").remove();
  const textAll = $("body").text().replace(/\s+/g, " ");
  const num = recordNumber.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9-])Record\\s+${num}\\s*:`, "i").test(textAll);
}

/** Search one ACA module for one record number (see the block above). Never throws. */
export async function searchAccelaRecordByNumber(
  portalUrl: string,
  recordNumber: string,
  opts: { module: string; allowUrl: (url: string) => boolean; fetchImpl?: typeof fetch },
): Promise<AccelaRecordSearch> {
  const module = opts.module;
  const miss = (reason: string): AccelaRecordSearch => ({ found: false, module, reason });
  const number = String(recordNumber || "").trim();
  if (!number || !/^[A-Za-z]{2,30}$/.test(module)) return miss("no record number or module to search");
  const doFetch = opts.fetchImpl ?? fetch;
  const cookies = new Map<string, string>();
  const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const keepCookies = (res: Response) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const pair = c.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  };
  /** One request, its redirects followed by hand so every hop is asked (rule 5) and keeps the
   *  session cookie. A POST answered by a redirect continues as a GET, as a browser does. */
  const request = async (url: string, body?: URLSearchParams): Promise<{ url: string; html: string } | { refused: string }> => {
    let at = url;
    let form = body;
    for (let hop = 0; hop < 5; hop++) {
      if (!opts.allowUrl(at)) return { refused: `${at.slice(0, 200)} is not this filing's AHJ portal` };
      let res: Response;
      try {
        res = await doFetch(at, {
          method: form ? "POST" : "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(15000),
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; permit-status-bot/1.0)",
            ...(cookies.size ? { Cookie: cookieHeader() } : {}),
            ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
          },
          ...(form ? { body: form.toString() } : {}),
        });
      } catch (err) {
        return { refused: `the portal did not answer (${err instanceof Error ? err.message.slice(0, 120) : String(err)})` };
      }
      keepCookies(res);
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        at = new URL(location, at).toString();
        form = undefined;
        continue;
      }
      if (!res.ok) return { refused: `the portal answered HTTP ${res.status}` };
      return { url: at, html: await res.text() };
    }
    return { refused: "the portal redirected too many times" };
  };

  const base = accelaBaseUrl(portalUrl);
  const searchUrl = `${base}/Cap/CapHome.aspx?module=${encodeURIComponent(module)}&TabName=${encodeURIComponent(module)}`;
  const page = await request(searchUrl);
  if ("refused" in page) return miss(page.refused);

  const { load } = await import("cheerio");
  const $ = load(page.html);
  // THE SEARCH CONTROL, AND ONLY IT (rule 1). Accela's general search: the permit-number box
  // (…txtGSPermitNumber) and the Search control (…btnNewSearch), a __doPostBack link in ACA.
  const box = $("input[name$='txtGSPermitNumber']").first();
  const control = $("[id$='btnNewSearch'], [name$='btnNewSearch']").first();
  if (!box.length || !control.length) return miss(`the ${module} search page has no record-number search`);
  if (control.text().replace(/\s+/g, " ").trim().toLowerCase() !== "search" && String(control.attr("value") ?? "").trim().toLowerCase() !== "search") {
    return miss(`the ${module} search control does not read "Search"`);
  }
  const formEl = box.closest("form");
  if (!formEl.length) return miss(`the ${module} search box is outside any form`);
  let action: string;
  try {
    action = new URL(formEl.attr("action") || page.url, page.url).toString();
  } catch {
    return miss("the search form's action is not a URL");
  }
  if (!/\/Cap\/CapHome\.aspx$/i.test(new URL(action).pathname)) return miss("the search form does not post back to the search page");
  const postBack = /__doPostBack\(\s*'([^']+)'/.exec(String(control.attr("href") ?? control.attr("onclick") ?? ""));
  const controlName = String(control.attr("name") ?? "");
  const eventTarget = postBack?.[1] ?? "";
  if (eventTarget && !/btnNewSearch$/.test(eventTarget)) return miss("the Search control posts back to another control");
  if (!eventTarget && !controlName) return miss("the Search control has no postback name");

  // The form data set a browser's click would send (HTML form submission): every enabled named
  // field as rendered — hidden fields, boxes, each select's chosen option, checked boxes — no other
  // button; the permit-number box carries the number; __EVENTTARGET names the Search control.
  const data = new URLSearchParams();
  formEl.find("input[name], select[name], textarea[name]").each((_, el) => {
    const f = $(el);
    if (f.is("[disabled]")) return;
    const name = String(f.attr("name"));
    const tag = (el as { tagName?: string }).tagName?.toLowerCase();
    if (tag === "select") {
      const chosen = f.find("option[selected]").first();
      const opt = chosen.length ? chosen : f.find("option").first();
      if (opt.length) data.append(name, String(opt.attr("value") ?? opt.text()));
      return;
    }
    if (tag === "textarea") { data.append(name, f.text()); return; }
    const type = String(f.attr("type") ?? "text").toLowerCase();
    if (["submit", "button", "image", "reset", "file"].includes(type)) return;
    if ((type === "checkbox" || type === "radio") && !f.is("[checked]")) return;
    data.append(name, String(f.attr("value") ?? (type === "checkbox" || type === "radio" ? "on" : "")));
  });
  data.set(String(box.attr("name")), number);
  if (eventTarget) {
    data.set("__EVENTTARGET", eventTarget);
    data.set("__EVENTARGUMENT", "");
  } else {
    data.set(controlName, String(control.attr("value") ?? "Search"));
  }

  const answer = await request(action, data);
  if ("refused" in answer) return miss(answer.refused);

  // WHERE THE SEARCH LANDED. One record: ACA redirects to its CapDetail (followed above), or answers
  // an async postback with "pageRedirect||<url>|". A list: its record links, judged below.
  let detail: { url: string; html: string } | null = null;
  if (/\/Cap\/CapDetail\.aspx$/i.test(new URL(answer.url).pathname)) detail = answer;
  if (!detail) {
    const asyncRedirect = /pageRedirect\|\|([^|]+)\|/.exec(answer.html);
    let listed: string[] = [];
    if (asyncRedirect) {
      try { listed = [new URL(decodeURIComponent(asyncRedirect[1]!), answer.url).toString()]; } catch { listed = []; }
    } else {
      const $r = load(answer.html);
      $r("nav, header, footer, [role='navigation']").remove();
      const seen = new Set<string>();
      $r("a[href]").each((_, a) => {
        const href = String($r(a).attr("href") ?? "");
        if (!/CapDetail\.aspx/i.test(href)) return;
        try {
          const u = new URL(href, answer.url).toString();
          if (!seen.has(u)) { seen.add(u); listed.push(u); }
        } catch { /* not a link */ }
      });
      if (listed.length > 1) return miss(`the ${module} search listed ${listed.length} records for ${number}; none is chosen`);
      if (listed.length === 1) {
        const anchorText = $r(`a[href]`).filter((_, a) => /CapDetail\.aspx/i.test(String($r(a).attr("href") ?? ""))).first().text();
        if (!sameRecordNumber(anchorText, number)) return miss(`the ${module} search's one result is not ${number}`);
      }
    }
    if (listed.length === 0) return miss(`the ${module} search found no record ${number}`);
    const got = await request(listed[0]!);
    if ("refused" in got) return miss(got.refused);
    detail = got;
  }
  if (!/\/Cap\/CapDetail\.aspx$/i.test(new URL(detail.url).pathname)) return miss(`the ${module} search did not land on a record page`);
  if (!(await recordPageNamesNumber(detail.html, number))) return miss(`the record page the ${module} search landed on is not ${number}`);
  const text = await extractVisibleText(detail.html);
  if (!text || text.length <= 40) return miss("the record page held no readable text");
  return { found: true, link: detail.url, text, module };
}

// ---------------------------------------------------------------------------
// EnerGov / Tyler Technologies Citizen Self-Service (CSS)
// ---------------------------------------------------------------------------
// CSS portals have a public permit-lookup URL like:
// https://energov.[city].gov/EnerGovProd/selfservice#/permit/<number>
// The hash fragment is client-side routed so a plain fetch won't execute JS,
// but the API behind it is often at: /api/permit/search?permitNumber=<n>
// We try both.

async function fetchEnerGovStatus(portalUrl: string, applicationNumbers: string[]): Promise<string | null> {
  for (const num of applicationNumbers) {
    if (!num) continue;

    // Try the REST API endpoint that the CSS SPA calls.
    const apiBase = portalUrl.replace(/#.*$/, "").replace(/\/selfservice.*$/, "");
    const apiUrl = `${apiBase}/api/permit/search?permitNumber=${encodeURIComponent(num)}&pageNumber=1&pageSize=5`;
    try {
      const res = await fetch(apiUrl, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const json = await res.json().catch(() => null);
        if (json) return JSON.stringify(json).slice(0, 3000);
      }
    } catch { /* try next */ }

    // Fallback: plain HTML fetch to the search URL.
    const searchUrl = `${apiBase}/selfservice#/permit/${encodeURIComponent(num)}`;
    const text = await htmlToText(searchUrl);
    if (text && text.length > 80) return text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// SolarAPP+ — instant solar permit approvals
// ---------------------------------------------------------------------------
// Permits issued via SolarAPP+ carry a SolarAPP+ application ID. The status
// API is publicly accessible when a project_id is known:
// https://api.gosolarapp.org/v1/projects/{id}/status  (requires API key)
// Fallback: their public portal shows status at gosolarapp.org

async function fetchSolarAppStatus(portalUrl: string, applicationNumbers: string[]): Promise<string | null> {
  // SolarAPP+ portal is mostly gated; plain HTML fetch is our best bet.
  return htmlToText(portalUrl);
}

// ---------------------------------------------------------------------------
// Generic public URL — parse HTML and return visible text (cheerio-powered)
// ---------------------------------------------------------------------------
export async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; permit-status-bot/1.0)" },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** THE WHOLE RECORD PAGE'S TEXT, not the status fragment extractVisibleText picks. The fee
 *  reader (portalFeeReadings.ts) needs the page's Fees section, which sits far from the status
 *  and which the status extractor's first-match selectors never reach. Read-only GET. */
export async function fetchRecordPageText(url: string): Promise<string | null> {
  const html = await fetchHtml(url);
  if (html == null) return null;
  try {
    const { load } = await import("cheerio");
    const $ = load(html);
    $("script, style, noscript, iframe, svg").remove();
    const text = $("body").text().replace(/[ \t\r]+/g, " ").replace(/\n\s*(?:\n\s*)+/g, "\n").trim();
    return text ? text.slice(0, 60000) : null;
  } catch {
    return null;
  }
}

export async function htmlToText(url: string): Promise<string | null> {
  const html = await fetchHtml(url);
  if (html == null) return null;
  return extractVisibleText(html);
}

export async function extractVisibleText(html: string): Promise<string | null> {
  try {
    const { load } = await import("cheerio");
    const $ = load(html);

    // Remove noise: scripts, styles, navigation chrome, cookie banners.
    $("script, style, noscript, nav, header, footer, iframe, svg").remove();
    $("[class*='nav' i], [class*='menu' i], [class*='cookie' i], [class*='banner' i], [id*='nav' i], [id*='menu' i]").remove();

    // Try to extract the most status-relevant section first.
    const statusSelectors = [
      "[class*='status' i]",
      "[id*='status' i]",
      "[class*='permit' i]",
      "[id*='permit' i]",
      "[class*='record' i]",
      "[class*='detail' i]",
      "main",
      "article",
      "[role='main']",
      "table",
    ];

    for (const sel of statusSelectors) {
      const el = $(sel).first();
      if (el.length) {
        const t = el.text().replace(/\s+/g, " ").trim();
        if (t.length > 80) return t.slice(0, 8000);
      }
    }

    const bodyText = $("body").text().replace(/\s+/g, " ").trim();
    return bodyText.slice(0, 8000) || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
/** Try every applicable public (unauthenticated) check strategy for the given
 *  portal URL and application/permit numbers. Returns the raw status text to
 *  feed into classifyPermitStatusText(text, track) — the caller
 *  (repository.recordPermitStatusCheck) passes the TARGET's track, since the
 *  same "Approved" is the interconnection approval on a NEM target and plan
 *  review done on a permit target — or null if nothing useful was found. */
export async function publicPermitStatusCheck(
  portalUrl: string,
  applicationNumbers: string[],
): Promise<string | null> {
  if (!portalUrl || !applicationNumbers.some(Boolean)) return null;
  const platform = detectPlatform(portalUrl);

  switch (platform) {
    case "accela":
      return fetchAccelaStatus(portalUrl, applicationNumbers);
    case "energov":
      return fetchEnerGovStatus(portalUrl, applicationNumbers);
    case "solarapp":
      return fetchSolarAppStatus(portalUrl, applicationNumbers);
    case "projectdox":
      // ProjectDox has no public API; rely on authenticated scrape + email.
      return null;
    case "opengov":
    case "civicplus":
    case "public_url":
      return htmlToText(portalUrl);
    default:
      return null;
  }
}
