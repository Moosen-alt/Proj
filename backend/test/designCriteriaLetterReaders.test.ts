// A PACKAGE WHOSE DOCUMENTS AGREE IS NEVER BLOCKED BY ONE READER'S WEAK READING OF ONE OF THEM (#312).
//
// Live intake 2026-10-13 (an Oregon city, engineered path): the reviewer gate raised two BLOCKERS the
// documents did not support, and no operator override exists, so a correct package could not be
// staged. Both came from how the structural letter's text layer was read:
//   1. its page 2 prints the design-criteria table's VALUES first and its LABELS last, with nothing
//      after the labels, and page 3 opens with a span table. extractPdfText joins pages with a
//      newline and readSources flattens it, so "Risk Category:" ran into "1 43 191.11 …" and read
//      Risk Category I against the plan set's II.
//   2. its governing-codes block is name-then-edition ("Oregon Electrical Specialty Code 2023
//      Oregon Fire Code 2025"); read year-first, the Fire Code took the Electrical Code's 2023
//      against the verified OFC 2025.
// And the rules that fire on them block only when EVERY reading of the quantity disagrees: a
// disagreement that rests on a weak reading lands as a callout naming it.
//
// Fixtures are the issue's scrubbed text (no names, addresses, firms or seals). No database, no LLM.
// Every MUST-PASS below fails on the reader before this change (the PR carries the banner).
//
// Run: npx tsx backend/test/designCriteriaLetterReaders.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import type { JurisdictionCodeProfile, ProjectRecord, ReviewerFinding, StatedDesignCriteria } from "../../shared/src/types";
import { buildCodeContext } from "../src/codeProfiles";
import { evaluateDesignCodeFindings } from "../src/codeReviewRules";
import { extractStatedDesignCriteria, type DesignTextSource } from "../src/designCriteria";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const CONFLICT = "city.struct.design-criteria-conflict";
const BASIS = "city.code.basis-mismatch";

const bare = { id: "letter-readers-test", parserSnapshot: {} } as unknown as ProjectRecord;
const read = (text: string, label = "Structural letter"): StatedDesignCriteria => extractStatedDesignCriteria(bare, [{ label, text }]);
const stated = (text: string, criterion: string): string[] =>
  [...new Set(read(text).criteria.filter((c) => c.criterion === criterion).map((c) => String(c.value)))].sort();
const codes = (text: string): string[] =>
  read(text).codeBasis.map((b) => `${b.code} ${b.edition}${b.baseCode ? ` (${b.baseCode} ${b.baseEdition})` : ""}`).sort();

const project = (snapshot: Record<string, unknown>): ProjectRecord => ({
  id: "letter-readers-project", state: "OR", ahj: "City of Testport", utility: "Test Power", homeownerName: "Test Owner",
  projectAddress: "1 Test St", interconnectionMethod: "Load-side breaker", parserSnapshot: { mounting: "Roof mount", ...snapshot },
} as unknown as ProjectRecord);
const profile = (over: Partial<JurisdictionCodeProfile>): JurisdictionCodeProfile => ({
  key: "or|city of testport|unknown", state: "OR", ahj: "City of Testport", confidence: "seeded",
  adoptedCodes: [], amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
  researchedAt: "2026-09-01T00:00:00.000Z", ...over,
});
const findings = (p: ProjectRecord, over: Partial<JurisdictionCodeProfile>, docs: DesignTextSource[]): ReviewerFinding[] =>
  evaluateDesignCodeFindings(p, null, buildCodeContext("OR", "City of Testport", profile(over)), [], docs);
const get = (fs: ReviewerFinding[], id: string): ReviewerFinding | undefined => fs.find((f) => f.id === id);

// The city's verified editions, in the shape of the live profile.
const VERIFIED_OR = {
  confidence: "verified" as const, verifiedBy: "operator", verifiedAt: "2026-10-01T00:00:00Z",
  adoptedCodes: [
    { code: "ORSC", edition: "2023" }, { code: "OSSC", edition: "2025" }, { code: "OESC", edition: "2023" },
    { code: "OFC", edition: "2025" }, { code: "NEC", edition: "2023" },
  ],
};

