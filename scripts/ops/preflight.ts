// OPS PREFLIGHT — one read-only command that says whether this box is set up to run for a customer.
//
//   npx tsx scripts/ops/preflight.ts            # run in the install folder (reads the live .env)
//   npx tsx scripts/ops/preflight.ts --json
//   npx tsx scripts/ops/preflight.ts --probe-edge   # also GET PUBLIC_BASE_URL from outside (Linux server, #437)
//
// Every step of docs/OPERATIONS.md ends with "re-run preflight; this line must say PASS". It checks
// configuration, not behaviour: the restore drill, --test-alert and the restart drill prove the rest.
//
// READ-ONLY. Reads .env (via the environment), the users table (read-only connection, operator
// accounts only: email, role, whether a password is set), two counts for NOTIFICATIONS (active IMAP
// tracking sources; unsent client emails) and the backup folders. Writes nothing. The one command
// that SENDS (a test email to yourself) is scripts/ops/test-email.ts, kept apart so this stays read-only.
// --probe-edge adds two GETs to PUBLIC_BASE_URL (/health and /status) to see whether Cloudflare
// Access is in front and the customer bypass works (backend/src/opsEdgePosture.ts); off by default,
// so a plain run never touches the network.
// NEVER PRINTS A SECRET: keys, passwords and tokens are reported as set/missing/length only.
//
// EXIT: 0 no FAIL (WARNs allowed), 1 at least one FAIL.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { backupDir as stateBackupDir, dbPath as stateDbPath, opsDir } from "../../backend/src/statePaths";
import { AUTOMATIC_SNAPSHOT_RE } from "../../backend/src/offboxBackup";
import { DEFAULT_LISTEN_HOST, isLoopbackListenHost, resolveListenHost } from "../../backend/src/listenHost";
import { intakeRequiresAuth } from "../../backend/src/intakeAuth";
import { DEFAULT_STAFF_ORG_ID, configuredStaffOrgs, parseOrgScopedList, staffAlertChannels, staffAlertsOn, staffDigestHour } from "../../backend/src/staffAlertConfig";
import { exposedHostAdvice, isWindows, probeEdge, trustProxyRow, watchdogInstallHint, type HostShape } from "../../backend/src/opsEdgePosture";

const env = process.env;
const asJson = process.argv.includes("--json");
const probeEdgeFlag = process.argv.includes("--probe-edge");
// The desk is Windows; the hosted server is Linux, usually inside the Docker image. Wording that
// only makes sense on one of them is chosen here (opsEdgePosture.ts).
const shape: HostShape = { platform: process.platform, inContainer: fs.existsSync("/.dockerenv") };
type Verdict = "PASS" | "WARN" | "FAIL";
const rows: { area: string; check: string; verdict: Verdict; detail: string }[] = [];
const add = (area: string, check: string, verdict: Verdict, detail: string): void => { rows.push({ area, check, verdict, detail }); };
const PLACEHOLDER_KEY = "replace-with-a-long-random-secret";

// --- ACCESS -----------------------------------------------------------------------------------
const authOn = String(env.AUTH_ENABLED ?? "").toLowerCase() === "true"; // exactly how auth.ts reads it
add("access", "AUTH_ENABLED", authOn ? "PASS" : "FAIL",
  authOn ? "login required" : "no login: anyone who can reach the port can read customer data and use the credential/approve endpoints");

