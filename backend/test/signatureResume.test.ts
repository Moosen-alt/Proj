// RESUME AFTER THE HOMEOWNER SIGNS (#310): the NEM track between Request Signatures and the filing,
// and the step 5 Submit under hard rule 1's gate, unchanged.
//
// Pinned on the real modules (prepareSubmission with only the browser stubbed, as the #308 tests):
//   (a) THE TRANSITIONS (signatureTrack.reduceNemSignatureState): staged → awaiting signature request
//       (the #308 stop) → awaiting customer signature (an approved click, or a person's confirmation,
//       which applies ONLY in front of Request Signatures) → ready to submit (a resume read it signed)
//       → awaiting human submit (signed, staged up to step 5's Submit) → submitted (filed). A run that
//       read nothing about the signature never moves the track back; filed wins.
//   (b) A PERSON'S CONFIRMATION is recorded with who and when, refused without a name, refused when the
//       track is not in front of Request Signatures, and the track card then reads "Awaiting customer
//       signature" with "Check signature now" as the next action — never submitted.
//   (c) A RESUME'S READ becomes the run's review state (seedOutcomeToStageResult): signed and stopped at
//       the Submit → awaiting_human_submit; signed short of it → ready_to_submit; not signed or
//       unreadable → awaiting_customer_signature; never requested → the re-staged signature step's
//       own state. finalSubmitClicked is false on every one.
//   (d) THE GATE, UNCHANGED, JUDGES THE RECIPE THAT RUNS: a project with a draft on record has its stage
//       continue that draft, so the NEM recipe on file (recorded through Part 1, whose Submit is its one
//       valid terminal isFinalSubmit click) never counts — with an approval of this run and
//       PORTAL_ALLOW_FINAL_SUBMIT=1, the gate refuses (the same project without a draft is allowed:
//       the setup is otherwise clean).
//   (e) Without the approval, or without PORTAL_ALLOW_FINAL_SUBMIT=1, the resume is refused at the gate.
//   (f) A burned approval (spent by a run a gate refused) refuses the next run.
//   (g) The next-step answer names the signature wait and never asks for a submit.
//
// KILL TESTS:
//   K1 reduceNemSignatureState: apply a confirmation from any state → (a) "ignored after" fails.
//   K2 repository.ts: gateRecipeId = recipe?.id (drop the nemDraft clause) → (d) fails.
//   K3 seedOutcomeToStageResult: drop resumeState → (c) fails.
//   K4 submittalTracks: drop signatureHolds → (b) card label fails.
//   K5 nextStep rule 10a removed → (g) fails.
//
// Run: npx tsx backend/test/signatureResume.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("signature-resume");
const { db, repo, recipes } = fx;
const st = await import("../src/signatureTrack");
const draftMod = await import("../src/portalDraft");
const { seedOutcomeToStageResult } = await import("../src/portalChannel");
const { getSubmittalTracks } = await import("../src/submittalTracks");
const next = await import("../src/nextStep");

// THE NEM RECIPE ON FILE, recorded through Part 1: its one flagged terminal click (after a
// stopForReview — a VALID shape) is Part 1's Submit, the click that only made the draft (#302).
{
  const r = recipes.startPortalRecording(db, {
    scopeType: "utility", state: "OR", ahj: "Portland", utility: "PGE",
    portalUrl: "https://pge.powerclerk.example/MvcAccount/Login", portalPlatform: "powerclerk", createdBy: "test",
  });
  recipes.savePortalRecipeSteps(db, r.id, [...fx.fills(3), fx.REVIEW, { ...fx.FINAL, selector: { text: "Submit" }, note: "Part 1 submit" }],
    { status: "complete", notes: "Auto-learned and verified (high confidence)." });
}

let runnerCalls = 0;
let lastOptions: Record<string, unknown> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
fx.stubRunner((async (...args: any[]) => {
  runnerCalls += 1;
  lastOptions = (args[5] ?? null) as Record<string, unknown> | null;
  return { portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null, steps: [{ ok: true, message: "Human review required. AUTOMATION HAS STOPPED.", data: { finalSubmitClicked: false } }] };
}) as never);

