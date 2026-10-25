// ---------------------------------------------------------------------------
// A click in the server's console window must never stop the server (#360).
//
// On 2026-10-17 production went silent for eight minutes: port listening, CPU flat, main
// thread in a kernel wait. The console window's title read "Select Windows PowerShell".
// Someone had clicked inside it, which put the console into QuickEdit selection mode, and
// Windows blocks every console write while a selection is active. The logger mirrors each
// line to that console (synchronously on a Windows TTY), so one log line froze the event
// loop and with it the dashboard, the job queue and every portal run for every org.
//
// The fix: at boot, when stdout is a real Windows console, clear ENABLE_QUICK_EDIT_MODE on
// the console this process is attached to. Node has no way to call SetConsoleMode itself,
// so a short PowerShell child does it through P/Invoke. Three things about that, each
// measured on the owner's machine before this was written:
//   - The child opens CONIN$ by name rather than GetStdHandle: spawnSync gives it pipes
//     for stdio, so its own standard handles are not the console.
//   - The change outlives the child. It is cmd.exe that restores a console's mode, and
//     only when the command it is waiting on (npm start → this process) exits. While this
//     process lives, the mode this child set stays in force.
//   - The script travels as -EncodedCommand: PowerShell 5.1 strips embedded double quotes
//     from a -Command string, and the P/Invoke definition is full of them.
// Only this one console is touched. The user-wide default (HKCU\Console\QuickEdit) is the
// owner's setting and stays as it is. AUTOPILOT_KEEP_QUICKEDIT=1 opts out.
//
// Residual: QuickEdit is the click-and-drag selection that caused the incident. Edit → Mark
// (Ctrl+M) and scroll-lock (Ctrl+S) still pause console writes; those take a deliberate
// keystroke, not a stray click.
// ---------------------------------------------------------------------------
import { spawnSync } from "node:child_process";
import fs from "node:fs";

export const ENABLE_QUICK_EDIT_MODE = 0x40;
export const ENABLE_EXTENDED_FLAGS = 0x80;

/** Opt-out: the operator wants QuickEdit kept on this console (and accepts the freeze). */
export const KEEP_QUICKEDIT_ENV = "AUTOPILOT_KEEP_QUICKEDIT";

export interface QuickEditDecisionInput {
  platform: NodeJS.Platform;
  /** `process.stdout.isTTY`: true only when stdout is the console whose writes can block. */
  stdoutIsTTY: boolean | undefined;
  env: NodeJS.ProcessEnv;
}

/**
 * Whether to touch the console at all. The blocking write is to the screen buffer, so the
 * gate is stdout (not stdin): a server with stdout redirected to a file or pipe — every test
 * boot, the smoke, systemd — never spawns anything.
 */
export function shouldDisableQuickEdit(input: QuickEditDecisionInput): boolean {
  if (input.platform !== "win32") return false;
  if (!input.stdoutIsTTY) return false;
  if ((input.env[KEEP_QUICKEDIT_ENV] || "").trim() === "1") return false;
  return true;
}

/**
 * The PowerShell that reads the attached console's input mode, applies `op`, and prints
 * `mode=<before>,<after>` in hex. `op` "disable" clears QUICK_EDIT and sets EXTENDED_FLAGS
 * (the flag that makes the QUICK_EDIT bit meaningful); "enable" sets both, which the
 * regression test uses to force the failure shape before it runs the fix; "read" changes
 * nothing. The arithmetic keeps every other bit as it was.
 */
