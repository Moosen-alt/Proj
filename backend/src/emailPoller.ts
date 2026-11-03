import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { unlink, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppDb } from "./db";
import { DEFAULT_ORG_ID } from "./db";
import { logger } from "./logger";
import { runEmailTracker } from "./repository";
import { encryptStorageState, decryptStorageState } from "../../portal-bot/src/cryptoStorage";
import { writeMboxMessage } from "./mbox";
import { intakeEnabled, isIntakeMessage, processIntakeMessages } from "./emailIntake";
import { enqueueJob } from "./jobQueue";

// IMAP email polling — supports two source modes:
//
//   1. Global env-var source (EMAIL_IMAP_HOST/USER/PASS) — the central TML inbox.
//      Scanned on every poll tick; no DB row required.
//
//   2. DB-driven sources (email_tracking_sources rows with source_type='imap') —
//      per-client or additional inboxes, each with independently encrypted credentials.
//      A non-empty recipient_tag filters to emails whose To:/CC: contain the tag,
//      letting one shared inbox serve many clients (permits+acme@tml.com → acme).
//
// The forwarding pattern (clients set a 2-min Outlook/Gmail rule → central TML inbox)
// means most setups need only the global env source. Per-client DB rows are for
// clients whose AHJ emails go to a dedicated address we poll directly.
//
// SECURITY:
//   - Global credentials from env only; per-source credentials stored only as
//     AES-256-GCM encrypted blobs (keyed by SESSION_ENCRYPTION_KEY). Never plaintext.
//   - Raw email bodies are never stored or logged — only parsed/classified output.
//   - The MBOX temp file is deleted immediately after the tracker run.

interface ImapSourceConfig {
  sourceId?: string; // DB row id; undefined for the env-based source
  orgId?: string;    // tenant this source belongs to; SCOPES project matching
  clientId?: string; // DB client_id for this source; further constrains matching
  label: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  mailbox: string;
  maxMessages: number;
  recipientTag: string; // empty = accept all; non-empty = filter To:/CC: lines
}

// ---------------------------------------------------------------------------
// Env-based global IMAP config (central TML inbox)
// ---------------------------------------------------------------------------

function envImapConfig(): ImapSourceConfig | null {
  const host = process.env.EMAIL_IMAP_HOST;
  const user = process.env.EMAIL_IMAP_USER;
  const pass = process.env.EMAIL_IMAP_PASS;
  if (!host || !user || !pass) return null;
  return {
    label: "central (env)",
    host,
    port: Number(process.env.EMAIL_IMAP_PORT ?? 993),
    secure: process.env.EMAIL_IMAP_TLS !== "false",
    user,
    pass,
    mailbox: process.env.EMAIL_IMAP_MAILBOX || "INBOX",
    maxMessages: Number(process.env.EMAIL_IMAP_MAX_MESSAGES ?? 100),
    recipientTag: "",
  };
}

export function imapStatus(): { configured: boolean; host: string | null; mailbox: string } {
  const cfg = envImapConfig();
  return { configured: cfg !== null, host: cfg?.host ?? null, mailbox: cfg?.mailbox ?? "INBOX" };
}

/** Whether the scheduler has any IMAP inbox to poll (#514): the env inbox OR an active DB
 *  source — the same two lists `pollImap` reads. Gating the scheduled poll on
 *  `imapStatus().configured` (env only) meant an install that keeps its inboxes only in the
 *  database (POST /api/imap/sources) was never polled except by a manual POST /api/imap/poll. */
export function imapPollDue(db: AppDb): boolean {
  return envImapConfig() !== null || dbImapSources(db).length > 0;
}

// ---------------------------------------------------------------------------
// DB-driven IMAP sources
// ---------------------------------------------------------------------------

interface ImapSourceRow {
  id: string;
  label: string;
  imap_host: string;
  imap_port: number;
  imap_secure: number;
  imap_user: string;
  imap_pass_encrypted: string;
  imap_mailbox: string;
  imap_max_messages: number;
  recipient_tag: string;
  client_id: string | null;
  org_id: string | null;
}

