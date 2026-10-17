// OPENING A PROJECT DOES NO WORK FOR PANELS NOBODY CAN SEE (#361).
//
// Evidence: on a scratch DB built by scripts/demo-environment.ts, the six hidden team panels
// (ops plan + brief, runbook, handoff packet, communication drafts, installer actions; DOM kept in
// #hiddenTeamArtifacts in dashboard.html) were 50-70% of an open's server CPU, because each one
// rebuilds the reviewer gate: 38 of the 51 reviewer builds in one open. The open also re-downloaded
// the whole knowledge base and the code profiles, which the board load already holds. In real
// Chromium the panels painted in 2.8-4.3 s with them, 0.9-1.3 s without.
//
// The fix (frontend/dashboard.js selectProject) drops those loads from the open. This test reads
// the REAL file and fails if any of them comes back, directly or through a function the open uses:
//   MUST-EXCLUDE  any reference (a call, or a bare name handed to a helper) to a hidden-panel loader,
//                 loadPmPackets (which calls three of them) or loadKnowledgeBase, in selectProject
//                 or in any top-level function selectProject calls or names (one level down; the
//                 likeliest regression is a helper bundling the `await loadOpsPlan(); await
//                 loadPmPackets(); ...` block the action handlers repeat). A called name that is not
//                 a top-level definition (and not a keyword) FAILS rather than being skipped; that
//                 includes a local callback such as `(f) => f()`, so give such a helper a top-level name.
//   MUST-KEEP     the visible gate (loadSubmitGate) and the next-step banner (loadNextStep) still
//                 load on open; the open's timeline load POSTs ops-plan/sync BEFORE it reads the
//                 timeline, because the visible Project Timeline's phase entries and blocker count
//                 come from the operation_steps that sync writes (the hidden ops-plan GET used to do
//                 it); the hidden loaders stay defined so the panels can be restored; the KB still
//                 loads at board load (loadProjects), which the record-portal URL prefill
//                 (renderRecordPortal reads state.knowledgeProfiles) depends on, and a KB load that
//                 succeeds later repaints that prefill.
// Known gap: the comment stripper is a regex, not a parser. A `//` inside a regex literal (one
// ending `\\//`, say) drops the rest of that line, so a loader called later on that line is missed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   - ${name}`);
};

const here = path.dirname(fileURLToPath(import.meta.url));
// DASHBOARD_JS_PATH points a kill run at a mutated copy (the live file is never edited to test).
const dashboard = fs.readFileSync(process.env.DASHBOARD_JS_PATH || path.join(here, "..", "..", "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");

const esc = (name: string): string => name.replace(/\$/g, "\\$");
const defRe = (name: string): RegExp => new RegExp(`^(?:async )?function ${esc(name)}\\(|^(?:const|let|var) ${esc(name)} = `, "m");
/** A top-level `[async] function NAME(` up to its closing `}` in column 0, or null. */
const body = (name: string): string | null => {
  const m = new RegExp(`^(?:async )?function ${esc(name)}\\(`, "m").exec(dashboard);
  if (!m) return null;
  const end = dashboard.indexOf("\n}\n", m.index);
  return dashboard.slice(m.index, end < 0 ? undefined : end + 2);
};
/** A top-level arrow `const NAME = (...) =>` / `async (...) =>`, to its end, or null. */
const arrowBody = (name: string): string | null => {
  const m = new RegExp(`^const ${esc(name)} = (?:async )?(?:\\([^)]*\\)|\\w+) =>`, "m").exec(dashboard);
  if (!m) return null;
  const brace = dashboard.indexOf("\n};\n", m.index), semi = dashboard.indexOf(";\n", m.index);
  const end = dashboard[m.index + m[0].length + 1] === "{" && brace >= 0 ? brace + 3 : semi + 1;
  return dashboard.slice(m.index, end);
};
const fnBody = (name: string): string | null => body(name) ?? arrowBody(name);
/** Comments out, so a loader NAMED in prose is not mistaken for a use. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const ID = "[A-Za-z_$][\\w$]*";
/** Any use of NAME that is not a property access: `name(`, `[name]`, `f(name)`. */
const refs = (src: string, name: string): boolean => new RegExp(`(?<![\\w$.])${esc(name)}(?![\\w$])`).test(code(src));
const calls = (src: string, name: string): boolean => new RegExp(`(?<![\\w$.])${esc(name)}\\s*\\(`).test(code(src));
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "function", "return", "typeof", "await", "async", "void", "new", "delete", "in", "of"]);

