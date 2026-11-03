// A SLOT THAT ASKS FOR A PHOTO TAKES THAT PHOTO OR NOTHING (#542).
//
// PacifiCorp's PowerClerk NEM asks, REQUIRED, to "Upload a photo of meter where system will be
// interconnected". With a plan set on file and no meter photo, resolveUpload's split-mode tier 1b
// ("label named a document we don't hold → the plan set as the best available substitute") filed
// the whole plan set into that slot, recorded it as `upload plan_set: Upload a photo of meter…`,
// and did not report the slot empty. The run read as complete; the utility reviewer opened a plan
// set where a meter photo belongs. PacifiCorp has already rejected a filing over that field.
//
// MUST-PASS    the meter photo, when held, still goes into the meter-photo slot (split and
//              combined); a generic required "Plans" slot, a missing split sheet (one-line, site
//              plan) and a generic "Attachment" still take the plan set.
// MUST-EXCLUDE plan set only: a required meter-photo slot gets NOTHING (the caller then reports it
//              missing). Nor does any other photo/picture slot get the plan set or another
//              document; and a recipe step that recorded the plan set against the meter-photo
//              label is refused at replay (exactUploadDocType names meter_photo).
//
// Run: npx tsx portal-bot/src/adapters/photoSlotNoSubstitute.test.ts
// Constructing the learner starts a debug bundle (LearnRunDebug.start) — keep it out of data/learn-runs.
import "../smokeArtifactDirs";
import assert from "node:assert/strict";
import { AutoLearnAdapter, exactUploadDocType, uploadForbidsSubstitute, type LearnPlanner } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${e instanceof Error ? e.message : String(e)}`); }
};
const planner: LearnPlanner = async () => ({ fills: [], atReview: false });
const PLAN = { plan_set: "C:/nope/ZZTEST-plan-set.pdf" };
const WITH_PHOTO = { ...PLAN, meter_photo: "C:/nope/ZZTEST-meter-photo.jpg" };
const METER = "Upload a photo of meter where system will be interconnected";
const pick = (docs: Record<string, string>, label: string, mode: "combined" | "split" = "split", required = true): string | null => {
  const a = new AutoLearnAdapter("Photo Slots", planner, { uploadMode: mode, docsByType: docs }) as unknown as { resolveUploadByLabel(l: string, r?: boolean, acc?: string): { docType: string } | null };
  return a.resolveUploadByLabel(label, required, "")?.docType ?? null;
};

check("MUST-EXCLUDE plan set only: the required PacifiCorp meter-photo slot is left empty (split mode)", () => {
  assert.equal(pick(PLAN, METER), null);
  assert.equal(pick(PLAN, "Meter Photo *"), null);
  assert.equal(pick(PLAN, "Picture of the meter"), null);
});
check("MUST-EXCLUDE …and in combined mode, where every other slot takes the plan set", () => {
  assert.equal(pick(PLAN, METER, "combined"), null);
});
check("MUST-EXCLUDE …and with other documents on file, none of them goes into the meter slot either", () => {
  assert.equal(pick({ ...PLAN, sld: "C:/nope/sld.pdf", utility_bill: "C:/nope/bill.pdf" }, METER), null);
});
check("MUST-EXCLUDE a required photo slot with no matching document gets no stand-in (split mode)", () => {
  assert.equal(pick(PLAN, "Photo of the main service panel *"), null);
  assert.equal(pick(PLAN, "Picture of 5 x 7 signage, knife blade disconnect, and smart inverter"), null);
  assert.equal(pick(WITH_PHOTO, "Photo of the main service panel *"), null, "the meter photo is not a panel photo");
});
check("MUST-EXCLUDE replay: a recorded plan-set upload against the meter-photo label is refused", () => {
  // recipeAdapter's upload step refuses any docType other than exactUploadDocType(label).
  assert.equal(exactUploadDocType(METER), "meter_photo");
  assert.equal(uploadForbidsSubstitute(METER), true);
});
check("MUST-PASS the meter photo, when held, still fills the meter-photo slot (split and combined)", () => {
  assert.equal(pick(WITH_PHOTO, METER), "meter_photo");
  assert.equal(pick(WITH_PHOTO, METER, "combined"), "meter_photo");
});
check("MUST-PASS a generic required 'Plans' slot and a generic 'Attachment' still take the plan set", () => {
  assert.equal(pick(PLAN, "Plans *"), "plan_set");
  assert.equal(pick(PLAN, "Attachment"), "plan_set");
  assert.equal(pick(PLAN, "Plans and photos"), "plan_set");
});
check("MUST-PASS a missing split sheet still takes the plan set (tier 1b unchanged for documents)", () => {
  assert.equal(pick(PLAN, "One-Line Electrical Diagram"), "plan_set");
  assert.equal(pick(PLAN, "Site Plan"), "plan_set");
});
check("MUST-PASS 'Photovoltaic' is not a photo request", () => {
  assert.equal(pick(PLAN, "Photovoltaic System Drawings"), "plan_set");
  assert.equal(pick(PLAN, "Photovoltaic Plans", "combined"), "plan_set");
});
check("MUST-PASS an optional meter-photo slot with no photo stays empty (unchanged)", () => {
  assert.equal(pick(PLAN, METER, "split", false), null);
});

if (failures) { console.error(`\n${failures} photo-slot check(s) FAILED.`); process.exit(1); }
console.log("\nAll photo-slot no-substitute checks passed.");
process.exit(0);
