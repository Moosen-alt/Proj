import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppDb } from "./db";
import { HttpError } from "./httpError";
import { runEmailTracker } from "./repository";
import { writeMboxMessage } from "./mbox";
import { intakeEnabled, isIntakeMessage, processIntakeMessages } from "./emailIntake";
import { enqueueJob } from "./jobQueue";
import { logger } from "./logger";
import type { EmailIntakeRunResult, EmailTrackerRunResult } from "../../shared/src/types";

// =============================================================================
// Live Gmail polling.
//
// Fetches recent messages from a work Gmail inbox via the Gmail REST API, writes
// them to a temporary MBOX file, and runs them through the EXISTING email
// tracker/matcher — so all classification and project-matching logic is reused
// unchanged. Read-only (gmail.readonly scope); never sends or modifies mail.
//
// SETUP (one time):
//   1. Create a Google Cloud project, enable the Gmail API.
//   2. Create an OAuth 2.0 Client (type "Web application") with redirect URI
//      <APP_URL>/api/gmail/oauth/callback.
//   3. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in the environment.
//   4. Open /api/gmail/auth-url, authorize, and copy the returned refresh token
//      into GMAIL_REFRESH_TOKEN.
// =============================================================================

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

function clientId(): string {
  const v = process.env.GMAIL_CLIENT_ID;
  if (!v) throw new HttpError(400, "GMAIL_CLIENT_ID is not set. Complete the Gmail OAuth setup first.");
  return v;
}

function clientSecret(): string {
  const v = process.env.GMAIL_CLIENT_SECRET;
  if (!v) throw new HttpError(400, "GMAIL_CLIENT_SECRET is not set. Complete the Gmail OAuth setup first.");
  return v;
}

function redirectUri(): string {
  return process.env.GMAIL_REDIRECT_URI || `http://localhost:${process.env.PORT || 4173}/api/gmail/oauth/callback`;
}

export function gmailStatus(): { configured: boolean; authorized: boolean; redirectUri: string } {
  return {
    configured: Boolean(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET),
    authorized: Boolean(process.env.GMAIL_REFRESH_TOKEN),
    redirectUri: redirectUri(),
  };
}

// One-time consent URL. access_type=offline + prompt=consent ensures a refresh
// token is returned.
export function buildAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

// Exchanges the one-time auth code for tokens. Returns the refresh token to be
// stored in GMAIL_REFRESH_TOKEN.
export async function exchangeCodeForTokens(code: string): Promise<{ refreshToken: string | null; accessToken: string }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { refresh_token?: string; access_token?: string; error_description?: string };
  if (!res.ok) throw new HttpError(502, `Gmail token exchange failed: ${data.error_description || res.status}`);
  return { refreshToken: data.refresh_token ?? null, accessToken: data.access_token ?? "" };
}

async function getAccessToken(): Promise<string> {
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!refreshToken) throw new HttpError(400, "GMAIL_REFRESH_TOKEN is not set. Authorize via /api/gmail/auth-url first.");
  const res = await gmailFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    throw new HttpError(502, `Gmail token refresh failed: ${data.error_description || res.status}. The refresh token may be revoked — re-authorize.`);
  }
  return data.access_token;
}

interface GmailListResponse {
  messages?: { id: string }[];
  nextPageToken?: string;
  error?: { message?: string };
}

// ---------------------------------------------------------------------------
// EVERY MESSAGE, ONCE (#539). The poll used to list ONE page of `maxResults` 100 for its window
// and read only that: a burst of more than 100 inside the window was never read. Now it pages the
// whole list, skips the ids it has already handed on (email_poll_seen), and reads the rest oldest
// first, at most GMAIL_MAX_MESSAGES_PER_TICK (default 500) a tick. An id past that bound stays
// unseen, so a later tick reads it: carried, never dropped.
//
// THE WINDOW. Gmail has no UID, so the scheduled poll asks for mail after the start of the last
// tick that CAUGHT UP (no remainder, every message read), less an hour of overlap for Gmail's
// indexing delay; until one has, `newer_than:1d` as before. While a remainder is being worked off
// the window does not move, so the oldest unread message never falls out of it. Re-listing what
// was already read costs one list call per 500 ids and no message fetch.
//
// A message is marked seen only once it is handed on: the tracker ran its batch without a source
// error, or it is on an email_intake job. A fetch that fails leaves it unseen for the next tick.
// ---------------------------------------------------------------------------

const GMAIL_SOURCE_KEY = "gmail:env";
const LIST_PAGE_SIZE = 500; // Gmail's own maximum for messages.list
const LIST_PAGE_CAP = 50; // 25,000 ids: a safety stop, far past any burst between two ticks
const WINDOW_OVERLAP_MS = 60 * 60 * 1000;

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: URLSearchParams }) => Promise<Response>;
let gmailFetch: FetchLike = (url, init) => fetch(url, init);

