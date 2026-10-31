// EVERY TRACKED-FILING CARD HAS ITS OWN EDIT AND RECORD STATUS (#411).
//
// Owner 2026-10-29, West / Lincoln County (project 7ddfbe48): "can we also make it so we can edit
// the checkups?" The building permit was issued while its card read ACTIVE, and the card offered
// nothing to change — fixing a target meant knowing the add-target form upserts by number, and a
// status meant pasting text and picking the filing in a separate selector.
//
// Run as the SHIPPED functions lifted out of frontend/dashboard.js (the brace-balanced cut of
// correctionCardRender.test.ts — no Chromium). Checks:
//   - each card renders Edit and Record status, carrying THAT card's target id, every value esc()'d;
//   - a click on the second card's Record posts the second card's targetId with source "manual",
//     never the project's first target (MUST-EXCLUDE);
//   - each pick's words classify, through the REAL classifier, as the status it names (a bare
//     "Issued" reads as issued too since #419; the pick still posts "Permit issued");
//   - an untouched Edit form sends nothing (the card shows the EFFECTIVE cadence: sending it back
//     would rewrite a stored 7 to 1).
//
//   npx tsx backend/test/permitTargetCard.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPermitStatusText } from "../src/permitMonitor";

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboard = fs.readFileSync(path.join(here, "..", "..", "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
const cut = (kind: "function" | "async function" | "const", name: string): string => {
  const re = kind === "const" ? new RegExp(`^const ${name} = `, "m") : new RegExp(`^${kind} ${name}\\(`, "m");
  const m = re.exec(dashboard);
  if (!m) throw new Error(`dashboard.js: could not find ${kind} ${name}`);
  let depth = 0, end = -1;
  const open = kind === "const" ? dashboard.slice(m.index).search(/[[{]/) + m.index : dashboard.indexOf("{", dashboard.indexOf(")", m.index));
  const [o, c] = dashboard[open] === "[" ? ["[", "]"] : ["{", "}"];
  for (let j = open; j < dashboard.length; j++) {
    if (dashboard[j] === o) depth++;
    else if (dashboard[j] === c) { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  if (end < 0) throw new Error(`dashboard.js: unbalanced ${name}`);
  return dashboard.slice(m.index, end) + (kind === "const" ? ";" : "");
};

// The page globals the lifted functions reach, stubbed. `posted` records every api() call.
const harness = `
class Element {}
const posted = [];
const messages = [];
const elements = {};
const $ = (id) => elements[id] || null;
let renders = 0;
const state = { selectedProjectId: "p-1", detail: null, permitFormFor: null, recheckTargetId: null, permitTargetEditing: null, permitTargetRecording: null };
const api = async (url, options = {}) => { posted.push({ url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null }); return state.detail; };
const showMessage = (text, kind) => { messages.push({ text, kind }); };
const renderPermitMonitor = () => { renders++; };
const renderDetail = () => { renders++; };
const noop = async () => {};
const loadOpsPlan = noop, loadPmPackets = noop, loadLiveReadiness = noop, loadProjectTimeline = noop, loadProcessMap = noop,
  loadInstallerPacket = noop, loadStaleReadings = noop, loadProjects = noop;
`;
const bundle = [
  harness,
  cut("function", "esc"), cut("function", "humanize"), cut("function", "statusBadge"),
  cut("function", "permitTargetKindLabel"), cut("function", "portalSaysFor"), cut("function", "permitStatusTargetId"),
  cut("const", "PERMIT_STATUS_PICKS"), cut("function", "permitTargetStatusText"), cut("function", "permitTargetEditPatch"),
  cut("function", "permitTargetCardHtml"), cut("function", "handlePermitTargetClick"),
  cut("async function", "savePermitTargetEdit"), cut("async function", "recordPermitStatus"),
].join("\n\n");
type Target = Record<string, unknown>;
type Lifted = {
  Element: new () => object;
  posted: Array<{ url: string; method: string; body: Record<string, unknown> | null }>;
  messages: Array<{ text: string; kind: string }>;
  elements: Record<string, unknown>;
  state: Record<string, unknown>;
  PERMIT_STATUS_PICKS: Array<{ key: string; label: string; text: string }>;
  permitTargetStatusText: (key: string, other?: string) => string;
  permitTargetEditPatch: (target: Target, values: Record<string, unknown>) => Record<string, unknown>;
  permitTargetCardHtml: (target: Target, checks: unknown[], ui: { editing?: boolean; recording?: boolean }) => string;
  handlePermitTargetClick: (event: { target: unknown }) => void;
};
// eslint-disable-next-line no-new-func
const L = new Function(`${bundle}
return { Element, posted, messages, elements, state, PERMIT_STATUS_PICKS, permitTargetStatusText, permitTargetEditPatch, permitTargetCardHtml, handlePermitTargetClick };`)() as Lifted;

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// Two filings on one project, in the live shape (West / Lincoln County: a structural and an
// electrical permit). The SECOND is the one the owner records — the first-target default is the bug.
const STR: Target = {
  id: "t-str", projectId: "p-1", jurisdiction: "Lincoln County", portalName: "Oregon ePermitting", portalUrl: "",
  applicationNumber: "519-26-001665-STR", permitNumber: "519-26-001665-STR", checkFrequencyDays: 1, active: true,
  latestOutcome: null, targetType: "permit", permitType: "building", portalPlatform: "unknown",
};
const ELEC: Target = { ...STR, id: "t-elec", applicationNumber: "519-26-001666-ELEC", permitNumber: "519-26-001666-ELEC", permitType: "electrical" };
L.state.detail = { project: { id: "p-1" }, permitCheckTargets: [STR, ELEC], permitStatusChecks: [] };

console.log("1. The card renders Edit and Record status for THIS filing");
await check("each card carries Edit and Record status controls with its own target id", () => {
  for (const t of [STR, ELEC]) {
    const html = L.permitTargetCardHtml(t, [], {});
    assert.match(html, new RegExp(`data-target-action="edit" data-target-id="${t.id}"`));
    assert.match(html, new RegExp(`data-target-action="record" data-target-id="${t.id}"`));
    assert.match(html, new RegExp(`data-permit-target="${t.id}"`));
  }
});
await check("the Edit form opens with the filing's values in fields scoped to the card", () => {
  const html = L.permitTargetCardHtml(ELEC, [], { editing: true });
  for (const f of ["portalUrl", "trackingUrl", "applicationNumber", "permitNumber", "portalName", "checkFrequencyDays", "active"]) {
    assert.match(html, new RegExp(`data-edit-field="${f}"`), f);
  }
  assert.match(html, /value="519-26-001666-ELEC"/);
  assert.match(html, /data-target-action="save" data-target-id="t-elec"/);
  assert.doesNotMatch(html, /\sid="/, "a repeated card must not use page-wide element ids");
});
await check("the Record form offers the six picks", () => {
  const html = L.permitTargetCardHtml(ELEC, [], { recording: true });
  for (const label of ["Issued", "Approved", "In review", "Corrections required", "Fees due", "Other"]) assert.ok(html.includes(`>${label}`), label);
  assert.match(html, /data-target-action="record-save" data-target-id="t-elec"/);
});
await check("every interpolated value is esc()'d (an injected tag reaches the HTML only escaped)", () => {
  const evil = '"><img src=x onerror=alert(1)>';
  const t = { ...ELEC, id: `t${evil}`, portalName: evil, portalUrl: `https://x.test/${evil}`, trackingUrl: `https://y.test/${evil}`, applicationNumber: evil, permitNumber: evil, portalPlatform: evil, readGap: evil };
  for (const ui of [{}, { editing: true }, { recording: true }]) {
    const html = L.permitTargetCardHtml(t, [], ui);
    assert.ok(!html.includes("<img"), `raw tag in ${JSON.stringify(ui)}`);
    assert.ok(!html.includes(evil) && !html.includes("alert(1)>"), `attribute break-out in ${JSON.stringify(ui)}`);
  }
});

await check("the card says why the monitor cannot read the filing on its own (#413), and says nothing once it can", () => {
  const gap = "No portal recipe learned for Pacific Power yet, and its record pages need a login, so the monitor cannot read this filing. Record the status by hand until the portal is learned.";
  const html = L.permitTargetCardHtml({ ...ELEC, readGap: gap }, [], {});
  assert.ok(html.includes(`<strong>Can't read on its own:</strong> ${gap}`), html);
  assert.doesNotMatch(L.permitTargetCardHtml(ELEC, [], {}), /data-read-gap/, "a readable filing shows a gap line");
  assert.doesNotMatch(L.permitTargetCardHtml({ ...ELEC, readGap: gap, active: false }, [], {}), /data-read-gap/, "a stopped filing shows a gap line");
});

console.log("\n2. Record status posts THIS card's targetId");
// A fake card: the clicked button, its <article>, and the two Record inputs inside it.
const fakeCard = (targetId: string, pick: string, other = ""): { target: unknown } => {
  const fields: Record<string, { value: string }> = { pick: { value: pick }, other: { value: other } };
  const article = { querySelector: (sel: string) => fields[/data-record-field="(\w+)"/.exec(sel)?.[1] ?? ""] ?? null, querySelectorAll: () => [] };
  const button = Object.assign(new L.Element(), { dataset: { targetId, targetAction: "record-save" }, closest: (sel: string) => (sel.startsWith("article") ? article : button) });
  const clicked = Object.assign(new L.Element(), { closest: (sel: string) => (sel.startsWith("button") ? button : null) });
  return { target: clicked };
};
const flush = () => new Promise((r) => setTimeout(r, 20));
await check("MUST PASS: Record on the electrical card posts the electrical target, source manual, the Issued words", async () => {
  L.posted.length = 0;
  L.handlePermitTargetClick(fakeCard("t-elec", "issued"));
  await flush();
  const post = L.posted.find((p) => p.url === "/api/projects/p-1/permit-checks");
  assert.ok(post, `no POST to permit-checks: ${JSON.stringify(L.posted)}`);
  assert.equal(post!.method, "POST");
  assert.equal(post!.body?.targetId, "t-elec");
  assert.equal(post!.body?.source, "manual");
  assert.equal(post!.body?.rawStatusText, "Permit issued");
});
await check("MUST EXCLUDE: it is never the project's first target, and the paste box's numbers are not stamped on it", async () => {
  L.posted.length = 0;
  // The paste form is synced to THIS card's filing, with other numbers typed in it: only the card
  // guard (fromCard) keeps those numbers off the reading.
  L.state.permitFormFor = "p-1|t-elec";
  L.elements.permitStatusTarget = { value: "t-str" }; // the separate selector still names the FIRST filing
  L.elements.permitApplicationNumber = { value: "519-26-009999-TYPED" };
  L.elements.permitTrackingNumber = { value: "519-26-009999-TYPED" };
  L.handlePermitTargetClick(fakeCard("t-elec", "fees_due"));
  await flush();
  const post = L.posted.find((p) => p.url === "/api/projects/p-1/permit-checks");
  assert.ok(post, "no POST");
  assert.notEqual(post!.body?.targetId, "t-str");
  assert.equal(post!.body?.targetId, "t-elec");
  assert.equal(post!.body?.applicationNumber, "");
  assert.equal(post!.body?.permitNumber, "");
});
await check("Other with no words posts nothing and says why", async () => {
  L.posted.length = 0; L.messages.length = 0;
  L.handlePermitTargetClick(fakeCard("t-elec", "other", "   "));
  await flush();
  assert.equal(L.posted.length, 0);
  assert.equal(L.messages.at(-1)?.kind, "warning");
});
await check("Other posts the operator's own words", async () => {
  L.posted.length = 0;
  L.handlePermitTargetClick(fakeCard("t-elec", "other", "Final inspection scheduled"));
  await flush();
  assert.equal(L.posted[0]?.body?.rawStatusText, "Final inspection scheduled");
});

console.log("\n3. Each pick's words mean that status to the real classifier");
const words = (key: string) => L.permitTargetStatusText(key);
await check("a bare 'Issued' reads as issued (#419), the same outcome as the pick's own words", () => {
  assert.equal(classifyPermitStatusText("Issued", "permit").outcome, "issued");
});
await check("permit track: Issued -> issued, Approved -> reviewed_by_ahj, In review -> waiting, Corrections -> correction_flagged, Fees due -> ready_for_issue", () => {
  const want: Record<string, string> = { issued: "issued", approved: "reviewed_by_ahj", in_review: "waiting", corrections: "correction_flagged", fees_due: "ready_for_issue" };
  for (const [key, outcome] of Object.entries(want)) assert.equal(classifyPermitStatusText(words(key), "permit").outcome, outcome, key);
});
await check("NEM track: Approved -> nem_approved", () => {
  assert.equal(classifyPermitStatusText(words("approved"), "nem").outcome, "nem_approved");
});

console.log("\n4. Edit sends only what changed");
await check("an untouched form sends nothing — the effective 1-day cadence shown is not written back", () => {
  const patch = L.permitTargetEditPatch(ELEC, {
    portalUrl: "", trackingUrl: "", applicationNumber: "519-26-001666-ELEC", permitNumber: "519-26-001666-ELEC",
    portalName: "Oregon ePermitting", checkFrequencyDays: "1", active: true,
  });
  assert.deepEqual(Object.keys(patch), []);
});
await check("a pasted record URL, a new frequency and stop-tracking are sent by name", () => {
  const patch = L.permitTargetEditPatch(ELEC, {
    portalUrl: " https://aca-oregon.accela.com/oregon/Cap/CapDetail.aspx?capID1=26CAP ", trackingUrl: "", applicationNumber: "519-26-001666-ELEC",
    permitNumber: "519-26-001666-ELEC", portalName: "Oregon ePermitting", checkFrequencyDays: "7", active: false,
  });
  assert.equal(JSON.stringify(patch), JSON.stringify({ portalUrl: "https://aca-oregon.accela.com/oregon/Cap/CapDetail.aspx?capID1=26CAP", checkFrequencyDays: 7, active: false }));
});

if (failures) { console.error(`\n${failures} permit-target-card check(s) FAILED.`); process.exit(1); }
console.log("\nAll permit-target-card checks passed.");
process.exit(0);
