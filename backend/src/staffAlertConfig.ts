// ---------------------------------------------------------------------------
// STAFF ALERT CONFIGURATION (#487) — who on the team hears that a job needs them, and when.
//
// A LEAF MODULE (env only; no database, no repository): scripts/ops/preflight.ts reads the same
// answer staffAlerts.ts sends by, so "is it on?" has one source and preflight cannot report a
// state the server does not act on.
//
// VARIABLES
//   STAFF_ALERT_TO              comma/semicolon list of email addresses. Needs the product's own
//                               SMTP settings (SMTP_HOST + SMTP_FROM, the ones client email uses).
//   STAFF_ALERT_WEBHOOK_URL     optional phone push / SMS bridge, one POST per alert. Same shape as
//                               the watchdog's WATCHDOG_WEBHOOK_URL (scripts/ops/mailer.ts):
//   STAFF_ALERT_WEBHOOK_FORMAT  json (default) posts {subject, text}; text posts the plain text with
//                               the subject as a "Title" header — what ntfy.sh expects.
//   STAFF_DIGEST_HOUR           0-23, server local time, for the morning "needs you today" email.
//                               Unset (or "off") means no digest; the alerts stay on either way.
// Unset recipients and unset webhook means OFF: nothing is sent, and preflight says so.
//
// PREFLIGHT: the rows for these settings are #493's (worker-493, in parallel); describeStaffAlerts()
// below is the one-line answer it can print, so preflight and the server cannot disagree.
//
// ORG SCOPING (CLAUDE.md rule 6 — tenant data never crosses orgs). A bare entry belongs to the
// default org (org-default: Keelix's own team). An entry written `<org-id>=<address-or-url>`
// belongs to that org alone. An org with no entries of its own hears NOTHING: the default org's
// inbox is never a fallback for another org's jobs, because the default org's staff are not that
// org's staff. A prefix is recognised only when the text before the first "=" has no "@", ":",
// "/" or "." — so an email address or a URL with a query string is never mistaken for one.
// ---------------------------------------------------------------------------

export const DEFAULT_STAFF_ORG_ID = "org-default"; // = db.ts DEFAULT_ORG_ID; restated so this stays a leaf

export interface StaffAlertChannels {
  emails: string[];
  webhooks: string[];
  webhookFormat: "json" | "text";
}

const ORG_PREFIX = /^([A-Za-z0-9_-]+)=(.+)$/;

/** Split a STAFF_ALERT_* list into (org, value) pairs. Exported for tests. */
export function parseOrgScopedList(raw: string | undefined, separators: RegExp): Array<{ orgId: string; value: string }> {
  return String(raw ?? "")
    .split(separators)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const m = ORG_PREFIX.exec(entry);
      return m ? { orgId: m[1], value: m[2].trim() } : { orgId: DEFAULT_STAFF_ORG_ID, value: entry };
    })
    .filter((e) => e.value);
}

export function smtpConfiguredFor(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_FROM);
}

/** What this org's staff alerts can go out on. Email needs SMTP as well as addresses: an address
 *  with no mail server is not a channel, it is a draft nobody sends. */
export function staffAlertChannels(orgId: string, env: NodeJS.ProcessEnv = process.env): StaffAlertChannels {
  const org = orgId || DEFAULT_STAFF_ORG_ID;
  const emails = smtpConfiguredFor(env)
    ? parseOrgScopedList(env.STAFF_ALERT_TO, /[,;]/).filter((e) => e.orgId === org).map((e) => e.value)
    : [];
  // URLs can hold ";" in a query string but not a bare comma in practice; commas separate.
  const webhooks = parseOrgScopedList(env.STAFF_ALERT_WEBHOOK_URL, /,/)
    .filter((e) => e.orgId === org && /^https?:\/\//i.test(e.value))
    .map((e) => e.value);
  const webhookFormat = String(env.STAFF_ALERT_WEBHOOK_FORMAT || "json").toLowerCase() === "text" ? "text" : "json";
  return { emails, webhooks, webhookFormat };
}

export function staffAlertsOn(orgId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const c = staffAlertChannels(orgId, env);
  return c.emails.length > 0 || c.webhooks.length > 0;
}

/** Every org named in the configuration (the default org whenever a bare entry exists). */
export function configuredStaffOrgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const orgs = new Set<string>();
  for (const e of parseOrgScopedList(env.STAFF_ALERT_TO, /[,;]/)) orgs.add(e.orgId);
  for (const e of parseOrgScopedList(env.STAFF_ALERT_WEBHOOK_URL, /,/)) orgs.add(e.orgId);
  return [...orgs].filter((o) => staffAlertsOn(o, env));
}

/** The digest hour (0-23), or null when the digest is off. Unset means off. Anything unreadable is
 *  null (off) rather than a guess: an email at a surprise hour is worse than a preflight WARN. */
export function staffDigestHour(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = String(env.STAFF_DIGEST_HOUR ?? "").trim();
  if (!raw) return null;
  if (/^(off|false|no|none|-1)$/i.test(raw)) return null;
  if (!/^\d{1,2}$/.test(raw)) return null;
  const h = Number(raw);
  return h >= 0 && h <= 23 ? h : null;
}

/** One line for preflight and the boot log. Never prints an address or a webhook URL (an ntfy
 *  topic IS the password to the push channel). */
export function describeStaffAlerts(env: NodeJS.ProcessEnv = process.env): { on: boolean; detail: string; digest: string } {
  const c = staffAlertChannels(DEFAULT_STAFF_ORG_ID, env);
  const listed = parseOrgScopedList(env.STAFF_ALERT_TO, /[,;]/).filter((e) => e.orgId === DEFAULT_STAFF_ORG_ID).length;
  const parts = [
    c.emails.length ? `email to ${c.emails.length} address(es)` : listed ? "STAFF_ALERT_TO set but SMTP_HOST/SMTP_FROM are not" : "no STAFF_ALERT_TO",
    c.webhooks.length ? `webhook set (${c.webhookFormat})` : "no STAFF_ALERT_WEBHOOK_URL",
  ];
  const others = configuredStaffOrgs(env).filter((o) => o !== DEFAULT_STAFF_ORG_ID).length;
  if (others) parts.push(`${others} other org(s) configured`);
  const on = c.emails.length > 0 || c.webhooks.length > 0;
  const hour = staffDigestHour(env);
  const digest = !on ? "off (no staff alert channel)"
    : hour === null ? (String(env.STAFF_DIGEST_HOUR ?? "").trim() ? `off (STAFF_DIGEST_HOUR=${String(env.STAFF_DIGEST_HOUR)} is not an hour 0-23)` : "off (STAFF_DIGEST_HOUR unset)")
    : `every day at ${String(hour).padStart(2, "0")}:00 server time`;
  return { on, detail: on ? parts.join("; ") : `off: nobody is told when a run stops, a correction lands or a status changes (${parts.join("; ")})`, digest };
}
