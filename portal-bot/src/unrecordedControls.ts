// A REQUIRED CONTROL THE RECIPE HAS NO STEP FOR — WHAT DOES THIS JOB ANSWER? (issue #352)
//
// A recipe records what the LEARN project triggered. PacifiCorp renders its AC disconnect section
// only when the computed rating requires one: the live recipe was learned on a 5.4 kW system, so it
// has no step for "Disconnect Switch Manufacturer" *, "Disconnect Switch Model" *, the knife-blade
// question or the distance-to-meter question — and a 16 kW job reached review with all four blank.
//
// For a control like that, the replay asks THIS, and nothing else decides it:
//   1. THE AC DISCONNECT PART (make / model / make+model) — the project's disconnectMake /
//      disconnectModel / disconnectMakeModel (backend resolveRecipeFieldValues: the plan set's own
//      part, else the client's standard part). Never another project's literal.
//   2. A PER-JOB QUESTION only a person answers (shared perJobAnswerKeyFor — the same predicate as
//      the question bank, the binders and the stage gate): the job's own recorded answer; when the job
//      has none, the operator's standing answer if there is one (below); else nothing.
//   3. A POLICY QUESTION — the learner's own table (autoLearnAdapter policyDefaultAnswerFor), so a
//      learn and a replay give one question one answer.
// A control none of these knows is not this module's: the LLM gap-fill and the required sweep keep it.
//
// THE STANDING ANSWER FOR AN UNRECORDED PER-JOB CONTROL IS THE LEARNER'S POLICY ANSWER. The distance
// question ("within the state's required distance from the utility meter") is per-job in principle;
// the operator's standing answer is "Yes" (backend intakeRequests OPERATOR_POLICY_ANSWERS), which is
// the same answer POLICY_RADIO_DEFAULTS files at learn time. A RECORDED step bound to the key still
// stops the stage before a browser opens when the job has not answered (recipeReplayBinding
// openPerJobQuestions) — this module does not touch that; it only answers a control the recipe could
// not have asked about, and only when it is EMPTY.
import { perJobAnswerKeyFor, perJobControlOfField } from "../../shared/src/perJobQuestions";
import { isSensitiveLabel, policyDefaultAnswerFor, type PolicyScope } from "./adapters/autoLearnAdapter";

export type DisconnectPartKey = "disconnectMake" | "disconnectModel" | "disconnectMakeModel";

/**
 * THE AC DISCONNECT PART a control asks for, or null — by its own words. "Disconnect Switch
 * Manufacturer" → disconnectMake, "Disconnect Switch Model" → disconnectModel, "AC Disconnect
 * Make/Model" → disconnectMakeModel. Never a question ("Is the disconnect lockable?"), never a long
 * prose label, and never another piece of equipment's disconnect (a battery's, an EV charger's).
 */
export function disconnectPartKeyFor(label: string): DisconnectPartKey | null {
  const t = String(label ?? "").replace(/\s+/g, " ").trim();
  if (!t || t.length > 80 || /\?/.test(t)) return null;
  if (!/\bdisconnect(?:s|\(s\))?\b/i.test(t)) return null;
  if (/batter|energy\s*storage|\bess\b|storage|powerwall|\bev\b|charger|vehicle|generator/i.test(t)) return null;
  const make = /\b(manufacturer|make|brand|mfr|mfg)\b/i.test(t);
  const model = /\bmodel\b/i.test(t);
  if (make && model) return "disconnectMakeModel";
  if (make) return "disconnectMake";
  if (model) return "disconnectModel";
  return null;
}

/** A required control, as the page extraction reads it (autoLearnAdapter toExtractedField). */
export interface UnrecordedControl {
  label: string;
  fieldType: string;
  options?: string[] | null;
}

export type UnrecordedAnswer =
  /** Bound to a project key. `value` "" = the project has nothing for it: never typed, the run stops. */
  | { kind: "bound"; key: string; value: string }
  /** A standing answer (the learner's policy table), offered by the control's own options. */
  | { kind: "policy"; value: string; why: string };

