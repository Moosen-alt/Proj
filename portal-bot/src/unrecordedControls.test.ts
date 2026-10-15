// WHICH REQUIRED CONTROLS THE REPLAY ANSWERS WITHOUT A RECORDED STEP, AND WITH WHAT (issue #352).
//
// answerForUnrecordedControl decides what a replay types into a required control its recipe never
// recorded. A filter like this fails BOTH ways: too narrow and PacifiCorp's disconnect section
// reaches review blank again; too wide and a battery's disconnect, a question ABOUT the disconnect,
// or an identifier box gets an answer it was never meant to have. Both directions are pinned here.
//
// Run: npx tsx portal-bot/src/unrecordedControls.test.ts
import assert from "node:assert/strict";
import { answerForUnrecordedControl, disconnectPartKeyFor, missingRequiredStopMessage } from "./unrecordedControls";
import { policyDefaultAnswerFor, policyScopeFor } from "./adapters/autoLearnAdapter";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const YES_NO = ["Select...", "Yes", "No"];
const KNIFE = "Please indicate if the AC disconnect(s) for this installation are manually operated, lockable, load break, accessible, and has a visible open (knife blade type).";
const DIST = "Are the AC disconnect(s) for this installation within the states required distance from the utility meter?  (California - 3 Ft., Oregon - 10 Ft., Washington - 3 Ft.)";
const STD = { disconnectMake: "Eaton", disconnectModel: "DG221URB", disconnectMakeModel: "Eaton DG221URB", disconnectWithin10ft: "" };

check("MUST-PASS: the AC disconnect part, by its own words", () => {
  assert.equal(disconnectPartKeyFor("Disconnect Switch Manufacturer"), "disconnectMake");
  assert.equal(disconnectPartKeyFor("Disconnect Switch Model"), "disconnectModel");
  assert.equal(disconnectPartKeyFor("AC Disconnect Make"), "disconnectMake");
  assert.equal(disconnectPartKeyFor("AC Disconnect(s) Model Number"), "disconnectModel");
  assert.equal(disconnectPartKeyFor("AC Disconnect Make/Model"), "disconnectMakeModel");
});

check("MUST-EXCLUDE: another device's disconnect, a question about the disconnect, a part with no disconnect", () => {
  assert.equal(disconnectPartKeyFor("Battery Disconnect Manufacturer"), null);
  assert.equal(disconnectPartKeyFor("EV Charger Disconnect Model"), null);
  assert.equal(disconnectPartKeyFor("Is the disconnect model lockable?"), null);
  assert.equal(disconnectPartKeyFor("Manufacturer"), null);
  assert.equal(disconnectPartKeyFor("Model"), null);
  assert.equal(disconnectPartKeyFor("Inverter Manufacturer"), null);
  assert.equal(disconnectPartKeyFor("AC Disconnect Switch Required"), null);
  assert.equal(disconnectPartKeyFor(KNIFE), null);
});

check("PacifiCorp's section: make/model bound to the project's part, knife-blade and distance standing Yes", () => {
  assert.deepEqual(answerForUnrecordedControl({ label: "Disconnect Switch Manufacturer", fieldType: "text" }, STD, "nem"), { kind: "bound", key: "disconnectMake", value: "Eaton" });
  assert.deepEqual(answerForUnrecordedControl({ label: "Disconnect Switch Model", fieldType: "text" }, STD, "nem"), { kind: "bound", key: "disconnectModel", value: "DG221URB" });
  assert.equal(answerForUnrecordedControl({ label: KNIFE, fieldType: "select", options: YES_NO }, STD, "nem")?.value, "Yes");
  const dist = answerForUnrecordedControl({ label: DIST, fieldType: "select", options: YES_NO }, STD, "nem");
  assert.equal(dist?.kind, "policy");
  assert.equal(dist?.value, "Yes");
});

check("the job's own per-job answer wins over the standing one", () => {
  assert.deepEqual(answerForUnrecordedControl({ label: DIST, fieldType: "select", options: YES_NO }, { ...STD, disconnectWithin10ft: "No" }, "nem"),
    { kind: "bound", key: "disconnectWithin10ft", value: "No" });
});