// ---------------------------------------------------------------------------------------
// Fixture 1 — the letter's page 2 (values, then labels with nothing after them) and page 3 (a
// span table), joined the way extractPdfText joins pages.
// ---------------------------------------------------------------------------------------
const LETTER_P2 = "Based on the information provided by the contractor, I, the engineer of record, have reviewed the roof framing. "
  + "C. Design Criteria 96 mph 74 mph C II 45.00 psf D. Factors Considered Exposure Factor (Ce) 1.000 Thermal Factor (Ct) 1.000 "
  + "Importance Factor (Is) 1.000 Ground Snow Load: Wind Speed (ult): Wind Speed (asd): Exposure: Risk Category:";
const LETTER_P3 = "1 43 191.11 41 194.38 191.11 1' X X X X X 2e 43 191.11 41 194.38 191.11";
const LETTER_CRITERIA = `${LETTER_P2}\n${LETTER_P3}`;
const PLAN_CRITERIA = "DESIGN CRITERIA: WIND SPEED = 96 MPH EXPOSURE CATEGORY = C GROUND SNOW LOAD = 45 PSF RISK CATEGORY = II";

console.log("1. a label with no value reads nothing — the next page's table is never its value");

check("MUST-PASS: the letter's risk category reads II or nothing — never the 1 that opens page 3's table, never the first-person I", () => {
  const risk = stated(LETTER_CRITERIA, "riskCategory");
  assert.ok(risk.every((v) => v === "II"), `read ${JSON.stringify(risk)}`);
  // The other labels on that row read nothing either: nothing follows them but another label.
  assert.deepEqual(stated(LETTER_CRITERIA, "groundSnowPsf"), []);
  assert.deepEqual(stated(LETTER_CRITERIA, "windExposure"), []);
});

check("MUST-PASS: plan set II + parser II + that letter -> no design-criteria conflict (and never 'I in Structural letter')", () => {
  const p = project({ riskCategory: "II", windSpeed: "96", wind: "C", snow: "45", planSetExtractedText: `${PLAN_CRITERIA}\n${LETTER_CRITERIA}` });
  const f = get(findings(p, VERIFIED_OR, [{ label: "Plan set", text: PLAN_CRITERIA }, { label: "Structural letter", text: LETTER_CRITERIA }]), CONFLICT);
  assert.equal(f, undefined, f?.message);
});

check("MUST-PASS: the same shape under every label reads nothing — 'Ground Snow Load:' then a table is not Pg 1, 'Exposure:' then a table is not Exposure C", () => {
  assert.deepEqual(stated("Ground Snow Load: Wind Speed (ult):\n1 43 191.11 41 194.38", "groundSnowPsf"), []);
  assert.deepEqual(stated("Ground Snow Load:\n1 43 191.11 41 194.38", "groundSnowPsf"), []);
  assert.deepEqual(stated("Wind Speed (ult): Exposure:\nC 43 191.11 41 194.38", "windExposure"), []);
  assert.deepEqual(stated("Risk Category:\n1' X X X X X 2e 43", "riskCategory"), []);
  assert.deepEqual(stated("Wind Speed (mph) 110 120 130", "windSpeedMph"), []);
});

check("MUST-EXCLUDE: a lone value is still the label's — a list marker, a unit, a year or a word after it is not a row of cells", () => {
  assert.deepEqual(stated("1. RISK CATEGORY: II 2. WIND SPEED = 110 MPH", "riskCategory"), ["II"]);
  assert.deepEqual(stated("EXPOSURE: C RISK CATEGORY: II 45.00 PSF GROUND SNOW LOAD", "riskCategory"), ["II"]);
  assert.deepEqual(stated("RISK CATEGORY: 2 2023 EDITION", "riskCategory"), ["II"]);
  assert.deepEqual(stated("DESIGN CRITERIA RISK CATEGORY: 2", "riskCategory"), ["II"]);
  assert.deepEqual(stated("GROUND SNOW LOAD: 25 WIND SPEED: 110 MPH", "groundSnowPsf"), ["25"]);
  assert.deepEqual(stated("GROUND SNOW LOAD = 25 PSF 2. WIND SPEED = 110 MPH", "groundSnowPsf"), ["25"]);
  assert.deepEqual(stated("WIND SPEED: 110 2. GROUND SNOW LOAD = 25 PSF", "windSpeedMph"), ["110"]);
  assert.deepEqual(stated("EXPOSURE CATEGORY: C 2. GROUND SNOW LOAD = 25 PSF", "windExposure"), ["C"]);
});

