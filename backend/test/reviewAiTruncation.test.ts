// THE AI HALF OF THE REVIEW GATE RAN OUT OF ROOM AND SAID NOTHING (#531).
//
// The owner's gate test (2026-11-02) put seven real residential plan sets through
// POST /api/review/upload. Every AI plan review logged "reviewPlanSetGeneral hit max_tokens"
// (about 19.6k tokens in, 4096 out) and every report came back with an EMPTY AI summary. Only the
// deterministic findings survived, so the AI pass read as "nothing found" when it had read nothing.
//
// This test drives the REAL provider (ClaudeLLMProvider) against a LOCAL HTTP STUB standing in for
// api.anthropic.com (ANTHROPIC_BASE_URL). The stub behaves like the model on a full plan set: the
// review needs NEEDED_OUTPUT_TOKENS of output (adaptive thinking shares that budget), so a request
// whose max_tokens is below it comes back cut off, stop_reason "max_tokens". No network, no spend.
//
// KILL-TESTS: put the old 4096 ceiling back and "a full plan set's review completes" goes red; take
// out the completeness reading and the "incomplete" checks go red.
//
// Run: npx tsx backend/test/reviewAiTruncation.test.ts
import "./_isolate"; // FIRST: temp cwd + data dirs, off the network (loopback still allowed)
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AiPlanReviewResult, LLMProvider, ProjectRecord } from "../../shared/src/types";

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// What a full residential plan-set review costs in output on the real model: more than the old
// 4096 ceiling (all seven real sets ran out there), well inside the new one.
const NEEDED_OUTPUT_TOKENS = 9000;
const OLD_CEILING = 4096;

const FULL_ANSWER = JSON.stringify({
  findings: [
    { title: "Attachment detail missing", message: "Show the rafter attachment detail with fastener size and embedment.", severity: "warning", codeFamily: "IRC", codeSection: "R907", sheetRef: "PV-3" },
    { title: "Rapid shutdown label", message: "Provide the rapid shutdown placard at the service.", severity: "warning", codeFamily: "NEC", codeSection: "690.56(C)", sheetRef: "PV-6" },
    { title: "Fire pathway dimension", message: "Dimension the ridge setback on the roof plan.", severity: "callout", codeFamily: "IFC", codeSection: "1205", sheetRef: "PV-2" },
  ],
  summary: "Plan set is largely complete; three items a correction letter would ask for.",
  confidence: "medium",
  notes: "",
});

type Mode = "model" | "cut-off" | "prose" | "empty-findings";
let mode: Mode = "model";
interface Captured { path: string; body: Record<string, unknown> }
let captured: Captured[] = [];
const messageCalls = (): Captured[] => captured.filter((c) => !c.path.includes("count_tokens"));

