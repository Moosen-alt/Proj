// STAFF ALERTS + MORNING DIGEST (#487). Pins, through the REAL writers where one exists:
//
//   TRIGGERS   a stage run that FAILS / PAUSES (prepareSubmission with the browser stubbed), an
//              INTERRUPTED run (recoverInterruptedPortalRuns), a status CHANGE and a matched
//              CORRECTION (recordPermitStatusCheck) each record + send one alert.
//   DEDUPE     one alert per transition, never per poll: a re-poll of the same outcome, a second
//              call for the same run, a run that staged cleanly, and a "waiting" reading send none;
//              a status that moves away and back is a new transition and alerts again.
//   DELIVERY   the product's SMTP settings + STAFF_ALERT_TO (a fake SMTP server on loopback, through
//              the real nodemailer) and STAFF_ALERT_WEBHOOK_URL in the watchdog's exact webhook shape
//              (pinned against scripts/ops/mailer.ts). Unset = off, recorded as 'off'. A refused
//              webhook is recorded 'failed' with a code and is listed as undelivered.
//   SCRUB      MUST-EXCLUDE: the account and meter numbers, the homeowner's name, URLs, emails and
//              bare long digit runs never reach a subject, a body, a mail or a webhook — the run's
//              own reason carries them in the fixture.
//   ORG SCOPE  an org-acme job goes only to org-acme's channel; the default org's inbox is never its
//              fallback; each org's digest lists only its own projects.
//   DIGEST     at STAFF_DIGEST_HOUR server time, once a day, built from the project list's next-step
//              answers (who === "me"), most urgent first, a link per project.
// No spawned server shares the DB: only this process writes it (fake mail/webhook servers only).
//
// KILL TESTS: drop the alertStaffOnRunOutcome call after the stage run's transaction → the run
// checks fail; drop the recordPermitStatusCheck hook → the status/correction checks fail; remove
// the claim()'s newest-row check → the dedupe checks fail; remove scrubStaffText's redaction →
// the MUST-EXCLUDE fails.
//
// Run: npx tsx backend/test/staffAlerts.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("staff-alerts");
const { db, repo } = fx;
const sa = await import("../src/staffAlerts");
const cfg = await import("../src/staffAlertConfig");
const mailer = await import("../../scripts/ops/mailer");

const ACCOUNT = "1234567890";   // the fixture's account number
const METER = "987654321";      // the fixture's meter number

// ── fake servers (loopback; they never touch the DB) ─────────────────────────────────────────
const mails: Array<{ rcpt: string[]; data: string }> = [];
const smtp = net.createServer((sock) => {
  sock.write("220 fake.smtp.invalid ESMTP\r\n");
  let buf = ""; let inData = false; let data = ""; let rcpt: string[] = [];
  sock.on("data", (chunk) => {
    buf += chunk.toString("latin1");
    let idx: number;
    while ((idx = buf.indexOf("\r\n")) >= 0) {
      const lineIn = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (inData) {
        if (lineIn === ".") {
          inData = false;
          const decoded = Buffer.from(data.replace(/=\n/g, "").replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8");
          mails.push({ rcpt, data: decoded }); data = ""; rcpt = []; sock.write("250 2.0.0 queued\r\n");
        } else data += `${lineIn}\n`;
        continue;
      }
      const cmd = lineIn.slice(0, 4).toUpperCase();
      if (cmd === "EHLO" || cmd === "HELO") sock.write("250 fake.smtp.invalid\r\n");
      else if (cmd === "RCPT") { rcpt.push(lineIn.replace(/^RCPT TO:\s*/i, "").replace(/[<>]/g, "")); sock.write("250 OK\r\n"); }
      else if (cmd === "DATA") { inData = true; sock.write("354 go ahead\r\n"); }
      else if (cmd === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
      else sock.write("250 OK\r\n");
    }
  });
});
await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
const hooks: Array<{ path: string; contentType: string; title: string; body: string }> = [];
const hook = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    hooks.push({ path: String(req.url), contentType: String(req.headers["content-type"] ?? ""), title: String(req.headers.title ?? ""), body });
    res.writeHead(req.url === "/broken" ? 500 : 200); res.end("ok");
  });
});
await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
const HOOK = `http://127.0.0.1:${(hook.address() as AddressInfo).port}`;

