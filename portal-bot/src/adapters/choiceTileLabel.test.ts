// A CHOICE TILE IS LABELLED BY ITS TITLE, AND THE TILE THAT NAMES THE JOB IS THE ONE TO CLICK.
//
// Portland DevHub (live, 2026-10-13, issue #315): "Apply For A Permit" leads to a page of ten
// cards — "Building Permit Request", "Solar Permit Request", "Trade Permits", … — each
// clickable as a whole, each carrying an information link inside. The learner saw the links,
// never the cards, and died "nothing fillable" on a page of plainly labelled choices.
//
// The browser-free half of the fix, pinned here:
//   - choiceTileLabel: the title's raw text becomes the label (whitespace collapsed, a trailing
//     arrow glyph dropped); a record-looking title (digits) or an advance / step-bar item is NOT
//     a choice and yields null.
//   - permitTypeCandidates on the captured page's titles: EVERY track picks "Solar Permit Request"
//     and nothing else. On main the electrical track picked nothing and the structural track
//     picked "Building Permit Request" — Portland's own tile says the solar request "includes the
//     Renewable Energy Electrical Permit", so both would have filed the wrong permit. The
//     record-type guard already rules "a solar/PV-specific type is always the right answer
//     wherever an AHJ offers one"; the chooser now agrees with it (one question, one predicate).
//   - The information link's own label is never a candidate on any track (rule 5's refusal of
//     an information page is unchanged — this only adds the tile beside it).
//
// The in-page structural scan (markChoiceTilesInPage) needs layout and is pinned by
// choiceTiles.dom.smoke.ts in real Chromium.
//
// Run: npx tsx portal-bot/src/adapters/choiceTileLabel.test.ts
import assert from "node:assert/strict";
import * as entry from "./applicationEntry";
import { permitTypeCandidates } from "./applicationEntry";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// The captured page's tile titles, verbatim (data/learn-runs/2026-10-13_21-18-04_city-of-portland_u1f4).
const PORTLAND_TILES = [
  "Building Permit Request",
  "New Single-Family Residence and/or New Detached Accessory Dwelling Unit Permit Request",
  "Solar Permit Request",
  "FCC Wireless Applications - Permit Request",
  "Demolition Permit Request",
  "Trade Permits",
  "Trade Permits with Plan Review - Permit Request",
  "Sign Permit Request",
  "Tree Permits",
];
// The information links inside the cards, as field discovery labelled them on the live run.
const PORTLAND_LINKS = [
  "New Single Family Residential permits",
  "See more information about Solar Permit requirements.",
  "See more information about Radio Frequency Transmission Facilities (Wireless) permits.",
  "See more information about demolitions.",
  "see more information about Trades Permits and see if your work requires plan review.",
  "See more information about Sign Permits.",
];

// Reached through the namespace so that, against main's file, this is a FAIL line and not a
// crash at import: the proof that the test bites is a banner, not a stack trace.
const choiceTileLabel = (entry as { choiceTileLabel?: (raw: string) => string | null }).choiceTileLabel;

check("THE LABEL: choiceTileLabel exists and a card's title text IS its label", () => {
  assert.equal(typeof choiceTileLabel, "function", "applicationEntry exports choiceTileLabel");
  assert.equal(choiceTileLabel!("Solar Permit Request"), "Solar Permit Request");
  assert.equal(choiceTileLabel!("\n\t Solar   Permit\n Request \t"), "Solar Permit Request", "whitespace collapsed");
  assert.equal(choiceTileLabel!("Solar Permit Request ›"), "Solar Permit Request", "a trailing arrow glyph is the affordance, not the name");
  assert.equal(choiceTileLabel!("Trade Permits →"), "Trade Permits");
});

check("the label is a KIND of thing: a record's title (digits), a step bar's item, a button face are null", () => {
  assert.equal(choiceTileLabel!("BP-2024-00123 — 123 Main St"), null, "a record number is a thing that exists, not a type");
  assert.equal(choiceTileLabel!("Permit 2026-0042"), null);
  assert.equal(choiceTileLabel!("Review and Submit"), null, "the step bar's last item");
  assert.equal(choiceTileLabel!("Review & Submit"), null);
  assert.equal(choiceTileLabel!("Next"), null);
  assert.equal(choiceTileLabel!("Continue"), null);
  assert.equal(choiceTileLabel!("Submit Application"), null);
  assert.equal(choiceTileLabel!("OK"), null);
  assert.equal(choiceTileLabel!("x"), null, "too short to be a title");
  // ...while a door worded with "submit" keeps its name: the exclusion lists decide what is
  // clickable, this only decides what is a tile.
  assert.equal(choiceTileLabel!("Submit a Request"), "Submit a Request");
  assert.equal(choiceTileLabel!("Apply For A Permit"), "Apply For A Permit");
});

check("THE DECISION: on the captured page EVERY track picks 'Solar Permit Request', alone", () => {
  for (const track of ["solar", "electrical", "structural"]) {
    const picked = permitTypeCandidates(PORTLAND_TILES, track);
    assert.deepEqual(picked, ["Solar Permit Request"], `${track} track picked ${JSON.stringify(picked)}`);
  }
});

check("...and the structural track does NOT take 'Building Permit Request' over it (that is a different permit)", () => {
  assert.equal(permitTypeCandidates(PORTLAND_TILES, "structural").includes("Building Permit Request"), false);
});

check("...and the electrical track does NOT take 'Trade Permits' (Portland files the solar electrical inside the solar request)", () => {
  assert.equal(permitTypeCandidates(PORTLAND_TILES, "electrical").includes("Trade Permits"), false);
});

check("MUST EXCLUDE: an information link beside a tile is never a candidate, on any track", () => {
  for (const track of ["solar", "electrical", "structural"]) {
    const picked = permitTypeCandidates([...PORTLAND_TILES, ...PORTLAND_LINKS], track);
    assert.deepEqual(picked, ["Solar Permit Request"], `${track}: ${JSON.stringify(picked)}`);
    for (const link of PORTLAND_LINKS) assert.equal(picked.includes(link), false, `picked the information link: ${link}`);
  }
});

check("the discipline vocabulary still decides where no solar-specific type exists", () => {
  const noSolar = ["Residential Building Permit", "Electrical Permit", "Fence Permit", "Look Up Record"];
  assert.deepEqual(permitTypeCandidates(noSolar, "electrical"), ["Electrical Permit"]);
  assert.deepEqual(permitTypeCandidates(noSolar, "structural"), ["Residential Building Permit"]);
  assert.deepEqual(permitTypeCandidates(noSolar, "solar"), [], "a NEM track has no second tier: nothing, rather than the nearest thing");
});

check("'renewable energy' names the job; a renewable-energy REBATE never does", () => {
  assert.deepEqual(permitTypeCandidates(["Renewable Energy Permit", "Fence Permit"], "electrical"), ["Renewable Energy Permit"]);
  assert.deepEqual(permitTypeCandidates(["Renewable Energy Rebate", "Solar Incentive Program", "Fence Permit"], "solar"), []);
});

check("two solar-named tiles stay AMBIGUOUS — the chooser reports both so the run can refuse and name them", () => {
  const two = permitTypeCandidates(["Residential Solar Permit - Roof Mount", "Residential Solar Permit - Ground Mount", "Electrical Permit"], "electrical");
  assert.equal(two.length, 2, JSON.stringify(two));
});

if (failures) { console.error(`\n${failures} choiceTileLabel check(s) FAILED.`); process.exit(1); }
console.log("\nAll choiceTileLabel checks passed.");
