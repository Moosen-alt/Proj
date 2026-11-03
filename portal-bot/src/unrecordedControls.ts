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
//      part, else the client's standard part). Never another project's literal, and never a
//      disconnect whose label says anything but AC-disconnect words (an ALLOW-list: a DC,
//      rapid-shutdown, storage, EVSE, gateway or transfer-switch disconnect, or a qualifier the list
//      does not carry): that part is recognized, never bound, and stops the run by name.
//   2. A PER-JOB QUESTION only a person answers (shared perJobAnswerKeyFor — the same predicate as
//      the question bank, the binders and the stage gate): the job's own recorded answer; when the job
//      has none, the operator's standing answer for THAT KEY if there is one (below); else nothing.
//   3. A POLICY QUESTION — the learner's own table (autoLearnAdapter policyDefaultAnswerFor), so a
//      learn and a replay give one question one answer. When the job itself carries the answer
//      (a learner rule's own `jobKey`, read through POLICY_QUESTION_JOB_KEYS: the export-capacity
//      question ↔ exportLimiting), the job's value, bound to that key; the standing answer when the
//      key is absent or empty, or when the replay map says the job carries no evidence for it (#356:
//      exportLimiting's "No" is then the standing answer, and the note says so).
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
import { operatorPolicyAnswer, perJobAnswerKeyFor, perJobControlOfField, perJobRuleFor } from "../../shared/src/perJobQuestions";
import { isSubmitIntent } from "../../shared/src/portalSafety";
import { EXPORT_LIMITING_NO_EVIDENCE_KEY } from "../../shared/src/exportLimiting";
import { isSensitiveLabel, POLICY_RADIO_DEFAULTS, policyDefaultRuleFor, type PolicyScope } from "./adapters/autoLearnAdapter";
import { isSubmitIntentField } from "./llmGapFill";

export type DisconnectPartKey = "disconnectMake" | "disconnectModel" | "disconnectMakeModel";

/**
 * THE ONLY WORDS THAT MAY SIT BESIDE THE PART WORD IN AN AC DISCONNECT'S LABEL — an ALLOW-list
 * (PR #353 round 3). Round 2 kept a DENY-list of other equipment, and it failed open: every
 * equipment it did not list ("EVSE Disconnect Manufacturer", "Backup Gateway Disconnect Model",
 * "Transfer Switch Disconnect Manufacturer", "Subpanel…", "Load center…", "Wind turbine…", "Fuel
 * cell…") read as the AC disconnect and got the client's standard AC part. Now a label binds only
 * when EVERY word left after the part word is one of these; any other word — a piece of equipment,
 * a side, a location, a rating — is unknown, the control is recognized but never bound, and the run
 * stops by name. That costs a few AC wordings a stop ("Inverter AC Disconnect", "Fused AC
 * Disconnect", "Production Meter Disconnect"…): the safe direction, and named in the stop.
 *
 * Each word, and why it can only mean the AC disconnect:
 *   ac                         — the AC side, named ("AC Disconnect"; "A.C." is normalised to it).
 *   disconnect, disconnects    — the thing itself ("Disconnect(s)" reads as "disconnects").
 *   switch                     — PacifiCorp's own bare "Disconnect Switch Manufacturer / Model".
 *   utility, external          — the utility's (external) disconnect switch: the utility-accessible
 *                                AC disconnect, never a DC or a storage one.
 *   visible, lockable          — the utilities' own requirement wording for that same switch
 *                                ("visible, lockable disconnect").
 *   the, of, for               — connecting words; they name nothing.
 * Left out on purpose: "disconnecting means" (the NEC's words for ANY disconnect, a PV DC one
 * included — and the detection below needs the word "disconnect" itself), "fused" / "non-fused"
 * (a DC disconnect is fused too), "pv" / "solar" (either side), "inverter", "main", "service",
 * "meter" (other equipment, or a location that does not say which side).
 */
const AC_DISCONNECT_WORDS = new Set([
  "ac", "disconnect", "disconnects", "switch",
  "utility", "external", "visible", "lockable", "the", "of", "for",
]);

/** The words a disconnect-part label says besides its part word — lower-cased, punctuation gone.
 *  The part words removed are the ones the key is read from (manufacturer / make / brand / mfr / mfg /
 *  model), with what qualifies them as a part ("model number", "model no.", "model #", "manufacturer
 *  name"). */
