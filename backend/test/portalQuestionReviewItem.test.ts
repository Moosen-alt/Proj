// A PORTAL QUESTION A RUN LEFT BLANK IS ASKED AS THAT QUESTION (#544).
//
// Owner, 2026-11-02, on a PacifiCorp job: the learn left "Will the System be Customer-Owned or
// Third-Party Owned?" blank (by design: the planner never guesses a per-job answer), and the person
// met it as a "Run triage" item whose text was the agent's engineering note and whose suggestion
// ("Add a systemOwnership field … and bind it to this question") sat in an editable box — Save Edit
// wrote that sentence into the project under "systemOwnership". The question itself could not be
// answered there.
//
// Through the REAL write paths, stub LLM (no ANTHROPIC_API_KEY), synthetic data only:
//   T1  triage on a run bundle whose plan left the ownership select blank (a decision bound to the
//       per-job key with no value, and the run's required-miss list naming it) files ONE review item
//       carrying the question in the portal's words and its options (placeholder removed) — and no
//       engineering text in llm_suggested_value / notes. A blank NON-per-job question gets no item.
//       An older triage note about the same question is closed (the person meets it once).
//   T2  it stays advisory (never holds staging: the per-job stage gate does that), and the run's
//       triage note records the question.
//   T3  GET /portal-questions (portalQuestionStatus) lists it with the item's options — with no
//       recipe in the bank at all.
//   T4  POST /portal-questions (answerPortalQuestions): an answer outside the portal's options is a
//       400 that writes nothing and leaves the item pending; one of them writes the snapshot and the
//       v17 column and CLOSES the item; the question is then no longer open.
//   T5  re-triage files no duplicate; a job that already answered gets no item.
//   T6  the intake link's answer closes it too (submitIntakeRequest).
//   T7  A QUESTION THE OPERATOR'S STANDING ANSWER SETTLES IS NOT ASKED (skeptic, round 1). A learn that
//       left PGE's "Is your disconnect within 10 feet of the PGE utility meter?" blank (a select that
//       did not hold, the decision bound to disconnectWithin10ft = "Yes") must file no question item,
//       add nothing to the open portal questions or the client intake (that question reaching the
//       homeowner's intake on every PGE job is the defect OPERATOR_POLICY_ANSWERS fixed), and must not
//       displace the bank's own question for the key either way: one the policy settles stays settled,
//       a recipe step bound to it with no value ("bound-empty") is still asked.
//   T8  an answer that reaches the job through another door (a project save) is closed by the next
//       triage instead of staying pending.
//
//   npx tsx backend/test/portalQuestionReviewItem.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

delete process.env.ANTHROPIC_API_KEY;
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";
process.env.CODE_RESEARCH = "off";

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const { triageLearnRun } = await import("../src/runTriage");
const { portalQuestionStatus, answerPortalQuestions, createIntakeRequest, submitIntakeRequest, unansweredPortalQuestions, setPortalQuestionSource } = await import("../src/intakeRequests");
const { intakeNeedsFor, intakeHeld } = await import("../src/clientRequestLinks");
const { learnRunsDir } = await import("../src/statePaths");

const db = await openDatabase();

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const Q = "Will the System be Customer-Owned or Third-Party Owned?";
const INSTALLER_Q = "Who will install this generation system?";
const newProject = (over: Record<string, unknown> = {}): string => R.createProject(db, {
  owner: "Sample Homeowner", street: "100 Example Ave", city: "Sampleville", state: "OR", zip: "97000",
  ahj: "City of Sampleville", utility: "Sample Power", dcKw: "4.4", acKw: "3.8", ...over,
} as never, undefined, { learningExcluded: true }).project.id;

