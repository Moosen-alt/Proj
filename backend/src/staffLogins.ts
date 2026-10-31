// STAFF LOGINS (issue #431): an admin makes, resets and deactivates teammates' sign-ins from the
// dashboard, and anyone signed in changes their own password.
//
// Before this, a login could only be made by hand-writing `POST /api/orgs/:id/users`, and the
// dashboard's Team panel (`POST /api/users`) made directory entries with no password at all, so
// putting the team on a shared server meant an API call per teammate.
//
// The rules this module holds, each pinned in backend/test/staffLogins.test.ts:
// - ONE ORG. Every read and write is scoped to the acting admin's own org (owner ruling
//   2026-10-10: Keelix staff only, no cross-org admin). A user id from another org is "not
//   found" (404), never "forbidden" (rule 6). A superadmin gets no wider reach here either.
// - The password hash is written ONLY by auth.ts `setUserPassword` and checked only by
//   `passwordMatchesForUser`; this file never sees the stored format.
// - Every change is audit-logged with the actor's email. A password never reaches the audit
//   log, a console line, or a response.
// - Nobody resets their own password through the admin door (self-change asks for the current
//   password; the admin door would skip that), and nobody deactivates their own login.
import { HttpError } from "./httpError";
import type { AppDb, SqlParam } from "./db";
import { addAuditLog } from "./audit";
import { ROLE_ADMIN, ROLE_OPERATOR, ROLE_SUPERADMIN, passwordMatchesForUser, setUserPassword, type SessionUser } from "./auth";
import { createUser } from "./users";

type Row = Record<string, SqlParam>;

/** Roles an admin may give a login here. Superadmin is never minted through this door. */
export const STAFF_LOGIN_ROLES = [ROLE_OPERATOR, ROLE_ADMIN] as const;

// A floor, not a policy engine: long enough that the 8-try login throttle means something, and a
// ceiling so a megabyte "password" can't make scrypt chew on it.
export const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 256;

export interface StaffLogin {
  id: string;
  name: string;
  email: string;
  role: string;
  /** users.active: a deactivated login cannot sign in (currentUser and login both read it). */
  active: boolean;
  /** Whether a password is set, i.e. whether this person can sign in at all. Never the hash. */
  hasLogin: boolean;
  createdAt: string;
}

function mapLogin(row: Row): StaffLogin {
  return {
    id: String(row.id),
    name: String(row.name),
    email: String(row.email),
    role: String(row.role || ROLE_OPERATOR),
    active: Boolean(row.active),
    hasLogin: String(row.password_hash || "") !== "",
    createdAt: String(row.created_at || ""),
  };
}

