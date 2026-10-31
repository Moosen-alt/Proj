// ONE APPROVE ACTION, ONE MEANING (#423; CLAUDE.md rule 1).
//
// The project rail's "Approve & Submit" (the button the next-step banner points at) posted
// /autopilot/approve, which on every real portal records an approval and files nothing, while the
// track card's "Approve & auto-submit" mints a claimed-by-id approval and may have the bot click the
// final submit under the one gate. A new operator reads them as the same action. The owner's
// direction (2026-10-31, "they click Stage and Submit from the CRM and it does it all") settled it:
// the rail button opens the CARD's door. Pinned here:
//   (a) THE LABEL: the rail button, the next-step banner's label table and the server's next-step
//       button all read "Approve & auto-submit"; "Approve & Submit" is gone from the page.
//   (b) THE SAME BODY: the rail click, lifted from frontend/dashboard.js and run with stubbed browser
//       globals, posts to prepare-submission exactly the body the card's click posts for the same
//       track — sign-in off with a typed name ({ track, autoSubmit: true, approverName }), a blank name
//       (a plain run, no name), sign-in on (no name: the server names the signed-in person).
//   (c) THE SAME REFUSALS: on a staged NEM draft the rail holds exactly where the card holds it
//       (#435, the card's own words) and posts nothing; a refused draft (canApprove false) posts
//       nothing; no dashboard code posts /autopilot/approve any more.
//   (d) THE SERVER says which filing the rail acts on: getAutopilotState's approveTrack is the
//       newest awaiting draft's track, and its message no longer says "Click Approve & Submit to file".
//
// What this does NOT change (rule 1): no door moves. The gate is mayClickFinalSubmit /
// automaticSubmitRefusals, PORTAL_ALLOW_FINAL_SUBMIT=1 and a valid recipe shape, asked by the same
// prepare-submission route the card already used; /autopilot/approve is unchanged on the server.
//
// KILL TESTS (each turns this file red):
//   K1 dashboard approveAndSubmit: post /autopilot/approve again → (b1)(c3) fail.
//   K2 dashboard approveAndSubmit: call stageSubmittalTrack(track, btn, true) without the prompt → (b1) fails.
//   K3 dashboard railApproveHold: drop the "nem" hold → (c1) fails.
//   K4 dashboard.html / NEXT_STEP_BUTTON_LABELS / nextStep.ts: the old label → (a) fails.
//   K5 autopilot.ts: drop approveTrack from the awaiting state → (d1) fails.
//
// Run: npx tsx backend/test/approveRailOneDoor.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REPO } from "./_isolate";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("approve-rail-one-door");
const { db } = fx;
const { getAutopilotState } = await import("../src/autopilot");
const { decideNextStep } = await import("../src/nextStep");

