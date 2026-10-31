// APPROVE & AUTO-SUBMIT NAMES A PERSON, AND SAYS WHAT HAPPENED (#422; CLAUDE.md rule 1).
//
// The track card's "Approve & auto-submit" promised the bot would click the portal's application
// submit under the named person's approval, then posted `{ track, autoSubmit: true }` with NO name.
// With sign-in off (the install's posture) the server mints an approval only under a name the
// request carries, so it minted none, audited `portal.final_submit_not_approved`, and staged a plain
// run to review — while the operator read "Approving …" and was never told. The owner's direction
// (2026-10-31, "they click Stage and Submit from the CRM and it does it all") makes this the team's
// primary path. Pinned here:
//   (a) THE BUTTON, lifted from frontend/dashboard.js and run with stubbed browser globals:
//       sign-in off → it prompts for the name (prefilled from the last name typed in this browser),
//       posts it as approverName with autoSubmit true, and remembers it; a blank or cancelled prompt
//       posts autoSubmit false and no name (a plain run) and says "No approval recorded"; sign-in on
//       → no prompt, the server names the signed-in person; backing out of the confirm posts nothing.
//   (b) THE RESULT LINE says which of three things happened: filed under <name>'s approval,
//       stopped at review with the gate's own reason (not a failure), or no approval recorded.
//   (c) THE ROUTE, on a real server with sign-in off: a nameless autoSubmit mints no approval and
//       its 202 says so (finalSubmitApproval.recorded false); a named one mints exactly one approval
//       under that name and says so; a plain stage carries no approval answer at all.
//   (e) #435 (owner ruling "One click now"): while the NEM track holds a staged draft, the card's
//       Approve & auto-submit is disabled with the reason, and a stale card's click posts nothing;
//       a NEM track with no draft and a staged permit track keep the one-click button.
//   (d) THE JOB RESULT of an approved run the gate declined carries the gate's reasons for THAT run
//       (autoSubmitDeclined), read from the gate's own audit row; a plain run carries none.
//
// What this does NOT change (rule 1): the gate is mayClickFinalSubmit / automaticSubmitRefusals,
// PORTAL_ALLOW_FINAL_SUBMIT=1 and a valid recipe shape; there is no default name and no standing arm.
//
// KILL TESTS (each turns this file red):
//   K1 dashboard approveAndAutoSubmitTrack: drop `{ approverName }` from the stage call → (a1) fails.
//   K2 dashboard: send autoSubmit true on a blank name → (a2) fails.
//   K3 server: drop finalSubmitApproval from the 202 → (c1)(c2) fail.
//   K4 jobQueue: drop autoSubmitDeclined from the prepare_submission result → (d) fails.
//   K5 dashboard trackCardHtml: approveHeld always "" → (e1) fails; the handler guard removed → (e3) fails.
//
// Run: npx tsx backend/test/approveAutoSubmitName.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REPO } from "./_isolate";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("approve-auto-submit-name");
const { db, repo } = fx;

