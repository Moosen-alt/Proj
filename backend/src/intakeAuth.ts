// ---------------------------------------------------------------------------
// EMAIL-IN INTAKE: IS THE FROM ADDRESS AUTHENTICATED? (#510, follow-up to #489 / #508)
//
// Intake trusts a message because its From address is one of the client's own. A From line is
// free text, so the receiving mail server's Authentication-Results header (RFC 8601) is the only
// evidence that the From domain really sent it. Two modes:
//
//   default (EMAIL_INTAKE_REQUIRE_AUTH unset) — a STATED fail (dmarc=fail) refuses the message; no
//       header at all is accepted on the sender match alone. Plenty of honest mail passes through
//       servers that stamp nothing, and a hard requirement there would lose real jobs.
//   required (EMAIL_INTAKE_REQUIRE_AUTH=1) — the message is accepted only when the TOPMOST
//       Authentication-Results header carries dmarc=pass for the From domain, or spf=pass and
//       dkim=pass, each aligned with the From domain. Anything else (no header, none, neutral,
//       temperror, a pass for another domain) refuses.
//
// WHY THE TOPMOST HEADER ONLY. The last server to receive the message (the mailbox provider) adds
// its header on top. Anyone can write an Authentication-Results line into the mail they send; it
// lands BELOW the provider's. So a pass is believed only from the top header, and the switch is
// only meaningful on a mailbox whose provider stamps one (Gmail, Microsoft 365 and most hosted
// IMAP providers do). A stated fail is believed from any header: a fail can only make intake more
// careful, never less.
//
// A leaf module (no db, no mailparser) so the preflight script and the tests can import it.
// ---------------------------------------------------------------------------

/** EMAIL_INTAKE_REQUIRE_AUTH is on (1/true/on/yes). Read here by emailIntake.ts and preflight. */
export function intakeRequiresAuth(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|on|yes)$/i.test(String(env.EMAIL_INTAKE_REQUIRE_AUTH ?? "").trim());
}

export interface AuthResult {
  method: string;
  result: string;
  /** ptype.property → value, lower-cased (header.d, header.from, smtp.mailfrom, header.i…). */
  props: Record<string, string>;
}

/** One Authentication-Results value: "authserv-id [version]; method=result prop=value …; …".
 *  Comments in parentheses are dropped; a ";" inside a quoted string does not split. */
export function parseAuthenticationResults(value: string): { authservId: string; results: AuthResult[] } {
  const segments: string[] = [];
  let cur = "";
  let depth = 0;
  let quoted = false;
  for (const ch of String(value || "")) {
    if (quoted) {
      if (ch === "\"") quoted = false;
      else if (depth === 0) cur += ch;
      continue;
    }
    if (ch === "(") { depth++; continue; }
    if (ch === ")") { if (depth > 0) depth--; continue; }
    if (depth > 0) continue;
    if (ch === "\"") { quoted = true; continue; }
    if (ch === ";") { segments.push(cur); cur = ""; continue; }
    cur += ch;
  }
  segments.push(cur);
  // Microsoft 365 writes no authserv-id: its header opens straight with "spf=pass …". A first
  // segment that is already a method=result is a result, not the id.
  const first = (segments[0] ?? "").trim().split(/\s+/)[0] ?? "";
  let authservId = "";
  if (!first.includes("=")) { segments.shift(); authservId = first.toLowerCase(); }
  const results: AuthResult[] = [];
  for (const seg of segments) {
    const tokens = seg.replace(/\s*=\s*/g, "=").trim().split(/\s+/).filter(Boolean);
    const head = /^([a-z0-9_-]+)\s*=\s*([a-z]+)$/i.exec(tokens.shift() ?? "");
    if (!head) continue; // "none" (no checks run) or something unreadable: no result
    const props: Record<string, string> = {};
    for (const t of tokens) {
      const m = /^([a-z0-9_-]+\.[a-z0-9_-]+)=(.*)$/i.exec(t);
      if (m) props[m[1].toLowerCase()] = m[2].trim().toLowerCase();
    }
    results.push({ method: head[1].toLowerCase(), result: head[2].toLowerCase(), props });
  }
  return { authservId, results };
}

/** The domain part of an address or a bare domain ("bounce@mail.acme.test" → "mail.acme.test"). */
function domainOf(value: string | undefined): string {
  const v = String(value || "").trim().toLowerCase().replace(/^<|>$/g, "");
  return v.slice(v.lastIndexOf("@") + 1).replace(/\.$/, "");
}

/** DMARC's relaxed alignment without a public-suffix list: the same domain, or one a subdomain of
 *  the other, where the shorter one has at least two labels. A pass for a bare suffix ("test",
 *  "com") can never align, and neither can a sibling ("evil-acme.test" vs "acme.test"). */
export function domainsAlign(a: string, b: string): boolean {
  const x = domainOf(a);
  const y = domainOf(b);
  if (!x || !y) return false;
  if (x === y) return x.includes(".");
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return short.includes(".") && long.endsWith(`.${short}`);
}

/** Any header states dmarc=fail. The same text test intake has always made (#508), so the default
 *  mode refuses exactly what it refused before. */
export function dmarcFailStated(headers: string[]): boolean {
  return headers.some((h) => /\bdmarc=fail\b/i.test(h));
}

/** The topmost header shows the From domain authenticated: dmarc=pass (for this From domain when
 *  the header names one), or an aligned spf=pass AND an aligned dkim=pass. `headers` is in message
 *  order, top first, as mailparser gives repeated headers. */
export function senderAuthenticated(headers: string[], fromAddress: string): boolean {
  const fromDomain = domainOf(fromAddress);
  if (!fromDomain || !String(fromAddress).includes("@") || !headers.length) return false;
  const { results } = parseAuthenticationResults(headers[0]);
  const passes = (method: string) => results.filter((r) => r.method === method && r.result === "pass");
  if (passes("dmarc").some((r) => !r.props["header.from"] || domainOf(r.props["header.from"]) === fromDomain)) return true;
  const spf = passes("spf").some((r) => domainsAlign(r.props["smtp.mailfrom"] ?? "", fromDomain));
  const dkim = passes("dkim").some((r) => domainsAlign(r.props["header.d"] ?? r.props["header.i"] ?? "", fromDomain));
  return spf && dkim;
}

/** The intake verdict on a message's sender authentication: null = go on; otherwise why it is
 *  refused (the row is unsorted as sender_not_authenticated either way). */
export function intakeAuthRefusal(headers: string[], fromAddress: string, required = intakeRequiresAuth()): "dmarc_fail" | "not_authenticated" | null {
  if (dmarcFailStated(headers)) return "dmarc_fail";
  if (required && !senderAuthenticated(headers, fromAddress)) return "not_authenticated";
  return null;
}
