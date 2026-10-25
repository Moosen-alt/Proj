// The in-console half of consoleQuickEdit.test.ts. Not a suite (no .test.ts): the test starts
// it in a FRESH console window, because the test runner gives every suite pipes for stdio and
// a pipe is not a console. Here stdout is the real thing, so `process.stdout.isTTY` is true and
// the boot hook takes the same path it takes under `cmd /k npm start`.
//
// Steps, each written to QUICKEDIT_RESULT_FILE as JSON so the parent can read them back:
//   1. force QuickEdit ON (the failure shape, whatever the user's console default is);
//   2. read it back: it must be on, or the console cannot be driven and the check is moot;
//   3. run the boot hook (unless QUICKEDIT_SKIP_FIX=1, which the test uses to prove the
//      check bites);
//   4. read it back again.
import fs from "node:fs";
import { applyConsoleMode, disableConsoleQuickEdit, quickEditOn } from "../src/consoleQuickEdit";

const out = process.env.QUICKEDIT_RESULT_FILE!;
const result: Record<string, unknown> = { stdoutIsTTY: process.stdout.isTTY === true };
try {
  result.forced = applyConsoleMode("enable");
  result.afterForce = applyConsoleMode("read");
  result.fix = process.env.QUICKEDIT_SKIP_FIX === "1"
    ? { skipped: true, reason: "QUICKEDIT_SKIP_FIX" }
    : disableConsoleQuickEdit({ platform: process.platform, stdoutIsTTY: process.stdout.isTTY, env: process.env });
  const after = applyConsoleMode("read");
  result.afterFix = after;
  result.quickEditOnAfterFix = after.ok && after.after !== undefined ? quickEditOn(after.after) : null;
} catch (e) {
  result.error = e instanceof Error ? e.message : String(e);
}
fs.writeFileSync(out, JSON.stringify(result));
