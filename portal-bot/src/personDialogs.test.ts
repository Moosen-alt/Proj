// #381 — A NATIVE DIALOG ON A HANDED-OVER WINDOW WAITS FOR THE PERSON; AUTOMATION NEVER ANSWERS ONE.
//
// Hard rule 1: leaving a dialog to the person must never become automation answering it. This pins,
// by source and with doubles (the real-Chromium pins are personDialogAfterHandOver.dom.smoke.ts):
//   1. the ONE place product code answers a dialog is the approved click's slot handler
//      (filingBackstop.ts allowApprovedFiling) — no other accept() / dismiss() call, and no other
//      dialog listener than that one and personDialogs' own;
//   2. personDialogs.ts answers nothing; the hand-over and every left-open window register it; the
//      approved slot never opens after the hand-over;
//   3. the listener notes a dialog and leaves it open (a double whose accept / dismiss throw), and
//      readUnlessDialog skips while one is open, gives up the moment one opens, and is inert on a
//      window whose dialogs were never left to the person (before the hand-over: as on main).
//
//   npx tsx portal-bot/src/personDialogs.test.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dialogOpenedSince, dialogOpenOn, dialogsLeftToPerson, leaveDialogsToPerson, readUnlessDialog } from "./personDialogs";

let failures = 0;
let total = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  total++;
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), "utf8");
/** Product TypeScript under `dir` (tests, smokes and vendored code left out). */
const productTs = (dir: string): string[] => {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((d) => {
    const rel = `${dir}/${d.name}`;
    if (d.isDirectory()) return d.name === "node_modules" || d.name === "vendor" ? [] : productTs(rel);
    return /\.ts$/.test(d.name) && !/\.(test|smoke)\.ts$/.test(d.name) ? [rel] : [];
  });
};
/** Comments blanked (line and block), so prose naming accept() is never read as a call. String
 *  literals' text is blanked first (except "dialog", which the listener scan reads), so a `"**\/*"`
 *  never opens a block comment. */
