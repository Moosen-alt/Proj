// #436 PR1 — RULE 2 FOR THE STAGED REVIEW: NO ACCOUNT OR METER DIGITS, ANYWHERE THE READING GOES.
//
// The staged draft's pages show the customer's account and meter numbers (a review page echoes what
// was typed). The digest reader HMACs every value in Node (a scrypt subkey of SESSION_ENCRYPTION_KEY,
// the row's own nonce) and redacts every label and display value; the backend's one writer re-checks
// both. Pinned end to end on the REAL prepareSubmission (only the browser stubbed — the stub builds
// its reading with the REAL builder from the secrets the backend handed it), with a SYNTHETIC account
// and meter number written plain, with separators, and inside prose:
//   (a) MUST PASS: the row is approvable and holds one 64-hex mac per item (the reading really was
//       hashed, not dropped), and the field report shows the account and meter masked to a last 4.
//   (b) the digits appear NOWHERE: the staged row (every column), result_json, the project's audit
//       rows, its submissions, the log file and everything printed to the console during the stage —
//       matched digit-for-digit with separators ignored, never inside a longer digit run.
//   (c) THE IDENTITY SWAP: the same reading built with an identity "mac" carries the digits (the scan
//       catches it — the HMAC is what protects them), and the writer refuses to keep it: no item, not
//       approvable, said why.
//
// KILL TESTS (run by hand on this tree):
//   K1 reviewDigest.buildStagedReviewCapture: default the mac to identity → (a) fails (no 64-hex macs;
//      the writer kept nothing) and the in-memory capture carries the digits.
//   K2 reviewDigest.redactDigestText: return the text unredacted → (b) fails (labels / field report).
//   K3 repository: hand the replay no secrets (stagedReview: { secrets: [] }) → (a) fails (the field
//      report no longer masks the account to its last 4). (b) still holds: the writer re-scrubs every
//      label and value against the project's own secrets — the second layer, on purpose.
//
// Run: npx tsx backend/test/reviewDigestRule2.test.ts
import "./_isolate"; // FIRST
import { ISOLATED_CWD } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Synthetic numbers (never a real customer's).
const ACCOUNT = "8814402937";
const METER = "55120938";
const LOG = path.join(ISOLATED_CWD, "rule2-backend.log");
process.env.AUTOPILOT_LOG_FILE = LOG;
process.env.SESSION_ENCRYPTION_KEY = "rule2-test-key-not-a-real-secret";

const { setupStageFixture, check, finish } = await import("./_stageFixture");
const fx = await setupStageFixture("review-digest-rule2");
const { db, repo, recipes } = fx;
const digest = await import("../../portal-bot/src/reviewDigest");
const { recordStagedReview } = await import("../src/stagedReviews");

const NEM_URL = "https://pgenm.powerclerk.example/MvcAccount/Login";
const REVIEW_URL = "https://pgenm.powerclerk.example/MvcProjects/EditForm?ProjectId=5521&FormId=9";
recipes.savePortalRecipeSteps(db,
  recipes.startPortalRecording(db, { scopeType: "utility", state: "OR", utility: "PGE", portalUrl: NEM_URL, portalPlatform: "powerclerk", createdBy: "test" }).id,
  [...fx.fills(2), fx.REVIEW, fx.FINAL], { status: "complete", notes: "test" });

type Item = { kind: "field" | "line" | "pair" | "row" | "check"; label: string; value: string };
const reading = (items: Item[], url = REVIEW_URL) => ({ title: "Review and Submit", url, items, unreadable: "" });
// The secrets as a real draft shows them: plain in a box, with separators, inside prose, as a label.
const REVIEW_ITEMS: Item[] = [
  { kind: "line", label: "", value: "Review and Submit" },
  { kind: "field", label: "Utility Account Number", value: ACCOUNT },
  { kind: "line", label: "", value: `Customer account ${ACCOUNT.slice(0, 4)}-${ACCOUNT.slice(4, 7)}-${ACCOUNT.slice(7)} is on file for this service.` },
  { kind: "pair", label: "Meter", value: `${METER.slice(0, 2)} ${METER.slice(2, 5)} ${METER.slice(5)}` },
  { kind: "row", label: "Meter", value: `${METER} | North wall` },
  { kind: "field", label: `Acct ${ACCOUNT} holder`, value: "Avery Fenwick" },
];
const STEP_ITEMS: Item[] = [
  { kind: "field", label: "Meter Number", value: METER },
  { kind: "line", label: "", value: `Bill for acct #${ACCOUNT} attached; meter ${METER}.` },
];
const walkOf = () => ({
  sections: [
    { step: "review", where: "https://pgenm.powerclerk.example/MvcProjects/EditForm", first: reading(REVIEW_ITEMS), second: reading(REVIEW_ITEMS), unreadable: "" },
    { step: `Service ${ACCOUNT}`, where: "https://pgenm.powerclerk.example/MvcProjects/EditForm", first: reading(STEP_ITEMS), second: reading(STEP_ITEMS), unreadable: "" },
  ],
  reasons: [], stepsFound: 1, stepsRead: 1, writesBlocked: 0, reviewUrl: REVIEW_URL,
});

let handedSecrets: string[] = [];
let inMemory: Record<string, unknown> | null = null;
fx.stubRunner((async (_r: unknown, _p: unknown, _v: unknown, _d: unknown, _f: unknown, opts: unknown) => {
  const sr = (opts as { stagedReview?: { secrets?: string[] } | null })?.stagedReview;
  handedSecrets = sr?.secrets ?? [];
  // The adapter's own call: the REAL builder, over the secrets the backend handed the replay.
  const stagedReview = digest.buildStagedReviewCapture({ walk: walkOf(), secrets: handedSecrets, boundValues: [{ key: "accountNumber", value: ACCOUNT }, { key: "meterNumber", value: METER }] });
  inMemory = stagedReview as unknown as Record<string, unknown>;
  return {
    portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null, stagedReview,
    steps: [{ ok: true, message: "Opened stub portal." }, { ok: true, message: "Human review required. AUTOMATION HAS STOPPED.", data: { finalSubmitClicked: false } }],
  } as never;
}) as never);

/** The secret, digit for digit, separators ignored, never inside a longer digit run. */
const leak = (secret: string) => new RegExp(`(?<!\\d)${secret.split("").join("[\\s\\-\\u2010-\\u2015\\u2212.#/]*")}(?!\\d)`);
const leaksIn = (hay: string): string[] => [ACCOUNT, METER].filter((sec) => leak(sec).test(hay));

// Everything printed during the stage.
const printed: string[] = [];
const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
for (const k of ["log", "warn", "error", "info"] as const) {
  console[k] = (...args: unknown[]) => { printed.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); (orig[k] as (...a: unknown[]) => void)(...args); };
}
const pid = fx.newProject({ account: ACCOUNT, meter: METER });
await repo.prepareSubmission(db, pid, "nem");
for (const k of ["log", "warn", "error", "info"] as const) console[k] = orig[k];

