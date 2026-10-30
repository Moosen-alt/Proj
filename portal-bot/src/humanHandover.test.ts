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
// A class method's body: from its signature to the next member at the same indent (`override ` and
// accessors included, Helm Should-fix 8: `protected override async runGapFill(` was invisible), cut at
// the method's own closing brace so the next member's doc comment is not read as part of it.
const MODIFIERS = "(?:private |protected |public |static |readonly |override )*";
const methodBody = (src: string, signature: RegExp): string => {
  const m = signature.exec(src);
  if (!m) return "";
  const start = m.index;
  const rest = src.slice(start + m[0].length);
  const next = new RegExp(`\\n  ${MODIFIERS}(?:async )?(?:get |set )?[A-Za-z_$][\\w$]*\\s*(?:<[^>]*>)?\\(|\\n  (?:private |protected |public |static |readonly |override )+[A-Za-z_$][\\w$]*\\s*[:=]|\\n}\\n`).exec(rest);
  const body = src.slice(start, start + m[0].length + (next ? next.index : rest.length));
  const close = body.lastIndexOf("\n  }");
  return close > 0 ? body.slice(0, close + 4) : body;
};
const INPUT_CALL = /\.(?:click|dblclick|tap|press|pressSequentially|type|fill|check|uncheck|setChecked|selectOption|setInputFiles|hover|dragTo|dragAndDrop|dispatchEvent|focus)\s*\(|\bkeyboard\.|\bmouse\.|\btouchscreen\.|guardedClick\s*\(|guardedPress\s*\(|executeStep\s*\(|dismissModalsGuarded\s*\(|clickResilient\s*\(/;

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

console.log("\n3. AFTER THE WATCH IS ARMED THE RUN ONLY READS (Helm Should-fix 8: every call followed)");
{
  // THE TAIL: from the line that closes the run's own input to the end of runAll (so the arm's receiver
  // `this.backstop!` and the stop decision's whereTheRunStopped are both inside it). Its CLOSURE is
  // everything it can reach: every `this.X` it names is followed into X's body in recipeAdapter.ts,
  // transitively, and so is every module-level function of recipeAdapter.ts it calls. The scan FAILS
  // (by caller → callee) on:
  //   - a `this.X(` with no method body in recipeAdapter.ts's RecipeAdapter class (a getter called, a
  //     field holding a function, or an inherited BasePortalAdapter method — none can be read here);
  //   - a `super.X`, a `this[…]`, a computed call `…](` or `…].call/apply/bind(`;
  //   - a call off the backstop (this.backstop, this.handedOverBackstop, or a local / parameter that
  //     holds one, `!` and `?.` included) not on BACKSTOP_NO_INPUT, or a read of one of its members
  //     not on BACKSTOP_RECORDS (a method taken as a value);
  //   - ANY reference to a name recipeAdapter.ts imports as a value — a call of any shape (`f(`,
  //     `f?.(`, `(f)(`, `f.call(`, `new f(`) or the function taken as a value (`const g = f`, `run(f)`,
  //     `page.evaluate(f)`) — that is not on NO_INPUT_HELPERS or IMPORTED_VALUES (a module function or
  //     class of recipeAdapter.ts is followed instead, on any reference); a call to a name that is not
  //     imported, local, global or followed;
  //   - `this` taken as a value (`const self = this`, `const { m } = this`, `f.call(this)`,
  //     `(this as any).m`): only `this.` / `this!.` / `this?.` are followed;
  //   - a module loaded at run time (`import(` / `require(`);
  //   - an INPUT_CALL in any body it reaches (read RAW, comments and strings included: an in-page
  //     `el.click()` in an evaluate string counts).
  // Call DISCOVERY reads each body with comments and string text blanked but template EXPRESSIONS kept
  // (a `${this.pageLabelNow()}` is a real call): see codeOnly below and its self-check.
  // Two more roots, both run on the person's page after the hand-over: the review step (stopAtReview,
  // after fillApplication lets the page go: it reads what became of the person's click) and the capture
  // (captureSubmissionConfirmation, which index.ts calls when the person's submit is seen). Neither may
  // click either.
  // A helper a later change adds to the closure fails here BY NAME until it is added to the class (a
  // method is followed, never allowlisted) or to one of the lists below with its reason.
  // The in-page readers the closure hands to page.evaluate, and the in-page source it evaluates, are
  // covered by a raw INPUT_CALL scan of their whole module (submissionLedger.ts, portalSafety.ts).
  // NOT FOLLOWED (stated, not pinned): calls off fields other than the backstop (this.page.*,
  // this.options.*), which only INPUT_CALL's method names cover — and a page method taken as a VALUE
  // (`const c = this.page.click`, `this.page.click.bind(…)`) is not seen at all, since INPUT_CALL needs
  // the `(` right after the name and a bare `.click` cannot be told from prose; a local, parameter or
  // destructuring key spelled like an import shadows that import for the body it is declared in (any
  // identifier inside a `const {…} =` pattern counts as declared); the bodies of imported functions
  // (NO_INPUT_HELPERS is read by hand, each with its reason), except the two modules scanned whole.
  // GUARD PINS: every check here is green on the tree by design. KILLS, each run once in a throwaway
  // tree at b773db29 against this scan and against the fixed-list scan it replaced (2285c42a, 62
  // checks), the slip put just after `lockReview(\`replay stopped at review` unless it says "move":
  //   K-S8a move reassertBlanksOnce(false) below the lock → 25 FAIL, among them "reassertPass: reached
  //         via reassertBlanksOnce, makes no input" (executeStep() and "never reaches" reassertBlanksOnce
  //         / reassertPass / executeStep / guardedClick / guardedPress / dismissModalsGuarded. Old: green.
  //   K-S8b move runGapFill(this.page) below the lock → 2 FAIL: "runGapFill → super.runGapFill" and
  //         "never reaches runGapFill". Old: green.
  //   K-S8c `await dismissPageModals(this.page, …)` → 1 FAIL: "<runAll tail> → dismissPageModals(: an
  //         imported function not on NO_INPUT_HELPERS". Old: green; green at 63d3c829 too (localsOf read
  //         the tail as a signature — b773db29 closed it).
  //   K-S8d `(this as any)["guardedClick"](…)` → "a bracket call"; K-S8d2 `this["guardedClick"](…)` →
  //         "a bracket member" and "a bracket call". Old: green.
  //   K-S8e `this.backstop!.withAutomationInput(…)` → "backstop.withAutomationInput(: not on
  //         BACKSTOP_NO_INPUT". Old: green.
  //   K-S8f move answerUnrecordedRequired() below the lock → 24 FAIL, among them
  //         "answerUnrecordedRequired: reached via <runAll tail>, makes no input" (executeStep(). Old: green.
  //   K-S8g `const w = this.backstop!.withAutomationInput;` → "a member read that is not on
  //         BACKSTOP_RECORDS". Old and 63d3c829: green.
  //   K-S8h `dismissPageModals.call(null, …)` → "dismissPageModals(: … not on NO_INPUT_HELPERS". Old and
  //         63d3c829: green.
  //   K-nit-a an unfenced `.setChecked(true)` beside the last fenced `.check(` → section 4's checkbox
  //         check. Old: green.
  //   K-nit-b `this.page.dragAndDrop(…)` in verifyReviewScreen → "verifyReviewScreen: reached via
  //         <runAll tail>, makes no input". Old: green. K-nit-c `.setChecked(true)` there → that and
  //         section 4. Old: green. (`touchscreen.tap(` there is red on the old scan too, by `.tap(`:
  //         `\btouchscreen\.` is a guard for a touchscreen method Playwright may add.)
  const classAt = recipe.indexOf("\nexport class RecipeAdapter ");
  const cls = classAt >= 0 ? recipe.slice(classAt, recipe.indexOf("\n}\n", classAt) + 3) : "";
  check("the RecipeAdapter class is found in recipeAdapter.ts", cls.length > 10_000, `len=${cls.length}`);
  const esc = (s: string): string => s.replace(/[$]/g, "\\$");
  // A method or accessor, never `(?:get )?` in a method's signature (a called getter has no method body).
  const sigFor = (name: string): RegExp => new RegExp(`\\n  ${MODIFIERS}(?:async )?\\*?${esc(name)}\\s*(?:<[^>]*>)?\\(`);
  const getterFor = (name: string): RegExp => new RegExp(`\\n  ${MODIFIERS}get ${esc(name)}\\s*\\(`);
  const memberBody = (name: string): { kind: "method" | "getter"; body: string } | null => {
    const m = methodBody(cls, sigFor(name));
    if (m) return { kind: "method", body: m };
    const g = methodBody(cls, getterFor(name));
    return g ? { kind: "getter", body: g } : null;
  };
  // A module-level function of recipeAdapter.ts (outside the class): `function NAME(` or `const NAME = …`.
  const moduleSrc = classAt >= 0 ? recipe.slice(0, classAt) + recipe.slice(classAt + cls.length) : recipe;
  const moduleFnBody = (name: string): string => {
    const fn = new RegExp(`\\n(?:export )?(?:async )?function\\s*\\*?\\s*${esc(name)}\\s*(?:<[^>]*>)?\\(`).exec(moduleSrc);
    if (fn) { const end = moduleSrc.indexOf("\n}\n", fn.index); return moduleSrc.slice(fn.index, end < 0 ? undefined : end + 3); }
    // A module-level class (`new X(` follows it: its constructor and field initialisers run).
    const kl = new RegExp(`\\n(?:export )?(?:abstract )?class ${esc(name)}\\b`).exec(moduleSrc);
    if (kl) { const end = moduleSrc.indexOf("\n}\n", kl.index); return moduleSrc.slice(kl.index, end < 0 ? undefined : end + 3); }
    const cn = new RegExp(`\\n(?:export )?const ${esc(name)}\\b[^=\\n]*=\\s*(?:async\\s*)?(?:\\(|[A-Za-z_$][\\w$]*\\s*=>|function)`).exec(moduleSrc);
    if (!cn) return "";
    const rest = moduleSrc.slice(cn.index + 1);
    const end = /\n(?=[^\s})\]])/.exec(rest);
    return moduleSrc.slice(cn.index, cn.index + 1 + (end ? end.index : rest.length));
  };

  // Comments blanked, string and template TEXT blanked, regex literals blanked, template expressions
  // KEPT. A string, comment-free regex or regex literal never spans a line, so a misread `/` costs at
  // most the rest of that line.
  const codeOnly = (src: string): string => {
    let out = "";
    let i = 0;
    let depth = 0;
    const tpl: number[] = [];
    const lastToken = (): string => (/([\w$]+|[^\s])\s*$/.exec(out) || ["", ""])[1];
    const regexMayStart = (): boolean => {
      const t = lastToken();
      return t === "" || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(t) || /^(?:return|typeof|case|in|of|delete|void|throw|new|await|yield|instanceof)$/.test(t);
    };
    const template = (): void => {
      while (i < src.length) {
        const c = src[i];
        if (c === "\\") { i += 2; continue; }
        if (c === "`") { i++; out += "``"; return; }
        if (c === "$" && src[i + 1] === "{") { i += 2; tpl.push(depth); depth++; out += "` "; return; }
        if (c === "\n") out += "\n";
        i++;
      }
    };
    while (i < src.length) {
      const c = src[i];
      const d = src[i + 1];
      if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
      if (c === "/" && d === "*") {
        const e = src.indexOf("*/", i + 2);
        const end = e < 0 ? src.length : e + 2;
        out += src.slice(i, end).replace(/[^\n]/g, "");
        i = end;
        continue;
      }
      if (c === "\"" || c === "'") {
        let j = i + 1;
        while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
        out += `${c}${c}`;
        i = j + 1;
        continue;
      }
      if (c === "`") { i++; out += "`"; template(); continue; }
      if (c === "/" && regexMayStart()) {
        let j = i + 1;
        let inClass = false;
        while (j < src.length && src[j] !== "\n") {
          if (src[j] === "\\") { j += 2; continue; }
          if (src[j] === "[") inClass = true;
          else if (src[j] === "]") inClass = false;
          else if (src[j] === "/" && !inClass) break;
          j++;
        }
        if (j < src.length && src[j] === "/") {
          j++;
          while (j < src.length && /[a-z]/.test(src[j])) j++;
          out += " 0 ";
          i = j;
          continue;
        }
      }
      if (c === "{") depth++;
      if (c === "}") {
        depth--;
        if (tpl.length && tpl[tpl.length - 1] === depth) { tpl.pop(); i++; out += " `"; template(); continue; }
      }
      out += c;
      i++;
    }
    return out;
  };
  {
    // codeOnly's own pin: the shapes the tail uses, read the way discovery needs them.
    const sample = [
      "// this.commentCall()",
      "/* this.blockCall() */ const a = \"this.stringCall()\" + 'b(' + `x ${this.tplCall(`y ${inner()}`)} z(` ;",
      "const re = /(?:click|press)\\(/i.test(s) ? 1 : 2; const half = n / 2 / k; this.afterRegex();",
      "const o = { k: `${{ a: 1 }.a}` }; this.afterNested();",
    ].join("\n");
    const c = codeOnly(sample);
    check("codeOnly keeps calls in code and in template expressions, and drops comments, strings and regex literals",
      /this\.tplCall\(/.test(c) && /inner\(/.test(c) && /this\.afterRegex\(/.test(c) && /this\.afterNested\(/.test(c)
        && !/commentCall|blockCall|stringCall|click|z\(|b\(/.test(c), JSON.stringify(c));
  }

  const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "typeof", "function", "await", "async", "super", "import", "void", "delete", "in", "of", "do", "else", "try", "yield", "throw", "case", "instanceof", "as", "satisfies", "new", "keyof"]);
  const GLOBALS = new Set(["String", "Number", "Boolean", "Date", "Math", "JSON", "Array", "Object", "Promise", "Error", "RegExp", "Map", "Set", "WeakMap", "WeakSet", "URL", "URLSearchParams", "Buffer", "Symbol", "BigInt", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "queueMicrotask", "fetch", "structuredClone", "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
    // in-page reads inside an evaluate body (they run in the browser, never on the page's behalf of a click)
    "getComputedStyle"]);
  // The backstop's calls a body after the arm may make: none is an input on the page.
  const BACKSTOP_NO_INPUT: Record<string, string> = {
    watchHumanInput: "arms the input watch (CDP sessions in an isolated world); no input",
    handOverToHuman: "flips the backstop's verdict for a person's input; no input",
    lockReview: "starts the review lockdown (route state only); no input",
    personActedSinceHandOver: "reads the watch's record",
    stoppingAborts: "reads the abort record",
    handedOver: "reads the hand-over state",
  };
  // The backstop's fields a body after the arm reads: records, never callable.
  const BACKSTOP_RECORDS: Record<string, string> = {
    humanRequests: "the person's requests that went (an array)",
    aborts: "every abort (an array)",
  };
  // Imported functions the closure calls, each a reader or a pure builder (grepped: no input-shaped call).
  const NO_INPUT_HELPERS: Record<string, string> = {
    ok: "adapter.ts: builds a PortalStepResult",
    fail: "adapter.ts: builds a PortalStepResult",
    sleep: "safeAction.ts: a timer",
    drainOwnWrites: "filingBackstop.ts: waits out the run's own in-flight saves (route state only)",
    unsavedAtReviewWarning: "filingBackstop.ts: words a note",
    isStoppingAbort: "filingBackstop.ts: reads an abort record",
    armHumanCaptureOnPage: "humanCapture.ts: listens for the person's submit (an observer); no input",
    scrapeReviewScreenShared: "reviewScreenScraper.ts: the review read-back (scanned whole below)",
    reviewComparison: "reviewScreenScraper.ts: compares two readings",
    utilityIdentifiersEnteredBySteps: "reviewScreenScraper.ts: reads the recipe's steps",
    redactCaptureText: "safeAction.ts: scrubs text",
    collectPortalErrorBanner: "safeAction.ts: reads the page's error banner",
    collectValidationErrorsFrom: "autoLearnAdapter.ts: reads the page's validation messages (page.evaluate only)",
    describeBackstopAbort: "filingBackstop.ts: words an abort record",
    isPayRequestUrl: "shared/src/portalSafety.ts: a URL predicate (rule 1)",
    isSubmitOrPayRequestUrl: "shared/src/portalSafety.ts: a URL predicate",
    completionEvidence: "shared/src/portalSafety.ts: reads completion wording out of text",
    recordNumberCandidates: "recordNumber.ts: reads record numbers out of text",
    readDraftCreated: "draftCreated.ts: reads whether the page shows a created draft (page.evaluate only)",
    smartWait: "safeAction.ts: waits for a load state",
    extractRecordNumber: "recordNumber.ts: reads a record number out of text",
    pageConfirmsSubmission: "recordNumber.ts: reads completion wording out of text",
    cleanRecordLink: "adapters/submissionLedger.ts: tidies a link (#401)",
    chooseSubmittedRecord: "adapters/submissionLedger.ts: picks a record off the ledger it read (#401)",
    draftTenantKey: "draftSubmitGate.ts: builds a key from a URL",
    // Handed to page.evaluate (taken as values, run in the page): their module is scanned whole below.
    readApplicationLedgerInPage: "adapters/submissionLedger.ts: reads the application ledger in the page (#401)",
    recordLinkForNumberInPage: "adapters/submissionLedger.ts: reads a record's link in the page (#401)",
  };
  // The names recipeAdapter.ts imports as VALUES (`import type` and `type X` items left out), by their
  // local name. ANY reference to one in the closure — a call of any shape (`f(`, `f?.(`, `(f)(`,
  // `f.call(`), a `new f(`, or the function taken as a value (`const g = f`, `run(f)`) — must be on
  // NO_INPUT_HELPERS or IMPORTED_VALUES (Helm Should-fix 8, verifier round: an optional or
  // parenthesized call once read as no call at all).
  const importedValues = new Map<string, string>(); // local name → module
  for (const m of recipe.matchAll(/^import\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/gm)) {
    if (m[1]) continue;
    const [clause, from] = [m[2], m[3]];
    for (const part of clause.split(",")) {
      const p = part.replace(/[{}]/g, "").trim();
      if (!p || /^type\s/.test(p)) continue;
      const ns = /^\*\s*as\s+([A-Za-z_$][\w$]*)$/.exec(p);
      const alias = /^[A-Za-z_$][\w$]*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(p);
      const bare = /^([A-Za-z_$][\w$]*)$/.exec(p);
      const local = ns?.[1] ?? alias?.[1] ?? bare?.[1];
      if (local) importedValues.set(local, from);
    }
  }
  check("recipeAdapter.ts's value imports are read (dismissPageModals, ok, FilingBackstop left out as a type)",
    importedValues.has("dismissPageModals") && importedValues.has("ok") && importedValues.has("fs") && !importedValues.has("FilingBackstop") && !importedValues.has("PortalRecipe"),
    [...importedValues.keys()].join(", "));
  // Imported values the closure names that are not functions it calls: constants and node modules.
  // Each with what it is.
  const IMPORTED_VALUES: Record<string, string> = {
    HUMAN_REVIEW_MESSAGE: "adapter.ts: a string",
    HUMAN_SUBMIT_OBSERVED_NOTE: "humanCapture.ts: a string",
    RECORD_NUMBER_TIERS: "recordNumber.ts: an array of tier names",
    PORTAL_SAFETY_GLOBAL: "shared/src/portalSafety.ts: the in-page global's name (a string)",
    PORTAL_SAFETY_IN_PAGE_SOURCE: "shared/src/portalSafety.ts: the in-page predicates' source, evaluated in the page (the file is scanned whole below)",
    fs: "node:fs: the capture's own files on disk",
    path: "node:path: builds file paths",
  };
  // Identifiers a body declares itself (const / let / var / function / catch / parameters): a call to one
  // is a local callback (progress's `sink`, noteHumanSubmit's `fn`), never a helper of the module.
  const localsOf = (code: string, isMember: boolean): Set<string> => {
    const names = new Set<string>();
    const add = (text: string): void => { for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) names.add(m[0]); };
    for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of code.matchAll(/\b(?:const|let|var)\s*([{[][^=]*?[}\]])\s*=/g)) add(m[1]);
    for (const m of code.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of code.matchAll(/\(([^()]*)\)\s*(?::[^=;{}()]*)?=>/g)) add(m[1]);
    for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1]);
    // A method's or function's own parameter list: its first paren group, matched (never the tail's
    // text, which has no signature — a kill once read the tail up to its first `{` as "parameters").
    const open = isMember ? code.indexOf("(") : -1;
    if (open >= 0) {
      let level = 0;
      let close = open;
      for (; close < code.length; close++) {
        if (code[close] === "(") level++;
        else if (code[close] === ")" && --level === 0) break;
      }
      add(code.slice(0, close)); // its modifiers, its own name and its parameters
    }
    return names;
  };

  const runAllSig = /\n  private async runAll\(/;
  const runAllAt = (runAllSig.exec(recipe) || { index: -1 }).index;
  const runAllBody = runAllAt >= 0 ? methodBody(recipe, runAllSig) : "";
  const closeAt = recipe.indexOf("this.inputsClosed = `");
  const tail = runAllAt >= 0 && closeAt > runAllAt && closeAt < runAllAt + runAllBody.length ? recipe.slice(closeAt, runAllAt + runAllBody.length) : "";
  check("the runAll tail, from the line that closes the run's input to the end of runAll, exists", tail.length > 200 && /\n  }$/.test(tail), `len=${tail.length}`);
  check("…and makes no input call", !INPUT_CALL.test(tail), (tail.match(INPUT_CALL) || [""])[0]);
  check("…and calls the arm off the backstop after a non-null assertion (`this.backstop!.watchHumanInput(`)", tail.includes("this.backstop!.watchHumanInput("));
  const stopAtReviewBody = methodBody(cls, sigFor("stopAtReview"));
  check("the review step (stopAtReview) is found", stopAtReviewBody.length > 200, `len=${stopAtReviewBody.length}`);
  const captureBody = methodBody(cls, sigFor("captureSubmissionConfirmation"));
  check("the capture (captureSubmissionConfirmation) is found", captureBody.length > 200, `len=${captureBody.length}`);

  const closure = new Map<string, string>(); // a member or module function → who reached it first
  const freeCalls = new Map<string, string>();
  const backstopCalls = new Map<string, string>();
  const problems = new Set<string>();
  const queue: Array<{ name: string; via: string; body: string }> = [
    { name: "<runAll tail>", via: "", body: tail },
    { name: "stopAtReview", via: "<the review step>", body: stopAtReviewBody },
    { name: "captureSubmissionConfirmation", via: "<the capture of the person's page>", body: captureBody },
  ];
  closure.set("stopAtReview", "<the review step>");
  closure.set("captureSubmissionConfirmation", "<the capture of the person's page>");
  const enqueue = (name: string, via: string, body: string): void => {
    if (closure.has(name)) return;
    closure.set(name, via);
    queue.push({ name, via, body });
  };
  while (queue.length) {
    const { name, via, body } = queue.shift()!;
    if (via) check(`${name}: reached via ${via}, makes no input on the page`, !INPUT_CALL.test(body), (body.match(INPUT_CALL) || [""])[0]);
    const code = codeOnly(body);
    const locals = localsOf(code, name !== "<runAll tail>");
    for (const m of code.matchAll(/\bsuper\s*\.\s*([A-Za-z_$][\w$]*)/g)) problems.add(`${name} → super.${m[1]}: resolves outside recipeAdapter.ts`);
    for (const m of code.matchAll(/\bthis\s*[!?]?\s*(?:\?\.)?\s*\[/g)) problems.add(`${name} → this[…]: a bracket member (${code.slice(m.index!, m.index! + 40)})`);
    for (const m of code.matchAll(/\]\s*!?\s*(?:\?\.)?\s*\(|\]\s*[!?]?\s*\.\s*(?:call|apply|bind)\s*\(/g)) problems.add(`${name} → …](: a bracket call (${code.slice(Math.max(0, m.index! - 40), m.index! + 3).replace(/\s+/g, " ")})`);
    for (const m of code.matchAll(/\bthis\s*[!?]?\s*\.\s*([A-Za-z_$][\w$]*)(\s*!?\s*(?:\?\.)?\s*\()?/g)) {
      const member = m[1];
      const called = !!m[2];
      const found = memberBody(member);
      if (found && (found.kind === "method" || !called)) enqueue(member, name, found.body);
      else if (called) problems.add(`${name} → this.${member}(: no method body in recipeAdapter.ts (${found ? "a getter, called" : "a field holding a function, or an inherited method"})`);
    }
    // The backstop and every local or parameter that holds it.
    const aliases = ["this\\s*\\.\\s*backstop", "this\\s*\\.\\s*handedOverBackstop"];
    for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*this\s*\.\s*(?:backstop|handedOverBackstop)\b\s*(?:\?\?\s*this\s*\.\s*(?:backstop|handedOverBackstop)\b\s*)?[;\n]/g)) aliases.push(m[1]);
    for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*\??\s*:\s*FilingBackstop\b/g)) aliases.push(m[1]);
    // Every member the body touches on it: a call (or .call/.apply/.bind) must be on BACKSTOP_NO_INPUT, a
    // read on BACKSTOP_RECORDS — so a method taken as a value (`const w = bs.withAutomationInput`) fails too.
    const onBackstop = new RegExp(`(?<![\\w$.])(?:${aliases.join("|")})\\s*[!?]?\\s*\\.\\s*([A-Za-z_$][\\w$]*)(\\s*(?:\\.\\s*(?:call|apply|bind)\\s*)?\\()?`, "g");
    for (const m of code.matchAll(onBackstop)) {
      if (m[2]) {
        if (!backstopCalls.has(m[1])) backstopCalls.set(m[1], name);
        if (!(m[1] in BACKSTOP_NO_INPUT)) problems.add(`${name} → backstop.${m[1]}(: not on BACKSTOP_NO_INPUT`);
      } else if (!(m[1] in BACKSTOP_RECORDS) && !(m[1] in BACKSTOP_NO_INPUT)) problems.add(`${name} → backstop.${m[1]}: a member read that is not on BACKSTOP_RECORDS`);
    }
    // `this` taken as a value (`const self = this`, `const { m } = this`, `f.call(this)`, `(this as any)`)
    // carries every method past the this-member discovery above: only `this.`, `this!.`, `this?.` and
    // `this[` (which fails above) are read.
    for (const m of code.matchAll(/(?<![\w$.])this(?![\w$])(?!\s*[!?]?\s*(?:\?\.)?\s*[.[])/g)) problems.add(`${name} → this as a value: its members cannot be followed (${code.slice(Math.max(0, m.index! - 30), m.index! + 30).replace(/\s+/g, " ")})`);
    // A module loaded at run time (`await import(…)`, `require(…)`) brings names no import line lists.
    for (const m of code.matchAll(/(?<![.\w$])(?:import|require)\s*\(/g)) problems.add(`${name} → ${m[0]}: a module loaded at run time cannot be followed`);
    // Every name, called or not: a module function or class of recipeAdapter.ts is followed; an imported
    // value must be allowlisted (a reference that is not a call is a function taken as a value).
    for (const m of code.matchAll(/(?<![.\w$])(?:(new\s+)|(?<!\bnew\s+))([A-Za-z_$][\w$]*)(?![\w$])(\s*(?:<[^<>()]*>)?\s*(?:\?\.\s*)?(?:\.\s*(?:call|apply|bind)\s*(?:\?\.\s*)?)?\()?/g)) {
      const fn = m[2];
      const called = !!m[1] || !!m[3];
      if (KEYWORDS.has(fn) || GLOBALS.has(fn) || locals.has(fn)) continue;
      if (importedValues.has(fn)) {
        if (called && !freeCalls.has(fn)) freeCalls.set(fn, name);
        if (!(fn in NO_INPUT_HELPERS) && !(fn in IMPORTED_VALUES)) problems.add(`${name} → ${fn}${called ? "(" : ""}: an imported ${called ? "function" : "value"} not on NO_INPUT_HELPERS / IMPORTED_VALUES`);
        continue;
      }
      const own = moduleFnBody(fn);
      if (own) { if (called && !freeCalls.has(fn)) freeCalls.set(fn, name); enqueue(`function ${fn}`, name, own); continue; }
      if (!called) continue; // a module constant, a property key, a type name
      if (!freeCalls.has(fn)) freeCalls.set(fn, name);
      if (!(fn in NO_INPUT_HELPERS)) problems.add(`${name} → ${fn}(: a call to a name that is not imported, local or followed, and not on NO_INPUT_HELPERS`);
    }
  }
  check("the closure makes no call it cannot follow (every this.X( has a body here, no super / bracket call, every backstop and imported call or reference allowlisted)",
    problems.size === 0, [...problems].join("\n         "));
  // The fixed list this scan replaced, kept as a FLOOR: a rename or a re-cut that stops reaching one fails.
  for (const name of [
    "drainBeforeReviewLock", "handOverReviewPage", "armOwnSubmitWatch", "noteHumanSubmit", "verifyReviewScreen",
    "writeSanitizedCapture", "whereTheRunStopped", "stoppedBeforeReviewMessage", "pageSafetyContext", "readPortalRefusal",
    "pageLabelNow", "heldHumanClick", "firstHumanDocument", "pageUrlNoHash", "personFilingShapedRequestAfter",
    "sightHumanSubmit", "startJudging", "judgeHumanClick", "commitHumanClick", "reopenHumanSubmit", "hookLateHumanRequests",
    "scheduleCompletionReread", "rereadForCompletion", "readPageForCapture", "readReviewForCapture", "judgeCompletion",
    "followUpHeldOnErrorPage", "reportedHumanClick", "humanClickVerdict", "humanClickReport", "reviewValuesOnPage",
  ]) check(`the closure reaches ${name}`, closure.has(name), [...closure.keys()].join(", "));
  // …and the doors and fill paths the run makes its input through are NOT reached (the durable form of
  // the round's fence inventory: main's #353 / #362 / #387 fill paths all run above inputsClosed).
  for (const name of ["executeStep", "guardedClick", "guardedPress", "dismissModalsGuarded", "answerUnrecordedRequired",
    "reassertBlanksOnce", "reassertPass", "runGapFill", "attachOwedDocuments", "fillArrayRow", "addAnotherArrayRow"]) {
    check(`the closure never reaches ${name}`, !closure.has(name), closure.has(name) ? `reached via ${closure.get(name)}` : "");
  }
  check("the arm is seen as a backstop call (the `!` assertion is read)", backstopCalls.has("watchHumanInput"), JSON.stringify([...backstopCalls]));
  console.log(`  info - closure: ${closure.size} member(s) — ${[...closure].map(([k, v]) => `${k} ← ${v}`).join("; ")}`);
  console.log(`  info - free calls: ${[...freeCalls.keys()].join(", ")}; backstop calls: ${[...backstopCalls.keys()].join(", ")}`);
  // THE HAND-OVER COMES BEFORE THE DRAIN (round 2, skeptic r2 F2), and the person is told after it.
  const handAt = tail.indexOf("this.handOverReviewPage()");
  const drainAt = tail.indexOf("this.drainBeforeReviewLock()");
  const lockAt = tail.indexOf(".lockReview(");
  const yoursAt = tail.indexOf("the page is yours");
  check("the hand-over is called BEFORE the run drains its own save", handAt > 0 && drainAt > 0 && handAt < drainAt, `hand=${handAt} drain=${drainAt}`);
  check("…and the person is told 'the page is yours' only AFTER the drain and the lock", yoursAt > lockAt && lockAt > drainAt, `drain=${drainAt} lock=${lockAt} yours=${yoursAt}`);
  const scraper = read("portal-bot/src/reviewScreenScraper.ts");
  check("reviewScreenScraper.ts (the review read-back) makes no input on the page", !INPUT_CALL.test(scraper), (scraper.match(INPUT_CALL) || [""])[0]);
  // The modules whose functions or source the closure hands to the page to run (IMPORTED_VALUES,
  // NO_INPUT_HELPERS' in-page readers): each whole file, read raw.
  for (const rel of ["portal-bot/src/adapters/submissionLedger.ts", "shared/src/portalSafety.ts"]) {
    const src = read(rel);
    check(`${rel} (run in the page by the closure) makes no input on the page`, !INPUT_CALL.test(src), (src.match(INPUT_CALL) || [""])[0]);
  }
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
  // Checkbox writes too (skeptic round 1: check / uncheck were trusted input outside the fence; Helm's
  // nit: setChecked fires the same trusted pointerdown + mousedown).
  const ticks = recipe.split("\n").filter((l) => /\.(?:check|uncheck|setChecked)\s*\(/.test(l));
  const unfencedTicks = ticks.filter((l) => !/withAutomationInput\(/.test(l));
  check("every checkbox write (check / uncheck / setChecked) in recipeAdapter.ts is fenced", ticks.length >= 4 && unfencedTicks.length === 0, JSON.stringify(unfencedTicks.map((l) => l.trim().slice(0, 140))));
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
