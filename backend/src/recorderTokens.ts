// RECORDER TOKENS (issue #433, shared server #429).
//
// The portal recorder (`npm run portal:record`, portal-bot/src/recordRecipe.ts) drives a visible
// browser on a person's OWN computer and posts what it captured to the server. With sign-in on
// (AUTH_ENABLED=true) it has no session cookie, so every call 401'd. Org API keys cannot stand in:
// requireAuth never lets a key reach autopilot routes, by design, because a recording needs a
// human identity in the audit trail.
//
// So a signed-in person mints a token of their own in the dashboard. The rules this module holds,
// each pinned in backend/test/recorderTokens.test.ts:
// - SHOWN ONCE, STORED HASHED. The token is returned by the mint call and never again; the table
//   holds sha256(token) only. It never reaches the audit log, a console line or a list response.
// - EXACTLY THE RECORDER'S FOUR ENDPOINTS (RECORDER_ROUTES): start a recording, read the recording
//   project's field values, ask for binding suggestions, save the captured steps. Matched on method
//   AND the whole path. Anything else — staging, approval, admin, minting another token — is 401
//   exactly as if no token had been sent (hard rule 1: a recorder token can never approve or stage
//   a filing; rule 6: deny by default). requireAuth (auth.ts) is the only place a token is read.
// - AS THAT PERSON. A valid token makes currentUser() answer with its user for THAT request, so the
//   org scope guard, the entitlement gate and the audit rows all see the person who minted it.
// - EXPIRING AND REVOCABLE. Default 30 days (at most 90). Revoking, a deactivated login
//   (users.active = 0) or expiry each stop it on the next request.
import crypto from "node:crypto";
import type { Request } from "express";
import type { AppDb, SqlParam } from "./db";
import { DEFAULT_ORG_ID } from "./db";
import { addAuditLog } from "./audit";
import { HttpError } from "./httpError";
import type { SessionUser } from "./auth";

type Row = Record<string, SqlParam>;

/** The request header the recorder CLI sends its token in. */
export const RECORDER_TOKEN_HEADER = "x-recorder-token";
export const RECORDER_TOKEN_DEFAULT_DAYS = 30;
export const RECORDER_TOKEN_MAX_DAYS = 90;
/** Live (unrevoked, unexpired) tokens one person may hold at once: enough for a laptop and a
 *  desktop and a spare, few enough that a forgotten one is noticed in the list. */
export const RECORDER_TOKEN_MAX_LIVE = 10;
const NAME_MAX = 60;

/**
 * THE ONLY ROUTES A RECORDER TOKEN REACHES. Method plus the WHOLE path, anchored, one segment per
 * id. Express routes case-insensitively and forgives a trailing slash; these patterns do neither,
 * so a variant spelling of a recorder route gets no principal and 401s (fails closed) rather than
 * the other way round. Each entry must be the exact registration in server.ts (asserted by
 * recorderTokens.test.ts against the source).
 */
export const RECORDER_ROUTES: ReadonlyArray<{ method: string; route: string; pattern: RegExp }> = [
  { method: "POST", route: "/api/portal-recipes/record", pattern: /^\/api\/portal-recipes\/record$/ },
  { method: "GET", route: "/api/projects/:id/staging-field-values", pattern: /^\/api\/projects\/[^/]+\/staging-field-values$/ },
  { method: "POST", route: "/api/portal-recipes/:id/suggest-bindings", pattern: /^\/api\/portal-recipes\/[^/]+\/suggest-bindings$/ },
  { method: "PUT", route: "/api/portal-recipes/:id/steps", pattern: /^\/api\/portal-recipes\/[^/]+\/steps$/ },
];

export function isRecorderRoute(method: string, requestPath: string): boolean {
  const verb = String(method || "").toUpperCase();
  return RECORDER_ROUTES.some((r) => r.method === verb && r.pattern.test(requestPath));
}

// The principal requireAuth attaches for one request. A Symbol, so nothing a client sends (a header,
// a body field, a query string) can set it; only requireAuth writes it, and only on a recorder route.
const RECORDER_PRINCIPAL = Symbol("recorderPrincipal");

export function attachRecorderPrincipal(req: Request, user: SessionUser): void {
  (req as unknown as Record<symbol, SessionUser>)[RECORDER_PRINCIPAL] = user;
}

/** The person a recorder token authenticated THIS request as, or null (no token, or not a recorder route). */
export function recorderPrincipal(req: Request): SessionUser | null {
  return (req as unknown as Record<symbol, SessionUser | undefined>)[RECORDER_PRINCIPAL] ?? null;
}

export function presentedRecorderToken(req: Request): string {
  const raw = req.headers[RECORDER_TOKEN_HEADER];
  return String(Array.isArray(raw) ? raw[0] : raw || "").trim();
}

const hashToken = (token: string): string => crypto.createHash("sha256").update(token).digest("hex");

