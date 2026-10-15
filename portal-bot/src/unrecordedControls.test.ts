// WHICH REQUIRED CONTROLS THE REPLAY ANSWERS WITHOUT A RECORDED STEP, AND WITH WHAT (issue #352).
//
// answerForUnrecordedControl decides what a replay types into a required control its recipe never
// recorded. A filter like this fails BOTH ways: too narrow and PacifiCorp's disconnect section
// reaches review blank again; too wide and a battery's disconnect, a question ABOUT the disconnect,
// or an identifier box gets an answer it was never meant to have. Both directions are pinned here.
//
// Run: npx tsx portal-bot/src/unrecordedControls.test.ts
import assert from "node:assert/strict";
import { answerForUnrecordedControl, disconnectPartKeyFor, missingRequiredStopMessage, readDisconnectPart, UNPINNED_CONTROL_WHY } from "./unrecordedControls";
import { policyDefaultAnswerFor, policyProfileFor, policyScopeFor } from "./adapters/autoLearnAdapter";
import { operatorPolicyAnswer } from "../../shared/src/perJobQuestions";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const YES_NO = ["Select...", "Yes", "No"];
/** The value an answer would type, or undefined (an "unbound" answer types nothing). */
const valueOf = (a: ReturnType<typeof answerForUnrecordedControl>): string | undefined => (a && "value" in a ? a.value : undefined);
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

