// EVERY HUMAN REVIEW CARD ASKS ONE PLAIN QUESTION (#544).
//
// Owner, 2026-11-02: "can we clean these up too? They're a bit confusing". Two shapes:
//   - a portal question a run left blank showed as the triage agent's note, its suggestion in an
//     editable box (Save Edit wrote the sentence into the project);
//   - the inverter's output current took two boxes: an "Auto-fill (AI)" panel with an EMPTY model
//     box even when the model was on file, and a separate amps box.
//
// Run as the SHIPPED renderReview (the production caller) with the shipped helpers lifted out of
// frontend/dashboard.js (brace-balanced cut, no Chromium), the DOM stubbed to what renderReview
// touches. Checks:
//   Q  a portal-question item renders the portal's question with its own options as radios (a select
//      past four), NOTHING pre-selected, no free-text box, a Save answer button;
//      Every question card also offers Dismiss, like a note;
//   S  Save answer POSTs this job's answer to /api/projects/:id/portal-questions — never human-verify;
//   P  the probe (skeptic, round 3): triage asks ownershipModel, a project save then writes it. The card
//      the backend names as answered on file shows the job's answer and Dismiss, no options; a save
//      from a card rendered before says the answer stands; a save that fails never shows the key;
//   A  an advisory (legacy run-triage) item is information: no input, no engineering text, Dismiss;
//   I  the inverter item is ONE card: model + qty prefilled from the snapshot (each key the issue
//      names), a lookup, no amps box; a found lookup shows "model × qty → N A total" to confirm; the
//      amps box appears only when the lookup could not find the model;
//   T  a typed QC value keeps its box and Save Edit;
//   W  every pending card says who acts and what happens after saving;
//   E  esc() everything (a hostile option is text).
//
//   npx tsx backend/test/humanReviewPlainQuestions.test.ts
import "./_isolate";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboard = fs.readFileSync(path.join(here, "..", "..", "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");

let failures = 0;
let passed = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { passed++; console.log(`  ok   - ${label}`); }
  else { failures++; console.error(`  FAIL - ${label}${detail ? `\n         ${detail.slice(0, 600)}` : ""}`); }
};

