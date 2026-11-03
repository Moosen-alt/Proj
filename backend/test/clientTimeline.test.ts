// THE CLIENT'S TIMELINE OF ONE JOB (#497): filed → issued / approved → installed → final → PTO.
//
// One server function (clientTimeline.buildClientTimeline) builds it from the tracks panel's own
// status (submittalTracks.trackProgress) and the recorded closeout milestones; both client pages
// (the per-project status link and the per-client tracker) publish it. Recording a client-facing
// closeout milestone sends the one-voice client update (note + email) once.
//
//   MUST SHOW   — each stage as a fixture job moves: preparing; filed (dated) with the review step
//                 current and its days so far; the usual days only from a measured median of ≥3
//                 filings; issued / approved with how long they took; the closeout one step at a
//                 time to PTO granted; a correction named in the client's words.
//   MUST EXCLUDE — record numbers, account/meter values, raw portal text and internal notes on the
//                 timeline; another project's or another client's milestones on a link; a second
//                 client update for the same milestone (re-record, clear + re-record); any client
//                 update for "installed"; a date in the future; an unknown milestone.
//
// KILL TESTS:
//   K1 read submissions of any status for filedAt (drop `status = 'submitted'`) → (b) fails.
//   K2 quote typicalDays without the n≥3 rule (read average_timeline_days alone) → (c) fails.
//   K3 drop the announced-marker check in announceMilestone → (g) fails (a second note).
//   K4 add "installed" to CLIENT_MILESTONE_EVENTS → (g) fails.
//   K5 select project_milestones without the project_id filter → (i) fails.
//
//   npx tsx backend/test/clientTimeline.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "client-timeline-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.SMTP_HOST;
delete process.env.SMTP_FROM;
delete process.env.CLIENT_NOTIFICATIONS;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject, getProjectDetail } = await import("../src/repository");
const { ensureClientPortalToken, clientPortalPayload, publicProjectStatusPayload } = await import("../src/clientPortal");
const { ensureStatusShareToken } = await import("../src/clientNotifier");
const { knowledgeProfileKey } = await import("../src/knowledgeBase");
const timelineMod = await import("../src/clientTimeline");
const { clientUpdateFor, CLIENT_FACING_OUTCOMES } = await import("../src/clientUpdates");
const { buildClientTimeline, recordProjectMilestone, clearProjectMilestone, projectMilestones, milestoneInstant, MILESTONE_ANNOUNCED_ACTION } = timelineMod;

const db = await openDatabase();

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

// Synthetic values only.
const PERMIT_RECORD = "519-26-004497-STR";
const ELEC_RECORD = "519-26-004498-ELEC";
const NEM_RECORD = "APP-497497";
const RAW_PORTAL_TEXT = "Examiner J. Smith 555-0199 says Plan Review Complete";
const PM_NOTE = "client is chasing, do not mention the re-inspection fee yet";

const ours = createClient(db, { companyName: "Timeline Solar", ccbLicenseNumber: "497001", businessEmail: "ops@timeline.test" });
const theirs = createClient(db, { companyName: "Other Solar", ccbLicenseNumber: "497002", businessEmail: "ops@other.test" });
const mk = (clientId: string, owner: string, street: string) => createProject(db, {
  clientId, owner, street, city: "Coos Bay", state: "OR", ahj: "City of Coos Bay",
  utility: "Pacific Power", dcKw: "8", acKw: "6.4",
}).project;

const job = mk(ours.id, "Timeline Owner", "1 Timeline St");
const sibling = mk(ours.id, "Sibling Owner", "2 Timeline St");
const foreign = mk(theirs.id, "Foreign Owner", "99 Elsewhere Ln");

