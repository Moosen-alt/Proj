// THE CODE BASIS IS THE PLAN'S OWN CODE BLOCK, NEVER AN AHJ CHECKLIST EMBEDDED IN THE PACKAGE (#559).
//
// Owner's Saratoga Springs, UT job (2026-11-03): the gate blocked a correct plan on "the plan states
// NEC 2015". The plan's GOVERNING CODES block said NEC 2023; the string came from the city's retired
// solar checklist, embedded as a page of the plan-set PDF: "designed to the 201 7 [OCR split] National
// Electrical Code (NEC) and the 2015 International Codes". Three things went wrong:
//   1. "(NEC) and the 2015": RUN_GLUE took "and the" as list glue past the closing parenthesis and
//      paired the NEC with the International Codes' year.
//   2. A spelled-out code name was read ANYWHERE, so a checklist's sentence counted as the plan's
//      statement (unsplit, the same page reads "NEC 2017" and blocks just the same).
//   3. The blocker named the city's design-criteria page (its /213 URL) as the source of editions the
//      city inherits from Utah's statewide layer.
// Fixtures are SYNTHETIC: an invented city, invented URLs, no names or addresses.
//
//   npx tsx backend/test/codeBasisEmbeddedChecklist.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectRecord, ReviewerFinding } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "code-basis-checklist-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.BACKUP_DIR = path.join(tmp, "backups");
process.env.CODE_RESEARCH = "off";

const { openDatabase } = await import("../src/db");
const CP = await import("../src/codeProfiles");
const { extractStatedDesignCriteria } = await import("../src/designCriteria");
const { evaluateDesignCodeFindings } = await import("../src/codeReviewRules");

const db = await openDatabase();
let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const ST = "UT";
const AHJ = "Testvale City";
const STATE_URL = "https://codes.example.gov/ut/state-construction-code";
const CITY_DC_URL = "https://testvale.example.gov/213/Design-Criteria";
const BASIS = "city.code.basis-mismatch";

// Utah's statewide layer (verified) and the city's own row (verified, design criteria only): the city
// inherits every edition from the state.
CP.saveVerifiedCodeProfile(db, {
  key: "", state: ST, ahj: "", confidence: "verified",
  adoptedCodes: [
    { code: "IRC", edition: "2021", sourceUrl: STATE_URL },
    { code: "NEC", edition: "2023", sourceUrl: STATE_URL },
    { code: "IFC", edition: "2021", sourceUrl: STATE_URL },
  ],
  amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
}, "state-reviewer");
CP.saveVerifiedCodeProfile(db, {
  key: "", state: ST, ahj: AHJ, confidence: "verified", adoptedCodes: [],
  amendments: [], designCriteria: { groundSnowPsf: 30, windSpeedMph: 115, sourceUrl: CITY_DC_URL }, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
}, "city-reviewer");
const ctx = CP.resolveEffectiveCodeContext(db, ST, AHJ);

const project = (text: string): ProjectRecord => ({
  id: "code-basis-checklist", state: ST, ahj: AHJ, utility: "Test Power", homeownerName: "Test Owner", projectAddress: "1 Test St",
  parserSnapshot: { mounting: "Roof mount", planSetExtractedText: text },
} as unknown as ProjectRecord);

const cover = (nec: string): string => `SHEET PV-1 COVER SHEET GOVERNING CODES: ${nec} NATIONAL ELECTRICAL CODE (NEC), 2021 INTERNATIONAL RESIDENTIAL CODE (IRC), 2021 INTERNATIONAL FIRE CODE (IFC). SYSTEM SIZE: 8.2 KW DC.`;
const OTHER_SHEETS = "SHEET PV-2 SITE PLAN ROOF ACCESS PATHWAY 36 IN FROM RIDGE. ALL CONDUIT RUNS IN ATTIC WHERE POSSIBLE. SHEET PV-3 ELECTRICAL LINE DIAGRAM 10 AWG THWN-2 IN 3/4 IN EMT. SHEET PV-4 PLACARDS AND LABELS.";
// The city's retired checklist, as OCR reads it ("201 7") and as a clean text layer would.
const CHECKLIST_SPLIT = "RESIDENTIAL SOLAR PHOTOVOLTAIC CHECKLIST All residential solar systems are to be designed to the 201 7 National Electrical Code (NEC) and the 2015 International Codes. Provide a site plan and a one-line diagram.";
const CHECKLIST_CLEAN = CHECKLIST_SPLIT.replace("201 7", "2017");
const pkg = (nec: string, checklist: string): string => `${cover(nec)} ${OTHER_SHEETS} ${checklist}`;

