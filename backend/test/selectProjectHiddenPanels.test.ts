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
// the REAL file and fails if any of them comes back, directly or through a loader the open calls:
//   MUST-EXCLUDE  selectProject (or a load* it calls) calling a hidden-panel loader,
//                 loadPmPackets (which calls three of them) or loadKnowledgeBase.
//   MUST-KEEP     the visible gate (loadSubmitGate) and the next-step banner (loadNextStep) still
//                 load on open; the hidden loaders stay defined so the panels can be restored; the
//                 KB still loads at board load (loadProjects), which the record-portal URL prefill
//                 (renderRecordPortal reads state.knowledgeProfiles) depends on.
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

/** A top-level `[async] function NAME(` up to its closing `}` in column 0, or null. */
const body = (name: string): string | null => {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(dashboard);
  if (!m) return null;
  const end = dashboard.indexOf("\n}\n", m.index);
  return dashboard.slice(m.index, end < 0 ? undefined : end + 2);
};
/** Comments out, so a loader NAMED in prose is not mistaken for a call. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const calls = (src: string, fn: string): boolean => new RegExp(`\\b${fn}\\s*\\(`).test(code(src));

const HIDDEN_LOADERS = [
  "loadOpsPlan", "loadRunbook", "loadHandoffPacket", "loadCommunicationDrafts", "loadInstallerPacket",
  "loadPmPackets", "loadKnowledgeBase",
];

const select = body("selectProject");
check("selectProject is found in dashboard.js", Boolean(select));
if (select) {
  for (const fn of HIDDEN_LOADERS) check(`selectProject does not call ${fn}`, !calls(select, fn));

  // One level down: a loader the open calls must not pull a hidden panel back in.
  const direct = [...new Set([...code(select).matchAll(/\b(load[A-Z]\w*)\s*\(/g)].map((m) => m[1]))];
  for (const loader of direct.filter((name) => !HIDDEN_LOADERS.includes(name))) {
    const src = body(loader);
    if (!src) continue;
    const hit = HIDDEN_LOADERS.filter((fn) => calls(src, fn));
    check(`${loader} (called on open) calls no hidden-panel loader`, hit.length === 0, hit.join(", "));
  }

  check("selectProject still loads the visible submit gate", calls(select, "loadSubmitGate"));
  check("selectProject still loads the next-step banner", calls(select, "loadNextStep"));
  check("selectProject does not reset the loaded knowledge base", !/state\.knowledgeProfiles\s*=/.test(code(select)));
}

for (const fn of HIDDEN_LOADERS) check(`${fn} stays defined (panels can be restored, actions still call it)`, Boolean(body(fn)));

const loadProjects = body("loadProjects");
check("the board load (loadProjects) still loads the knowledge base", Boolean(loadProjects && calls(loadProjects, "loadKnowledgeBase")));
const recordPortal = body("renderRecordPortal");
check("the record-portal URL prefill still reads state.knowledgeProfiles", Boolean(recordPortal && /state\.knowledgeProfiles/.test(recordPortal)));

if (failures) { console.error(`\nselectProjectHiddenPanels: ${failures} FAILED`); process.exit(1); }
console.log("\nselectProjectHiddenPanels: all checks passed");
process.exit(0);
