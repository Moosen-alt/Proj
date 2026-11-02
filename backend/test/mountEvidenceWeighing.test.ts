// ONE STRAY WORD NEVER RECLASSIFIES A ROOF JOB (#533).
//
// A rooftop plan set that says "roof mount" over and over and names its rafters carried one
// "CARPORT" — a site-plan label for an existing structure beside the driveway. The mount
// predicate's text fallback asked "does the word appear anywhere?", so the job read as a carport
// array: reviewer.plan.ground-array-site fired ("roof access rules do not apply") and every rule
// gated on a roof — structure, attachment spacing, the UL listings — went silent. Those were the
// items the inspector then corrected. Separately, the UL listing check ran only on roofs, though a
// ground or carport array needs UL 61730 / 1703 modules and UL 2703 racking just the same.
//
// These fixtures are SYNTHETIC text (no names, addresses or plan-set prose).
// Every MUST-PASS fails with its fix removed (on main), except the "GROUND RACKING" check, which
// main passes: it pins a regression the first version of this fix brought in, and fails on that
// version. Every MUST-EXCLUDE is a way the weighing could over-correct into calling a real ground or
// carport array a roof; the TIE-BAND ones failed on that first version, which counted a ground set's
// roof-notes boilerplate as a full vote per word.
//
// Run: npx tsx backend/test/mountEvidenceWeighing.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import type { JurisdictionCodeProfile, ProjectRecord, ReviewerFinding } from "../../shared/src/types";
import { buildCodeContext } from "../src/codeProfiles";
import { evaluateDesignCodeFindings, isRoofMounted, designText, mountAdjective, mountKindForProject, rapidShutdownApplies } from "../src/codeReviewRules";
import { buildReviewerReport } from "../src/reviewerEngine";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const project = (snapshot: Record<string, unknown>): ProjectRecord => ({
  id: "mount-evidence-test",
  clientId: "c",
  state: "OR",
  ahj: "City of Testport",
  utility: "Test Power",
  homeownerName: "Test Owner",
  projectAddress: "1 Test St",
  interconnectionMethod: "Load-side breaker",
  status: "pending",
  parserSnapshot: { mounting: "", interco: "Load-side breaker", busRating: "225A", mainBreaker: "200A", pvBreaker: "40", ...snapshot },
} as unknown as ProjectRecord);
const textOnly = (planSetExtractedText: string, extra: Record<string, unknown> = {}) => project({ planSetExtractedText, ...extra });

const profile = (over: Partial<JurisdictionCodeProfile> = {}): JurisdictionCodeProfile => ({
  key: "or|city of testport|unknown", state: "OR", ahj: "City of Testport", confidence: "seeded",
  adoptedCodes: [{ code: "ORSC", edition: "2023" }, { code: "OESC", edition: "2023" }, { code: "NEC", edition: "2023" }],
  amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
  researchedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});
const ctxFor = (over: Partial<JurisdictionCodeProfile> = {}) => buildCodeContext("OR", "City of Testport", profile(over));
const LIMIT24 = { prescriptive: { maxAttachmentSpacingIn: 24 } };
const ASKED = { prescriptive: { listingEvidenceRequired: true } };

const report = (p: ProjectRecord, over: Partial<JurisdictionCodeProfile> = LIMIT24): ReviewerFinding[] =>
  buildReviewerReport(p, { codeContext: ctxFor(over) }).findings;
const codeRules = (p: ProjectRecord, over: Partial<JurisdictionCodeProfile> = LIMIT24): ReviewerFinding[] =>
  evaluateDesignCodeFindings(p, null, ctxFor(over), [], []);
const get = (fs: ReviewerFinding[], id: string): ReviewerFinding | undefined => fs.find((f) => f.id === id);

