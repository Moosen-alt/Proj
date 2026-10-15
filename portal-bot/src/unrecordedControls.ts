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
//      part, else the client's standard part). Never another project's literal, and never another
//      piece of equipment's disconnect (a DC, rapid-shutdown or storage disconnect): that part is
//      recognized, never bound, and stops the run by name.
//   2. A PER-JOB QUESTION only a person answers (shared perJobAnswerKeyFor — the same predicate as
//      the question bank, the binders and the stage gate): the job's own recorded answer; when the job
//      has none, the operator's standing answer for THAT KEY if there is one (below); else nothing.
//   3. A POLICY QUESTION — the learner's own table (autoLearnAdapter policyDefaultAnswerFor), so a
//      learn and a replay give one question one answer.
// A control none of these knows is not this module's: the LLM gap-fill and the required sweep keep it.
//
// THE STANDING ANSWER FOR AN UNRECORDED PER-JOB CONTROL IS READ BY ITS KEY. The distance question
// ("within the state's required distance from the utility meter") is per-job in principle; the
// operator's standing answer is "Yes", kept in ONE table keyed by the binding (shared
// perJobQuestions OPERATOR_POLICY_ANSWERS — the table the intake reads too), and it is the same
// answer POLICY_RADIO_DEFAULTS files at learn time. A RECORDED step bound to the key still stops the
// stage before a browser opens when the job has not answered (recipeReplayBinding
// openPerJobQuestions) — this module does not touch that; it only answers a control the recipe could
// not have asked about, and only when it is EMPTY.
import { operatorPolicyAnswer, perJobAnswerKeyFor, perJobControlOfField } from "../../shared/src/perJobQuestions";
import { isSensitiveLabel, policyDefaultAnswerFor, type PolicyScope } from "./adapters/autoLearnAdapter";

export type DisconnectPartKey = "disconnectMake" | "disconnectModel" | "disconnectMakeModel";

/** Another SYSTEM's disconnect — storage, an EV charger, a generator — whatever else the label says. */
const ANOTHER_SYSTEMS_DISCONNECT = /batter|energy\s*storage|\bess\b|storage|powerwall|\bev\b|charger|vehicle|generator/i;
/** The DC side ("DC Disconnect", "Inverter DC Disconnect", "AC/DC"): never the AC disconnect. */
const DC_SIDE = /\bdc\b|\bd\.c\b|direct[\s-]*current/i;
/** The AC side, named ("AC Disconnect", "Inverter AC Disconnect"). */
const AC_SIDE = /\bac\b|\ba\.c\b|alternating[\s-]*current/i;
/** Other equipment a disconnect can belong to. Named WITHOUT the AC side ("Rapid Shutdown Disconnect",
 *  "Inverter Disconnect", "Combiner Disconnect", "Main Service Disconnect"), the disconnect is that
 *  equipment's, not the AC disconnect. */
const OTHER_EQUIPMENT = /rapid[\s-]*shut|\brsd\b|inverter|micro|optimi[sz]er|\bmodules?\b|\bpanels?\b|\barrays?\b|\bstrings?\b|combiner|\bmeter\b|\bmain\b|\bservice\b|transformer/i;

/**
 * A DISCONNECT PART a control asks for (its make, model, or both), and whether it is THE AC DISCONNECT's
 * — or null when the control asks for no disconnect part. Never a question ("Is the disconnect
 * lockable?") and never a long prose label.
 *
 * `acDisconnect` is true only when the label names the AC disconnect, or names no other equipment at
 * all (PacifiCorp's bare "Disconnect Switch Manufacturer"). A DC disconnect, an inverter's DC
 * disconnect, a rapid-shutdown disconnect, a combiner's, a battery's or an EV charger's is false
 * (PR #353 round 2: the AC part's Eaton DG221URB was being filed into a DC disconnect's field).
 */
export function readDisconnectPart(label: string): { key: DisconnectPartKey; acDisconnect: boolean } | null {
  const t = String(label ?? "").replace(/\s+/g, " ").trim();
  if (!t || t.length > 80 || /\?/.test(t)) return null;
  if (!/\bdisconnect(?:s|\(s\))?\b/i.test(t)) return null;
  const make = /\b(manufacturer|make|brand|mfr|mfg)\b/i.test(t);
  const model = /\bmodel\b/i.test(t);
  const key: DisconnectPartKey | null = make && model ? "disconnectMakeModel" : make ? "disconnectMake" : model ? "disconnectModel" : null;
  if (!key) return null;
  const another = ANOTHER_SYSTEMS_DISCONNECT.test(t) || DC_SIDE.test(t) || (!AC_SIDE.test(t) && OTHER_EQUIPMENT.test(t));
  return { key, acDisconnect: !another };
}