let runSeq = 0;
/** A learn-run bundle as autoLearnAdapter writes it: result.json + one page plan. */
function writeBundle(): string {
  const runId = `learn-544-${Date.now()}-${++runSeq}`;
  const dir = path.join(learnRunsDir(), runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({
    status: "needs_review", pageCount: 3, finalSubmitRecorded: false,
    verification: { accurate: false, confidence: "medium", issues: [`Required field(s) left blank/unselected — fill before trusting: ${Q}; ${INSTALLER_Q}.`] },
  }));
  fs.writeFileSync(path.join(dir, "p003-plan.json"), JSON.stringify({
    page: 3, title: "System Information",
    fieldsSeen: [
      { i: 0, type: "select", label: Q, options: ["-- Select --", "Customer-Owned", "Third-Party Owned"] },
      { i: 1, type: "select", label: INSTALLER_Q, options: ["-- Select --", "Contractor", "Self"] },
      { i: 2, type: "text", label: "System Size (kW DC)" },
    ],
    decisions: [
      { index: 0, label: Q, boundField: "ownershipModel", value: "", source: "data-bound" },
      { index: 2, label: "System Size (kW DC)", boundField: "systemSizeDcKw", value: "4.4", source: "data-bound" },
    ],
  }));
  return runId;
}
const items = (projectId: string) => R.getProjectDetail(db, projectId).humanReviewItems;
const questionItems = (projectId: string) => items(projectId).filter((i) => i.portalQuestion);
/** The pre-#544 shape runTriage wrote for the same miss (engineering text in the item). */
function legacyNote(projectId: string): string {
  const id = `legacy-${++runSeq}`;
  const ts = new Date().toISOString();
  db.run(
    `INSERT INTO human_review_items (id, project_id, issue_type, field_name, parser_value, llm_suggested_value, source_excerpt, status, notes, created_at, updated_at)
     VALUES (?, ?, 'Run triage', 'systemOwnership', '', ?, ?, 'pending', ?, ?, ?)`,
    [id, projectId, "Add a systemOwnership field to the project record and bind it to this question so the planner can map it.",
      `Required question '${Q}' left blank`, "The project record has no system-ownership attribute, so the planner had nothing to map.", ts, ts],
  );
  return id;
}

const p1 = newProject();
const legacy = legacyNote(p1);
const run1 = writeBundle();
const triage = await triageLearnRun(db, run1, p1);