// PR #353 round 2: the AC disconnect's part (the client's standard Eaton DG221URB) was bound into a DC
// disconnect's, a rapid-shutdown disconnect's and an inverter's DC disconnect's fields. Both directions.
const NOT_THE_AC_DISCONNECT = [
  "DC Disconnect Manufacturer",
  "DC Disconnect Switch Model",
  "Inverter DC Disconnect Make",
  "Rapid Shutdown Disconnect Manufacturer",
  "RSD Disconnect Model",
  "Inverter Disconnect Manufacturer",
  "Combiner Box Disconnect Model",
  "Main Service Disconnect Manufacturer",
  "AC/DC Disconnect Model",
  "Battery Disconnect Manufacturer",
  "EV Charger Disconnect Model",
  // PR #353 round 3: the round-2 DENY-list let through every equipment it did not name (the reviewer's
  // probe: each of these got acDisconnect:true and the client's Eaton DG221URB). An ALLOW-list now.
  "EVSE Disconnect Manufacturer",
  "Backup Gateway Disconnect Manufacturer",
  "Gateway Disconnect Model",
  "Transfer Switch Disconnect Manufacturer",
  "Subpanel Disconnect Manufacturer",
  "Load center disconnect manufacturer",
  "Wind turbine disconnect manufacturer",
  "Turbine Disconnect Model",
  "Fuel cell disconnect manufacturer",
  "EVSE AC Disconnect Model",
];
const THE_AC_DISCONNECT: Array<[string, string]> = [
  ["Disconnect Switch Manufacturer", "disconnectMake"],
  ["Disconnect Switch Model", "disconnectModel"],
  ["AC Disconnect Manufacturer", "disconnectMake"],
  ["AC Disconnect Make/Model", "disconnectMakeModel"],
  ["AC Disconnect(s) Model Number", "disconnectModel"],
  ["A.C. Disconnect Model #", "disconnectModel"],
  ["Disconnect Switch Model No.", "disconnectModel"],
  ["Disconnect Switch Manufacturer Name", "disconnectMake"],
  ["Disconnect Switch Manufacturer *", "disconnectMake"],
  ["Utility AC Disconnect Model", "disconnectModel"],
  ["Utility External Disconnect Switch Model", "disconnectModel"],
  ["Lockable Disconnect Switch Manufacturer", "disconnectMake"],
  ["Disconnect for the Utility Model", "disconnectModel"],
  ["Visible, Lockable Disconnect Brand", "disconnectMake"],
];
// THE ACCEPTED SAFE DIRECTION (PR #353 round 3): an AC wording that carries a word the allow-list does
// not — an inverter, a meter, a rating, a location, a fuse — is no longer bound. It stops by name with
// the AC part on file, which a person then enters. The first three bound in round 2; the other five
// are the round-2 review's nit (they stopped in round 2 as well, through the deny-list).
const AC_WORDING_THAT_NOW_STOPS = [
  "Inverter AC Disconnect Manufacturer",
  "Fused AC Disconnect Manufacturer",
  "Non-Fused Disconnect Switch Model",
  "Inverter Output Disconnect Manufacturer",
  "Production Meter Disconnect Manufacturer",
  "Disconnect Switch Manufacturer (near meter)",
  "Service-rated Disconnect Manufacturer",
  "Disconnect Make (Main)",
];
check("MUST-EXCLUDE: a DC / rapid-shutdown / inverter / combiner / service / storage disconnect is never bound to the AC disconnect's keys", () => {
  for (const label of NOT_THE_AC_DISCONNECT) {
    assert.equal(disconnectPartKeyFor(label), null, label);
    assert.equal(readDisconnectPart(label)?.acDisconnect, false, label);
  }
});
check("MUST-PASS: the AC disconnect, named or bare, binds to its keys", () => {
  for (const [label, key] of THE_AC_DISCONNECT) {
    assert.equal(disconnectPartKeyFor(label), key, label);
    assert.deepEqual(answerForUnrecordedControl({ label, fieldType: "text" }, STD, "nem"),
      { kind: "bound", key, value: (STD as Record<string, string>)[key] }, label);
  }
});
check("an AC wording with a word the allow-list does not carry is never bound: it stops by name (the accepted safe direction)", () => {
  // The two meter-named text boxes are not this module's at all: the identifier guard (a free-text
  // box whose label names a meter) runs before the part is read, as it did in round 2 — never typed,
  // left to the sweep. As a dropdown, the same labels stop by name.
  const identifierGuarded = new Set(["Production Meter Disconnect Manufacturer", "Disconnect Switch Manufacturer (near meter)"]);
  for (const label of AC_WORDING_THAT_NOW_STOPS) {
    assert.equal(disconnectPartKeyFor(label), null, label);
    assert.equal(readDisconnectPart(label)?.acDisconnect, false, label);
    const asText = answerForUnrecordedControl({ label, fieldType: "text" }, STD, "nem");
    assert.deepEqual(identifierGuarded.has(label) ? asText : asText?.kind, identifierGuarded.has(label) ? null : "unbound", `${label} → ${JSON.stringify(asText)}`);
    assert.equal(answerForUnrecordedControl({ label, fieldType: "select", options: ["Select...", "Eaton", "Square D"] }, STD, "nem")?.kind, "unbound", label);
  }
});
check("the detection itself is not widened: \"Disconnecting Means\" alone names no disconnect part (the NEC's words for any disconnect, DC included)", () => {
  assert.equal(readDisconnectPart("Disconnecting Means Manufacturer"), null);
  assert.equal(readDisconnectPart("PV System Disconnecting Means Model"), null);
});
check("another equipment's disconnect part is recognized and never typed — it stops by name (unbound), with the AC part on file", () => {
  for (const label of NOT_THE_AC_DISCONNECT) {
    const ans = answerForUnrecordedControl({ label, fieldType: "text" }, STD, "nem");
    assert.equal(ans?.kind, "unbound", `${label} → ${JSON.stringify(ans)}`);
    assert.ok(!("value" in (ans ?? {})), `${label} carries no value to type: ${JSON.stringify(ans)}`);
  }
  const msg = missingRequiredStopMessage('"advance: Next"', [{ label: "DC Disconnect Manufacturer", key: null }]);
  assert.ok(msg.slice(0, 300).includes("DC Disconnect Manufacturer"), msg);
  assert.ok(/no value was supplied/.test(msg) && /another piece of equipment's disconnect/.test(msg), msg);
});

check("PacifiCorp's section: make/model bound to the project's part, knife-blade and distance standing Yes", () => {
  assert.deepEqual(answerForUnrecordedControl({ label: "Disconnect Switch Manufacturer", fieldType: "text" }, STD, "nem"), { kind: "bound", key: "disconnectMake", value: "Eaton" });
  assert.deepEqual(answerForUnrecordedControl({ label: "Disconnect Switch Model", fieldType: "text" }, STD, "nem"), { kind: "bound", key: "disconnectModel", value: "DG221URB" });
  assert.equal(valueOf(answerForUnrecordedControl({ label: KNIFE, fieldType: "select", options: YES_NO }, STD, "nem")), "Yes");
  const dist = answerForUnrecordedControl({ label: DIST, fieldType: "select", options: YES_NO }, STD, "nem");
  assert.equal(dist?.kind, "policy");
  assert.equal(valueOf(dist), "Yes");
});

// PR #353 round 2: the standing answer is read BY THE KEY the per-job rule returned, not by re-matching
// the wording against the learner's regexes. Each of these reads as the distance question to the shared
// rule (DISCONNECT_DISTANCE_QUESTION) but matches no POLICY_RADIO_DEFAULTS regex — so a wording lookup
// gave nothing, the answer came back bound-empty and the run stopped mid-wizard.
const DIST_REWORDED = [
  "Is the AC disconnect within ten feet of the utility meter?",
  "Is the disconnect located within 10 feet of the meter?",
  "Is the AC disconnect switch installed within 10 ft. of the revenue meter?",
  "Within 10 feet of the meter, is there a visible lockable disconnect?",
];
check("the distance question's standing answer comes BY ITS KEY, whatever the wording (the reviewer's four wordings)", () => {
  for (const label of DIST_REWORDED) {
    assert.equal(policyDefaultAnswerFor(label, "nem"), "", `precondition: the learner's wording table does not carry ${JSON.stringify(label)}`);
    assert.deepEqual(answerForUnrecordedControl({ label, fieldType: "select", options: YES_NO }, STD, "nem"),
      { kind: "policy", value: "Yes", why: "the operator's standing answer (this job recorded none)" }, label);
    // ...and the job's own answer still wins, by the same key.
    assert.deepEqual(answerForUnrecordedControl({ label, fieldType: "select", options: YES_NO }, { ...STD, disconnectWithin10ft: "No" }, "nem"),
      { kind: "bound", key: "disconnectWithin10ft", value: "No" }, label);
  }
});

check("the standing answer is the shared table's, read by key (the one the intake reads)", () => {
  assert.equal(operatorPolicyAnswer("disconnectWithin10ft"), "Yes");
  assert.equal(operatorPolicyAnswer("ownershipModel"), "");
  assert.equal(operatorPolicyAnswer("constructor"), "", "an Object.prototype name is not a key in the table");
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

check("ONE policy rule: the learn's profile (policyProfileFor, which backend autoLearn.ts passes the learner) and the replay's scope agree", () => {
  const envs = [{}, { PORTAL_POLICY_DEFAULTS: "off" }, { PORTAL_POLICY_DEFAULTS: "0" }, { PORTAL_POLICY_DEFAULTS: "on" }] as NodeJS.ProcessEnv[];
  const asScope = { residential_nem: "nem", permit_standard: "permit", none: "none" } as const;
  for (const env of envs) {
    for (const scopeType of ["utility", "ahj", "", null, undefined]) {
      assert.equal(policyScopeFor(scopeType, env), asScope[policyProfileFor(scopeType, env)], `${JSON.stringify(env)} ${String(scopeType)}`);
    }
  }
  assert.equal(policyProfileFor("utility", {} as NodeJS.ProcessEnv), "residential_nem");
  assert.equal(policyProfileFor("ahj", {} as NodeJS.ProcessEnv), "permit_standard");
  assert.equal(policyProfileFor("utility", { PORTAL_POLICY_DEFAULTS: "off" } as NodeJS.ProcessEnv), "none");
  assert.equal(policyProfileFor("ahj", { PORTAL_POLICY_DEFAULTS: "0" } as NodeJS.ProcessEnv), "none");
});

check("the stop's message names every control within the first 300 characters", () => {
  const msg = missingRequiredStopMessage('"advance: Next"', [{ label: "Disconnect Switch Manufacturer", key: "disconnectMake" }, { label: "Disconnect Switch Model", key: "disconnectModel" }]);
  assert.ok(msg.slice(0, 300).includes("Disconnect Switch Manufacturer") && msg.slice(0, 300).includes("Disconnect Switch Model"), msg);
  assert.ok(/no value was supplied/.test(msg), msg);
});

check("a control that could not be pinned to one element stops with the replay's own reason (and still reads as the project's, not the recipe's)", () => {
  const msg = missingRequiredStopMessage('"advance: Next"', [{ label: "Disconnect Switch Model", key: "disconnectModel", why: UNPINNED_CONTROL_WHY }]);
  assert.ok(msg.slice(0, 300).includes("Disconnect Switch Model"), msg);
  assert.ok(/no value was supplied by this run/.test(msg), msg);
  assert.ok(msg.includes(UNPINNED_CONTROL_WHY) && !/no AC disconnect part is on file/.test(msg), msg);
  assert.ok(!/add the value and stage again/.test(msg), `the value is on file — the remedy is the browser: ${msg}`);
});

if (failures) { console.error(`\n${failures} unrecordedControls check(s) FAILED.`); process.exit(1); }
console.log("\nAll unrecordedControls checks passed.");
process.exit(0);