const STAFF_ENV_KEYS = ["STAFF_ALERT_TO", "STAFF_ALERT_WEBHOOK_URL", "STAFF_ALERT_WEBHOOK_FORMAT", "STAFF_DIGEST_HOUR", "SMTP_HOST", "SMTP_PORT", "SMTP_FROM", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS"];
function setEnv(vars: Record<string, string>): void {
  for (const k of STAFF_ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
}
const smtpEnv = { SMTP_HOST: "127.0.0.1", SMTP_PORT: String((smtp.address() as AddressInfo).port), SMTP_SECURE: "false", SMTP_FROM: "Keelix <alerts@keelix.invalid>" };
const settle = () => new Promise((r) => setTimeout(r, 400));   // the triggers are fire-and-forget

type Row = { id: string; org_id: string; project_id: string | null; kind: string; ref: string; state: string; subject: string; body: string; recipient: string; delivery_status: string; delivery_detail: string };
const rows = (where = "1 = 1", params: unknown[] = []) => db.query<Row>(`SELECT * FROM staff_notifications WHERE ${where} ORDER BY created_at, rowid`, params as never[]);
const ownerOf = (projectId: string) => String(db.get<{ homeowner_name: string }>("SELECT homeowner_name FROM projects WHERE id = ?", [projectId])!.homeowner_name);
const ownerNames: string[] = [];
const newProject = (o: Parameters<typeof fx.newProject>[0] = {}) => { const id = fx.newProject(o); ownerNames.push(ownerOf(id)); return id; };

// ── configuration ───────────────────────────────────────────────────────────────────────────
await check("config: bare entries are the default org's, `<org>=` entries that org's alone; email needs SMTP; unset = off", () => {
  setEnv({});
  assert.equal(cfg.staffAlertsOn("org-default"), false, "nothing set is OFF");
  setEnv({ STAFF_ALERT_TO: "a@keelix.invalid; org-acme=b@acme.invalid, c@keelix.invalid" });
  assert.equal(cfg.staffAlertsOn("org-default"), false, "addresses without SMTP are not a channel");
  setEnv({ ...smtpEnv, STAFF_ALERT_TO: "a@keelix.invalid; org-acme=b@acme.invalid, c@keelix.invalid", STAFF_ALERT_WEBHOOK_URL: "https://ntfy.invalid/topic?x=1, org-acme=https://push.acme.invalid/t" });
  assert.deepEqual(cfg.staffAlertChannels("org-default").emails, ["a@keelix.invalid", "c@keelix.invalid"]);
  assert.deepEqual(cfg.staffAlertChannels("org-acme").emails, ["b@acme.invalid"]);
  assert.deepEqual(cfg.staffAlertChannels("org-default").webhooks, ["https://ntfy.invalid/topic?x=1"], "a URL's query '=' is not an org prefix");
  assert.deepEqual(cfg.staffAlertChannels("org-acme").webhooks, ["https://push.acme.invalid/t"]);
  assert.deepEqual(cfg.staffAlertChannels("org-other"), { emails: [], webhooks: [], webhookFormat: "json" }, "an unconfigured org hears nothing — no fallback");
  assert.deepEqual(cfg.configuredStaffOrgs().sort(), ["org-acme", "org-default"]);
  const described = JSON.stringify(cfg.describeStaffAlerts());
  assert.doesNotMatch(described, /@|ntfy|acme\.invalid/, `preflight's line never prints an address or URL: ${described}`);
});
await check("config: STAFF_DIGEST_HOUR — unset 7, 0-23 honoured, off/garbage = off", () => {
  for (const [raw, want] of [["", 7], ["0", 0], ["23", 23], ["9", 9], ["off", null], ["24", null], ["7am", null], ["-1", null]] as const) {
    setEnv(raw ? { STAFF_DIGEST_HOUR: raw } : {});
    assert.equal(cfg.staffDigestHour(), want, `STAFF_DIGEST_HOUR=${raw}`);
  }
});
await check("shouldAlertStaffOnStatus: changes only; waiting / no_change / correction_flagged are silent", () => {
  assert.equal(sa.shouldAlertStaffOnStatus("issued", "waiting"), true);
  assert.equal(sa.shouldAlertStaffOnStatus("issued", ""), true);
  assert.equal(sa.shouldAlertStaffOnStatus("issued", "issued"), false, "never per poll");
  assert.equal(sa.shouldAlertStaffOnStatus("needs_human_review", "waiting"), true);
  assert.equal(sa.shouldAlertStaffOnStatus("waiting", "issued"), false);
  assert.equal(sa.shouldAlertStaffOnStatus("correction_flagged", "waiting"), false, "the correction has its own alert");
});
await check("scrubStaffText: first line; known secrets (any separators), URLs, emails, long digit runs gone; capped", () => {
  const out = sa.scrubStaffText(`Field "Account" got 1234-567-890 and meter 987 654 321 (see https://portal.invalid/rec?acct=${ACCOUNT}, ops@x.invalid, ref 55512345678)\nsecond line ${ACCOUNT}`, [ACCOUNT, METER]);
  for (const bad of [/1234.?567.?890/, /987.?654.?321/, /portal\.invalid/, /ops@x/, /55512345678/, /second line/]) assert.doesNotMatch(out, bad, out);
  assert.match(out, /Field "Account" got/);
  assert.ok(sa.scrubStaffText("x".repeat(500), []).length <= 200);
});
await check("the webhook is the watchdog's exact shape (scripts/ops/mailer.ts postWebhook), json and text", async () => {
  for (const format of ["json", "text"] as const) {
    hooks.length = 0;
    await mailer.postWebhook("Keelix — needs you: X", "body line", { WATCHDOG_WEBHOOK_URL: `${HOOK}/parity`, WATCHDOG_WEBHOOK_FORMAT: format });
    await sa.postStaffWebhook(`${HOOK}/parity`, format, "Keelix — needs you: X", "body line");
    assert.equal(hooks.length, 2);
    assert.deepEqual({ ...hooks[1] }, { ...hooks[0] }, `${format}: staff webhook differs from the watchdog's`);
  }
});

// ── triggers, through the real writers ──────────────────────────────────────────────────────
fx.completeRecipe();
setEnv({ STAFF_ALERT_WEBHOOK_URL: `${HOOK}/staff`, STAFF_ALERT_WEBHOOK_FORMAT: "text" });

let failedProject = "";
await check("a stage run that FAILS alerts once: address, track, the run's reason — scrubbed", async () => {
  hooks.length = 0;
  failedProject = newProject();
  fx.stubRunner(async () => fx.failingStep(`Required field "Meter number" is blank (bill shows ${METER}, account ${ACCOUNT}); see https://permits.portland.example/rec/${ACCOUNT}`));
  await repo.prepareSubmission(db, failedProject, "building").catch((e) => e);
  await settle();
  const run = fx.latestRun(failedProject)!;
  assert.equal(run.status, "failed", JSON.stringify(run).slice(0, 400));
  const mine = rows("project_id = ? AND kind = 'run'", [failedProject]);
  assert.equal(mine.length, 1, JSON.stringify(mine));
  assert.equal(mine[0].ref, String(run.id));
  assert.equal(mine[0].state, "failed");
  assert.equal(mine[0].delivery_status, "sent", mine[0].delivery_detail);
  assert.equal(mine[0].recipient, "webhook", "the webhook URL is never stored");
  assert.equal(hooks.filter((h) => h.path === "/staff").length, 1);
  const h = hooks[0];
  assert.match(h.title, /needs you: Building permit run failed/);
  assert.match(h.body, /Solar Way/, "the address");
  assert.match(h.body, /Track: Building permit/);
  assert.match(h.body, /Why: .*Meter number/, "the run's own reason");
  assert.match(h.body, new RegExp(`/#/project/${failedProject}`), "a link to the project");
});
await check("DEDUPE: the same run's outcome again sends nothing; a cleanly staged run sends nothing", async () => {
  const before = rows().length; const hooksBefore = hooks.length;
  const run = fx.latestRun(failedProject)!;
  await sa.alertStaffOnRunOutcome(db, { projectId: failedProject, runId: String(run.id), track: "building", runStatus: "failed", reason: "again" });
  await sa.alertStaffOnRunOutcome(db, { projectId: failedProject, runId: "run-staged", track: "building", runStatus: "awaiting_human_submit", reason: "" });
  assert.equal(rows().length, before);
  assert.equal(hooks.length, hooksBefore);
});
await check("a stage run that PAUSES (MFA) alerts once with its own sentence", async () => {
  const pid = newProject();
  fx.stubRunner(async () => ({ portalName: "stub", ok: false, finalSubmitClicked: false, pauseReason: "mfa_captcha", steps: [{ ok: false, message: "MFA challenge", pauseReason: "mfa_captcha" }] }));
  await repo.prepareSubmission(db, pid, "building").catch((e) => e);
  await settle();
  const mine = rows("project_id = ? AND kind = 'run'", [pid]);
  assert.equal(mine.length, 1, JSON.stringify(fx.latestRun(pid)).slice(0, 400));
  assert.equal(mine[0].state, "paused_for_human");
  assert.match(mine[0].body, /verification challenge/);
});
await check("an INTERRUPTED run (its process went away) alerts once", async () => {
  const pid = newProject();
  db.run(`INSERT INTO portal_runs (id, project_id, portal_profile_id, run_type, status, started_at, finished_at, error_message, human_action_required, screenshots_path, logs_path, result_json, pause_reason, permit_type, recipe_id, recipe_version, runner)
          VALUES ('run-gone', ?, NULL, 'prepare_submit', 'running', ?, NULL, '', 0, '', '', '{}', NULL, 'nem', NULL, NULL, 'dead-runner')`, [pid, new Date().toISOString()]);
  repo.recoverInterruptedPortalRuns(db, { projectId: pid, isAlive: () => false });
  await settle();
  const mine = rows("project_id = ? AND kind = 'run'", [pid]);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].state, "interrupted");
  assert.match(mine[0].subject, /NEM \/ interconnection run interrupted/);
});