await check("T1 the blank per-job select becomes ONE item: the portal's question and its options, placeholder removed", () => {
  const qs = questionItems(p1);
  assert.equal(qs.length, 1, JSON.stringify(items(p1).map((i) => [i.issueType, i.fieldName, i.status])));
  const it = qs[0];
  assert.equal(it.status, "pending");
  assert.deepEqual(it.portalQuestion, { key: "ownershipModel", label: Q, options: ["Customer-Owned", "Third-Party Owned"], control: "select" });
  assert.equal(it.fieldName, "ownershipModel");
  assert.equal(it.sourceExcerpt, Q);
  assert.equal(triage.questionsAsked?.length, 1);
});
await check("T1 no engineering text rides on the item (suggestion and root cause are not in the item)", () => {
  const it = questionItems(p1)[0];
  assert.equal(it.llmSuggestedValue, "");
  assert.equal(it.notes, "");
});
await check("T1 a blank NON-per-job required question ('who will install') files no question item", () => {
  assert.ok(!items(p1).some((i) => i.portalQuestion?.label === INSTALLER_Q || i.sourceExcerpt === INSTALLER_Q));
});
await check("T1 the older triage note about the same question is closed: the person meets it once", () => {
  const note = items(p1).find((i) => i.id === legacy)!;
  assert.notEqual(note.status, "pending");
});
await check("T2 advisory: the item never holds staging (the per-job stage gate does)", () => {
  const it = questionItems(p1)[0];
  assert.equal(it.issueType, "Run triage");
  assert.equal(R.isCriticalReviewItem(it), false);
});
await check("T2 the run's triage note records the question asked", () => {
  const notes = R.getProjectDetail(db, p1).projectNotes ?? [];
  assert.ok(notes.some((n: { body: string }) => n.body.includes(run1) && n.body.includes(Q)), JSON.stringify(notes.map((n: { body: string }) => n.body)));
});
await check("T3 GET /portal-questions lists it with the item's options (no recipe in the bank)", async () => {
  const st = await portalQuestionStatus(db, p1);
  const q = st.questions.find((x) => x.key === "ownershipModel");
  assert.ok(q, JSON.stringify(st));
  assert.equal(q!.label, Q);
  assert.deepEqual(q!.options, ["Customer-Owned", "Third-Party Owned"]);
});
await check("T4 an answer outside the portal's options is a 400 that writes nothing; the item stays pending", async () => {
  await assert.rejects(answerPortalQuestions(db, p1, { ownershipModel: "PPA" }), (err: { status?: number }) => err.status === 400);
  assert.equal(questionItems(p1)[0].status, "pending");
  const col = db.get<{ ownership_model: string | null }>("SELECT ownership_model FROM projects WHERE id = ?", [p1]);
  assert.ok(!col?.ownership_model, `wrote ${col?.ownership_model}`);
});
await check("T4 one of the portal's options saves as this job's answer and CLOSES the item", async () => {
  const out = await answerPortalQuestions(db, p1, { ownershipModel: "Third-Party Owned" });
  assert.deepEqual(out.written, ["ownershipModel"]);
  const it = questionItems(p1)[0];
  assert.equal(it.status, "edited");
  const col = db.get<{ ownership_model: string }>("SELECT ownership_model FROM projects WHERE id = ?", [p1]);
  assert.equal(col?.ownership_model, "Third-Party Owned");
  assert.equal(String(R.getProjectDetail(db, p1).project.parserSnapshot?.ownershipModel ?? ""), "Third-Party Owned");
  const st = await portalQuestionStatus(db, p1);
  assert.ok(!st.questions.some((x) => x.key === "ownershipModel"), "still listed as open");
  assert.equal(R.getProjectDetail(db, p1).humanReviewItems.filter((i) => i.status === "pending" && i.issueType === "Run triage").length, 0);
});
await check("T5 re-triage of the same run on the answered job files no new item", async () => {
  await triageLearnRun(db, run1, p1);
  assert.equal(questionItems(p1).length, 1);
});
await check("T5 re-triage while still unanswered files no duplicate", async () => {
  const p2 = newProject({ owner: "Second Sample" });
  await triageLearnRun(db, writeBundle(), p2);
  await triageLearnRun(db, writeBundle(), p2);
  assert.equal(questionItems(p2).filter((i) => i.status === "pending").length, 1);
});
await check("T5 a job that already answered the question gets no item", async () => {
  const p3 = newProject({ owner: "Third Sample" });
  db.run("UPDATE projects SET ownership_model = 'Customer-Owned' WHERE id = ?", [p3]);
  await triageLearnRun(db, writeBundle(), p3);
  assert.equal(questionItems(p3).length, 0);
});
await check("T6 the intake link's answer closes the item too", async () => {
  const p4 = newProject({ owner: "Fourth Sample", homeownerEmail: "owner@example.test", homeownerPhone: "555-0100", jobValue: "20000" });
  await triageLearnRun(db, writeBundle(), p4);
  assert.equal(questionItems(p4)[0]?.status, "pending");
  const req = await createIntakeRequest(db, p4, { fields: ["homeownerPhone"] });
  assert.ok(req.questions.some((q) => q.key === "ownershipModel"), JSON.stringify(req.questions));
  submitIntakeRequest(db, req.token, { ownershipModel: "Customer-Owned" });
  assert.equal(questionItems(p4)[0].status, "edited");
});

// ---- T7: the operator's standing answer settles the disconnect-distance question -------------------
const DQ = "Is your disconnect within 10 feet of the PGE utility meter?";
/** A PGE-shaped learn whose disconnect select did not hold: the planner bound it to the standing "Yes",
 *  and the run's verification still lists it as a required field left blank. */