const dbPath = stateDbPath();
let admins: { email: string; role: string; hasPassword: boolean }[] | null = null;
// NOTIFICATIONS (#493) read two counts from the same read-only connection. Each is null when its
// table cannot be read (an older database), which preflight reports as "could not read", never as 0.
let imapSourceRows: number | null = null;
let unsent: { draft: number; failed: number } | null = null;
try {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    try {
      admins = (db.prepare("SELECT email, role, COALESCE(password_hash, '') <> '' AS has_pw FROM users WHERE COALESCE(active, 1) = 1").all() as { email: string; role: string; has_pw: number }[])
        .map((u) => ({ email: String(u.email), role: String(u.role), hasPassword: Number(u.has_pw) === 1 }));
    } catch { admins = null; }
    try {
      // The same filter the scheduler polls with (emailPoller.ts dbImapSources).
      imapSourceRows = Number((db.prepare("SELECT COUNT(*) AS n FROM email_tracking_sources WHERE source_type = 'imap' AND active = 1 AND imap_host != ''").get() as { n: number }).n);
    } catch { imapSourceRows = null; }
    try {
      // The same filter as crm.ts undeliveredCommunications (what scripts/undelivered.ts lists and
      // re-sends), across every org: this is the box's backlog, not one tenant's.
      const r = db.prepare("SELECT SUM(delivery_status = 'draft') AS draft, SUM(delivery_status = 'failed') AS failed FROM communications WHERE direction = 'outbound' AND channel = 'email' AND delivery_status IN ('draft','failed')").get() as { draft: number | null; failed: number | null };
      unsent = { draft: Number(r.draft ?? 0), failed: Number(r.failed ?? 0) };
    } catch { unsent = null; }
  } finally {
    db.close();
  }
} catch {
  admins = null;
}
const isAdmin = (u: { role: string }): boolean => u.role === "admin" || u.role === "superadmin";
const adminWithPw = (admins ?? []).filter((u) => isAdmin(u) && u.hasPassword);
const anyWithPw = (admins ?? []).filter((u) => u.hasPassword);
const seedReady = Boolean(env.ADMIN_EMAIL && env.ADMIN_PASSWORD);
// seedAdminUser (auth.ts) runs only while NO user has a password. When ADMIN_EMAIL matches an
// existing user it sets that user's password and LEAVES ITS ROLE; otherwise it inserts a new
// row with role 'admin'. Production's one user is role 'operator' (2026-09-24), so pointing
// ADMIN_EMAIL at it yields a login that every admin-only page refuses.
if (admins === null) {
  add("access", "admin login", "WARN", `could not read users from ${dbPath}`);
} else if (adminWithPw.length) {
  add("access", "admin login", "PASS", `${adminWithPw.length} admin account(s) with a password (${adminWithPw.map((u) => u.email).join(", ")})`);
} else if (anyWithPw.length) {
  add("access", "admin login", "WARN",
    `${anyWithPw.map((u) => `${u.email} (${u.role})`).join(", ")} can sign in, but no ADMIN account has a password - admin pages (diagnostics, manual backup) will refuse. ` +
    "The ADMIN_* seed no longer runs once any user has a password: promote one account (OPERATIONS.md s4.1).");
} else if (seedReady) {
  const match = admins.find((u) => u.email.toLowerCase() === String(env.ADMIN_EMAIL).trim().toLowerCase());
  if (match && !isAdmin(match)) {
    add("access", "admin login", "FAIL",
      `ADMIN_EMAIL is the existing account ${match.email}, whose role is ${match.role}: the next start sets its password but NOT admin. ` +
      "Use a NEW address for ADMIN_EMAIL (a new admin account is created) - OPERATIONS.md s4.1.");
  } else {
    add("access", "admin login", "WARN",
      "no account has a password yet; the next start with AUTH_ENABLED=true " +
      (match ? `sets it on the existing admin account ${match.email}` : `creates a NEW admin account ${String(env.ADMIN_EMAIL).trim()}`));
  }
} else {
  add("access", "admin login", "FAIL", "no account has a password and ADMIN_EMAIL/ADMIN_PASSWORD are not set - turning auth on would lock everyone out");
}
if (env.ADMIN_PASSWORD && adminWithPw.length) {
  add("access", "ADMIN_PASSWORD in .env", "WARN", "an admin password is already set, so this line is no longer used - remove it from .env (it is plaintext)");
}

