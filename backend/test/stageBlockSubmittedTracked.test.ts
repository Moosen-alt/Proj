// #436 RULING 5 — A STAGE IS REFUSED ONCE THE TRACK IS SUBMITTED AND TRACKED; A STAGED DRAFT IS NOT.
//
// Owner, 2026-11-03: "b, let it run" — a plain Stage while a staged draft awaits approval runs —
// "except BLOCK when the track is already submitted and being tracked (a filing is recorded on the
// track, or its NEM/permit tracking card holds an application number). The block is a 409 at the
// route, with the reason on the card." ONE predicate, submittalTracks.trackSubmittedAndTracked, read
// by the route (before an approval is minted), the job (prepareSubmission, before anything opens)
// and the track card (stageBlocked). Pinned on the REAL prepareSubmission (browser stubbed) and on a
// real server for the route:
//   (j1) a filing recorded on the track (a person captured it) → the job refuses 409, the runner is
//        never called, and the card holds Stage with the same sentence.
//   (j2) NO submission row, but the track's tracking card holds an application number (a filing a
//        person tracked under NEM Checks) → 409 "submitted and tracked", runner never called.
//   (j3) MUST PASS: a staged draft awaiting approval (the Stage's own awaiting_human_submit row, whose
//        submission can hold the draft's number) → a plain Stage over it runs (the runner IS called),
//        and the card does not hold Stage.
//   (j4) MUST PASS: a tracking card with no number blocks nothing.
//   (j5) the pool rule: an UNTAGGED target with a number blocks the one track drawing on the pool,
//        never two (building + electrical) — one unattributed number is not pinned on either.
//   (r1) THE ROUTE: on (j1) and (j2) shapes, POST prepare-submission {track:"nem"} answers 409 with the
//        sentence — even with autoSubmit and a name — and mints NO approval and enqueues NO job.
//   (r2) MUST PASS: the route lets a staged-awaiting track through (202). (Every route project is
//        on an operator hold, so the job that follows opens nothing.)
//
// KILL TESTS (run by hand on this tree):
//   K1 server.ts prepare-submission: drop the trackSubmittedAndTracked block → (r1) fails (202, an
//      approval minted, a job enqueued).
//   K2 repository.prepareSubmission: drop the per-track trackSubmittedAndTracked refusal → (j1) and
//      (j2) fail (the runner is called on a filed track).
//   K3 trackSubmittedAndTracked: drop the tracking-card leg → (j2) and (r1)-tracked fail.
//   K4 trackSubmittedAndTracked: read the submission's own application_number (readTrackState's
//      fallback) → (j3) fails (a staged draft's number blocks its re-stage).
//
// Run: npx tsx backend/test/stageBlockSubmittedTracked.test.ts
import "./_isolate"; // FIRST
import { REPO } from "./_isolate";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import type { SubmittalTrackType } from "../../shared/src/types";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("stage-block-submitted");
const { db, repo, recipes } = fx;
const tracksMod = await import("../src/submittalTracks");

const NEM_URL = "https://pgenm.powerclerk.example/MvcAccount/Login";
const r = recipes.startPortalRecording(db, { scopeType: "utility", state: "OR", utility: "PGE", portalUrl: NEM_URL, portalPlatform: "powerclerk", createdBy: "test" });
recipes.savePortalRecipeSteps(db, r.id, [...fx.fills(2), fx.REVIEW, fx.FINAL], { status: "complete", notes: "test" });

let runnerCalls = 0;
fx.stubRunner((async () => {
  runnerCalls++;
  return {
    portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null,
    steps: [{ ok: true, message: "Opened stub portal." }, { ok: true, message: "Human review required. AUTOMATION HAS STOPPED.", data: { finalSubmitClicked: false } }],
  };
}) as never);

type Refusal = { status: number; message: string; details?: Record<string, unknown> };
const refusalOf = async (fn: () => Promise<unknown>): Promise<Refusal | null> => {
  try { await fn(); return null; } catch (e) { return e as Refusal; }
};
const nemCard = (pid: string) => tracksMod.getSubmittalTracks(db, repo.getProjectDetail(db, pid).project).find((t) => t.type === "nem")!;

// Synthetic numbers only.
const FILED_NO = "SYN-NEM-0101";
const TRACKED_NO = "SYN-NEM-0202";

const filedProject = (): string => {
  const pid = fx.newProject();
  tracksMod.markTrackSubmitted(db, repo.getProjectDetail(db, pid).project, "nem", { applicationNumber: FILED_NO, submittedBy: "stage block test" });
  return pid;
};
const trackedProject = (n = TRACKED_NO): string => {
  const pid = fx.newProject();
  repo.createPermitCheckTarget(db, pid, { targetType: "nem", permitType: "nem", applicationNumber: n, notes: "tracked by hand" });
  return pid;
};

await check("(j1) a filing recorded on the track: the job refuses 409, the runner is never called, the card holds Stage", async () => {
  const pid = filedProject();
  const before = runnerCalls;
  const e = await refusalOf(() => repo.prepareSubmission(db, pid, "nem"));
  assert.ok(e, "MUST-EXCLUDE: a Stage of a filed track ran");
  assert.equal(e!.status, 409);
  assert.match(e!.message, new RegExp(`^The nem track is already filed as ${FILED_NO} on \\d{4}-\\d{2}-\\d{2}\\. Staging it again would open a duplicate application`));
  assert.equal(runnerCalls, before, "the runner was called for a filed track");
  const card = nemCard(pid);
  assert.equal(card.stageBlocked, e!.message, "the card does not hold Stage with the route's own reason");
});