// ── (a)(b) the dashboard's own functions ────────────────────────────────────────────────────
const dashboard = fs.readFileSync(path.join(REPO, "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
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
];
const code = NAMES.map(lift).join("\n\n");

type Posted = { path: string; body: Record<string, unknown> };
type Harness = {
  posted: Posted[]; messages: Array<{ text: string; kind: string }>; prompts: Array<{ text: string; def: string }>; store: Map<string, string>;
  run: (type: string) => Promise<void>;
  stagedResultLine: (type: string, result: unknown, opts: Record<string, unknown>) => string;
};
const harness = (opts: {
  auth: { enabled: boolean; user?: { name?: string; email?: string } | null };
  confirmAnswer?: boolean; promptAnswer?: string | null; remembered?: string;
  approvalAnswer?: Record<string, unknown> | undefined; jobResult?: Record<string, unknown>;
  tracks?: Array<Record<string, unknown>>;
}): Harness => {
  const posted: Posted[] = [];
  const messages: Array<{ text: string; kind: string }> = [];
  const prompts: Array<{ text: string; def: string }> = [];
  const store = new Map<string, string>(opts.remembered ? [["feeConfirmName", opts.remembered]] : []);
  const state: Record<string, unknown> = { selectedProjectId: "proj-under-test", authMe: null, submittalTracks: opts.tracks ?? [] };
  const stubs: Record<string, unknown> = {
    api: async (p: string, init?: { method?: string; body?: string }) => {
      if (p === "/api/auth/me") return opts.auth;
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body || "{}")) as Record<string, unknown>;
        posted.push({ path: p, body });
        return { jobId: "job-1", ...(opts.approvalAnswer ? { finalSubmitApproval: opts.approvalAnswer } : {}) };
      }
      return { project: { id: "proj-under-test" } };
    },
    waitForStagingJob: async () => ({ status: "done", result: opts.jobResult ?? { status: "awaiting_human_submit", pauseReason: null, message: null } }),
    loadSubmittalTracks: async () => {},
    renderDetail: () => {},
    showMessage: (text: string, kind = "info") => { messages.push({ text, kind }); },
    confirm: () => opts.confirmAnswer !== false,
    prompt: (text: string, def = "") => { prompts.push({ text, def }); return opts.promptAnswer === undefined ? def : opts.promptAnswer; },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } },
  };
  // eslint-disable-next-line no-new-func
  const lib = new Function("state", ...Object.keys(stubs), `${code}\nreturn { approveAndAutoSubmitTrack, stagedResultLine };`)(state, ...Object.values(stubs)) as {
    approveAndAutoSubmitTrack: (type: string, btn: unknown) => Promise<void>;
    stagedResultLine: Harness["stagedResultLine"];
  };
  return { posted, messages, prompts, store, run: (type) => lib.approveAndAutoSubmitTrack(type, { disabled: false }), stagedResultLine: lib.stagedResultLine };
};
const OFF = { enabled: false, user: null };

await check("(a1) sign-in off: the approve click prompts, posts the typed name as approverName with autoSubmit true, and remembers it", async () => {
  const h = harness({ auth: OFF, promptAnswer: "  Pat Approver  ", approvalAnswer: { recorded: true, approver: "Pat Approver" } });
  await h.run("nem");
  assert.equal(h.prompts.length, 1, "no name was asked for: a nameless approval stages silently to review");
  assert.match(h.prompts[0].text, /approver of this run/);
  assert.equal(h.posted.length, 1);
  assert.match(h.posted[0].path, /\/api\/projects\/proj-under-test\/prepare-submission$/);
  assert.deepEqual(h.posted[0].body, { track: "nem", autoSubmit: true, approverName: "Pat Approver" });
  assert.equal(h.store.get("feeConfirmName"), "Pat Approver", "the typed name is not remembered for the next prompt");
});

await check("(a1b) the prompt is prefilled with the last name typed in this browser, and confirming it still asks per run", async () => {
  const h = harness({ auth: OFF, remembered: "Lee Operator", approvalAnswer: { recorded: true, approver: "Lee Operator" } });
  await h.run("nem");
  assert.equal(h.prompts.length, 1, "MUST-EXCLUDE: a remembered name approved without asking (a standing arm)");
  assert.equal(h.prompts[0].def, "Lee Operator");
  assert.equal(h.posted[0].body.approverName, "Lee Operator");
  assert.equal(h.posted[0].body.autoSubmit, true);
});

