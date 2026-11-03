// A CLICK IN THE SERVER'S CONSOLE WINDOW MUST NEVER STOP THE SERVER (#360).
//
// 2026-10-17: a click inside the production window put it in QuickEdit selection mode, Windows
// held every console write, and one log line froze the event loop for eight minutes. The boot
// hook in consoleQuickEdit.ts clears QuickEdit on the console the server is attached to.
//
//   MUST-PASS    in a REAL console window with QuickEdit forced on, the boot hook clears it
//                (read back with GetConsoleMode); the gate says yes for a Windows TTY stdout.
//   MUST-EXCLUDE the gate says no when stdout is a pipe or a file, off Windows, or when the
//                operator opts out (AUTOPILOT_KEEP_QUICKEDIT=1): a test boot, the smoke and a
//                systemd unit never spawn PowerShell; the script changes only the two bits it
//                names and never a user-wide default.
//
// The real-console half runs in a fresh minimized window (cmd `start /wait`), because this
// process has pipes for stdio and a pipe is not a console. It is Windows-only; elsewhere the
// gate checks run and the console half says so. QUICKEDIT_SKIP_FIX=1 in that window makes the
// check fail, which is how it was shown to bite (see the PR).
// Run: npx tsx backend/test/consoleQuickEdit.test.ts
import { REPO, ISOLATED_CWD } from "./_isolate";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  ENABLE_EXTENDED_FLAGS, ENABLE_QUICK_EDIT_MODE, KEEP_QUICKEDIT_ENV,
  consoleModeScript, quickEditOn, shouldDisableQuickEdit,
} from "../src/consoleQuickEdit";

let failed = 0;
const check = (label: string, fn: () => void) => {
  try { fn(); console.log(`ok   - ${label}`); }
  catch (e) { failed++; console.log(`FAIL - ${label}: ${e instanceof Error ? e.message : String(e)}`); }
};

// --- The gate ------------------------------------------------------------------------------
const win = (stdoutIsTTY: boolean | undefined, env: NodeJS.ProcessEnv = {}) =>
  shouldDisableQuickEdit({ platform: "win32", stdoutIsTTY, env });

check("gate: Windows console stdout → disable", () => assert.equal(win(true), true));
check("gate: stdout a pipe or file (every test boot, the smoke) → leave alone", () => {
  assert.equal(win(false), false);
  assert.equal(win(undefined), false);
});
check("gate: not Windows → leave alone even on a TTY", () => {
  assert.equal(shouldDisableQuickEdit({ platform: "linux", stdoutIsTTY: true, env: {} }), false);
  assert.equal(shouldDisableQuickEdit({ platform: "darwin", stdoutIsTTY: true, env: {} }), false);
});
check(`gate: ${KEEP_QUICKEDIT_ENV}=1 opts out; other values do not`, () => {
  assert.equal(win(true, { [KEEP_QUICKEDIT_ENV]: "1" }), false);
  assert.equal(win(true, { [KEEP_QUICKEDIT_ENV]: " 1 " }), false);
  assert.equal(win(true, { [KEEP_QUICKEDIT_ENV]: "0" }), true);
  assert.equal(win(true, { [KEEP_QUICKEDIT_ENV]: "" }), true);
});