await check("(j2) no submission, but the tracking card holds an application number: 409 'submitted and tracked'", async () => {
  const pid = trackedProject();
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM submissions WHERE project_id = ?", [pid])!.n, 0, "fixture: a submission row exists");
  const before = runnerCalls;
  const e = await refusalOf(() => repo.prepareSubmission(db, pid, "nem"));
  assert.ok(e, "MUST-EXCLUDE: a Stage of a tracked track ran");
  assert.equal(e!.status, 409);
  assert.match(e!.message, new RegExp(`^The nem track is already submitted and tracked: its tracking card holds ${TRACKED_NO}`));
  assert.equal(runnerCalls, before);
  assert.match(String(nemCard(pid).stageBlocked ?? ""), /submitted and tracked/);
});

let stagedPid = "";
await check("(j3) MUST PASS: a staged draft awaiting approval — a plain Stage over it runs, and the card does not hold Stage", async () => {
  stagedPid = fx.newProject();
  await repo.prepareSubmission(db, stagedPid, "nem");
  // The staged draft's own submission row carries its number (a Stage that read it): never a filing.
  db.run("UPDATE submissions SET application_number = 'SYN-DRAFT-0303' WHERE project_id = ? AND status = 'awaiting_human_submit'", [stagedPid]);
  const card = nemCard(stagedPid);
  assert.equal(card.status, "staged", `fixture: the track is ${card.status}`);
  assert.equal(card.stageBlocked, undefined, `the card holds Stage over a staged draft: ${card.stageBlocked}`);
  const before = runnerCalls;
  await repo.prepareSubmission(db, stagedPid, "nem");
  assert.equal(runnerCalls, before + 1, "MUST PASS: the plain Stage over a staged draft did not run");
});

await check("(j4) MUST PASS: a tracking card with no number blocks nothing", async () => {
  const pid = trackedProject("");
  const before = runnerCalls;
  await repo.prepareSubmission(db, pid, "nem");
  assert.equal(runnerCalls, before + 1);
  assert.equal(nemCard(pid).stageBlocked, undefined);
});

await check("(j5) the pool rule: an untagged permit target's number blocks the one track drawing on it, never two", () => {
  const pid = fx.newProject();
  repo.createPermitCheckTarget(db, pid, { targetType: "permit", permitType: "", applicationNumber: "SYN-BLD-0505", notes: "untagged" });
  const two: SubmittalTrackType[] = ["building", "electrical"];
  assert.equal(tracksMod.trackSubmittedAndTracked(db, pid, "building", two), null, "MUST-EXCLUDE: one unattributed number blocked building on a two-permit project");
  assert.equal(tracksMod.trackSubmittedAndTracked(db, pid, "electrical", two), null);
  const one = tracksMod.trackSubmittedAndTracked(db, pid, "combo", ["combo"]);
  assert.ok(one && one.via === "tracking_card" && one.number === "SYN-BLD-0505", JSON.stringify(one));
});

// ── the route, on a real server ─────────────────────────────────────────────────────────────
// Every project posted to is on an OPERATOR HOLD: a request the route lets through enqueues a job
// that refuses at the hold before any browser (the server process has no stubbed runner).
const hold = (pid: string): string => { repo.setProjectStatusByOperator(db, pid, "blocked", "route test: never open a portal", "operator"); return pid; };
const routeFiled = hold(filedProject());
const routeTracked = hold(trackedProject("SYN-NEM-0606"));
const routeStaged = fx.newProject();
await repo.prepareSubmission(db, routeStaged, "nem");
hold(routeStaged);

const dbPath = String(process.env.AUTOPILOT_DB_PATH);
const PORT = 5420 + Math.floor(Math.random() * 15); // never 4173 / 4270
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
    await new Promise((res) => setTimeout(res, 1000));
  }
  const post = (p: string, body: Record<string, unknown>) => fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const read = async <T>(fn: () => T): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try { return fn(); } catch (err) {
        const code = String((err as { code?: unknown }).code ?? "");
        if (attempt >= 40 || !code.startsWith("SQLITE_BUSY")) throw err;
        await new Promise((res) => setTimeout(res, 50));
      }
    }
  };
  const count = (sql: string, pid: string) => read(() => Number(db.get<{ n: number }>(sql, [pid])!.n));

  await check("(r1) the route answers 409 on a filed and on a tracked track — even with autoSubmit and a name — and mints and enqueues nothing", async () => {
    for (const [pid, re] of [[routeFiled, /already filed as SYN-NEM-0101/], [routeTracked, /submitted and tracked: its tracking card holds SYN-NEM-0606/]] as const) {
      const res = await post(`/api/projects/${pid}/prepare-submission`, { track: "nem", autoSubmit: true, approverName: "Pat Approver" });
      const text = await res.text();
      assert.equal(res.status, 409, `MUST-EXCLUDE: the route let a Stage of a submitted-and-tracked track through: ${res.status} ${text.slice(0, 200)}`);
      assert.match(String((JSON.parse(text) as { error?: string }).error ?? ""), re);
      assert.equal(await count("SELECT COUNT(*) AS n FROM portal_run_approvals WHERE project_id = ?", pid), 0, "an approval was minted before the refusal");
      assert.equal(await count("SELECT COUNT(*) AS n FROM job_queue WHERE project_id = ? AND job_type = 'prepare_submission'", pid), 0, "a job was enqueued");
    }
  });

  await check("(r2) MUST PASS: the route lets a plain Stage over a staged draft through (202)", async () => {
    const res = await post(`/api/projects/${routeStaged}/prepare-submission`, { track: "nem" });
    const text = await res.text();
    assert.equal(res.status, 202, `the route refused a Stage over a staged draft: ${res.status} ${text.slice(0, 200)}`);
  });
} finally {
  server.kill("SIGTERM");
}

finish("stage-block-submitted-tracked");