function writeDisconnectBundle(): string {
  const runId = `learn-544-dq-${Date.now()}-${++runSeq}`;
  const dir = path.join(learnRunsDir(), runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({
    status: "needs_review", pageCount: 2, finalSubmitRecorded: false,
    verification: { accurate: false, confidence: "medium", issues: [`Required field(s) left blank/unselected — fill before trusting: ${DQ}.`] },
  }));
  fs.writeFileSync(path.join(dir, "p002-plan.json"), JSON.stringify({
    page: 2, title: "Equipment",
    fieldsSeen: [{ i: 0, type: "select", label: DQ, options: ["-- Select --", "Yes", "No"] }],
    decisions: [{ index: 0, label: DQ, boundField: "disconnectWithin10ft", value: "Yes", source: "data-bound" }],
  }));
  return runId;
}
const openQuestions = async (projectId: string) => unansweredPortalQuestions(db, R.getProjectDetail(db, projectId).project);
const { parsePerJobPortalQuestion } = await import("../../shared/src/perJobQuestions");

await check("T7 a blank the operator's standing answer settles files no question item", async () => {
  const p = newProject({ owner: "Seventh Sample" });
  const t = await triageLearnRun(db, writeDisconnectBundle(), p);
  assert.equal(questionItems(p).length, 0, JSON.stringify(questionItems(p).map((i) => i.portalQuestion)));
  assert.equal(t.questionsAsked?.length ?? 0, 0, t.message);
});
await check("T7 ... and adds nothing to the open portal questions or the client intake", async () => {
  const p = newProject({ owner: "Seventh Sample B", homeownerEmail: "owner7@example.test" });
  const needsBefore = await intakeNeedsFor(db, R.getProjectDetail(db, p).project);
  await triageLearnRun(db, writeDisconnectBundle(), p);
  assert.ok(!(await openQuestions(p)).some((q) => q.key === "disconnectWithin10ft"), JSON.stringify(await openQuestions(p)));
  const st = await portalQuestionStatus(db, p);
  assert.ok(!st.questions.some((q) => q.key === "disconnectWithin10ft"), JSON.stringify(st.questions));
  const needsAfter = await intakeNeedsFor(db, R.getProjectDetail(db, p).project);
  assert.ok(!JSON.stringify(needsAfter.questions).includes("within 10 feet"), JSON.stringify(needsAfter.questions));
  assert.deepEqual(needsAfter.questions, needsBefore.questions);
  assert.equal(intakeHeld(needsAfter), intakeHeld(needsBefore));
});
await check("T7 a stored question row for the settled key is not read back as a question", () => {
  assert.equal(parsePerJobPortalQuestion(JSON.stringify({ key: "disconnectWithin10ft", label: DQ, options: ["Yes", "No"], control: "select" })), null);
  assert.ok(parsePerJobPortalQuestion(JSON.stringify({ key: "ownershipModel", label: Q, options: ["Customer-Owned", "Third-Party Owned"], control: "select" })));
});
try {
  await check("T7 the bank's question the policy settles stays settled (not displaced by the run's blank)", async () => {
    setPortalQuestionSource(() => [{ key: "disconnectWithin10ft", label: DQ, options: ["Yes", "No"], kind: "radio-choice" }]);
    const p = newProject({ owner: "Seventh Sample C" });
    assert.ok(!(await openQuestions(p)).some((q) => q.key === "disconnectWithin10ft"), "settled before the triage");
    await triageLearnRun(db, writeDisconnectBundle(), p);
    assert.ok(!(await openQuestions(p)).some((q) => q.key === "disconnectWithin10ft"), JSON.stringify(await openQuestions(p)));
  });
  await check("T7 the bank's bound-empty question for the key is still asked, as the bank's", async () => {
    setPortalQuestionSource(() => [{ key: "disconnectWithin10ft", label: DQ, options: ["Yes", "No"], kind: "bound-empty" }]);
    const p = newProject({ owner: "Seventh Sample D" });
    await triageLearnRun(db, writeDisconnectBundle(), p);
    const q = (await openQuestions(p)).find((x) => x.key === "disconnectWithin10ft");
    assert.ok(q, "the recipe-bound blank is no longer asked");
    assert.equal(q!.kind, "bound-empty", JSON.stringify(q));
  });
} finally {
  setPortalQuestionSource(null);
}

