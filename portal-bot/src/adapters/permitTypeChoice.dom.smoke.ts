// WHICH PERMIT TO FILE — CHOSEN BY A LOOKUP, NOT BY AN LLM, AND NEVER GUESSED.
//
// permiteyes.us answers "New Application" with a menu of ~50 permit types. Handing that page
// to the field planner cost 16.6k input tokens and 7-8k output PER CALL at 25-96 seconds
// each, hit the 8192-token ceiling once and returned unparseable JSON, and two learn runs
// were cut off mid-page with nothing saved. Fifty permit types is fifty navigation
// candidates; an LLM is the wrong instrument for a lookup.
//
// It is also the wrong instrument for the DECISION. Filing the wrong permit type is worse
// than filing nothing, and this project has already shipped a Residential Mechanical permit
// on a solar job and learned a Permit EXTENSION Request as if it were a new permit. So the
// refusals below matter more than the matches.
//   npx tsx portal-bot/src/adapters/permitTypeChoice.dom.smoke.ts
import assert from "node:assert/strict";
import { permitTypeCandidates } from "./applicationEntry";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// permiteyes.us's real menu, as the failing run reported it.
const MENU = [
  "Abandoned / Foreclosed Property",
  "Accessory Dwelling Unit",
  "Certificate Of Inspection",
  "Commercial Building Permit",
  "Commercial Pool Permit",
  "Commercial Solar Permit",
  "Electrical Permit",
  "Fence Permit",
  "Fire Sprinkler System",
  "Residential Building Permit",
  "Residential Solar Permit",
  "Smoke Detector Permit",
  "Look Up Record",
];

const solar = permitTypeCandidates(MENU, "solar");
console.log(`   solar track picks: ${JSON.stringify(solar)}`);

check("THE DECISION: a NEM/solar track picks the RESIDENTIAL solar permit, alone",
  solar.length === 1 && solar[0] === "Residential Solar Permit", JSON.stringify(solar));

check("...and never the COMMERCIAL twin, which matches 'solar' just as well",
  !solar.includes("Commercial Solar Permit"),
  "choosing between residential and commercial by position is how the wrong permit gets filed");

// THE JOB OUTRANKS THE DISCIPLINE (#315). This menu offers a solar-specific type, and that is
// the right answer on every track: the record-type guard (autoLearnAdapter, RECORD_TYPE_LABEL)
// has always ruled "a solar/PV-specific type is always allowed: that IS the right answer
// wherever an AHJ offers one", and Portland DevHub says so in its own words — "The new Solar
// Permit Request includes the Renewable Energy Electrical Permit". Before this, the electrical
// track took "Electrical Permit" and the structural track "Residential Building Permit" from
// this very menu, and on Portland's tiles the one found nothing and the other took "Building
// Permit Request": a different permit. The discipline vocabulary is the SECOND tier, pinned
// right after.
const electrical = permitTypeCandidates(MENU, "electrical");
check("an electrical track picks the residential SOLAR permit where the AHJ offers one",
  electrical.length === 1 && electrical[0] === "Residential Solar Permit", JSON.stringify(electrical));

const structural = permitTypeCandidates(MENU, "structural");
check("a structural track picks the residential SOLAR permit too — not the building one, not the commercial one",
  structural.length === 1 && structural[0] === "Residential Solar Permit", JSON.stringify(structural));

const NO_SOLAR_MENU = MENU.filter((t) => !/solar/i.test(t));
const electricalNoSolar = permitTypeCandidates(NO_SOLAR_MENU, "electrical");
check("with no solar type on offer, an electrical track picks the electrical permit",
  electricalNoSolar.length === 1 && electricalNoSolar[0] === "Electrical Permit", JSON.stringify(electricalNoSolar));

const structuralNoSolar = permitTypeCandidates(NO_SOLAR_MENU, "structural");
check("with no solar type on offer, a structural track picks the residential BUILDING permit, not the commercial one",
  structuralNoSolar.length === 1 && structuralNoSolar[0] === "Residential Building Permit", JSON.stringify(structuralNoSolar));

// ---- the refusals, which matter more than the matches -------------------------
check("'Smoke Detector Permit' is never a solar type — the string the DISMISSER used to click",
  !solar.includes("Smoke Detector Permit"));

check("'Look Up Record' is not an application at all",
  !solar.includes("Look Up Record") && !structural.includes("Look Up Record"));

const extensionMenu = ["Residential Solar Permit Extension", "Solar Permit Renewal", "Solar Pre-Application"];
check("an EXTENSION, a RENEWAL and a PRE-APPLICATION are all refused",
  permitTypeCandidates(extensionMenu, "solar").length === 0,
  `${JSON.stringify(permitTypeCandidates(extensionMenu, "solar"))} — gilbertaz learned a Permit Extension Request for exactly this reason`);

check("a menu with NO solar type yields nothing, rather than the nearest thing",
  permitTypeCandidates(["Fence Permit", "Fire Sprinkler System", "Smoke Detector Permit"], "solar").length === 0);

// Two residential solar types is a real shape (roof-mount vs ground-mount). Refusing is
// correct: a human picks, and the recipe is finishable. Guessing files one of them.
const twoSolar = ["Residential Solar Permit - Roof Mount", "Residential Solar Permit - Ground Mount"];
check("two plausible solar types is AMBIGUOUS — the caller must refuse, not pick",
  permitTypeCandidates(twoSolar, "solar").length === 2,
  "the chooser reports both so chooseApplicationType can refuse and name them");

assert.ok(true);
if (failures) { console.error(`\n${failures} permit-type check(s) FAILED.`); process.exit(1); }
console.log("\nAll permit-type choice checks passed.");