let statusProject = "";
await check("a status CHANGE alerts once in our own words; a re-poll of it sends nothing", async () => {
  statusProject = newProject();
  const now = new Date().toISOString();
  db.run(`INSERT INTO permit_check_targets (id, project_id, target_type, permit_type, active, latest_outcome, permit_number, created_at, updated_at)
          VALUES ('t-staff', ?, 'permit', 'electrical', 1, 'waiting', 'ELEC-2026-0042', ?, ?)`, [statusProject, now, now]);
  await repo.recordPermitStatusCheck(db, statusProject, { targetId: "t-staff", source: "manual", rawStatusText: "Permit issued" });
  await settle();
  let mine = rows("project_id = ? AND kind = 'status'", [statusProject]);
  assert.equal(mine.length, 1, JSON.stringify(mine));
  assert.equal(mine[0].state, "issued");
  assert.equal(mine[0].ref, "t-staff");
  assert.match(mine[0].body, /permit issued \(book the install/);
  assert.doesNotMatch(mine[0].body, /ELEC-2026-0042/, "no permit number — address, track and reason only");
  await repo.recordPermitStatusCheck(db, statusProject, { targetId: "t-staff", source: "manual", rawStatusText: "Permit issued" });
  await settle();
  mine = rows("project_id = ? AND kind = 'status'", [statusProject]);
  assert.equal(mine.length, 1, "a re-poll is not a transition");
});
await check("a matched CORRECTION alerts as a correction (not also as a status change)", async () => {
  const pid = newProject();
  const now = new Date().toISOString();
  db.run(`INSERT INTO permit_check_targets (id, project_id, target_type, permit_type, active, latest_outcome, created_at, updated_at)
          VALUES ('t-corr', ?, 'permit', 'building', 1, 'waiting', ?, ?)`, [pid, now, now]);
  await repo.recordPermitStatusCheck(db, pid, { targetId: "t-corr", source: "email", rawStatusText: "Corrections required: please revise sheet E-1 and resubmit." });
  await settle();
  const corr = rows("project_id = ? AND kind = 'correction'", [pid]);
  assert.equal(corr.length, 1, JSON.stringify(rows("project_id = ?", [pid])));
  assert.match(corr[0].subject, /correction notice received/);
  assert.equal(rows("project_id = ? AND kind = 'status'", [pid]).length, 0);
});
await check("DEDUPE: a status that moves away and back is a NEW transition and alerts again", async () => {
  for (const [outcome, prev] of [["needs_human_review", "issued"], ["issued", "needs_human_review"]] as const) {
    await sa.alertStaffOnStatusChange(db, { projectId: statusProject, targetId: "t-staff", track: "electrical", outcome, previousOutcome: prev });
  }
  await sa.alertStaffOnStatusChange(db, { projectId: statusProject, targetId: "t-staff", track: "electrical", outcome: "issued", previousOutcome: "waiting" });
  assert.deepEqual(rows("project_id = ? AND kind = 'status'", [statusProject]).map((r) => r.state), ["issued", "needs_human_review", "issued"],
    "the last call repeats the newest state, so it is refused even though the caller said it changed");
});

// ── delivery states ─────────────────────────────────────────────────────────────────────────
await check("OFF: nothing configured → recorded once as 'off', nothing sent, listed as undelivered", async () => {
  setEnv({});
  hooks.length = 0;
  const pid = newProject();
  await sa.alertStaffOnRunOutcome(db, { projectId: pid, runId: "run-off", track: "building", runStatus: "failed", reason: "x" });
  await sa.alertStaffOnRunOutcome(db, { projectId: pid, runId: "run-off", track: "building", runStatus: "failed", reason: "x" });
  const mine = rows("project_id = ?", [pid]);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].delivery_status, "off");
  assert.equal(hooks.length, 0);
  assert.ok(sa.undeliveredStaffNotifications(db, "org-default").some((r) => r.id === mine[0].id));
});
await check("FAILED: a webhook that refuses is recorded 'failed' with a code, and listed as undelivered", async () => {
  setEnv({ STAFF_ALERT_WEBHOOK_URL: `${HOOK}/broken` });
  const pid = newProject();
  await sa.alertStaffOnRunOutcome(db, { projectId: pid, runId: "run-broken", track: "building", runStatus: "submitted_unconfirmed", reason: "" });
  const mine = rows("project_id = ?", [pid]);
  assert.equal(mine[0].delivery_status, "failed");
  assert.equal(mine[0].delivery_detail, "webhook: HTTP_500");
  assert.match(mine[0].body, /portal did not confirm/);
  assert.ok(sa.undeliveredStaffNotifications(db, null).some((r) => r.id === mine[0].id));
});
await check("EMAIL: goes out on the product's SMTP settings to the org's STAFF_ALERT_TO only", async () => {
  setEnv({ ...smtpEnv, STAFF_ALERT_TO: "staff@keelix.invalid, org-acme=ops@acme.invalid" });
  mails.length = 0;
  const pid = newProject();
  await sa.alertStaffOnRunOutcome(db, { projectId: pid, runId: "run-mail", track: "nem", runStatus: "failed", reason: `meter ${METER} blank` });
  const mine = rows("project_id = ?", [pid]);
  assert.equal(mine[0].delivery_status, "sent", mine[0].delivery_detail);
  assert.equal(mine[0].recipient, "staff@keelix.invalid");
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0].rcpt, ["staff@keelix.invalid"]);
  assert.match(mails[0].data, /Track: NEM \/ interconnection\nWhat happened: run failed/);
});