for (const [label, answer] of [["cancelled", null], ["blank", "   "]] as const) {
  await check(`(a2) a ${label} prompt stages a plain run (autoSubmit false, no name) and says no approval was recorded`, async () => {
    const h = harness({ auth: OFF, promptAnswer: answer, remembered: "" });
    await h.run("nem");
    assert.equal(h.posted.length, 1, "the plain run was not staged");
    assert.equal(h.posted[0].body.autoSubmit, false, "MUST-EXCLUDE: a nameless request asked for the final submit");
    assert.equal("approverName" in h.posted[0].body, false, "a nameless request carried an approverName");
    assert.ok(h.messages.some((m) => /No approval recorded \(no name given\)/.test(m.text) && /manual submit/.test(m.text)),
      `the operator is not told: ${JSON.stringify(h.messages)}`);
    assert.ok(!h.messages.some((m) => /^Approving/.test(m.text)), "MUST-EXCLUDE: the 'Approving …' line showed for a run nobody approved");
    assert.equal(h.store.has("feeConfirmName"), false, "a blank name was remembered");
  });
}

await check("(a3) backing out of the confirm posts nothing", async () => {
  const h = harness({ auth: OFF, confirmAnswer: false });
  await h.run("nem");
  assert.equal(h.posted.length, 0);
  assert.equal(h.prompts.length, 0);
});

