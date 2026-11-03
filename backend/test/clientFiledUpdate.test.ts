// "WE FILED IT" — THE CLIENT HEARS THE DAY THEIR REVIEW CLOCK STARTS (#490).
//
// Clients heard from us only when something came back (issued / ready for issue / NEM approved /
// correction). The day a permit or NEM application went in, nothing was sent, so the client did
// not know their clock had started and phoned to ask. Now every door that records a CONFIRMED
// filing sends one update through the existing notifier (note + email, one voice):
//
//   (a) the gated auto-submit, when the portal ACCEPTED the filing
//   (b) a submit the portal did NOT confirm (submitted_unconfirmed) sends nothing — until a person
//       confirms it through the capture form, which then sends it
//   (c) the hand-over: a confident completion-page read in the left-open window
//       (an unconfident read sends nothing)
//   (d) the dashboard's capture form (captureConfirmation)
//   (e) the track card's "mark submitted" (markTrackSubmitted), NEM included
//
// and NEVER TWICE for one track: a re-capture of the same run, a later "mark submitted" of the
// same track, or a monitor re-read sends nothing more. Content: address, track, agency, record
// number, status link; never account/meter numbers or raw page text (e2). SMTP unset → a draft, like the others.
//
// KILL TESTS:
//   K1 drop the notifyClientOfFiling call in prepareSubmission → (a) fails.
//   K2 notify on every clicked run instead of acceptedFiling → (b) fails.
//   K3 drop the call in captureConfirmation → (b) (c) (d) fail.
//   K4 drop the call in markTrackSubmitted → (e) fails.
//   K5 drop the audit-marker check in notifyClientOfFiling → (d)+(f) and (e) fail (a second filed note).
//   K6 send the record number unscreened (no clientSafeRecordNumber) → (e2) fails.
//
// Run: npx tsx backend/test/clientFiledUpdate.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("client-filed-update");
const { db, repo } = fx;
const notifier = await import("../src/clientNotifier");
const filing = await import("../src/clientFilingUpdate");
const updates = await import("../src/clientUpdates");
const tracks = await import("../src/submittalTracks");

// Synthetic record numbers.
const RECORD = "519-26-004490-STR";
const NEM_RECORD = "APP-490490";
// The fixture's synthetic account / meter numbers — must never reach a client update.
const ACCOUNT = "1234567890";
const METER = "987654321";

// The notifier is fire-and-forget; its synchronous part (note + marker) is done when the door
// returns, the communication row lands after the (no-op, SMTP unset) send settles.
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

const filedNotes = (projectId: string) => db.query<{ body: string }>(
  "SELECT body FROM project_notes WHERE project_id = ? AND note_type = 'client_update' AND body LIKE 'We have filed%' ORDER BY created_at, rowid",
  [projectId],
);
const filedEmails = (projectId: string) => db.query<{ subject: string; body: string; delivery_status: string; recipient: string }>(
  "SELECT subject, body, delivery_status, recipient FROM communications WHERE project_id = ? AND subject LIKE '%application filed%' ORDER BY created_at, rowid",
  [projectId],
);
const markers = (projectId: string) => fx.audits(filing.FILING_ANNOUNCED_ACTION).filter((a) => a.project_id === projectId)
  .map((a) => JSON.parse(a.details) as { track: string; via: string });

const clickedResult = (verdict: "accepted" | "unknown") => ({
  portalName: "stub", ok: true, finalSubmitClicked: true, finalSubmitClickedByAutomation: true, pauseReason: null,
  capturedPermitNumber: verdict === "accepted" ? RECORD : "",
  steps: [
    { ok: true, message: "Opened stub portal." },
    { ok: true, message: "the approved final submit was CLICKED", data: { finalSubmitClicked: true, finalSubmitOutcome: { verdict, evidence: null } } },
  ],
});
const STAGED = {
  portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null,
  steps: [
    { ok: true, message: "Opened stub portal." },
    { ok: true, message: "Human review required. AUTOMATION HAS STOPPED.", data: { finalSubmitClicked: false } },
  ],
};
type Capture = Parameters<NonNullable<Parameters<typeof repo.setRecipeStageRunnerForTests>[0]>>[5] extends infer O
  ? O extends { onSubmitCaptured?: infer F } ? F : never : never;