const authSecret = env.AUTH_SECRET ?? "";
const sessionKey = env.SESSION_ENCRYPTION_KEY ?? "";
add("access", "AUTH_SECRET", !authSecret ? "WARN" : authSecret === sessionKey ? "FAIL" : authSecret.length < 32 ? "WARN" : "PASS",
  !authSecret ? "unset: login cookies are signed with SESSION_ENCRYPTION_KEY (works, but one secret doing two jobs)"
    : authSecret === sessionKey ? "identical to SESSION_ENCRYPTION_KEY - set its own value"
      : authSecret.length < 32 ? `only ${authSecret.length} characters - use 32+ random characters` : `set (${authSecret.length} characters)`);

// The bind decision is server.ts's (backend/src/listenHost.ts, issue #82) - read from there, never
// re-derived, so preflight cannot report a host the server would not actually listen on.
const listen = resolveListenHost(env);
const host = String(env.SERVER_HOST ?? "").trim() || DEFAULT_LISTEN_HOST;
if (isLoopbackListenHost(host)) {
  add("access", "SERVER_HOST", "PASS",
    `${env.SERVER_HOST?.trim() ? host : `unset (${host})`}: reachable only from this machine (customer links then need a tunnel - see OPERATIONS.md)`);
} else if (authOn) {
  add("access", "SERVER_HOST", "WARN", `${host}: listening beyond this machine - ${exposedHostAdvice(shape)}`);
} else if (!listen.ok) {
  add("access", "SERVER_HOST", "FAIL", `${host} with AUTH_ENABLED off: the server will refuse to start - turn auth on, or remove SERVER_HOST`);
} else {
  // Only ALLOW_UNAUTHENTICATED_NETWORK=1 gets here: the server starts, and that is the failure.
  add("access", "SERVER_HOST", "FAIL",
    `${host} with AUTH_ENABLED off and ALLOW_UNAUTHENTICATED_NETWORK=1: the server starts, and anyone who can reach the port has full access to customer data and the approve/credential endpoints`);
}

const finalSubmit = String(env.PORTAL_ALLOW_FINAL_SUBMIT ?? "").trim() === "1";
add("access", "PORTAL_ALLOW_FINAL_SUBMIT", !finalSubmit ? "PASS" : authOn ? "WARN" : "FAIL",
  !finalSubmit ? "unset: automation never clicks a portal's final submit"
    : authOn ? "=1: Approve & Submit may click a portal's final submit after a named per-run approval (operator ruling; acceptable only with that gate verified on the running build)"
      : "=1 with no login: anyone on the network can approve a filing into a real submission");

// --- CUSTOMER LINKS -----------------------------------------------------------------------------
const base = String(env.PUBLIC_BASE_URL ?? "").trim();
let baseHost = "";
try { baseHost = base ? new URL(base).hostname.toLowerCase() : ""; } catch { baseHost = "(unparseable)"; }
const baseDead = !base || ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "(unparseable)"].includes(baseHost);
add("links", "PUBLIC_BASE_URL", baseDead ? "FAIL" : base.startsWith("https://") ? "PASS" : "WARN",
  baseDead ? `${base || "unset"}: every status/portal/credential link a customer receives points at this machine and will not open`
    : base.startsWith("https://") ? base : `${base}: not https - customers will type portal passwords into the credential page over plain http`);

// --- NOTIFICATIONS (#493) ---------------------------------------------------------------------------
// Every client update and every agency/utility email the tracker matches depends on settings that
// are easy to miss on a new box: without SMTP an update is only saved as a draft, without a tracking
// inbox no correction or approval email is ever read. Each is a WARN (the server runs without them)
// that names the .env line to add. PUBLIC_BASE_URL is the LINKS line above. Values are never printed.
const smtpOn = Boolean(env.SMTP_HOST && env.SMTP_FROM); // exactly clientNotifier.ts smtpConfigured()
add("notifications", "client email (SMTP)", smtpOn ? "PASS" : "WARN",
  smtpOn
    ? `set (${env.SMTP_USER ? "with sign-in" : "no sign-in"}): prove it with scripts/ops/test-email.ts --to <you>`
    : `${env.SMTP_HOST ? "SMTP_FROM" : env.SMTP_FROM ? "SMTP_HOST" : "SMTP_HOST and SMTP_FROM"} unset: client updates are only saved as drafts, never sent. ` +
      "Add SMTP_HOST=<server> and SMTP_FROM=<address clients see> (plus SMTP_PORT, SMTP_USER, SMTP_PASS) to .env");