const recordDraft = (projectId: string) => draftMod.recordPortalDraft(db, {
  projectId, track: "nem", source: "learn",
  draft: { applicationNumber: "NEM-90017", nextForm: "Interconnection Application - Part 2", evidence: "synthetic", strength: "status" },
});
/** Stage the NEM track once (the stubbed replay) and give that run a review state. */
const runWithReviewState = async (projectId: string, reviewState: string, extra: Record<string, unknown> = {}) => {
  await repo.prepareSubmission(db, projectId, "nem");
  const run = fx.latestRun(projectId)!;
  db.run("UPDATE portal_runs SET result_json = ? WHERE id = ?", [JSON.stringify({ ...JSON.parse(String(run.result_json || "{}")), reviewState, ...extra }), String(run.id)]);
  return String(run.id);
};
const nemCard = (projectId: string) => getSubmittalTracks(db, repo.getProjectDetail(db, projectId).project).find((t) => t.type === "nem")!;
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const declined = (projectId: string) => fx.audits("portal.auto_submit_declined").filter((a) => a.project_id === projectId).map((a) => JSON.parse(a.details));
const allowed = (projectId: string) => fx.audits("portal.auto_submit_allowed").filter((a) => a.project_id === projectId);

await check("(a) the transitions, in order, and a confirmation only in front of Request Signatures", () => {
  const R = (reviewState: string, at: string) => ({ kind: "run" as const, reviewState, at });
  const C = (by: string, at: string) => ({ kind: "confirmed" as const, by, at });
  const reduce = st.reduceNemSignatureState;
  assert.equal(reduce([], null), null, "nothing staged is not a signature state");
  assert.equal(reduce([R("", "t1")], null), null, "a run that read nothing is no event");
  assert.equal(reduce([R("awaiting_signature_request", "t1")], null)?.state, "awaiting_signature_request");
  const confirmed = reduce([R("awaiting_signature_request", "t1"), C("Pat Operator", "t2")], null);
  assert.equal(confirmed?.state, "awaiting_customer_signature");
  assert.equal(confirmed?.by, "Pat Operator");
  assert.equal(reduce([R("signature_request_unconfirmed", "t1"), C("Pat Operator", "t2")], null)?.state, "awaiting_customer_signature");
  assert.equal(reduce([R("awaiting_customer_signature", "t1")], null)?.state, "awaiting_customer_signature", "an approved click whose status reads requested");
  // Ignored anywhere else: before any staging, after it was already requested, after it was signed.
  assert.equal(reduce([C("Pat Operator", "t1")], null), null, "a confirmation with nothing staged moved the track");
  assert.equal(reduce([C("Pat Operator", "t0"), R("awaiting_signature_request", "t1")], null)?.state, "awaiting_signature_request", "an OLDER confirmation applied to a newer stop");
  assert.equal(reduce([R("ready_to_submit", "t1"), C("Pat Operator", "t2")], null)?.state, "ready_to_submit", "a confirmation moved a signed track back");
  // The resume: still waiting (a resume that read requested or unreadable), then signed, then at the Submit.
  const flow = [R("awaiting_signature_request", "t1"), C("Pat Operator", "t2"), R("awaiting_customer_signature", "t3")];
  assert.equal(reduce(flow, null)?.state, "awaiting_customer_signature");
  assert.equal(reduce([...flow, R("ready_to_submit", "t4")], null)?.state, "ready_to_submit");
  assert.equal(reduce([...flow, R("ready_to_submit", "t4"), R("awaiting_human_submit", "t5")], null)?.state, "awaiting_human_submit");
  // Filed wins over everything.
  assert.equal(reduce([...flow, R("awaiting_human_submit", "t5")], { at: "t6" })?.state, "submitted");
  assert.equal(st.nemStageIsResume({ state: "awaiting_customer_signature", at: "t" }), true);
  assert.equal(st.nemStageIsResume({ state: "ready_to_submit", at: "t" }), true);
  assert.equal(st.nemStageIsResume({ state: "awaiting_signature_request", at: "t" }), false, "a stage in front of Request Signatures is not a resume");
  assert.equal(st.nemStageIsResume(null), false);
});