function qualifierWords(label: string): string[] {
  return String(label ?? "").toLowerCase()
    .replace(/\ba\.c\.?(?=[^a-z0-9]|$)/g, " ac ")
    .replace(/\(s\)/g, "s")
    .replace(/\b(?:manufacturer|make|brand|mfr|mfg|model)\b(?:\s*(?:name|number|no)\b\.?|\s*#)?/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/**
 * A DISCONNECT PART a control asks for (its make, model, or both), and whether it is THE AC DISCONNECT's
 * — or null when the control asks for no disconnect part. Never a question ("Is the disconnect
 * lockable?") and never a long prose label.
 *
 * `acDisconnect` is true only when every word beside the part word is an AC-disconnect word
 * (AC_DISCONNECT_WORDS): PacifiCorp's bare "Disconnect Switch Manufacturer", "AC Disconnect Model".
 * Anything else — a DC, rapid-shutdown, inverter, storage, EV charger (EVSE), gateway, transfer
 * switch, subpanel or turbine disconnect, or a qualifier this list does not carry — is false, so the
 * AC part's Eaton DG221URB is never filed into it (PR #353 rounds 2 and 3).
 */
export function readDisconnectPart(label: string): { key: DisconnectPartKey; acDisconnect: boolean } | null {
  const t = String(label ?? "").replace(/\s+/g, " ").trim();
  if (!t || t.length > 80 || /\?/.test(t)) return null;
  if (!/\bdisconnect(?:s|\(s\))?\b/i.test(t)) return null;
  const make = /\b(manufacturer|make|brand|mfr|mfg)\b/i.test(t);
  const model = /\bmodel\b/i.test(t);
  const key: DisconnectPartKey | null = make && model ? "disconnectMakeModel" : make ? "disconnectMake" : model ? "disconnectModel" : null;
  if (!key) return null;
  const words = qualifierWords(t);
  return { key, acDisconnect: words.length > 0 && words.every((w) => AC_DISCONNECT_WORDS.has(w)) };
}

/**
 * THE AC DISCONNECT PART a control asks for, or null — by its own words. "Disconnect Switch
 * Manufacturer" → disconnectMake, "Disconnect Switch Model" → disconnectModel, "AC Disconnect
 * Make/Model" → disconnectMakeModel. Never a question, never a long prose label, and never a
 * disconnect whose label says anything besides AC-disconnect words (readDisconnectPart's allow-list) —
 * those are never bound to the AC disconnect's keys.
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
  /** A control this module recognizes that NO project key answers — a disconnect part whose label
   *  names something besides the AC disconnect (DC, rapid shutdown, storage, EVSE, a gateway, a
   *  transfer switch, or a word the allow-list does not carry). Never typed: the AC disconnect's
   *  part is never filed into it. The run stops by name. */
  | { kind: "unbound"; why: string };

/** A required control this job has no value for, named in the stop. `key` is the project key it binds
 *  to, or null when no project key answers it (an "unbound" answer). `why`, when set, is the reason
 *  in place of missingValueHint(key) — the replay's own reason (the value is on file but the control
 *  the sweep named could not be pinned to exactly one element, so nothing was typed). */
export interface MissingRequired {
  label: string;
  key: string | null;
  why?: string;
}

const OTHER_DISCONNECT_WHY = "it asks for another piece of equipment's disconnect, or a disconnect its label does not name as the AC disconnect (a DC, rapid-shutdown, inverter, storage, EVSE, gateway or transfer-switch disconnect, or a qualifier the AC words do not cover), and only the AC disconnect's make and model are on file, so no project value answers it";

/** The stop's reason when a value IS on file but the empty required control the sweep named could
 *  not be pinned to exactly one element on the page (PR #353 round 3): several empty controls share
 *  its name, or the one named could not be found again. Writing by label then is how a value lands in
 *  a namesake ("Disconnect Switch Model Notes") instead — so nothing is typed. */
export const UNPINNED_CONTROL_WHY = "a value is on file, but the empty control by that name could not be told apart from another on this page (several share the name, or the one named could not be found again), so it was not typed into a box that might be the wrong one";

/**
 * A POLICY QUESTION WHOSE ANSWER THE JOB ALSO CARRIES (PR #353 round 4) — the replay-map key that
 * answers it ahead of the learner's standing answer. DATA, consulted only where the learner's policy
 * table (policyDefaultAnswerFor) already answers the question in this scope, so it never widens or
 * narrows which controls or which recipes get an answer; it only says WHOSE answer that is.
 *
 * ONE SOURCE: the learner's table (autoLearnAdapter POLICY_RADIO_DEFAULTS). A rule gets a job key by
 * carrying `jobKey` THERE; this list is derived from it and holds each such rule's own RegExp object —
 * never a copy (issue #352 review: a copied regex would not follow a widened learner wording), and
 * unrecordedControls.test pins that every entry IS the learner rule's regex, by identity.
 *
 * Today one rule carries a key: "Do you propose to limit the export capacity of this system?" ↔
 * `exportLimiting`. The table's standing answer is "No", but the replay map carries the job's own
 * `exportLimiting` (backend resolveRecipeFieldValues: "Yes" when the design shows a PCS / export
 * limit / non-export / NGOM), and the round-3 pass filed the standing "No" on an export-limited job.
 * The per-job rule does not catch this wording (per-job:export-limit reads "export limit", not "limit
 * the export capacity").
 *
 * No other policy rule carries a key: lab-certified / UL 1741, the distance question (a per-job key,
 * answered above by perJobAnswerKeyFor), public school, kWh netting, monetize, knife-blade, meter
 * collar and drone consent match nothing resolveRecipeFieldValues emits (its own keys or the parser
 * snapshot's).
 */
export const POLICY_QUESTION_JOB_KEYS: ReadonlyArray<Readonly<{ question: RegExp; key: string }>> = Object.freeze(
  POLICY_RADIO_DEFAULTS.flatMap((rule) => (rule.jobKey ? [Object.freeze({ question: rule.question, key: rule.jobKey })] : [])),
);

/**
 * NO EVIDENCE ON THE JOB (#356). The replay map always carries exportLimiting ("Yes" / "No", so a
 * recorded step bound to it fills), and beside it EXPORT_LIMITING_NO_EVIDENCE_KEY = "1" when nothing on
 * the job says either way (backend resolveRecipeFieldValues, shared exportLimitingFor). Its "No" is then
 * the operator's standing answer, not the job's: it is typed as the standing answer and noted as one,
 * never "from exportLimiting". An explicit "No" from the design leaves the flag "" and stays bound.
 */
const NO_EVIDENCE_KEYS: Readonly<Record<string, string>> = Object.freeze({ exportLimiting: EXPORT_LIMITING_NO_EVIDENCE_KEY });
export const NO_JOB_EVIDENCE_WHY = "standing answer, no evidence on the job";
function noJobEvidence(fieldValues: Record<string, string>, key: string): boolean {
  const flag = NO_EVIDENCE_KEYS[key];
  return !!flag && String(fieldValues?.[flag] ?? "").trim() === "1";
}

/** The replay-map key that carries this job's own answer to a policy question, or null. */
function policyQuestionJobKeyFor(question: string): string | null {
  const text = String(question ?? "");
  return POLICY_QUESTION_JOB_KEYS.find((p) => p.question.test(text))?.key ?? null;
}

/**
 * A QUESTION ABOUT SUBMITTING IS NEVER ANSWERED HERE (Helm review of PR #353, item 3). "Are you ready
 * to submit your Net Metering (kWh) application?" matched the kWh-netting rule and got its standing
 * "Yes"; "Submit as final? (UL 1741 certified inverters only)" matched UL 1741 and got "Yes". A
 * standing answer to a policy question is not a person's decision to file. So: the shared submit
 * predicate (portalSafety isSubmitIntent), the gap-fill's own (isSubmitIntentField — the one #373's
 * picks are refused by), and the wordings neither carries ("final", "ready to be submitted",
 * "complete and ready"). Such a control gets no answer: it stays empty, and the run stops on it by
 * name (the sweep's required-still-empty, or the stamped draft click's refusal).
 */
const SUBMIT_INTENT_EXTRA = /\bfinal\b|\bready\s+(?:to\s+be|for)\s+submi|\bcomplete\s+and\s+ready\b/i;
export function readsAsSubmitIntent(label: string): boolean {
  const t = String(label ?? "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  return isSubmitIntent(t, null) || isSubmitIntentField(t) || SUBMIT_INTENT_EXTRA.test(t);
}

/**
 * A NEGATED STATEMENT GETS NO STANDING ANSWER (Helm review of PR #353, item 4). The rules are written
 * for the question in its plain form: "public school project" → "No" is right for "Is this a public
 * school project?" and wrong for "I certify this is NOT a public school project". So when not / no /
 * never / none (or a "-n't", or "cannot") sits in the SENTENCE the rule matched, the control gets no
 * answer and the run stops on it by name. The sentence, not the label: a label is often a preamble
 * and a question, and a "no" in the preamble says nothing about the question. A rule whose match
 * spans sentences is read against the whole label. "No less than 5\" by 7\"" (the knife-blade
 * signage wording) and a "Yes/No" hint are comparisons and options, not negations.
 */
const NEGATION = /\b(?:not|no|never|none|cannot)\b|\b\w+n['’]t\b/i;
const NOT_A_NEGATION = /\bno\s+(?:less|more|later|earlier|greater|fewer|smaller|larger|longer|shorter)\s+than\b|\byes\s*\/\s*no\b/gi;
export function negatedWhereMatched(label: string, rule: RegExp): boolean {
  const text = String(label ?? "").replace(/\s+/g, " ").trim();
  const sentences = text.split(/(?<=[.?!])\s+/).filter(Boolean);
  const hit = sentences.filter((sen) => rule.test(sen));
  return (hit.length ? hit : [text]).some((sen) => NEGATION.test(sen.replace(NOT_A_NEGATION, " ")));
}

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
  // NEVER A STANDING ANSWER TO "SUBMIT?" (item 3): no answer, so the run stops on it by name.
  if (readsAsSubmitIntent(label)) return null;

  // A DISCONNECT PART binds to the AC disconnect's keys only when its label says nothing but
  // AC-disconnect words (readDisconnectPart's allow-list); any other is recognized, never bound,
  // and stops.
  const part = readDisconnectPart(label);
  if (part && !part.acDisconnect) return { kind: "unbound", why: OTHER_DISCONNECT_WHY };
  if (part) return { kind: "bound", key: part.key, value: String(fieldValues?.[part.key] ?? "").trim() };

  if (isDropdown) {
    const perJob = perJobAnswerKeyFor(label, { control: perJobControlOfField({ fieldType: type, options }), answer: "", options });
    if (perJob) {
      // A NEGATED STATEMENT (item 4): neither the job's answer nor the standing one — both answer
      // the plain question. No answer; the run stops on it by name.
      const rule = perJobRuleFor(label);
      if (rule && negatedWhereMatched(label, rule.re)) return null;
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
    const rule = policyDefaultRuleFor(label, scope);
    const standing = rule?.answer ?? "";
    if (rule && standing) {
      // A NEGATED STATEMENT (item 4): no answer, the run stops on it by name.
      if (negatedWhereMatched(label, rule.question)) return null;
      // THE JOB'S OWN ANSWER FIRST, when the job carries one (POLICY_QUESTION_JOB_KEYS): bound to its
      // key, so the step selects the job's value. `value` is the control's own option for it, the gate
      // for typing at all: a job value the dropdown does not offer is "" — never the standing answer
      // in its place — and the run stops by name.
      const jobKey = policyQuestionJobKeyFor(label);
      const own = jobKey ? String(fieldValues?.[jobKey] ?? "").trim() : "";
      // With no evidence on the job (#356) its value is the default, not its answer: the standing
      // answer below, noted honestly.
      const noEvidence = !!jobKey && !!own && noJobEvidence(fieldValues, jobKey);
      if (jobKey && own && !noEvidence) return { kind: "bound", key: jobKey, value: offered(options, own) };
      const policy = offered(options, standing);
      if (policy) return { kind: "policy", value: policy, why: noEvidence ? NO_JOB_EVIDENCE_WHY : "the operator's standing policy answer" };
    }
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
  if (key === "exportLimiting") {
    return "the project's export-limiting answer (exportLimiting) is not one this control offers, so it was not replaced with the standing answer";
  }
  return `the project has no value for ${key}`;
}

/**
 * The stop's message: the controls BY NAME first (a downstream reader keeps ~300 characters), then
 * why there is no value. "no value was supplied" is deliberate — backend replayFailureBlamesRecipe
 * reads it as the project's missing data, so the recipe is kept, never demoted or flagged for it
 * (pinned in backend/test/replayDemotion.test.ts). When every control's reason is the replay's own
 * (`why`: the value is on file but the control could not be pinned), the words say "by this run"
 * and the remedy is the browser, not the project's data.
 */
export function missingRequiredStopMessage(before: string, missing: MissingRequired[]): string {
  const names = missing.map((m) => `"${String(m.label ?? "").replace(/\s+/g, " ").trim().slice(0, 60)}"`).join(", ");
  const hints = Array.from(new Set(missing.map((m) => m.why || missingValueHint(m.key))));
  const them = missing.length === 1 ? "it" : "them";
  const allPinning = missing.length > 0 && missing.every((m) => !!m.why);
  return `Stopped before ${before}: this page requires ${names} and no value was supplied ${allPinning ? "by this run" : "for this project"} — ${hints.join("; ")}. `
    + `Nothing was typed into ${them} and the page was not left: ${allPinning ? `enter ${them} in the browser before submitting.` : `add the value and stage again, or enter ${them} in the browser before submitting.`}`;
}