if (smtpOn && env.SMTP_USER && !env.SMTP_PASS) {
  add("notifications", "SMTP_PASS", "WARN", "SMTP_USER is set but SMTP_PASS is empty: the mail server will refuse the sign-in. Add SMTP_PASS=<app password>");
}
// The three ways the scheduler reads the tracking inbox (scheduler.ts): the env IMAP inbox
// (emailPoller.ts envImapConfig needs host, user AND password), IMAP sources saved in the database
// (POST /api/imap/sources), and Gmail once it holds a refresh token (gmail.ts gmailStatus().authorized).
const envImap = Boolean(env.EMAIL_IMAP_HOST && env.EMAIL_IMAP_USER && env.EMAIL_IMAP_PASS);
const envImapPartial = !envImap && Boolean(env.EMAIL_IMAP_HOST || env.EMAIL_IMAP_USER || env.EMAIL_IMAP_PASS);
const gmailApp = Boolean(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET);
const gmailOn = Boolean(env.GMAIL_REFRESH_TOKEN);
const sources = [
  envImap ? "IMAP inbox (EMAIL_IMAP_*)" : "",
  imapSourceRows ? `${imapSourceRows} saved IMAP source(s) (email_tracking_sources)` : "",
  gmailOn ? "Gmail" : "",
].filter(Boolean);
const trackingFixes: string[] = [];
if (envImapPartial) {
  trackingFixes.push(`EMAIL_IMAP_* is incomplete (${["EMAIL_IMAP_HOST", "EMAIL_IMAP_USER", "EMAIL_IMAP_PASS"].filter((k) => !env[k]).join(", ")} unset), so it is ignored`);
}
if (gmailApp && !gmailOn) {
  // The OAuth redirect defaults to localhost; on the server the consent page must come back to the
  // server's own address, which is the step the Linux runbook moves (OPERATIONS_LINUX.md s2).
  const redirect = String(env.GMAIL_REDIRECT_URI ?? "").trim();
  let redirectHost = "";
  try { redirectHost = redirect ? new URL(redirect).hostname.toLowerCase() : "localhost"; } catch { redirectHost = "(unparseable)"; }
  trackingFixes.push("Gmail is set up but not authorized (no GMAIL_REFRESH_TOKEN): " +
    (!baseDead && redirectHost !== baseHost ? `set GMAIL_REDIRECT_URI=${base.replace(/\/+$/, "")}/api/gmail/oauth/callback (now ${redirect ? "another host" : "localhost"}) and restart, then ` : "") +
    "open /api/gmail/auth-url signed in, follow its url, and add the GMAIL_REFRESH_TOKEN line the callback page shows");
}
add("notifications", "tracking inbox", sources.length ? (trackingFixes.length ? "WARN" : "PASS") : "WARN",
  sources.length
    ? [`${sources.join(" + ")}: agency and utility emails are read every monitor tick`, ...trackingFixes].join("; ")
    : [imapSourceRows === null ? "could not read the Email tracking sources" : "none configured: correction, approval and utility emails are never read",
      ...trackingFixes,
      "add EMAIL_IMAP_HOST=, EMAIL_IMAP_USER=, EMAIL_IMAP_PASS= (the shared inbox clients forward to), or connect Gmail (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, then GMAIL_REFRESH_TOKEN)"].join("; "));