check("no part on file → bound with no value (the replay stops by name), never another value", () => {
  assert.deepEqual(answerForUnrecordedControl({ label: "Disconnect Switch Manufacturer", fieldType: "text" }, { disconnectMake: "" }, "nem"),
    { kind: "bound", key: "disconnectMake", value: "" });
  assert.deepEqual(answerForUnrecordedControl({ label: "Disconnect Switch Model", fieldType: "text" }, {}, "nem"),
    { kind: "bound", key: "disconnectModel", value: "" });
});

check("an unanswered per-job question with no standing answer is bound-empty (a stop), never guessed", () => {
  assert.deepEqual(answerForUnrecordedControl({ label: "Will the System be Customer-Owned or Third-Party Owned?", fieldType: "select", options: ["Select...", "Customer-Owned", "Third-Party Owned"] }, {}, "nem"),
    { kind: "bound", key: "ownershipModel", value: "" });
});

check("policy answers off (PORTAL_POLICY_DEFAULTS=off): the knife-blade question is not answered; distance falls to a stop", () => {
  assert.equal(policyScopeFor("utility", { PORTAL_POLICY_DEFAULTS: "off" } as NodeJS.ProcessEnv), "none");
  assert.equal(answerForUnrecordedControl({ label: KNIFE, fieldType: "select", options: YES_NO }, STD, "none"), null);
  assert.deepEqual(answerForUnrecordedControl({ label: DIST, fieldType: "select", options: YES_NO }, STD, "none"), { kind: "bound", key: "disconnectWithin10ft", value: "" });
});

check("a policy answer is never typed into a dropdown that does not offer it", () => {
  assert.equal(answerForUnrecordedControl({ label: KNIFE, fieldType: "select", options: ["Select...", "Compliant", "Not compliant"] }, STD, "nem"), null);
});

check("MUST-EXCLUDE: ordinary required controls are not this module's (gap-fill and the sweep keep them)", () => {
  for (const label of ["Is this meter located inside a garage/residence/facility?", "Possible meter access issues?", "Manufacturer", "Model", "Tilt", "Azimuth", "Tracking", "Total System Export (kW)"]) {
    assert.equal(answerForUnrecordedControl({ label, fieldType: "select", options: YES_NO }, STD, "nem"), null, label);
    assert.equal(answerForUnrecordedControl({ label, fieldType: "text" }, STD, "nem"), null, label);
  }
});

check("MUST-EXCLUDE: an identifier text box is never touched; the meter-named distance select is (an enumeration holds no identifier)", () => {
  assert.equal(answerForUnrecordedControl({ label: "Current meter number where system will be interconnected", fieldType: "text" }, STD, "nem"), null);
  assert.equal(answerForUnrecordedControl({ label: "Customer's account number", fieldType: "text" }, STD, "nem"), null);
  assert.notEqual(answerForUnrecordedControl({ label: DIST, fieldType: "select", options: YES_NO }, STD, "nem"), null);
});

check("scope: a permit learn's policy never answers a utility question, and the reverse", () => {
  assert.equal(policyDefaultAnswerFor(KNIFE, "nem"), "Yes");
  assert.equal(policyDefaultAnswerFor(KNIFE, "permit"), "");
  assert.equal(policyDefaultAnswerFor("I consent to drone inspection(s) for this project.", "nem"), "");
  assert.equal(policyDefaultAnswerFor("I consent to drone inspection(s) for this project.", "permit"), "Yes");
  assert.equal(policyScopeFor("utility", {} as NodeJS.ProcessEnv), "nem");
  assert.equal(policyScopeFor("ahj", {} as NodeJS.ProcessEnv), "permit");
});

check("the stop's message names every control within the first 300 characters", () => {
  const msg = missingRequiredStopMessage('"advance: Next"', [{ label: "Disconnect Switch Manufacturer", key: "disconnectMake" }, { label: "Disconnect Switch Model", key: "disconnectModel" }]);
  assert.ok(msg.slice(0, 300).includes("Disconnect Switch Manufacturer") && msg.slice(0, 300).includes("Disconnect Switch Model"), msg);
  assert.ok(/no value was supplied/.test(msg), msg);
});

if (failures) { console.error(`\n${failures} unrecordedControls check(s) FAILED.`); process.exit(1); }
console.log("\nAll unrecordedControls checks passed.");
process.exit(0);