const row = db.get<Record<string, unknown>>("SELECT * FROM portal_staged_reviews WHERE project_id = ?", [pid]);
const run = fx.latestRun(pid)!;

await check("(a) MUST PASS: the row is approvable, one 64-hex mac per item, and the field report masks both numbers to a last 4", () => {
  assert.ok(handedSecrets.includes(ACCOUNT) && handedSecrets.includes(METER), `the backend did not hand the replay the project's secrets: ${handedSecrets.length}`);
  assert.ok(row, "no staged review row");
  assert.equal(Number(row!.approvable), 1, String(row!.unapprovable_reason));
  const sections = JSON.parse(String(row!.sections_json)) as Array<{ items: Array<{ mac: string }> }>;
  const items = sections.flatMap((s) => s.items);
  assert.ok(items.length >= REVIEW_ITEMS.length + STEP_ITEMS.length, `the reading kept ${items.length} items`);
  assert.ok(items.every((i) => /^[0-9a-f]{64}$/.test(i.mac)), "an item's mac is not a 64-hex HMAC");
  const report = JSON.parse(String(row!.field_report_json)) as Array<{ label: string; display: string; source: string }>;
  const acct = report.find((r) => r.label === "Utility Account Number");
  assert.ok(acct && acct.display === `******${ACCOUNT.slice(-4)}` && acct.source === "accountNumber", JSON.stringify(acct));
  const meter = report.find((r) => r.label === "Meter Number");
  assert.ok(meter && meter.display === `****${METER.slice(-4)}` && meter.source === "meterNumber", JSON.stringify(meter));
});

await check("(b) the digits appear nowhere: the row, result_json, the audit, the submissions, the log file, the console", () => {
  const where: Array<[string, string]> = [
    ["the staged row", JSON.stringify(row)],
    ["result_json", String(run.result_json)],
    ["the audit", JSON.stringify(db.query("SELECT action, details FROM audit_logs WHERE project_id = ?", [pid]))],
    ["the submissions", JSON.stringify(db.query("SELECT * FROM submissions WHERE project_id = ?", [pid]))],
    ["the log file", fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8") : ""],
    ["the console", printed.join("\n")],
  ];
  assert.ok(where[4][1].length > 0 || printed.length > 0, "fixture: nothing was logged at all (the log scan would prove nothing)");
  for (const [name, hay] of where) assert.deepEqual(leaksIn(hay), [], `MUST-EXCLUDE: ${name} carries a secret`);
  // ...and the in-memory reading itself (what the adapter hands over) carries none either.
  assert.deepEqual(leaksIn(JSON.stringify(inMemory)), [], "the in-memory capture carries a secret");
});

await check("(c) the identity swap: the digits ride in the reading, and the writer keeps nothing of it", () => {
  const identity = digest.buildStagedReviewCapture({ walk: walkOf(), secrets: [ACCOUNT, METER], mac: (x) => x, nonce: "00112233445566778899aabbccddeeff" });
  assert.notDeepEqual(leaksIn(JSON.stringify(identity)), [], "fixture: an identity mac did not carry the digits (the scan proves nothing)");
  const pid2 = fx.newProject({ account: ACCOUNT, meter: METER });
  const w = recordStagedReview(db, { runId: `identity-${pid2}`, projectId: pid2, track: "nem", recipeId: "r", stepsSignature: "s", capture: identity, secrets: [ACCOUNT, METER] });
  assert.equal(w.approvable, false);
  assert.match(w.why, /did not come back hashed/);
  const kept = db.get<Record<string, unknown>>("SELECT * FROM portal_staged_reviews WHERE project_id = ?", [pid2])!;
  assert.deepEqual(leaksIn(JSON.stringify(kept)), [], "MUST-EXCLUDE: the writer kept a raw value");
  assert.ok((JSON.parse(String(kept.sections_json)) as Array<{ items: unknown[] }>).every((s) => s.items.length === 0));
});

finish("review-digest-rule2");
