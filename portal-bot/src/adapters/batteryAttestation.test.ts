// A BATTERY ATTESTATION IS A STATEMENT ON THE FILING, ANSWERED ONLY FROM AN OWNER RULING (#536).
//
// PacifiCorp's battery section asks the applicant to tick "The battery system will not backfeed
// into the grid." and "The battery system includes a transfer switch (or equivalent) to ensure
// proper isolation before going off grid (islanding)." Owner ruling 2026-11-02: on PacifiCorp
// battery jobs both are checked (Pacific Power allows no battery export). This pins the shared
// predicate and the ruling table the learner's fill guard, its attestation pass and replay's
// no-battery skip all read. The real-browser half is batteryLearnPacifiCorp.dom.smoke.ts.
//   npx tsx portal-bot/src/adapters/batteryAttestation.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BATTERY_ATTESTATION_RULINGS,
  batteryAttestationAnswer,
  batteryAttestationOf,
  batteryControlKind,
} from "../../../shared/src/batteryControls";
import type { RecipeStep } from "../../../shared/src/types";

process.env.AUTOLEARN_RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "battery-attestation-test-"));
const { RecipeAdapter } = await import("./recipeAdapter");

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const NO_BACKFEED = "The battery system will not backfeed into the grid.";
const TRANSFER = "The battery system includes a transfer switch (or equivalent) to ensure proper isolation before going off grid (islanding).";

check("the two PacifiCorp statements are ATTESTATIONS (not mentions the planner may answer)", () => {
  assert.equal(batteryControlKind(NO_BACKFEED, { control: "checkbox" }), "attestation");
  assert.equal(batteryControlKind(`${NO_BACKFEED} *`, { control: "checkbox" }), "attestation", "required marker");
  assert.equal(batteryControlKind(TRANSFER, { control: "checkbox" }), "attestation");
  assert.equal(batteryAttestationOf(NO_BACKFEED), "no-backfeed");
  assert.equal(batteryAttestationOf(TRANSFER), "transfer-switch-isolation");
  assert.equal(batteryAttestationOf("The battery will not back-feed the utility grid"), "no-backfeed", "hyphenated spelling");
});

check("nothing else changes kind: declarations, specs, programmes and acknowledgments read as before", () => {
  assert.equal(batteryControlKind("This system includes battery storage", { control: "checkbox" }), "declaration");
  assert.equal(batteryControlKind("Battery Inverter Model", { control: "text" }), "spec");
  assert.equal(batteryControlKind("Will you be participating in the Wattsmart Battery Program?", { control: "select" }), "program");
  assert.equal(batteryControlKind("I have read the Battery System Interim Technical Requirements", { control: "checkbox" }), "mention");
  assert.equal(batteryControlKind("Does the inverter include a transfer switch?", { control: "checkbox" }), null, "no storage words: not a battery control at all");
  assert.equal(batteryAttestationOf("The PV system will not export to the grid"), null, "a PV export statement is not the battery's");
});

check("THE RULING: PacifiCorp / Pacific Power battery jobs get both checked, and say whose ruling it is", () => {
  for (const portal of ["PacifiCorp", "Pacificorp (synthetic)", "Pacific Power"]) {
    for (const label of [NO_BACKFEED, TRANSFER]) {
      const a = batteryAttestationAnswer(portal, label, true);
      assert.ok(a, `${portal}: ${label.slice(0, 40)}`);
      assert.equal(a.answer, "checked");
      assert.match(a.ruling, /owner ruling 2026-11-02 \(#536\)/);
    }
  }
});

check("NEVER A GUESS: no ruling for the portal, no battery, or silence about one -> no answer", () => {
  assert.equal(batteryAttestationAnswer("Portland General Electric", NO_BACKFEED, true), null, "another utility");
  assert.equal(batteryAttestationAnswer("Rocky Mountain Power", NO_BACKFEED, true), null, "PacifiCorp's other brand was not named in the ruling");
  assert.equal(batteryAttestationAnswer("PacifiCorp", NO_BACKFEED, false), null, "no battery");
  assert.equal(batteryAttestationAnswer("PacifiCorp", NO_BACKFEED, undefined), null, "battery unknown");
  assert.equal(batteryAttestationAnswer("PacifiCorp", "This system includes battery storage", true), null, "not an attestation");
  assert.ok(BATTERY_ATTESTATION_RULINGS.every((r) => r.ruling.trim().length > 0), "every ruling names its source");
});

type Replay = { skipForNoBattery(s: RecipeStep): boolean };
const replayWith = (hasBattery: string): Replay => {
  const a = Object.create(RecipeAdapter.prototype) as Record<string, unknown>;
  a.fieldValues = { hasBattery };
  a.recipe = { steps: [] };
  return a as unknown as Replay;
};
const recorded = (label: string): RecipeStep =>
  ({ action: "check", phase: "fill", note: `battery attestation: ${label} → checked (owner ruling 2026-11-02 (#536): on PacifiCorp battery jobs both attestations are checked)`, selector: { label } }) as RecipeStep;

check("REPLAY: a recorded attestation is skipped on a job with no battery, and replayed on one with a battery", () => {
  for (const label of [NO_BACKFEED, TRANSFER]) {
    assert.equal(replayWith("No").skipForNoBattery(recorded(label)), true, `no battery: ${label.slice(0, 40)}`);
    assert.equal(replayWith("Yes").skipForNoBattery(recorded(label)), false, `battery: ${label.slice(0, 40)}`);
    assert.equal(replayWith("").skipForNoBattery(recorded(label)), false, "unknown replays as recorded");
  }
});

if (failures) { console.error(`\n${failures} battery-attestation check(s) FAILED.`); process.exit(1); }
console.log("\nAll battery-attestation checks passed.");
process.exit(0);
