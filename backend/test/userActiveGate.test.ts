// WHO MAY SWITCH A LOGIN OFF THROUGH THE TEAM PANEL DOOR (issue #474).
//
// `PUT /api/users/:id` hands the body to users.updateUser with the SESSION actor. Before #474 it
// checked the actor for a ROLE change but took `active` from anyone signed in, so an operator could
// switch an admin's login off (and, after #432, end their sessions) with one request. The dashboard's
// own door (staffLogins.setStaffLoginActive, #431) was admin-gated; this one now gives the same
// answer, from the same rule (users.assertMayManageLogin):
//
//   an operator                      403, and NOTHING the request carried is written
//   no actor (sign-in off, scripts)  403: nobody can be shown to be an admin
//   an admin                         switches a teammate off and back on
//   your own login                   403, even for an admin (or a superadmin)
//   a superadmin's login             403 for an org admin; a superadmin may
//   leaving `active` alone           an operator still edits name/colour (and sending the value it
//                                    already has is not a change)
//
// The route itself is pinned in sessionRevocation.test.ts ("an operator's PUT ... is 403").
//
// KILL: drop the ADMIN_ROLES check in updateUser → "an operator ... 403" and "no actor" fail; drop
// the self check → "your own login" fails; drop assertMayManageLogin from updateUser → "an org
// admin cannot switch off a superadmin" fails.
//
// Run: tsx backend/test/userActiveGate.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "user-active-gate-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "users.sqlite");

const { openDatabase } = await import("../src/db");
const { updateUser, getUser } = await import("../src/users");
const { HttpError } = await import("../src/httpError");

let failures = 0;
const run = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const db = await openDatabase();
const ORG = "org-default";
// Synthetic people only.
const people = {
  owner: { id: "user-super", role: "superadmin" },
  admin: { id: "user-admin", role: "admin" },
  admin2: { id: "user-admin-2", role: "admin" },
  op: { id: "user-op", role: "operator" },
  mate: { id: "user-mate", role: "operator" },
};
for (const [key, p] of Object.entries(people)) {
  db.run(
    "INSERT INTO users (id, name, email, role, color, active, created_at, org_id) VALUES (?, ?, ?, ?, '#000000', 1, ?, ?)",
    [p.id, key, `${key}@active-gate.test`, p.role, new Date().toISOString(), ORG],
  );
}
const actor = (p: { id: string; role: string }) => ({ id: p.id, role: p.role, orgId: ORG });
const activeOf = (id: string) => getUser(db, id)!.active;
const versionOf = (id: string) => Number(db.get<{ v: number }>("SELECT session_version AS v FROM users WHERE id = ?", [id])?.v ?? 0);

function refused(fn: () => unknown, status = 403): void {
  try { fn(); }
  catch (err) {
    assert.ok(err instanceof HttpError, `expected an HttpError, got ${String(err)}`);
    assert.equal(err.status, status, err.message);
    return;
  }
  assert.fail("the change was allowed");
}

run("an operator switching an admin's login off is 403 and changes nothing", () => {
  const before = { ...getUser(db, people.admin.id)!, version: versionOf(people.admin.id) };
  refused(() => updateUser(db, people.admin.id, { active: false, name: "Renamed by op" }, actor(people.op)));
  const after = getUser(db, people.admin.id)!;
  assert.equal(after.active, true, "the admin's login was switched off");
  assert.equal(after.name, before.name, "the name the refused request carried was written");
  assert.equal(versionOf(people.admin.id), before.version, "the admin's sessions were ended");
});

run("an operator cannot switch a fellow operator's login off either", () => {
  refused(() => updateUser(db, people.mate.id, { active: false }, actor(people.op)));
  assert.equal(activeOf(people.mate.id), true);
});

run("no actor (sign-in off, a script) cannot change active", () => {
  refused(() => updateUser(db, people.mate.id, { active: false }, null));
  refused(() => updateUser(db, people.mate.id, { active: false }));
  assert.equal(activeOf(people.mate.id), true);
});

run("an admin switches a teammate off and back on, ending their sessions", () => {
  const v0 = versionOf(people.mate.id);
  assert.equal(updateUser(db, people.mate.id, { active: false }, actor(people.admin)).active, false);
  assert.ok(versionOf(people.mate.id) > v0, "switching off did not end the sessions");
  assert.equal(updateUser(db, people.mate.id, { active: true }, actor(people.admin)).active, true);
});

run("an admin can switch another admin off (and back on)", () => {
  assert.equal(updateUser(db, people.admin2.id, { active: false }, actor(people.admin)).active, false);
  assert.equal(updateUser(db, people.admin2.id, { active: true }, actor(people.admin)).active, true);
});

run("nobody switches off their own login here, admin or superadmin", () => {
  refused(() => updateUser(db, people.admin.id, { active: false }, actor(people.admin)));
  refused(() => updateUser(db, people.owner.id, { active: false }, actor(people.owner)));
  assert.equal(activeOf(people.admin.id), true);
  assert.equal(activeOf(people.owner.id), true);
});

run("an org admin cannot switch off a superadmin's login", () => {
  refused(() => updateUser(db, people.owner.id, { active: false }, actor(people.admin)));
  assert.equal(activeOf(people.owner.id), true);
});

run("a superadmin can switch an admin off (and back on)", () => {
  assert.equal(updateUser(db, people.admin2.id, { active: false }, actor(people.owner)).active, false);
  assert.equal(updateUser(db, people.admin2.id, { active: true }, actor(people.owner)).active, true);
});

run("an operator still edits a teammate's name and colour, and resending the current active is no change", () => {
  const v0 = versionOf(people.mate.id);
  const out = updateUser(db, people.mate.id, { name: "Mate Renamed", color: "#123456", active: true }, actor(people.op));
  assert.equal(out.name, "Mate Renamed");
  assert.equal(out.color, "#123456");
  assert.equal(out.active, true);
  assert.equal(versionOf(people.mate.id), v0, "an edit that left Active alone ended sessions");
});

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nuserActiveGate: all checks passed");