function dbImapSources(db: AppDb): ImapSourceConfig[] {
  const rows = db.query<ImapSourceRow>(
    `SELECT id, label, imap_host, imap_port, imap_secure, imap_user,
            imap_pass_encrypted, imap_mailbox, imap_max_messages, recipient_tag, client_id, org_id
     FROM email_tracking_sources
     WHERE source_type = 'imap' AND active = 1 AND imap_host != ''
     ORDER BY created_at`,
  );

  return rows.flatMap((row) => {
    if (!row.imap_pass_encrypted) return [];
    let pass: string;
    try {
      const dec = decryptStorageState(row.imap_pass_encrypted) as { password?: string };
      pass = dec.password ?? "";
    } catch {
      logger.warn("imap", `Failed to decrypt credentials for source ${row.id} (${row.label}) — skipping`);
      return [];
    }
    if (!pass) return [];
    return [
      {
        sourceId: row.id,
        orgId: row.org_id || DEFAULT_ORG_ID,
        clientId: row.client_id ?? undefined,
        label: row.label || row.id,
        host: row.imap_host,
        port: row.imap_port || 993,
        secure: row.imap_secure !== 0,
        user: row.imap_user,
        pass,
        mailbox: row.imap_mailbox || "INBOX",
        maxMessages: row.imap_max_messages || 100,
        recipientTag: row.recipient_tag || "",
      } satisfies ImapSourceConfig,
    ];
  });
}

// ---------------------------------------------------------------------------
// Credential management for DB sources
// ---------------------------------------------------------------------------

/** The `file_path` an IMAP row stores. The column is `NOT NULL UNIQUE` (it is the mbox
 *  watch path for mbox rows), so every IMAP row writing `''` meant the second inbox failed
 *  with a UNIQUE constraint error (#498). `imap:<id>` is unique per row and can never equal
 *  an mbox path, which `configureEmailTrackingSource` always stores resolved to absolute. */
export function imapSourceFilePath(id: string): string {
  return `imap:${id}`;
}