await check("(b) a person's confirmation: named, recorded, only in front of Request Signatures; the card never reads submitted", async () => {
  const projectId = fx.newProject();
  assert.throws(() => st.confirmSignatureRequestSent(db, projectId, { confirmedBy: "Pat Operator" }), /nothing to confirm/, "confirmed with nothing staged");
  await runWithReviewState(projectId, "awaiting_signature_request");
  assert.equal(nemCard(projectId).signatureRequest?.state, "awaiting_signature_request");
  assert.match(nemCard(projectId).statusLabel, /awaiting signature request/i);
  assert.throws(() => st.confirmSignatureRequestSent(db, projectId, { confirmedBy: "   " }), /who sent/, "a blank name was recorded");
  await sleepMs(5);
  const view = st.confirmSignatureRequestSent(db, projectId, { confirmedBy: "Pat Operator" });
  assert.equal(view.state, "awaiting_customer_signature");
  assert.equal(view.by, "Pat Operator");
  const audit = fx.audits(st.SIGNATURE_REQUEST_CONFIRMED_ACTION).filter((a) => a.project_id === projectId);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_name, "Pat Operator");
  assert.throws(() => st.confirmSignatureRequestSent(db, projectId, { confirmedBy: "Pat Operator" }), /not in front of Request Signatures/, "confirmed twice");
  const card = nemCard(projectId);
  assert.equal(card.signatureRequest?.state, "awaiting_customer_signature");
  assert.equal(card.signatureRequest?.by, "Pat Operator");
  assert.equal(card.statusLabel, "Awaiting customer signature", card.statusLabel);
  assert.match(card.nextAction, /Check signature now/);
  assert.doesNotMatch(card.statusLabel, /submitted/i);
  assert.equal(st.nemStageIsResume(st.nemSignatureState(db, projectId)), true, "a stage now would not be a resume");
  // A resume that read signed and stopped at the Submit: the card says so, still not filed.
  await sleepMs(5);
  await runWithReviewState(projectId, "awaiting_human_submit", { signatureCheck: { state: "signed", why: "every signature status reads signed" } });
  const after = nemCard(projectId);
  assert.equal(after.signatureRequest?.state, "awaiting_human_submit");
  assert.match(after.statusLabel, /Signed — staged, awaiting manual submit/);
  assert.notEqual(after.status, "submitted");
});

await check("(c) a resume's read is the run's review state; nothing reads as clicked", () => {
  const signedAtSubmit = seedOutcomeToStageResult({ status: "draft", pauseReason: null, message: "m", signatureCheck: { state: "signed" }, finalSubmitRecorded: true });
  assert.equal(signedAtSubmit.reviewState, "awaiting_human_submit");
  assert.equal(signedAtSubmit.finalSubmitClicked, false);
  assert.equal(seedOutcomeToStageResult({ status: "draft", pauseReason: null, message: "m", signatureCheck: { state: "signed" }, finalSubmitRecorded: false }).reviewState, "ready_to_submit");
  assert.equal(seedOutcomeToStageResult({ status: "failed", pauseReason: null, message: "m", signatureCheck: { state: "signed" }, finalSubmitRecorded: true }).reviewState, "ready_to_submit",
    "a failed walk read as staged at the Submit");
  const waiting = seedOutcomeToStageResult({ status: "draft", pauseReason: null, message: "m", signatureCheck: { state: "awaiting_customer_signature" } });
  assert.equal(waiting.reviewState, "awaiting_customer_signature");
  assert.equal(waiting.finalSubmitClicked, false);
  assert.equal(seedOutcomeToStageResult({ status: "draft", pauseReason: null, message: "m", signatureCheck: { state: "not_requested" }, signatureStep: { state: "awaiting_signature_request" } }).reviewState,
    "awaiting_signature_request", "a never-requested read did not hand the run to the re-staged signature step");
});

await check("(d) a draft on record: the Part 1 recipe's terminal Submit never counts — the gate refuses; without a draft it allows", async () => {
  process.env.PORTAL_AUTOSEED = "0";
  process.env.PORTAL_ALLOW_FINAL_SUBMIT = "1";
  try {
    const control = fx.newProject();
    const a0 = repo.createRunApproval(db, { projectId: control, track: "nem", approver: "Pat Approver" });
    await repo.prepareSubmission(db, control, "nem", true, false, a0.id);
    assert.equal(allowed(control).length, 1, `the control (no draft) was not allowed — the setup is not clean: ${JSON.stringify(declined(control))}`);

    const projectId = fx.newProject();
    recordDraft(projectId);
    const a = repo.createRunApproval(db, { projectId, track: "nem", approver: "Pat Approver" });
    runnerCalls = 0;
    await repo.prepareSubmission(db, projectId, "nem", true, false, a.id);
    assert.equal(allowed(projectId).length, 0, "the Part 1 recipe's Submit was counted as the continuation's terminal click");
    const d = declined(projectId);
    assert.equal(d.length, 1);
    assert.ok(d[0].reasons.some((r: string) => /no recorded recipe drives this run/.test(r)), JSON.stringify(d[0].reasons));
    assert.equal(d[0].continuesDraft, "NEM-90017");
    assert.equal(d[0].approvedBy, "Pat Approver");
    assert.equal(runnerCalls, 0, "the replay ran on a project with a draft");
  } finally {
    delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
  }
});