const GROUND_SITE = "reviewer.plan.ground-array-site";
const LISTINGS = "city.plan.ul-listings-missing";
const SPACING_OVER = "city.struct.anchor-spacing-exceeds-ahj";
const FIRE_IDS = ["city.fire.pathways-missing", "reviewer.plan.fire-path"];
// Every rule a roof reading switches on that a ground array reads clear of — the four BLOCKERS the
// first version of this fix newly raised on a tie-band ground set among them (fire pathways, framing,
// rapid shutdown, the roof site plan).
const ROOF_ONLY_IDS = [...FIRE_IDS, "city.struct.framing-missing", "city.struct.attachment-detail-missing", "city.struct.span-table-incomplete", SPACING_OVER, "city.elec.rapid-shutdown-missing", "city.plan.site-roof-missing"];

// A rooftop set: the mount named on the cover, the notes and the attachment detail; rafters and
// flashing; ONE carport, drawn on the site plan as an existing structure. Inverter listings only.
const ROOF_WITH_STRAY_CARPORT = [
  "SOLAR PV SYSTEM - ROOF MOUNT",
  "(N) 20 PV MODULES ROOF-MOUNTED ON (E) COMPOSITION SHINGLE",
  "ROOF MOUNT RACKING: TEST RAIL ON L-FOOT WITH FLASHING",
  "ALL MODULES ARE ROOF MOUNTED FLUSH TO THE ROOF PLANE",
  "(E) 2X6 RAFTERS @ 24\" O.C.",
  "NEW PV ATTACHMENTS AT 4'-0\" O.C. INTO RAFTERS",
  "SITE PLAN: PROPERTY LINE  (E) DRIVEWAY  (E) CARPORT  (E) SHED  (E) RESIDENCE",
  "INVERTERS LISTED TO UL 1741.",
].join("\n");

// A ground set: the array named as a ground mount throughout, piers and a trench, a ground-mounted
// disconnect (equipment), and one template note that still says "roof mounted".
const GROUND_PLAN = [
  "SOLAR PV SYSTEM - GROUND MOUNT",
  "(N) 24 PV MODULES ON A FIXED-TILT GROUND MOUNT ARRAY",
  "GROUND MOUNT RACKING ON DRIVEN STEEL PIERS, SEE PIER DETAIL",
  "GROUND MOUNTED ARRAY SET BACK 10' FROM THE PROPERTY LINE",
  "(N) GROUND-MOUNTED AC DISCONNECT AT THE ARRAY",
  "UNDERGROUND FEEDER IN TRENCH, 24\" MIN. COVER",
  "ROOF MOUNTED CONDUIT: NONE",
  "INVERTERS LISTED TO UL 1741.",
].join("\n");

// A ground set in the TIE BAND: three ground-mount phrases against a general-notes template line that
// names a roof mount, roof penetrations and flashing — three roof words. Counted whole that was a tie,
// and the tie put a ground array on the roof rules. The notes line is boilerplate; the array is a
// ground mount.
const GROUND_PLAN_WITH_ROOF_NOTES = [
  "SOLAR PV SYSTEM - GROUND MOUNT",
  "GROUND MOUNT RACKING ON DRIVEN STEEL PIERS",
  "GROUND MOUNTED ARRAY SET BACK 10' FROM THE PROPERTY LINE",
  "GENERAL NOTES: ROOF MOUNTED SYSTEMS - ALL ROOF PENETRATIONS SHALL BE SEALED WITH FLASHING",
  "INVERTERS LISTED TO UL 1741.",
].join("\n");

// A carport set: the structure IS the array's mount.
const CARPORT_PLAN = [
  "(N) SOLAR CARPORT STRUCTURE - TWO BAYS",
  "PV MODULES MOUNTED ON THE NEW CARPORT",
  "CARPORT FOUNDATION: 24\" DIA. CONCRETE FOOTINGS",
  "INVERTERS LISTED TO UL 1741.",
].join("\n");