// ---------------------------------------------------------------------------------------
// Fixture 2 — the letter's name-then-edition governing-codes block, and the plan set's year-first one.
// ---------------------------------------------------------------------------------------
const LETTER_CODES = "B. Governing Codes Oregon Residential Specialty Code 2023 Oregon Electrical Specialty Code 2023 Oregon Fire Code 2025 "
  + "Oregon Structural Specialty Code 2025 All Local City and County Ordinances, National Electrical Code 2023 (NEC) ASCE 7-16";
const PLAN_CODES = "GOVERNING CODES: · 2023 OREGON RESIDENTIAL SPECIALTY CODE · 2025 OREGON STRUCTURAL SPECIALTY CODE · 2023 OREGON ELECTRICAL SPECIALTY CODE "
  + "· 2025 OREGON FIRE CODE · 2023 NATIONAL ELECTRICAL CODE";
const FIVE = ["NEC 2023", "OESC 2023", "OFC 2025", "ORSC 2023", "OSSC 2025"];

console.log("2. editions bind to the name they follow when the block is name-then-edition");

check("MUST-PASS: the letter's block reads ORSC 2023, OESC 2023, OFC 2025, OSSC 2025, NEC 2023 — the Fire Code takes the 2025 after it", () => {
  assert.deepEqual(codes(LETTER_CODES), FIVE);
});

check("MUST-PASS: the plan set's year-first block still reads as today — the same five", () => {
  assert.deepEqual(codes(PLAN_CODES), FIVE);
});

check("MUST-PASS: one predicate for names and abbreviations — a mixed block pairs each code with its own year", () => {
  assert.deepEqual(codes("CODES: IRC 2021 Oregon Fire Code 2025"), ["IRC 2021", "OFC 2025"]);
  assert.deepEqual(codes("CODES: 2021 IRC 2025 Oregon Fire Code"), ["IRC 2021", "OFC 2025"]);
  assert.deepEqual(codes("Design codes: Oregon Residential Specialty Code, 2023 Edition (2021 IRC); Oregon Fire Code, 2022 Edition"), ["OFC 2022", "ORSC 2023 (IRC 2021)"]);
});

check("MUST-EXCLUDE: a 'CODE:' heading never opens a run — a year-first block after 'BUILDING CODE:' keeps its years", () => {
  assert.deepEqual(codes("BUILDING CODE: 2023 OREGON RESIDENTIAL SPECIALTY CODE 2025 OREGON FIRE CODE"), ["OFC 2025", "ORSC 2023"]);
  assert.deepEqual(codes("GOVERNING CODES: 2019 CHICAGO BUILDING CODE 2018 CHICAGO ELECTRICAL CODE"), ["CBC 2019", "CEC 2018"]);
});

check("MUST-PASS: the shapes the abbreviation reader always paired still read — a dash or a colon between a code and its year, and a cut-off run keeps its first pairs", () => {
  assert.deepEqual(codes("GOVERNING CODES: IRC-2021, NEC-2020"), ["IRC 2021", "NEC 2020"]);
  assert.deepEqual(codes("GOVERNING CODES: NEC: 2020, IRC: 2021"), ["IRC 2021", "NEC 2020"]);
  // Opens with a code, closes with a code: the first pairs stand (weak), the yearless OFC reads nothing.
  assert.deepEqual(codes("CODES: ORSC 2023 OESC 2023 OFC"), ["OESC 2023", "ORSC 2023"]);
  assert.deepEqual(codes("APPLICABLE CODES: NFPA 70-2020"), []);
});

check("MUST-PASS: verified OR profile + year-first plan + name-first letter -> no basis-mismatch (the letter agrees with the profile)", () => {
  const p = project({ planSetExtractedText: `${PLAN_CODES}\n${LETTER_CODES}` });
  const f = get(findings(p, VERIFIED_OR, [{ label: "Plan set", text: PLAN_CODES }, { label: "Structural letter", text: LETTER_CODES }]), BASIS);
  assert.equal(f, undefined, f?.message);
});