// --- The script ----------------------------------------------------------------------------
check("script: opens the console by name (CONIN$), never a standard handle the child does not own", () => {
  const s = consoleModeScript("disable");
  assert.match(s, /CreateFileW\("CONIN\$"/);
  assert.doesNotMatch(s, /GetStdHandle/);
});
check("script: disable clears QUICK_EDIT, sets EXTENDED_FLAGS, keeps every other bit", () => {
  const s = consoleModeScript("disable");
  assert.match(s, new RegExp(`\\$n = \\$m -bor ${ENABLE_EXTENDED_FLAGS}; if \\(\\(\\$n -band ${ENABLE_QUICK_EDIT_MODE}\\) -ne 0\\) \\{ \\$n = \\$n - ${ENABLE_QUICK_EDIT_MODE} \\}`));
  assert.doesNotMatch(s, /0xFFFFFFFF/, "PowerShell 5.1 reads that literal as Int32 -1");
  assert.doesNotMatch(s, /HKCU|Registry|Set-ItemProperty/i, "must never touch the user-wide console default");
});
check("script: read changes nothing", () => assert.match(consoleModeScript("read"), /\$n = \$m\n/));
check("quickEditOn reads bit 0x40", () => {
  assert.equal(quickEditOn(0x1f7), true);
  assert.equal(quickEditOn(0x1b7), false);
});

// --- The real console (Windows only) ------------------------------------------------------
if (process.platform !== "win32") {
  console.log("ok   - real-console check skipped (Windows only; the gate above is what runs elsewhere)");
} else {
  const resultFile = path.join(ISOLATED_CWD, "quickedit-result.json");
  const runner = path.join(ISOLATED_CWD, "quickedit-in-console.cmd");
  const tsx = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
  const inner = path.join(REPO, "backend", "test", "consoleQuickEdit.inConsole.ts");
  // One runner file instead of nested quoting through `start` and `cmd /c`: node's path has a
  // space in it. The window is minimized and closes itself when the inner script exits.
  fs.writeFileSync(runner, [
    "@echo off",
    `set "QUICKEDIT_RESULT_FILE=${resultFile}"`,
    process.env.QUICKEDIT_SKIP_FIX === "1" ? "set QUICKEDIT_SKIP_FIX=1" : "set QUICKEDIT_SKIP_FIX=",
    `"${process.execPath}" "${tsx}" "${inner}"`,
    "exit",
  ].join("\r\n") + "\r\n");

  const r = spawnSync("cmd.exe", ["/c", "start", "", "/min", "/wait", runner], {
    cwd: REPO, stdio: "ignore", timeout: 120_000, windowsHide: false,
  });
  check("real console: the window ran and reported", () => {
    assert.equal(r.error, undefined, String(r.error));
    assert.ok(fs.existsSync(resultFile), "no result file: the in-console script never finished");
  });
  if (fs.existsSync(resultFile)) {
    const res = JSON.parse(fs.readFileSync(resultFile, "utf8")) as {
      stdoutIsTTY: boolean; forced?: { ok: boolean; error?: string }; afterForce?: { ok: boolean; after?: number };
      fix?: { ok?: boolean; skipped?: boolean; error?: string; before?: number; after?: number };
      afterFix?: { ok: boolean; after?: number }; quickEditOnAfterFix: boolean | null; error?: string;
    };
    check("real console: stdout was a TTY there (the production shape)", () => assert.equal(res.stdoutIsTTY, true));
    check("real console: QuickEdit could be forced on first (the failure shape)", () => {
      assert.equal(res.error, undefined, res.error);
      assert.equal(res.forced?.ok, true, res.forced?.error);
      assert.ok(res.afterForce?.ok && res.afterForce.after !== undefined && quickEditOn(res.afterForce.after), `mode after force: ${res.afterForce?.after?.toString(16)}`);
    });
    check("real console: the boot hook ran and cleared QuickEdit (GetConsoleMode read-back)", () => {
      assert.equal(res.fix?.skipped, false, `hook skipped: ${JSON.stringify(res.fix)}`);
      assert.equal(res.fix?.ok, true, res.fix?.error);
      assert.equal(res.quickEditOnAfterFix, false, `mode after fix: ${res.afterFix?.after?.toString(16)}`);
    });
    check("real console: EXTENDED_FLAGS set and the other bits kept", () => {
      const before = res.afterForce!.after!, after = res.afterFix!.after!;
      assert.ok((after & ENABLE_EXTENDED_FLAGS) !== 0);
      assert.equal(after & ~(ENABLE_QUICK_EDIT_MODE | ENABLE_EXTENDED_FLAGS), before & ~(ENABLE_QUICK_EDIT_MODE | ENABLE_EXTENDED_FLAGS));
    });
  }
}

if (failed) { console.log(`consoleQuickEdit: ${failed} FAILED`); process.exit(1); }
console.log("consoleQuickEdit: all checks passed");