const optNorm = (s: string): string => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** The control's own option for an answer ("Yes" → "Yes"), or "" when it offers none — a policy
 *  answer is never typed into a dropdown that does not offer it. */
function offered(options: string[] | null | undefined, answer: string): string {
  const want = optNorm(answer);
  return (options ?? []).find((o) => optNorm(o) === want) ?? "";
}

/**
 * The answer THIS job gives a required control the recipe has no step for, or null when the control
 * is not one this module knows. Pure.
 *
 * Only a text box (the disconnect part) or a dropdown (`select`, or a custom `other` that offers
 * options) is answered. A free-text box whose label reads as an identifier (account, meter number…)
 * is never touched; a dropdown is, because an enumeration cannot hold an identifier — PacifiCorp's
 * distance question names the "utility meter" and is a Yes/No select.
 */
export function answerForUnrecordedControl(
  control: UnrecordedControl,
  fieldValues: Record<string, string>,
  scope: PolicyScope,
): UnrecordedAnswer | null {
  const label = String(control?.label ?? "");
  const type = String(control?.fieldType ?? "");
  const options = Array.isArray(control?.options) ? control.options.map((o) => String(o ?? "")) : [];
  const isDropdown = type === "select" || (type === "other" && options.length > 0);
  const isText = type === "text" || (type === "other" && options.length === 0);
  if (!isDropdown && !isText) return null;
  if (isText && isSensitiveLabel(label)) return null;

  const part = disconnectPartKeyFor(label);
  if (part) return { kind: "bound", key: part, value: String(fieldValues?.[part] ?? "").trim() };

  if (isDropdown) {
    const perJob = perJobAnswerKeyFor(label, { control: perJobControlOfField({ fieldType: type, options }), answer: "", options });
    if (perJob) {
      const own = String(fieldValues?.[perJob] ?? "").trim();
      if (own) return { kind: "bound", key: perJob, value: own };
      const standing = offered(options, policyDefaultAnswerFor(label, scope));
      if (standing) return { kind: "policy", value: standing, why: "the operator's standing answer (this job recorded none)" };
      return { kind: "bound", key: perJob, value: "" };
    }
    const policy = offered(options, policyDefaultAnswerFor(label, scope));
    if (policy) return { kind: "policy", value: policy, why: "the operator's standing policy answer" };
  }
  return null;
}

/** Why a bound key has no value, in the operator's terms — the stop names it. */
export function missingValueHint(key: string): string {
  if (/^disconnect(Make|Model|MakeModel)$/.test(key)) {
    return "no AC disconnect part is on file — the plan set names none and the client has no standard disconnect make/model (or the standard part conflicts with the plan set; QC says which)";
  }
  if (key === "disconnectWithin10ft" || key === "ownershipModel" || key === "systemConfiguration") {
    return "it is a per-job question only a person answers (the project's portal questions, or the intake link)";
  }
  return `the project has no value for ${key}`;
}

/**
 * The stop's message: the controls BY NAME first (a downstream reader keeps ~300 characters), then
 * why there is no value. "no value was supplied" is deliberate — backend replayFailureBlamesRecipe
 * reads it as the project's missing data, so the recipe is kept, never demoted or flagged for it
 * (pinned in backend/test/replayDemotion.test.ts).
 */
export function missingRequiredStopMessage(before: string, missing: Array<{ label: string; key: string }>): string {
  const names = missing.map((m) => `"${String(m.label ?? "").replace(/\s+/g, " ").trim().slice(0, 60)}"`).join(", ");
  const hints = Array.from(new Set(missing.map((m) => missingValueHint(m.key))));
  const them = missing.length === 1 ? "it" : "them";
  return `Stopped before ${before}: this page requires ${names} and no value was supplied for this project — ${hints.join("; ")}. `
    + `Nothing was typed into ${them} and the page was not left: add the value and stage again, or enter ${them} in the browser before submitting.`;
}