// ---------------------------------------------------------------------------------------
// 3. The rules block only when every reading disagrees; a weak reading lands as a callout.
// ---------------------------------------------------------------------------------------
console.log("3. a conflict that rests on a weak reading is a callout naming it, never a blocker");

check("MUST-PASS: an ambiguous block ('2023 OREGON FIRE CODE 2025') vs verified OFC 2025 -> callout naming the weak reading, not a blocker", () => {
  const letter = "Governing Codes 2023 OREGON FIRE CODE 2025";
  const f = get(findings(project({}), VERIFIED_OR, [{ label: "Structural letter", text: letter }]), BASIS);
  assert.ok(f, "the reading still surfaces");
  assert.equal(f!.severity, "callout", f!.message);
  assert.match(f!.message, /weak reading/);
  assert.match(f!.message, /Structural letter/);
  assert.equal(f!.installerCallout, false, "a weak reading never asks the installer to change the plan");
});

check("MUST-PASS: not every reading disagrees — the plan set's OFC 2025 matches the profile, so the letter's OFC 2022 is a callout naming the agreeing sheet", () => {
  const letter = "Governing Codes Oregon Fire Code 2022";
  const fs = findings(project({}), VERIFIED_OR, [{ label: "Plan set", text: "GOVERNING CODES: · 2025 OREGON FIRE CODE" }, { label: "Structural letter", text: letter }]);
  const f = get(fs, BASIS);
  assert.ok(f, "the disagreement still surfaces");
  assert.equal(f!.severity, "callout", f!.message);
  assert.match(f!.message, /Plan set \(OFC 2025\)/);
  // Control: every reading disagrees (the letter alone, surely stating 2022) -> the verified mismatch still BLOCKS.
  const alone = get(findings(project({}), VERIFIED_OR, [{ label: "Structural letter", text: letter }]), BASIS);
  assert.equal(alone?.severity, "blocker", alone?.message);
});

check("MUST-PASS: a design-criteria conflict that rests on one document's weak reading is a CALLOUT naming the weak reading", () => {
  // The plan's list reads both ways (Pg 36 value-first, Pg 25 label-first); the letter surely states 25.
  const fs = findings(project({}), VERIFIED_OR, [
    { label: "Plan set", text: "DESIGN LOADS 36 PSF GROUND SNOW 25 PSF" },
    { label: "Structural letter", text: "GROUND SNOW LOAD = 25 PSF" },
  ]);
  const f = get(fs, CONFLICT);
  assert.ok(f, "the disagreement still surfaces");
  assert.equal(f!.severity, "callout", f!.message);
  assert.match(f!.message, /36 psf in Plan set \[only one way of reading an unseparated load list\]/);
  assert.match(f!.message, /weak reading of Plan set/);
  // Control: two documents that SURELY disagree keep the BLOCKER.
  const two = get(findings(project({}), VERIFIED_OR, [
    { label: "Plan set", text: "GROUND SNOW LOAD = 36 PSF" },
    { label: "Structural letter", text: "GROUND SNOW LOAD = 25 PSF" },
  ]), CONFLICT);
  assert.equal(two?.severity, "blocker", two?.message);
});

check("MUST-PASS: a document that states BOTH values does not disagree with the other — not a blocker", () => {
  const f = get(findings(project({}), VERIFIED_OR, [
    { label: "Plan set", text: "S-1 GROUND SNOW LOAD = 25 PSF. S-2 GROUND SNOW LOAD = 36 PSF" },
    { label: "Structural letter", text: "GROUND SNOW LOAD = 36 PSF" },
  ]), CONFLICT);
  assert.ok(f, "the plan's own inconsistency is still reported");
  assert.notEqual(f!.severity, "blocker", f!.message);
  assert.match(f!.message, /one document states more than one value/);
});

// ---------------------------------------------------------------------------------------
// 4. Follow-up to #313 (#314): three governing-codes shapes the one pairing read worse than the
// readers before it. Each row is the issue's text with "GOVERNING CODES:" in front, and reads
// what it read before #313: the same names, the same editions, and SURE (a mismatch through it
// blocks against a verified profile).
// ---------------------------------------------------------------------------------------
console.log("4. a code name keeps its stopwords and its title colon, and a yearless name takes no year");

