// A RE-CHECK THAT READ NOTHING IS NOT A STATUS (issue #412).
//
// Live 2026-10-29, project 7ddfbe48: the building target was `issued` (a manual reading). One
// public re-check from the stale panel — POST /api/projects/:id/permit-checks {targetId, source:
// "public_url"}, whose entire body is recordPermitStatusCheck — got "no results" from Accela's
// global search, and the placeholder "No status text available…" was written as the target's
// latest_outcome (needs_human_review) and the project's current_stage. The scheduled sweep already
// refused exactly this; the manual door answered the same question differently. Both now ask
// permitMonitor.shouldSkipEmptyRead. The network is the only thing stubbed
// (setStatusCheckSeamsForTests); the target reaches `issued` through the real writer.
//
//   THE POINT    a target at issued + a public re-check whose fetch returns nothing -> still
//                issued, project stage/status unchanged, no check row, no review item, the target
//                rescheduled, and the caller told in a sentence
//   MUST-PASS    a login page is nothing read too (the sweep already says so): no row, and the
//                sentence names the credential
//   MUST-PASS    a NEVER-checked target still records the honest "manual check required" row
//   MUST-PASS    a pasted text on a known target is never "empty" — even the placeholder itself
//
// Run: npx tsx backend/test/emptyReadIsNotAStatus.test.ts
import "./_isolate"; // FIRST — generated files land in a temp cwd, never the repo's backend/data
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("empty-read-is-not-a-status");
const { db, repo } = fx;
// The live install's mode (the stage fixture sets PORTAL_AUTOSEED=0, the offline-dev switch).
process.env.PORTAL_AUTOSEED = "1";
const ACA_OREGON = "https://aca-oregon.accela.com/oregon/";
const PLACEHOLDER = "No status text available. Manual AHJ/utility portal check required.";

let reply: string | null = "";
const fetches: string[] = [];
repo.setStatusCheckSeamsForTests({
  publicCheck: (async (url: string) => { fetches.push(url); return reply; }) as never,
  checkStatus: (async () => { throw new Error("no browser in this test"); }) as never,
});

const buildingTarget = (applicationNumber: string) => {
  const projectId = fx.newProject({ ahj: "Lincoln County", city: "Newport", zip: "97365" });
  repo.createPermitCheckTarget(db, projectId, { targetType: "permit", permitType: "building", portalUrl: ACA_OREGON, applicationNumber, jurisdiction: "Lincoln County", portalName: "Accela" });
  const targetId = db.get<{ id: string }>("SELECT id FROM permit_check_targets WHERE project_id = ? ORDER BY created_at DESC LIMIT 1", [projectId])!.id;
  return { projectId, targetId };
};
const issuedTarget = async (applicationNumber: string) => {
  const t = buildingTarget(applicationNumber);
  await repo.recordPermitStatusCheck(db, t.projectId, { targetId: t.targetId, source: "manual", rawStatusText: `Record ${applicationNumber}: Residential Building. Record Status: Permit Issued.` });
  const row = db.get<{ latest_outcome: string }>("SELECT latest_outcome FROM permit_check_targets WHERE id = ?", [t.targetId])!;
  assert.equal(row.latest_outcome, "issued", "fixture: the manual reading did not put the target at issued");
  // As if the last look were a day ago, so a reschedule is visible.
  db.run("UPDATE permit_check_targets SET last_checked_at = '2026-10-28T00:00:00.000Z', next_check_at = '2026-10-28T00:00:00.000Z' WHERE id = ?", [t.targetId]);
  return t;
};
const snapshot = (projectId: string, targetId: string) => ({
  target: db.get<Record<string, unknown>>("SELECT latest_outcome, latest_status_label FROM permit_check_targets WHERE id = ?", [targetId]),
  project: db.get<Record<string, unknown>>("SELECT status, current_stage, stage_detail FROM projects WHERE id = ?", [projectId]),
  checks: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM permit_status_checks WHERE target_id = ?", [targetId])!.n,
  reviewItems: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM human_review_items WHERE project_id = ?", [projectId])!.n,
});
const humanReviewChecks = (targetId: string) =>
  db.get<{ n: number }>("SELECT COUNT(*) AS n FROM permit_status_checks WHERE target_id = ? AND outcome = 'needs_human_review'", [targetId])!.n;

