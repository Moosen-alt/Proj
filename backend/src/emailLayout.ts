// ---------------------------------------------------------------------------
// ONE LOOK FOR EVERY EMAIL KEELIX SENDS (#589).
//
// Until this module every email left through one text-only call with a bare From address and no
// layout, so the first real staff alert read as a log line: "Keelix — needs you: Permit correction
// notice received — <address>", then "Track: … / What happened: … / Why: … / Open the project: …".
// Clients got the same treatment. Now every builder describes its message as EmailContent and
// renderEmail turns it into an HTML part and a plain-text twin; sendEmail (clientNotifier.ts) sends
// both, and a caller that still hands it plain text gets that text wrapped in the same layout
// (wrapPlainText), so EVERY email carries the look at minimum.
//
// THE HTML. Table layout with inline CSS only (no <style> block: Gmail drops or scopes it, Outlook
// reads little of it), 600px wide and fluid below that, a bulletproof table button, no remote image
// and no SVG (Gmail drops SVG; a remote image is a tracking-pixel lookalike and blocked by default).
// The header is a TEXT wordmark — KEELIX over AUTOMATION — in the dashboard's own colours
// (frontend/styles.css .brand-name / .brand-sub and the Keelix palette, converted from oklch).
// DARK MODE without a media query: every text-bearing cell sets BOTH its text colour AND its
// background (style plus the bgcolor attribute Outlook reads), so a client that inverts flips the
// two together and a client that does not keeps both. Nothing ever paints a coloured background
// without its own text colour — that is how white-on-white happens.
//
// THE TEXT TWIN IS THE MESSAGE. It is what the communications / staff_notifications row stores, what
// a staff webhook (phone push) receives, what a person copies from a draft and what a re-send
// replays — and code reads it back: refreshStatusLink rewrites the "Live status page (no login
// needed): …" line, maskCredentialLinks masks the one-time token, tests pin its lines. So it has a
// FIXED shape: content only (the wordmark and the footer are HTML chrome), the action as
// "<text label>: <url>" on its own line, detail rows as adjacent "Label: value" lines, a section
// heading ending in a colon, items as "- " or "1. " lines, and never a hard wrap.
//
// ESCAPING (rule 2 and injection). Every interpolated value goes through escapeHtml; a link is made
// only from an http(s) URL (safeHttpUrl), anything else is shown as text and never becomes an href.
// This module does no secret scrubbing of its own: a builder scrubs its CONTENT (mapEmailText) and
// renders both parts from the scrubbed fields, so the HTML can never carry what the text does not.
//
// FROM. SMTP_FROM stays a bare address; the display name is SMTP_FROM_NAME (default "<BRAND>
// Filings"). An older SMTP_FROM written as "Name <address>" still works: its address is used, and
// its name when SMTP_FROM_NAME is unset (mailFrom). The footer reads "<BRAND> Automation · <address>",
// the address being FILING_CONTACT_EMAIL, else SMTP_FROM's address, else none — never a literal.
//
// PURE: env and strings only, no database. scripts/ops/mailer.ts (the watchdog) imports it.
// ---------------------------------------------------------------------------
import { BRAND } from "./brand";
import { filingContactEmailSetting } from "./filingContact";
import { looksLikeEmail } from "../../shared/src/emailAddress";

export type EmailAudience = "staff" | "client";

/** The one primary button. `textLabel` is how the plain-text twin introduces the URL (the button's
 *  own words when unset): "Live status page (no login needed)" reads well in text, not on a button. */
export interface EmailAction { label: string; url: string; textLabel?: string }

/** A list item. `url` makes a link under the item (http(s) only); `linkLabel` is its words. */
export interface EmailItem { text: string; url?: string; linkLabel?: string }

export interface EmailSection {
  heading?: string;
  paragraphs?: string[];
  items?: Array<string | EmailItem>;
  ordered?: boolean;
}