const basis = (text: string): string[] => extractStatedDesignCriteria(project(text)).codeBasis.map((b) => `${b.code} ${b.edition}`).sort();
const findings = (text: string): ReviewerFinding[] => evaluateDesignCodeFindings(project(text), null, ctx, [], []);
const get = (fs: ReviewerFinding[], id: string): ReviewerFinding | undefined => fs.find((f) => f.id === id);

console.log("1. the embedded checklist is not the plan's code basis");

check("the layered context reads Utah's verified NEC 2023 as inherited by the city", () => {
  assert.equal(ctx.verified, true);
  const nec = ctx.adoptedCodes.find((c) => c.code === "NEC");
  assert.equal(nec?.edition, "2023");
  assert.equal(nec?.inheritedFrom, "state");
});

for (const [name, checklist] of [["OCR-split", CHECKLIST_SPLIT], ["clean", CHECKLIST_CLEAN]] as const) {
  check(`MUST-PASS: a NEC 2023 plan carrying the ${name} checklist reads only the plan's block — no NEC 2015, no NEC 2017`, () => {
    assert.deepEqual(basis(pkg("2023", checklist)), ["IFC 2021", "IRC 2021", "NEC 2023"]);
  });
  check(`MUST-PASS: the same correct plan with the ${name} checklist raises no basis-mismatch against the verified NEC 2023`, () => {
    const f = get(findings(pkg("2023", checklist)), BASIS);
    assert.equal(f, undefined, f?.message);
  });
}

check("MUST-PASS: a checklist page whose text follows the cover's block directly (abbreviations too) never extends the block", () => {
  for (const checklist of [CHECKLIST_SPLIT, CHECKLIST_CLEAN, CHECKLIST_CLEAN.replace("National Electrical Code (NEC)", "NEC")]) {
    assert.deepEqual(basis(`${cover("2023")} ${checklist}`), ["IFC 2021", "IRC 2021", "NEC 2023"], checklist);
  }
});

check("MUST-PASS: the checklist alone states no code basis at all", () => {
  assert.deepEqual(basis(CHECKLIST_SPLIT), []);
  assert.deepEqual(basis(CHECKLIST_CLEAN), []);
});

console.log("2. glue never pairs a code with a year across a closing parenthesis or a sentence");

check("MUST-EXCLUDE: '(NEC) and the 2015' inside a governing-codes block pairs nothing with 2015", () => {
  assert.deepEqual(basis("GOVERNING CODES: NATIONAL ELECTRICAL CODE (NEC) AND THE 2015 INTERNATIONAL CODES"), []);
  assert.deepEqual(basis("GOVERNING CODES: National Electrical Code (NEC) and the 2015 International Codes"), []);
});

check("MUST-EXCLUDE: a sentence end parts a name from the next sentence's year", () => {
  assert.deepEqual(basis("GOVERNING CODES: NATIONAL ELECTRICAL CODE. THE 2015 INTERNATIONAL CODES ARE RETIRED."), []);
});

check("MUST-PASS: punctuation after a parenthetical is still list glue", () => {
  assert.deepEqual(basis("GOVERNING CODES: · 2023 OREGON ELECTRICAL SPECIALTY CODE (NEC 2020) · 2022 OREGON FIRE CODE"), ["OESC 2023", "OFC 2022"]);
  assert.deepEqual(basis("GOVERNING CODES: 2021 INTERNATIONAL RESIDENTIAL CODE (IRC) AND 2020 NATIONAL ELECTRICAL CODE (NEC)"), ["IRC 2021", "NEC 2020"]);
});

