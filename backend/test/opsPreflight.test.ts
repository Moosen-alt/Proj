// OPS PREFLIGHT: THE RUNBOOK'S "HOW DO I KNOW IT WORKED" HAS ONE COMMAND, AND IT TELLS THE TRUTH.
//
// scripts/ops/preflight.ts reads .env + the users table (read-only) + the backup folders and marks
// each day-one setting PASS / WARN / FAIL. docs/OPERATIONS.md ends every step with it.
//
//   MUST-PASS    today's production shape (auth off, final submit armed with no login, localhost
//                PUBLIC_BASE_URL, no off-box copy, no watchdog, no admin password) FAILs on exactly
//                those lines; the fully configured shape has no FAIL and exits 0.
//   MUST-EXCLUDE no secret value (AUTH_SECRET, SESSION_ENCRYPTION_KEY, ADMIN_PASSWORD, SMTP_PASS)
//                ever appears in its output; AUTH_SECRET equal to the session key is not a PASS.
//
// The admin account is created through the production path for turning auth on (seedAdminUser
// with AUTH_ENABLED/ADMIN_EMAIL/ADMIN_PASSWORD), not raw SQL.
// Run: npx tsx backend/test/opsPreflight.test.ts
import { REPO, ISOLATED_CWD } from "./_isolate";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SECRETS = {
  session: "sess-key-0123456789-abcdefghij-KLMNOPQRST-uvwxyz",
  auth: "auth-secret-9876543210-zyxwvutsrq-PONMLKJIHG-fedcba",
  adminPw: "admin-pw-Larkspur-4471",
  smtpPw: "smtp-pw-Quintero-9931",
  imapPw: "imap-pw-Halvorsen-2207",
  gmailSecret: "gmail-secret-Mbeki-6018",
  gmailToken: "gmail-refresh-Tanaka-7734",
};
const noPw = path.join(ISOLATED_CWD, "no-admin-pw.sqlite");
const withAdmin = path.join(ISOLATED_CWD, "with-admin.sqlite");
const withNotify = path.join(ISOLATED_CWD, "with-notify.sqlite");
process.env.AUTOPILOT_DB_PATH = path.join(ISOLATED_CWD, "live.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SESSION_ENCRYPTION_KEY = SECRETS.session;
process.env.AUTH_ENABLED = "true";
process.env.ADMIN_EMAIL = "owner@ops.invalid";
process.env.ADMIN_PASSWORD = SECRETS.adminPw;

const { openDatabase } = await import("../src/db");
const { seedAdminUser } = await import("../src/auth");
const { createUser } = await import("../src/users");
const { addCommunication } = await import("../src/crm");
const db = await openDatabase();
createUser(db, { name: "Owner", email: "owner@ops.invalid" });
db.backupTo(noPw); // today's shape: one OPERATOR user, no password
seedAdminUser(db); // the production path: sets the password on the matching existing user - and leaves its role
const pwNotAdmin = path.join(ISOLATED_CWD, "pw-not-admin.sqlite");
db.backupTo(pwNotAdmin); // what following ADMIN_EMAIL=<existing operator> actually produces
db.run("UPDATE users SET role = 'admin' WHERE email = ?", ["owner@ops.invalid"]); // the documented promotion (no role writer exists)
db.backupTo(withAdmin); // the configured shape: an admin, no IMAP source, no communications
// NOTIFICATIONS (#493): one active IMAP source row, an inactive one (not polled), and the
// client-email record in each delivery state (addCommunication, the production writer). The IMAP rows
// are raw SQL because their writer, emailPoller.ts upsertImapSource, cannot run under ESM today
// (`require` is not defined, #498); the columns are the ones it writes.
const imapRow = (id: string, host: string, filePath: string, active: number): void => db.run(
  `INSERT INTO email_tracking_sources (id, source_type, label, file_path, imap_host, imap_user, imap_pass_encrypted, active, created_at, updated_at)
   VALUES (?, 'imap', ?, ?, ?, 'permits@ops.invalid', 'enc', ?, datetime('now'), datetime('now'))`, [id, id, filePath, host, active]);
imapRow("shared-inbox", "imap.ops.invalid", "", 1);
imapRow("switched-off", "imap2.ops.invalid", "imap:switched-off", 0);
for (const deliveryStatus of ["draft", "draft", "failed", "sent"]) {
  addCommunication(db, { direction: "outbound", channel: "email", subject: `update (${deliveryStatus})`, deliveryStatus });
}
addCommunication(db, { direction: "outbound", channel: "note", subject: "a note, not an email", deliveryStatus: "draft" });
addCommunication(db, { direction: "inbound", channel: "email", subject: "an agency email", deliveryStatus: "" });
db.backupTo(withNotify);
db.close();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const backupDir = path.join(ISOLATED_CWD, "pf-backups");
const secondDir = path.join(ISOLATED_CWD, "pf-offbox");
fs.mkdirSync(backupDir, { recursive: true });
fs.mkdirSync(secondDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
fs.writeFileSync(path.join(backupDir, `autopilot-${stamp}.sqlite`), "x");
fs.writeFileSync(path.join(secondDir, `autopilot-${stamp}.sqlite`), "x");
const stateFile = path.join(ISOLATED_CWD, "pf-state.json");
fs.writeFileSync(stateFile, JSON.stringify({ version: 1, lastRunAt: new Date().toISOString(), checks: {}, undelivered: [] }));

const outputs: string[] = [];
function preflight(env: Record<string, string>): { code: number; out: string } {
  // A clean environment for the child: only what the scenario names (plus what node needs).
  const base: Record<string, string> = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", TEMP: process.env.TEMP ?? "", TMP: process.env.TMP ?? "" };
  const r = spawnSync(process.execPath, [path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs"), path.join(REPO, "scripts", "ops", "preflight.ts")], {
    cwd: ISOLATED_CWD, env: { ...base, ...env }, encoding: "utf8", timeout: 120_000,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  outputs.push(out);
  return { code: r.status ?? -1, out };
}
const line = (out: string, name: string): string => out.split(/\r?\n/).find((l) => new RegExp(`^\\s+(PASS|WARN|FAIL)\\s+${name.replace(/[()]/g, "\\$&")}\\s`).test(l)) ?? `<no line for ${name}>`;

console.log("preflight: today's production shape");
const today = preflight({
  AUTOPILOT_DB_PATH: noPw, SESSION_ENCRYPTION_KEY: SECRETS.session, AUTH_ENABLED: "false", PORTAL_ALLOW_FINAL_SUBMIT: "1",
  PUBLIC_BASE_URL: "http://localhost:4173", BACKUP_DIR: backupDir, BACKUP_INTERVAL_HOURS: "24", BACKUP_KEEP: "14",
  SMTP_HOST: "smtp.invalid", SMTP_FROM: "x@ops.invalid", SMTP_PASS: SECRETS.smtpPw,
  WATCHDOG_STATE_FILE: path.join(ISOLATED_CWD, "never-ran.json"),
});
check("exits 1", () => assert.equal(today.code, 1, today.out));
for (const [name, re] of [
  ["AUTH_ENABLED", /FAIL/], ["admin login", /FAIL/], ["PORTAL_ALLOW_FINAL_SUBMIT", /FAIL .*with no login/],
  ["PUBLIC_BASE_URL", /FAIL/], ["BACKUP_SECOND_DIR", /FAIL/], ["watchdog channel", /FAIL .*SMTP set but WATCHDOG_ALERT_TO is empty/],
  ["watchdog running", /FAIL/], ["BACKUP_INTERVAL_HOURS", /WARN .*1-4 h recommended/], ["BACKUP_KEEP", /PASS .*14\.0 days/], ["WATCHDOG_HEARTBEAT_URL", /WARN/],
] as [string, RegExp][]) {
  check(`${name}: ${re.source}`, () => assert.match(line(today.out, name), re));
}
check("SERVER_HOST unset is loopback since #82 (server.ts binds 127.0.0.1), so a PASS even with auth off", () => {
  assert.match(line(today.out, "SERVER_HOST"), /PASS .*unset \(127\.0\.0\.1\): reachable only from this machine/);
});
check("BACKUP_DIR with a fresh snapshot is a PASS even today", () => assert.match(line(today.out, "BACKUP_DIR"), /PASS/));

console.log("preflight: the configured shape");
const good = preflight({
  AUTOPILOT_DB_PATH: withAdmin, SESSION_ENCRYPTION_KEY: SECRETS.session, AUTH_ENABLED: "true", AUTH_SECRET: SECRETS.auth,
  SERVER_HOST: "127.0.0.1", PUBLIC_BASE_URL: "https://autopilot.ops.invalid",
  BACKUP_DIR: backupDir, BACKUP_INTERVAL_HOURS: "2", BACKUP_KEEP: "84", BACKUP_SECOND_DIR: secondDir,
  SMTP_HOST: "smtp.invalid", SMTP_FROM: "x@ops.invalid", SMTP_PASS: SECRETS.smtpPw, WATCHDOG_ALERT_TO: "ops@ops.invalid",
  WATCHDOG_HEARTBEAT_URL: "https://hc-ping.invalid/abc", WATCHDOG_STATE_FILE: stateFile,
  EMAIL_IMAP_HOST: "imap.ops.invalid", EMAIL_IMAP_USER: "permits@ops.invalid", EMAIL_IMAP_PASS: SECRETS.imapPw,
  STAFF_ALERT_TO: "owner@ops.invalid, pm@ops.invalid", STAFF_DIGEST_HOUR: "7",
});
check("no FAIL, exit 0", () => {
  assert.equal(good.code, 0, good.out);
  assert.doesNotMatch(good.out, /^\s+FAIL/m);
});
check("the seeded admin is seen (by email, never by password)", () => assert.match(line(good.out, "admin login"), /PASS .*owner@ops\.invalid/));
check("final submit unset reads PASS", () => assert.match(line(good.out, "PORTAL_ALLOW_FINAL_SUBMIT"), /PASS/));
check("NOTIFICATIONS all PASS on the configured shape (#493)", () => {
  assert.match(line(good.out, "client email (SMTP)"), /PASS .*test-email\.ts --to/);
  assert.match(line(good.out, "tracking inbox"), /PASS .*IMAP inbox \(EMAIL_IMAP_\*\)/);
  assert.match(line(good.out, "unsent client emails"), /PASS .*none/);
  assert.match(line(good.out, "staff alerts"), /PASS .*email to 2 address\(es\); morning digest at hour 7/);
  assert.doesNotMatch(good.out, /MONITOR_INTERVAL_MINUTES/);
});
const armed = preflight({
  AUTOPILOT_DB_PATH: withAdmin, SESSION_ENCRYPTION_KEY: SECRETS.session, AUTH_ENABLED: "true", AUTH_SECRET: SECRETS.session,
  PORTAL_ALLOW_FINAL_SUBMIT: "1", BACKUP_DIR: backupDir,
});
check("MUST-EXCLUDE: AUTH_SECRET equal to the session key is a FAIL, not a PASS", () => assert.match(line(armed.out, "AUTH_SECRET"), /FAIL .*identical/));
check("final submit armed WITH a login is a WARN naming the per-run approval (the operator's ruling), not a FAIL", () => {
  assert.match(line(armed.out, "PORTAL_ALLOW_FINAL_SUBMIT"), /WARN .*per-run approval/);
});
console.log("preflight: SERVER_HOST reports the server's own bind decision (listenHost.ts)");
const hostCase = (extra: Record<string, string>): string =>
  line(preflight({ AUTOPILOT_DB_PATH: withAdmin, BACKUP_DIR: backupDir, ...extra }).out, "SERVER_HOST");
check("explicit loopback with auth off: PASS", () => {
  assert.match(hostCase({ AUTH_ENABLED: "false", SERVER_HOST: "::1" }), /PASS .*::1: reachable only from this machine/);
});
check("auth on + non-loopback: WARN with the firewall note for this platform (#437: no Windows advice on Linux)", () => {
  assert.match(hostCase({ AUTH_ENABLED: "true", SERVER_HOST: "0.0.0.0" }),
    process.platform === "win32" ? /WARN .*0\.0\.0\.0: .*firewall rule off the Public profile/
      : fs.existsSync("/.dockerenv") ? /WARN .*0\.0\.0\.0: .*publish the port on 127\.0\.0\.1 only/
        : /WARN .*0\.0\.0\.0: .*port closed in the host and provider firewalls/);
});
check("auth off + non-loopback, no opt-in: FAIL - the server will refuse to start", () => {
  assert.match(hostCase({ AUTH_ENABLED: "false", SERVER_HOST: "0.0.0.0" }), /FAIL .*server will refuse to start/);
});
check("MUST-EXCLUDE: a look-alike loopback name (127.evil.example) is not a PASS", () => {
  assert.match(hostCase({ AUTH_ENABLED: "false", SERVER_HOST: "127.evil.example" }), /FAIL .*refuse to start/);
});
check("auth off + non-loopback WITH ALLOW_UNAUTHENTICATED_NETWORK=1: still FAIL (it starts, exposed)", () => {
  assert.match(hostCase({ AUTH_ENABLED: "false", SERVER_HOST: "0.0.0.0", ALLOW_UNAUTHENTICATED_NETWORK: "1" }),
    /FAIL .*ALLOW_UNAUTHENTICATED_NETWORK=1: the server starts, and anyone/);
});
console.log("preflight: the admin seed does not promote");
const seedExisting = preflight({ AUTOPILOT_DB_PATH: noPw, AUTH_ENABLED: "true", ADMIN_EMAIL: "Owner@ops.invalid", ADMIN_PASSWORD: SECRETS.adminPw, BACKUP_DIR: backupDir });
check("MUST-EXCLUDE: ADMIN_EMAIL pointing at the existing OPERATOR account is a FAIL (it would get a password, not admin)", () => {
  assert.match(line(seedExisting.out, "admin login"), /FAIL .*role is operator: the next start sets its password but NOT admin/);
});
const seedNew = preflight({ AUTOPILOT_DB_PATH: noPw, AUTH_ENABLED: "true", ADMIN_EMAIL: "admin@ops.invalid", ADMIN_PASSWORD: SECRETS.adminPw, BACKUP_DIR: backupDir });
check("a NEW ADMIN_EMAIL is the right move: WARN (not effective until the restart) naming the new admin", () => {
  assert.match(line(seedNew.out, "admin login"), /WARN .*creates a NEW admin account admin@ops\.invalid/);
});
const operatorOnly = preflight({ AUTOPILOT_DB_PATH: pwNotAdmin, AUTH_ENABLED: "true", BACKUP_DIR: backupDir });
check("MUST-EXCLUDE: a password on an operator account is not reported as 'no password' nor as an admin PASS", () => {
  assert.match(line(operatorOnly.out, "admin login"), /WARN .*owner@ops\.invalid \(operator\) can sign in, but no ADMIN account has a password/);
});

console.log("preflight: NOTIFICATIONS (#493) - each a WARN naming the line to add, never a FAIL");
const notify = (dbFile: string, extra: Record<string, string>): string =>
  preflight({ AUTOPILOT_DB_PATH: dbFile, AUTH_ENABLED: "true", BACKUP_DIR: backupDir, ...extra }).out;
let out = notify(withAdmin, {});
check("no SMTP: WARN, client updates are only drafts, names SMTP_HOST= and SMTP_FROM=", () => {
  assert.match(line(out, "client email (SMTP)"), /WARN .*SMTP_HOST and SMTP_FROM unset: client updates are only saved as drafts.*Add SMTP_HOST=<server> and SMTP_FROM=/);
});
check("no tracking source: WARN, emails are never read, names the EMAIL_IMAP_* and GMAIL_* lines", () => {
  assert.match(line(out, "tracking inbox"), /WARN .*none configured: correction, approval and utility emails are never read.*EMAIL_IMAP_HOST=, EMAIL_IMAP_USER=, EMAIL_IMAP_PASS=.*GMAIL_REFRESH_TOKEN/);
});
check("no new line is a FAIL (the configured shape exits 0 without NOTIFICATIONS PASSing is covered above)", () => {
  assert.doesNotMatch(out.split(/\r?\n/).filter((l) => /client email|tracking inbox|staff alerts|unsent client|SMTP_PASS|MONITOR_INTERVAL/.test(l)).join("\n"), /FAIL/);
});
check("no staff alert recipients: WARN naming STAFF_ALERT_TO= and STAFF_ALERT_WEBHOOK_URL= (#487's names)", () => {
  assert.match(line(out, "staff alerts"), /WARN .*no recipients: nobody on the team is told.*Add STAFF_ALERT_TO=.*STAFF_ALERT_WEBHOOK_URL=/);
});
out = notify(withAdmin, { STAFF_ALERT_TO: "owner@ops.invalid" });
check("MUST-EXCLUDE: STAFF_ALERT_TO with no SMTP cannot email anyone, so it is not a PASS", () => {
  assert.match(line(out, "staff alerts"), /WARN .*STAFF_ALERT_TO is set but SMTP is not/);
});
out = notify(withAdmin, { STAFF_ALERT_WEBHOOK_URL: "https://ntfy.invalid/staff-topic" });
check("a staff webhook alone is a PASS (no SMTP needed); no STAFF_DIGEST_HOUR means no digest, and it says so", () => {
  assert.match(line(out, "staff alerts"), /PASS .*webhook set; no morning digest \(STAFF_DIGEST_HOUR unset\)/);
  assert.ok(!out.includes("staff-topic"), "the webhook URL (a secret topic) is printed");
});
out = notify(withAdmin, { STAFF_ALERT_WEBHOOK_URL: "org-acme=https://ntfy.invalid/acme-topic", STAFF_DIGEST_HOUR: "7" });
check("the verdict is the server's (staffAlertConfig.ts): another org's webhook is not the default org's channel", () => {
  assert.match(line(out, "staff alerts"), /WARN .*no recipients/);
  assert.ok(!out.includes("acme-topic"), "the webhook URL (a secret topic) is printed");
});
out = notify(withAdmin, { STAFF_ALERT_WEBHOOK_URL: "https://ntfy.invalid/staff-topic", STAFF_DIGEST_HOUR: "7am" });
check("an unreadable STAFF_DIGEST_HOUR is no digest, said plainly (the server sends none)", () => {
  assert.match(line(out, "staff alerts"), /PASS .*webhook set; no morning digest \(STAFF_DIGEST_HOUR=7am is not an hour 0-23\)/);
});
out = notify(withAdmin, { SMTP_HOST: "smtp.invalid" });
check("SMTP_HOST without SMTP_FROM names only SMTP_FROM (clientNotifier needs both)", () => {
  assert.match(line(out, "client email (SMTP)"), /WARN .*  SMTP_FROM unset/);
});
out = notify(withAdmin, { SMTP_HOST: "smtp.invalid", SMTP_FROM: "x@ops.invalid", SMTP_USER: "x@ops.invalid" });
check("SMTP_USER with no SMTP_PASS: the sign-in will be refused", () => {
  assert.match(line(out, "client email (SMTP)"), /PASS .*with sign-in/);
  assert.match(line(out, "SMTP_PASS"), /WARN .*SMTP_USER is set but SMTP_PASS is empty/);
});
out = notify(withAdmin, { EMAIL_IMAP_HOST: "imap.ops.invalid", EMAIL_IMAP_USER: "permits@ops.invalid" });
check("MUST-EXCLUDE: an incomplete EMAIL_IMAP_* (the poller ignores it) is not a PASS, and names the missing key", () => {
  assert.match(line(out, "tracking inbox"), /WARN .*EMAIL_IMAP_\* is incomplete \(EMAIL_IMAP_PASS unset\), so it is ignored/);
});
out = notify(withAdmin, { GMAIL_CLIENT_ID: "client-id.ops.invalid", GMAIL_CLIENT_SECRET: SECRETS.gmailSecret, PUBLIC_BASE_URL: "https://keelix.ops.invalid" });
check("MUST-EXCLUDE: Gmail set up but never authorized is not a PASS; on the server it names the redirect to set first", () => {
  assert.match(line(out, "tracking inbox"), /WARN .*Gmail is set up but not authorized.*GMAIL_REDIRECT_URI=https:\/\/keelix\.ops\.invalid\/api\/gmail\/oauth\/callback \(now localhost\) and restart, then open \/api\/gmail\/auth-url/);
});
out = notify(withAdmin, { GMAIL_CLIENT_ID: "client-id.ops.invalid", GMAIL_CLIENT_SECRET: SECRETS.gmailSecret, GMAIL_REFRESH_TOKEN: SECRETS.gmailToken,
  PUBLIC_BASE_URL: "https://keelix.ops.invalid" });
check("Gmail with a refresh token (what the scheduler polls on) is a PASS", () => {
  assert.match(line(out, "tracking inbox"), /PASS .*  Gmail: agency and utility emails are read/);
});
out = notify(withNotify, { SMTP_HOST: "smtp.invalid", SMTP_FROM: "x@ops.invalid" });
check("an IMAP source saved in the database counts (active ones only: 1 of 2)", () => {
  assert.match(line(out, "tracking inbox"), /PASS .*  1 saved IMAP source\(s\)/);
});
check("unsent client emails: counts outbound EMAIL drafts and failures only (2 + 1), with the command that re-sends them", () => {
  assert.match(line(out, "unsent client emails"), /WARN .*  2 draft \(never tried\) \+ 1 failed: list them with scripts\/undelivered\.ts, re-send with --send/);
});
const bare = path.join(ISOLATED_CWD, "bare.sqlite");
{
  const { default: Database } = await import("better-sqlite3");
  const b = new Database(bare);
  b.exec("CREATE TABLE users (email TEXT, role TEXT, password_hash TEXT, active INTEGER)");
  b.close();
}
out = notify(bare, {});
check("MUST-EXCLUDE: a database without those tables reads as 'could not read', never as a clean 0", () => {
  assert.match(line(out, "unsent client emails"), /WARN .*  could not read communications/);
  assert.match(line(out, "tracking inbox"), /WARN .*  could not read the Email tracking sources/);
});
for (const v of ["0", ""]) {
  out = notify(withAdmin, { MONITOR_INTERVAL_MINUTES: v });
  check(`MONITOR_INTERVAL_MINUTES=${JSON.stringify(v)} turns the monitor off (scheduler.ts reads <= 0): WARN`, () => {
    assert.match(line(out, "MONITOR_INTERVAL_MINUTES"), /WARN .*the monitor never runs, so no tracking inbox is read/);
  });
}

const shortHistory = preflight({ AUTOPILOT_DB_PATH: withAdmin, BACKUP_DIR: backupDir, BACKUP_INTERVAL_HOURS: "2", BACKUP_KEEP: "14" });
check("a 2 h interval that keeps only 14 snapshots (28 h of history) warns with the number to set", () => {
  assert.match(line(shortHistory.out, "BACKUP_INTERVAL_HOURS"), /PASS/);
  assert.match(line(shortHistory.out, "BACKUP_KEEP"), /WARN .*1\.2 days .*BACKUP_KEEP=84/);
});
check("MUST-EXCLUDE: no secret value appears in any output", () => {
  const all = outputs.join("\n");
  for (const [k, v] of Object.entries(SECRETS)) assert.ok(!all.includes(v), `${k} leaked`);
});

if (failures) { console.error(`\n${failures} preflight check(s) FAILED.`); process.exit(1); }
console.log("\nAll preflight checks passed.");
