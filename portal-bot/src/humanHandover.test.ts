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
// second caller of the hand-over, or an unfenced click / key press / typing call fails here. "An input"
// means one INPUT_CALL can NAME: a Playwright input method in any call shape, a called run door
// (guardedClick, executeStep, …), a `keyboard.` / `mouse.` / `touchscreen.` reference, a raw DevTools
// session or an Input-domain method. Section 0 pins the call shapes and the DevTools / Input-domain
// patterns both ways; the keyboard / mouse / touchscreen patterns have no section-0 row. Section 3
// separately fails on a call it cannot follow (a bracket call, `import(`, an unlisted import). It is a
// source scan, not a proof: what section 3 lists under NOT FOLLOWED (a method reached by a computed
// name, an input method taken as a value) is not seen.
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

// Comments blanked, string and template TEXT blanked, regex literals blanked, template expressions
// KEPT. A string, comment-free regex or regex literal never spans a line, so a misread `/` costs at
// most the rest of that line. `at[k]` is the source index the k-th character of `code` came from
// (every `{`, `}` and line break is copied as it stands), so a position found in the code maps back
// to the raw source (methodBody below). `inside[p]` is 1 where source index p is inside something:
// string or template text, a template's own backticks and `${`, or any character while a `(`, `[` or
// `{` (a template expression's included) is open. statementFrom below: a line at column 0 there is
// no new statement.
const codeOnlyMapped = (src: string): { code: string; at: number[]; inside: Uint8Array } => {
  let out = "";
  const at: number[] = [];
  const inside = new Uint8Array(src.length + 1);
  const emit = (s: string, from: number): void => { out += s; for (let k = 0; k < s.length; k++) at.push(from); };
  let i = 0;
  let depth = 0;
  let paren = 0;
  const tpl: number[] = [];
  // One flag per open `(` / `[`: true for the `(` of an `if (…)`, `while (…)`, `for (…)` or `with (…)`
  // head. After THAT `)` a `/` starts a regex literal (`if (x) /\{/.test(s)`); after any other `)` it
  // is a division (verifier V-A1: two such regexes read as divisions counted their braces, a balanced
  // pair, so a fake `  }` line ended a method before a click).
  const heads: boolean[] = [];
  let closedHead = false;
  const lastToken = (): string => (/([\w$]+|[^\s])\s*$/.exec(out) || ["", ""])[1];
  const regexMayStart = (): boolean => {
    const t = lastToken();
    if (t === ")") return closedHead;
    return t === "" || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(t) || /^(?:return|typeof|case|in|of|delete|void|throw|new|await|yield|instanceof)$/.test(t);
  };
  const template = (): void => {
    while (i < src.length) {
      const c = src[i];
      inside[i] = 1;
      if (c === "\\") { inside[i + 1] = 1; i += 2; continue; }
      if (c === "`") { emit("``", i); i++; return; }
      if (c === "$" && src[i + 1] === "{") { inside[i + 1] = 1; emit("` ", i); i += 2; tpl.push(depth); depth++; return; }
      if (c === "\n") emit("\n", i);
      i++;
    }
  };
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    const nested = depth > 0 || paren > 0 ? 1 : 0;
    if (c === "/" && d === "/") { const from = i; while (i < src.length && src[i] !== "\n") i++; inside.fill(nested, from, i); continue; }
    if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? src.length : e + 2;
      for (let k = i; k < end; k++) if (src[k] === "\n") emit("\n", k);
      inside.fill(nested, i, end);
      i = end;
      continue;
    }
    if (c === "\"" || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      emit(`${c}${c}`, i);
      inside[i] = nested;
      inside.fill(1, i + 1, Math.min(j + 1, src.length));
      i = j + 1;
      continue;
    }
    if (c === "`") { inside[i] = 1; emit("`", i); i++; template(); continue; }
    inside[i] = nested;
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
        emit(" 0 ", i);
        inside.fill(nested, i, j);
        i = j;
        continue;
      }
    }
    if (c === "(" || c === "[") { heads.push(c === "(" && /(?<![\w$.]|\.\s+)(?:if|while|for|with)\s*$/.test(out.slice(-24))); paren++; }
    if (c === ")" || c === "]") { closedHead = heads.pop() === true; paren--; }
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (tpl.length && tpl[tpl.length - 1] === depth) { tpl.pop(); emit(" `", i); i++; template(); continue; }
    }
    emit(c, i);
    i++;
  }
  return { code: out, at, inside };
};
const codeOnly = (src: string): string => codeOnlyMapped(src).code;