/** Test door: a fake Gmail API in place of the network. null restores fetch. */
export function setGmailFetchForTests(f: FetchLike | null): void {
  gmailFetch = f ?? ((url, init) => fetch(url, init));
}

function maxMessagesPerTick(): number {
  const n = Number(process.env.GMAIL_MAX_MESSAGES_PER_TICK ?? 500);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 500;
}

/** Every id the query lists, newest first (Gmail's order), and whether the list was complete. */
async function listGmailIds(auth: Record<string, string>, query: string): Promise<{ ids: string[]; complete: boolean }> {
  const ids: string[] = [];
  let pageToken = "";
  for (let page = 0; page < LIST_PAGE_CAP; page++) {
    const params = new URLSearchParams({ q: query, maxResults: String(LIST_PAGE_SIZE) });
    if (pageToken) params.set("pageToken", pageToken);
    const listRes = await gmailFetch(`${GMAIL_API}/messages?${params.toString()}`, { headers: auth });
    const list = (await listRes.json().catch(() => ({}))) as GmailListResponse;
    if (!listRes.ok) throw new HttpError(502, `Gmail list failed: ${list.error?.message || listRes.status}`);
    for (const m of list.messages ?? []) if (m?.id) ids.push(m.id);
    pageToken = list.nextPageToken ?? "";
    if (!pageToken) return { ids: [...new Set(ids)], complete: true };
  }
  return { ids: [...new Set(ids)], complete: false };
}

function seenIds(db: AppDb, ids: string[]): Set<string> {
  const seen = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db.query<{ message_ref: string }>(
      `SELECT message_ref FROM email_poll_seen WHERE source_key = ? AND message_ref IN (${chunk.map(() => "?").join(",")})`,
      [GMAIL_SOURCE_KEY, ...chunk],
    );
    for (const r of rows) seen.add(String(r.message_ref));
  }
  return seen;
}

function markSeen(db: AppDb, ids: string[]): void {
  const now = new Date().toISOString();
  for (const ref of ids) {
    db.run("INSERT OR IGNORE INTO email_poll_seen (source_key, message_ref, seen_at) VALUES (?, ?, ?)", [GMAIL_SOURCE_KEY, ref, now]);
  }
}