type CaptureArg = Parameters<NonNullable<Capture>>[0];
const stageWith = async (projectId: string, result: unknown, during?: CaptureArg) => {
  fx.stubRunner(async (_r, _p, _v, _d, _f, o) => {
    if (during) (o?.onSubmitCaptured as Capture)?.(during);
    return result as never;
  });
  await repo.prepareSubmission(db, projectId);
  await settle();
};

fx.completeRecipe();

await check("(a) THE POINT: an auto-submit the portal ACCEPTED tells the client once — note, email draft, record number, agency, link", async () => {
  const projectId = fx.newProject();
  await stageWith(projectId, clickedResult("accepted"));
  assert.equal(fx.latestRun(projectId)!.status, "submitted");
  const notes = filedNotes(projectId);
  assert.equal(notes.length, 1, `expected one "we filed it" note, found ${notes.length}`);
  assert.match(notes[0].body, /Portland/, "the note does not name the agency");
  assert.match(notes[0].body, new RegExp(RECORD), "the note does not carry the record number");
  assert.match(notes[0].body, /Nothing needed from you/, "the note does not say whether anything is needed");
  const emails = filedEmails(projectId);
  assert.equal(emails.length, 1, `expected one filed email, found ${emails.length}`);
  assert.equal(emails[0].delivery_status, "draft", "SMTP unset must record a draft");
  assert.equal(emails[0].recipient, "ops@replaytrust.test");
  assert.match(emails[0].body, /\/status\?token=/, "the email has no status link");
  assert.match(emails[0].body, /101 Solar Way|Solar Way/, "the email does not carry the address");
  // ONE VOICE: the note's sentences are the email's.
  for (const line of notes[0].body.split(/(?<=\.)\s+/)) assert.ok(emails[0].body.includes(line), `the email lacks the note's sentence: ${line}`);
  assert.deepEqual(markers(projectId).map((m) => m.via), ["auto_submit"]);
});

await check("(b) a click the portal did NOT confirm sends nothing; the person's confirmation then sends it, once", async () => {
  const projectId = fx.newProject();
  await stageWith(projectId, clickedResult("unknown"));
  assert.equal(fx.latestRun(projectId)!.status, "submitted_unconfirmed");
  assert.equal(filedNotes(projectId).length, 0, "an unconfirmed click was announced to the client as filed");
  assert.equal(markers(projectId).length, 0, "an unconfirmed click claimed the once-per-track marker");
  repo.captureConfirmation(db, String(fx.latestRun(projectId)!.id), { applicationNumber: RECORD, submittedBy: "test operator" });
  await settle();
  assert.equal(filedNotes(projectId).length, 1, "the person's confirmation did not announce the filing");
  assert.equal(filedEmails(projectId).length, 1);
  assert.deepEqual(markers(projectId).map((m) => m.via), ["capture"]);
});

await check("(c) the hand-over: a confident completion-page read sends one update; an unconfident one sends none", async () => {
  const projectId = fx.newProject();
  await stageWith(projectId, STAGED, { recordNumber: RECORD, confidence: "high", reason: `Captured submission confirmation: ${RECORD}.`, recordLink: "" });
  assert.equal(fx.latestRun(projectId)!.status, "submitted");
  assert.equal(filedNotes(projectId).length, 1, "the hand-over capture did not announce the filing");
  assert.match(filedNotes(projectId)[0].body, new RegExp(RECORD));

  const unsure = fx.newProject();
  await stageWith(unsure, STAGED, { recordNumber: "", confidence: "low", reason: "Submitted; no record number found yet.", recordLink: "" });
  assert.equal(fx.latestRun(unsure)!.status, "awaiting_human_submit");
  assert.equal(filedNotes(unsure).length, 0, "an unconfident read (not a recorded filing) was announced");
});