// A block's text: from `start` (a declaration's signature) to its OWN closing brace, found by brace
// matching on the code (codeOnly: comments, strings and template text blanked) and returned RAW (the
// input scan reads strings and comments too). It ends at the first `}` that brings the brace depth
// counted from `start` back to 0 on a line that is exactly `indent` + `}` (trailing blanks aside) and
// is followed by what can follow a block (endsHere below): a return type's braces (`): Promise<{ … }>
// {`) and a multi-line parameter type's (`  }) {`) close mid-line, and one that closes on its own
// `indent` + `}` line is followed by no next declaration. Step 21.2 (the rule-1 verifier): a member's end was once found on the RAW text (the next-
// member regex, `\n}\n`), which also read a template literal's continuation line indented two spaces
// (`` `review\n  note(s) follow` ``) or a "\n}\n" inside a template as the end, so a followed body was
// cut short and an input call after the cut was never scanned. A block that never reaches that line,
// or whose depth goes below 0, is UNTERMINATED: it is recorded by its signature line in bodyFaults
// (section 3 FAILS on it) and returned to the end of `src`, so the scan reads more, never less.
const bodyFaults = new Set<string>();
// Each source is read once (lexed whole, from its first character); a block's start is found in the
// code by the map.
const mappedCache = new Map<string, ReturnType<typeof codeOnlyMapped>>();
const mappedAt = (src: string, start: number): ReturnType<typeof codeOnlyMapped> & { k0: number } => {
  let m = mappedCache.get(src);
  if (!m) { m = codeOnlyMapped(src); mappedCache.set(src, m); }
  let lo = 0;
  let hi = m.at.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (m.at[mid] < start) lo = mid + 1; else hi = mid; }
  return { ...m, k0: lo };
};
// A depth-0 `indent` + `}` line is the block's end only if what comes next can follow one (verifier
// V-A5: a return type written `): string & {` / `    readonly brand?: never;` / `  }` / `  {` closed
// at that `  }`, so the body after it was never read): the next code line (comments are blank lines in
// the code) is the end of the text, an enclosing `}` at a shorter indent, or a line at exactly `indent`
// that starts the next declaration: for a class member, a member's signature (modifiers, then a name
// that is no statement keyword, then `(`, `<`, `:`, `=`, `;`, `?` or `!`; or a decorator, or a static
// block); at column 0, a name. Anything else (`  {`, `  > {`, `  ): T {`, `  & {`, `  await …`) means
// that `}` closed a type or a block inside the body: the match reads on, so the scan reads more, never
// less, and a block that then never closes FAILS below (unterminated, or its braces below depth 0).
const STATEMENT_WORDS = /^(?:if|else|for|while|do|switch|case|default|return|void|await|yield|typeof|delete|new|throw|try|catch|finally|with|break|continue|debugger|super|this|const|let|var|function|class|import|export|in|of|instanceof)$/;
const endsHere = (after: string, indent: string): boolean => {
  const next = /\n([ \t]*)(\S[^\n]*)/.exec(after);
  if (!next) return true; // only blanks to the end of the text
  const [, lead, text] = next;
  if (indent && lead.length < indent.length && text[0] === "}") return true;
  if (lead !== indent) return false;
  if (!indent) return /^[A-Za-z_$@]/.test(text);
  if (/^@|^static\s*\{/.test(text)) return true;
  const member = /^(?:(?:private|protected|public|static|readonly|override|abstract|declare|accessor|async|get|set)\s+)*\*?\s*#?([A-Za-z_$][\w$]*)\s*[?!]?\s*[(<:=;]/.exec(text);
  return !!member && !STATEMENT_WORDS.test(member[1]);
};
const blockFrom = (src: string, start: number, indent: string): string => {
  const rest = src.slice(start);
  const { code, at, k0 } = mappedAt(src, start);
  const sigLine = rest.replace(/^\n/, "").split("\n")[0].trim().slice(0, 120);
  const lineStart = `\n${indent}`;
  let depth = 0;
  for (let k = k0; k < code.length; k++) {
    const c = code[k];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth < 0) { bodyFaults.add(`${sigLine}: its braces go below depth 0 before its body ends`); return rest; }
      if (depth === 0 && code.slice(k - lineStart.length, k) === lineStart && /^[ \t]*(?:\n|$)/.test(code.slice(k + 1, k + 200))
        && endsHere(code.slice(k + 1), indent)) return src.slice(start, at[k] + 1);
    }
  }
  bodyFaults.add(`${sigLine}: unterminated (no closing \`${indent}}\` line at depth 0 before the end of the text)`);
  return rest;
};
// A statement at column 0 (`const H = { … };`, `const f = (…) => …;`): from its line to the next line
// that starts at column 0 with no blank, `}`, `)` or `]` (the next statement, or the next one's doc
// comment), where that line's first character is inside nothing (codeOnlyMapped's `inside`: step 21.2,
// a template's continuation line, its closing backtick or a `${` at column 0 once ended it, and so
// did a comment line at column 0 inside an object). Returned raw; with none after it, the rest of
// `src`. NOT SEEN: an expression continued at column 0 outside every bracket (`\n+ f()`,
// `\n.concat(…)`) is read as the next statement; this repo indents its continuations.
const statementFrom = (src: string, start: number): string => {
  const { inside } = mappedAt(src, start);
  const next = /\n(?=[^\s})\]])/g;
  next.lastIndex = start + 1;
  for (let end = next.exec(src); end; end = next.exec(src)) if (!inside[end.index + 1]) return src.slice(start, end.index);
  return src.slice(start);
};
// A class method's body: from its signature to its own `  }` line (blockFrom). Accessors and
// `override ` are matched by the signature (Helm Should-fix 8: `protected override async runGapFill(`
// was invisible).
const MODIFIERS = "(?:private |protected |public |static |readonly |override )*";
const methodBody = (src: string, signature: RegExp): string => {
  const m = signature.exec(src);
  return m ? blockFrom(src, m.index, "  ") : "";
};
// A call of any shape after a name: `m(`, `m!(`, `m?.(`, `m!?.(`, and `m.call(` / `.apply(` / `.bind(`
// (each optional or non-null too). Helm Should-fix 8's nit and its verifier round: `.click?.()`,
// `.click!()` and `.press?.("Enter")` are trusted clicks and key presses exactly like `.click()`.
const CALL = String.raw`\s*(?:!\s*)?(?:\?\.\s*)?(?:\.\s*(?:call|apply|bind)\s*(?:!\s*)?(?:\?\.\s*)?)?\(`;
// `clear` is the same write as `fill` (it fires input events on the field). `requestSubmit` is left out
// on purpose: it makes no input event (the lockdown holds it, as A15 pins for untrusted events), and the
// in-page source scanned whole names it in a comment.
const INPUT_METHODS = "click|dblclick|tap|press|pressSequentially|type|fill|clear|check|uncheck|setChecked|selectOption|setInputFiles|hover|dragTo|dragAndDrop|dispatchEvent|focus";
const INPUT_CALL = new RegExp([
  `\\.\\s*(?:${INPUT_METHODS})${CALL}`,
  // A bracket member named like one, CALLED (`el['click']()`): a bare `el["type"]` is an attribute read.
  `\\[\\s*["'\`](?:${INPUT_METHODS})["'\`]\\s*\\]${CALL}`,
  String.raw`\bkeyboard\.`, String.raw`\bmouse\.`, String.raw`\btouchscreen\.`,
  `\\b(?:guardedClick|guardedPress|executeStep|dismissModalsGuarded|clickResilient)${CALL}`,
  // Trusted input sent over a raw DevTools session (step 21's verifier: `newCDPSession(…)` then
  // `send("Input.dispatchMouseEvent", …)` after the lock read as no input). The session's factory is
  // matched on ANY reference, called or taken as a value (nothing after the arm opens a session: the
  // watch's own sessions are opened inside watchHumanInput, in filingBackstop.ts), and the Input
  // domain's methods by their raw names, read in strings too (a session handed in from elsewhere still
  // names the method it sends). A bare word "Input" is no match: only `Input.` plus one of these names.
  String.raw`\bnew(?:Browser)?CDPSession\b`,
  String.raw`\bInput\.(?:dispatch\w*Event|insertText|imeSetComposition|synthesize\w+|emulateTouchFromMouseEvent)\b`,
].join("|"));
const TYPING_CALL = new RegExp(`\\.\\s*(?:pressSequentially|type)${CALL}`);
const TICK_CALL = new RegExp(`\\.\\s*(?:check|uncheck|setChecked)${CALL}`);

