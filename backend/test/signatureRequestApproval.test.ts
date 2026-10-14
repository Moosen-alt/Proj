// A NAMED PERSON'S APPROVAL OF ONE RUN'S SIGNATURE REQUEST (#308; owner ruling 2026-10-14 on #305).
//
// PSE PowerClerk's "Request Signatures" emails the homeowner a DocuSign request. The bot clicks it only
// in a run a named person approved; signatureRequestApproval.ts is that approval. Pinned on the REAL
// prepareSubmission with only the browser stubbed:
//   (a) the approval is claimed BY ID before the first gate, its id becomes the run's id, and it is
//       consumed: a second run with the same id claims nothing (audited, named);
//   (b) a run a gate refuses has spent its approval (operator hold → 409, approval consumed);
//   (c) a FINAL-SUBMIT approval's id is never claimed as a signature-request approval (separate
//       tables), and a signature-request approval never arms the final submit: the stage carries
//       autoSubmit false and no runApproval;
//   (d) blank approvers, non-NEM tracks, another project's id and expired rows are refused;
//   (e) the stage result carries the signature step's state as the run's review state, and the NEM
//       track card reads it (submittalTracks signatureRequest).
//
// KILL TESTS:
//   K1 claimSignatureRequestApproval: drop the consumed_at UPDATE → (a) second claim succeeds, fails.
//   K2 prepareSubmission: claim after the operator-hold gate instead of before → (b) fails.
//   K3 prepareSubmission: pass the signature approval as runApproval → (c) fails.
//   K4 seedOutcomeToStageResult: drop the reviewState spread → (e) fails.
//
// Run: npx tsx backend/test/signatureRequestApproval.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("signature-request-approval");
const { db, repo, recipes } = fx;
const sra = await import("../src/signatureRequestApproval");
const { seedOutcomeToStageResult } = await import("../src/portalChannel");
const { getSubmittalTracks } = await import("../src/submittalTracks");

// A complete NEM recipe for the fixture's utility (so the NEM stage replays through the stub).
{
  const r = recipes.startPortalRecording(db, {
    scopeType: "utility", state: "OR", ahj: "Portland", utility: "PGE",
    portalUrl: "https://pge.powerclerk.example/MvcAccount/Login", portalPlatform: "powerclerk", createdBy: "test",
  });
  recipes.savePortalRecipeSteps(db, r.id, [...fx.fills(3), fx.REVIEW, fx.FINAL], { status: "complete", notes: "Auto-learned and verified (high confidence)." });
}

let lastOptions: Record<string, unknown> | null = null;
let runnerCalls = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
fx.stubRunner((async (...args: any[]) => {
  runnerCalls += 1;
  lastOptions = (args[5] ?? null) as Record<string, unknown> | null;
  return { portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null, steps: [{ ok: true, message: "Human review required. AUTOMATION HAS STOPPED.", data: { finalSubmitClicked: false } }] };
}) as never);

const consumed = (id: string) => db.get<{ consumed_at: string | null }>("SELECT consumed_at FROM portal_signature_request_approvals WHERE id = ?", [id])?.consumed_at ?? null;

await check("(a) claimed by id before the first gate; its id becomes the run's id; single use", async () => {
  const projectId = fx.newProject();
  const a = sra.createSignatureRequestApproval(db, { projectId, track: "nem", approver: "Pat Approver" });
  runnerCalls = 0;
  await repo.prepareSubmission(db, projectId, "nem", false, false, null, a.id);
  assert.equal(runnerCalls, 1, "the stage did not run");
  assert.ok(consumed(a.id), "the approval was not consumed");
  assert.equal(String(fx.latestRun(projectId)?.id), a.id, "the run did not adopt the approval's id");
  const claimed = fx.audits("portal.signature_request_approval_claimed").filter((x) => x.project_id === projectId);
  assert.equal(claimed.length, 1);
  assert.equal(JSON.parse(claimed[0].details).approvedBy, "Pat Approver");
  // The same id again: nothing to claim, named; the run gets a fresh id.
  await repo.prepareSubmission(db, projectId, "nem", false, false, null, a.id);
  assert.equal(fx.audits("portal.signature_request_approval_missing").filter((x) => x.project_id === projectId).length, 1);
  assert.notEqual(String(fx.latestRun(projectId)?.id), a.id);
  assert.equal(sra.claimSignatureRequestApproval(db, projectId, "nem", a.id), null, "a spent approval was claimed again");
});