/** Upsert an IMAP source row. Pass password only when setting or rotating credentials. */
export function upsertImapSource(
  db: AppDb,
  opts: {
    id?: string;
    label: string;
    host: string;
    port?: number;
    secure?: boolean;
    user: string;
    password?: string;
    mailbox?: string;
    maxMessages?: number;
    recipientTag?: string;
    clientId?: string;
    /** Owning tenant. Set on create; never changed by an update — a source does not
     *  move between orgs, and its org is what scopes every project match it makes. */
    orgId?: string;
    active?: boolean;
  },
): string {
  // randomUUID is a top-level import: the package is ESM, where `require` is not defined,
  // so the old inline require() threw before anything was written (#498).
  const now = new Date().toISOString();
  const id = opts.id ?? randomUUID();
  const existing = db.get<{ imap_pass_encrypted?: string }>(
    "SELECT imap_pass_encrypted FROM email_tracking_sources WHERE id = ?",
    [id],
  );

  const encPass = opts.password
    ? encryptStorageState({ password: opts.password })
    : existing?.imap_pass_encrypted ?? "";

  if (existing) {
    db.run(
      `UPDATE email_tracking_sources SET
         label = ?, imap_host = ?, imap_port = ?, imap_secure = ?, imap_user = ?,
         imap_pass_encrypted = ?, imap_mailbox = ?, imap_max_messages = ?,
         recipient_tag = ?, client_id = ?, active = ?, updated_at = ?
       WHERE id = ?`,
      [
        opts.label,
        opts.host,
        opts.port ?? 993,
        opts.secure !== false ? 1 : 0,
        opts.user,
        encPass,
        opts.mailbox ?? "INBOX",
        opts.maxMessages ?? 100,
        opts.recipientTag ?? "",
        opts.clientId ?? null,
        opts.active !== false ? 1 : 0,
        now,
        id,
      ],
    );
  } else {
    db.run(
      `INSERT INTO email_tracking_sources
         (id, source_type, label, file_path, imap_host, imap_port, imap_secure, imap_user,
          imap_pass_encrypted, imap_mailbox, imap_max_messages, recipient_tag, client_id,
          org_id, active, created_at, updated_at)
       VALUES (?, 'imap', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        opts.label,
        imapSourceFilePath(id),
        opts.host,
        opts.port ?? 993,
        opts.secure !== false ? 1 : 0,
        opts.user,
        encPass,
        opts.mailbox ?? "INBOX",
        opts.maxMessages ?? 100,
        opts.recipientTag ?? "",
        opts.clientId ?? null,
        opts.orgId || DEFAULT_ORG_ID,
        opts.active !== false ? 1 : 0,
        now,
        now,
      ],
    );
  }
  return id;
}

// ---------------------------------------------------------------------------
// The read cursor (#539)
// ---------------------------------------------------------------------------
//
// EVERY MESSAGE, ONCE. The poll used to read the newest `maxMessages` of the WHOLE mailbox each
// tick, with no memory of what it had read: a burst of more than that between two ticks left the
// oldest of it unread forever (an emailed job or an AHJ correction, silently lost). Now each inbox
// keeps the highest UID it has handed on, under the mailbox's UIDVALIDITY, and a tick reads
// everything above it, oldest first, at most `maxMessages` (EMAIL_IMAP_MAX_MESSAGES, still "per
// tick") in fetches of IMAP_FETCH_PAGE. What is left over is still above the cursor, so the next
// tick reads it: carried, never dropped.
//
// THE CURSOR MOVES ONLY AFTER THE HAND-OFF. It is written once the tracker has run the batch
// without a source error and the batch's intake mail is on the job queue. A tick that fails reads
// the same messages again next time (the tracker skips a message it already matched by its
// signature, and intake skips one by its Message-ID), so a failure repeats work, never loses it.
//
// FIRST SIGHT, OR A RENUMBERED MAILBOX. With no cursor, or a UIDVALIDITY that changed (the server
// renumbered every UID), a tick reads the newest page, as the poll always did, and the cursor
// starts there. Older mail in the box was never read before this cursor existed either.
//
// RULE 6. The cursor carries no org. A source's org is read from its own row every time, by the
// poll and by the intake job, never from the cursor or the job payload.

/** The cursor row for one inbox. The env inbox has no DB row: its key is a hash of what names
 *  it, so pointing EMAIL_IMAP_* at another inbox starts a fresh cursor. */
function cursorKey(cfg: ImapSourceConfig): string {
  if (cfg.sourceId) return `imap:${cfg.sourceId}`;
  const name = `${cfg.host.toLowerCase()}|${cfg.port}|${cfg.user.toLowerCase()}|${cfg.mailbox}`;
  return `imap-env:${createHash("sha256").update(name).digest("hex").slice(0, 32)}`;
}

interface ImapCursor { uidValidity: string; lastUid: number }

function readCursor(db: AppDb, key: string): ImapCursor | null {
  const row = db.get<{ uid_validity: string; last_uid: number }>(
    "SELECT uid_validity, last_uid FROM email_poll_cursors WHERE source_key = ?",
    [key],
  );
  return row ? { uidValidity: String(row.uid_validity), lastUid: Number(row.last_uid) || 0 } : null;
}

function writeCursor(db: AppDb, key: string, cursor: ImapCursor): void {
  db.run(
    `INSERT INTO email_poll_cursors (source_key, uid_validity, last_uid, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(source_key) DO UPDATE SET uid_validity = excluded.uid_validity, last_uid = excluded.last_uid, updated_at = excluded.updated_at`,
    [key, cursor.uidValidity, cursor.lastUid, new Date().toISOString()],
  );
}

/** UIDs per FETCH command inside one tick: keeps one command's response small. */
const IMAP_FETCH_PAGE = 50;

// ---------------------------------------------------------------------------
// The IMAP client (a narrow slice of imapflow, so a test can stand a fake inbox in for it)
// ---------------------------------------------------------------------------

export interface ImapClientLike {
  connect(): Promise<unknown>;
  getMailboxLock(mailbox: string): Promise<{ release(): void }>;
  /** imapflow's MailboxObject while a mailbox is open (`exists`, `uidValidity`), else false. */
  readonly mailbox: unknown;
  search(query: Record<string, unknown>, options: { uid: true }): Promise<number[] | false>;
  fetch(range: number[], query: Record<string, unknown>, options: { uid: true }): AsyncIterable<{ uid: number; source?: Buffer }>;
  logout(): Promise<unknown>;
}

type ImapClientFactory = (cfg: ImapSourceConfig) => Promise<ImapClientLike>;

const defaultImapClient: ImapClientFactory = async (cfg) => {
  const { ImapFlow } = await import("imapflow");
  return new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    disableAutoIdle: true,
  }) as unknown as ImapClientLike;
};

let imapClientFactory: ImapClientFactory = defaultImapClient;

/** Test door: a fake inbox in place of a real IMAP connection. null restores imapflow. */
export function setImapClientFactoryForTests(factory: ImapClientFactory | null): void {
  imapClientFactory = factory ?? defaultImapClient;
}

function mailboxState(client: ImapClientLike): { exists: number; uidValidity: string } {
  const mb = client.mailbox as { exists?: number; uidValidity?: bigint | number | string } | false | null;
  if (!mb || typeof mb !== "object") return { exists: 0, uidValidity: "" };
  return { exists: Number(mb.exists ?? 0) || 0, uidValidity: mb.uidValidity == null ? "" : String(mb.uidValidity) };
}

// ---------------------------------------------------------------------------
// Core fetch → MBOX → tracker pipeline
// ---------------------------------------------------------------------------

interface ImapBatch {
  filePath: string;
  /** Messages written to the tracker's MBOX. */
  count: number;
  /** UIDs of intake mail, for the email_intake job to fetch and file. */
  intakeUids: number[];
  /** The cursor to write once this batch is handed on; null when the mailbox had nothing. */
  next: ImapCursor | null;
  /** New messages above the cursor that this tick's bound left for the next tick. */
  carried: number;
}

async function fetchImapToMbox(cfg: ImapSourceConfig, cursor: ImapCursor | null): Promise<ImapBatch> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "solar-imap-"));
  const mboxPath = path.join(tmpDir, "inbox.mbox");
  const out = createWriteStream(mboxPath, { encoding: "utf8" });
  const batch: ImapBatch = { filePath: mboxPath, count: 0, intakeUids: [], next: null, carried: 0 };
  // EMAIL-IN INTAKE (#489): mail to the intake address is a new job, never a status email — it is
  // handed to emailIntake.ts and never written to the tracker's MBOX. A per-client source with a
  // recipient tag leaves it alone: on a shared inbox every such source sees it, and the first one
  // would file it under its own org. The central inbox and untagged sources take it.
  const intakeOn = intakeEnabled();
  const perTick = Math.max(1, Math.floor(cfg.maxMessages) || 100);

  const client = await imapClientFactory(cfg);

  try {
    await client.connect();
    const lock = await client.getMailboxLock(cfg.mailbox);
    try {
      const { exists, uidValidity } = mailboxState(client);
      // The UID to read above, or null: no cursor yet, or the server renumbered the mailbox.
      const resumeFrom = cursor && cursor.uidValidity === uidValidity ? cursor.lastUid : null;
      const resume = resumeFrom !== null;
      if (exists === 0) {
        // An empty box: nothing to read, but a renumbered or first-seen one starts its cursor at 0.
        if (!resume) batch.next = { uidValidity, lastUid: 0 };
        return batch;
      }
      // Ask by UID, not by sequence number: a sequence number shifts when mail is deleted, a UID
      // never does. `N:*` always includes the highest UID even when it is below N (RFC 3501), so
      // the list is filtered to what is really above the cursor.
      const floor = resumeFrom ?? 0;
      const found = resumeFrom !== null
        ? await client.search({ uid: `${resumeFrom + 1}:*` }, { uid: true })
        : await client.search({ seq: `${Math.max(1, exists - perTick + 1)}:*` }, { uid: true });
      const uids = [...new Set(found || [])].filter((u) => Number.isInteger(u) && u > floor).sort((a, b) => a - b);
      const take = uids.slice(0, perTick);
      batch.carried = uids.length - take.length;
      if (take.length === 0) {
        if (!resume) batch.next = { uidValidity, lastUid: 0 };
        return batch;
      }

      const { simpleParser } = await import("mailparser");
      for (let i = 0; i < take.length; i += IMAP_FETCH_PAGE) {
        const page = take.slice(i, i + IMAP_FETCH_PAGE);
        for await (const msg of client.fetch(page, { uid: true, source: true, envelope: true }, { uid: true })) {
          if (!msg.source) continue;

          // Parse full MIME structure in-memory — properly handles folded headers,
          // encoded words (=?UTF-8?...), and multipart bodies that raw string scanning misses.
          let parsed: Awaited<ReturnType<typeof simpleParser>> | null = null;
          try {
            parsed = await simpleParser(msg.source);
          } catch {
            // Fall back to raw source if mailparser can't handle this message.
          }

          if (intakeOn && parsed && isIntakeMessage(parsed)) {
            if (!cfg.recipientTag) batch.intakeUids.push(msg.uid);
            continue;
          }

          // Recipient tag filtering using parsed addresses (handles encoded display names).
          if (cfg.recipientTag) {
            const recipientAddrs = [
              ...(parsed?.to ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]) : []),
              ...(parsed?.cc ? (Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc]) : []),
            ].flatMap((a) => ("value" in a ? a.value : [])).map((a) => `${a.name ?? ""} ${a.address ?? ""}`).join(" ").toLowerCase();

            if (recipientAddrs && !recipientAddrs.includes(cfg.recipientTag.toLowerCase())) continue;
            // Fallback to raw header scan if mailparser gave no addresses.
            if (!recipientAddrs) {
              const raw = msg.source.toString("utf8");
              const headerEnd = raw.indexOf("\r\n\r\n");
              const headers = headerEnd >= 0 ? raw.slice(0, headerEnd) : raw.slice(0, 4096);
              const toBlock = headers.split("\r\n").filter((l) => /^(To|CC|Delivered-To|X-Original-To):/i.test(l)).join(" ").toLowerCase();
              if (!toBlock.includes(cfg.recipientTag.toLowerCase())) continue;
            }
          }

          const raw = msg.source.toString("utf8");
          writeMboxMessage(out, raw, "imap@local");
          batch.count++;
        }
      }
      // The whole taken range, not just what came back: a UID expunged between the search and the
      // fetch is gone for good, and waiting on it would stall this inbox forever.
      batch.next = { uidValidity, lastUid: take[take.length - 1] };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => null);
    await new Promise<void>((resolve, reject) =>
      out.end((err?: Error | null) => (err ? reject(err) : resolve())),
    );
  }

  return batch;
}

type SourcePollResult = { fetched: number; matches: number; errors: string[]; carried: number; intakeQueued: number };

async function runSourcePoll(db: AppDb, cfg: ImapSourceConfig): Promise<SourcePollResult> {
  const errors: string[] = [];
  let matches = 0;
  let count = 0;
  let carried = 0;
  let intakeQueued = 0;
  let filePath: string | null = null;
  const key = cursorKey(cfg);

  try {
    const batch = await fetchImapToMbox(cfg, readCursor(db, key));
    filePath = batch.filePath;
    count = batch.count;
    carried = batch.carried;

    if (count > 0) {
      const tracked = await runEmailTracker(db, { filePath, orgId: cfg.orgId, clientId: cfg.clientId });
      matches = tracked.matches?.length ?? 0;
      // A tracker that could not read the batch has not handed it on: keep the cursor where it
      // was, so the next tick reads these messages again.
      if (tracked.sourceErrors.length) throw new Error(tracked.sourceErrors.join("; "));
    }

    // THE INTAKE IS QUEUED, NOT RUN HERE (#539). Each emailed job costs a model read; run inline it
    // held the whole monitor tick (and every permit/NEM check behind it) through a burst. The job
    // fetches these UIDs again itself, so no raw message is stored at rest, and it re-reads this
    // source's row for the org (rule 6) rather than trusting anything in its payload. One job per
    // message, so one that fails retries alone.
    if (batch.next) {
      for (const uid of batch.intakeUids) {
        enqueueJob(db, "email_intake", {
          channel: "imap",
          sourceKey: key,
          sourceId: cfg.sourceId ?? null,
          uidValidity: batch.next.uidValidity,
          uids: [uid],
        }, { orgId: cfg.orgId, priority: 4 });
        intakeQueued += 1;
      }
    }

    if (batch.next) writeCursor(db, key, batch.next);
    if (carried > 0) {
      logger.info("imap", `Source "${cfg.label}": ${carried} newer message(s) past this tick's bound; read next tick.`);
    }

    if (cfg.sourceId) {
      const now = new Date().toISOString();
      db.run(
        `UPDATE email_tracking_sources
         SET last_checked_at = ?, last_message_count = ?, last_matched_count = ?,
             last_error = '', updated_at = ?
         WHERE id = ?`,
        [now, count, matches, now, cfg.sourceId],
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(msg);
    logger.warn("imap", `Poll failed for source "${cfg.label}": ${msg}`);
    if (cfg.sourceId) {
      const now = new Date().toISOString();
      db.run(
        `UPDATE email_tracking_sources SET last_error = ?, updated_at = ? WHERE id = ?`,
        [msg, now, cfg.sourceId],
      );
    }
  } finally {
    if (filePath) {
      await unlink(filePath).catch(() => null);
      const dir = path.dirname(filePath);
      await import("node:fs/promises")
        .then(({ rm }) => rm(dir, { recursive: true, force: true }))
        .catch(() => null);
    }
  }

  return { fetched: count, matches, errors, carried, intakeQueued };
}

// ---------------------------------------------------------------------------
// The email_intake job: fetch the queued UIDs again and file them
// ---------------------------------------------------------------------------

/** The source a queued intake batch came from, re-read now: a source switched off or deleted
 *  since the poll is not read again, and its org comes from its row (rule 6). */
function intakeSourceConfig(db: AppDb, payload: Record<string, unknown>): ImapSourceConfig | null {
  const sourceId = typeof payload.sourceId === "string" && payload.sourceId ? payload.sourceId : null;
  const cfg = sourceId ? dbImapSources(db).find((s) => s.sourceId === sourceId) ?? null : envImapConfig();
  // The env inbox's key names its host/user/mailbox: a job queued before EMAIL_IMAP_* moved to
  // another inbox must not fetch those UIDs from the new one.
  return cfg && cursorKey(cfg) === payload.sourceKey ? cfg : null;
}

export async function runImapIntakeJob(db: AppDb, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cfg = intakeSourceConfig(db, payload);
  if (!cfg) throw new Error("The inbox this intake mail came from is no longer configured.");
  const uids = (Array.isArray(payload.uids) ? payload.uids : []).map(Number).filter((u) => Number.isInteger(u) && u > 0);
  if (!uids.length) return { scanned: 0, created: 0, attached: 0, unsorted: 0, skippedDuplicates: 0 };

  const raws: Buffer[] = [];
  const client = await imapClientFactory(cfg);
  try {
    await client.connect();
    const lock = await client.getMailboxLock(cfg.mailbox);
    try {
      // Renumbered since the poll: these UIDs now name other messages, or none.
      if (mailboxState(client).uidValidity !== String(payload.uidValidity ?? "")) {
        throw new Error(`Mailbox "${cfg.mailbox}" on source "${cfg.label}" was renumbered (UIDVALIDITY changed) before its intake mail was read.`);
      }
      for await (const msg of client.fetch(uids, { uid: true, source: true }, { uid: true })) {
        if (msg.source) raws.push(msg.source);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => null);
  }

  // A DB source files only into its own org; the env (central) inbox is operator-level.
  const run = await processIntakeMessages(db, raws, cfg.sourceId ? { sourceOrgId: cfg.orgId, restrictToOrg: true } : {});
  if (run.created || run.attached || run.unsorted) {
    logger.info("email-intake", `Source "${cfg.label}": ${run.created} project(s) created, ${run.attached} attached, ${run.unsorted} unsorted.`);
  }
  return { fetched: raws.length, scanned: run.scanned, created: run.created, attached: run.attached, unsorted: run.unsorted, skippedDuplicates: run.skippedDuplicates };
}

// ---------------------------------------------------------------------------
// Public API — called by scheduler and server endpoints
// ---------------------------------------------------------------------------

export type ImapPollResult = { fetched: number; matches: number; errors: string[]; sources: number; carried: number; intakeQueued: number };

// One poll at a time per process: the scheduler's tick and a manual POST /api/imap/poll landing
// together would both read above the same cursor. The second caller shares the first one's run.
let imapPollInFlight: Promise<ImapPollResult> | null = null;

/** Poll all configured IMAP sources (env + active DB rows) in sequence. */
export function pollImap(db: AppDb): Promise<ImapPollResult> {
  if (imapPollInFlight) return imapPollInFlight;
  imapPollInFlight = pollAllImapSources(db).finally(() => { imapPollInFlight = null; });
  return imapPollInFlight;
}

async function pollAllImapSources(db: AppDb): Promise<ImapPollResult> {
  const sources: ImapSourceConfig[] = [];

  const envCfg = envImapConfig();
  if (envCfg) sources.push(envCfg);

  sources.push(...dbImapSources(db));

  if (sources.length === 0) {
    throw new Error("No IMAP sources configured (set EMAIL_IMAP_HOST/USER/PASS or add a DB source).");
  }

  const total: ImapPollResult = { fetched: 0, matches: 0, errors: [], sources: sources.length, carried: 0, intakeQueued: 0 };
  for (const src of sources) {
    const r = await runSourcePoll(db, src);
    total.fetched += r.fetched;
    total.matches += r.matches;
    total.errors.push(...r.errors);
    total.carried += r.carried;
    total.intakeQueued += r.intakeQueued;
  }
  return total;
}