console.log("\n1. A ROOF PLAN WITH ONE INCIDENTAL CARPORT — THE ROOF RULES RUN");
const roofJob = textOnly(ROOF_WITH_STRAY_CARPORT);
check("MUST PASS: the predicate does not call it a carport (unknown = the roof rules)", () => {
  assert.notEqual(mountKindForProject(roofJob), "carport", "one site-plan 'CARPORT' outvoted seven roof-mount mentions and the rafters");
  assert.notEqual(mountKindForProject(roofJob), "ground");
  assert.equal(isRoofMounted(roofJob, designText(roofJob)), true);
});
check("MUST PASS: no ground-array callout; fire pathway and anchor spacing are reviewed", () => {
  const fs = report(roofJob);
  assert.ok(!get(fs, GROUND_SITE), "the roof job was told its roof access rules do not apply");
  assert.ok(FIRE_IDS.some((id) => get(fs, id)), "no fire-pathway review on a roof job");
  assert.ok(get(fs, SPACING_OVER), "48\" attachments against a 24\" limit were never checked — the spacing rule is roof-gated");
});
check("MUST PASS: the UL listing check runs, in the roof wording", () => {
  const f = get(report(roofJob), LISTINGS);
  assert.ok(f, "UL listing check did not run");
  assert.equal(f!.severity, "callout");
  assert.equal(f!.cityFeedback, "Provide UL listing for the panels, mounting and racking hardware.");
  assert.match(f!.message, /racking\/mounting listing \(UL 2703\)/);
  assert.doesNotMatch(f!.message, /ground|carport/i);
});
check("MUST PASS: the application never calls it carport-mounted", () => {
  assert.equal(mountAdjective(mountKindForProject(roofJob)), "", "text evidence writes no mount adjective (leak sweep 2026-09-28)");
});
check("MUST PASS: the same carport twice (site plan + a notes field) still loses to the roof evidence", () => {
  const p = textOnly(ROOF_WITH_STRAY_CARPORT, { sitePlanNotesText: "Site plan shows the driveway, an existing carport and a shed." });
  assert.equal(mountKindForProject(p), "unknown");
});
check("MUST PASS: a lone carport / canopy word, with nothing else, is not a carport array", () => {
  assert.equal(mountKindForProject(textOnly("SITE PLAN: (E) CARPORT")), "unknown");
  assert.equal(mountKindForProject(textOnly("(E) TREE CANOPY OVER (E) CARPORT")), "unknown", "a tree canopy is shading, not a structure");
  assert.equal(mountKindForProject(textOnly("SHADING: (E) TREE CANOPY. CANOPY OF EXISTING TREES TO REMAIN.")), "unknown");
});
check("MUST PASS: ground-mounted EQUIPMENT, an underground feeder and a negated ground mount are not a ground array", () => {
  assert.equal(mountKindForProject(textOnly("(N) GROUND-MOUNTED AC DISCONNECT NEXT TO THE METER")), "unknown");
  assert.equal(mountKindForProject(textOnly("UNDERGROUND ARRAY FEEDER TO THE MAIN PANEL")), "unknown");
  assert.equal(mountKindForProject(textOnly("THIS IS NOT A GROUND MOUNT")), "unknown");
});
check("MUST PASS: a roof plan with ONE stray ground-mount phrase keeps the roof rules", () => {
  const p = textOnly(`${ROOF_WITH_STRAY_CARPORT}\nSHEET PV-9: GROUND MOUNT DETAIL (N/A)`);
  assert.equal(mountKindForProject(p), "unknown", "one ground-mount phrase outvoted the roof evidence");
  assert.ok(!get(report(p), GROUND_SITE));
});
check("MUST PASS: a grounding instruction ('GROUND RACKING') is not a ground array", () => {
  // Bonding notes, not mount nouns: each of these read "ground" in the first version of this fix,
  // and a ground reading switches off every roof rule.
  for (const text of [
    "GROUND RACKING PER UL 2703",
    "EQUIPMENT GROUNDING: GROUND RACK RAILS W/ WEEB\nPV ON (E) COMP ROOF",
    "BOND AND GROUND RACKING\nGROUND RACKING RAILS\nROOF PLAN",
  ]) {
    const p = textOnly(text);
    assert.equal(mountKindForProject(p), "unknown", JSON.stringify(text));
    assert.equal(isRoofMounted(p, designText(p)), true, JSON.stringify(text));
    assert.equal(rapidShutdownApplies(p, designText(p)), true, JSON.stringify(text));
  }
  const fs = report(textOnly("EQUIPMENT GROUNDING: GROUND RACK RAILS W/ WEEB\nPV ON (E) COMP ROOF"));
  assert.ok(!get(fs, GROUND_SITE), "a grounding note made the roof job a ground array");
});
check("MUST PASS: the parser's own empty-field flag 'confirm roof mount vs ground mount' is a tie, and keeps the roof rules", () => {
  // A deliberate change (#533): this used to read "ground" and exempt the job from every roof rule.
  const p = project({ reviewFlags: "Confirm roof mount vs ground mount." });
  assert.equal(mountKindForProject(p), "unknown");
  assert.ok(!get(report(p), GROUND_SITE));
});