/**
 * The active user a token belongs to, or null when it is unknown, revoked, expired, or its login is
 * switched off. Stamps last_used_at on success. Never logs or returns the token.
 */
export function userFromRecorderToken(db: AppDb, token: string): SessionUser | null {
  if (!token || token.length > 200) return null;
  const hash = hashToken(token);
  const row = db.get<Row>(
    `SELECT t.id AS token_id, t.expires_at, u.id, u.name, u.email, u.role, u.org_id
       FROM recorder_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.revoked_at = '' AND u.active = 1`,
    [hash],
  );
  if (!row) return null;
  const now = new Date();
  if (!(Date.parse(String(row.expires_at)) > now.getTime())) return null;
  db.run("UPDATE recorder_tokens SET last_used_at = ? WHERE id = ?", [now.toISOString(), String(row.token_id)]);
  return {
    id: String(row.id),
    name: String(row.name),
    email: String(row.email),
    role: String(row.role),
    orgId: String(row.org_id || DEFAULT_ORG_ID),
  };
}

export interface RecorderTokenInfo {
  id: string;
  name: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
  revokedAt: string;
  /** Neither revoked nor expired. */
  live: boolean;
}

function mapToken(row: Row, nowMs = Date.now()): RecorderTokenInfo {
  const revokedAt = String(row.revoked_at || "");
  const expiresAt = String(row.expires_at || "");
  return {
    id: String(row.id),
    name: String(row.name || ""),
    createdAt: String(row.created_at || ""),
    expiresAt,
    lastUsedAt: String(row.last_used_at || ""),
    revokedAt,
    live: !revokedAt && Date.parse(expiresAt) > nowMs,
  };
}

/** The caller's OWN tokens, newest first. Hashes are never selected. */
export function listRecorderTokens(db: AppDb, user: SessionUser): RecorderTokenInfo[] {
  const now = Date.now();
  return db.query<Row>(
    "SELECT id, name, created_at, expires_at, last_used_at, revoked_at FROM recorder_tokens WHERE user_id = ? ORDER BY created_at DESC, rowid DESC",
    [user.id],
  ).map((row) => mapToken(row, now));
}

function readDays(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return RECORDER_TOKEN_DEFAULT_DAYS;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > RECORDER_TOKEN_MAX_DAYS) {
    throw new HttpError(400, `days must be a whole number from 1 to ${RECORDER_TOKEN_MAX_DAYS}.`);
  }
  return days;
}

/**
 * Mint a token for the signed-in person. The plaintext is in the return value and nowhere else.
 * Audited (recorder_token.created) with the person's email, the token id and its expiry.
 */
export function mintRecorderToken(
  db: AppDb,
  user: SessionUser,
  input: { name?: unknown; days?: unknown },
): { token: string; info: RecorderTokenInfo } {
  const days = readDays(input.days);
  const name = String(input.name ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, NAME_MAX) || "recorder";
  const nowIso = new Date().toISOString();
  const live = db.get<Row>(
    "SELECT COUNT(*) AS cnt FROM recorder_tokens WHERE user_id = ? AND revoked_at = '' AND expires_at > ?",
    [user.id, nowIso],
  );
  if (Number(live?.cnt ?? 0) >= RECORDER_TOKEN_MAX_LIVE) {
    throw new HttpError(409, `You already have ${RECORDER_TOKEN_MAX_LIVE} live recorder tokens. Revoke one you no longer use first.`);
  }
  const id = crypto.randomUUID();
  const token = `rt_${crypto.randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  db.run(
    "INSERT INTO recorder_tokens (id, user_id, name, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, user.id, name, hashToken(token), nowIso, expiresAt],
  );
  addAuditLog(db, null, "human", user.email, "recorder_token.created", { tokenId: id, name, expiresAt, orgId: user.orgId });
  const row = db.get<Row>("SELECT id, name, created_at, expires_at, last_used_at, revoked_at FROM recorder_tokens WHERE id = ?", [id]);
  return { token, info: mapToken(row as Row) };
}

/**
 * Revoke one of the caller's OWN tokens. Another person's token id reads exactly like a missing one
 * (404, rule 6). Revoking an already-revoked token is a no-op that still answers with it.
 */
export function revokeRecorderToken(db: AppDb, user: SessionUser, tokenId: string): RecorderTokenInfo {
  const row = db.get<Row>(
    "SELECT id, name, created_at, expires_at, last_used_at, revoked_at FROM recorder_tokens WHERE id = ? AND user_id = ?",
    [tokenId, user.id],
  );
  if (!row) throw new HttpError(404, "Recorder token not found.");
  if (!row.revoked_at) {
    const now = new Date().toISOString();
    db.run("UPDATE recorder_tokens SET revoked_at = ?, revoked_by = ? WHERE id = ?", [now, user.email, tokenId]);
    addAuditLog(db, null, "human", user.email, "recorder_token.revoked", { tokenId, orgId: user.orgId });
    row.revoked_at = now;
  }
  return mapToken(row);
}