function sse(text: string, stop: string, outTok: number): string {
  const start = { type: "message_start", message: { id: "msg_stub", type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 19620, output_tokens: 0 } } };
  return [
    `event: message_start\ndata: ${JSON.stringify(start)}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outTok } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ].join("");
}

/** The model on a full plan set. Below NEEDED_OUTPUT_TOKENS the answer is cut mid-JSON. */
function answerFor(body: Record<string, unknown>): { text: string; stop: string; outTok: number } {
  const maxTokens = Number(body.max_tokens) || 0;
  if (mode === "prose") return { text: "I reviewed the sheets and they look broadly fine overall.", stop: "end_turn", outTok: 900 };
  if (mode === "empty-findings") return { text: JSON.stringify({ findings: [], summary: "No issues seen on the sheets provided.", confidence: "high", notes: "" }), stop: "end_turn", outTok: 1200 };
  if (mode === "cut-off" || maxTokens < NEEDED_OUTPUT_TOKENS) return { text: FULL_ANSWER.slice(0, 120), stop: "max_tokens", outTok: maxTokens };
  return { text: FULL_ANSWER, stop: "end_turn", outTok: NEEDED_OUTPUT_TOKENS };
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* keep {} */ }
    const path = req.url ?? "";
    captured.push({ path, body });
    if (path.includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ input_tokens: 1 })); return; }
    const a = answerFor(body);
    if (body.stream === true) { res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }); res.end(sse(a.text, a.stop, a.outTok)); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "msg_stub", type: "message", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: a.text, citations: null }], stop_reason: a.stop, stop_sequence: null, usage: { input_tokens: 19620, output_tokens: a.outTok } }));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// Imported AFTER the base URL is set: the SDK reads it when the client is constructed.
const { ClaudeLLMProvider } = await import("../src/llm");
const { runReviewPack, aiResultToFindings } = await import("../src/reviewPacks");
const { buildCodeContext } = await import("../src/codeProfiles");
const provider = new ClaudeLLMProvider("sk-ant-stub-key");

const ctx = buildCodeContext("OR", "Sample County", {
  key: "or|sample county|unknown", state: "OR", ahj: "Sample County", confidence: "seeded",
  adoptedCodes: [{ code: "IRC", edition: "2021" }, { code: "NEC", edition: "2023" }],
  amendments: [], designCriteria: { groundSnowLoadPsf: 25 },
  prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
});
const project = {
  id: "review-trunc-1", clientId: null, homeownerName: "Test Owner", projectAddress: "100 Example Way",
  city: "Sampleton", state: "OR", ahj: "Sample County", utility: "Example Power", systemSizeDcKw: 7.2,
  parserSnapshot: { state: "OR", ahj: "Sample County" },
} as unknown as ProjectRecord;

// A ~25-page plan set: 25 rendered pages offered and far more text than the prompt keeps.
const PAGES = Array.from({ length: 25 }, (_, i) => Buffer.from(`synthetic-page-${i + 1}`).toString("base64"));
const LONG_TEXT = Array.from({ length: 25 }, (_, i) => `SHEET PV-${i + 1} GENERAL NOTES ${"lorem ipsum dolor ".repeat(80)}`).join("\n");
const reviewInput = {
  workType: "solar_pv_residential" as const,
  jurisdictionLabel: "Sample County, OR",
  codeSummary: "- IRC 2021\n- NEC 2023",
  verifiedProfile: false,
  pageImagesBase64: PAGES,
  extractedText: LONG_TEXT,
  applicantFacts: { address: "100 Example Way", systemSizeDcKw: "7.2" },
};

const userBlocks = (c: Captured): Array<Record<string, unknown>> => {
  const msgs = c.body.messages as Array<{ content: Array<Record<string, unknown>> }>;
  return msgs[0].content;
};

// ---------------------------------------------------------------------------------------------
// 1. A full plan set's review has room to finish.
// ---------------------------------------------------------------------------------------------
mode = "model";
captured = [];
const full = await provider.reviewPlanSetGeneral(reviewInput);

await check(`KILL-TEST: a full plan set's review completes (needs ${NEEDED_OUTPUT_TOKENS} output tokens; the old ceiling was ${OLD_CEILING})`, () => {
  assert.equal(full.completeness, "complete", `completeness=${full.completeness} notes=${full.notes}`);
  assert.equal(full.findings.length, 3);
  assert.ok(full.summary.length > 0, "the summary came back");
});

await check("the request's ceiling covers the review, and the call streams (a 16k answer outlasts the 240 s client timeout)", () => {
  const calls = messageCalls();
  assert.equal(calls.length, 1, `one model call, no retry (${calls.length})`);
  assert.ok(Number(calls[0].body.max_tokens) >= NEEDED_OUTPUT_TOKENS, `max_tokens=${calls[0].body.max_tokens}`);
  assert.equal(calls[0].body.stream, true, "streamed");
});

await check("no more input than before: 8 of 25 page images, plan text cut to 6000 characters", () => {
  const blocks = userBlocks(messageCalls()[0]);
  assert.equal(blocks.filter((b) => b.type === "image").length, 8);
  const text = blocks.filter((b) => b.type === "text").map((b) => String(b.text)).join("\n");
  const plan = text.split("Extracted plan text (may be partial):\n")[1] ?? "";
  const planBody = plan.split("\n\nPerform the pre-review now.")[0];
  assert.ok(planBody.length <= 6000, `plan text sent: ${planBody.length} chars`);
  assert.ok(text.length < 8000, `whole user text: ${text.length} chars`);
});

await check("a complete review maps to its findings with no 'incomplete' finding", () => {
  const findings = aiResultToFindings(full, ctx);
  assert.equal(findings.length, 3);
  assert.ok(!findings.some((f) => f.id === "ai.review.incomplete"));
});

// ---------------------------------------------------------------------------------------------
// 2. When the answer is cut off anyway, the report says so.
// ---------------------------------------------------------------------------------------------
// A plan set whose review outgrows ANY ceiling: the answer is cut off whatever max_tokens says.
mode = "cut-off";
captured = [];
const cut = await provider.reviewPlanSetGeneral(reviewInput);

await check("a cut-off answer (stop_reason max_tokens) is INCOMPLETE, never an empty clean review", () => {
  assert.equal(cut.completeness, "incomplete");
  assert.match(cut.notes, /cut off/i);
  assert.equal(messageCalls().length, 1, "no retry: a retry would re-send every page image");
});