function windowAnchorMs(db: AppDb): number | null {
  const row = db.get<{ last_uid: number }>("SELECT last_uid FROM email_poll_cursors WHERE source_key = ?", [GMAIL_SOURCE_KEY]);
  const ms = Number(row?.last_uid ?? 0);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function writeWindowAnchor(db: AppDb, ms: number): void {
  db.run(
    `INSERT INTO email_poll_cursors (source_key, uid_validity, last_uid, updated_at) VALUES (?, '', ?, ?)
     ON CONFLICT(source_key) DO UPDATE SET last_uid = excluded.last_uid, updated_at = excluded.updated_at`,
    [GMAIL_SOURCE_KEY, ms, new Date().toISOString()],
  );
  // Seen ids older than the window can never be listed again. Two days of slack past it.
  const cutoff = new Date(ms - WINDOW_OVERLAP_MS - 2 * 86_400_000).toISOString();
  db.run("DELETE FROM email_poll_seen WHERE source_key = ? AND seen_at < ?", [GMAIL_SOURCE_KEY, cutoff]);
}

/** One message's RFC822 bytes, or null when Gmail would not return it (left for a later read). */
async function fetchGmailRaw(auth: Record<string, string>, id: string): Promise<Buffer | null> {
  const msgRes = await gmailFetch(`${GMAIL_API}/messages/${encodeURIComponent(id)}?format=raw`, { headers: auth });
  if (!msgRes.ok) return null;
  const msg = (await msgRes.json().catch(() => ({}))) as { raw?: string };
  if (!msg.raw) return null;
  // Gmail returns the full RFC822 message base64url-encoded.
  return Buffer.from(msg.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

interface GmailBatch {
  filePath: string;
  count: number;
  /** Ids written to the tracker's MBOX: seen once the tracker has run them. */
  trackerIds: string[];
  /** Ids of intake mail, for the email_intake job. */
  intakeIds: string[];
  /** Unseen ids this tick's bound left for a later tick. */
  carried: number;
  /** Every unseen id was read, and the list was complete: the window may move up. */
  caughtUp: boolean;
}

async function fetchGmailToMbox(db: AppDb, query: string): Promise<GmailBatch> {
  const token = await getAccessToken();
  const auth = { Authorization: `Bearer ${token}` };

  const listed = await listGmailIds(auth, query);
  if (!listed.complete) logger.warn("gmail", `Gmail list for "${query}" passed ${LIST_PAGE_CAP} pages; the oldest of it is read once the newer mail is seen.`);
  const seen = seenIds(db, listed.ids);
  // Gmail lists newest first; read oldest first, so what a bound leaves over is the newest.
  const unseen = listed.ids.filter((id) => !seen.has(id)).reverse();
  const take = unseen.slice(0, maxMessagesPerTick());

  const mboxPath = path.join(os.tmpdir(), `gmail-${Date.now()}-${process.pid}.mbox`);
  const out = fs.createWriteStream(mboxPath, { encoding: "utf8" });
  const batch: GmailBatch = { filePath: mboxPath, count: 0, trackerIds: [], intakeIds: [], carried: unseen.length - take.length, caughtUp: false };
  // EMAIL-IN INTAKE (#489): mail to the intake address is a new job, not a status email — it goes
  // to emailIntake.ts and never into the tracker's MBOX (emailPoller.ts does the same).
  const intakeOn = intakeEnabled();
  const { simpleParser } = await import("mailparser");
  let unread = 0;

  try {
    for (const id of take) {
      const bytes = await fetchGmailRaw(auth, id);
      if (!bytes) { unread += 1; continue; }
      if (intakeOn) {
        const parsed = await simpleParser(bytes).catch(() => null);
        if (parsed && isIntakeMessage(parsed)) { batch.intakeIds.push(id); continue; }
      }
      const rfc822 = bytes.toString("utf8");
      // MBOX separator line + escape any lines that start with "From " in the body.
      writeMboxMessage(out, rfc822, "gmail@local");
      batch.trackerIds.push(id);
      batch.count += 1;
    }
  } catch (err) {
    // Nothing of this batch is marked seen; the next tick reads it again. No temp file left behind.
    await new Promise<void>((resolve) => out.end(() => resolve()));
    fs.rmSync(mboxPath, { force: true });
    throw err;
  }
  await new Promise<void>((resolve, reject) => {
    out.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
  batch.caughtUp = listed.complete && batch.carried === 0 && unread === 0;
  return { ...batch, carried: batch.carried + unread };
}

/** Polls Gmail and runs the fetched messages through the existing email tracker. `scheduled`
 *  (the monitor tick) uses the moving window; a manual poll reads `query` (default 30 days). */
export async function pollGmail(
  db: AppDb,
  query?: string,
  opts: { scheduled?: boolean } = {},
): Promise<EmailTrackerRunResult & { fetched: number; carried: number; intakeQueued: number }> {
  const tickStart = Date.now();
  const anchor = opts.scheduled ? windowAnchorMs(db) : null;
  const q = anchor !== null
    ? `after:${Math.floor((anchor - WINDOW_OVERLAP_MS) / 1000)}`
    : query || (opts.scheduled ? "newer_than:1d" : "newer_than:30d");

  const batch = await fetchGmailToMbox(db, q);
  try {
    const result = await runEmailTracker(db, { filePath: batch.filePath });
    // A batch the tracker could not read is not handed on: left unseen, it is read again.
    const trackerOk = result.sourceErrors.length === 0;
    if (trackerOk) markSeen(db, batch.trackerIds);

    // THE INTAKE IS QUEUED, NOT RUN HERE (#539): one model read per emailed job held the monitor
    // tick. The job fetches these ids again itself, so no raw message is stored at rest. The
    // Gmail inbox is operator-level, like the central IMAP inbox: a tag in any org may match.
    // One job per message, so one that fails retries alone.
    for (const id of batch.intakeIds) enqueueJob(db, "email_intake", { channel: "gmail", ids: [id] }, { priority: 4 });
    markSeen(db, batch.intakeIds);

    if (opts.scheduled && trackerOk && batch.caughtUp) writeWindowAnchor(db, tickStart);
    if (batch.carried > 0) logger.info("gmail", `${batch.carried} message(s) past this tick's bound or not returned; read next tick.`);
    return { ...result, fetched: batch.count, carried: batch.carried, intakeQueued: batch.intakeIds.length };
  } finally {
    if (fs.existsSync(batch.filePath)) fs.unlinkSync(batch.filePath);
  }
}

/** The email_intake job for Gmail: fetch the queued ids again and file them. A message Gmail
 *  does not return fails the job after the rest are filed, so its retry reads it (the ones
 *  already filed are skipped by their Message-ID). */
export async function runGmailIntakeJob(db: AppDb, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ids = (Array.isArray(payload.ids) ? payload.ids : []).map(String).filter(Boolean);
  if (!ids.length) return { fetched: 0 };
  const token = await getAccessToken();
  const auth = { Authorization: `Bearer ${token}` };
  const raws: Buffer[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const bytes = await fetchGmailRaw(auth, id);
    if (bytes) raws.push(bytes); else missing.push(id);
  }
  const run: EmailIntakeRunResult = await processIntakeMessages(db, raws);
  if (missing.length) throw new Error(`Gmail did not return ${missing.length} of ${ids.length} intake message(s); retrying.`);
  return { fetched: raws.length, scanned: run.scanned, created: run.created, attached: run.attached, unsorted: run.unsorted, skippedDuplicates: run.skippedDuplicates };
}