const GOV = (s: string): string => `GOVERNING CODES: ${s}`;
/** "<code> <edition> sure|weak" per entry read: each code is checked alone against a VERIFIED
 *  profile recording it at another edition, where a sure reading blocks and a weak one is a callout. */
const readings = (text: string): string[] => read(text).codeBasis.map((b) => {
  const f = get(findings(project({}), { ...VERIFIED_OR, adoptedCodes: [{ code: b.code, edition: "1999" }] }, [{ label: "Structural letter", text }]), BASIS);
  return `${b.code} ${b.edition} ${f?.severity === "blocker" ? "sure" : "weak"}`;
}).sort();

// Table 1: a stopword inside the name ("CITY OF", "TOWN OF", "STATE OF", "POOL AND SPA").
const STOPWORD_ROWS: Array<[string, string[]]> = [
  ["2023 CITY OF LOS ANGELES BUILDING CODE 2020 CITY OF LOS ANGELES ELECTRICAL CODE", ["CLABC 2023 sure", "CLAEC 2020 sure"]],
  ["· 2021 TOWN OF TESTPORT BUILDING CODE · 2020 NATIONAL ELECTRICAL CODE", ["NEC 2020 sure", "TTBC 2021 sure"]],
  ["2021 INTERNATIONAL RESIDENTIAL CODE 2021 INTERNATIONAL BUILDING CODE 2021 INTERNATIONAL SWIMMING POOL AND SPA CODE 2020 NATIONAL ELECTRICAL CODE 2021 INTERNATIONAL FIRE CODE",
    ["IBC 2021 sure", "IFC 2021 sure", "IRC 2021 sure", "ISPSC 2021 sure", "NEC 2020 sure"]],
  ["2021 STATE OF WASHINGTON RESIDENTIAL CODE 2020 NATIONAL ELECTRICAL CODE", ["NEC 2020 sure", "SWRC 2021 sure"]],
  // The same names printed in title case.
  ["2023 City of Los Angeles Building Code 2020 City of Los Angeles Electrical Code", ["CLABC 2023 sure", "CLAEC 2020 sure"]],
];
// Table 2: a title whose CODE is followed by a colon.
const COLON_ROWS: Array<[string, string[]]> = [
  ["2018 NORTH CAROLINA STATE BUILDING CODE: RESIDENTIAL CODE", ["NCSBC 2018 sure"]],
  ["2021 INTERNATIONAL RESIDENTIAL CODE: SECTION R324 2017 NATIONAL ELECTRICAL CODE: ARTICLE 690", ["IRC 2021 sure", "NEC 2017 sure"]],
  ["2021 INTERNATIONAL RESIDENTIAL CODE: SECTION R324", ["IRC 2021 sure"]],
];
// Table 3: a name with no year of its own (the first row has no header).
const YEARLESS_ROWS: Array<[string, string[]]> = [
  ["ALL WORK PER THE BUILDING CODE 2020 NATIONAL ELECTRICAL CODE", ["NEC 2020 sure"]],
  [GOV("LOCAL FIRE CODE 2021 IRC 2020 NEC"), ["IRC 2021 sure", "NEC 2020 sure"]],
];

for (const [text, want] of STOPWORD_ROWS) {
  check(`MUST-PASS: a stopword inside a year-first name keeps the name whole — "${text.slice(0, 60)}…" reads ${want.join(", ")}`, () => {
    assert.deepEqual(readings(GOV(text)), want);
  });
}

check("MUST-PASS: a correct LA package against a verified LABC 2023 raises no basis-mismatch (it was a BLOCKER: \"plan states LABC 2020\")", () => {
  const f = get(findings(project({}), { ...VERIFIED_OR, adoptedCodes: [{ code: "LABC", edition: "2023" }] }, [{ label: "Plan set", text: GOV(STOPWORD_ROWS[0][0]) }]), BASIS);
  assert.equal(f, undefined, f?.message);
});

check("MUST-PASS: the five-code list against a verified IFC 2018 still blocks on the plan's IFC 2021 (the IFC was dropped)", () => {
  const f = get(findings(project({}), { ...VERIFIED_OR, adoptedCodes: [{ code: "IFC", edition: "2018" }] }, [{ label: "Plan set", text: GOV(STOPWORD_ROWS[2][0]) }]), BASIS);
  assert.equal(f?.severity, "blocker", f?.message ?? "no finding");
  assert.match(f!.message, /IFC 2021/);
});