export function consoleModeScript(op: "disable" | "enable" | "read"): string {
  // Subtraction, not a mask: PowerShell 5.1 reads 0xFFFFFFFF as the Int32 -1, and a failed
  // [uint32] cast left $n empty, so the first version set the mode to 0 (measured).
  const apply =
    op === "disable" ? `$n = $m -bor ${ENABLE_EXTENDED_FLAGS}; if (($n -band ${ENABLE_QUICK_EDIT_MODE}) -ne 0) { $n = $n - ${ENABLE_QUICK_EDIT_MODE} }`
    : op === "enable" ? `$n = $m -bor ${ENABLE_EXTENDED_FLAGS | ENABLE_QUICK_EDIT_MODE}`
    : `$n = $m`;
  return [
    // Any PowerShell error becomes an error= line and a non-zero exit, never a half-applied mode.
    `$ErrorActionPreference = "Stop"`,
    `try {`,
    `Add-Type -Namespace SolarConsole -Name Mode -MemberDefinition @'`,
    `[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]`,
    `public static extern IntPtr CreateFileW(string f, uint a, uint s, IntPtr sa, uint c, uint fl, IntPtr t);`,
    `[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleMode(IntPtr h, out uint m);`,
    `[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleMode(IntPtr h, uint m);`,
    `'@`,
    // GENERIC_READ|GENERIC_WRITE as a decimal literal: PowerShell 5.1 parses 0xC0000000 as a
    // negative Int32 and refuses to pass it as uint.
    `$h = [SolarConsole.Mode]::CreateFileW("CONIN$", [uint32]3221225472, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)`,
    `$m = [uint32]0`,
    `if (-not [SolarConsole.Mode]::GetConsoleMode($h, [ref]$m)) { Write-Output "error=GetConsoleMode"; exit 2 }`,
    `$before = $m`,
    apply,
    `if ($n -ne $m) { if (-not [SolarConsole.Mode]::SetConsoleMode($h, [uint32]$n)) { Write-Output "error=SetConsoleMode"; exit 3 } }`,
    `[void][SolarConsole.Mode]::GetConsoleMode($h, [ref]$m)`,
    `Write-Output ("mode={0:X},{1:X}" -f $before, $m)`,
    `} catch { Write-Output ("error=" + $_.Exception.Message.Replace("\`n", " ")); exit 4 }`,
  ].join("\n");
}

export interface ConsoleModeResult {
  ok: boolean;
  /** Input mode before and after, when the child reported them. */
  before?: number;
  after?: number;
  /** Why it did not happen: the child's error line, a spawn failure, or an unparseable reply. */
  error?: string;
}

/**
 * Run `consoleModeScript(op)` against the console this process is attached to. Never throws:
 * a console that cannot be reached is reported, not fatal — the server must still boot.
 */
export function applyConsoleMode(op: "disable" | "enable" | "read", timeoutMs = 15_000): ConsoleModeResult {
  const encoded = Buffer.from(consoleModeScript(op), "utf16le").toString("base64");
  let out = "";
  // THE CHILD'S STDIN MUST BE THE CONSOLE. Measured: with a pipe or NUL on stdin, PowerShell
  // puts the console's input mode back the way it found it when it exits, and the change
  // lasts exactly as long as the child. With the console itself on stdin the change stays.
  // Opening CONIN$ by name gives that handle whatever this process's own stdin is (the
  // supervisor feeds the server NUL); falling back to inherit covers a console we cannot open.
  let conin: number | null = null;
  try { conin = fs.openSync("CONIN$", "r+"); } catch { conin = null; }
  try {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      stdio: [conin ?? "inherit", "pipe", "pipe"],
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });
    if (r.error) return { ok: false, error: `spawn: ${r.error.message}` };
    out = (r.stdout || "").trim();
    const err = /error=(\S+)/.exec(out);
    if (err) return { ok: false, error: err[1] };
    const m = /mode=([0-9A-Fa-f]+),([0-9A-Fa-f]+)/.exec(out);
    if (!m) return { ok: false, error: `unexpected reply: ${(out || (r.stderr || "").trim()).slice(0, 200)}` };
    return { ok: true, before: parseInt(m[1], 16), after: parseInt(m[2], 16) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (conin !== null) { try { fs.closeSync(conin); } catch { /* already closed */ } }
  }
}

/**
 * The console's input mode as a fresh child sees it. A setter's own read-back is taken before
 * that child exits, so it cannot see a revert at exit; this read can, which is why the boot
 * hook trusts only this.
 */
export function readConsoleMode(): number | undefined {
  const r = applyConsoleMode("read");
  return r.ok ? r.before : undefined;
}

export const quickEditOn = (mode: number): boolean => (mode & ENABLE_QUICK_EDIT_MODE) !== 0;

/**
 * Boot hook: clear QuickEdit on this console when `shouldDisableQuickEdit` says so. Returns
 * what happened so the caller can log one line; `skipped` means the gate said no.
 */
export function disableConsoleQuickEdit(input: QuickEditDecisionInput = { platform: process.platform, stdoutIsTTY: process.stdout.isTTY, env: process.env }): ConsoleModeResult & { skipped: boolean } {
  if (!shouldDisableQuickEdit(input)) return { ok: true, skipped: true };
  const r = applyConsoleMode("disable");
  if (!r.ok) return { ...r, skipped: false };
  // Verify from outside the setter (see readConsoleMode): the one failure mode measured here
  // is a change that reverts the moment the child exits.
  const after = readConsoleMode();
  if (after === undefined) return { ...r, ok: false, skipped: false, error: "set, but the read-back failed" };
  if (quickEditOn(after)) return { ...r, after, ok: false, skipped: false, error: "QuickEdit came back on after the child exited" };
  return { ...r, after, skipped: false };
}