// Email-in intake (#489) is optional: a row only when EMAIL_INTAKE_ADDRESS is set. It is read off
// the same inbox, so it needs one; the address shape is the one emailIntake.intakeAddressSetting takes.
const intakeAddress = String(env.EMAIL_INTAKE_ADDRESS ?? "").trim();
if (intakeAddress) {
  const intakeOk = /^[^@\s+]+@[^@\s]+$/.test(intakeAddress);
  add("notifications", "email intake", intakeOk && sources.length ? "PASS" : "WARN",
    !intakeOk ? `EMAIL_INTAKE_ADDRESS=${intakeAddress} is not a plain address (no +tag): set it to the bare intake address, e.g. intake@<your domain>`
      : sources.length ? `jobs emailed to ${intakeAddress.replace("@", "+<client tag>@")} become projects; give each client a tag under Clients; ` +
        (intakeRequiresAuth(env)
          ? "sender check REQUIRED (EMAIL_INTAKE_REQUIRE_AUTH): only mail the inbox's provider marked dmarc=pass (or aligned spf+dkim pass) is filed"
          : "sender check default: a stated DMARC fail is refused, mail with no Authentication-Results is filed on the sender match alone (EMAIL_INTAKE_REQUIRE_AUTH=1 requires a pass; right for Gmail and most hosted inboxes)")
      : "EMAIL_INTAKE_ADDRESS is set but no tracking inbox is configured, so no emailed job is ever read (see tracking inbox)");
}
// Read exactly as scheduler.ts reads it: <= 0 (an empty value included) turns the monitor off.
if (Number(env.MONITOR_INTERVAL_MINUTES ?? 15) <= 0) {
  add("notifications", "MONITOR_INTERVAL_MINUTES", "WARN",
    `${String(env.MONITOR_INTERVAL_MINUTES).trim() || "empty"}: the monitor never runs, so no tracking inbox is read and no portal status is checked (right on a test copy only). Remove the line or set MONITOR_INTERVAL_MINUTES=15`);
}
// Staff alerts (stopped runs, corrections, status changes, the morning digest; #487). The verdict
// is staffAlertConfig.ts's — the leaf module the server sends by — so this row cannot call a
// setting on that the server ignores (an address with no SMTP, a webhook that is not http(s), an
// unreadable STAFF_DIGEST_HOUR). It never prints an address or the webhook URL (an ntfy topic is
// the password to the push channel).
{
  const staffChannels = staffAlertChannels(DEFAULT_STAFF_ORG_ID, env);
  const staffListed = parseOrgScopedList(env.STAFF_ALERT_TO, /[,;]/).filter((e) => e.orgId === DEFAULT_STAFF_ORG_ID).length;
  const staffOn = staffAlertsOn(DEFAULT_STAFF_ORG_ID, env);
  const digestHour = staffDigestHour(env);
  const digestRaw = String(env.STAFF_DIGEST_HOUR ?? "").trim();
  const otherOrgs = configuredStaffOrgs(env).filter((o) => o !== DEFAULT_STAFF_ORG_ID).length;
  add("notifications", "staff alerts", staffOn ? "PASS" : "WARN",
    staffOn
      ? [staffChannels.emails.length ? `email to ${staffChannels.emails.length} address(es)` : "",
        staffChannels.webhooks.length ? "webhook set" : "",
        digestHour !== null ? `morning digest at hour ${digestHour}` : digestRaw ? `no morning digest (STAFF_DIGEST_HOUR=${digestRaw} is not an hour 0-23)` : "no morning digest (STAFF_DIGEST_HOUR unset)",
        otherOrgs ? `${otherOrgs} other org(s) configured` : ""].filter(Boolean).join("; ")
      : staffListed
        ? "STAFF_ALERT_TO is set but SMTP is not, so no staff alert can be emailed: set SMTP (above) or STAFF_ALERT_WEBHOOK_URL=<ntfy topic>"
        : "no recipients: nobody on the team is told when a run stops or a job changes state. Add STAFF_ALERT_TO=<you>, <your PM> (uses SMTP) and/or STAFF_ALERT_WEBHOOK_URL=<ntfy topic> (staff alerts, #487)");
}
add("notifications", "unsent client emails", unsent === null ? "WARN" : unsent.draft + unsent.failed ? "WARN" : "PASS",
  unsent === null ? `could not read communications from ${dbPath}`
    : unsent.draft + unsent.failed
      ? `${unsent.draft} draft (never tried) + ${unsent.failed} failed: list them with scripts/undelivered.ts, re-send with --send once SMTP and PUBLIC_BASE_URL are set`
      : "none: every automated client email on record was sent");