export function checkNewPassword(password: unknown): string {
  const value = typeof password === "string" ? password : "";
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    throw new HttpError(400, `The password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
  return value;
}

/** Everyone in the admin's own org, with whether each can sign in. */
export function listStaffLogins(db: AppDb, actor: SessionUser): StaffLogin[] {
  return db.query<Row>(
    "SELECT id, name, email, role, active, password_hash, created_at FROM users WHERE org_id = ? ORDER BY name ASC",
    [actor.orgId],
  ).map(mapLogin);
}

/** One login in the admin's own org, or 404. Another org's id reads exactly like a missing one. */
function loginInOrg(db: AppDb, actor: SessionUser, userId: string): StaffLogin {
  const row = db.get<Row>(
    "SELECT id, name, email, role, active, password_hash, created_at FROM users WHERE id = ? AND org_id = ?",
    [userId, actor.orgId],
  );
  if (!row) throw new HttpError(404, "Team member not found.");
  return mapLogin(row);
}

/** An org admin cannot reset or switch off a superadmin (the owner's own login). */
function assertMayManage(actor: SessionUser, target: StaffLogin): void {
  if (target.role === ROLE_SUPERADMIN && actor.role !== ROLE_SUPERADMIN) {
    throw new HttpError(403, "Only a superadmin can manage a superadmin's login.");
  }
}

export function createStaffLogin(
  db: AppDb,
  actor: SessionUser,
  input: { name?: unknown; email?: unknown; role?: unknown; password?: unknown },
): StaffLogin {
  const name = String(input.name ?? "").trim();
  const email = String(input.email ?? "").trim().toLowerCase();
  if (!name || !email) throw new HttpError(400, "Name and email are required.");
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new HttpError(400, "That doesn't look like an email address.");
  const role = String(input.role ?? ROLE_OPERATOR);
  if (!(STAFF_LOGIN_ROLES as readonly string[]).includes(role)) {
    throw new HttpError(400, "Role must be operator or admin.");
  }
  const password = checkNewPassword(input.password);

  const existing = db.get<Row>("SELECT id, org_id, password_hash FROM users WHERE email = ?", [email]);
  if (existing) {
    // Already on this team as a directory entry (the Team panel's Add makes those): say how to
    // give THAT entry a login rather than failing on the UNIQUE email with no way forward.
    if (String(existing.org_id) === actor.orgId && !existing.password_hash) {
      throw new HttpError(409, "That email is already on the team without a login. Select them and use Set password.");
    }
    throw new HttpError(409, "A user with that email already exists.");
  }

  // createUser is the one INSERT into users and always makes an operator; the role an admin
  // picked is applied after, here, behind requireAdmin. setUserPassword is the one hash writer.
  const created = createUser(db, { name, email, orgId: actor.orgId });
  if (role !== ROLE_OPERATOR) db.run("UPDATE users SET role = ? WHERE id = ?", [role, created.id]);
  setUserPassword(db, created.id, password);
  addAuditLog(db, null, "human", actor.email, "staff.login_created", { userId: created.id, email, role });
  return loginInOrg(db, actor, created.id);
}

/** An admin sets a teammate's password: a reset, or a first login for a directory entry. */
export function resetStaffPassword(db: AppDb, actor: SessionUser, userId: string, password: unknown): StaffLogin {
  const target = loginInOrg(db, actor, userId);
  if (target.id === actor.id) {
    throw new HttpError(400, "Use Change my password for your own login; it asks for your current password.");
  }
  assertMayManage(actor, target);
  setUserPassword(db, target.id, checkNewPassword(password));
  addAuditLog(db, null, "human", actor.email, target.hasLogin ? "staff.password_reset" : "staff.login_created", {
    userId: target.id, email: target.email, role: target.role,
  });
  return loginInOrg(db, actor, target.id);
}

/**
 * Switch a login off (or back on). Off takes effect on the very next request: the session cookie
 * is stateless, but currentUser re-reads `active = 1` every time, so an open session dies too.
 */
export function setStaffLoginActive(db: AppDb, actor: SessionUser, userId: string, active: boolean): StaffLogin {
  const target = loginInOrg(db, actor, userId);
  if (target.id === actor.id && !active) throw new HttpError(400, "You can't deactivate your own login.");
  assertMayManage(actor, target);
  if (target.active !== active) {
    db.run("UPDATE users SET active = ? WHERE id = ?", [active ? 1 : 0, target.id]);
    addAuditLog(db, null, "human", actor.email, active ? "staff.login_reactivated" : "staff.login_deactivated", {
      userId: target.id, email: target.email,
    });
  }
  return loginInOrg(db, actor, target.id);
}

// A stolen session must not become an unlimited guesser of the current password, so wrong
// guesses here are throttled per user the way login() throttles per IP.
const selfChangeFails = new Map<string, { fails: number; lockedUntil: number }>();
const SELF_CHANGE_MAX_FAILS = 5;
const SELF_CHANGE_LOCK_MS = 15 * 60_000;

/** Self-service: the signed-in person changes their own password, proving the current one. */
export function changeOwnPassword(db: AppDb, user: SessionUser, currentPassword: unknown, newPassword: unknown): void {
  const now = Date.now();
  const record = selfChangeFails.get(user.id);
  if (record && record.lockedUntil > now) {
    throw new HttpError(429, "Too many wrong current passwords. Try again in a few minutes.");
  }
  if (!passwordMatchesForUser(db, user.id, typeof currentPassword === "string" ? currentPassword : "")) {
    const rec = record ?? { fails: 0, lockedUntil: 0 };
    rec.fails += 1;
    if (rec.fails >= SELF_CHANGE_MAX_FAILS) { rec.lockedUntil = now + SELF_CHANGE_LOCK_MS; rec.fails = 0; }
    selfChangeFails.set(user.id, rec);
    throw new HttpError(400, "Your current password is not right.");
  }
  selfChangeFails.delete(user.id);
  const next = checkNewPassword(newPassword);
  if (next === currentPassword) throw new HttpError(400, "The new password must be different from the current one.");
  setUserPassword(db, user.id, next);
  addAuditLog(db, null, "human", user.email, "user.password_changed", { userId: user.id });
}