// ---- T8: an answer through another door is closed by the next triage -------------------------------
await check("T8 a project save answers the question; the next triage closes the item instead of leaving it pending", async () => {
  const p = newProject({ owner: "Eighth Sample" });
  await triageLearnRun(db, writeBundle(), p);
  assert.equal(questionItems(p)[0]?.status, "pending");
  R.updateProject(db, p, { ownershipModel: "Customer-Owned" } as never);
  assert.equal(String(R.getProjectDetail(db, p).project.parserSnapshot?.ownershipModel ?? ""), "Customer-Owned");
  await triageLearnRun(db, writeBundle(), p);
  const all = questionItems(p);
  assert.equal(all.length, 1, JSON.stringify(all.map((i) => [i.status, i.fieldName])));
  assert.equal(all[0].status, "approved");
});

// ---- T9: a note is closed only when it names THAT question (skeptic, round 2) ----------------------
// The first cut matched notes by the ownership key's classifier regex (customer.?owned|third.?party|
// financ|lease|ppa|owner ship…), project-wide, the moment the question was ASKED: real findings that
// only mention one of those words vanished from Human Review. A note is that question only when it
// quotes the question's own label.
const UNRELATED = [
  "The city asks whether a third-party inspector will be used.",
  "The utility asks for the signed lease agreement document.",
  "The utility asks for the third-party owner's company name.",
  "The utility asks for the main breaker rating.",
  "Upload proof of property ownership.",
];
/** A pending 'Run triage' finding in the shape applySafeFixes writes (no question, no engineering text). */
function finding(projectId: string, title: string, fieldName = "portal_field"): string {
  const id = `gap-${++runSeq}`;
  const ts = new Date().toISOString();
  db.run(
    `INSERT INTO human_review_items (id, project_id, issue_type, field_name, parser_value, llm_suggested_value, source_excerpt, status, notes, created_at, updated_at)
     VALUES (?, ?, 'Run triage', ?, '', '', ?, 'pending', '', ?, ?)`,
    [id, projectId, fieldName, title, ts, ts],
  );
  return id;
}
const statusOf = (projectId: string, itemId: string) => items(projectId).find((i) => i.id === itemId)?.status;

await check("T9 findings that only mention lease / third party / ownership stay pending when the question is asked", async () => {
  const p = newProject({ owner: "Ninth Sample" });
  const gaps = UNRELATED.map((t) => finding(p, t));
  const legacy9 = legacyNote(p);
  await triageLearnRun(db, writeBundle(), p);
  assert.equal(questionItems(p).filter((i) => i.status === "pending").length, 1);
  assert.deepEqual(gaps.map((g) => statusOf(p, g)), UNRELATED.map(() => "pending"), JSON.stringify(items(p).map((i) => [i.sourceExcerpt, i.status])));
  assert.notEqual(statusOf(p, legacy9), "pending", "the note quoting the question's own label is that question");
  // ... and when it is answered.
  await answerPortalQuestions(db, p, { ownershipModel: "Customer-Owned" });
  assert.equal(questionItems(p)[0].status, "edited");
  assert.deepEqual(gaps.map((g) => statusOf(p, g)), UNRELATED.map(() => "pending"), JSON.stringify(items(p).map((i) => [i.sourceExcerpt, i.status])));
});
await check("T9 a finding whose field is the question's label (the agent's target) is that question", async () => {
  const p = newProject({ owner: "Ninth Sample B" });
  const same = finding(p, "The utility asks who owns the system.", Q);
  await triageLearnRun(db, writeBundle(), p);
  assert.notEqual(statusOf(p, same), "pending");
});