// --- SECRETS ---------------------------------------------------------------------------------------
add("secrets", "SESSION_ENCRYPTION_KEY", !sessionKey || sessionKey === PLACEHOLDER_KEY ? "FAIL" : sessionKey.length < 32 ? "WARN" : "PASS",
  !sessionKey || sessionKey === PLACEHOLDER_KEY ? "missing or the .env.example placeholder - saved portal logins cannot be read"
    : `set (${sessionKey.length} characters). It is in NO backup: escrow it in a password manager and prove it with the restore drill (--no-dotenv)`);

// --- BACKUPS ------------------------------------------------------------------------------------------
const backupDir = stateBackupDir();
const newestIn = (dir: string): { name: string; ageH: number } | null => {
  try {
    const hits = fs.readdirSync(dir).filter((f) => AUTOMATIC_SNAPSHOT_RE.test(f))
      .map((f) => ({ name: f, m: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
    return hits[0] ? { name: hits[0].name, ageH: (Date.now() - hits[0].m) / 3600_000 } : null;
  } catch { return null; }
};
const interval = Number(env.BACKUP_INTERVAL_HOURS || 24);
const keep = Number(env.BACKUP_KEEP || 14);
const newest = newestIn(backupDir);
add("backups", "BACKUP_DIR", newest ? (newest.ageH <= Math.max(interval, 1) * 1.5 + 1 ? "PASS" : "FAIL") : "FAIL",
  newest ? `${backupDir}: newest snapshot ${newest.ageH.toFixed(1)} h old` : `${backupDir}: no automatic snapshot found`);
add("backups", "BACKUP_INTERVAL_HOURS", interval >= 1 && interval <= 4 ? "PASS" : "WARN",
  interval > 0 ? `${interval} h between snapshots = up to ${interval} h of work lost${interval > 4 ? " (1-4 h recommended)" : ""}` : "schedule OFF (one snapshot per boot only)");
const historyH = interval > 0 ? interval * keep : 0;
add("backups", "BACKUP_KEEP", historyH >= 7 * 24 || interval <= 0 ? "PASS" : "WARN",
  `${keep} snapshots x ${interval} h = ${(historyH / 24).toFixed(1)} days of history${historyH < 7 * 24 ? ` (set BACKUP_KEEP=${Math.ceil((7 * 24) / Math.max(interval, 1))} for 7 days)` : ""}`);
const second = String(env.BACKUP_SECOND_DIR ?? "").trim();
if (!second) {
  add("backups", "BACKUP_SECOND_DIR", "FAIL", "unset: every backup is on this one machine");
} else {
  const secondDir = path.resolve(process.cwd(), second);
  const off = newestIn(secondDir);
  // Windows judges by drive letter. On Linux every path's root is "/", so the drive-letter test
  // called every folder "the same drive"; compare the filesystems' device ids instead (a mounted
  // Storage Box or second disk has its own). A path that cannot be stat'ed counts as different.
  const devOf = (p: string): number | null => { try { return fs.statSync(fs.existsSync(p) ? p : path.dirname(p)).dev; } catch { return null; } };
  const sameDrive = (a: string, b: string): boolean => isWindows(shape)
    ? path.parse(a).root.toLowerCase() === path.parse(b).root.toLowerCase()
    : devOf(a) !== null && devOf(a) === devOf(b);
  add("backups", "BACKUP_SECOND_DIR", !fs.existsSync(secondDir) ? "FAIL" : !off ? "WARN" : "PASS",
    !fs.existsSync(secondDir) ? `${secondDir} does not exist (a disconnected share?)`
      : !off ? `${secondDir}: no snapshot copied yet - run scripts/ops/offbox-sync.ts`
        : `${secondDir}: newest off-box snapshot ${off.ageH.toFixed(1)} h old` +
          (sameDrive(secondDir, dbPath) || sameDrive(secondDir, backupDir)
            ? isWindows(shape) ? " (same drive as the database or BACKUP_DIR: fine ONLY if it is a cloud-synced folder)" : " (same filesystem as the database or BACKUP_DIR: not off the box - mount the Storage Box there)"
            : ""));
}

// --- ALERTS ---------------------------------------------------------------------------------------------
const smtp = Boolean(env.SMTP_HOST && env.SMTP_FROM);
const to = String(env.WATCHDOG_ALERT_TO ?? "").trim();
const hook = Boolean(env.WATCHDOG_WEBHOOK_URL);
add("alerts", "watchdog channel", (smtp && to) || hook ? "PASS" : "FAIL",
  [smtp && to ? `email to ${to.split(/[,;]/).length} address(es)` : smtp ? "SMTP set but WATCHDOG_ALERT_TO is empty" : "no SMTP",
    hook ? "webhook set" : "no webhook"].join("; "));
add("alerts", "WATCHDOG_HEARTBEAT_URL", env.WATCHDOG_HEARTBEAT_URL ? "PASS" : "WARN",
  env.WATCHDOG_HEARTBEAT_URL ? "set: an outside service notices when this machine goes silent" : "unset: when the whole machine is off, nothing can tell anyone");
const stateFile = env.WATCHDOG_STATE_FILE ? path.resolve(process.cwd(), env.WATCHDOG_STATE_FILE) : path.join(opsDir(), "watchdog-state.json");
let lastRun: number | null = null;
try { lastRun = Date.parse(JSON.parse(fs.readFileSync(stateFile, "utf8")).lastRunAt); } catch { lastRun = null; }
add("alerts", "watchdog running", lastRun && Date.now() - lastRun < 20 * 60_000 ? "PASS" : "FAIL",
  lastRun ? `last poll ${Math.round((Date.now() - lastRun) / 60_000)} min ago` : `has never run here (${watchdogInstallHint(shape)})`);

// --- EDGE (the hosted server behind cloudflared; #437) -------------------------------------------
// TRUST_PROXY is read on every platform: it is what the login lockout keys on behind any proxy.
{ const r = trustProxyRow(env, shape); add(r.area, r.check, r.verdict, r.detail); }
if (probeEdgeFlag) {
  if (baseDead) add("edge", "probe", "FAIL", "--probe-edge needs a real PUBLIC_BASE_URL");
  else for (const r of await probeEdge(base, fetch)) add(r.area, r.check, r.verdict, r.detail);
}

// --- REPORT -------------------------------------------------------------------------------------------
const fails = rows.filter((r) => r.verdict === "FAIL").length;
const warns = rows.filter((r) => r.verdict === "WARN").length;
if (asJson) {
  console.log(JSON.stringify({ fails, warns, rows }, null, 2));
} else {
  console.log(`ops preflight   ${new Date().toISOString()}   (read-only; docs/OPERATIONS.md)`);
  let area = "";
  for (const r of rows) {
    if (r.area !== area) { console.log(`\n  ${r.area.toUpperCase()}`); area = r.area; }
    console.log(`    ${r.verdict.padEnd(4)}  ${r.check.padEnd(26)} ${r.detail}`);
  }
  console.log(`\nPREFLIGHT: ${fails ? `${fails} FAIL` : "no FAIL"}, ${warns} WARN`);
}
process.exit(fails ? 1 : 0);
