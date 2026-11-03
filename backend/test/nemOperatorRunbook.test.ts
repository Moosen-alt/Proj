// THE NEM OPERATOR RUNBOOK CITES ONLY THINGS THAT EXIST (#424).
//
// docs/NEM_OPERATOR_RUNBOOK.md is what a new Keelix team member files from. Every behaviour it
// describes names the code it comes from as `file:line`, every button it tells them to click is
// named in bold, and every setting it asks for is an environment variable. A cited file that moved,
// a line range past the end of its file, a button that was renamed, or a setting nothing reads is
// a runbook that sends a person to the wrong place. This pins all four against the repo, plus the
// "What the tool will not do" box (CLAUDE.md hard rule 1) the team's expectations rest on.
// MUST-EXCLUDE: a made-up path, line, label and setting are each caught (self-check at the bottom).
// Run: npx tsx backend/test/nemOperatorRunbook.test.ts
import { REPO } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");
const doc = read("docs/NEM_OPERATOR_RUNBOOK.md");

// After its first full path the runbook names a file by its bare name (`repository.ts:7831`).
// A bare name resolves against these folders, in order; the first that holds it wins.
const SEARCH_DIRS = ["", "backend/src", "portal-bot/src", "portal-bot/src/adapters", "shared/src", "frontend", "docs", "scripts"];
function resolveFile(name: string): string | null {
  for (const dir of SEARCH_DIRS) {
    const rel = path.join(dir, name);
    if (fs.existsSync(path.join(REPO, rel)) && fs.statSync(path.join(REPO, rel)).isFile()) return rel;
  }
  return null;
}
function lineCount(rel: string): number {
  return read(rel).split(/\r?\n/).length;
}

/** Every `path/or/name.ext` or `name.ext:12-34` the runbook puts in backticks. */
function citations(text: string): Array<{ file: string; last: number | null; raw: string }> {
  const out: Array<{ file: string; last: number | null; raw: string }> = [];
  for (const m of text.matchAll(/`([\w./-]+\.(?:ts|js|mjs|html|md|json))(?::(\d+)(?:-(\d+))?)?`/g)) {
    out.push({ file: m[1], last: m[3] ? Number(m[3]) : m[2] ? Number(m[2]) : null, raw: m[0] });
  }
  return out;
}
function assertCitation(c: { file: string; last: number | null; raw: string }): void {
  const rel = resolveFile(c.file);
  assert.ok(rel, `${c.raw}: no such file`);
  if (c.last !== null) assert.ok(c.last <= lineCount(rel!), `${c.raw}: ${rel} has only ${lineCount(rel!)} lines`);
}

const cites = citations(doc);
check(`the runbook cites ${cites.length} files, each exists and each line range is inside its file`, () => {
  assert.ok(cites.length >= 40, `only ${cites.length} citations found`);
  for (const c of cites) assertCitation(c);
});

// The buttons and controls a person is told to click, as the dashboard spells them. The frontend
// writes "&" as "&amp;" inside HTML, so both spellings count.
const frontend = ["frontend/dashboard.js", "frontend/dashboard.html", "frontend/parser.html", "backend/src/submittalTracks.ts"].map(read).join("\n");
const LABELS = [
  "Parse uploaded files", "Save to project", "Submitting client", "Stage in portal", "Approve & auto-submit",
  "Stage portals · Autopilot", "I submitted it → capture #", "Save & track",
  "Interconnection / case #", "Confirmation / PTO #", "Public status URL", "Before you submit on the portal",
  "Approve & request signatures", "I sent the signature request", "Check signature now",
  "Permit & NEM Checkup", "Record status", "Edit", "NEM checks", "Manage logins", "Audit Log",
  "3 · Submit", "4 · Track Approvals",
];
function labelExists(label: string): boolean {
  return frontend.includes(label) || frontend.includes(label.replace(/&/g, "&amp;"));
}
check(`every control the runbook names (${LABELS.length}) is on the dashboard, spelled the same`, () => {
  // The runbook wraps lines inside a label ("**Stage portals ·\nAutopilot**"): compare flattened.
  const flat = doc.replace(/\s+/g, " ");
  const missing = LABELS.filter((l) => !flat.includes(l) || !labelExists(l));
  assert.deepEqual(missing, []);
});

// The settings it asks for are read by the code.
const code = ["backend/src/server.ts", "backend/src/repository.ts", "portal-bot/src/browser.ts", "shared/src/portalSafety.ts", "backend/src/scheduler.ts", "backend/src/autoLearn.ts"]
  .filter((f) => fs.existsSync(path.join(REPO, f))).map(read).join("\n") + read(".env.example");
const SETTINGS = [...new Set([...doc.matchAll(/`((?:PORTAL|AUTH|MONITOR)_[A-Z_]+)(?:=[^`]*)?`/g)].map((m) => m[1]))];
check(`every setting the runbook names (${SETTINGS.join(", ")}) is read by the code and listed in .env.example`, () => {
  assert.ok(SETTINGS.includes("PORTAL_ALLOW_FINAL_SUBMIT") && SETTINGS.includes("PORTAL_HEADLESS") && SETTINGS.includes("AUTH_ENABLED"));
  const env = read(".env.example");
  const unread = SETTINGS.filter((s) => !new RegExp(`\\b${s}\\b`).test(code) || !new RegExp(`^#?\\s*${s}=`, "m").test(env));
  assert.deepEqual(unread, []);
});

// The rule-1 box: what the tool will never do, in words a new operator reads first.
check("the 'What the tool will not do' box names fees, CAPTCHA/MFA and filing without a named approval", () => {
  const box = doc.split(/\r?\n/).filter((l) => l.startsWith(">")).join("\n");
  assert.match(box, /What the tool will not do/);
  assert.match(box, /Pay a fee/i);
  assert.match(box, /CAPTCHA/);
  assert.match(box, /MFA/);
  assert.match(box, /named person's approval/);
});

// The runbook must say the rail's Approve is the card's one action (#423: it used to be a second
// "Approve & Submit" that never filed), held on a staged NEM draft like the card's, and must not
// promise that Stage-then-Approve files on NEM (#435).
check("it says the rail's Approve & auto-submit is the track card's action, held on a staged NEM draft, and not to Stage before Approve & auto-submit", () => {
  const flat = doc.replace(/\s+/g, " ");
  assert.match(flat, /rail's \*\*Approve & auto-submit\*\*[^]*same action as the track card's/);
  assert.match(flat, /held while a draft is staged, exactly like the card's/);
  assert.doesNotMatch(flat, /Approve & Submit/, "the runbook still names the retired rail label");
  assert.match(doc, /Do not click Stage first and then Approve & auto-submit/);
});

check("MUST-EXCLUDE (self-check): a made-up file, line range, label and setting are caught", () => {
  assert.throws(() => assertCitation({ file: "repositoryy.ts", last: null, raw: "`repositoryy.ts`" }));
  assert.throws(() => assertCitation({ file: "server.ts", last: 9_999_999, raw: "`server.ts:9999999`" }));
  assert.ok(!labelExists("Approve & auto-pay"));
  assert.ok(!new RegExp("\\bPORTAL_AUTO_PAY_FEES\\b").test(code));
});

if (failures) { console.error(`\n${failures} NEM runbook check(s) FAILED.`); process.exit(1); }
console.log("\nAll NEM runbook checks passed.");