{
  const { StubLLMProvider } = await import("../src/llm");
  const { dataGapNamesAskedQuestion } = await import("../src/runTriage");
  const realAgent = StubLLMProvider.prototype.runToolAgent;
  type Finding = { title: string; target: string };
  /** The agent reports these data-gap findings through its own report_finding tool. */
  const agentReports = (reports: Finding[]) => {
    StubLLMProvider.prototype.runToolAgent = (async (input: { tools: Array<{ name: string; handler: (i: Record<string, unknown>) => unknown }> }) => {
      const tool = input.tools.find((t) => t.name === "report_finding")!;
      for (const r of reports) {
        await tool.handler({ severity: "warning", title: r.title, rootCause: "synthetic cause", suggestedFix: "synthetic fix", fixKind: "data_gap", target: r.target });
      }
      return { provider: "stub", finalText: "", iterations: 1, hitIterationCap: false, stopReason: null };
    }) as unknown as typeof realAgent;
  };
  try {
    await check("T9 the agent's data-gap findings that only mention the subject are filed; the one naming the asked question is not", async () => {
      const p = newProject({ owner: "Ninth Sample C" });
      agentReports([
        ...UNRELATED.map((title) => ({ title, target: "portal_field" })),
        { title: "The utility asks whether the system is customer-owned.", target: Q },
      ]);
      await triageLearnRun(db, writeBundle(), p);
      const filed = items(p).filter((i) => i.issueType === "Run triage" && i.status === "pending" && !i.portalQuestion).map((i) => i.sourceExcerpt).sort();
      assert.deepEqual(filed, [...UNRELATED].sort(), JSON.stringify(items(p).map((i) => [i.sourceExcerpt, i.fieldName, i.status])));
      assert.equal(questionItems(p).length, 1);
    });
  } finally {
    StubLLMProvider.prototype.runToolAgent = realAgent;
  }
  await check("T9 dataGapNamesAskedQuestion: by the question's label only, never by its subject", () => {
    const asked = [{ label: Q }];
    for (const title of UNRELATED) assert.equal(dataGapNamesAskedQuestion({ title, target: "portal_field" }, asked), false, title);
    assert.equal(dataGapNamesAskedQuestion({ title: `Required question '${Q}' left blank`, target: "systemOwnership" }, asked), true);
    assert.equal(dataGapNamesAskedQuestion({ title: "x", target: Q.toUpperCase() }, asked), true);
    // fieldsSeen keeps 80 characters: a cut label still names the question.
    const longQ = "Please confirm whether the generating facility will be owned by the customer or by a third party lessor";
    assert.equal(dataGapNamesAskedQuestion({ title: `The portal asked: "${longQ}"`, target: "" }, [{ label: longQ.slice(0, 80) }]), true);
    // A short label is a word findings use: only the whole text counts.
    assert.equal(dataGapNamesAskedQuestion({ title: "Upload proof of property ownership.", target: "" }, [{ label: "Ownership" }]), false);
    assert.equal(dataGapNamesAskedQuestion({ title: "", target: "Ownership:" }, [{ label: "Ownership" }]), true);
  });
}

// ---- T10: a note left from before #544 is asked as its question --------------------------------------
await check("T10 GET /portal-questions names the pending note that quotes an open question; only that one", async () => {
  const p = newProject({ owner: "Tenth Sample" });
  setPortalQuestionSource(() => [{ key: "ownershipModel", label: Q, options: ["Customer-Owned", "Third-Party Owned"], kind: "radio-choice" }]);
  try {
    const legacy10 = legacyNote(p);
    const other = finding(p, UNRELATED[0]);
    const st = await portalQuestionStatus(db, p);
    const q = st.questions.find((x) => x.key === "ownershipModel");
    assert.ok(q, JSON.stringify(st));
    assert.deepEqual(q!.noteItemIds, [legacy10]);
    // Answered through the panel / the card in the note's place: the note closes, the other stays.
    await answerPortalQuestions(db, p, { ownershipModel: "Third-Party Owned" });
    assert.equal(statusOf(p, legacy10), "approved");
    assert.equal(statusOf(p, other), "pending");
  } finally {
    setPortalQuestionSource(null);
  }
});

if (failures) {
  console.error(`\nportalQuestionReviewItem: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nportalQuestionReviewItem: all checks passed");