console.log("\n0. THE INPUT PATTERNS READ EVERY CALL SHAPE (Helm Should-fix 8, the INPUT_CALL nit)");
{
  // A trusted input written as an optional call (`.click?.(`), a non-null call (`.click!(`), through
  // `.call` / `.apply` / `.bind`, or as a called bracket member (`['click']()`) is the same click.
  // Filter lists fail both ways, so the shapes that are NOT input are pinned too.
  const mustMatch = [
    "await this.page!.getByRole(\"button\").first().click?.();",
    "await (this.page!.getByRole(\"button\").first() as any).click!();",
    "await this.page!.locator(\"#x\").press?.(\"Enter\");",
    "await this.page!.mainFrame()?.click?.(\"b\");",
    "await this.page!.locator(\"#x\").clear();",
    "document.querySelector('button')['click']()",
    "HTMLElement.prototype.click.call(b)",
    "el.dispatchEvent?.(new MouseEvent(\"click\"))",
    "await this.guardedClick?.(step)",
    "await this.executeStep!(step, true)",
  ];
  const mustNotMatch = [
    "const label = v.click?.label;",
    "if (inf?.type !== \"radio\") return true;",
    "typeof scoped!.pressSequentially === \"function\"",
    "const t = el[\"type\"];",
    "step.type === \"click\"",
    "this.page!.click",
  ];
  const missed = mustMatch.filter((s) => !INPUT_CALL.test(s));
  const wrong = mustNotMatch.filter((s) => INPUT_CALL.test(s));
  check("INPUT_CALL reads an optional, non-null, .call and called-bracket input as input, and a property read as none",
    missed.length === 0 && wrong.length === 0, `missed: ${JSON.stringify(missed)} wrongly read: ${JSON.stringify(wrong)}`);
  // Trusted input over a raw DevTools session (step 21's verifier, K-S8z8): the session's factory on
  // any reference, and each Input-domain method by its raw name. The word "Input" in prose, a string or
  // a longer name is not the Input domain.
  const cdpMust = [
    "const cdp = await this.page!.context().newCDPSession(this.page!);",
    "const cdp = await ctx.newCDPSession?.(page);",
    "const open = ctx.newCDPSession;",
    "const bs = await browser.newBrowserCDPSession();",
    "await cdp.send(\"Input.dispatchMouseEvent\", { type: \"mousePressed\", x: 1, y: 1 });",
    "await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter' });",
    "await s.send(\"Input.dispatchTouchEvent\", { type: \"touchStart\", touchPoints: [] })",
    "await s.send(\"Input.dispatchDragEvent\", { type: \"drop\", x: 1, y: 1, data: d })",
    "await s.send(\"Input.insertText\", { text: \"x\" })",
    "await s.send(\"Input.imeSetComposition\", { text: \"x\", selectionStart: 0, selectionEnd: 0 })",
    "await s.send(\"Input.synthesizeTapGesture\", { x: 1, y: 1 })",
    "await s.send(\"Input.emulateTouchFromMouseEvent\", { type: \"mousePressed\", x: 1, y: 1, button: \"left\" })",
  ];
  const cdpMustNot = [
    "// Input: the person's click is theirs once the watch is armed.",
    "const v = Input.value;",
    "export const NOTE = \"Input from the person was not handed over\";",
    "Input.dispatched by a person is recorded",
    "the arm is watchHumanInput.dispatchMouseEvent-free",
    "const n = cdpSessionCount + newCDPSessions;",
  ];
  const cdpMissed = cdpMust.filter((s) => !INPUT_CALL.test(s));
  const cdpWrong = cdpMustNot.filter((s) => INPUT_CALL.test(s));
  check("INPUT_CALL reads a raw DevTools session (newCDPSession / newBrowserCDPSession, called or taken) and the Input domain's methods as input, and the word Input in prose as none",
    cdpMissed.length === 0 && cdpWrong.length === 0, `missed: ${JSON.stringify(cdpMissed)} wrongly read: ${JSON.stringify(cdpWrong)}`);
  const typingMust = ["await scoped.type?.(v)", "await scoped!.type!(v, { delay: 35 })", "await loc.pressSequentially?.(v)"];
  const tickMust = ["await box.setChecked?.(true)", "await box.check!()", "await box.uncheck?.()"];
  const notTyping = ["typeof scoped!.type === \"function\"", "if (inf?.type !== \"radio\")"];
  check("section 4's typing and checkbox patterns read optional and non-null calls (`.type?.(`, `.setChecked?.(`, `.check!(`)",
    typingMust.every((s) => TYPING_CALL.test(s)) && tickMust.every((s) => TICK_CALL.test(s)) && !notTyping.some((s) => TYPING_CALL.test(s)),
    JSON.stringify({ typing: typingMust.filter((s) => !TYPING_CALL.test(s)), ticks: tickMust.filter((s) => !TICK_CALL.test(s)), wrong: notTyping.filter((s) => TYPING_CALL.test(s)) }));
}

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
  // transitively, and so is every module-level function, class, object or value of recipeAdapter.ts it
  // names, and every static method it calls off the class name (`RecipeAdapter.X(`, followed into the
  // class like a `this.X(`). The scan FAILS (by caller → callee) on:
  //   - a `this.X(` or `RecipeAdapter.X(` with no method body in recipeAdapter.ts's RecipeAdapter class
  //     (a getter called, a field holding a function, or an inherited BasePortalAdapter method — none can
  //     be read here); `this.constructor`, or the class name taken as a value (a type position aside);
  //   - a `super.X`, a `this[…]`, a computed call `…](` or `…].call/apply/bind(`;
  //   - a call off the backstop (this.backstop, this.handedOverBackstop — `this!.` / `this?.` too — or a
  //     local / parameter that holds one) not on BACKSTOP_NO_INPUT, or a read of one of its members not
  //     on BACKSTOP_RECORDS (a method taken as a value). A HOLDER is the field, a parameter typed
  //     FilingBackstop, or a local declared from a holder as `= h`, `= h!`, `= h as T`, `= h satisfies T`
  //     or `= h ?? h2 / null / undefined`;
  //   - the backstop taken as a VALUE: a read of a holder that is not a member access (`.m`, `!.m`,
  //     `?.m`), and not one of: an alias's own declaration or a store back into the field; a write
  //     (`h = …`); a declared name or FilingBackstop parameter; a whole positional argument of a followed
  //     `this.X(` whose parameter there is typed FilingBackstop; a test whose value never leaves (`!h`,
  //     `!!h`, `typeof h`, `h && …`, `h ? a : b`, `h === x`, `if (h)`). So `run(bs)`, `[bs]`, `{ bs }`,
  //     `h || x`, `x && h`, `const { m } = bs` and an alias declared in any other shape all fail;
  //   - ANY reference to a name recipeAdapter.ts imports as a value — a call of any shape (`f(`,
  //     `f?.(`, `(f)(`, `f.call(`, `new f(`) or the function taken as a value (`const g = f`, `run(f)`,
  //     `page.evaluate(f)`) — that is not on NO_INPUT_HELPERS or IMPORTED_VALUES (a module function,
  //     class, object or value of recipeAdapter.ts is followed instead, on any reference); a call to a
  //     name that is not imported, local, global or followed;
  //   - `this` taken as a value (`const self = this`, `const { m } = this`, `f.call(this)`,
  //     `(this as any).m`): only `this.` / `this!.` / `this?.` are followed;
  //   - a module loaded at run time (`import(` / `require(`);
  //   - an INPUT_CALL in any body it reaches (read RAW, comments and strings included: an in-page
  //     `el.click()` or `el['click']()` in an evaluate string counts). INPUT_CALL takes every call shape
  //     after the method name (CALL: `m(`, `m!(`, `m?.(`, and `.call(` / `.apply(` / `.bind(`), a
  //     CALLED bracket member named like one, any reference to `newCDPSession` / `newBrowserCDPSession`
  //     (a raw DevTools session sends trusted input past every Playwright method name), and the Input
  //     domain's methods by raw name (`Input.dispatchMouseEvent`, `Input.insertText`, …, in a string
  //     too); section 0 pins it both ways.
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
  // this.options.*) and off static fields (`RecipeAdapter.WRITE_ACTIONS.has(`), which only INPUT_CALL's
  // method names cover — and an input method taken as a VALUE without a call (`const c =
  // this.page.click`, `const c = el['click']` in the page, `HTMLElement.prototype.click` stored) is not
  // seen at all, since a bare `.click` or `['click']` cannot be told from prose or an attribute read
  // (`.click.call(`, `.click.bind(` and `['click'](` ARE seen); a member reached by a COMPUTED name
  // through a call (`Reflect.get(ctx, "newCDP" + "Session")`, a method name or an Input-domain name
  // built by concatenation), since the scan reads names, never values (a computed `x[…](` call fails
  // above, a `Reflect.get(…)(…)` does not); a name spelled with a string escape or built in a
  // template (`"Input.dispatch\x4beyEvent"`, `` `Input.${d}` ``, `el['cl\x69ck']()`), since the
  // raw source is read, never the string's value; a programmatic submit
  // (`form.requestSubmit()`, `form.submit()` in the page): it makes no input event, so the lockdown holds
  // it (as it holds A15's untrusted events), and the in-page source scanned whole names it in prose
  // (Helm's call whether to add it; see the step-21 report); a local, parameter or
  // destructuring key spelled like an import shadows that import for the body it is declared in (any
  // identifier inside a `const {…} =` pattern counts as declared); the bodies of imported functions
  // (NO_INPUT_HELPERS is read by hand, each with its reason), except the two modules scanned whole.
  // GUARD PINS: every check here is green on the tree by design. KILLS, each run once in a throwaway
  // tree at b773db29 against the scan as it stood then and against the fixed-list scan it replaced (2285c42a, 62
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
  // VERIFIER ROUND (the scan above beat by four shapes at 385e4d78): KILLS run once in the throwaway
  // tree at 397b6b63 against this scan, and at 385e4d78 against the scan it replaced ("Old": 126
  // checks), the slip put just after the same lockReview line. Each is 1 FAIL of 129, the closure check:
  //   K-S8i `await dismissPageModals?.(this.page!, …)` → "<runAll tail> → dismissPageModals(: an imported
  //         function not on NO_INPUT_HELPERS / IMPORTED_VALUES". Old: green.
  //   K-S8j `await (dismissPageModals)(this.page!, …)` → "dismissPageModals: an imported value not on
  //         NO_INPUT_HELPERS / IMPORTED_VALUES". Old: green.
  //   K-S8k `const f = dismissPageModals; await f(this.page!, …)` (the residual this round retired) →
  //         the same "imported value" line. Old: green.
  //   K-S8l `const self = this; await self.answerUnrecordedRequired();` → "<runAll tail> → this as a
  //         value: its members cannot be followed". Old: green.
  //   K-S8m `const { answerUnrecordedRequired: fillRest } = this; await fillRest.call(this);` → two
  //         "this as a value" lines (the destructure and the `.call(this)`). Old: green.
  //   K-S8n `await (new BasePortalAdapter() as any).dismiss?.();` → "BasePortalAdapter(: an imported
  //         function not on NO_INPUT_HELPERS / IMPORTED_VALUES". Old: green (`new` was skipped).
  //         K-S8n2 `await new Foo(this.page).run();` → "Foo(: a call to a name that is not imported,
  //         local or followed". Old: green.
  //   K-S8o `const { dismissPageModals: d } = await import("./autoLearnAdapter"); await d(…)` →
  //         "import(: a module loaded at run time cannot be followed". Old: green.
  //   K-S8c and K-S8h, re-run at 397b6b63, now read "dismissPageModals(: an imported function not on
  //         NO_INPUT_HELPERS / IMPORTED_VALUES".
  //   K-S8p `document.querySelector("button")?.click();` as the first line of submissionLedger.ts's
  //         readApplicationLedgerInPage (no slip in recipeAdapter.ts) → 1 FAIL of 129, "submissionLedger.ts
  //         (run in the page by the closure) makes no input". Old: green (nothing read that file).
  //   K-S8q the same line as the first line of portalSafety.ts's portalSafetyFactory → 1 FAIL of 129,
  //         the portalSafety.ts whole-file check. Old: green.
  //   The import-parser check ("value imports are read") is a self-check, like codeOnly's: no kill.
  // STEP 21 VERIFIER ROUND (the scan above beat by the shapes below at 8aaf0997): KILLS run once in the
  // throwaway tree at fd3a7c47 against this scan (143 checks), and at 8aaf0997 against the scan it
  // replaced ("Old": 129 checks; 05c9d0f2 is 8aaf0997 with LF line endings, nothing else). Each slip is
  // put just after the same lockReview line unless it says otherwise. Each is 1 FAIL; Old: all green
  // (129/129) unless it says otherwise. Re-run at e24e1e39 (the write rule narrowed): every line
  // identical; K-S8d2, K-S8e, K-S8g, K-S8i and K-S8l re-run there too, each still red with its own line.
  //   K-S8r `const bsW = this.backstop!; await bsW.withAutomationInput(this.page!, async () => null);`
  //         (K-S8e's door through a `!` alias) → "backstop.withAutomationInput(: not on BACKSTOP_NO_INPUT".
  //   K-S8s `const bsX = this.backstop!; bsX.allowApprovedFiling(30_000);` (the approved slot, a door),
  //         K-S8t `const bsY = this.backstop ?? null; bsY?.allowApprovedFiling(30_000);` and K-S8u
  //         `const bsZ = this.backstop as FilingBackstop; bsZ.allowApprovedFiling(30_000);` → each
  //         "backstop.allowApprovedFiling(: not on BACKSTOP_NO_INPUT".
  //   K-S8v `const passOn = (b: any) => b?.allowApprovedFiling(30_000); passOn(this.backstop);` and
  //         K-S8v2 the same through `const bs2 = this.backstop; … passOn2(bs2);` → each "the backstop
  //         taken as a value: its members cannot be followed".
  //   K-S8w `static async pokeX(p: any) { await p.locator("#btnSubmit").click(); }` put in the class above
  //         runAll, and `await RecipeAdapter.pokeX(this.page);` → 1 FAIL of 144, "pokeX: reached via
  //         <runAll tail>, makes no input on the page" (.click(). K-S8x the same through a module object,
  //         `const H_POKE = { async x(p: any) { … .click(); } };` above the class and `await
  //         H_POKE.x(this.page);` → 1 FAIL of 144, "const H_POKE: reached via <runAll tail>, makes no input".
  //   K-S8y pokeX as in K-S8w and `await (this.constructor as any).pokeX(this.page);` → "this.constructor:
  //         the class taken as a value". Old: red BY ACCIDENT (1 FAIL of 130: the old scan followed
  //         `this.constructor` into the constructor's body and failed on its imports, feeBracketCoverage),
  //         never on the static it reached.
  //   INPUT_CALL (the verifier's A5, A6, A7, A10, A1, A2, A4; the case ids in the verifier's report, not
  //   the smoke's): each → "…and makes no input call", the matched text in brackets:
  //   K-S8z1 `await this.page!.getByRole("button").first().click?.();` (.click?.(); K-S8z2 `await
  //         (this.page!.getByRole("button").first() as any).click!();` (.click!(); K-S8z3 `await
  //         this.page!.locator("#x").press?.("Enter");` (.press?.(); K-S8z4 `await
  //         this.page!.mainFrame()?.click?.("b");` (.click?.(); K-S8z5 `await
  //         this.page!.evaluate("document.querySelector('button')['click']()");` (['click'](); K-S8z6 an
  //         evaluate whose body runs `HTMLElement.prototype.click.call(b)` (.click.call(); K-S8z7 `await
  //         this.page!.locator("#x").clear();` (.clear().
  //   K-nit-d `void (async (b: any) => { await b.setChecked?.(true); });` above the class (no slip in the
  //         closure) → section 4's checkbox check. K-nit-e the same with `b.type?.("x")` → section 4's
  //         typing check.
  //   Section 0's two pattern self-checks were red on the old patterns (2 FAIL of 131: every mustMatch
  //   shape missed, and `.type?.(`, `.pressSequentially?.(` and the three tick shapes) and are green now.
  // STEP 21.1 (step 21's verifier: trusted input over a raw DevTools session read as no input): KILLS
  // run once in a throwaway tree at 57812d6a, each slip just after the same lockReview line, against
  // this scan (145 checks) and against the scan at 57812d6a ("Old": 144 checks, all green on each slip):
  //   K-S8z8 (the verifier's attack) `const cdpX = await this.page!.context().newCDPSession(this.page!);
  //         await cdpX.send("Input.dispatchMouseEvent", { type: "mousePressed", … });` → 1 FAIL of 145,
  //         "…and makes no input call" (newCDPSession). K-S8z8b the factory alone, optional-called
  //         (`(this.page!.context() as any).newCDPSession?.(this.page!)`, then a `Page.bringToFront`
  //         send) → the same line (newCDPSession). K-S8z8c a session off a field the scan does not
  //         follow, `(this.options as any).cdp?.send("Input.insertText", …)` → the same line
  //         (Input.insertText).
  //   K-S8z8d (the stated residual, measured): `Reflect.get(ctxR, "newCDP" + "Session").call(ctxR, …)`
  //         and `send("Input." + "dispatchMouseEvent", …)` → GREEN 145/145. A name built at run time is
  //         not seen (NOT FOLLOWED above).
  //   Section 0's DevTools check was red on the old patterns (1 FAIL of 145: every one of its 12
  //   mustMatch rows missed) and is green now. Its mustNotMatch rows were measured against a broadened
  //   pattern (`\bInput\.\w+`, and `newCDPSession` with no trailing word boundary) → 1 FAIL of 145,
  //   wrongly read: `Input.value`, `Input.dispatched …`, `newCDPSessions`.
  // STEP 21.2 (step 21's verifier: a followed body cut short on the raw text): every block's end is
  // now found on the code (blockFrom / statementFrom, at the top), for the class, its methods and the
  // module functions, classes and declarations alike. On the tree every check reads exactly as before
  // (every ok and info line identical to 80221dad's; the 211 members' bodies byte-identical) plus the
  // new bodyFaults check. KILLS run once in a throwaway tree at 80221dad, against this scan (146
  // checks) and the scan at 80221dad ("Old"), the slip in verifyReviewScreen's final `catch` unless it
  // says otherwise:
  //   K-S8z9 (the verifier's attack) `const atkNote = \`review` / `  note(s) follow\`; await
  //         this.page?.locator("#btnSubmit").click();` (the template's second line indented two
  //         spaces) → 1 FAIL of 146, "verifyReviewScreen: reached via <runAll tail>, makes no input on
  //         the page" (.click(). Old: green, 145/145.
  //   K-S8z9b the same with the template `\`review` / `}` / `\`` (a "\n}\n" inside it) → the same
  //         1 FAIL of 146. Old: red BY ACCIDENT (8 FAIL of 135: the class itself was cut at that
  //         "\n}\n", so `this.progress(` had no body), never on the click.
  //   K-S8z9c the same "\n}\n" template and a `.click()` as the first line of the module function
  //         pruneCaptureDir → 1 FAIL of 146, "function pruneCaptureDir: reached via
  //         writeSanitizedCapture, makes no input". Old: green, 144/144 (the function was cut there).
  //   K-S8z9d the one-line arrow clickedLabel extended with `+ \`x` / `y\` + String(….click())`
  //         (a template line at column 0) → 1 FAIL of 146, "function clickedLabel: reached via
  //         humanClickReport, makes no input". Old: green, 145/145.
  //   K-S8z9e `if (project) /x{/.test("");` (a regex literal after `)`, which codeOnly then read as a
  //         division, so its `{` was counted): no `  }` line closed the class or the method → 41 FAIL
  //         of 368, among them the bodyFaults check naming `export class RecipeAdapter …:
  //         unterminated`. Old: green, 145/145. Its claim that the scan fails closed on ANY misread `/`
  //         was disproved (the fix round's V-A1 below: a balanced pair cut a method and stayed green);
  //         since the fix round the `/` after an `if (…)` head is read as a regex, and K-S8z9e is GREEN
  //         (146/146: the slip makes no input, and nothing is misread).
  //   K-S8z9f clickedLabel extended with `+ \`x` / `\` + String(….click())` (the template's CLOSING
  //         backtick at column 0) → 1 FAIL of 146, the clickedLabel line. Old: green, 145/145.
  //   K-S8z9g ERROR_PAGE_GO_BACK written `String(` / `// a note` / `  (….click()) + " The window …"`
  //         (a comment at column 0 inside the parentheses) → 1 FAIL of 146, "const ERROR_PAGE_GO_BACK:
  //         reached via function humanPaymentHeldNote, makes no input". Old: green, 145/145.
  //   K-S8z9h (the stated residual, measured; statementFrom's NOT SEEN) ERROR_PAGE_GO_BACK's string
  //         continued on a new line `+ String(….click());` at column 0 → GREEN 146/146 (Old: green,
  //         145/145). An expression continued at column 0 outside every bracket reads as the next
  //         statement.
  // STEP 21.2 FIX ROUND (the rule-1 verifier: two shapes ended a followed body at a balanced, wrong
  // `  }` that the parent's raw-text end did not stop at). Two rules: codeOnlyMapped reads the `/`
  // after an `if (…)` / `while (…)` / `for (…)` / `with (…)` head as a regex (`heads`), and blockFrom
  // takes a depth-0 `indent` + `}` line as the end only when the next code line can follow a block
  // (endsHere). On the tree every check reads exactly as at 48bdc9a3 (146/146, every ok and info line
  // identical; all 211 members' bodies under both signature forms, the 30 module functions and classes
  // and the 64 module declarations byte-identical; codeOnly of recipeAdapter.ts, submissionLedger.ts and
  // portalSafety.ts identical). KILLS run once in a throwaway tree at 48bdc9a3, against this scan (146
  // checks), the scan at 48bdc9a3 ("Old"), and this scan with one rule switched off ("no heads": the
  // `)` rule; "no ends": endsHere always true); the slip in verifyReviewScreen's final `catch` unless it
  // says otherwise:
  //   V-A5 (the verifier's) pageUrlNoHash written `  private pageUrlNoHash(): string & {` /
  //         `    readonly brand?: never;` / `  }` / `  {` and `void this.page?.locator("#btnSubmit")
  //         .click();` in its body → 1 FAIL of 146, "pageUrlNoHash: reached via <runAll tail>, makes no
  //         input on the page" (.click(). Old: green, 146/146. No ends: green. No heads: the same 1 FAIL.
  //   V-A1 (the verifier's) `if (project) /\}\}/.test("");` / `{` / `  }` / the click / `if (project)
  //         /\{\{/.test("");` → 1 FAIL of 146, "verifyReviewScreen: … makes no input on the page"
  //         (.click(). Old: green, 146/146. Each rule alone catches it (no heads and no ends: the same
  //         1 FAIL). V-A1c the same with `  sleep(0);` after the fake `  }` (a line endsHere reads as a
  //         member's signature) → the same 1 FAIL. Old: green. No heads: green. No ends: the same 1 FAIL.
  //   V-A2 (the verifier's: the return type `Promise<{` / `  }` / `  > {`) and V-A3 (a parameter type
  //         whose `}` sits alone on an indent-2 line), each with a click in the catch → 1 FAIL of 146 on
  //         the click (.click(). Old: red BY ACCIDENT (2 FAIL of 141, "the closure reaches
  //         writeSanitizedCapture" and "…reviewValuesOnPage", never the click); no ends: the same accident.
  //   V-A4 (the verifier's) `function zzUnfollowed(x: boolean): void { if (x) /\)/.test(""); }` put
  //         before K-S8z9g's ERROR_PAGE_GO_BACK (its misread `)` drove the paren count below 0) → 1 FAIL
  //         of 146, the ERROR_PAGE_GO_BACK line. Old: green, 146/146. No heads: green.
  //   K-S8z9e2 K-S8z9e plus a click on the next line → 1 FAIL of 146 on the click. Old: 41 FAIL of 368.
  //   K-S8z9i (legal TS) verifyReviewScreen closed `  };` → its end line is no bare `  }`, so the read
  //         goes on through reviewValuesOnPage → 1 FAIL of 146, the closure check ("verifyReviewScreen →
  //         reviewValuesOnPage(: a call to a name that is not imported, local or followed": the next
  //         member's signature read as a call). Old: the same.
  //   K-S8z9j (legal TS) the CLASS closed `};` → GREEN 146/146 (Old: the same): the class's text runs on
  //         to the next module function's `}` line, and every member is still found in it.
  //   K-S8z9k (legal TS) a new last member `  private zzLast(): void {` / `  };` and `this.zzLast();` →
  //         1 FAIL of 147, the bodyFaults check, "private zzLast(): void {: its braces go below depth 0
  //         before its body ends". Old, no heads, no ends: the same (the bodyFaults guard's kill).
  //   Re-run unchanged on this scan: K-S8z9, K-S8z9b, K-S8z9c, K-S8z9d, K-S8z9f, K-S8z9g (each the same
  //   1 FAIL as above) and K-S8z9h (GREEN, the stated residual); V-A0 and V-A6 (the controls: a plain
  //   click in verifyReviewScreen and in pageUrlNoHash) → 1 FAIL on the click, Old the same.
  //   NOT SEEN (stated, not pinned): a `/` misread in a shape the two rules do not cover (after a
  //   keyword read as a property name, `x.return / 2`, a postfix `x++ / y /` or a non-null `x! / y`),
  //   paired so the braces still balance and a fake `indent` + `}` line is followed by a line that
  //   reads as a declaration.
  const classAt =recipe.indexOf("\nexport class RecipeAdapter ");
  const cls = classAt >= 0 ? blockFrom(recipe, classAt, "") : "";
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
    // Its own `}` line at column 0, by brace matching (step 21.2: a "\n}\n" inside a template once cut
    // it short).
    if (fn) return blockFrom(moduleSrc, fn.index, "");
    // A module-level class (`new X(` follows it: its constructor and field initialisers run).
    const kl = new RegExp(`\\n(?:export )?(?:abstract )?class ${esc(name)}\\b`).exec(moduleSrc);
    if (kl) return blockFrom(moduleSrc, kl.index, "");
    const cn = new RegExp(`\\n(?:export )?const ${esc(name)}\\b[^=\\n]*=\\s*(?:async\\s*)?(?:\\(|[A-Za-z_$][\\w$]*\\s*=>|function)`).exec(moduleSrc);
    return cn ? statementFrom(moduleSrc, cn.index) : "";
  };
  // Any other module-level declaration (`const H = { … }`, `let x = new Y()`): from its line to the next
  // line that starts a new statement at column 0 (statementFrom: read on the code).
  const moduleDeclBody = (name: string): string => {
    const d = new RegExp(`\\n(?:export )?(?:const|let|var) ${esc(name)}\\b`).exec(moduleSrc);
    return d ? statementFrom(moduleSrc, d.index) : "";
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

  // The backstop's two fields, read off `this` (`this.`, `this!.`, `this?.`).
  const BS_FIELD = String.raw`(?<![\w$.])this\s*[!?]?\s*\.\s*(?:backstop|handedOverBackstop)\b`;
  // A type after `as` / `satisfies`: `FilingBackstop`, `FilingBackstop | null`, `X<Y>`, `X[]`.
  const TYPE_TEXT = String.raw`[A-Za-z_$][\w$.]*(?:\s*<[^>\n]*>)?(?:\s*\[\])?(?:\s*\|\s*[A-Za-z_$][\w$.]*(?:\s*\[\])?)*`;
  // A parameter or argument list split at its top-level commas.
  const topLevelParts = (s: string): string[] => {
    const parts: string[] = [];
    let level = 0;
    let from = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "(" || c === "[" || c === "{" || c === "<") level++;
      else if (c === ")" || c === "]" || c === "}" || (c === ">" && s[i - 1] !== "=")) level--;
      else if (c === "," && level === 0) { parts.push(s.slice(from, i)); from = i + 1; }
    }
    parts.push(s.slice(from));
    return parts;
  };
  // A holder read at [at, end) that is a WHOLE positional argument of `this.X(…)`, where X is a method of
  // the class whose parameter at that position is typed FilingBackstop: X is followed, and that
  // parameter is an alias inside it, so the backstop's members stay read.
  const backstopArgumentOfFollowedMember = (code: string, at: number, end: number): boolean => {
    if (!/^\s*!?\s*[,)]/.test(code.slice(end))) return false;
    let depth = 0;
    let commas = 0;
    let i = at - 1;
    for (; i >= 0; i--) {
      const c = code[i];
      if (c === ")" || c === "]" || c === "}") depth++;
      else if (c === "(" || c === "[" || c === "{") { if (depth === 0) break; depth--; }
      else if (c === "," && depth === 0) commas++;
    }
    if (i < 0 || code[i] !== "(") return false;
    const callee = /(?<![\w$.])this\s*[!?]?\s*\.\s*([A-Za-z_$][\w$]*)\s*!?\s*(?:\?\.)?\s*$/.exec(code.slice(Math.max(0, i - 160), i));
    if (!callee) return false;
    const found = memberBody(callee[1]);
    if (!found || found.kind !== "method") return false;
    const sig = codeOnly(found.body);
    const open = sig.indexOf("(");
    let level = 0;
    let close = open;
    for (; open >= 0 && close < sig.length; close++) {
      if (sig[close] === "(") level++;
      else if (sig[close] === ")" && --level === 0) break;
    }
    const param = topLevelParts(sig.slice(open + 1, close))[commas];
    return !!param && /^\s*[A-Za-z_$][\w$]*\s*\??\s*:\s*FilingBackstop\b/.test(param);
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
      // `this.constructor` is the class taken as a value: its statics would be called past the pass below.
      if (member === "constructor") { problems.add(`${name} → this.constructor: the class taken as a value`); continue; }
      const found = memberBody(member);
      if (found && (found.kind === "method" || !called)) enqueue(member, name, found.body);
      else if (called) problems.add(`${name} → this.${member}(: no method body in recipeAdapter.ts (${found ? "a getter, called" : "a field holding a function, or an inherited method"})`);
    }
    // A STATIC member called off the class name (`RecipeAdapter.siteOf(`) is a member of the class,
    // followed the same way (verifier round: `RecipeAdapter.pokeX(this.page)` was read as a module
    // constant). A static field read is not followed (as a `this.` field read is not); the class taken
    // as a value fails.
    for (const m of code.matchAll(new RegExp(`(?<![\\w$.])RecipeAdapter(?![\\w$])(\\s*[!?]?\\s*\\.\\s*([A-Za-z_$][\\w$]*)(${CALL})?)?`, "g"))) {
      if (!m[1]) {
        // A type position (`x: RecipeAdapter`, `as RecipeAdapter`, `<RecipeAdapter>`) is no value.
        const pre = code.slice(Math.max(0, m.index! - 16), m.index!);
        if (!/(?::|\bas|\bsatisfies|<|\|)\s*$/.test(pre)) problems.add(`${name} → RecipeAdapter: the class taken as a value (${code.slice(Math.max(0, m.index! - 30), m.index! + 30).replace(/\s+/g, " ")})`);
        continue;
      }
      const member = m[2];
      const called = !!m[3];
      const found = memberBody(member);
      if (found && (found.kind === "method" || !called)) enqueue(member, name, found.body);
      else if (called) problems.add(`${name} → RecipeAdapter.${member}(: no static method body in recipeAdapter.ts`);
    }
    // The backstop (`this.backstop`, `this.handedOverBackstop`; `this!.` / `this?.` too), every parameter
    // typed FilingBackstop, and every local declared from a holder: `= h`, `= h!`, `= h as T`,
    // `= h satisfies T`, `= h ?? h2`, `= h ?? null` (a holder being the field or an alias already found).
    const aliasNames: string[] = [];
    for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*\??\s*:\s*FilingBackstop\b/g)) aliasNames.push(m[1]);
    const holders = (): string => [BS_FIELD, ...aliasNames.map((n) => `(?<![\\w$.])${esc(n)}(?![\\w$])`)].join("|");
    const consumed: Array<[number, number]> = []; // the right-hand sides that declare or store a holder
    for (let round = 0; round < 6; round++) {
      const atom = `\\(?\\s*(?:${holders()})\\s*!?\\s*\\)?(?:\\s*(?:as|satisfies)\\s+${TYPE_TEXT})?`;
      const rhs = `${atom}(?:\\s*\\?\\?\\s*(?:${atom}|null|undefined))*`;
      const before = aliasNames.length;
      for (const m of code.matchAll(new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=\\n]*)?=\\s*(${rhs})\\s*(?=[;\\n])`, "g"))) {
        if (!aliasNames.includes(m[1])) aliasNames.push(m[1]);
        const s = m.index! + m[0].lastIndexOf(m[2]);
        consumed.push([s, s + m[2].length]);
      }
      // A holder stored back into the field (`this.handedOverBackstop = bs;`) is the same backstop.
      for (const m of code.matchAll(new RegExp(`(?:${BS_FIELD})\\s*=(?![=>])\\s*(${rhs})\\s*(?=[;\\n])`, "g"))) {
        const s = m.index! + m[0].lastIndexOf(m[1]);
        consumed.push([s, s + m[1].length]);
      }
      if (aliasNames.length === before) break;
    }
    const aliases = [BS_FIELD, ...aliasNames.map(esc)];
    // The backstop taken as a VALUE (Helm Should-fix 8, verifier round: `const b = this.backstop!` once
    // left `b` unseen): every read of a holder that is not a member access (`.m`, `!.m`, `?.m`, read
    // below) must be one of: an alias's own declaration or store (above); a write to it (`h = …`); a
    // declared name or a FilingBackstop parameter; a positional argument of a `this.X(` whose parameter
    // there is typed FilingBackstop (X's body is followed, and that parameter is an alias in it). Any
    // other read (`run(bs)`, `[bs]`, `{ bs }`, `cond ? bs : x`, `!bs`) fails: its members cannot be followed.
    for (const m of code.matchAll(new RegExp(`(?:${holders()})`, "g"))) {
      const at = m.index!;
      const end = at + m[0].length;
      const after = code.slice(end);
      if (/^\s*!?\s*(?:\?\.|\.)\s*[A-Za-z_$]/.test(after)) continue;
      if (consumed.some(([s, e]) => at >= s && end <= e)) continue;
      if (/^\s*=(?![=>])/.test(after) || /^\s*\??\s*:\s*FilingBackstop\b/.test(after)) continue;
      if (/\b(?:const|let|var)\s+$/.test(code.slice(Math.max(0, at - 12), at))) continue;
      if (backstopArgumentOfFollowedMember(code, at, end)) continue;
      // A TEST of it, whose value never leaves: `!h` / `!!h`, `typeof h`, `h && …` (yields h only when
      // it is null), `h ? a : b`, `h === x` / `x !== h`, `if (h)`. Never `h || …` or `… && h`: those hand
      // the backstop on.
      const pre = code.slice(Math.max(0, at - 24), at);
      if (/(?:^|[^!=])!!?\s*$/.test(pre) || /\btypeof\s+$/.test(pre) || /[!=]==?\s*$/.test(pre)) continue;
      if (/^\s*(?:&&|\?(?![.?])|[!=]==?)/.test(after)) continue;
      if (/\b(?:if|while)\s*\(\s*$/.test(pre) && /^\s*\)/.test(after)) continue;
      problems.add(`${name} → the backstop taken as a value: its members cannot be followed (${code.slice(Math.max(0, at - 30), end + 30).replace(/\s+/g, " ")})`);
    }
    // Every member the body touches on it: a call (or .call/.apply/.bind) must be on BACKSTOP_NO_INPUT, a
    // read on BACKSTOP_RECORDS — so a method taken as a value (`const w = bs.withAutomationInput`) fails too.
    const onBackstop = new RegExp(`(?<![\\w$.])(?:${aliases.join("|")})\\s*[!?]?\\s*\\.\\s*([A-Za-z_$][\\w$]*)(${CALL})?`, "g");
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
      // A module-level object or value of recipeAdapter.ts (`const H = { async x(p) {…} }`, `H.x(page)`):
      // its whole declaration is followed, on any reference (verifier round: members of module objects).
      const decl = moduleDeclBody(fn);
      if (decl) { enqueue(`const ${fn}`, name, decl); continue; }
      if (!called) continue; // a property key, a type name
      if (!freeCalls.has(fn)) freeCalls.set(fn, name);
      if (!(fn in NO_INPUT_HELPERS)) problems.add(`${name} → ${fn}(: a call to a name that is not imported, local or followed, and not on NO_INPUT_HELPERS`);
    }
  }
  check("the closure makes no call it cannot follow (every this.X( has a body here, no super / bracket call, every backstop and imported call or reference allowlisted)",
    problems.size === 0, [...problems].join("\n         "));
  // Step 21.2: a body cut short hides what follows the cut, so a member whose end cannot be found by
  // brace matching (methodBody above) fails here by its signature line.
  check("every method body the scan read ends at its own closing brace (brace matching on the code, never the next-member text)",
    bodyFaults.size === 0, [...bodyFaults].join("\n         "));
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
  // A call of any shape (TYPING_CALL: `.type(`, `.type!(`, `.type?.(`; a typeof guard has no call paren).
  const typing = recipe.split("\n").filter((l) => TYPING_CALL.test(l));
  const unfenced = typing.filter((l) => !/withAutomationInput\(/.test(l));
  check("every typing call (pressSequentially / type) in recipeAdapter.ts is fenced", typing.length >= 3 && unfenced.length === 0, JSON.stringify(unfenced.map((l) => l.trim().slice(0, 140))));
  // Checkbox writes too (skeptic round 1: check / uncheck were trusted input outside the fence; Helm's
  // nit: setChecked fires the same trusted pointerdown + mousedown).
  const ticks = recipe.split("\n").filter((l) => TICK_CALL.test(l));
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
  // A18-A24 (+ A19o/A22o/A22b) pin the behaviour; these pin the mechanism, so an edit that moves the
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
    /send\(\s*"Runtime\.evaluate",\s*\{\s*expression:\s*"window\.__solarBackstopHumanInputArmed === true",\s*contextId:/.test(backstop)
      && !/\.evaluate\(\s*"[^"]*__solarBackstopHumanInputArmed/.test(backstop));
  // Step 19.1: the marker is the boolean true, tested as such at both ends. A Window's named
  // properties (an element with that id) are seen from the isolated world too; by truthiness, such
  // an element made the script return before it listened while the read-back said armed (smoke A24
  // pins the behaviour; this pins the read-back, which A24 cannot redden while the script is strict).
  // Every read of the marker off a window (`w.` in the script, `window.` in the read-back); its one
  // assignment (`= true`) is left out, and so is prose (the comment's `id="…"` is not a read).
  const markerTests = backstop.match(/\b(?:w|window)\.__solarBackstopHumanInputArmed(?!\s*=[^=])[^;")]*/g) || [];
  check("the armed marker is tested `=== true` wherever it is read (the watch script's early return and the read-back): never by truthiness, never `!!`",
    markerTests.length >= 2 && markerTests.every((s) => /^(?:w|window)\.__solarBackstopHumanInputArmed\s*===\s*true\b/.test(s))
      && !/!!\s*window\.__solarBackstopHumanInputArmed/.test(backstop),
    JSON.stringify(markerTests));
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