/**
 * THE AC DISCONNECT PART a control asks for, or null — by its own words. "Disconnect Switch
 * Manufacturer" → disconnectMake, "Disconnect Switch Model" → disconnectModel, "AC Disconnect
 * Make/Model" → disconnectMakeModel. Never a question, never a long prose label, and never another
 * piece of equipment's disconnect (readDisconnectPart: DC, rapid shutdown, an inverter's DC side,
 * storage, an EV charger) — those are never bound to the AC disconnect's keys.
 */
export function disconnectPartKeyFor(label: string): DisconnectPartKey | null {
  const part = readDisconnectPart(label);
  return part && part.acDisconnect ? part.key : null;
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
  | { kind: "policy"; value: string; why: string }
  /** A control this module recognizes that NO project key answers — another piece of equipment's
   *  disconnect part (DC, rapid shutdown, an inverter's DC side, storage…). Never typed: the AC
   *  disconnect's part is never filed into it. The run stops by name. */
  | { kind: "unbound"; why: string };

/** A required control this job has no value for, named in the stop. `key` is the project key it binds
 *  to, or null when no project key answers it (an "unbound" answer). */
export interface MissingRequired {
  label: string;
  key: string | null;
}

const OTHER_DISCONNECT_WHY = "it asks for another piece of equipment's disconnect (a DC, rapid-shutdown, inverter or storage disconnect) and only the AC disconnect's make and model are on file, so no project value answers it";

const optNorm = (s: string): string => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** The control's own option for an answer ("Yes" → "Yes"), or "" when it offers none — a policy
 *  answer is never typed into a dropdown that does not offer it. */
function offered(options: string[] | null | undefined, answer: string): string {
  const want = optNorm(answer);
  return (options ?? []).find((o) => optNorm(o) === want) ?? "";
}

/**
 * The answer THIS job gives a required control the recipe has no step for, or null when the control
 * is not one this module knows. Pure. A "bound" answer with no value, and an "unbound" one, are
 * never typed: the replay stops by name.
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

  // A DISCONNECT PART binds to the AC disconnect's keys only when it IS the AC disconnect's
  // (readDisconnectPart); another piece of equipment's is recognized, never bound, and stops.
  const part = readDisconnectPart(label);
  if (part && !part.acDisconnect) return { kind: "unbound", why: OTHER_DISCONNECT_WHY };
  if (part) return { kind: "bound", key: part.key, value: String(fieldValues?.[part.key] ?? "").trim() };

  if (isDropdown) {
    const perJob = perJobAnswerKeyFor(label, { control: perJobControlOfField({ fieldType: type, options }), answer: "", options });
    if (perJob) {
      const own = String(fieldValues?.[perJob] ?? "").trim();
      if (own) return { kind: "bound", key: perJob, value: own };
      // THE STANDING ANSWER IS LOOKED UP BY THE KEY, never re-derived from the wording (PR #353 round
      // 2): the per-job rule already decided WHICH question this is, and the operator's standing
      // answers are keyed by that question (shared OPERATOR_POLICY_ANSWERS — the table the intake
      // reads). Matching the label against the learner's regexes instead stopped the run on four
      // wordings of the distance question those regexes do not carry. Off with the policy answers
      // (scope "none"): the job answers, or the run stops by name.
      const standing = scope === "none" ? "" : offered(options, operatorPolicyAnswer(perJob));
      if (standing) return { kind: "policy", value: standing, why: "the operator's standing answer (this job recorded none)" };
      return { kind: "bound", key: perJob, value: "" };
    }
    const policy = offered(options, policyDefaultAnswerFor(label, scope));
    if (policy) return { kind: "policy", value: policy, why: "the operator's standing policy answer" };
  }
  return null;
}

/** Why a bound key has no value, in the operator's terms — the stop names it. null = no project key
 *  answers the control (another piece of equipment's disconnect part). */
export function missingValueHint(key: string | null): string {
  if (key === null) return OTHER_DISCONNECT_WHY;
  if (/^disconnect(Make|Model|MakeModel)$/.test(key)) {
    return "no AC disconnect part is on file (the plan set names none and the client has no standard disconnect make/model, or the standard part conflicts with the plan set; QC says which)";
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
export function missingRequiredStopMessage(before: string, missing: MissingRequired[]): string {
  const names = missing.map((m) => `"${String(m.label ?? "").replace(/\s+/g, " ").trim().slice(0, 60)}"`).join(", ");
  const hints = Array.from(new Set(missing.map((m) => missingValueHint(m.key))));
  const them = missing.length === 1 ? "it" : "them";
  return `Stopped before ${before}: this page requires ${names} and no value was supplied for this project — ${hints.join("; ")}. `
    + `Nothing was typed into ${them} and the page was not left: add the value and stage again, or enter ${them} in the browser before submitting.`;
}