export interface EmailContent {
  audience: EmailAudience;
  /** The inbox preview line — hidden in the body. */
  preheader: string;
  /** A small label over the headline ("Action needed · Permit"). HTML only: it repeats the content. */
  eyebrow?: string;
  headline: string;
  greeting?: string;
  /** What happened, in a sentence or three. */
  intro?: string | string[];
  rows?: Array<[string, string]>;
  sections?: EmailSection[];
  /** What to do next — set apart in the HTML. */
  nextStep?: string;
  action?: EmailAction;
  note?: string | string[];
  signoff?: string[];
}

export interface RenderedEmail { html: string; text: string }

export interface RenderOptions {
  /** The footer's address. Default: footerContact(process.env). "" = no address. */
  contact?: string;
}

// ── the palette (frontend/styles.css :root, oklch → sRGB) ────────────────────────────────────────
const C = {
  page: "#e6f1f0",        // --background
  card: "#ffffff",        // --card
  text: "#091a1f",        // --foreground
  muted: "#415359",       // --muted-foreground
  border: "#afbec3",      // --border
  band: "#ecf1f3",        // --secondary (the quiet surface)
  rule: "#dbe4e6",        // a hairline between detail rows: --border mixed into the band
  primary: "#005f47",     // --primary
  primaryText: "#ffffff", // on the primary button (--primary-foreground #f8fafc, rounded to white)
  tint: "#e2f8e8",        // --accent (#bff0cc) mixed into the card: the next-step callout
} as const;
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// ── escaping and links ───────────────────────────────────────────────────────────────────────────

/** & < > " ' — every value interpolated into the HTML goes through this. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escaped, with line breaks kept. */
function escText(value: unknown): string {
  return escapeHtml(value).replace(/\r?\n/g, "<br>");
}

/** The normalized href of an http(s) URL, or null — the ONLY door to an href in this module. A
 *  javascript:, data:, mailto:, protocol-relative or relative value is never a link. */
