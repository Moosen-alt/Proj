// AN UNREAD PAGE IS NEVER A CLEAN PAGE (issue #534) — the learner's page-exit bookkeeping.
//
// The trust gate refuses a learn with a page its exit reading could not read, and one that reports
// no reading at all (backend/test/learnTrustBlanks.test.ts). That only means something if the
// learner never reports an unread page as read. recordPageTrustEvidence marks the page DUE first
// and moves it to `read` only when every reader answered, so:
//   1. a page that cannot be evaluated is UNREAD, and leaves no evidence;
//   2. a reading that THROWS part-way (the walk's call site swallows the throw) leaves the page
//      UNREAD — not uncounted, which would read as complete;
//   3. a page that answers every reader is READ;
//   4. a page mid-postback that refuses one evaluate and answers after the load settles is READ
//      (one bounded wait and one retry, not a false block);
//   5. a page that answers the validation reader with the portal's own words records them — the
//      fake answers as fieldValidationErrorsInPage would.
// Browser-free: a fake page whose evaluate answers by which page function it was handed.
//
// Run: npx tsx portal-bot/src/adapters/pageExitReads.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const debugTmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "page-exit-reads-test-"));
process.env.AUTOLEARN_RUN_DIR = debugTmpBase;
process.on("exit", () => { try { fs.rmSync(debugTmpBase, { recursive: true, force: true }); } catch { /* best effort */ } });

const { AutoLearnAdapter } = await import("./autoLearnAdapter");

type Reads = { read: number[]; unread: number[] };
type Internals = {
  page: unknown;
  pageExitReads: Reads;
  trustEvidence: Array<{ page: number; validationErrors: string[]; computePending: string }>;
  recordPageTrustEvidence(page: number, url: string): Promise<void>;
  collectRequiredUnchecked(): Promise<unknown>;
};
const learner = (): Internals => {
  const l = new AutoLearnAdapter("page-exit fake", (async () => ({ fills: [], atReview: false })) as never, { policyProfile: "none" });
  return l as unknown as Internals;
};
/** A fake page: the shim string is accepted; each page function gets the answer named for it. */
const fakePage = (answers: Partial<Record<"fieldValidationErrorsInPage" | "requiredCheckboxesUncheckedInPage" | "computePendingInPage", () => unknown>>) => ({
  evaluate: async (fn: unknown) => {
    if (typeof fn === "string") return undefined;
    const name = (fn as { name?: string }).name ?? "";
    const answer = (answers as Record<string, (() => unknown) | undefined>)[name];
    if (!answer) throw new Error(`no answer for ${name || "an anonymous function"}`);
    return answer();
  },
  waitForLoadState: async () => undefined,
});
const clean = { fieldValidationErrorsInPage: () => [], requiredCheckboxesUncheckedInPage: () => [], computePendingInPage: () => "" };

let failures = 0;
async function run(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ok   - ${name}`); }
  catch (err) { failures++; console.error(`  FAIL - ${name}\n         ${err instanceof Error ? err.message : String(err)}`); }
}

await run("(1) a page that cannot be evaluated is UNREAD, with no evidence", async () => {
  const l = learner();
  l.page = { evaluate: async () => { throw new Error("Execution context was destroyed"); }, waitForLoadState: async () => undefined };
  await l.recordPageTrustEvidence(3, "https://portal.example/apply");
  assert.deepEqual(l.pageExitReads, { read: [], unread: [3] });
  assert.equal(l.trustEvidence.length, 0);
});

await run("(2) a reading that throws part-way leaves the page UNREAD, never uncounted", async () => {
  const l = learner();
  l.page = fakePage(clean);
  l.collectRequiredUnchecked = async () => { throw new Error("boom"); };
  await l.recordPageTrustEvidence(4, "https://portal.example/apply").catch(() => null); // the walk's own .catch
  assert.deepEqual(l.pageExitReads, { read: [], unread: [4] });
});

await run("(3) a page that answers every reader is READ", async () => {
  const l = learner();
  l.page = fakePage(clean);
  await l.recordPageTrustEvidence(5, "https://portal.example/apply");
  assert.deepEqual(l.pageExitReads, { read: [5], unread: [] });
  assert.equal(l.trustEvidence.length, 0, "a clean page records no evidence");
});

await run("(4) a page mid-postback that answers after the load settles is READ (one retry)", async () => {
  const l = learner();
  let settled = false;
  const answers = fakePage(clean);
  l.page = {
    evaluate: async (fn: unknown) => {
      if (typeof fn !== "string" && !settled && (fn as { name?: string }).name === "fieldValidationErrorsInPage") throw new Error("Execution context was destroyed");
      return answers.evaluate(fn);
    },
    waitForLoadState: async () => { settled = true; },
  };
  await l.recordPageTrustEvidence(6, "https://portal.example/apply");
  assert.deepEqual(l.pageExitReads, { read: [6], unread: [] });
});

await run("(5) the portal's own validation words and a stale total are the page's evidence, by page", async () => {
  const l = learner();
  l.page = fakePage({
    ...clean,
    fieldValidationErrorsInPage: () => [{ label: "Model", section: "Inverter", message: "This field is required." }],
    computePendingInPage: () => '"Needs to be recalculated"',
  });
  await l.recordPageTrustEvidence(9, "https://portal.example/apply");
  assert.deepEqual(l.pageExitReads, { read: [9], unread: [] });
  assert.equal(l.trustEvidence.length, 1);
  assert.equal(l.trustEvidence[0].page, 9);
  assert.deepEqual(l.trustEvidence[0].validationErrors, ["Inverter Model: This field is required."]);
  assert.equal(l.trustEvidence[0].computePending, '"Needs to be recalculated"');
});

if (failures) {
  console.error(`\n${failures} page-exit-reads test(s) failed.`);
  process.exit(1);
}
console.log("\nAll page-exit-reads tests passed.");
