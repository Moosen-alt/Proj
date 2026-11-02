// OPS TEST SEND: does client email actually leave this box? (#493)
//
//   npx tsx scripts/ops/test-email.ts --to you@yourcompany.com
//   /opt/keelix/scripts/ops/linux/keelix-ops.sh test-email --to you@yourcompany.com   (Linux server)
//
// Sends ONE fixed message to the ONE address named with --to, through the same SMTP_* settings
// client updates use (scripts/ops/mailer.ts reads exactly clientNotifier.ts's variables), and prints
// what the SMTP server answered. Preflight (scripts/ops/preflight.ts) only says the settings are SET;
// this proves they WORK, which is the step that went undone for twelve days on the desk while client
// updates piled up as drafts.
//
// It never mails a client: --to is required and is the only recipient. The message carries no
// project data, only this server's name and PUBLIC_BASE_URL, so the reader can see the links clients
// will get start with the right address. NEVER PRINTS A SECRET: the password is never printed, and
// is scrubbed from the server's answer in case a server echoes it.
//
// EXIT: 0 the server accepted the message, 1 it did not (or SMTP is not set), 2 usage.
import "dotenv/config";
import os from "node:os";
import { sendTestEmail, smtpConfigured } from "./mailer";

const env = process.env;
const args = process.argv.slice(2);
const toIdx = args.indexOf("--to");
const to = toIdx >= 0 ? String(args[toIdx + 1] ?? "").trim() : "";

// One plain address: a list, a display name or a header break would let this mail more than the one
// person named, which is not what a test send is for.
if (!/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(to)) {
  console.error("usage: npx tsx scripts/ops/test-email.ts --to you@yourcompany.com   (one address, your own)");
  process.exit(2);
}

if (!smtpConfigured(env)) {
  console.error("test-email: SMTP is not configured, so client updates are only saved as drafts.");
  console.error("  Add to .env:  SMTP_HOST=<server>  SMTP_FROM=<the address clients see>  (and SMTP_PORT, SMTP_USER, SMTP_PASS)");
  console.error("  Then restart the server and run this again.");
  process.exit(1);
}

const name = String(env.WATCHDOG_NAME || "").trim() || os.hostname();
const base = String(env.PUBLIC_BASE_URL ?? "").trim();
const subject = `Keelix test message from ${name}`;
const text = [
  `This is a test message from the Keelix server "${name}", sent with scripts/ops/test-email.ts.`,
  "If you are reading it, client updates sent from this server can reach an inbox.",
  "",
  base ? `Links in client emails will start with: ${base}` : "PUBLIC_BASE_URL is NOT set: links in client emails would point at localhost and not open.",
  "Check that address opens from your phone, off the office network.",
  "",
  "Also check this message did not land in spam. If it did, the sending domain needs SPF/DKIM for this mail server.",
].join("\n");

const scrub = (s: string): string => {
  let out = s;
  for (const secret of [env.SMTP_PASS]) if (secret && secret.length >= 4) out = out.split(secret).join("[redacted]");
  return out;
};

const r = await sendTestEmail(to, subject, text, env);
const port = Number(env.SMTP_PORT || 587);
console.log(`test-email   ${new Date().toISOString()}`);
console.log(`  server     ${env.SMTP_HOST}:${port}${env.SMTP_SECURE === "true" || port === 465 ? " (TLS)" : ""}${env.SMTP_USER ? ", signed in" : ", no sign-in"}`);
console.log(`  from       ${env.SMTP_FROM}`);
console.log(`  to         ${to}`);
if (r.ok) {
  console.log(`  answer     ${scrub(r.response) || "(no answer line)"}`);
  console.log("\nTEST EMAIL: ACCEPTED by the SMTP server. Now check the inbox (and spam) for it.");
  process.exit(0);
}
console.log(`  answer     ${scrub(r.response) || "(none)"}${r.code ? `   [${r.code}]` : ""}`);
console.log("\nTEST EMAIL: NOT SENT. Client updates will be recorded as \"failed\" until this works.");
process.exit(1);