console.log("\n2. A REAL GROUND-MOUNT PLAN — GROUND, AND THE LISTING CHECK STILL RUNS");
const groundJob = textOnly(GROUND_PLAN);
check("MUST EXCLUDE: a ground plan reads ground (one template 'roof mounted' note does not outvote it)", () => {
  assert.equal(mountKindForProject(groundJob), "ground");
  assert.equal(rapidShutdownApplies(groundJob, designText(groundJob)), false);
});
check("MUST EXCLUDE: the ground-array callout fires and no roof-only rule does", () => {
  const fs = report(groundJob);
  assert.equal(get(fs, GROUND_SITE)?.severity, "callout");
  const leaked = ROOF_ONLY_IDS.filter((id) => get(fs, id));
  assert.deepEqual(leaked, [], `roof rules fired on a ground array: ${leaked.join(", ")}`);
});
check("MUST PASS: the UL listing check runs on a ground array, in ground-mount words", () => {
  const f = get(report(groundJob), LISTINGS);
  assert.ok(f, "a ground array's module and racking listings were never checked");
  assert.equal(f!.severity, "callout", "severity logic unchanged: callout unless the jurisdiction asked");
  assert.match(f!.message, /module listing \(UL 61730 or UL 1703\)/);
  assert.match(f!.message, /ground-mount racking listing \(UL 2703\)/);
  assert.match(f!.message, /A ground-mounted array needs listed modules and UL 2703 racking/);
  assert.equal(f!.cityFeedback, "Provide UL listing for the panels and the ground-mount racking and mounting hardware.");
  assert.match(f!.designTeamAction, /ground-mount racking UL 2703 listing/);
  assert.doesNotMatch(`${f!.cityFeedback} ${f!.designTeamAction}`, /\broof\b/i, "a ground array was asked about roof hardware");
});
check("MUST PASS: where the jurisdiction asked for listing evidence, the ground array's finding is a warning", () => {
  const f = get(codeRules(groundJob, ASKED), LISTINGS);
  assert.equal(f?.severity, "warning");
  assert.match(f!.message, /has asked for this listing evidence/);
});
check("MUST PASS: a mounting FIELD of 'Ground mount' gets the listing check too", () => {
  const f = get(codeRules(project({ mounting: "Ground mount", planSetExtractedText: "INVERTERS LISTED TO UL 1741." })), LISTINGS);
  assert.ok(f, "field-classified ground mount skipped the listing check");
  assert.match(f!.message, /ground-mount racking listing/);
});
check("MUST EXCLUDE: a ground array that states both listings gets no listing finding", () => {
  const p = textOnly(`${GROUND_PLAN}\nMODULES LISTED TO UL 61730. GROUND MOUNT RACKING LISTED TO UL 2703.`);
  assert.equal(mountKindForProject(p), "ground");
  assert.ok(!get(codeRules(p), LISTINGS));
});
check("MUST EXCLUDE: one ground-mount phrase with nothing on the roof side still reads ground", () => {
  assert.equal(mountKindForProject(textOnly("GROUND MOUNT ARRAY ON DRIVEN PIER FOUNDATION")), "ground");
});
check("MUST EXCLUDE (tie band): a roof-notes template line does not tie a ground set onto the roof rules", () => {
  const p = textOnly(GROUND_PLAN_WITH_ROOF_NOTES);
  assert.equal(mountKindForProject(p), "ground", "general-notes boilerplate outvoted three ground-mount phrases");
  const fs = report(p);
  assert.ok(get(fs, GROUND_SITE), "the ground-array callout did not fire");
  const leaked = ROOF_ONLY_IDS.filter((id) => get(fs, id));
  assert.deepEqual(leaked, [], `roof rules fired on a ground array: ${leaked.join(", ")}`);
  assert.match(get(fs, LISTINGS)?.message || "", /ground-mount racking listing \(UL 2703\)/, "the listing check still runs, in ground words");
});
check("MUST EXCLUDE (tie band): one ground-mount phrase beside a lone roof-plan sheet name reads ground", () => {
  assert.equal(mountKindForProject(textOnly("GROUND MOUNT ARRAY\nPV-2 ROOF PLAN")), "ground");
});
check("MUST PASS (tie band): one ground-mount phrase against one roof-mount phrase is a tie, and a tie keeps the roof rules", () => {
  assert.equal(mountKindForProject(textOnly("GROUND MOUNT ARRAY\nROOF MOUNT RACKING")), "unknown");
});

