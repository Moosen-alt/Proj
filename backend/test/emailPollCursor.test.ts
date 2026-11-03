// READ EVERY MESSAGE IN A BURST (#539). The inbox poll read only the newest EMAIL_IMAP_MAX_MESSAGES
// (100) of the whole mailbox each tick, with no memory of what it had read, and Gmail one capped
// page: more than 100 messages between two ticks and the oldest were never read (an emailed job or
// an AHJ correction, silently lost). Intake also ran inline, one model read per message, holding
// the monitor tick.
//
//   MUST PASS — 250 new messages are all read across two ticks (125 a tick, fetched in pages),
//               none twice, and a third tick reads nothing; a tick that fails mid-fetch leaves the
//               cursor where it was and the next tick reads those messages; a renumbered mailbox
//               (UIDVALIDITY) starts over at the newest page; intake mail goes to one email_intake
//               job per message, naming its UID (no raw message at rest), under the source's own org, and that job
//               files each message once; Gmail pages its list, reads oldest first, carries what
//               a tick's bound leaves over, and reads none twice.
//   MUST NOT  — the tracker's MBOX gets intake mail; a job for a source switched off reads it.
//
// Synthetic data only: example.test domains, a fake inbox and a fake Gmail API. No network.
//   npx tsx backend/test/emailPollCursor.test.ts
import "./_isolate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "email-poll-cursor-"));
process.env.AUTOPILOT_DB_PATH = path.join(scratch, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";
process.env.SESSION_ENCRYPTION_KEY = "email-poll-cursor-test-key-0123456789abcdef";
process.env.EMAIL_INTAKE_ADDRESS = "intake@keelix.example.test";
for (const key of ["EMAIL_IMAP_HOST", "EMAIL_IMAP_USER", "EMAIL_IMAP_PASS", "SMTP_HOST", "SMTP_FROM", "ANTHROPIC_API_KEY"]) delete process.env[key];

const { openDatabase } = await import("../src/db");
const { upsertImapSource, pollImap, runImapIntakeJob, setImapClientFactoryForTests } = await import("../src/emailPoller");
const { pollGmail, setGmailFetchForTests } = await import("../src/gmail");

const db = await openDatabase();

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

// ---------------------------------------------------------------------------
// A fake IMAP inbox: UIDs ascending, UIDVALIDITY, and a count of every full fetch per UID.
// ---------------------------------------------------------------------------
let n = 0;
function statusMail(i: number): Buffer {
  return Buffer.from([
    `From: permits@city.example.test`,
    `To: permits@keelix.example.test`,
    `Subject: Synthetic notice ${i}`,
    `Message-ID: <notice-${i}@city.example.test>`,
    `Date: Mon, 02 Nov 2026 10:00:00 +0000`,
    ``,
    `Synthetic status notice number ${i}. Nothing here names a project.`,
    ``,
  ].join("\r\n"));
}
function intakeMail(i: number): Buffer {
  return Buffer.from([
    `From: pm@unknown.example.test`,
    `To: intake+nobody@keelix.example.test`,
    `Subject: New job ${i}`,
    `Message-ID: <job-${i}@unknown.example.test>`,
    `Date: Mon, 02 Nov 2026 10:00:00 +0000`,
    ``,
    `Synthetic job ${i}.`,
    ``,
  ].join("\r\n"));
}

class FakeInbox {
  uidValidity = 7001n;
  messages: { uid: number; source: Buffer }[] = [];
  nextUid = 1;
  fetchCount = new Map<number, number>();
  /** Throw after this many messages of the next fetch (a dropped connection). */
  failAfter: number | null = null;
  add(source: Buffer): number { const uid = this.nextUid++; this.messages.push({ uid, source }); return uid; }
  renumber(): void { this.uidValidity += 1n; this.messages = this.messages.map((m, i) => ({ ...m, uid: i + 1 })); this.nextUid = this.messages.length + 1; }
}
const inbox = new FakeInbox();

setImapClientFactoryForTests(async () => {
  let open = false;
  return {
    async connect() {},
    async getMailboxLock() { open = true; return { release() { open = false; } }; },
    get mailbox() { return open ? { exists: inbox.messages.length, uidValidity: inbox.uidValidity, uidNext: inbox.nextUid } : false; },
    async search(query: Record<string, unknown>) {
      const uids = inbox.messages.map((m) => m.uid);
      if (typeof query.uid === "string") {
        const from = Number(query.uid.split(":")[0]);
        const hits = uids.filter((u) => u >= from);
        // RFC 3501: `N:*` always includes the highest UID, even below N.
        return hits.length ? hits : uids.slice(-1);
      }
      if (typeof query.seq === "string") {
        const from = Number(query.seq.split(":")[0]);
        return uids.slice(from - 1);
      }
      return false;
    },
    async *fetch(range: number[]) {
      const want = new Set(range);
      let served = 0;
      for (const m of inbox.messages) {
        if (!want.has(m.uid)) continue;
        if (inbox.failAfter !== null && served >= inbox.failAfter) { inbox.failAfter = null; throw new Error("synthetic connection drop"); }
        inbox.fetchCount.set(m.uid, (inbox.fetchCount.get(m.uid) ?? 0) + 1);
        served++;
        yield { uid: m.uid, source: m.source };
      }
    },
    async logout() {},
  };
});

const ORG_B = "org-poll-b";
db.run("INSERT INTO orgs (id, name, edition, created_at) VALUES (?, ?, 'full', ?)", [ORG_B, ORG_B, new Date().toISOString()]);
const sourceId = upsertImapSource(db, { label: "Synthetic inbox", host: "imap.example.test", user: "permits@keelix.example.test", password: "synthetic-pw", maxMessages: 125, orgId: ORG_B });
const cursor = () => db.get<{ uid_validity: string; last_uid: number }>("SELECT uid_validity, last_uid FROM email_poll_cursors WHERE source_key = ?", [`imap:${sourceId}`]);
const timesFetched = () => [...inbox.fetchCount.values()];

console.log("[1] first sight of an empty box starts the cursor at 0");
let r = await pollImap(db);
check("nothing read", r.fetched === 0 && r.errors.length === 0, JSON.stringify(r));
check("cursor at 0 under the box's UIDVALIDITY", cursor()?.last_uid === 0 && cursor()?.uid_validity === "7001", JSON.stringify(cursor()));

console.log("\n[2] a burst of 250 between ticks is read across two ticks, none twice");
for (let i = 0; i < 250; i++) inbox.add(statusMail(++n));
r = await pollImap(db);
check("tick 1 reads its bound (125)", r.fetched === 125, JSON.stringify(r));
check("tick 1 carries the other 125", r.carried === 125, String(r.carried));
check("cursor at UID 125", cursor()?.last_uid === 125, JSON.stringify(cursor()));
r = await pollImap(db);
check("tick 2 reads the remaining 125", r.fetched === 125 && r.carried === 0, JSON.stringify(r));
check("all 250 fetched", inbox.fetchCount.size === 250, String(inbox.fetchCount.size));
check("none fetched twice", timesFetched().every((c) => c === 1), JSON.stringify(timesFetched().filter((c) => c !== 1).length));
r = await pollImap(db);
check("tick 3 reads nothing (the `N:*` highest-UID echo is filtered)", r.fetched === 0, JSON.stringify(r));
check("…and the highest message is still fetched only once", inbox.fetchCount.get(250) === 1, String(inbox.fetchCount.get(250)));

console.log("\n[3] a tick that fails mid-fetch keeps the cursor; the next tick reads those messages");
for (let i = 0; i < 30; i++) inbox.add(statusMail(++n));
inbox.failAfter = 10;
r = await pollImap(db);
check("the failing tick reports the error", r.errors.some((e) => /connection drop/.test(e)), JSON.stringify(r.errors));
check("cursor did not move", cursor()?.last_uid === 250, JSON.stringify(cursor()));
r = await pollImap(db);
check("the next tick reads all 30", r.fetched === 30 && r.errors.length === 0, JSON.stringify(r));
check("cursor at UID 280", cursor()?.last_uid === 280, JSON.stringify(cursor()));
check("every one of the 30 was read (the 10 re-read after the drop, none lost)", [...Array(30).keys()].every((k) => (inbox.fetchCount.get(251 + k) ?? 0) >= 1));

console.log("\n[4] a renumbered mailbox (UIDVALIDITY changed) starts over at the newest page");
inbox.renumber();
inbox.fetchCount.clear();
r = await pollImap(db);
check("reads the newest 125, as the poll did before the cursor", r.fetched === 125, JSON.stringify(r));
check("cursor re-based on the new UIDVALIDITY", cursor()?.uid_validity === "7002" && cursor()?.last_uid === 280, JSON.stringify(cursor()));

console.log("\n[5] intake mail goes to queued jobs, one per message, under the source's org, naming UIDs only");
const intakeUids = [inbox.add(intakeMail(1)), inbox.add(statusMail(++n)), inbox.add(intakeMail(2)), inbox.add(intakeMail(3))];
inbox.fetchCount.clear();
r = await pollImap(db);
check("one status message went to the tracker", r.fetched === 1, JSON.stringify(r));
check("three intake messages were queued", r.intakeQueued === 3, JSON.stringify(r));
const jobs = db.query<{ id: string; payload: string; org_id: string }>("SELECT id, payload, org_id FROM job_queue WHERE job_type = 'email_intake' ORDER BY created_at, rowid");
check("one email_intake job per intake message", jobs.length === 3, String(jobs.length));
const payloads = jobs.map((j) => JSON.parse(j.payload) as Record<string, unknown>);
const queuedUids = payloads.flatMap((p) => (p.uids as number[]) ?? []).sort((a, b) => a - b);
check("the jobs name the intake UIDs, one each", JSON.stringify(queuedUids) === JSON.stringify([intakeUids[0], intakeUids[2], intakeUids[3]]) && payloads.every((p) => (p.uids as number[]).length === 1), JSON.stringify(payloads.map((p) => p.uids)));
check("no job carries a raw message", jobs.every((j) => !/Synthetic job|intake\+nobody/.test(j.payload)), jobs.map((j) => j.payload).join(" "));
check("every job is the source's org (rule 6)", jobs.every((j) => j.org_id === ORG_B), JSON.stringify(jobs.map((j) => j.org_id)));

// The enqueue kicks the worker; wait for it, then run a job by hand as well: the second run must
// find its message already filed.
const jobStates = () => jobs.map((j) => db.get<{ status: string; error: string | null }>("SELECT status, error FROM job_queue WHERE id = ?", [j.id]));
for (let i = 0; i < 200; i++) {
  if (jobStates().every((st) => st?.status === "done" || st?.status === "failed")) break;
  await new Promise((res) => setTimeout(res, 50));
}
check("the worker ran every job", jobStates().every((st) => st?.status === "done"), JSON.stringify(jobStates()));
const filed = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM email_intake_messages")?.c;
check("three intake rows recorded (unknown tag: unsorted for a person)", filed === 3, String(filed));
const intakeOrgs = db.query<{ org_id: string }>("SELECT DISTINCT org_id FROM email_intake_messages").map((x) => x.org_id);
check("…in the source's org", JSON.stringify(intakeOrgs) === JSON.stringify([ORG_B]), JSON.stringify(intakeOrgs));
const payload = payloads[0];
const again = await runImapIntakeJob(db, payload);
check("re-running a job files nothing twice", again.skippedDuplicates === 1 && again.unsorted === 0, JSON.stringify(again));

upsertImapSource(db, { id: sourceId, label: "Synthetic inbox", host: "imap.example.test", user: "permits@keelix.example.test", active: false });
let refused = "";
try { await runImapIntakeJob(db, payload); } catch (err) { refused = err instanceof Error ? err.message : String(err); }
check("a job for a source switched off since does not read it", /no longer configured/.test(refused), refused);
upsertImapSource(db, { id: sourceId, label: "Synthetic inbox", host: "imap.example.test", user: "permits@keelix.example.test", active: true });

console.log("\n[6] Gmail pages the list, reads oldest first, carries the remainder, reads none twice");
process.env.GMAIL_CLIENT_ID = "synthetic-client";
process.env.GMAIL_CLIENT_SECRET = "synthetic-secret";
process.env.GMAIL_REFRESH_TOKEN = "synthetic-refresh";
process.env.GMAIL_MAX_MESSAGES_PER_TICK = "500";
const gmailIds = Array.from({ length: 1200 }, (_, i) => `g${String(i + 1).padStart(5, "0")}`); // g00001 oldest
const gmailFetches = new Map<string, number>();
const listQueries: string[] = [];
let readOrder: string[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
setGmailFetchForTests(async (url) => {
  if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "synthetic-access" });
  const u = new URL(url);
  if (u.pathname.endsWith("/messages")) {
    listQueries.push(u.searchParams.get("q") ?? "");
    const newestFirst = [...gmailIds].reverse();
    const start = Number(u.searchParams.get("pageToken") || 0);
    const size = Number(u.searchParams.get("maxResults") || 100);
    const page = newestFirst.slice(start, start + size);
    return json({ messages: page.map((id) => ({ id })), ...(start + size < newestFirst.length ? { nextPageToken: String(start + size) } : {}) });
  }
  const id = decodeURIComponent(u.pathname.split("/").pop() ?? "");
  gmailFetches.set(id, (gmailFetches.get(id) ?? 0) + 1);
  readOrder.push(id);
  const raw = statusMail(10_000 + gmailIds.indexOf(id)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  return json({ raw });
});
const anchor = () => db.get<{ last_uid: number }>("SELECT last_uid FROM email_poll_cursors WHERE source_key = 'gmail:env'")?.last_uid ?? 0;

let g = await pollGmail(db, undefined, { scheduled: true });
check("Gmail tick 1 reads the bound (500)", g.fetched === 500 && g.carried === 700, JSON.stringify({ fetched: g.fetched, carried: g.carried }));
check("…oldest first", readOrder[0] === "g00001" && readOrder[499] === "g00500", `${readOrder[0]} ${readOrder[499]}`);
check("…its first window is newer_than:1d", listQueries[0] === "newer_than:1d", listQueries[0]);
check("…the list was paged (3 pages of 500)", listQueries.length === 3, String(listQueries.length));
check("…the window does not move while a remainder waits", anchor() === 0, String(anchor()));
readOrder = [];
g = await pollGmail(db, undefined, { scheduled: true });
check("Gmail tick 2 reads the next 500", g.fetched === 500 && g.carried === 200 && readOrder[0] === "g00501", JSON.stringify({ fetched: g.fetched, carried: g.carried, first: readOrder[0] }));
g = await pollGmail(db, undefined, { scheduled: true });
check("Gmail tick 3 reads the last 200 and catches up", g.fetched === 200 && g.carried === 0, JSON.stringify({ fetched: g.fetched, carried: g.carried }));
check("…and the window moves up", anchor() > 0, String(anchor()));
g = await pollGmail(db, undefined, { scheduled: true });
check("Gmail tick 4 reads nothing", g.fetched === 0, String(g.fetched));
check("…asking only after the caught-up tick (less the overlap)", /^after:\d+$/.test(listQueries[listQueries.length - 1]), listQueries[listQueries.length - 1]);
check("all 1200 Gmail messages read", gmailFetches.size === 1200, String(gmailFetches.size));
check("none read twice", [...gmailFetches.values()].every((c) => c === 1));

setImapClientFactoryForTests(null);
setGmailFetchForTests(null);
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