const NOW = new Date("2026-11-02T12:00:00.000Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const timeline = (projectId: string) => buildClientTimeline(db, getProjectDetail(db, projectId).project, NOW);
const step = (projectId: string, key: string) => {
  const s = timeline(projectId).steps.find((x) => x.key === key);
  assert.ok(s, `no ${key} step on the timeline`);
  return s!;
};

let seq = 0;
const submit = (projectId: string, permitType: string, at: string, status = "submitted", app = PERMIT_RECORD) => db.run(
  `INSERT INTO submissions (id, project_id, submission_type, status, application_number, permit_type, submitted_at, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  [`sub-${++seq}`, projectId, permitType === "nem" ? "interconnection" : "permit", status, app, permitType, at, at],
);
const target = (projectId: string, targetType: string, permitType: string, app: string, at: string) => {
  const id = `tgt-${++seq}`;
  db.run(
    `INSERT INTO permit_check_targets (id, project_id, target_type, permit_type, application_number, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    [id, projectId, targetType, permitType, app, at, at],
  );
  return id;
};
const reading = (projectId: string, targetId: string, outcome: string, label: string, at: string) => {
  db.run(
    `INSERT INTO permit_status_checks (id, project_id, target_id, source, raw_status_text, status_label, outcome, created_at)
     VALUES (?, ?, ?, 'portal', ?, ?, ?, ?)`,
    [`chk-${++seq}`, projectId, targetId, RAW_PORTAL_TEXT, label, outcome, at],
  );
  db.run("UPDATE permit_check_targets SET latest_outcome = ?, latest_status_label = ?, last_checked_at = ?, updated_at = ? WHERE id = ?",
    [outcome, label, at, at, targetId]);
};
const clientNotes = (projectId: string) => db.query<{ body: string }>(
  "SELECT body FROM project_notes WHERE project_id = ? AND note_type = 'client_update' ORDER BY created_at, rowid", [projectId],
).map((r) => r.body);

await check("(a) before filing: the permit and interconnection filings are current and 'being prepared'; nothing later is", () => {
  const steps = timeline(job.id).steps;
  assert.deepEqual(steps.map((s) => s.key),
    ["permit_filed", "permit_issued", "nem_filed", "nem_approved", "installed", "final_passed", "pto_requested", "pto_granted"]);
  assert.deepEqual(steps.filter((s) => s.state === "current").map((s) => s.key), ["permit_filed", "nem_filed"]);
  assert.equal(steps[0].detail, "Being prepared");
  // Every step is listed from day one, so a label never states an outcome (readingProvenance.test).
  assert.ok(steps.every((s) => !/approved|issued|granted|passed|filed|requested|installed/i.test(s.label)), JSON.stringify(steps.map((s) => s.label)));
  assert.ok(steps.slice(4).every((s) => s.state === "upcoming"), JSON.stringify(steps));
});

await check("(a2) a job with no utility has no interconnection or PTO steps", () => {
  const noUtility = createProject(db, { clientId: ours.id, owner: "No Utility", street: "3 Timeline St", city: "Coos Bay", state: "OR", ahj: "City of Coos Bay", utility: "", dcKw: "5", acKw: "4" }).project;
  assert.deepEqual(timeline(noUtility.id).steps.map((s) => s.key), ["permit_filed", "permit_issued", "installed", "final_passed"]);
});

// An Oregon job files a building AND an electrical permit (the state rule requiredTracks reads).
await check("premise: the fixture job files two permits and an interconnection", () => {
  assert.equal(step(job.id, "permit_filed").label, "Permit applications");
});
// A staged (not yet sent) permit: still not filed. Then the real filings.
submit(job.id, "building", day(20), "awaiting_human_submit");
await check("(b) a staged application is not filed: no date, 'Prepared — final submission in progress'", () => {
  const s = step(job.id, "permit_filed");
  assert.equal(s.state, "current");
  assert.equal(s.at, null);
  assert.equal(s.detail, "Prepared — final submission in progress");
});
submit(job.id, "building", day(12));
await check("(b2) one of two permits sent: the filing step says so and the review step has started", () => {
  assert.equal(step(job.id, "permit_filed").state, "current");
  assert.equal(step(job.id, "permit_filed").detail, "1 of 2 filed");
  assert.equal(step(job.id, "permit_issued").state, "current");
});
submit(job.id, "electrical", day(11), "submitted", ELEC_RECORD);
submit(job.id, "nem", day(10), "submitted", NEM_RECORD);
const permitTarget = target(job.id, "permit", "building", PERMIT_RECORD, day(12));
const elecTarget = target(job.id, "permit", "electrical", ELEC_RECORD, day(11));
const nemTarget = target(job.id, "nem", "nem", NEM_RECORD, day(10));
reading(job.id, permitTarget, "waiting", "In Review", day(11));
reading(job.id, elecTarget, "waiting", "In Review", day(10));
reading(job.id, nemTarget, "waiting", "In Review", day(9));

await check("(b) filed: dated by the sent submission; the review steps are current with their days so far", () => {
  const filed = step(job.id, "permit_filed");
  assert.equal(filed.state, "done");
  assert.equal(filed.at, day(11), "the step completes when its LAST filing was sent (never the staged row's date)");
  const issued = step(job.id, "permit_issued");
  assert.equal(issued.state, "current");
  assert.equal(issued.daysSoFar, 12, "the review clock starts at the FIRST filing");
  const nem = step(job.id, "nem_approved");
  assert.equal(nem.state, "current");
  assert.equal(nem.daysSoFar, 10);
  assert.equal(step(job.id, "installed").state, "upcoming");
});

await check("(c) the usual days appear only from a measured median of at least 3 filings", () => {
  assert.equal(step(job.id, "permit_issued").typicalDays, null, "no history, no figure");
  const key = knowledgeProfileKey({ state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power" });
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO permit_utility_knowledge (id, profile_key, state, ahj, utility, average_timeline_days, timeline_sample_count, confidence, first_seen_at, last_learned_at, updated_at)
     VALUES ('kb-497', ?, 'OR', 'City of Coos Bay', 'Pacific Power', 17.6, 2, 'learned', ?, ?, ?)
     ON CONFLICT(profile_key) DO UPDATE SET average_timeline_days = 17.6, timeline_sample_count = 2`,
    [key, now, now, now],
  );
  assert.equal(step(job.id, "permit_issued").typicalDays, null, "two filings were quoted as the usual time");
  db.run("UPDATE permit_utility_knowledge SET timeline_sample_count = 3 WHERE profile_key = ?", [key]);
  assert.equal(step(job.id, "permit_issued").typicalDays, 18);
  assert.equal(step(job.id, "permit_filed").typicalDays, null, "a done step carries no usual figure");
});

await check("(d0) one of two permits issued reads as such, and the step stays current", () => {
  reading(job.id, elecTarget, "issued", "Permit Issued", day(5));
  assert.equal(step(job.id, "permit_issued").state, "current");
  assert.equal(step(job.id, "permit_issued").detail, "1 of 2 permits issued");
});

await check("(d) a correction reads in the client's words, never the portal's", () => {
  reading(job.id, permitTarget, "correction_flagged", "Correction Flagged", day(8));
  assert.equal(step(job.id, "permit_issued").detail, "Correction requested — we are on it");
});

reading(job.id, permitTarget, "issued", "Permit Issued", day(2));
reading(job.id, nemTarget, "nem_approved", "NEM / Interconnection Approved", day(1));

await check("(e) issued and approved: dated at the reading that closed them, with how long each took", () => {
  const issued = step(job.id, "permit_issued");
  assert.equal(issued.state, "done");
  assert.equal(issued.at, day(2));
  assert.equal(issued.tookDays, 10);
  assert.equal(issued.typicalDays, null);
  assert.equal(issued.detail, "All permits issued", "the outcome word appears once the step is done");
  const nem = step(job.id, "nem_approved");
  assert.equal(nem.state, "done");
  assert.equal(nem.at, day(1));
  assert.equal(nem.tookDays, 9);
  assert.equal(nem.detail, "Approved");
  assert.equal(step(job.id, "installed").state, "current", "the install is next once the permit is issued");
});

await check("(f) the closeout moves one step at a time to PTO granted", () => {
  recordProjectMilestone(db, job.id, { milestone: "installed", at: "2026-10-30", recordedBy: "pm@keelix.test", now: NOW });
  assert.equal(step(job.id, "installed").at, "2026-10-30T12:00:00.000Z", "a bare date is stored at noon UTC");
  assert.equal(step(job.id, "final_passed").state, "current");
  assert.equal(step(job.id, "final_passed").daysSoFar, 3);
  recordProjectMilestone(db, job.id, { milestone: "final_passed", at: "2026-10-31", recordedBy: "pm@keelix.test", now: NOW });
  assert.equal(step(job.id, "final_passed").tookDays, 1);
  assert.equal(step(job.id, "pto_requested").state, "current");
  recordProjectMilestone(db, job.id, { milestone: "pto_requested", at: "2026-11-01", recordedBy: "pm@keelix.test", now: NOW });
  assert.equal(step(job.id, "pto_granted").state, "current");
  recordProjectMilestone(db, job.id, { milestone: "pto_granted", at: "2026-11-02", recordedBy: "pm@keelix.test", now: NOW });
  const steps = timeline(job.id).steps;
  assert.ok(steps.every((s) => s.state === "done"), JSON.stringify(steps.map((s) => [s.key, s.state])));
  assert.equal(steps.find((s) => s.key === "pto_granted")!.tookDays, 1);
});

await check("(g) each client-facing milestone sends ONE client update; 'installed' sends none; re-record and clear + re-record send nothing more", async () => {
  await settle();
  const notes = clientNotes(job.id);
  assert.equal(notes.filter((b) => /passed the final inspection/.test(b)).length, 1, notes.join("\n"));
  assert.equal(notes.filter((b) => /Permission to operate has been requested from Pacific Power/.test(b)).length, 1, notes.join("\n"));
  assert.equal(notes.filter((b) => /Pacific Power has granted permission to operate/.test(b)).length, 1, notes.join("\n"));
  assert.ok(!notes.some((b) => /install/i.test(b) && !/permission|final/i.test(b)), `an 'installed' update was sent: ${notes.join("\n")}`);
  const emails = db.query<{ subject: string; delivery_status: string }>(
    "SELECT subject, delivery_status FROM communications WHERE project_id = ? AND subject LIKE '%Final inspection passed%'", [job.id],
  );
  assert.equal(emails.length, 1, "the email channel carries the same one update");
  assert.equal(emails[0].delivery_status, "draft", "SMTP unset → a draft, like every other client update");
  // The installer requests PTO for now (owner, 2026-11-02): the final-passed update hands them that
  // step, matching the handoff checklist, and every client email signs off with the brand.
  assert.ok(notes.some((b) => /send the signed final inspection card to Pacific Power to request permission to operate/.test(b)), notes.join("\n"));
  assert.ok(!notes.some((b) => /We have asked .* for permission to operate/.test(b)), "the PTO update must not claim we requested it");
  const finalBody = String(db.get<{ body: string }>(
    "SELECT body FROM communications WHERE project_id = ? AND subject LIKE '%Final inspection passed%'", [job.id])?.body ?? "");
  assert.match(finalBody, /\n— Keelix \(automated update; reply to reach the team\)$/, finalBody);
  assert.doesNotMatch(finalBody, /Solar Submission Autopilot/);

  recordProjectMilestone(db, job.id, { milestone: "final_passed", at: "2026-10-30", recordedBy: "pm@keelix.test", now: NOW });
  clearProjectMilestone(db, job.id, "pto_granted", "pm@keelix.test");
  assert.equal(step(job.id, "pto_granted").state, "current", "a cleared milestone is not done");
  recordProjectMilestone(db, job.id, { milestone: "pto_granted", at: "2026-11-02", recordedBy: "pm@keelix.test", now: NOW });
  await settle();
  const after = clientNotes(job.id);
  assert.equal(after.filter((b) => /passed the final inspection/.test(b)).length, 1, "a re-recorded date re-sent the update");
  assert.equal(after.filter((b) => /granted permission to operate/.test(b)).length, 1, "clear + re-record re-sent the update");
  const markers = db.query<{ details: string }>("SELECT details FROM audit_logs WHERE project_id = ? AND action = ?", [job.id, MILESTONE_ANNOUNCED_ACTION]);
  assert.equal(markers.length, 3);
});

await check("(h) refused: an unknown milestone, a date that is not a date, a date in the future", () => {
  assert.throws(() => recordProjectMilestone(db, job.id, { milestone: "permit_issued", recordedBy: "x", now: NOW }), /Unknown milestone/);
  assert.throws(() => recordProjectMilestone(db, job.id, { milestone: "installed", at: "soon", recordedBy: "x", now: NOW }), /not a date/);
  assert.throws(() => milestoneInstant("2026-11-05", NOW), /future/);
  assert.equal(milestoneInstant("2026-11-03", NOW), "2026-11-03T12:00:00.000Z", "a person west of UTC recording today is not refused");
  assert.throws(() => recordProjectMilestone(db, "no-such-project", { milestone: "installed", recordedBy: "x", now: NOW }), /not found/);
});

await check("(i) SCOPE: a status link and a client tracker carry only their own jobs' milestones", () => {
  recordProjectMilestone(db, foreign.id, { milestone: "installed", at: "2026-10-01", recordedBy: "x", now: NOW });
  assert.equal(projectMilestones(db, sibling.id).find((m) => m.key === "installed")!.at, null, "another project's milestone leaked");
  const status = publicProjectStatusPayload(db, ensureStatusShareToken(db, sibling.id))!;
  assert.equal(status.timeline.steps.find((s) => s.key === "installed")!.state, "upcoming");
  const portal = clientPortalPayload(db, ensureClientPortalToken(db, ours.id))!;
  assert.ok(!portal.projects.some((p) => p.id === foreign.id), "another client's job is on this tracker");
  const mine = portal.projects.find((p) => p.id === job.id)!;
  assert.ok(mine.timeline.steps.length === 8 && mine.timeline.steps.every((s) => s.state === "done"), JSON.stringify(mine.timeline));
  assert.equal(portal.projects.find((p) => p.id === sibling.id)!.timeline.steps[0].state, "current");
});

await check("(j) RULE 2: no record number, account/meter value, portal text or internal note on any timeline", () => {
  db.run(
    "INSERT INTO project_notes (id, project_id, note_type, body, created_by, created_at) VALUES ('pm-497', ?, 'pm_note', ?, 'pm', ?)",
    [job.id, PM_NOTE, new Date().toISOString()],
  );
  // Synthetic account / meter values on the job itself.
  db.run("UPDATE projects SET account_number = '4970012345', meter_number = '497654321' WHERE id = ?", [job.id]);
  const secrets = ["4970012345", "497654321"];
  const blobs = [
    JSON.stringify(timeline(job.id)),
    JSON.stringify(publicProjectStatusPayload(db, ensureStatusShareToken(db, job.id))!.timeline),
    JSON.stringify(clientPortalPayload(db, ensureClientPortalToken(db, ours.id))!.projects.map((p) => p.timeline)),
  ];
  for (const blob of blobs) {
    for (const needle of [PERMIT_RECORD, ELEC_RECORD, NEM_RECORD, RAW_PORTAL_TEXT, "555-0199", PM_NOTE, ...secrets]) {
      assert.ok(!blob.includes(needle), `"${needle}" reached a client timeline`);
    }
  }
  assert.ok(!clientNotes(job.id).some((b) => b.includes(PM_NOTE)), "an internal note became a client update");
});

await check("(k) the wording: three closeout updates, each answering 'anything needed from me' (final passed: the PTO request is theirs); none for 'installed'; none in the monitor's gate", () => {
  const project = getProjectDetail(db, job.id).project;
  for (const m of ["final_passed", "pto_requested", "pto_granted"]) {
    const u = clientUpdateFor(db, project, m, { targetType: m === "final_passed" ? "permit" : "nem" });
    // final_passed hands the installer the PTO request (they file it for now, owner 2026-11-02);
    // the other two need nothing from the client.
    const expected = m === "final_passed" ? /^Next for you: send the signed final inspection card/ : /^Nothing needed from you/;
    assert.ok(u && u.headline && u.meaning && expected.test(u.action), `${m}: ${JSON.stringify(u)}`);
    assert.ok(!(CLIENT_FACING_OUTCOMES as readonly string[]).includes(m), `${m} is in the monitor's reading gate`);
  }
  assert.equal(clientUpdateFor(db, project, "installed", { targetType: "permit" }), null);
  assert.match(clientUpdateFor(db, project, "pto_requested", { targetType: "nem" })!.meaning, /stays off/);
});

console.log(failures === 0 ? "\nAll clientTimeline checks passed." : `\n${failures} clientTimeline check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
