// AN INFORMATION PAGE'S CANDIDATE IS SCRUBBED BEFORE IT IS KEPT (Helm's review of #349, nits).
//
// The learner keeps the held page as a candidate (settleInfoPagePass): its evidence text was scrubbed,
// but the DIGEST it also keeps — digest_json on the candidate row — carried every button's label
// (shape.controlLabels) and the forward control's (shape.controlLabel, control.label) in clear. A
// portal that prints an account number or an email on a button kept it. And redactCaptureText, the
// scrub both use, left a 5-digit account number in clear (it masked 6+ digit runs only, to their last 4).
//
//   MUST PASS    — the kept digest's labels are scrubbed like the evidence: a 10-digit account to its
//                  last 4, a 5-digit one WHOLE, an email masked; "Next" / "Previous" unchanged, and the
//                  identity hash untouched (the scrub never changes what is matched).
//   MUST EXCLUDE — a year or a 4-digit house number is not masked; a second pass changes nothing.
//
//   npx tsx portal-bot/src/adapters/infoPageCandidateScrub.test.ts
// Constructing the learner starts a debug bundle (LearnRunDebug.start) — keep it out of data/learn-runs.
import "../smokeArtifactDirs";
import assert from "node:assert/strict";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";
import { redactCaptureText } from "../safeAction";
import { INFO_PAGE_IDENTITY_VERSION, digestInfoPageIdentity, type InfoPageIdentityMaterial } from "../../../shared/src/infoPagePass";

let failures = 0;
let total = 0;
const check = (label: string, fn: () => void): void => {
  total++;
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${e instanceof Error ? e.message : String(e)}`); }
};

check("redactCaptureText: a 5-digit run is masked WHOLE, 6+ to the last 4, an email masked; a year and a house number kept; idempotent", () => {
  const raw = "Account 48213 or 7734-009-155, mail jo@solar.example. Since 2026 at 1234 Main St.";
  const once = redactCaptureText(raw);
  assert.ok(!once.includes("48213") && once.includes("*****"), once);
  assert.ok(!once.includes("7734") && once.includes("9155"), once);
  assert.ok(!once.includes("jo@solar.example") && once.includes("[email]"), once);
  assert.ok(once.includes("2026") && once.includes("1234 Main St"), once);
  assert.equal(redactCaptureText(once), once, "a second pass changes nothing");
});

const ORIGIN = "https://permits.example.test";
const material = (): InfoPageIdentityMaterial => ({
  version: INFO_PAGE_IDENTITY_VERSION,
  page: { origin: ORIGIN, path: "/permits/sfjsp", query: [] },
  title: "Development Hub Fixture",
  structure: {
    headings: [["1", "Development Hub Fixture"]],
    forms: [{ id: "smartguide_ApplyForAPermit", name: "", method: "post", enctype: "multipart/form-data", action: `${ORIGIN}/permits/sfjsp`, target: "", elements: [["button", "submit", "t_p1", null], ["button", "submit", "t_n1", null]] }],
    fillable: [], clickables: [["button", "submit", "t_p1", 0, ""], ["button", "submit", "t_n1", 0, ""]], frames: [],
  },
  facts: {
    fileInputsInForm: 0, customFormElements: 0, summaryOutsideChrome: 0, summaryInForm: 0,
    controlLabels: ["Previous", "Next", "Account 7734-009-155", "Ref 48213", "Help: jo@solar.example"],
    hiddenNames: [], masked: 0, baseTarget: "",
  },
  text: "Development Hub Fixture Permitting Information This is a permit request only. Previous Next",
  control: { tag: "button", type: "submit", name: "t_n1", value: "", label: "Next", formIndex: 0, submitterIndex: 1, method: "post", action: `${ORIGIN}/permits/sfjsp`, enctype: "multipart/form-data", target: "" },
  request: { method: "POST", url: `${ORIGIN}/permits/sfjsp`, media: "multipart/form-data", body: [["t_n1", ""]] },
});

const planner: LearnPlanner = async () => ({ fills: [], atReview: false });
type Settle = { settleInfoPagePass(door: unknown, step: unknown, before: number, shot: string | undefined, page: number): unknown; infoPageCandidate: { digest: { identitySha256: string; control: { label: string }; shape: { controlLabel: string; controlLabels: string[] } }; controlLabel: string } | null };
const m = material();
const digest = digestInfoPageIdentity(m);
const a = new AutoLearnAdapter("Candidate Scrub", planner, {}) as unknown as Settle;
const door = {
  closeInfoPagePass: () => undefined,
  takeInfoPageCandidate: () => ({ digest, prefix: [], material: m, observed: { method: "POST", where: digest.expected.where, actionUrlSha: digest.expected.actionUrlSha, media: digest.expected.media, body: digest.expected.body, hasFilenamePart: false } }),
  infoPageAdmissions: [],
};
a.settleInfoPagePass(door, { action: "click", note: "advance: Next" }, 0, undefined, 1);
const kept = a.infoPageCandidate;

check("premise: the learner kept the held page as a candidate", () => { assert.ok(kept && kept.digest, "no candidate kept"); });
check("the kept digest's button labels are scrubbed like the evidence: no account number, no 5-digit ref, no email", () => {
  const labels = kept!.digest.shape.controlLabels;
  const blob = JSON.stringify(kept!.digest);
  for (const leak of ["7734", "009-155", "48213", "jo@solar.example"]) assert.ok(!blob.includes(leak), `the kept digest carries ${leak}: ${JSON.stringify(labels)}`);
  assert.ok(labels.some((l) => l.includes("9155")) && labels.some((l) => l.includes("*****")) && labels.some((l) => l.includes("[email]")), JSON.stringify(labels));
});
check("the forward control's label is unchanged ('Next'), in the shape, the control and the card", () => {
  assert.equal(kept!.digest.control.label, "Next");
  assert.equal(kept!.digest.shape.controlLabel, "Next");
  assert.equal(kept!.controlLabel, "Next");
  assert.ok(kept!.digest.shape.controlLabels.includes("Previous") && kept!.digest.shape.controlLabels.includes("Next"));
});
check("the identity is untouched — the scrub never changes what a person verifies or what is matched", () => {
  assert.equal(kept!.digest.identitySha256, digest.identitySha256);
});
check("the backstop's own digest object is not mutated (the scrub copies)", () => {
  assert.ok(digest.shape.controlLabels.includes("Ref 48213"), JSON.stringify(digest.shape.controlLabels));
});

console.log(failures === 0 ? `\nAll ${total}/${total} infoPageCandidateScrub checks passed.` : `\n${failures}/${total} infoPageCandidateScrub check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