for (const [text, want] of COLON_ROWS) {
  check(`MUST-PASS: a title whose CODE is followed by a colon reads — "${text.slice(0, 60)}…" reads ${want.join(", ")}`, () => {
    assert.deepEqual(readings(GOV(text)), want);
  });
}

check("MUST-PASS: 'CODE: SECTION' / 'CODE: ARTICLE' against a verified NEC 2020 blocks on the plan's NEC 2017 (a false negative before)", () => {
  const f = get(findings(project({}), { ...VERIFIED_OR, adoptedCodes: [{ code: "NEC", edition: "2020" }] }, [{ label: "Plan set", text: GOV(COLON_ROWS[1][0]) }]), BASIS);
  assert.equal(f?.severity, "blocker", f?.message ?? "no finding");
});

for (const [text, want] of YEARLESS_ROWS) {
  check(`MUST-PASS: a name with no year of its own takes no other item's year — "${text}" reads ${want.join(", ")}`, () => {
    assert.deepEqual(readings(text), want);
  });
}

check("MUST-PASS: all-caps prose before a name-first name is not part of it — 'SHALL CONFORM TO CHICAGO ELECTRICAL CODE 2018' is CEC 2018", () => {
  assert.deepEqual(codes("SHALL CONFORM TO CHICAGO ELECTRICAL CODE 2018"), ["CEC 2018"]);
  assert.deepEqual(codes(GOV("ALL WORK SHALL CONFORM TO CHICAGO ELECTRICAL CODE 2018")), ["CEC 2018"]);
});

check("MUST-EXCLUDE: the heading, placard and conjunction shapes keep reading as #313 made them", () => {
  assert.deepEqual(codes("BUILDING CODE: 2023 ORSC 2025 OFC"), ["OFC 2025", "ORSC 2023"]);
  assert.deepEqual(codes("Design Criteria Code: 2021 WSBC, 2021 WSRC"), ["WSBC 2021", "WSRC 2021"]);
  assert.deepEqual(codes("ELECTRICAL CODE: NEC 2020 BUILDING CODE: IRC 2021"), ["IRC 2021", "NEC 2020"]);
  assert.ok(!codes("NEC: 2020 PER CODE: NEC 690.54").some((c) => c.startsWith("PC ")), "no code named PC");
  // "AND" between two names joins no name: never a code named "ORSCAOSSC".
  assert.deepEqual(codes(GOV("2023 OREGON RESIDENTIAL SPECIALTY CODE AND OREGON STRUCTURAL SPECIALTY CODE 2023")), ["ORSC 2023", "OSSC 2023"]);
  assert.deepEqual(codes("OREGON RESIDENTIAL SPECIALTY CODE AND OREGON STRUCTURAL SPECIALTY CODE 2023"), ["OSSC 2023"]);
  assert.deepEqual(codes(GOV("2023 ORSC AND 2025 OSSC")), ["ORSC 2023", "OSSC 2025"]);
  assert.deepEqual(codes(GOV("2023 EDITION OF THE OREGON RESIDENTIAL SPECIALTY CODE")), ["ORSC 2023"]);
  assert.deepEqual(codes(GOV("IRC 2021 AND NATIONAL ELECTRICAL CODE 2020")), ["IRC 2021", "NEC 2020"]);
  // Name-first, the year before the second "CITY OF" is the FIRST code's: both names read as #313 read them.
  assert.deepEqual(codes(GOV("CITY OF LOS ANGELES BUILDING CODE 2023 CITY OF LOS ANGELES ELECTRICAL CODE 2020")), ["LABC 2023", "LAEC 2020"]);
  // A cut-off name-first letter still reads its first pairs.
  assert.deepEqual(codes(GOV("Oregon Fire Code 2025 Oregon Structural Specialty Code 2025 Oregon Electrical Specialty Code")), ["OFC 2025", "OSSC 2025"]);
});

if (failures) {
  console.error(`\n${failures} letter-reader check(s) FAILED`);
  process.exit(1);
}
console.log("\nall letter-reader checks passed");