captured = [];
const solarCut = await runReviewPack({
  workType: "solar_pv_residential", project, ctx, llm: provider,
  pageImagesBase64: PAGES, extractedText: LONG_TEXT, includeAiSecondOpinion: true,
});

await check("solar pack (the project shape the gate test ran): the report carries 'AI review incomplete'", () => {
  const f = solarCut.report.findings.find((x) => x.id === "ai.review.incomplete");
  assert.ok(f, `no incomplete finding among ${solarCut.report.findings.map((x) => x.id).join(", ")}`);
  assert.equal(f.category, "ai_review");
  assert.equal(f.severity, "warning", "asks for action");
  assert.equal(f.installerCallout, false);
  assert.match(f.message, /does NOT mean the plan set has no issues/);
  assert.ok(solarCut.report.findings.some((x) => x.severity === "blocker" && x.category !== "ai_review"), "deterministic findings still there");
  assert.equal(solarCut.report.findings.filter((x) => x.category === "ai_review" && x.severity === "blocker").length, 0, "AI never blocks");
});

await check("...and its summary is not empty: it says the AI review is incomplete", () => {
  assert.ok(solarCut.ai, "the AI result is returned");
  assert.match(solarCut.ai!.summary, /AI review incomplete/);
});

// ---------------------------------------------------------------------------------------------
// 3. An answer that ended on its own but is not the requested JSON is incomplete too.
// ---------------------------------------------------------------------------------------------
mode = "prose";
captured = [];
const prose = await provider.reviewPlanSetGeneral(reviewInput);

await check("an unparseable answer (end_turn, prose) is INCOMPLETE", () => {
  assert.equal(prose.completeness, "incomplete");
  assert.match(prose.notes, /could not be read/i);
});

const deckProse = await runReviewPack({ workType: "deck", project, ctx, llm: provider, pageImagesBase64: PAGES.slice(0, 3), extractedText: "deck plan" });

await check("AI-served work type (deck): the unreadable answer puts 'AI review incomplete' on the report", () => {
  assert.ok(deckProse.report.findings.some((x) => x.id === "ai.review.incomplete"));
  assert.match(deckProse.ai!.summary, /AI review incomplete/);
});

// ---------------------------------------------------------------------------------------------
// 4. A clean "nothing found" stays clean: the warning does not cry wolf.
// ---------------------------------------------------------------------------------------------
mode = "empty-findings";
const clean = await provider.reviewPlanSetGeneral(reviewInput);

await check("a complete answer with zero findings is complete, and adds no 'incomplete' finding", () => {
  assert.equal(clean.completeness, "complete");
  assert.equal(aiResultToFindings(clean, ctx).length, 0);
});

// ---------------------------------------------------------------------------------------------
// 5. A failed call is not silent either (the solar second opinion used to swallow it).
// ---------------------------------------------------------------------------------------------
const throwingLlm = { reviewPlanSetGeneral: async () => { throw new Error("upstream overloaded"); } } as unknown as LLMProvider;
const solarThrow = await runReviewPack({
  workType: "solar_pv_residential", project, ctx, llm: throwingLlm,
  pageImagesBase64: PAGES, extractedText: LONG_TEXT, includeAiSecondOpinion: true,
});

await check("solar second opinion whose call throws: 'AI review incomplete' on the report, summary says so", () => {
  const f = solarThrow.report.findings.find((x) => x.id === "ai.review.incomplete");
  assert.ok(f, "the failure is on the report");
  assert.match(f.message, /call failed/);
  assert.ok(solarThrow.ai, "an AI result is returned, not null");
  assert.match(solarThrow.ai!.summary, /AI review incomplete/);
});

const deckThrow = await runReviewPack({ workType: "deck", project, ctx, llm: throwingLlm, extractedText: "deck plan" });

await check("AI-served work type whose call throws: 'incomplete', not 'configure an API key'", () => {
  assert.ok(deckThrow.report.findings.some((x) => x.id === "ai.review.incomplete"));
  assert.ok(!deckThrow.report.findings.some((x) => x.id === "ai.review.unavailable"));
});

// ---------------------------------------------------------------------------------------------
// 6. An unknown completeness (a producer that never said) reads as incomplete.
// ---------------------------------------------------------------------------------------------
await check("a result with no completeness field is treated as incomplete (fails closed)", () => {
  const unknown = { provider: "claude", findings: [], summary: "", confidence: "low", notes: "" } as unknown as AiPlanReviewResult;
  assert.ok(aiResultToFindings(unknown, ctx).some((x) => x.id === "ai.review.incomplete"));
});

server.close();
console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) {
  console.error(`${failures} review AI truncation test(s) FAILED.`);
  process.exit(1);
}
console.log("All review AI truncation tests passed.");