export function safeHttpUrl(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

// ── From and footer ──────────────────────────────────────────────────────────────────────────────

export const DEFAULT_FROM_NAME = `${BRAND} Filings`;

/** "Name <a@b.co>" → { name, address }; a bare value → { name: "", address: value }. */
export function parseMailbox(raw: unknown): { name: string; address: string } {
  const s = String(raw ?? "").trim();
  const m = /^(.*?)\s*<\s*([^<>\s]+)\s*>$/.exec(s);
  if (m) return { name: m[1].trim().replace(/^"(.*)"$/, "$1").trim(), address: m[2].trim() };
  return { name: "", address: s };
}

/** A display name with no control characters (a header break) and a sane length. */
function cleanDisplayName(raw: unknown): string {
  return String(raw ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

/**
 * The From header nodemailer is given. SMTP_FROM_NAME wins, then a name already written into an
 * older "Name <address>" SMTP_FROM, then DEFAULT_FROM_NAME; the address is always SMTP_FROM's bare
 * address. A value we cannot read as an address is passed through untouched, exactly as before
 * this existed; unset stays unset.
 */
export function mailFrom(rawFrom: string | undefined, rawName: string | undefined): { name: string; address: string } | string | undefined {
  const raw = String(rawFrom ?? "").trim();
  if (!raw) return rawFrom;
  const { name: embedded, address } = parseMailbox(raw);
  if (!looksLikeEmail(address)) return rawFrom;
  return { name: cleanDisplayName(rawName) || cleanDisplayName(embedded) || DEFAULT_FROM_NAME, address };
}

/** SMTP_FROM's bare address, or "" when it does not read as one. */
export function senderAddress(rawFrom: string | undefined): string {
  const { address } = parseMailbox(rawFrom);
  return looksLikeEmail(address) ? address : "";
}

/** The footer's address: FILING_CONTACT_EMAIL, else SMTP_FROM's address, else "". */
export function footerContact(env: NodeJS.ProcessEnv = process.env): string {
  return filingContactEmailSetting(env) || senderAddress(env.SMTP_FROM);
}

// ── content helpers ──────────────────────────────────────────────────────────────────────────────

function list(value: string | string[] | undefined): string[] {
  return (Array.isArray(value) ? value : value === undefined ? [] : [value]).map((s) => String(s ?? "")).filter((s) => s.trim() !== "");
}

function itemOf(item: string | EmailItem): EmailItem {
  return typeof item === "string" ? { text: item } : item;
}

/** Apply `fn` to EVERY string a content carries (URLs included) — how a builder scrubs secrets so
 *  both parts render from the same scrubbed fields. */
export function mapEmailText(content: EmailContent, fn: (s: string) => string): EmailContent {
  const f = (s: string | undefined): string | undefined => (s === undefined ? undefined : fn(String(s)));
  const fl = (v: string | string[] | undefined): string | string[] | undefined =>
    v === undefined ? undefined : Array.isArray(v) ? v.map((s) => fn(String(s))) : fn(String(v));
  return {
    ...content,
    preheader: fn(content.preheader),
    eyebrow: f(content.eyebrow),
    headline: fn(content.headline),
    greeting: f(content.greeting),
    intro: fl(content.intro),
    rows: content.rows?.map(([label, value]) => [fn(label), fn(value)] as [string, string]),
    sections: content.sections?.map((s) => ({
      ...s,
      heading: f(s.heading),
      paragraphs: s.paragraphs?.map((p) => fn(p)),
      items: s.items?.map((it) => {
        const i = itemOf(it);
        return { text: fn(i.text), url: f(i.url), linkLabel: f(i.linkLabel) };
      }),
    })),
    nextStep: f(content.nextStep),
    action: content.action ? { label: fn(content.action.label), url: fn(content.action.url), textLabel: f(content.action.textLabel) } : undefined,
    note: fl(content.note),
    signoff: content.signoff?.map((s) => fn(s)),
  };
}

// ── the plain-text twin ──────────────────────────────────────────────────────────────────────────

function sectionHeadingText(heading: string): string {
  const h = heading.trim();
  return /[:?!]$/.test(h) ? h : `${h}:`;
}

export function renderEmailText(content: EmailContent): string {
  const blocks: string[][] = [];
  const push = (lines: string[]): void => { if (lines.length) blocks.push(lines); };
  push(list(content.headline));
  push(list(content.greeting));
  for (const p of list(content.intro)) push([p]);
  if (content.rows?.length) push(content.rows.map(([label, value]) => `${label}: ${value}`));
  for (const s of content.sections ?? []) {
    const lines: string[] = [];
    if (s.heading?.trim()) lines.push(sectionHeadingText(s.heading));
    lines.push(...list(s.paragraphs));
    (s.items ?? []).map(itemOf).forEach((it, i) => {
      lines.push(`${s.ordered ? `${i + 1}.` : "-"} ${it.text}`);
      if (it.url) lines.push(`  ${it.url}`);
    });
    push(lines);
  }
  push(list(content.nextStep));
  if (content.action) push([`${(content.action.textLabel || content.action.label).trim()}: ${content.action.url}`]);
  for (const p of list(content.note)) push([p]);
  push(list(content.signoff));
  return blocks.map((b) => b.join("\n")).join("\n\n");
}

// ── the HTML ─────────────────────────────────────────────────────────────────────────────────────

/** A text cell's style: font, size, line height, and BOTH colours (see DARK MODE above). */
function textStyle(opts: { size: number; line: number; color: string; bg: string; weight?: number; extra?: string }): string {
  return `font-family:${FONT};font-size:${opts.size}px;line-height:${opts.line}px;color:${opts.color};background-color:${opts.bg};`
    + `${opts.weight ? `font-weight:${opts.weight};` : ""}${opts.extra ?? ""}`;
}

/** One full-width row of the card. */
function cardRow(inner: string, padding: string): string {
  return `<tr><td bgcolor="${C.card}" style="padding:${padding};background-color:${C.card};">${inner}</td></tr>`;
}

function paragraph(textHtml: string, opts: { size?: number; color?: string; margin?: string; weight?: number; extra?: string } = {}): string {
  const size = opts.size ?? 15;
  return `<p style="margin:${opts.margin ?? "0 0 14px 0"};${textStyle({ size, line: Math.round(size * 1.6), color: opts.color ?? C.text, bg: C.card, weight: opts.weight, extra: opts.extra })}">${textHtml}</p>`;
}

function link(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener" style="color:${C.primary};text-decoration:underline;word-break:break-all;">${escText(label)}</a>`;
}

function wordmark(): string {
  const name = escapeHtml(BRAND.toUpperCase());
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>`
    + `<td bgcolor="${C.card}" style="${textStyle({ size: 18, line: 18, color: C.text, bg: C.card, weight: 800, extra: "letter-spacing:1.5px;" })}">${name}</td>`
    + `</tr><tr>`
    + `<td bgcolor="${C.card}" style="padding-top:4px;${textStyle({ size: 9, line: 9, color: C.muted, bg: C.card, weight: 700, extra: "letter-spacing:2.4px;" })}">AUTOMATION</td>`
    + `</tr></table>`;
}

function rowsTable(rows: Array<[string, string]>): string {
  const body = rows.map(([label, value], i) => {
    const rule = i === 0 ? "" : `border-top:1px solid ${C.rule};`;
    return `<tr>`
      + `<td width="32%" valign="top" bgcolor="${C.band}" style="padding:10px 12px 10px 14px;${rule}${textStyle({ size: 13, line: 20, color: C.muted, bg: C.band, weight: 600 })}">${escText(label)}</td>`
      + `<td valign="top" bgcolor="${C.band}" style="padding:10px 14px 10px 0;${rule}${textStyle({ size: 14, line: 20, color: C.text, bg: C.band })}">${escText(value)}</td>`
      + `</tr>`;
  }).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.band}" style="background-color:${C.band};border-radius:6px;border-collapse:separate;">${body}</table>`;
}

function itemsTable(items: EmailItem[], ordered: boolean): string {
  const body = items.map((it, i) => {
    const href = it.url ? safeHttpUrl(it.url) : null;
    const under = it.url
      ? `<br>${href
        ? `<span style="font-size:13px;">${link(href, it.linkLabel || it.url)}</span>`
        : `<span style="font-size:13px;color:${C.muted};">${escText(it.url)}</span>`}`
      : "";
    return `<tr>`
      + `<td width="${ordered ? 30 : 22}" valign="top" bgcolor="${C.card}" style="padding:0 0 8px 0;${textStyle({ size: 15, line: 24, color: C.primary, bg: C.card, weight: 700 })}">${ordered ? `${i + 1}.` : "&#8226;"}</td>`
      + `<td valign="top" bgcolor="${C.card}" style="padding:0 0 8px 0;${textStyle({ size: 15, line: 24, color: C.text, bg: C.card })}">${escText(it.text)}${under}</td>`
      + `</tr>`;
  }).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 6px 0;">${body}</table>`;
}

function sectionHtml(s: EmailSection): string {
  const parts: string[] = [];
  if (s.heading?.trim()) {
    parts.push(paragraph(escText(s.heading.trim().replace(/:$/, "")), { size: 14, weight: 700, margin: "4px 0 8px 0" }));
  }
  for (const p of list(s.paragraphs)) parts.push(paragraph(escText(p)));
  const items = (s.items ?? []).map(itemOf).filter((it) => it.text.trim() !== "");
  if (items.length) parts.push(itemsTable(items, Boolean(s.ordered)));
  return parts.join("");
}

function nextStepHtml(textValue: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.tint}" style="background-color:${C.tint};border-left:4px solid ${C.primary};border-radius:4px;">`
    + `<tr><td bgcolor="${C.tint}" style="padding:12px 16px 4px 16px;${textStyle({ size: 11, line: 14, color: C.primary, bg: C.tint, weight: 700, extra: "letter-spacing:1.6px;text-transform:uppercase;" })}">Next step</td></tr>`
    + `<tr><td bgcolor="${C.tint}" style="padding:0 16px 12px 16px;${textStyle({ size: 15, line: 24, color: C.text, bg: C.tint })}">${escText(textValue)}</td></tr>`
    + `</table>`;
}

/** The bulletproof button (td background + mso-padding-alt for Outlook, padded link elsewhere),
 *  then the plain URL under it. A URL that is not http(s) is never a link: label and value as text. */
function actionHtml(action: EmailAction): string {
  const href = safeHttpUrl(action.url);
  if (!href) {
    return paragraph(`${escText(action.textLabel || action.label)}: <span style="color:${C.muted};">${escText(action.url)}</span>`);
  }
  const button = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 12px 0;"><tr>`
    + `<td align="center" bgcolor="${C.primary}" style="border-radius:6px;background-color:${C.primary};mso-padding-alt:12px 24px;">`
    + `<a href="${escapeHtml(href)}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 24px;border-radius:6px;`
    + `${textStyle({ size: 15, line: 20, color: C.primaryText, bg: C.primary, weight: 600, extra: "text-decoration:none;" })}">${escText(action.label)}</a>`
    + `</td></tr></table>`;
  const plain = paragraph(`Or open this link:<br>${link(href, action.url.trim())}`, { size: 12, color: C.muted, margin: "0 0 14px 0" });
  return button + plain;
}

function footerHtml(audience: EmailAudience, contact: string): string {
  const who = `${escapeHtml(BRAND)} Automation${contact ? ` &middot; ${escapeHtml(contact)}` : ""}`;
  const small = audience === "client"
    ? `${escapeHtml(BRAND)} prepares, files and tracks your permit and interconnection applications.`
    : `An automated alert for the ${escapeHtml(BRAND)} team.`;
  return `<tr><td bgcolor="${C.page}" style="padding:16px 32px 0 32px;${textStyle({ size: 12, line: 18, color: C.muted, bg: C.page, weight: 600 })}">${who}</td></tr>`
    + `<tr><td bgcolor="${C.page}" style="padding:2px 32px 24px 32px;${textStyle({ size: 12, line: 18, color: C.muted, bg: C.page })}">${small}</td></tr>`;
}

/** The page around a card body: doctype, preheader, the 600px column, header, footer. */
function shell(opts: { title: string; preheader: string; audience: EmailAudience; contact: string; bodyRows: string }): string {
  const filler = "&#847;&zwnj;&nbsp;".repeat(40);
  return `<!DOCTYPE html>\n`
    + `<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">\n`
    + `<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n`
    + `<meta http-equiv="X-UA-Compatible" content="IE=edge">\n<meta name="x-apple-disable-message-reformatting">\n`
    + `<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">\n`
    + `<meta name="color-scheme" content="light">\n<meta name="supported-color-schemes" content="light">\n`
    + `<title>${escapeHtml(opts.title)}</title>\n`
    + `<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->\n`
    + `</head>\n`
    + `<body bgcolor="${C.page}" style="margin:0;padding:0;width:100%;background-color:${C.page};color:${C.text};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">\n`
    + `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:${C.page};background-color:${C.page};">${escapeHtml(opts.preheader)}${filler}</div>\n`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background-color:${C.page};">\n`
    + `<tr><td align="center" bgcolor="${C.page}" style="padding:24px 12px;background-color:${C.page};">\n`
    + `<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->\n`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">\n`
    + `<tr><td bgcolor="${C.card}" style="background-color:${C.card};border:1px solid ${C.border};border-top:4px solid ${C.primary};border-radius:8px;">\n`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" style="background-color:${C.card};border-radius:8px;">\n`
    + cardRow(wordmark(), "24px 32px 20px 32px")
    + `<tr><td bgcolor="${C.card}" style="padding:0 32px;background-color:${C.card};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="1" bgcolor="${C.rule}" style="height:1px;line-height:1px;font-size:1px;background-color:${C.rule};">&nbsp;</td></tr></table></td></tr>\n`
    + opts.bodyRows
    + `</table>\n</td></tr>\n`
    + footerHtml(opts.audience, opts.contact)
    + `\n</table>\n<!--[if mso]></td></tr></table><![endif]-->\n</td></tr>\n</table>\n</body>\n</html>\n`;
}

export function renderEmailHtml(content: EmailContent, opts: RenderOptions = {}): string {
  const contact = opts.contact ?? footerContact();
  const inner: string[] = [];
  if (content.eyebrow?.trim()) {
    inner.push(paragraph(escText(content.eyebrow), { size: 11, color: C.primary, weight: 700, margin: "0 0 10px 0", extra: "letter-spacing:1.6px;text-transform:uppercase;" }));
  }
  inner.push(`<h1 style="margin:0 0 18px 0;${textStyle({ size: 24, line: 31, color: C.text, bg: C.card, weight: 600, extra: "letter-spacing:-0.3px;" })}">${escText(content.headline)}</h1>`);
  for (const g of list(content.greeting)) inner.push(paragraph(escText(g)));
  for (const p of list(content.intro)) inner.push(paragraph(escText(p)));
  if (content.rows?.length) inner.push(`<div style="margin:4px 0 18px 0;">${rowsTable(content.rows)}</div>`);
  for (const s of content.sections ?? []) inner.push(sectionHtml(s));
  if (content.nextStep?.trim()) inner.push(`<div style="margin:6px 0 18px 0;">${nextStepHtml(content.nextStep)}</div>`);
  if (content.action) inner.push(actionHtml(content.action));
  for (const n of list(content.note)) inner.push(paragraph(escText(n), { size: 14, color: C.muted }));
  const signoff = list(content.signoff);
  if (signoff.length) inner.push(paragraph(signoff.map(escText).join("<br>"), { margin: "8px 0 0 0" }));
  return shell({
    title: content.headline,
    preheader: content.preheader,
    audience: content.audience,
    contact,
    bodyRows: cardRow(inner.join("\n"), "24px 32px 28px 32px"),
  });
}

/** The layout: both parts from one content. */
export function renderEmail(content: EmailContent, opts: RenderOptions = {}): RenderedEmail {
  return { html: renderEmailHtml(content, opts), text: renderEmailText(content) };
}

// ── plain text, wrapped (a caller that has only text) ────────────────────────────────────────────

const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/gi;

/** One line of plain text as HTML: escaped, leading spaces kept, http(s) URLs as links. */
function plainLineHtml(line: string): string {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(URL_IN_TEXT)) {
    const start = m.index ?? 0;
    let url = m[0];
    const trail = /[.,;:!?)\]]+$/.exec(url)?.[0] ?? "";
    if (trail) url = url.slice(0, -trail.length);
    const href = safeHttpUrl(url);
    out += escapeHtml(line.slice(last, start)) + (href ? link(href, url) : escapeHtml(url));
    last = start + url.length;
  }
  out += escapeHtml(line.slice(last));
  return out.replace(/^( +)/, (sp) => "&nbsp;".repeat(sp.length));
}

/**
 * The layout around a plain-text body — every email that arrives at sendEmail with text only (a
 * re-sent stored message, the watchdog, the test send) still gets the wordmark, the column and the
 * footer. The text is kept as written: its line breaks and blank lines, escaped, with its http(s)
 * URLs made links.
 */
export function wrapPlainText(text: string, opts: { subject?: string; audience?: EmailAudience; contact?: string } = {}): string {
  const raw = String(text ?? "").replace(/\r\n/g, "\n");
  const paragraphs = raw.split(/\n{2,}/).map((p) => p.replace(/^\n+|\n+$/g, "")).filter((p) => p.trim() !== "");
  const bodyHtml = paragraphs.map((p) => paragraph(p.split("\n").map(plainLineHtml).join("<br>"))).join("\n");
  const firstLine = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return shell({
    title: String(opts.subject ?? "").trim() || firstLine,
    preheader: firstLine.slice(0, 140),
    audience: opts.audience ?? "client",
    contact: opts.contact ?? footerContact(),
    bodyRows: cardRow(bodyHtml || paragraph(""), "24px 32px 28px 32px"),
  });
}
