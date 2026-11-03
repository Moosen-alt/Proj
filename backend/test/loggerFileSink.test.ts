// THE FILE LOG KEEPS TELLING THE TRUTH THROUGH A BAD NIGHT (#388).
//
// One failed append used to silence backend.log for the life of the process: on 2026-10-25 a nearly
// full disk stopped the live file at 02:24Z while /health answered for 21 more hours. And the crash
// block (logErrorBlock, used by the uncaughtException / unhandledRejection handlers) went to the
// console only, so a crash in a console window that was then closed left nothing on disk.
//
// The fault is a log path that IS A DIRECTORY, not an unwritable directory: cloud containers run tests
// as root, and root ignores directory permission bits, so that form would pass without testing anything.
//   npx tsx backend/test/loggerFileSink.test.ts
import "./_isolate"; // FIRST — it sets AUTOPILOT_LOG_FILE="", which this test overrides below
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logger-sink-"));
const LOG = path.join(dir, "backend.log");
process.env.AUTOPILOT_LOG_FILE = LOG; // LOG_FILE is resolved at module load
process.env.LOG_LEVEL = "info";

const { logger, logErrorBlock, setLogFileClockForTests } = await import("../src/logger");
let t = 1_000_000;
setLogFileClockForTests(() => t);
const read = (): string => (fs.existsSync(LOG) && fs.statSync(LOG).isFile() ? fs.readFileSync(LOG, "utf8") : "");

// Keep the console quiet: the lines under test are the file's.
const quiet = <T>(fn: () => T): T => {
  const saved = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {};
  try { return fn(); } finally { [console.log, console.warn, console.error] = saved; }
};

check("CONTROL: a healthy sink writes the line", () => {
  quiet(() => logger.info("sink-test", "line one, before the fault"));
  assert.match(read(), /line one, before the fault/);
});

check("a failed append is dropped, and the sink does not retry inside the 30 s window (no retry-storm)", () => {
  fs.rmSync(LOG);
  fs.mkdirSync(LOG); // the fault: the log path is a directory
  quiet(() => logger.info("sink-test", "line two, during the fault"));
  fs.rmdirSync(LOG); // the fault clears
  t += 10_000;
  quiet(() => logger.info("sink-test", "line three, fault cleared but inside the window"));
  assert.equal(fs.existsSync(LOG), false, "the sink retried inside the backoff window");
});

check("after the window, the next line is on disk with ONE gap line in front of it", () => {
  t += 20_000;
  quiet(() => logger.warn("sink-test", "line four, after the window"));
  const text = read();
  const lines = text.trimEnd().split("\n");
  assert.equal(lines.length, 2, `expected the gap line then line four, got:\n${text}`);
  assert.match(lines[0], /\[logger\] file log resumed after 2 dropped line\(s\)$/);
  assert.match(lines[1], /line four, after the window/);
  assert.doesNotMatch(text, /line two|line three/, "a dropped line reached the file");
});

check("the gap line is written once: the next healthy line follows with no second gap", () => {
  quiet(() => logger.info("sink-test", "line five"));
  const lines = read().trimEnd().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[2], /line five/);
  assert.equal(lines.filter((l) => l.includes("resumed after")).length, 1);
});

check("a crash block from logErrorBlock lands in the file, the same text the console gets", () => {
  const err = new Error("boom from a synthetic uncaughtException");
  let consoleText = "";
  const saved = console.error;
  console.error = (s: unknown) => { consoleText += String(s); };
  try { logErrorBlock("uncaughtException", err); } finally { console.error = saved; }
  const text = read();
  assert.ok(consoleText.includes("boom from a synthetic uncaughtException"), "the console did not get the block");
  assert.ok(text.includes(consoleText + "\n"), "the file does not hold the console's block verbatim");
  assert.match(text, /│ scope:   uncaughtException/);
});

check("a log FOLDER that vanished is re-made on the retry, not left failing", () => {
  fs.rmSync(dir, { recursive: true, force: true });
  t += 1;
  quiet(() => logger.info("sink-test", "line six, folder gone"));
  t += 30_000;
  quiet(() => logger.info("sink-test", "line seven, after the window"));
  const lines = read().trimEnd().split("\n");
  assert.equal(lines.length, 2, `expected the gap line then line seven, got:\n${lines.join("\n")}`);
  assert.match(lines[0], /file log resumed after 1 dropped line\(s\)$/);
  assert.match(lines[1], /line seven/);
});

setLogFileClockForTests(null);
if (failures) { console.error(`\n${failures} logger file-sink test(s) failed.`); process.exit(1); }
console.log("\nAll logger file-sink tests passed.");