/** One top-level declaration out of dashboard.js, or null when the file has none by that name. */
const cut = (kind: "function" | "const", name: string): string | null => {
  const re = kind === "function" ? new RegExp(`^(?:async )?function ${name}\\(`, "m") : new RegExp(`^const ${name} = `, "m");
  const m = re.exec(dashboard);
  if (!m) return null;
  if (kind === "const" && !/^const \w+ = [{[]/.test(dashboard.slice(m.index, m.index + 200))) {
    return dashboard.slice(m.index, dashboard.indexOf(";", m.index) + 1);
  }
  let depth = 0, end = -1;
  for (let j = dashboard.indexOf("{", m.index); j < dashboard.length; j++) {
    if (dashboard[j] === "{") depth++;
    else if (dashboard[j] === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return dashboard.slice(m.index, end) + (kind === "const" ? ";" : "");
};

const wanted: Array<["function" | "const", string]> = [
  ["function", "esc"], ["function", "plural"], ["function", "humanize"], ["function", "statusBadge"], ["function", "camelToTitle"],
  ["const", "REVIEW_FIELD_LABELS"], ["function", "reviewLabel"], ["function", "reviewHint"],
  ["const", "REVIEW_WARNING_FIELDS"], ["function", "reviewNotesDisplay"], ["const", "ADVISORY_REVIEW_ISSUE_TYPES"],
  ["const", "REVIEW_NEXT_LINE"], ["const", "REVIEW_ADVISORY_TITLES"], ["function", "inverterSpecsFromSnapshot"],
  ["function", "inverterLookupBasis"], ["function", "inverterOutputBodyHtml"], ["function", "portalQuestionBodyHtml"],
  ["function", "reviewCardHtml"], ["function", "renderReview"], ["function", "portalQuestionChoice"],
  ["function", "savePortalQuestionAnswer"],
];
const parts: string[] = [];
const missing: string[] = [];
for (const [kind, name] of wanted) {
  const src = cut(kind, name);
  if (src) parts.push(src); else missing.push(name);
}
// Correction bodies and their proposal tables are pinned by their own suites; none of these items is one.
const stubs = ["jurisdictionProposalList", "reviewRuleProposalList"].map((n) => `function ${n}() { return []; }`)
  .concat(["jurisdictionProposalsHtml", "reviewRuleProposalsHtml", "reviewTabApplyCaption", "correctionReviewBodyHtml"].map((n) => `function ${n}() { return ""; }`))
  .filter((s) => !new RegExp(`^(?:async )?function ${s.match(/function (\w+)/)![1]}\\(`, "m").test(parts.join("\n")));

type Env = {
  state: Record<string, unknown>;
  $: (id: string) => unknown;
  api: (url: string, opts?: { method?: string; body?: string }) => Promise<unknown>;
  selectProject: (id: string) => Promise<void>;
  showMessage: (msg: string, kind?: string) => void;
  document: { querySelectorAll: (sel: string) => unknown[] };
  CSS: { escape: (s: string) => string };
};
const bundle = `const { state, $, api, selectProject, showMessage, document, CSS } = env;\n${stubs.join("\n")}\n${parts.join("\n\n")}
return {
  renderReview: typeof renderReview === "function" ? renderReview : null,
  savePortalQuestionAnswer: typeof savePortalQuestionAnswer === "function" ? savePortalQuestionAnswer : null,
};`;

const calls: Array<{ url: string; method: string; body: unknown }> = [];
const messages: string[] = [];
const els: Record<string, { textContent?: string; innerHTML?: string; querySelectorAll?: () => unknown[]; style?: Record<string, string> }> = {
  reviewCounts: { textContent: "" },
  reviewItems: { innerHTML: "", querySelectorAll: () => [] },
};
let domRadios: Array<{ dataset: Record<string, string>; checked: boolean; value: string }> = [];
/** What the next POST answers: {} by default; [P] makes it the route's refusal or its "already answered". */
let apiReply: () => Promise<unknown> = async () => ({});
const env: Env = {
  state: { selectedProjectId: "p-1", detail: null, inverterLookup: null },
  $: (id: string) => els[id] ?? null,
  api: async (url, opts) => { calls.push({ url, method: String(opts?.method || "GET"), body: opts?.body ? JSON.parse(opts.body) : null }); return apiReply(); },
  selectProject: async () => {},
  showMessage: (msg) => { messages.push(msg); },
  document: { querySelectorAll: (sel: string) => (sel.startsWith("input") ? domRadios : []) },
  CSS: { escape: (s: string) => s },
};
// eslint-disable-next-line no-new-func
const lib = new Function("env", bundle)(env) as { renderReview: (() => void) | null; savePortalQuestionAnswer: ((id: string, key: string, b?: unknown) => Promise<void>) | null };

check("the shipped helpers are all present (renderReview's card, the question save)", missing.length === 0, `missing from dashboard.js: ${missing.join(", ")}`);

const Q = "Will the System be Customer-Owned or Third-Party Owned?";
const item = (over: Record<string, unknown>) => ({
  projectId: "p-1", parserValue: "", llmSuggestedValue: "", sourceExcerpt: "", status: "pending", notes: "",
  createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z", ...over,
});
const question = item({ id: "q1", issueType: "Run triage", fieldName: "ownershipModel", sourceExcerpt: Q,
  portalQuestion: { key: "ownershipModel", label: Q, options: ["Customer-Owned", "Third-Party Owned"], control: "select" } });
const legacy = item({ id: "lg1", issueType: "Run triage", fieldName: "systemOwnership", sourceExcerpt: `Required question '${Q}' left blank`,
  llmSuggestedValue: "Add a systemOwnership field to the project record and bind it to this question so the planner can map it.",
  notes: "The project record has no system-ownership attribute, so the planner had nothing to map to this required select." });
const inverter = item({ id: "inv1", issueType: "Inverter output", fieldName: "inverterOutput",
  notes: "Enter the inverter's rated continuous AC output current in amps (per the datasheet)." });
const bus = item({ id: "bus1", issueType: "MSP bus rating", fieldName: "busRating", notes: "Enter the main service panel busbar rating in amps (e.g. 200)." });

/** Render a set of pending items through renderReview; returns each card's HTML, in item order. */
function render(items: unknown[], snapshot: Record<string, unknown> = {}, lookup: unknown = null, portalQuestions: unknown = null): string[] {
  env.state.detail = { project: { id: "p-1", parserSnapshot: snapshot }, humanReviewItems: items };
  env.state.inverterLookup = lookup;
  env.state.portalQuestions = portalQuestions;
  els.reviewItems.innerHTML = "";
  try { lib.renderReview?.(); } catch (err) { return [`RENDER THREW: ${String((err as Error).message)}`]; }
  return String(els.reviewItems.innerHTML).split("<article").slice(1);
}
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const SNAP = { invModel: "IQ8M-72-2-US", invQty: "10" };
const [qCard = "", lgCard = "", invCard = "", busCard = ""] = render([question, legacy, inverter, bus], SNAP);

console.log("\n[Q] a portal question is that question, with its options");
check("Q the portal's own wording is the card's question", qCard.includes(Q), text(qCard));
const radios = qCard.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
check("Q one radio per portal option", radios.length === 2 && radios.some((r) => r.includes('value="Customer-Owned"')) && radios.some((r) => r.includes('value="Third-Party Owned"')), radios.join(" | "));
check("Q nothing pre-selected (the answer is the person's)", !/\bchecked\b/.test(qCard) && !/\bselected\b/.test(qCard), qCard);
check("Q no free-text box and no Save Edit", !/id="review-q1"/.test(qCard) && !/Save Edit/.test(qCard) && !/<input(?![^>]*type="radio")[^>]*>/.test(qCard), qCard);
check("Q a Save answer button carrying the per-job key", /data-portal-answer="q1"/.test(qCard) && /data-portal-key="ownershipModel"/.test(qCard) && /Save answer/.test(qCard), qCard);
check("Q a Dismiss, like a note (it clears the card; it writes no answer)", /data-review-action="reject" data-review-id="q1"/.test(qCard) && /Dismiss/.test(text(qCard))
  && /clears this card/i.test(text(qCard)), qCard);
const many = item({ id: "q2", issueType: "Run triage", fieldName: "ownershipModel",
  portalQuestion: { key: "ownershipModel", label: "Ownership type", options: ["Customer-Owned", "Third-Party Owned", "Lease", "PPA", "Loan", "Cash"], control: "select" } });
const [manyCard = ""] = render([many]);
check("Q past four options: a select with a blank first choice, nothing selected", /<select[^>]*data-portal-question-select="q2"/.test(manyCard)
  && /<option value="">/.test(manyCard) && !/\bselected\b/.test(manyCard) && (manyCard.match(/<option /g) ?? []).length === 7, manyCard);

console.log("\n[S] Save answer goes through the portal-questions route");
if (lib.savePortalQuestionAnswer) {
  calls.length = 0;
  domRadios = [{ dataset: { portalQuestionOption: "q1" }, checked: true, value: "Customer-Owned" }];
  await lib.savePortalQuestionAnswer("q1", "ownershipModel");
  const post = calls.find((c) => c.method === "POST");
  check("S POST /api/projects/:id/portal-questions with this job's answer", !!post && post.url === "/api/projects/p-1/portal-questions"
    && JSON.stringify(post.body) === JSON.stringify({ answers: { ownershipModel: "Customer-Owned" } }), JSON.stringify(calls));
  check("S never the human-verify door (that would write the answer under the item's field)", !calls.some((c) => /human-verify/.test(c.url)), JSON.stringify(calls));
  calls.length = 0;
  domRadios = [{ dataset: { portalQuestionOption: "q1" }, checked: false, value: "Customer-Owned" }];
  await lib.savePortalQuestionAnswer("q1", "ownershipModel");
  check("S nothing chosen: nothing posted, the person is told to choose", calls.length === 0 && /Choose/.test(messages[messages.length - 1] || ""), JSON.stringify(calls));
} else {
  check("S savePortalQuestionAnswer exists", false, "dashboard.js has no savePortalQuestionAnswer");
}

console.log("\n[A] an advisory item is information");
check("A no input box on an advisory run-triage item", !/<input/.test(lgCard), lgCard);
check("A none of the agent's engineering text (suggestion, root cause, internal field name)",
  !/systemOwnership|planner|\bbind\b|nothing to map/i.test(text(lgCard)), text(lgCard));
check("A a Dismiss button", /data-review-action="reject"/.test(lgCard) && /Dismiss/.test(lgCard), lgCard);
check("A a run's note never reads as settled: no 'nothing to enter', it says to check the portal before submitting",
  !/nothing to enter/i.test(text(lgCard)) && /before you submit/i.test(text(lgCard)), text(lgCard));

console.log("\n[N] a run note that names an open portal question is asked as that question");
const PQ = { questions: [
  { key: "ownershipModel", label: Q, options: ["Customer-Owned", "Third-Party Owned"], unsure: false, noteItemIds: ["lg1"] },
], unansweredCount: 1, unsureCount: 0 };
const [noteAsQ = "", otherNote = ""] = render([legacy, item({ id: "lg2", issueType: "Run triage", fieldName: "portal_field", sourceExcerpt: "The city asks whether a third-party inspector will be used." })], {}, null, PQ);
const noteRadios = noteAsQ.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
check("N the note is the portal's question with its options, nothing pre-selected", noteAsQ.includes(Q) && noteRadios.length === 2 && !/\bchecked\b/.test(noteAsQ), noteAsQ);
// Asked as a question, the note saves through the portal-questions door; its Dismiss is the question
// card's own (every question card offers one, like a note) and clears only the note.
check("N it saves through the portal-questions door (Save answer with the per-job key), with the question card's Dismiss",
  /data-portal-answer="lg1"/.test(noteAsQ) && /data-portal-key="ownershipModel"/.test(noteAsQ)
  && /data-review-action="reject" data-review-id="lg1"/.test(noteAsQ) && !/data-review-action="edit"/.test(noteAsQ), noteAsQ);
check("N none of the agent's engineering text", !/systemOwnership|planner|\bbind\b|nothing to map|left blank/i.test(text(noteAsQ)), text(noteAsQ));
check("N a note the backend did not name stays a note", !/type="radio"/.test(otherNote) && /data-review-action="reject"/.test(otherNote) && /third-party inspector/.test(otherNote), otherNote);
const [resolvedNote = ""] = render([{ ...legacy, status: "rejected" }], {}, null, PQ);
check("N a dismissed note is not re-asked", !/type="radio"/.test(resolvedNote), resolvedNote);
const both = render([question, legacy], {}, null, PQ);
check("N a question a pending item already asks is asked once (the note naming it stays a note)",
  both.length === 2 && /type="radio"/.test(both[0]) && !/type="radio"/.test(both[1]) && /data-review-action="reject"/.test(both[1]), both.join("\n----\n"));

console.log("\n[P] a question the job answered since it was asked (the probe: triage asks, a project save answers)");
// GET /portal-questions no longer lists the key; it names the pending item as answered on file.
const ANSWERED_PQ = { questions: [], answeredItems: [{ itemId: "q1", key: "ownershipModel", answer: "Customer-Owned" }], unansweredCount: 0, unsureCount: 0 };
const [answeredCard = ""] = render([question], {}, null, ANSWERED_PQ);
check("P the card reads as answered, with the job's answer", /Already answered for this job/.test(text(answeredCard)) && text(answeredCard).includes("Customer-Owned"), text(answeredCard));
check("P no options to choose and no Save answer (the route would refuse them)",
  !/type="radio"/.test(answeredCard) && !/<select/.test(answeredCard) && !/data-portal-answer=/.test(answeredCard), answeredCard);
check("P it offers Dismiss", /data-review-action="reject" data-review-id="q1"/.test(answeredCard), answeredCard);
check("P no internal key on screen", !/ownershipModel/.test(text(answeredCard)), text(answeredCard));
check("P a question the backend does not name stays a question (answered is never inferred)",
  /type="radio"/.test(render([question], {}, null, { questions: [], answeredItems: [], unansweredCount: 0, unsureCount: 0 })[0] ?? ""));
if (lib.savePortalQuestionAnswer) {
  // A card rendered before the save landed still posts: the route closes the item and says what is on file.
  domRadios = [{ dataset: { portalQuestionOption: "q1" }, checked: true, value: "Third-Party Owned" }];
  apiReply = async () => ({ written: [], alreadyAnswered: [{ key: "ownershipModel", label: Q, answer: "Customer-Owned" }], remaining: 0 });
  messages.length = 0;
  await lib.savePortalQuestionAnswer("q1", "ownershipModel");
  const said = messages[messages.length - 1] || "";
  check("P already answered: the person is told the job's answer stands, in plain words", /already had an answer/i.test(said) && said.includes("Customer-Owned") && /Nothing was changed/.test(said), said);
  check("P ... and no internal key", !/ownershipModel/.test(said), said);
  // The route's refusal as it read before this fix: the message names the key.
  apiReply = async () => { throw new Error('"ownershipModel" is not an open portal question for this project.'); };
  messages.length = 0;
  await lib.savePortalQuestionAnswer("q1", "ownershipModel");
  const failed = messages[messages.length - 1] || "";
  check("P a save that still fails shows a plain message that never names the internal key", !!failed && !/ownershipModel/.test(failed), failed);
  apiReply = async () => { throw new Error('"Will the System be Customer-Owned or Third-Party Owned?" must be one of the portal\'s own options.'); };
  await lib.savePortalQuestionAnswer("q1", "ownershipModel");
  check("P a plain refusal from the route is shown as it is", /must be one of the portal's own options/.test(messages[messages.length - 1] || ""), messages[messages.length - 1] || "");
  apiReply = async () => ({});
} else {
  check("P savePortalQuestionAnswer exists", false, "dashboard.js has no savePortalQuestionAnswer");
}
const [dismissedQ = ""] = render([{ ...question, status: "rejected" }]);
check("P a dismissed question with no answer on file never reads as answered", !/\bAnswered\b/.test(text(dismissedQ)) && /Dismissed/.test(text(dismissedQ)), text(dismissedQ));

console.log("\n[I] the inverter item is one card");
const inputValue = (html: string, idPrefix: string): string | null => {
  const m = html.match(new RegExp(`<input[^>]*id="${idPrefix}[^"]*"[^>]*>`));
  if (!m) return null;
  return (m[0].match(/value="([^"]*)"/) ?? [])[1] ?? "";
};
check("I the model is prefilled from the snapshot", inputValue(invCard, "inverterModel-") === "IQ8M-72-2-US", invCard);
check("I the quantity is prefilled from the snapshot", inputValue(invCard, "inverterQty-") === "10", invCard);
check("I it offers the lookup", /data-inverter-lookup="inv1"/.test(invCard), invCard);
check("I no amps box before a lookup has failed", !/data-inverter-manual=/.test(invCard) && !/id="review-inv1"/.test(invCard), invCard);
check("I it says what the value is for (sizing the PV breaker)", /size the PV breaker/i.test(text(invCard)), text(invCard));
for (const [snap, label] of [
  [{ inverterModel: "IQ8M-72-2-US", inverterCount: "12" }, "inverterModel / inverterCount"],
  [{ pvMicroModel: "DS3-L", pvMicroQty: "8" }, "pvMicroModel / pvMicroQty"],
  [{ invModel: "SE7600H-US", inverterQty: "1" }, "invModel / inverterQty"],
] as Array<[Record<string, string>, string]>) {
  const [c = ""] = render([inverter], snap);
  const model = Object.entries(snap).find(([k]) => /Model/.test(k))![1];
  const qty = Object.entries(snap).find(([k]) => !/Model/.test(k))![1];
  check(`I prefilled from ${label}`, inputValue(c, "inverterModel-") === model && inputValue(c, "inverterQty-") === qty, c);
}
const found = render([{ ...inverter, llmSuggestedValue: "13.5" }], SNAP,
  { projectId: "p-1", itemId: "inv1", status: "found", model: "IQ8M-72-2-US", qty: 10, perUnitA: 1.35, totalA: 13.5, source: "built-in equipment table" })[0] ?? "";
check("I a found lookup reads 'IQ8M-72-2-US × 10 → 13.5 A total'", text(found).includes("IQ8M-72-2-US × 10 → 13.5 A total"), text(found));
check("I …with one Confirm button carrying the value, and no amps box", /data-inverter-confirm="inv1"[^>]*data-value="13.5"/.test(found) && !/data-inverter-manual=/.test(found), found);
const reloaded = render([{ ...inverter, llmSuggestedValue: "13.5" }], SNAP)[0] ?? "";
check("I after a reload the suggestion still reads from the snapshot's model and quantity", text(reloaded).includes("IQ8M-72-2-US × 10 → 13.5 A total"), text(reloaded));
const notFound = render([inverter], { invModel: "ZZ-UNLISTED-9000", invQty: "1" },
  { projectId: "p-1", itemId: "inv1", status: "notFound", model: "ZZ-UNLISTED-9000", qty: 1 })[0] ?? "";
check("I the amps box appears when the lookup could not find the model", /data-inverter-manual="inv1"/.test(notFound) && /id="review-inv1"/.test(notFound)
  && /couldn.t find/i.test(text(notFound)) && !/data-inverter-lookup=/.test(notFound), notFound);
const noModel = render([inverter], {})[0] ?? "";
check("I no model on file: the lookup asks for it (still no amps box)", inputValue(noModel, "inverterModel-") === "" && !/data-inverter-manual=/.test(noModel), noModel);

console.log("\n[T] a typed value keeps its box");
check("T a QC value (bus rating) keeps its input and Save Edit", /id="review-bus1"/.test(busCard) && /Save Edit/.test(busCard), busCard);

console.log("\n[W] who acts, and what happens after saving");
for (const [name, card] of [["question", qCard], ["advisory", lgCard], ["inverter", invCard], ["typed", busCard]] as Array<[string, string]>) {
  check(`W the ${name} card says who acts and what saving does`, /class="muted review-next"/.test(card) && /\b(you|nothing to enter)\b/i.test(text(card)), text(card));
}

console.log("\n[E] esc() everything");
const hostile = item({ id: "q3", issueType: "Run triage", fieldName: "ownershipModel",
  portalQuestion: { key: "ownershipModel", label: `<img src=x onerror="alert(1)">`, options: [`<b>Customer-Owned</b>`, `x" onclick="alert(1)`], control: "select" } });
const [hostileCard = ""] = render([hostile]);
check("E a hostile label and option stay text", !/<img/.test(hostileCard) && !/<b>/.test(hostileCard) && !/" onclick="/.test(hostileCard), hostileCard);

console.log(`\nhumanReviewPlainQuestions: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