const dashboard = fs.readFileSync(path.join(REPO, "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
const html = fs.readFileSync(path.join(REPO, "frontend", "dashboard.html"), "utf8");
/** Lift a top-level `[async] function NAME(` or `const NAME = ` by bracket balance (submitSeam's pattern). */
const lift = (name: string): string => {
  const re = new RegExp(`^(?:async )?function ${name}\\(|^const ${name} = `, "m");
  const m = re.exec(dashboard);
  if (!m) throw new Error(`dashboard.js: could not find ${name}`);
  const isConst = m[0].startsWith("const");
  let i = isConst ? m.index + m[0].length : dashboard.indexOf("{", dashboard.indexOf(")", m.index));
  if (isConst && !"{[(".includes(dashboard[i])) { const semi = dashboard.indexOf(";\n", i); return dashboard.slice(m.index, semi + 1); }
  let depth = 0;
  for (; i < dashboard.length; i++) {
    const ch = dashboard[i];
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") { depth--; if (depth === 0) { i++; break; } }
  }
  return dashboard.slice(m.index, i) + (isConst ? ";" : "");
};
const NAMES = [
  "humanize", "authForDecision", "APPROVE_AUTO_SUBMIT_LEDE", "APPROVE_HELD_BY_STAGED_DRAFT", "APPROVER_NAME_KEY", "approveAndAutoSubmitTrack",
  "stagedResultLine", "NO_APPROVAL_RECORDED_TEXT", "stageSubmittalTrack",
  "RAIL_APPROVE_TITLE", "RAIL_APPROVE_NO_TRACK", "railApproveHold", "approveAndSubmit", "NEXT_STEP_BUTTON_LABELS",
];
const code = NAMES.map(lift).join("\n\n");

type Posted = { path: string; body: Record<string, unknown> };
type Lib = {
  approveAndAutoSubmitTrack: (type: string, btn: unknown) => Promise<void>;
  approveAndSubmit: () => Promise<void>;
  railApproveHold: (s: unknown) => string;
  APPROVE_HELD_BY_STAGED_DRAFT: string;
  NEXT_STEP_BUTTON_LABELS: Record<string, string>;
};
const harness = (opts: {
  auth: { enabled: boolean; user?: { name?: string } | null };
  promptAnswer?: string | null;
  autopilot?: Record<string, unknown> | null;
  tracks?: Array<Record<string, unknown>>;
}) => {
  const posted: Posted[] = [];
  const messages: Array<{ text: string; kind: string }> = [];
  const prompts: string[] = [];
  let refreshed = 0;
  const railBtn = { disabled: false };
  const state: Record<string, unknown> = {
    selectedProjectId: "proj-under-test", authMe: null, submittalTracks: opts.tracks ?? [], autopilot: opts.autopilot ?? null,
  };
  const stubs: Record<string, unknown> = {
    $: (id: string) => (id === "approveSubmitBtn" ? railBtn : null),
    api: async (p: string, init?: { method?: string; body?: string }) => {
      if (p === "/api/auth/me") return opts.auth;
      if (init?.method === "POST") {
        posted.push({ path: p, body: JSON.parse(String(init.body || "{}")) as Record<string, unknown> });
        return { jobId: "job-1", finalSubmitApproval: { recorded: true, approver: "x" } };
      }
      return { project: { id: "proj-under-test" } };
    },
    waitForStagingJob: async () => ({ status: "done", result: { status: "awaiting_human_submit", pauseReason: null, message: null } }),
    loadSubmittalTracks: async () => {},
    renderDetail: () => {},
    refreshAutopilot: async () => { refreshed++; },
    showMessage: (text: string, kind = "info") => { messages.push({ text, kind }); },
    confirm: () => true,
    prompt: (text: string, def = "") => { prompts.push(text); return opts.promptAnswer === undefined ? def : opts.promptAnswer; },
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  // eslint-disable-next-line no-new-func
  const lib = new Function("state", ...Object.keys(stubs),
    `${code}\nreturn { approveAndAutoSubmitTrack, approveAndSubmit, railApproveHold, APPROVE_HELD_BY_STAGED_DRAFT, NEXT_STEP_BUTTON_LABELS };`,
  )(state, ...Object.values(stubs)) as Lib;
  return { lib, posted, messages, prompts, railBtn, refreshed: () => refreshed };
};
const OFF = { enabled: false, user: null };
const APPROVABLE = (track: string) => ({ projectId: "proj-under-test", canApprove: true, approveDisabledReason: null, approveTrack: track });

// ── (a) one label ───────────────────────────────────────────────────────────────────────────
await check("(a) the rail button, the banner's label table and the server's next-step button all say Approve & auto-submit", async () => {
  assert.match(html, /<button id="approveSubmitBtn"[^>]*>.*<span>Approve &amp; auto-submit<\/span><\/button>/);
  assert.doesNotMatch(html, /Approve &amp; Submit/, "the retired rail label is still on the page");
  const { lib } = harness({ auth: OFF });
  assert.equal(lib.NEXT_STEP_BUTTON_LABELS.approveSubmitBtn, "Approve & auto-submit");
  const run = { id: "r1", status: "awaiting_human_submit", permitType: "combo", startedAt: "2026-10-31T10:00:00.000Z", resultJson: "{}" };
  const step = decideNextStep({
    projectId: "p1", status: "awaiting_human_submit", stageDetail: "", archived: false, ahj: "City of Testport", utility: "Test Power",
    operatorHold: null, openCorrections: [], jobInFlight: null, reopenPause: null,
    tracks: [
      { track: "combo", filed: false, filedAt: null, done: false, latestRun: run, onPortal: true, stagedRun: run, gapFillMissing: [], feeDue: false, paymentDue: false },
      { track: "nem", filed: true, filedAt: null, done: false, latestRun: null, onPortal: true, stagedRun: null, gapFillMissing: [], feeDue: false, paymentDue: false },
    ] as never,
    qcRan: true, qcFails: [], qcReview: [], portalReadings: 0, approvedRunIds: [],
    gate: { decision: "ready_to_stage", blockers: [] }, reviewerBlockers: [],
  });
  assert.deepEqual(step.button, { id: "approveSubmitBtn", label: "Approve & auto-submit" });
  const said = [step.headline, ...step.why.map((w) => w.text)].join(" ");
  assert.doesNotMatch(said, /Approve & Submit|file it and capture the confirmation/, said);
});

// ── (b) the same body as the card ───────────────────────────────────────────────────────────
for (const [label, auth, promptAnswer] of [
  ["sign-in off, a typed name", OFF, "Pat Approver"],
  ["sign-in off, a blank name", OFF, "   "],
  ["sign-in on", { enabled: true, user: { name: "Signed In Person" } }, undefined],
] as const) {
  await check(`(b1) ${label}: the rail click posts exactly the card's body for the same filing, to prepare-submission`, async () => {
    const card = harness({ auth, promptAnswer });
    await card.lib.approveAndAutoSubmitTrack("combo", { disabled: false });
    const rail = harness({ auth, promptAnswer, autopilot: APPROVABLE("combo") });
    await rail.lib.approveAndSubmit();
    assert.equal(card.posted.length, 1);
    assert.equal(rail.posted.length, 1, `the rail posted ${rail.posted.length} requests: ${JSON.stringify(rail.posted)}`);
    assert.match(rail.posted[0].path, /\/api\/projects\/proj-under-test\/prepare-submission$/, "MUST-EXCLUDE: the rail still posts /autopilot/approve");
    assert.deepEqual(rail.posted[0], card.posted[0]);
    assert.equal(rail.prompts.length, card.prompts.length, "the rail asked for the approver differently from the card");
    assert.ok(rail.refreshed() >= 1, "the rail button is not re-derived from the server's answer after the run");
  });
}
await check("(b2) the bodies are the #422 bodies: a named approval, a plain run with no name, the server's own person", async () => {
  const named = harness({ auth: OFF, promptAnswer: "Pat Approver", autopilot: APPROVABLE("combo") });
  await named.lib.approveAndSubmit();
  assert.deepEqual(named.posted[0].body, { track: "combo", autoSubmit: true, approverName: "Pat Approver" });
  const blank = harness({ auth: OFF, promptAnswer: "", autopilot: APPROVABLE("combo") });
  await blank.lib.approveAndSubmit();
  assert.deepEqual(blank.posted[0].body, { track: "combo", autoSubmit: false }, "MUST-EXCLUDE: a nameless rail click asked for the final submit");
  const signedIn = harness({ auth: { enabled: true, user: { name: "Signed In Person" } }, autopilot: APPROVABLE("combo") });
  await signedIn.lib.approveAndSubmit();
  assert.deepEqual(signedIn.posted[0].body, { track: "combo", autoSubmit: true });
});

// ── (c) the same refusals ───────────────────────────────────────────────────────────────────
await check("(c1) a staged NEM draft: the rail holds where the card holds it, in the card's words, and posts nothing", async () => {
  const h = harness({ auth: OFF, promptAnswer: "Pat Approver", autopilot: APPROVABLE("nem") });
  assert.equal(h.lib.railApproveHold(APPROVABLE("nem")), h.lib.APPROVE_HELD_BY_STAGED_DRAFT);
  assert.equal(h.lib.railApproveHold(APPROVABLE("combo")), "", "a staged permit draft lost the one-click button");
  await h.lib.approveAndSubmit();
  assert.equal(h.posted.length, 0, `a held NEM approve posted: ${JSON.stringify(h.posted)}`);
  assert.equal(h.prompts.length, 0, "a held NEM approve asked for a name");
  assert.ok(h.messages.some((m) => m.text === h.lib.APPROVE_HELD_BY_STAGED_DRAFT && m.kind === "warning"), JSON.stringify(h.messages));
});
await check("(c2) a draft the server refuses (canApprove false), no state, or no single track: the rail posts nothing and says why", async () => {
  for (const autopilot of [
    { projectId: "proj-under-test", canApprove: false, approveDisabledReason: "Not approvable: the reviewer gate lists 1 blocker(s).", approveTrack: "combo" },
    null,
    { projectId: "proj-under-test", canApprove: true, approveDisabledReason: null, approveTrack: null },
  ]) {
    const h = harness({ auth: OFF, promptAnswer: "Pat Approver", autopilot });
    await h.lib.approveAndSubmit();
    assert.equal(h.posted.length, 0, `posted for ${JSON.stringify(autopilot)}`);
    assert.ok(h.messages.length === 1 && h.messages[0].kind === "warning" && h.messages[0].text, JSON.stringify(h.messages));
  }
});
await check("(c3) no dashboard code posts /autopilot/approve (the route stays on the server, unchanged)", async () => {
  // A request path, not the comments that explain why it is gone.
  assert.doesNotMatch(dashboard, /[`'"]\/api\/projects\/[^`'"]*\/autopilot\/approve[`'"]/);
});

// ── (d) the server names the filing ─────────────────────────────────────────────────────────
const mkRun = (pid: string, permitType: string, startedAt: string): void => {
  db.run(
    `INSERT INTO portal_runs (id, project_id, portal_profile_id, run_type, status, started_at, error_message,
       human_action_required, screenshots_path, logs_path, result_json, permit_type)
     VALUES (?, ?, NULL, 'prepare_submit', 'awaiting_human_submit', ?, '', 0, '', '', ?, ?)`,
    [`run-rail-${permitType}-${pid}`, pid, startedAt, JSON.stringify({ actor: "RecipeAdapter", ok: true }), permitType],
  );
  db.run("UPDATE projects SET status = 'awaiting_human_submit', stage_detail = 'staged_for_review' WHERE id = ?", [pid]);
};
await check("(d1) getAutopilotState names the newest awaiting draft's track as the one the rail acts on", async () => {
  const pid = fx.newProject();
  mkRun(pid, "nem", "2026-10-31T09:00:00.000Z");
  const nem = getAutopilotState(db, pid);
  assert.equal(nem.phase, "awaiting_approval", nem.message);
  assert.equal(nem.approveTrack, "nem");
  assert.doesNotMatch(nem.message, /Click Approve & Submit/, nem.message);
  const pid2 = fx.newProject();
  mkRun(pid2, "nem", "2026-10-31T09:00:00.000Z");
  mkRun(pid2, "combo", "2026-10-31T10:00:00.000Z");
  const newest = getAutopilotState(db, pid2);
  assert.equal(newest.approveTrack, "combo", "the rail would approve a different filing than the newest draft");
  assert.doesNotMatch(newest.message, /Click Approve & Submit/, newest.message);
});
await check("(d2) MUST-EXCLUDE: with nothing awaiting approval there is no filing for the rail", async () => {
  const pid = fx.newProject();
  const s = getAutopilotState(db, pid);
  assert.ok(!s.approveTrack, `approveTrack ${s.approveTrack} on a project with no staged draft`);
});

finish("approve rail one door");