await check("(a4) sign-in on: no prompt, no body name — the server records the signed-in person", async () => {
  const h = harness({ auth: { enabled: true, user: { name: "Signed In Person" } }, approvalAnswer: { recorded: true, approver: "Signed In Person" },
    jobResult: { status: "submitted", pauseReason: null, message: null } });
  await h.run("nem");
  assert.equal(h.prompts.length, 0, "with sign-in on the name is the server's, never typed");
  assert.deepEqual(h.posted[0].body, { track: "nem", autoSubmit: true });
  assert.ok(h.messages.some((m) => /filed by automation under Signed In Person's approval/.test(m.text)), JSON.stringify(h.messages));
});

await check("(a5) the server's answer wins: an autoSubmit the server recorded no approval for reads 'No approval recorded'", async () => {
  const h = harness({ auth: OFF, promptAnswer: "Pat Approver", approvalAnswer: { recorded: false, approver: null } });
  await h.run("nem");
  const last = h.messages[h.messages.length - 1];
  assert.match(last.text, /No approval recorded \(no name given\); staged to the review screen for your manual submit/);
  assert.equal(last.kind, "warning");
});

await check("(b) three outcomes, three lines: filed under <name>, stopped at review with the gate's reason, no approval", async () => {
  const h = harness({ auth: OFF });
  const filed = h.stagedResultLine("nem", { status: "submitted" }, { autoSubmit: true, approvedBy: "Pat Approver" });
  assert.match(filed, /^Nem filed by automation under Pat Approver's approval of this run/);
  const stopped = h.stagedResultLine("nem", { status: "awaiting_human_submit", autoSubmitDeclined: ["PORTAL_ALLOW_FINAL_SUBMIT is not 1 on this process"] }, { autoSubmit: true, approvedBy: "Pat Approver" });
  assert.match(stopped, /stopped at review: PORTAL_ALLOW_FINAL_SUBMIT is not 1 on this process\. Nothing was filed and this is not a failure/);
  const stoppedNoReason = h.stagedResultLine("nem", { status: "awaiting_human_submit" }, { autoSubmit: true, approvedBy: "Pat Approver" });
  assert.match(stoppedNoReason, /stopped at review: the run did not reach the recorded submit/);
  const none = h.stagedResultLine("nem", { status: "awaiting_human_submit" }, { autoSubmit: false, approvalMissing: true });
  assert.match(none, /No approval recorded \(no name given\)/);
  const plain = h.stagedResultLine("nem", { status: "awaiting_human_submit" }, {});
  assert.match(plain, /staged to final review/);
  assert.ok(![stopped, none, plain].some((t) => /filed by automation/.test(t)), "MUST-EXCLUDE: a run that filed nothing reads as filed");
});

await check("(b2) the confirm states the three conditions, that a stop at review is not a failure, and that it is its own run (#435)", async () => {
  const lede = new Function(`${lift("APPROVE_AUTO_SUBMIT_LEDE")}\nreturn APPROVE_AUTO_SUBMIT_LEDE;`)() as string;
  assert.match(lede, /named approver/);
  assert.match(lede, /PORTAL_ALLOW_FINAL_SUBMIT/);
  assert.match(lede, /recipe recorded through submit/);
  assert.match(lede, /not a failure/);
  // #435: on the NEM track an approved run after a Stage stops on Stage's draft, so the button is
  // described as its own run from the start and never as submitting what a Stage left.
  assert.match(lede, /starts its own run from the start of the application/);
  assert.match(lede, /does not submit an application an earlier Stage left/);
  assert.doesNotMatch(lede, /submit(s|ting)? the staged/i, "MUST-EXCLUDE: the confirm promises a click on the staged application");
});

// ── (e) #435: the card holds Approve & auto-submit while a NEM draft is staged ───────────────
// The SHIPPED renderer, lifted with every helper it calls (feeTracksDisplay.test's list).
const CARD_NAMES = [
  "esc", "humanize", "fmtDate", "statusBadge", "httpUrl", "portalHostname",
  "TRACK_STATUS_CLASS", "TRACK_CHANNEL_BASIS", "linkifyText", "trackChannelHtml", "OFF_TOOL_CHANNEL", "offToolChannelHtml", "trackPrerequisitesHtml", "ESS_STEP_BASIS", "trackEssStepHtml", "trackNextActionText",
  "TRACK_ISSUER_KEY", "TRACK_ISSUER_SOURCE", "trackIssuerHtml", "trackIssuerEditHtml", "trackCardHtml",
];
const cardCode = `const screenshotMisses = new Set(); const screenshotKey = (a, b, c) => \`\${a}:\${b}:\${c}\`;\n${CARD_NAMES.map(lift).join("\n\n")}\n${lift("APPROVE_HELD_BY_STAGED_DRAFT")}`;
// eslint-disable-next-line no-new-func
const card = new Function("$", "state", "window", `${cardCode}\nreturn { trackCardHtml, APPROVE_HELD_BY_STAGED_DRAFT };`)(() => null, { selectedProjectId: "p1" }, {}) as {
  trackCardHtml: (t: Record<string, unknown>) => string; APPROVE_HELD_BY_STAGED_DRAFT: string;
};
const nemTrack = {
  type: "nem", label: "Utility net metering (NEM) / interconnection", category: "utility", status: "not_started", statusLabel: "Not started", nextAction: "Approve it.",
  captureFields: [], applicationNumber: "", permitNumber: "", confirmationNumber: "", trackingUrl: "", submittedAt: null, lastCheckedAt: null,
  outstanding: true, hasRecipe: true, recipeStatus: "complete", recipeScopeType: "utility",
};
const approveButton = (html: string): string => /<button[^>]*data-track-approve="[^"]*"[^>]*>/.exec(html)?.[0] ?? "";

await check("(e1) a NEM track with a staged draft holds Approve & auto-submit and says how to finish the draft", async () => {
  const html = card.trackCardHtml({ ...nemTrack, status: "staged", statusLabel: "Staged" });
  const btn = approveButton(html);
  assert.ok(btn, "the button is gone: the operator cannot see why there is no one-click filing");
  assert.match(btn, /\sdisabled[\s>]/, `MUST-EXCLUDE: Approve starts a second run over the staged draft: ${btn}`);
  assert.ok(html.includes(card.APPROVE_HELD_BY_STAGED_DRAFT), "the reason is not shown on the card");
  assert.match(card.APPROVE_HELD_BY_STAGED_DRAFT, /staged draft; finish it from the review window or by staging again, then a person submits/);
});

await check("(e2) MUST-PASS: a NEM track with no staged draft, and a staged PERMIT track, keep the one-click button", async () => {
  for (const t of [{ ...nemTrack }, { ...nemTrack, type: "combo", category: "permit", label: "AHJ permit", status: "staged", recipeScopeType: "ahj" }]) {
    const html = card.trackCardHtml(t);
    const btn = approveButton(html);
    assert.ok(btn && !/\sdisabled[\s>]/.test(btn), `${t.type}/${t.status}: ${btn}`);
    assert.ok(!html.includes(card.APPROVE_HELD_BY_STAGED_DRAFT), `${t.type}/${t.status} shows the hold`);
    assert.match(btn, /Starts its own run from the start of the application/);
  }
});

await check("(e3) a click from a card drawn before the Stage finished is held too: nothing is posted", async () => {
  const h = harness({ auth: OFF, promptAnswer: "Pat Approver", tracks: [{ type: "nem", status: "staged" }] });
  await h.run("nem");
  assert.equal(h.posted.length, 0, "MUST-EXCLUDE: a second NEM run was started over the staged draft");
  assert.equal(h.prompts.length, 0);
  assert.ok(h.messages.some((m) => /staged draft/.test(m.text) && m.kind === "warning"), JSON.stringify(h.messages));
});

// ── (d) the job result of an approved run the gate declined ──────────────────────────────────
const { enqueueJob, processNextJob, getJob } = await import("../src/jobQueue");
fx.completeRecipe();
fx.stubRunner((async () => ({
  portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null,
  steps: [{ ok: true, message: "Human review required. AUTOMATION HAS STOPPED.", data: { finalSubmitClicked: false } }],
})) as never);

await check("(d) an approved run the gate declined carries the gate's reasons for THAT run; a plain run carries none", async () => {
  const pid = fx.newProject();
  const approval = repo.createRunApproval(db, { projectId: pid, track: "permit", approver: "Pat Approver" });
  const job = enqueueJob(db, "prepare_submission", repo.finalSubmitJobPayload({ autoSubmit: true, allowFinalSubmit: false, approval }), { projectId: pid, priority: 7, maxRetries: 0 });
  await processNextJob(db);
  const done = getJob(db, job.id)!;
  assert.equal(done.status, "done", `job: ${JSON.stringify(done)}`);
  const result = done.result as { status?: string; autoSubmitDeclined?: string[] };
  assert.notEqual(result.status, "submitted", "MUST-EXCLUDE: with the switch off the run filed");
  assert.ok(Array.isArray(result.autoSubmitDeclined) && result.autoSubmitDeclined.some((r) => /PORTAL_ALLOW_FINAL_SUBMIT is not 1/.test(r)),
    `the result does not say why the approved run stopped: ${JSON.stringify(result)}`);
  assert.equal(String(fx.latestRun(pid)?.id), approval.id, "setup: the run did not adopt the approval's id");
  assert.equal(repo.autoSubmitDeclineReasons(db, pid, "some-other-run"), null, "another run's id read this run's refusal");

  const plainPid = fx.newProject();
  const plain = enqueueJob(db, "prepare_submission", repo.finalSubmitJobPayload({ autoSubmit: false, allowFinalSubmit: false, approval: null }), { projectId: plainPid, priority: 7, maxRetries: 0 });
  await processNextJob(db);
  const plainDone = getJob(db, plain.id)!;
  assert.equal("autoSubmitDeclined" in (plainDone.result as Record<string, unknown>), false, JSON.stringify(plainDone.result));
});

// ── (c) the route, on a real server with sign-in off ─────────────────────────────────────────
const dbPath = String(process.env.AUTOPILOT_DB_PATH);
const PORT = 5380 + Math.floor(Math.random() * 15); // never 4173 / 4270
const BASE = `http://127.0.0.1:${PORT}`;
const env: Record<string, string | undefined> = {
  ...process.env, AUTOPILOT_DB_PATH: dbPath, PORT: String(PORT), AUTOPILOT_AUTO_START: "0", SEED_TEST_INSTALLER: "false",
  MONITOR_INTERVAL_MINUTES: "0", LOG_LEVEL: "warn", ANTHROPIC_API_KEY: "", CODE_RESEARCH: "off", BACKGROUND_WORKERS: "off",
  SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
  AUTH_ENABLED: "false", NO_PROXY: "*", no_proxy: "*", AUTOPILOT_TEST_SEAMS: "",
};
delete env.PORTAL_ALLOW_FINAL_SUBMIT;
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
const server = spawn(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "backend/src/server.ts")], {
  env: env as NodeJS.ProcessEnv, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout?.on("data", (d) => { serverLog += String(d); });
server.stderr?.on("data", (d) => { serverLog += String(d); });
try {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up yet */ }
    if (i === 89) throw new Error(`server never came up:\n${serverLog.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const post = (p: string, body: Record<string, unknown>) => fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  // A project an early gate refuses before any browser (an operator hold), so no run opens anything.
  const held = () => {
    const pid = fx.newProject();
    repo.setProjectStatusByOperator(db, pid, "blocked", "waiting on the homeowner", "operator");
    return pid;
  };
  const approvalsFor = (pid: string) => db.query<{ id: string; approver: string }>("SELECT id, approver FROM portal_run_approvals WHERE project_id = ?", [pid]);
  const payloadOf = (jobId: string) => JSON.parse(db.get<{ payload: string }>("SELECT payload FROM job_queue WHERE id = ?", [jobId])!.payload) as { autoSubmit?: boolean; approvalId?: string | null };

  await check("(c1) sign-in off: a nameless autoSubmit mints no approval, audits it, and the 202 says no approval was recorded", async () => {
    const pid = held();
    const res = await post(`/api/projects/${pid}/prepare-submission`, { track: "building", autoSubmit: true });
    const text = await res.text();
    assert.equal(res.status, 202, text);
    const body = JSON.parse(text) as { jobId: string; finalSubmitApproval?: { recorded: boolean; approver: string | null } };
    assert.deepEqual(body.finalSubmitApproval, { recorded: false, approver: null }, "the response does not say the approval was not recorded");
    assert.equal(approvalsFor(pid).length, 0, "MUST-EXCLUDE: a nameless request minted an approval");
    const payload = payloadOf(body.jobId);
    assert.equal(payload.autoSubmit, false, "MUST-EXCLUDE: a nameless request's job asks for the final submit");
    assert.equal(payload.approvalId ?? null, null);
    assert.equal(db.query("SELECT id FROM audit_logs WHERE project_id = ? AND action = 'portal.final_submit_not_approved'", [pid]).length, 1);
  });

  await check("(c2) sign-in off: a named autoSubmit mints exactly one approval under that name and the 202 names it", async () => {
    const pid = held();
    const res = await post(`/api/projects/${pid}/prepare-submission`, { track: "building", autoSubmit: true, approverName: "  Pat Approver " });
    const text = await res.text();
    assert.equal(res.status, 202, text);
    const body = JSON.parse(text) as { jobId: string; finalSubmitApproval?: { recorded: boolean; approver: string | null } };
    assert.deepEqual(body.finalSubmitApproval, { recorded: true, approver: "Pat Approver" });
    const rows = approvalsFor(pid);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].approver, "Pat Approver");
    assert.equal(payloadOf(body.jobId).approvalId, rows[0].id, "the job does not carry the approval this request minted");
  });

  await check("(c3) a plain stage carries no approval answer and mints nothing", async () => {
    const pid = held();
    const res = await post(`/api/projects/${pid}/prepare-submission`, { track: "building" });
    const body = JSON.parse(await res.text()) as Record<string, unknown>;
    assert.equal(res.status, 202);
    assert.equal("finalSubmitApproval" in body, false);
    assert.equal(approvalsFor(pid).length, 0);
  });
} finally {
  server.kill("SIGTERM");
}

finish("approve-auto-submit-name");