await check("(e) a resume without the approval, or without PORTAL_ALLOW_FINAL_SUBMIT=1, is refused at the gate", async () => {
  const projectId = fx.newProject();
  recordDraft(projectId);
  // No approval: Approve & auto-submit asked, nobody named.
  process.env.PORTAL_ALLOW_FINAL_SUBMIT = "1";
  try { await repo.prepareSubmission(db, projectId, "nem", true, false, null); } finally { delete process.env.PORTAL_ALLOW_FINAL_SUBMIT; }
  let d = declined(projectId);
  assert.equal(d.length, 1);
  assert.ok(d[0].reasons.includes("no named person approved this run"), JSON.stringify(d[0].reasons));
  // An approval, the switch off.
  const a = repo.createRunApproval(db, { projectId, track: "nem", approver: "Pat Approver" });
  await repo.prepareSubmission(db, projectId, "nem", true, false, a.id);
  d = declined(projectId);
  assert.equal(d.length, 2);
  assert.ok(d[1].reasons.includes("PORTAL_ALLOW_FINAL_SUBMIT is not 1 on this process"), JSON.stringify(d[1].reasons));
  assert.equal(allowed(projectId).length, 0);
});

await check("(f) a burned approval refuses the next run", async () => {
  const projectId = fx.newProject();
  recordDraft(projectId);
  const a = repo.createRunApproval(db, { projectId, track: "nem", approver: "Pat Approver" });
  db.run("UPDATE projects SET status = 'blocked' WHERE id = ?", [projectId]);
  let status = 0;
  try { await repo.prepareSubmission(db, projectId, "nem", true, false, a.id); } catch (e) { status = Number((e as { status?: number }).status ?? 0); }
  assert.equal(status, 409, "the operator hold did not refuse the run");
  db.run("UPDATE projects SET status = 'ready_to_stage' WHERE id = ?", [projectId]);
  process.env.PORTAL_ALLOW_FINAL_SUBMIT = "1";
  try { await repo.prepareSubmission(db, projectId, "nem", true, false, a.id); } finally { delete process.env.PORTAL_ALLOW_FINAL_SUBMIT; }
  assert.equal(fx.audits("portal.run_approval_missing").filter((x) => x.project_id === projectId).length, 1, "the spent approval was not reported missing");
  const d = declined(projectId);
  assert.ok(d.length >= 1 && d[d.length - 1].reasons.includes("no named person approved this run"), JSON.stringify(d));
  assert.equal(allowed(projectId).length, 0);
});

await check("(g) the next-step answer names the signature wait and never asks for a submit", async () => {
  const projectId = fx.newProject();
  await runWithReviewState(projectId, "awaiting_signature_request");
  await sleepMs(5);
  st.confirmSignatureRequestSent(db, projectId, { confirmedBy: "Pat Operator" });
  const project = repo.getProjectDetail(db, projectId).project;
  const facts = next.loadNextStepFacts(db, [project]).get(projectId)!;
  const nem = facts.tracks.find((t) => t.track === "nem")!;
  assert.equal(nem.signatureState, "awaiting_customer_signature");
  // Only the NEM track is on the portal; the QC and gate rules are passed so rule 10 is reached.
  const step = next.decideNextStep({ ...facts, qcRan: true, qcFails: [], qcReview: [], jobInFlight: null, operatorHold: null, openCorrections: [], portalReadings: 0,
    tracks: facts.tracks.map((t) => (t.track === "nem" ? t : { ...t, stagedRun: null, latestRun: null, onPortal: false })) });
  assert.equal(step.key, "awaiting_signature", `${step.key}: ${step.headline}`);
  assert.equal(step.who, "customer");
  assert.match(step.headline, /homeowner's DocuSign signature/);
  assert.doesNotMatch(step.headline, /click its submit|approve/i);
});

lastOptions = null;
void lastOptions;
fx.stubRunner(null as never);
finish("signatureResume");