check("MUST-PASS: a genuine block's own 'and' / 'the' glue (no parenthesis before it) still reads every entry", () => {
  assert.deepEqual(basis("GOVERNING CODES: 2021 INTERNATIONAL RESIDENTIAL CODE AND THE 2023 NATIONAL ELECTRICAL CODE"), ["IRC 2021", "NEC 2023"]);
  assert.deepEqual(basis("GOVERNING CODES: THE 2023 EDITION OF THE NATIONAL ELECTRICAL CODE AND THE 2021 INTERNATIONAL FIRE CODE"), ["IFC 2021", "NEC 2023"]);
  assert.deepEqual(basis("GOVERNING CODES: IRC 2021 AND NATIONAL ELECTRICAL CODE 2023"), ["IRC 2021", "NEC 2023"]);
  assert.deepEqual(basis("GOVERNING CODES: 2021 IRC (R324) · 2023 NEC AND 2021 IFC"), ["IFC 2021", "IRC 2021", "NEC 2023"]);
});

console.log("3. a spelled-out name counts only inside a code-basis block");

check("MUST-EXCLUDE: a name in a sentence of prose outside any block reads nothing", () => {
  assert.deepEqual(basis("ALL WORK SHALL CONFORM TO THE 2017 NATIONAL ELECTRICAL CODE AND LOCAL AMENDMENTS."), []);
});

check("MUST-PASS: a headerless LIST of names on a cover sheet is a block", () => {
  assert.deepEqual(basis("2021 INTERNATIONAL RESIDENTIAL CODE · 2023 NATIONAL ELECTRICAL CODE · 2021 INTERNATIONAL FIRE CODE SYSTEM SIZE: 8 KW"), ["IFC 2021", "IRC 2021", "NEC 2023"]);
});

check("MUST-PASS: a name directly after a '… Code:' label is a block; a placard's 'PER CODE:' is not", () => {
  assert.deepEqual(basis("Electrical Code: National Electrical Code 2023 Risk Category: II"), ["NEC 2023"]);
  assert.deepEqual(basis("PER CODE: NATIONAL ELECTRICAL CODE 2017 ARTICLE 690"), []);
});

console.log("4. the blocker names the row the edition came from");

check("MUST-PASS: a NEC 2020 plan still BLOCKS on the verified state edition, and the message names Utah's state row and its source — never the city's design-criteria page", () => {
  const f = get(findings(pkg("2020", CHECKLIST_SPLIT)), BASIS);
  assert.equal(f?.severity, "blocker", f?.message ?? "no finding");
  assert.match(f!.message, /plan states NEC 2020/);
  assert.doesNotMatch(f!.message, /NEC 2015|NEC 2017/);
  assert.match(f!.message, /UT state-level code profile \(human-verified by state-reviewer/);
  assert.ok(f!.message.includes(STATE_URL), f!.message);
  assert.ok(!f!.message.includes(CITY_DC_URL), f!.message);
  assert.ok(!f!.message.includes(`${AHJ} (UT) code profile`), f!.message);
  assert.match(f!.message, new RegExp(`for NEC 2023, inherited by ${AHJ}`));
});

check("MUST-PASS: a city edition of its own still names the city row", () => {
  const own = CP.buildCodeContext(ST, AHJ, { ...ctx.profile!, adoptedCodes: [{ code: "NEC", edition: "2023" }], fieldSources: undefined });
  const f = get(evaluateDesignCodeFindings(project(cover("2020")), null, own, [], []), BASIS);
  assert.ok(f, "no finding");
  assert.match(f!.message, new RegExp(`Profile: ${AHJ} \\(UT\\) code profile`));
});

if (failures) {
  console.error(`\n${failures} code-basis checklist check(s) FAILED`);
  process.exit(1);
}
console.log("\nall code-basis checklist checks passed");
