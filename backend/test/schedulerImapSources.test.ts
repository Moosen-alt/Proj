// THE SCHEDULER AND DATABASE IMAP INBOXES (#514). Two gaps, reachable once #513 made extra
// IMAP inboxes saveable through POST /api/imap/sources:
//   1. the scheduler's mbox loop selected EVERY active email_tracking_sources row, IMAP rows
//      included, and ran each through runEmailTracker as a local mbox path. `imap:<id>` is no
//      file, so every tick wrote "Email watch path was not found" onto the IMAP row's
//      last_error (runEmailTracker's own no-sourceId loop had the same shape);
//   2. the scheduled IMAP poll was gated on imapStatus().configured, which reads only the
//      EMAIL_IMAP_* env, so an install whose inboxes live only in the database never had them
//      polled except by a manual POST /api/imap/poll.
// This pins: the mbox loops read only non-IMAP rows and leave an IMAP row's last_error alone,
// and the poll gate opens for an active DB inbox with no env inbox (and stays shut with none).
// Synthetic hosts and credentials only; no mailbox is ever contacted. Browser-free.
// Run: tsx backend/test/schedulerImapSources.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-imap-sources-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";
process.env.SESSION_ENCRYPTION_KEY = "scheduler-imap-sources-test-key-0123456789";
// No env inbox: the case the issue is about.
for (const key of ["EMAIL_IMAP_HOST", "EMAIL_IMAP_USER", "EMAIL_IMAP_PASS"]) delete process.env[key];

const { openDatabase } = await import("../src/db");
const { upsertImapSource, imapStatus, imapPollDue } = await import("../src/emailPoller");
const { configureEmailTrackingSource, mboxTrackerSourceIds, runEmailTracker } = await import("../src/repository");

const db = await openDatabase();

let failures = 0;
const run = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};
const lastError = (id: string) =>
  db.get<{ last_error: string }>("SELECT last_error FROM email_tracking_sources WHERE id = ?", [id])?.last_error;

console.log("[1] with no inbox anywhere, the scheduled IMAP poll stays shut");
run("the env inbox is not configured", imapStatus().configured === false);
run("imapPollDue is false with no env inbox and no DB source", imapPollDue(db) === false);

console.log("\n[2] one DB IMAP inbox and one mbox source");
const imapId = upsertImapSource(db, { label: "Extra inbox", host: "imap.extra.invalid", user: "permits@extra.invalid", password: "synthetic-pw" });
const mboxPath = path.join(tmpDir, "missing.mbox"); // never created: the mbox run errors on its OWN row
configureEmailTrackingSource(db, { filePath: mboxPath, label: "Watched mbox" });
const mboxId = db.get<{ id: string }>("SELECT id FROM email_tracking_sources WHERE source_type = 'mbox_path'")?.id ?? "";
run("both rows exist", !!imapId && !!mboxId);
run("the IMAP row starts with no last_error", lastError(imapId) === "", JSON.stringify(lastError(imapId)));

console.log("\n[3] the mbox loops read only mbox rows");
const ids = mboxTrackerSourceIds(db);
run("mboxTrackerSourceIds lists the mbox row", ids.includes(mboxId), JSON.stringify(ids));
run("mboxTrackerSourceIds leaves the IMAP row out", !ids.includes(imapId), JSON.stringify(ids));

const byId = await runEmailTracker(db, { sourceId: imapId });
run("runEmailTracker({ sourceId: <imap row> }) checks no source", byId.sourcesChecked === 0 && byId.sourceErrors.length === 0, JSON.stringify({ checked: byId.sourcesChecked, errors: byId.sourceErrors }));
run("…and leaves the IMAP row's last_error alone", lastError(imapId) === "", JSON.stringify(lastError(imapId)));

const all = await runEmailTracker(db);
run("runEmailTracker() with no source checks only the mbox row", all.sourcesChecked === 1, String(all.sourcesChecked));
run("the IMAP row's last_error is still empty after the all-sources run", lastError(imapId) === "", JSON.stringify(lastError(imapId)));
run("the mbox row still reports its own missing file", /not found/i.test(lastError(mboxId) ?? ""), JSON.stringify(lastError(mboxId)));

// What the scheduler's loop body does, row by row.
for (const id of mboxTrackerSourceIds(db)) await runEmailTracker(db, { sourceId: id });
run("the scheduler's per-source loop leaves the IMAP row's last_error alone", lastError(imapId) === "", JSON.stringify(lastError(imapId)));

console.log("\n[4] the poll gate opens for a DB inbox with no env inbox");
run("the env inbox is still not configured", imapStatus().configured === false);
run("imapPollDue is true with one active DB IMAP source", imapPollDue(db) === true);
upsertImapSource(db, { id: imapId, label: "Extra inbox", host: "imap.extra.invalid", user: "permits@extra.invalid", active: false });
run("imapPollDue is false again once that source is switched off", imapPollDue(db) === false);

console.log("\n[5] the scheduler uses these two answers, not its own queries");
const schedulerSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/scheduler.ts"), "utf8");
run("scheduler.ts reads mbox ids through mboxTrackerSourceIds", schedulerSrc.includes("mboxTrackerSourceIds(db)"));
run("scheduler.ts gates the IMAP poll on imapPollDue", schedulerSrc.includes("imapPollDue(db)"));
run("scheduler.ts no longer gates on the env-only imapStatus()", !schedulerSrc.includes("imapStatus("));
run("scheduler.ts has no query of its own on email_tracking_sources", !/FROM\s+email_tracking_sources/.test(schedulerSrc));

console.log(failures === 0 ? "\nschedulerImapSources: all checks passed" : `\nschedulerImapSources: ${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
