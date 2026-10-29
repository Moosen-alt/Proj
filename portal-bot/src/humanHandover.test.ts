// #333 — THE HAND-OVER'S ORDERING, PINNED IN SOURCE.
//
// A Playwright click or key press is a TRUSTED event in the page, exactly like a person's. The review
// page is handed to a person only because two layers tell their input apart, either of which holds
// alone (filingBackstop.ts header, the hand-over):
//   (1) ORDERING: the replay closes its own input (inputsClosed) BEFORE it arms the input watch, its
//       guarded clicks / presses / steps refuse from then on, and everything it does after the watch is
//       armed only READS the page;
//   (2) THE FENCE: every input the replay makes runs inside withAutomationInput.
// This scan makes (1) and (2) durable: a later edit that adds an input to the post-review path, a
// second caller of the hand-over, or an unfenced click / key press / typing call fails here.
//
//   npx tsx portal-bot/src/humanHandover.test.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
let total = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  total++;
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), "utf8");
const listTs = (dir: string): string[] => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((d) => {
  const rel = `${dir}/${d.name}`;
  if (d.isDirectory()) return listTs(rel);
  return /\.ts$/.test(d.name) && !/\.(test|smoke)\.ts$|dom\.smoke\.ts$/.test(d.name) ? [rel] : [];
});
const recipe = read("portal-bot/src/adapters/recipeAdapter.ts");
// A class method's body: from its signature to the next member at the same indent.
const methodBody = (src: string, signature: RegExp): string => {
  const m = signature.exec(src);
  if (!m) return "";
  const start = m.index;
  const rest = src.slice(start + m[0].length);
  const next = /\n  (?:private |protected |public |static |readonly )*(?:async )?[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\(|\n  (?:private |protected |public |readonly )+[A-Za-z_$][\w$]*\s*[:=]|\n}\n/.exec(rest);
  return src.slice(start, start + m[0].length + (next ? next.index : rest.length));
};
const INPUT_CALL = /\.(?:click|dblclick|tap|press|pressSequentially|type|fill|check|uncheck|selectOption|setInputFiles|hover|dragTo|dispatchEvent|focus)\s*\(|\bkeyboard\.|\bmouse\.|guardedClick\s*\(|guardedPress\s*\(|executeStep\s*\(|dismissModalsGuarded\s*\(|clickResilient\s*\(/;

console.log("\n1. THE HAND-OVER HAS ONE DOOR");
{
  const callers = listTs("portal-bot/src").filter((f) => !/filingBackstop\.ts$/.test(f) && /\.handOverToHuman\s*\(/.test(read(f)));
  check("handOverToHuman is called from exactly one product file (recipeAdapter.ts)", callers.length === 1 && /recipeAdapter\.ts$/.test(callers[0]), JSON.stringify(callers));
  check("…and exactly once there (handOverReviewPage)", (recipe.match(/\.handOverToHuman\s*\(/g) || []).length === 1);
  const watchCallers = listTs("portal-bot/src").filter((f) => !/filingBackstop\.ts$/.test(f) && /\.watchHumanInput\s*\(/.test(read(f)));
  check("watchHumanInput is called from exactly one product file (recipeAdapter.ts), once", watchCallers.length === 1 && /recipeAdapter\.ts$/.test(watchCallers[0]) && (recipe.match(/\.watchHumanInput\s*\(/g) || []).length === 1, JSON.stringify(watchCallers));
}

console.log("\n2. THE RUN'S INPUT CLOSES BEFORE THE WATCH IS ARMED, AND ITS DOORS REFUSE AFTER");
{
  const closeAt = recipe.indexOf("this.inputsClosed = `");
  const armAt = recipe.indexOf(".watchHumanInput(");
  check("inputsClosed is set BEFORE watchHumanInput is called", closeAt > 0 && armAt > 0 && closeAt < armAt, `close=${closeAt} arm=${armAt}`);
  for (const [name, sig] of [["guardedClick", /  private async guardedClick\(/], ["guardedPress", /  private async guardedPress\(/], ["executeStep", /  private async executeStep\(/]] as const) {
    const body = methodBody(recipe, sig);
    const firstLines = body.split("\n").slice(0, 4).join("\n");
    check(`${name} refuses first thing once inputsClosed is set`, /if \(this\.inputsClosed\) throw new ReplayGuardRefusal/.test(firstLines), firstLines.slice(0, 300));
  }
}

console.log("\n3. AFTER THE WATCH IS ARMED THE RUN ONLY READS");
{
  const armAt = recipe.indexOf(".watchHumanInput(");
  const tailEnd = recipe.indexOf("const stop = !pastReview", armAt);
  const tail = armAt > 0 && tailEnd > armAt ? recipe.slice(armAt, tailEnd) : "";
  check("the runAll tail from the watch to the stop decision exists", tail.length > 200, `len=${tail.length}`);
  check("…and makes no input call", !INPUT_CALL.test(tail), (tail.match(INPUT_CALL) || [""])[0]);
  for (const [name, sig] of [
    ["drainBeforeReviewLock", /  private async drainBeforeReviewLock\(/],
    ["handOverReviewPage", /  private async handOverReviewPage\(/],
    ["armOwnSubmitWatch", /  private armOwnSubmitWatch\(/],
    ["noteHumanSubmit", /  private noteHumanSubmit\(/],
    ["verifyReviewScreen", /  private async verifyReviewScreen\(/],
    ["writeSanitizedCapture", /  private async writeSanitizedCapture\(/],
    ["whereTheRunStopped", /  private async whereTheRunStopped\(/],
    // Helm Should-fix 4: the early "where did the run stop" read and its sentence.
    ["reviewValuesOnPage", /  private async reviewValuesOnPage\(/],
    ["stoppedBeforeReviewMessage", /  private stoppedBeforeReviewMessage\(/],
    // …and the readers those call (skeptic round 1: the scan reached only the named methods).
    ["pageSafetyContext", /  private async pageSafetyContext\(/],
    ["readPortalRefusal", /  private async readPortalRefusal\(/],
    ["pageLabelNow", /  private async pageLabelNow\(/],
    ["heldHumanClick", /  private heldHumanClick\(/],
    ["firstHumanDocument", /  private firstHumanDocument\(/],
    ["pageUrlNoHash", /  private pageUrlNoHash\(/],
    // Round 4: the one "filing-shaped request after the click" predicate (a record reader).
    ["personFilingShapedRequestAfter", /  private personFilingShapedRequestAfter\(/],
    // Round 4 (Helm Blocking 1): the provisional sighting, its judgement, the late hooks and the
    // capture's readers — all run after the watch is armed, so none may make an input.
    ["sightHumanSubmit", /  private sightHumanSubmit\(/],
    ["startJudging", /  private startJudging\(/],
    ["judgeHumanClick", /  private judgeHumanClick\(/],
    ["commitHumanClick", /  private commitHumanClick\(/],
    ["reopenHumanSubmit", /  private reopenHumanSubmit\(/],
    ["hookLateHumanRequests", /  private hookLateHumanRequests\(/],
    ["scheduleCompletionReread", /  private scheduleCompletionReread\(/],
    ["rereadForCompletion", /  private async rereadForCompletion\(/],
    ["readPageForCapture", /  private async readPageForCapture\(/],
    ["readReviewForCapture", /  private async readReviewForCapture\(/],
    ["judgeCompletion", /  private judgeCompletion\(/],
    // Round 4 (Helm Blocking 2): the review step's readers of what became of the person's click (called
    // from stopAtReview, outside the tail; listed so a reader never grows an input).
    ["followUpHeldOnErrorPage", /  private followUpHeldOnErrorPage\(/],
    ["reportedHumanClick", /  private reportedHumanClick\(/],
    ["humanClickVerdict", /  private async humanClickVerdict\(/],
    ["humanClickReport", /  private humanClickReport\(/],
  ] as const) {
    const body = methodBody(recipe, sig);
    check(`${name}: found, and makes no input on the page`, body.length > 0 && !INPUT_CALL.test(body), body ? (body.match(INPUT_CALL) || [""])[0] : "not found");
  }
  // THE HAND-OVER COMES BEFORE THE DRAIN (round 2, skeptic r2 F2), and the person is told after it.
  const handAt = tail.indexOf("this.handOverReviewPage()");
  const drainAt = tail.indexOf("this.drainBeforeReviewLock()");
  const lockAt = tail.indexOf(".lockReview(");
  const yoursAt = tail.indexOf("the page is yours");
  check("the hand-over is called BEFORE the run drains its own save", handAt > 0 && drainAt > 0 && handAt < drainAt, `hand=${handAt} drain=${drainAt}`);
  check("…and the person is told 'the page is yours' only AFTER the drain and the lock", yoursAt > lockAt && lockAt > drainAt, `drain=${drainAt} lock=${lockAt} yours=${yoursAt}`);
  const scraper = read("portal-bot/src/reviewScreenScraper.ts");
  check("reviewScreenScraper.ts (the review read-back) makes no input on the page", !INPUT_CALL.test(scraper), (scraper.match(INPUT_CALL) || [""])[0]);
}

console.log("\n4. EVERY INPUT THE RUN MAKES IS FENCED");
{
  const clickBody = methodBody(recipe, /  private async guardedClick\(/);
  check("guardedClick's click runs inside withAutomationInput", /withAutomationInput\([^)]*\),?\s*\(\)\s*=>\s*\(target as \{ click/.test(clickBody), clickBody.slice(-400));
  const pressBody = methodBody(recipe, /  private async guardedPress\(/);
  check("both of guardedPress's presses run inside withAutomationInput", (pressBody.match(/withAutomationInput\(/g) || []).length >= 2, pressBody.slice(-500));
  // A call is `.pressSequentially(` or `.pressSequentially!(` (a typeof guard has no call paren).
  const typing = recipe.split("\n").filter((l) => /\.(?:pressSequentially|type)!?\s*\(/.test(l));
  const unfenced = typing.filter((l) => !/withAutomationInput\(/.test(l));
  check("every typing call (pressSequentially / type) in recipeAdapter.ts is fenced", typing.length >= 3 && unfenced.length === 0, JSON.stringify(unfenced.map((l) => l.trim().slice(0, 140))));
  // Checkbox writes too (skeptic round 1: check / uncheck were trusted input outside the fence).
  const ticks = recipe.split("\n").filter((l) => /\.(?:check|uncheck)\s*\(/.test(l));
  const unfencedTicks = ticks.filter((l) => !/withAutomationInput\(/.test(l));
  check("every checkbox write (check / uncheck) in recipeAdapter.ts is fenced", ticks.length >= 4 && unfencedTicks.length === 0, JSON.stringify(unfencedTicks.map((l) => l.trim().slice(0, 140))));
}

console.log("\n5. ONLY A CALLER THAT WATCHES FOR THE SUBMIT IS HANDED THE PAGE (Helm Should-fix 4)");
{
  // A caller with no onSubmitCaptured (the learn self-test, the cross-project replay, the benchmark)
  // never sees the person's submit: its tail click is held by the lockdown, as on main.
  check("handingOver in recipeAdapter.ts requires the caller's handOverReview option",
    /const handingOver = this\.options\.handOverReview === true && /.test(recipe), (recipe.match(/const handingOver = [^\n]*/) || [""])[0]);
  const index = read("portal-bot/src/index.ts");
  const stageAt = index.indexOf("export async function stageWithRecipe(");
  const stage = stageAt >= 0 ? index.slice(stageAt, index.indexOf("\n}\n", stageAt)) : "";
  check("index.ts stageWithRecipe passes handOverReview only when the caller gives onSubmitCaptured",
    /handOverReview: typeof options\.onSubmitCaptured === "function"/.test(stage), stage ? stage.slice(-400) : "stageWithRecipe not found");
  // GUARD PINS (green before by design: none of the three ever passed onSubmitCaptured). Kill: give
  // autoLearn.ts's stageWithRecipe call an onSubmitCaptured, and its check goes red.
  for (const rel of ["backend/src/autoLearn.ts", "backend/src/runCrossProjectReplay.ts", "backend/src/runReplayBenchmark.ts"]) {
    const src = read(rel);
    check(`${rel} stages with stageWithRecipe and gives no onSubmitCaptured (never handed over)`,
      /\bstageWithRecipe\(/.test(src) && !/onSubmitCaptured/.test(src));
  }
}

console.log("\n6. THE INPUT WATCH LIVES IN A CDP ISOLATED WORLD (Helm Should-fix 1)");
{
  // In the main world a page script could forge the person's input: find the watch's binding by its
  // prefix, read its name off Playwright's binding controller, call it from a cross-origin iframe, or
  // drive the watch's own listener through an addEventListener it wrapped before the arm. The smoke's
  // A18-A23 (+ A19o/A22o/A22b) pin the behaviour; these pin the mechanism, so an edit that moves the
  // watch back into the main world fails here too.
  const backstop = read("portal-bot/src/filingBackstop.ts");
  check("filingBackstop.ts exposes no binding and adds no init script through Playwright (exposeBinding / addInitScript are main-world)",
    !/\.exposeBinding\s*\(/.test(backstop) && !/\.addInitScript\s*\(/.test(backstop),
    (backstop.match(/\.(?:exposeBinding|addInitScript)\s*\([^\n]*/) || [""])[0].slice(0, 160));
  const sends = (method: string): string[] => backstop.match(new RegExp(`send\\(\\s*"${method.replace(/\./g, "\\.")}"[^)]*\\)`, "g")) || [];
  const addBinding = sends("Runtime.addBinding");
  check("every Runtime.addBinding send names the isolated world (executionContextName): the binding exists in no main world",
    addBinding.length >= 1 && addBinding.every((s) => /executionContextName:\s*HUMAN_INPUT_WORLD\b/.test(s)), JSON.stringify(addBinding));
  const newDoc = sends("Page.addScriptToEvaluateOnNewDocument");
  check("every Page.addScriptToEvaluateOnNewDocument send runs the watch in that world (worldName)",
    newDoc.length >= 1 && newDoc.every((s) => /worldName:\s*HUMAN_INPUT_WORLD\b/.test(s)), JSON.stringify(newDoc));
  const worlds = sends("Page.createIsolatedWorld");
  check("every Page.createIsolatedWorld send (the documents already loaded) names that world too",
    worlds.length >= 1 && worlds.every((s) => /worldName:\s*HUMAN_INPUT_WORLD\b/.test(s)), JSON.stringify(worlds));
  check("the watch's session enables Runtime and Page (without Runtime.enable a new document's world gets no binding; without Page.enable no new document runs the watch)",
    sends("Runtime.enable").length >= 1 && sends("Page.enable").length >= 1, `${sends("Runtime.enable").length} ${sends("Page.enable").length}`);
  check("the armed marker is read back from the isolated world (a Runtime.evaluate with its contextId), never through a frame's main-world .evaluate(",
    /send\(\s*"Runtime\.evaluate",\s*\{\s*expression:\s*"!!window\.__solarBackstopHumanInputArmed",\s*contextId:/.test(backstop)
      && !/\.evaluate\(\s*"!!window\.__solarBackstopHumanInputArmed"/.test(backstop));
  check("the watch script calls the binding with one argument (a raw CDP binding throws on none, and the script's catch would swallow every click while the read-back said armed)",
    /w\.\$\{HUMAN_INPUT_BINDING\}\((?!\))/.test(backstop) && !/w\.\$\{HUMAN_INPUT_BINDING\}\(\)/.test(backstop));
  // Helm Blocking 1, bullet 4: the watch's sessions are detached only after the route comes off. Not
  // observable at run time now that a disposed handler lets everything through first thing, so this
  // source pin is its only cover.
  const disposeAt = backstop.indexOf("async dispose() {");
  const disposeBody = disposeAt >= 0 ? backstop.slice(disposeAt) : "";
  const unrouteAt = disposeBody.indexOf("await target.unroute(");
  const detachAt = disposeBody.indexOf("humanSessions");
  check("dispose detaches the watch's DevTools sessions only AFTER the route comes off",
    unrouteAt > 0 && detachAt > unrouteAt, `unroute=${unrouteAt} detach=${detachAt}`);
  const head = backstop.split("\n").slice(0, 100).join("\n");
  check("the backstop's header names the isolated world and its residual (Chromium only)", /isolated world/i.test(head) && /Chromium only/.test(head));
  // A comment is read with its line breaks folded, so a reflowed sentence is still caught.
  const flat = recipe.replace(/\n\s*\/\/\s*/g, " ");
  check("recipeAdapter.ts no longer says the page's own scripts \"posting with no click still meet the lockdown\" (a page could make that click)",
    !/posting with no click still meet the lockdown/.test(flat));
}

if (failures) { console.error(`\n${failures}/${total} humanHandover.test check(s) FAILED.`); process.exit(1); }
console.log(`\nAll ${total}/${total} humanHandover.test checks passed.`);
process.exit(0);