await check("(b) a run a gate refuses has spent its approval (operator hold)", async () => {
  const projectId = fx.newProject();
  const a = sra.createSignatureRequestApproval(db, { projectId, track: "nem", approver: "Pat Approver" });
  db.run("UPDATE projects SET status = 'blocked' WHERE id = ?", [projectId]);
  let status = 0;
  try { await repo.prepareSubmission(db, projectId, "nem", false, false, null, a.id); }
  catch (e) { status = Number((e as { status?: number }).status ?? 0); }
  assert.equal(status, 409, "the operator hold did not refuse the run");
  assert.ok(consumed(a.id), "a refused run left its approval live for the next request");
});

await check("(c) the two approvals never stand in for each other; a signature approval never arms the final submit", async () => {
  const projectId = fx.newProject();
  const finalApproval = repo.createRunApproval(db, { projectId, track: "nem", approver: "Pat Approver" });
  assert.equal(sra.claimSignatureRequestApproval(db, projectId, "nem", finalApproval.id), null, "a final-submit approval was claimed as a signature request");
  const a = sra.createSignatureRequestApproval(db, { projectId, track: "nem", approver: "Pat Approver" });
  lastOptions = null;
  await repo.prepareSubmission(db, projectId, "nem", false, false, null, a.id);
  assert.ok(lastOptions, "the stage did not run");
  assert.equal(lastOptions!.autoSubmit, false, "a signature-request approval armed autoSubmit");
  assert.equal(lastOptions!.runApproval, null, "a signature-request approval reached the final-submit gate as a runApproval");
  assert.equal(lastOptions!.allowFinalSubmit, false);
});

await check("(d) blank approver, a non-NEM track, another project's id and an expired row are refused", async () => {
  const projectId = fx.newProject();
  assert.throws(() => sra.createSignatureRequestApproval(db, { projectId, track: "nem", approver: "   " }), /named approver/);
  assert.throws(() => sra.createSignatureRequestApproval(db, { projectId, track: "building", approver: "Pat Approver" }), /utility/);
  const a = sra.createSignatureRequestApproval(db, { projectId, track: "nem", approver: "Pat Approver" });
  const other = fx.newProject();
  assert.equal(sra.claimSignatureRequestApproval(db, other, "nem", a.id), null, "another project's approval was claimed");
  assert.equal(sra.claimSignatureRequestApproval(db, projectId, "building", a.id), null, "another track claimed it");
  db.run("UPDATE portal_signature_request_approvals SET expires_at = ? WHERE id = ?", [new Date(Date.now() - 1000).toISOString(), a.id]);
  assert.equal(sra.claimSignatureRequestApproval(db, projectId, "nem", a.id), null, "an expired approval was claimed");
  assert.equal(sra.claimSignatureRequestApproval(db, projectId, "nem", ""), null);
});

await check("(e) the signature step's state is the run's review state, and the NEM track card reads it", async () => {
  const r = seedOutcomeToStageResult({ status: "draft", pauseReason: null, message: "m", signatureStep: { state: "awaiting_signature_request" } });
  assert.equal(r.reviewState, "awaiting_signature_request");
  assert.equal(r.finalSubmitClicked, false);
  assert.equal(seedOutcomeToStageResult({ status: "draft", pauseReason: null, message: "m" }).reviewState, undefined);
  const projectId = fx.newProject();
  await repo.prepareSubmission(db, projectId, "nem");
  const run = fx.latestRun(projectId)!;
  db.run("UPDATE portal_runs SET result_json = ? WHERE id = ?", [JSON.stringify({ ...JSON.parse(String(run.result_json || "{}")), reviewState: "awaiting_signature_request" }), String(run.id)]);
  const project = repo.getProjectDetail(db, projectId).project;
  const nem = getSubmittalTracks(db, project).find((t) => t.type === "nem");
  assert.equal(nem?.signatureRequest?.state, "awaiting_signature_request", JSON.stringify(nem?.signatureRequest));
});

fx.stubRunner(null as never);
finish("signatureRequestApproval");