const HIDDEN_LOADERS = [
  "loadOpsPlan", "loadRunbook", "loadHandoffPacket", "loadCommunicationDrafts", "loadInstallerPacket",
  "loadPmPackets", "loadKnowledgeBase",
];

const select = body("selectProject");
check("selectProject is found in dashboard.js", Boolean(select));
if (select) {
  for (const fn of HIDDEN_LOADERS) check(`selectProject does not reference ${fn}`, !refs(select, fn));

  // Every called name must be something this file defines; an unknown one fails instead of
  // silently escaping the one-level check below.
  const called = [...new Set([...code(select).matchAll(new RegExp(`(?<![\\w$.])(${ID})\\s*\\(`, "g"))].map((m) => m[1]))]
    .filter((name) => !KEYWORDS.has(name));
  const unresolved = called.filter((name) => !defRe(name).test(dashboard));
  check("every function selectProject calls is defined at top level in dashboard.js", unresolved.length === 0, unresolved.join(", "));

  // One level down: no function the open calls or names may pull a hidden panel back in.
  const named = [...new Set([...code(select).matchAll(new RegExp(`(?<![\\w$.])(${ID})(?![\\w$])`, "g"))].map((m) => m[1]))]
    .filter((name) => name !== "selectProject" && !HIDDEN_LOADERS.includes(name) && fnBody(name));
  for (const name of [...new Set([...called.filter((n) => defRe(n).test(dashboard)), ...named])]) {
    if (name === "selectProject" || HIDDEN_LOADERS.includes(name)) continue;
    const src = fnBody(name);
    check(`${name} (used on open) is found as a function`, Boolean(src));
    if (!src) continue;
    const hit = HIDDEN_LOADERS.filter((fn) => refs(src, fn));
    check(`${name} (used on open) references no hidden-panel loader`, hit.length === 0, hit.join(", "));
  }

  check("selectProject still loads the visible submit gate", calls(select, "loadSubmitGate"));
  check("selectProject still loads the next-step banner", calls(select, "loadNextStep"));
  check("selectProject does not reset the loaded knowledge base", !/state\.knowledgeProfiles\s*=/.test(code(select)));

  // THE TIMELINE STAYS CURRENT: the open reads the timeline only through the synced loader, and that
  // loader awaits POST ops-plan/sync before it reads.
  check("selectProject reads the timeline through loadProjectTimelineSynced", calls(select, "loadProjectTimelineSynced"));
  check("selectProject never reads the timeline unsynced", !calls(select, "loadProjectTimeline"));
  const synced = body("loadProjectTimelineSynced");
  const syncedCode = synced ? code(synced) : "";
  const postAt = syncedCode.search(/await api\(`\/api\/projects\/\$\{state\.selectedProjectId\}\/ops-plan\/sync`,\s*\{\s*method:\s*"POST"/);
  const readAt = syncedCode.search(/await loadProjectTimeline\(\)/);
  check("the open's timeline load awaits POST ops-plan/sync", postAt >= 0);
  check("the open's timeline load reads the timeline after the sync", readAt > postAt && postAt >= 0);
  check("a failed sync still reads the timeline (the POST is caught)", /try\s*\{[\s\S]*ops-plan\/sync[\s\S]*\}\s*catch/.test(syncedCode));
}

for (const fn of HIDDEN_LOADERS) check(`${fn} stays defined (panels can be restored, actions still call it)`, Boolean(body(fn)));

const loadProjects = body("loadProjects");
check("the board load (loadProjects) still loads the knowledge base", Boolean(loadProjects && calls(loadProjects, "loadKnowledgeBase")));
const recordPortal = body("renderRecordPortal");
check("the record-portal URL prefill still reads state.knowledgeProfiles", Boolean(recordPortal && /state\.knowledgeProfiles/.test(recordPortal)));
const kb = body("loadKnowledgeBase");
check("a KB load that succeeds repaints the open project's record-portal prefill", Boolean(kb && refs(kb, "renderRecordPortal")));

if (failures) { console.error(`\nselectProjectHiddenPanels: ${failures} FAILED`); process.exit(1); }
console.log("\nselectProjectHiddenPanels: all checks passed");
process.exit(0);