console.log("\n3. A REAL CARPORT PLAN — CARPORT, RAPID SHUTDOWN KEPT, LISTINGS CHECKED");
const carportJob = textOnly(CARPORT_PLAN);
check("MUST EXCLUDE: a carport plan reads carport", () => {
  assert.equal(mountKindForProject(carportJob), "carport");
  assert.equal(rapidShutdownApplies(carportJob, designText(carportJob)), true, "a carport keeps NEC 690.12");
  assert.ok(get(report(carportJob), GROUND_SITE));
});
check("MUST PASS: the carport's listing finding names the carport racking", () => {
  const f = get(report(carportJob), LISTINGS);
  assert.ok(f, "a carport array's listings were never checked");
  assert.match(f!.message, /carport racking\/mounting listing \(UL 2703\)/);
  assert.equal(f!.cityFeedback, "Provide UL listing for the panels and the carport's racking and mounting hardware.");
});
check("MUST EXCLUDE: a ground-mounted carport stays a carport (the stricter reading for rapid shutdown)", () => {
  assert.equal(mountKindForProject(textOnly("(N) GROUND-MOUNTED CARPORT ARRAY")), "carport");
  assert.equal(mountKindForProject(textOnly("(N) POLE-MOUNTED SOLAR CANOPY")), "carport");
});
check("MUST PASS: a ground array with one '(E) CARPORT' on its site plan is a ground array", () => {
  // One carport word is a structure on the site plan, beside a ground array as beside a roof one.
  const p = textOnly("GROUND MOUNT ARRAY ON DRIVEN PIERS\nSITE PLAN: (E) CARPORT");
  assert.equal(mountKindForProject(p), "ground");
  assert.equal(mountAdjective(mountKindForProject(p)), "Ground-mounted");
  assert.equal(rapidShutdownApplies(p, designText(p)), false);
});
check("MUST EXCLUDE: the mounting FIELD still answers alone (Carport / Canopy / Roof mount)", () => {
  assert.equal(mountKindForProject(project({ mounting: "Carport" })), "carport");
  assert.equal(mountKindForProject(project({ mounting: "Canopy" })), "carport");
  assert.equal(mountKindForProject(project({ mounting: "Roof mount", planSetExtractedText: CARPORT_PLAN })), "roof");
});

console.log(failures === 0
  ? "\nAll mount evidence-weighing checks passed."
  : `\n${failures} mount evidence-weighing check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