await check("(e1) THE POINT: issued + a public re-check that reads nothing -> still issued, nothing recorded, rescheduled, caller told", async () => {
  const { projectId, targetId } = await issuedTarget("519-26-001665-STR");
  const before = snapshot(projectId, targetId);
  reply = "";
  fetches.length = 0;
  const result = await repo.recordPermitStatusCheck(db, projectId, { targetId, source: "public_url" });
  assert.deepEqual(fetches, [ACA_OREGON], `the re-check did not reach the public fetch: ${JSON.stringify(fetches)}`);
  const after = snapshot(projectId, targetId);
  assert.equal(after.target?.latest_outcome, "issued", `an empty read replaced the issued status: ${JSON.stringify(after.target)}`);
  assert.deepEqual(after.target, before.target, "the target's status label moved");
  assert.deepEqual(after.project, before.project, "the project's status/stage moved on a read that gathered nothing");
  assert.equal(after.checks, before.checks, "a check row was written for a read that gathered nothing");
  assert.equal(humanReviewChecks(targetId), 0, "a needs_human_review row was written");
  assert.equal(after.reviewItems, before.reviewItems, "a human-review item was raised for a read that gathered nothing");
  const sched = db.get<{ last_checked_at: string; next_check_at: string }>("SELECT last_checked_at, next_check_at FROM permit_check_targets WHERE id = ?", [targetId])!;
  assert.ok(sched.last_checked_at > "2026-10-28T00:00:00.000Z" && sched.next_check_at > sched.last_checked_at, `not rescheduled: ${JSON.stringify(sched)}`);
  assert.match(String(result.unreadable), /no readable status.*nothing recorded/i, `the caller was not told: ${JSON.stringify(result.unreadable)}`);
  assert.equal(result.permitCheckTargets.find((t) => t.id === targetId)?.latestOutcome, "issued", "the returned detail does not show the kept status");
  const audit = fx.audits("permit_status.unreadable").map((a) => JSON.parse(a.details)).filter((d) => d.targetId === targetId);
  assert.equal(audit.length, 1, `the unread re-check was not audited: ${JSON.stringify(audit)}`);
});

await check("(e2) MUST-PASS a login page is nothing read: no row, and the sentence names the credential", async () => {
  const { projectId, targetId } = await issuedTarget("519-26-001666-ELEC");
  const before = snapshot(projectId, targetId);
  reply = "Accela Citizen Access Log In Username Password Forgot password? Register for an account";
  const result = await repo.recordPermitStatusCheck(db, projectId, { targetId, source: "public_url" });
  reply = "";
  const after = snapshot(projectId, targetId);
  assert.deepEqual(after.target, before.target, `a login page replaced the known status: ${JSON.stringify(after.target)}`);
  assert.equal(after.checks, before.checks);
  assert.equal(after.reviewItems, before.reviewItems);
  assert.match(String(result.unreadable), /login page/i, String(result.unreadable));
});

await check("(e3) MUST-PASS a NEVER-checked target still records the honest 'manual check required' row", async () => {
  const { projectId, targetId } = buildingTarget("519-26-009999-STR");
  reply = "";
  fetches.length = 0;
  const result = await repo.recordPermitStatusCheck(db, projectId, { targetId, source: "public_url" });
  assert.deepEqual(fetches, [ACA_OREGON]);
  assert.equal(result.unreadable, undefined, "a never-checked target's first read was swallowed");
  const rows = db.query<{ outcome: string; raw_status_text: string }>("SELECT outcome, raw_status_text FROM permit_status_checks WHERE target_id = ?", [targetId]);
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.equal(rows[0].outcome, "needs_human_review");
  assert.equal(rows[0].raw_status_text, PLACEHOLDER);
});

await check("(e4) MUST-PASS a pasted text on a known target is never 'empty' — even the placeholder itself", async () => {
  const { projectId, targetId } = await issuedTarget("519-26-001667-STR");
  const before = snapshot(projectId, targetId);
  fetches.length = 0;
  const result = await repo.recordPermitStatusCheck(db, projectId, { targetId, source: "manual", rawStatusText: PLACEHOLDER });
  assert.deepEqual(fetches, [], "a pasted text was re-fetched");
  assert.equal(result.unreadable, undefined, "a pasted text was treated as an empty read");
  assert.equal(snapshot(projectId, targetId).checks, before.checks + 1, "the operator's paste was not recorded");
});

repo.setStatusCheckSeamsForTests(null);
finish("emptyReadIsNotAStatus");