const codeOnly = (src: string): string => src
  .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (m) => (/^["']dialog["']$/.test(m) ? m : m[0] + " ".repeat(m.length - 2) + m[0]))
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
/** A method body in an object literal or class, from its signature to the matching close brace. */
const bodyFrom = (src: string, sig: RegExp): string => {
  const m = sig.exec(src);
  if (!m) return "";
  let i = src.indexOf("{", m.index + m[0].length - 1);
  if (i < 0) return "";
  const start = i;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
};

console.log("\n1. ONE PLACE IN PRODUCT CODE ANSWERS A DIALOG: THE APPROVED CLICK'S SLOT");
{
  const files = ["portal-bot/src", "backend/src", "shared/src", "tools"].flatMap(productTs);
  check("the scan reads the product sources (filingBackstop.ts, personDialogs.ts, recipeAdapter.ts, index.ts among them)",
    ["portal-bot/src/filingBackstop.ts", "portal-bot/src/personDialogs.ts", "portal-bot/src/adapters/recipeAdapter.ts", "portal-bot/src/index.ts"].every((f) => files.includes(f)), String(files.length));
  const ANSWER = /\.\s*(accept|dismiss)\s*\(/g;
  const LISTEN = /\.\s*(on|once|addListener|prependListener|waitForEvent)\s*(?:!|\?\.)?\s*\(\s*["'`]dialog["'`]/g;
  const answers: string[] = [];
  const listens: string[] = [];
  for (const f of files) {
    const code = codeOnly(read(f));
    for (const m of code.matchAll(ANSWER)) answers.push(`${f}:${code.slice(0, m.index).split("\n").length}`);
    for (const m of code.matchAll(LISTEN)) listens.push(`${f}:${code.slice(0, m.index).split("\n").length}`);
  }
  check("every accept() / dismiss() call in product code is in filingBackstop.ts", answers.length >= 1 && answers.every((a) => a.startsWith("portal-bot/src/filingBackstop.ts:")), JSON.stringify(answers));
  const backstop = codeOnly(read("portal-bot/src/filingBackstop.ts"));
  const slot = bodyFrom(backstop, /\n {4}allowApprovedFiling\(ms: number[^)]*\)\s*\{/);
  const slotAnswers = (slot.match(ANSWER) || []).length;
  const allBackstopAnswers = (backstop.match(ANSWER) || []).length;
  check("…and every one of them is inside allowApprovedFiling (the approved click's own slot)", slot.length > 0 && slotAnswers >= 1 && slotAnswers === allBackstopAnswers, `slot=${slotAnswers} file=${allBackstopAnswers}`);
  check("exactly two dialog listeners in product code: the approved slot's and personDialogs' (which answers nothing)",
    listens.length === 2 && listens.some((l) => l.startsWith("portal-bot/src/filingBackstop.ts:")) && listens.some((l) => l.startsWith("portal-bot/src/personDialogs.ts:")), JSON.stringify(listens));
  check("…the backstop's listener is registered inside allowApprovedFiling", /\.on\(\s*"dialog"/.test(slot), slot.slice(0, 200));
}

console.log("\n2. THE HAND-OVER AND EVERY LEFT-OPEN WINDOW LEAVE DIALOGS TO THE PERSON; THE SLOT NEVER OPENS AFTER");
{
  const mod = codeOnly(read("portal-bot/src/personDialogs.ts"));
  check("personDialogs.ts calls no accept() / dismiss() and no handleJavaScriptDialog", !/\.\s*(accept|dismiss)\s*\(|handleJavaScriptDialog/.test(mod), (mod.match(/\.\s*(accept|dismiss)\s*\(|handleJavaScriptDialog/) || [""])[0]);
  const backstop = codeOnly(read("portal-bot/src/filingBackstop.ts"));
  const handOver = bodyFrom(backstop, /\n {4}handOverToHuman\(_why: string\)\s*\{/);
  check("handOverToHuman registers leaveDialogsToPerson on the run's page (after its armed-watch refusal)",
    /if \(disposed \|\| !humanWatchArmed\) return false;[\s\S]*leaveDialogsToPerson\(page\);[\s\S]*return true;/.test(handOver), handOver);
  const slot = bodyFrom(backstop, /\n {4}allowApprovedFiling\(ms: number[^)]*\)\s*\{/);
  const refuse = slot.indexOf("if (disposed || handedOverAt > 0) return;");
  check("allowApprovedFiling refuses after the hand-over, before the slot (and its answering dialog handler) exists",
    refuse > 0 && refuse < slot.indexOf("slot = s;") && refuse < slot.indexOf('.on("dialog"'), slot.slice(0, 600));
  check("the hand-over never calls handleJavaScriptDialog either (anywhere in filingBackstop.ts)", !/handleJavaScriptDialog/.test(backstop));
  const dialogClosed = /session\.on\("Page\.javascriptDialogClosed", \(e: \{ result\?: boolean \}\) => \{\s*if \(e && e\.result === true && handedOverAt > 0 && dialogsLeftToPerson\(owner\)\) noteHumanInput\(owner\);\s*\}\);/;
  check("a dialog the person ACCEPTED after the hand-over, on a window left to them, counts as their input (and nothing else does)", dialogClosed.test(read("portal-bot/src/filingBackstop.ts")));
  const index = codeOnly(read("portal-bot/src/index.ts"));
  const track = bodyFrom(index, /export function trackOpenAdapter\([\s\S]*?\): void\s*\{/);
  check("index.ts trackOpenAdapter (every window left open for a person) leaves its dialogs to the person", /leaveDialogsToPerson\(page\)/.test(track), track.slice(0, 400));
  const recipe = codeOnly(read("portal-bot/src/adapters/recipeAdapter.ts"));
  check("the replay's review read-back, where-it-stopped read, capture page read and capture go through readUnlessDialog",
    /readUnlessDialog\(this\.page, \(\) => this\.verifyReviewScreen\(project\)/.test(recipe)
      && /readUnlessDialog\(this\.page, \(\) => this\.whereTheRunStopped\(/.test(recipe)
      && /readUnlessDialog\(page, \(\) => this\.readPageForCaptureNow\(\), null\)/.test(recipe)
      && /readUnlessDialog\(this\.page, \(\) => this\.readSubmissionConfirmation\(\)/.test(recipe));
  // Raw source: dispose's `unroute("**/*", …)` would open a block comment for codeOnly.
  const dispose = bodyFrom(read("portal-bot/src/filingBackstop.ts"), /\n {4}async dispose\(\)\s*\{/);
  check("dispose bounds its DevTools teardown (redirect guard, unroute, the watch's sessions) only after the hand-over — an open dialog stalls them",
    /const settle = dialogsLeftToPerson\(page\)\s*\?\s*<T>\(p: Promise<T>\): Promise<T \| null> => settleWithin\(p, TERMINAL_READ_TIMEOUT_MS\)\s*:\s*<T>\(p: Promise<T>\): Promise<T \| null> => p;/.test(dispose)
      && /leaveGuard\(settle\)/.test(dispose) && /settle\(Promise\.resolve\(target\.unroute\(/.test(dispose) && /settle\(Promise\.resolve\(s\.detach\(\)\)/.test(dispose)
      && dispose.indexOf("disposed = true;") < dispose.indexOf("const settle"), dispose.slice(0, 300));
  check("the drain's saving read goes through readUnlessDialog", (backstop.match(/readUnlessDialog\(page, \(\) => isSaving\(page\), false\)/g) || []).length === 2);
}

console.log("\n3. THE LISTENER LEAVES THE DIALOG OPEN; READS SKIP OR GIVE UP, NEVER ANSWER");
{
  type Fn = (d: unknown) => void;
  const makeWindow = () => {
    const listeners = new Map<string, Fn[]>();
    const ctx = { on: (ev: string, fn: Fn) => { listeners.set(ev, [...(listeners.get(ev) ?? []), fn]); return ctx; } };
    let closeProbe: (() => void) | null = null;
    const page = {
      context: () => ctx,
      evaluate: () => new Promise<number>((r) => { closeProbe = () => r(0); }),
    };
    const answered: string[] = [];
    const dialog = {
      page: () => page, type: () => "confirm", message: () => "Submit this application?",
      accept: () => { answered.push("accept"); throw new Error("automation answered a dialog"); },
      dismiss: () => { answered.push("dismiss"); throw new Error("automation answered a dialog"); },
    };
    const open = (): void => { for (const fn of listeners.get("dialog") ?? []) fn(dialog); };
    return { ctx, page, listeners, answered, open, closeDialog: () => { closeProbe?.(); } };
  };
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

  // Before the hand-over: nothing registered, reads run as before.
  const w = makeWindow();
  let ran = 0;
  const value = await readUnlessDialog(w.page, async () => { ran++; return "read"; }, "skipped");
  check("before leaveDialogsToPerson: no listener, and a read runs exactly as before", value === "read" && ran === 1 && !dialogsLeftToPerson(w.page) && !w.listeners.has("dialog"));

  check("leaveDialogsToPerson registers ONE listener on the page's context", leaveDialogsToPerson(w.page) && (w.listeners.get("dialog") ?? []).length === 1 && dialogsLeftToPerson(w.page));
  leaveDialogsToPerson(w.page);
  check("…idempotent: a second call adds no second listener", (w.listeners.get("dialog") ?? []).length === 1);

  // A read in flight gives up the moment a dialog opens.
  let releaseRead: (v: string) => void = () => {};
  const inFlight = readUnlessDialog(w.page, () => new Promise<string>((r) => { releaseRead = r; }), "gave up");
  const t0 = Date.now();
  w.open();
  check("a dialog opening is noted (open now, opened since the read began), and never answered",
    dialogOpenOn(w.page) && dialogOpenedSince(w.page, t0) && w.answered.length === 0, JSON.stringify(w.answered));
  check("…a read in flight gives up at once with its fallback", (await inFlight) === "gave up");
  releaseRead("late");

  // While it is open, a read is skipped without running.
  let ranWhileOpen = 0;
  const skipped = await readUnlessDialog(w.page, async () => { ranWhileOpen++; return "read"; }, "skipped");
  check("while the dialog is open a read is skipped (its function never runs)", skipped === "skipped" && ranWhileOpen === 0);

  // The person answers (the page's script runs again): the probe settles, reads run again.
  w.closeDialog();
  await tick();
  const after = await readUnlessDialog(w.page, async () => "read", "skipped");
  check("once the dialog is answered (the queued probe settles), reads run again — and automation still answered nothing",
    !dialogOpenOn(w.page) && after === "read" && w.answered.length === 0, JSON.stringify({ open: dialogOpenOn(w.page), after, answered: w.answered }));

  // A read that throws still throws (callers keep their own catch).
  let threw = false;
  try { await readUnlessDialog(w.page, async () => { throw new Error("boom"); }, "x"); } catch { threw = true; }
  check("a read that throws still throws", threw);

  // A page with nothing to listen on: not left to the person, reads unchanged.
  const bare = { evaluate: async () => 0 };
  check("a double with no context and no on(): leaveDialogsToPerson reports false, reads unchanged",
    leaveDialogsToPerson(bare) === false && (await readUnlessDialog(bare, async () => "read", "skipped")) === "read");
}

if (failures) { console.error(`\n${failures}/${total} personDialogs.test check(s) FAILED.`); process.exit(1); }
console.log(`\nAll ${total}/${total} personDialogs.test checks passed.`);