// ── org scoping ─────────────────────────────────────────────────────────────────────────────
db.run("INSERT OR IGNORE INTO orgs (id, name, edition, created_at) VALUES ('org-acme', 'Acme Solar', 'full', ?)", [new Date().toISOString()]);
const acmeProject = newProject({ street: "77 Acme Ridge Rd" });
db.run("UPDATE projects SET org_id = 'org-acme' WHERE id = ?", [acmeProject]);
await check("ORG SCOPE: an org-acme job goes to org-acme's channel only, never the default org's", async () => {
  setEnv({ STAFF_ALERT_WEBHOOK_URL: `${HOOK}/keelix, org-acme=${HOOK}/acme` });
  hooks.length = 0;
  await sa.alertStaffOnRunOutcome(db, { projectId: acmeProject, runId: "run-acme", track: "building", runStatus: "failed", reason: "x" });
  assert.deepEqual(hooks.map((h) => h.path), ["/acme"]);
  assert.equal(rows("project_id = ?", [acmeProject])[0].org_id, "org-acme", "the row carries the project's org");
});
await check("ORG SCOPE: with only the default org configured, an org-acme job is recorded 'off' — no fallback", async () => {
  setEnv({ STAFF_ALERT_WEBHOOK_URL: `${HOOK}/keelix` });
  hooks.length = 0;
  await sa.alertStaffOnRunOutcome(db, { projectId: acmeProject, runId: "run-acme-2", track: "building", runStatus: "failed", reason: "x" });
  assert.equal(hooks.length, 0, JSON.stringify(hooks));
  assert.equal(rows("ref = 'run-acme-2'")[0].delivery_status, "off");
});