await check("(d)+(f) the capture form sends once; a re-capture of the same run sends nothing more", async () => {
  const projectId = fx.newProject();
  await stageWith(projectId, STAGED);
  const runId = String(fx.latestRun(projectId)!.id);
  assert.equal(filedNotes(projectId).length, 0, "staging alone announced a filing");
  repo.captureConfirmation(db, runId, { applicationNumber: RECORD, submittedBy: "test operator" });
  await settle();
  assert.equal(filedNotes(projectId).length, 1);
  // The live database holds one run captured twice five minutes apart: the same news.
  repo.captureConfirmation(db, runId, { applicationNumber: RECORD, submittedBy: "test operator" });
  await settle();
  assert.equal(filedNotes(projectId).length, 1, "a re-capture of the same run sent the client a second filed update");
  assert.equal(filedEmails(projectId).length, 1, "a re-capture of the same run sent a second filed email");
  // The staging here is trackless, so the filing is announced as the "permit" track, once.
  assert.deepEqual(markers(projectId).map((m) => m.track), ["permit"]);
});

await check("(e) the track card's mark-submitted door: a NEM filing names the utility and the interconnection; never account/meter numbers", async () => {
  const projectId = fx.newProject();
  const detail = repo.getProjectDetail(db, projectId);
  assert.ok(tracks.requiredTracks(detail.project).includes("nem"), "fixture has no NEM track");
  tracks.markTrackSubmitted(db, detail.project, "nem", { applicationNumber: NEM_RECORD });
  await settle();
  const notes = filedNotes(projectId);
  assert.equal(notes.length, 1, `expected one filed note, found ${notes.length}`);
  assert.match(notes[0].body, /interconnection application with PGE/, notes[0].body);
  assert.match(notes[0].body, new RegExp(NEM_RECORD));
  const email = filedEmails(projectId)[0];
  assert.ok(email, "no filed email recorded");
  assert.match(email.subject, /Interconnection application filed/);
  for (const secret of [ACCOUNT, METER]) {
    assert.ok(!email.body.includes(secret) && !email.subject.includes(secret) && !notes[0].body.includes(secret), `a client update carried ${secret}`);
  }
  // A second mark of the same track: no resend. The permit track is a different filing: it sends.
  tracks.markTrackSubmitted(db, detail.project, "nem", { applicationNumber: NEM_RECORD });
  await settle();
  assert.equal(filedNotes(projectId).length, 1, "re-marking the NEM track resent");
  const permitTrack = tracks.requiredTracks(detail.project).find((t) => t !== "nem")!;
  tracks.markTrackSubmitted(db, detail.project, permitTrack, { applicationNumber: RECORD });
  await settle();
  assert.equal(filedNotes(projectId).length, 2, "the permit track's own filing was swallowed by the NEM track's marker");
  assert.deepEqual(markers(projectId).map((m) => m.track).sort(), ["nem", permitTrack].sort());
});

