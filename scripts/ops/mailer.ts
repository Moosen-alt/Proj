// OPS ALERT DELIVERY — email through the product's OWN SMTP settings, plus an optional webhook.
//
// Email uses exactly the six variables backend/src/clientNotifier.ts reads (SMTP_HOST, SMTP_PORT,
// SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_SECURE) with the same defaults, so configuring client email
// configures alerts too and there is one set of credentials to rotate. It is re-implemented here
// rather than imported because clientNotifier pulls in the database layer, and a watchdog must
// keep working when the database is exactly what broke. backend/test/opsWatchdog.test.ts pins the
// variable names against clientNotifier.ts so the two cannot drift apart.
//
// The webhook is for phone push / SMS bridges: WATCHDOG_WEBHOOK_URL receives a POST per alert
// batch. WATCHDOG_WEBHOOK_FORMAT=json (default) sends {subject, text}; =text sends the plain text
// with the subject as a "Title" header, which is what ntfy.sh expects (free phone push:
// https://ntfy.sh/<your-private-topic>).

export const SMTP_ENV_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM", "SMTP_SECURE"] as const;

export interface Delivery {
  channel: "email" | "webhook";
  ok: boolean;
  /** Error CODE or HTTP status only — never a server's free text. */
  detail: string;
}

export function smtpConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_FROM);
}

export function alertRecipients(env: NodeJS.ProcessEnv = process.env): string[] {
  return String(env.WATCHDOG_ALERT_TO || "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
}

/** Channels that are configured enough to try. */
export function configuredChannels(env: NodeJS.ProcessEnv = process.env): ("email" | "webhook")[] {
  const out: ("email" | "webhook")[] = [];
  if (smtpConfigured(env) && alertRecipients(env).length) out.push("email");
  if (env.WATCHDOG_WEBHOOK_URL) out.push("webhook");
  return out;
}

/** Same transport construction as clientNotifier.ts sendEmail(), with timeouts so a dead server
 *  answers in seconds instead of hanging the watchdog or the test send. */
async function smtpTransport(env: NodeJS.ProcessEnv) {
  const { default: nodemailer } = await import("nodemailer");
  const port = Number(env.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: env.SMTP_SECURE === "true" || port === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS || "" } : undefined,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 30_000,
  });
}

export async function sendAlertEmail(subject: string, text: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const transporter = await smtpTransport(env);
  await transporter.sendMail({ from: env.SMTP_FROM, to: alertRecipients(env).join(", "), subject, text });
}

export interface TestSendResult {
  ok: boolean;
  /** The SMTP server's own answer line ("250 2.0.0 OK ..."), or its refusal ("535 5.7.8 ..."). */
  response: string;
  /** Error code when the send failed (ECONNREFUSED, EAUTH, EENVELOPE, ...). */
  code: string;
  accepted: string[];
  rejected: string[];
}

/**
 * ONE message to ONE named address, through the same SMTP settings client updates use, reporting
 * what the server said (scripts/ops/test-email.ts, #493). The answer is the operator's evidence that
 * mail leaves this box: a 250 means the server took it, which is all a sender can know.
 */
export async function sendTestEmail(to: string, subject: string, text: string, env: NodeJS.ProcessEnv = process.env): Promise<TestSendResult> {
  try {
    const transporter = await smtpTransport(env);
    const info = await transporter.sendMail({ from: env.SMTP_FROM, to, subject, text });
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((a) => (typeof a === "string" ? a : String((a as { address?: string })?.address ?? ""))) : []);
    const rejected = list(info.rejected);
    return { ok: rejected.length === 0, response: String(info.response ?? ""), code: "", accepted: list(info.accepted), rejected };
  } catch (err) {
    const e = err as { code?: string; responseCode?: number; response?: string; message?: string };
    return {
      ok: false,
      response: String(e?.response || e?.message || ""),
      code: String(e?.code || (e?.responseCode ? `SMTP_${e.responseCode}` : "ERROR")),
      accepted: [],
      rejected: [to],
    };
  }
}

export async function postWebhook(subject: string, text: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const asText = String(env.WATCHDOG_WEBHOOK_FORMAT || "json").toLowerCase() === "text";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(String(env.WATCHDOG_WEBHOOK_URL), {
      method: "POST",
      headers: asText ? { "Content-Type": "text/plain; charset=utf-8", Title: subject.replace(/[^\x20-\x7e]/g, "") } : { "Content-Type": "application/json" },
      body: asText ? text : JSON.stringify({ subject, text }),
      signal: ctrl.signal,
    });
    if (res.status >= 300) throw Object.assign(new Error(`HTTP ${res.status}`), { code: `HTTP_${res.status}` });
    return res.status;
  } finally {
    clearTimeout(timer);
  }
}

/** Try every configured channel. The batch counts as delivered if ANY channel accepted it. */
export async function deliver(subject: string, text: string, env: NodeJS.ProcessEnv = process.env): Promise<Delivery[]> {
  const results: Delivery[] = [];
  const code = (err: unknown): string => {
    const e = err as { code?: string; responseCode?: number };
    return String(e?.code || (e?.responseCode ? `SMTP_${e.responseCode}` : "ERROR"));
  };
  for (const channel of configuredChannels(env)) {
    try {
      if (channel === "email") await sendAlertEmail(subject, text, env);
      else await postWebhook(subject, text, env);
      results.push({ channel, ok: true, detail: "sent" });
    } catch (err) {
      results.push({ channel, ok: false, detail: code(err) });
    }
  }
  return results;
}