// ── the morning digest ──────────────────────────────────────────────────────────────────────
await check("DIGEST: due at STAFF_DIGEST_HOUR server time, once a day per org, each org's own projects only", async () => {
  setEnv({ STAFF_DIGEST_HOUR: "7", STAFF_ALERT_WEBHOOK_URL: `${HOOK}/keelix, org-acme=${HOOK}/acme` });
  hooks.length = 0;
  const day = (h: number) => new Date(2026, 10, 3, h, 5, 0);
  assert.deepEqual(await sa.sendStaffDigestsIfDue(db, day(6)), [], "not before the hour");
  assert.deepEqual((await sa.sendStaffDigestsIfDue(db, day(7))).sort(), ["org-acme", "org-default"]);
  assert.deepEqual(await sa.sendStaffDigestsIfDue(db, day(9)), [], "once a day");
  const keelix = hooks.find((h) => h.path === "/keelix")!;
  const acme = hooks.find((h) => h.path === "/acme")!;
  assert.ok(keelix && acme, JSON.stringify(hooks.map((h) => h.path)));
  assert.doesNotMatch(keelix.body, /Acme Ridge/, "the default org's digest never lists another org's job");
  assert.doesNotMatch(acme.body, /Solar Way/, "org-acme's digest lists only its own job");
  assert.equal(rows("kind = 'digest'").length, 2);
  assert.ok(rows("kind = 'digest'").every((r) => r.ref === "2026-11-03" && r.project_id === null));
});
await check("DIGEST: built from the next-step answers (who === 'me'), most urgent first, a link each", async () => {
  const list = repo.getProjectList(db, { orgId: "org-default", includeArchived: false, limit: 500 }).projects;
  const mine = list.filter((p) => p.nextStep?.who === "me" && p.nextStep.urgency !== "done");
  assert.ok(mine.length > 0, "the fixture leaves jobs on the team");
  const digest = await sa.buildStaffDigest(db, "org-default", new Date(2026, 10, 3, 7));
  assert.equal(digest.count, mine.length);
  assert.match(digest.subject, new RegExp(`${mine.length} jobs? needs? you today \\(2026-11-03\\)`));
  for (const p of mine) assert.ok(digest.body.includes(`/#/project/${p.id}`), `no link for ${p.id}`);
  const rank: Record<string, number> = { overdue: 0, today: 1, waiting: 2 };
  const order = [...digest.body.matchAll(/#\/project\/([^\s]+)/g)].map((m) => rank[mine.find((p) => p.id === m[1])!.nextStep!.urgency]);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "most urgent first");
  const others = list.filter((p) => !mine.includes(p));
  for (const p of others) assert.ok(!digest.body.includes(`/#/project/${p.id}`), `a job not on the team is listed: ${p.id}`);
});

// ── MUST-EXCLUDE across everything sent and recorded ────────────────────────────────────────
await check("MUST-EXCLUDE: no account/meter number, homeowner name or portal URL in any row, mail or webhook", () => {
  const everything = [
    ...rows().flatMap((r) => [r.subject, r.body, r.recipient, r.delivery_detail]),
    ...mails.map((m) => m.data),
    ...hooks.map((h) => `${h.title}\n${h.body}`),
  ].join("\n");
  assert.ok(rows().length >= 10, "the suite sent things to inspect");
  for (const bad of [ACCOUNT, METER, "permits.portland.example", ...ownerNames]) {
    assert.ok(!everything.includes(bad), `"${bad}" leaked into a staff alert`);
  }
  assert.doesNotMatch(everything, /1234.?567.?890|987.?654.?321/);
});

smtp.close();
hook.close();
finish("staff alerts + morning digest (#487)");