await check("(e2) RULE 2: a 'record number' carrying the account or meter number, or raw page text, is dropped — the update still goes, without it", async () => {
  const projectId = fx.newProject();
  const detail = repo.getProjectDetail(db, projectId);
  // The account number typed into the case-number box, with separators (redactSecretValues ignores them).
  tracks.markTrackSubmitted(db, detail.project, "nem", { applicationNumber: "123-456-7890" });
  const permitTrack = tracks.requiredTracks(detail.project).find((t) => t !== "nem")!;
  // Raw completion-page prose captured as the number, with the meter number inside it.
  tracks.markTrackSubmitted(db, detail.project, permitTrack, {
    applicationNumber: `Thank you! Your application for meter ${METER} was received. Reference will follow by email.`,
  });
  await settle();
  const notes = filedNotes(projectId);
  assert.equal(notes.length, 2, `expected both filings announced, found ${notes.length}`);
  const emails = filedEmails(projectId);
  assert.equal(emails.length, 2);
  for (const out of [...notes.map((n) => n.body), ...emails.flatMap((e) => [e.subject, e.body])]) {
    const digits = out.replace(/\D/g, "");
    assert.ok(!digits.includes(ACCOUNT) && !digits.includes(METER), `a client update carried an account/meter number: ${out}`);
    assert.doesNotMatch(out, /Thank you|was received|\[redacted\]/, `raw page text or a redaction marker reached the client: ${out}`);
    assert.doesNotMatch(out, /reference/i, `a dropped number still left a "reference" phrase: ${out}`);
  }
  // The helper itself: a real record number passes, a secret-bearing one does not.
  assert.equal(filing.clientSafeRecordNumber(RECORD, [ACCOUNT, METER]), RECORD);
  assert.equal(filing.clientSafeRecordNumber("APP 9876 54321", [ACCOUNT, METER]), "");
});

await check("(g) a monitor reading can never send it: 'filed' is not a monitor outcome", () => {
  assert.equal(updates.isClientFacingOutcome(updates.CLIENT_FILED_EVENT), false);
  assert.equal(notifier.shouldNotifyClient(updates.CLIENT_FILED_EVENT, null, { trusted: true }), false);
  assert.equal(notifier.shouldNotifyClient("waiting", null, { trusted: true }), false);
});

await check("(h) the usual review time is quoted only from a MEASURED median of at least 3 filings", async () => {
  const projectId = fx.newProject();
  const detail = repo.getProjectDetail(db, projectId);
  const key = (await import("../src/knowledgeBase")).knowledgeProfileKey({ state: "OR", ahj: "", utility: "PGE" });
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO permit_utility_knowledge (id, profile_key, state, ahj, utility, average_timeline_days, timeline_sample_count, confidence, first_seen_at, last_learned_at, updated_at)
     VALUES (?, ?, 'OR', '', 'PGE', 17.6, 1, 'learned', ?, ?, ?)
     ON CONFLICT(profile_key) DO UPDATE SET average_timeline_days = 17.6, timeline_sample_count = 1`,
    [`kb-${projectId}`, key, now, now, now],
  );
  assert.equal(filing.usualReviewDays(db, { nem: true, state: "OR", agency: "PGE", utility: "PGE" }), null, "one filing was quoted as the usual time");
  db.run("UPDATE permit_utility_knowledge SET timeline_sample_count = 3 WHERE profile_key = ?", [key]);
  assert.equal(filing.usualReviewDays(db, { nem: true, state: "OR", agency: "PGE", utility: "PGE" }), 17.6);
  tracks.markTrackSubmitted(db, detail.project, "nem", { applicationNumber: NEM_RECORD });
  await settle();
  assert.match(filedNotes(projectId)[0]?.body ?? "", /about 18 days to be approved/, filedNotes(projectId)[0]?.body);
});

await check("(i) the kill switch: CLIENT_NOTIFICATIONS=off sends nothing and claims no marker, so the filing is still announced once it is on", async () => {
  const projectId = fx.newProject();
  const detail = repo.getProjectDetail(db, projectId);
  process.env.CLIENT_NOTIFICATIONS = "off";
  try {
    tracks.markTrackSubmitted(db, detail.project, "nem", { applicationNumber: NEM_RECORD });
    await settle();
  } finally { delete process.env.CLIENT_NOTIFICATIONS; }
  assert.equal(filedNotes(projectId).length, 0);
  assert.equal(markers(projectId).length, 0, "a silenced project claimed the marker");
  tracks.markTrackSubmitted(db, detail.project, "nem", { applicationNumber: NEM_RECORD });
  await settle();
  assert.equal(filedNotes(projectId).length, 1);
});

finish("client filed update");
