// DOES THIS JOB LIMIT ITS EXPORT? — ONE DERIVATION FOR LEARN AND REPLAY (issue #356).
//
// NEM portals ask a REQUIRED "Do you propose to limit the export capacity of this system?". The
// answer was derived twice: the replay map (backend resolveRecipeFieldValues) read only the parser
// snapshot's exportMode / pcs / exportLimit, and the learner (autoLearn buildPortalPlanner) read
// those plus the design notes — so a job whose PCS / export limit sat only in the design notes was
// "Yes" at learn and "No" at replay. Both now read THIS, through the replay map.
//
// And the replay map's "No" meant two things: "the job says it exports" and "nothing on the job says
// either way" (the default). PR #353 answers an unrecorded export question from exportLimiting and
// noted it "from exportLimiting", so a default read as the job's own answer. The value stays "Yes" /
// "No" (a recorded step bound to exportLimiting fills what it always filled, and the planner still has
// an answer for the required radio), and the replay map carries, beside it, whether the job gave any
// evidence at all: EXPORT_LIMITING_NO_EVIDENCE_KEY = "1" when it gave none, "" when it did. With no
// evidence the "No" is the operator's standing answer (autoLearnAdapter POLICY_RADIO_DEFAULTS gives
// the export-capacity question "No"), and a replay that types it says so ("standing answer, no
// evidence on the job" — portal-bot unrecordedControls). Owner's 2026-10-18 "Data is enough": the run
// goes ahead on the standing answer rather than stopping.
//
// WHY A ONE-CHARACTER FLAG AND NOT A WORD ("job" / "none"). The replay map is matched by VALUE: the
// post-learn binder indexes every value of two characters or more (portalRecipes
// convertLiteralsToBoundFields), and the gap-fill grounds a free-text answer that is a substring of
// any project value (llmGapFill isGrounded). A "none" or "job" there would bind a recorded "None" to
// this key, and ground a guessed "Job site" as project data. "1" / "" is under both thresholds.
//
// SAFETY RULE 2: the design notes are read here in the backend only, by a regex; nothing is sent to a
// model. The flag is kept out of the planner's view (autoLearn plannerFieldView), so the planner still
// gets the same fields and the digest.

/** The replay-map key beside exportLimiting: "1" = the job carries no export-limiting evidence either
 *  way, so exportLimiting's "No" is the standing answer; "" = exportLimiting is the job's own answer. */
export const EXPORT_LIMITING_NO_EVIDENCE_KEY = "exportLimitingNoEvidence";

// The parser's long narrative texts — the ones the learner's design digest (autoLearn
// designNotesDigest) reads its decision lines from, and the design notes this derivation reads.
// One list for the digest, the planner's view (plannerFieldView) and this; it lives here so the
// replay resolver can read it without importing the learner.
export const DESIGN_NOTE_SOURCES = [
  "sitePlanNotesText", "roofPlanNotesText", "projectDescriptionText", "electricalCalcText",
  "structuralCalcText", "labelsText", "reviewFlags", "utilityUploadNotesText", "planSetExtractedText",
] as const;

// Export-limiting evidence: the words the learner and the resolver both tested (unchanged).
const EVIDENCE = /non.?export|export.?limit\b|power control system|\bpcs\b|\bngom\b/i;
// The same words, NEGATED where they stand: "NO PCS", "not export limited", "without a power control
// system". Removed before EVIDENCE is tested, and read as the design's explicit "No" — the shared
// regex alone took "NO EXPORT LIMIT" for a "Yes".
const NEGATED = /\b(?:no|not|without)\s+(?:an?\s+|any\s+)?(?:export.?limit\w*|power control system|pcs)\b/gi;
// "UL 1741 PCS" (and its "PCS CRD" listing) is an inverter's CERTIFICATION, printed on data sheets
// whether or not the job limits its export: never evidence. Read in the design notes only.
const PCS_LISTING = /\bul\s*1741\s*(?:-?\s*(?:sa|sb|crd))?[\s,/-]*pcs(?:\s*crd)?\b|\bpcs\s*crd\b/gi;
// An explicit structured "no" (pcs / exportLimit / exportLimiting): the design states there is none.
const NO_WORD = /^(?:no|none|n\/?a|false|n)$/i;
const YES_WORD = /^(?:yes|true|y)$/i;

export interface ExportLimitingAnswer {
  value: "Yes" | "No";
  /** "job": the job's own evidence decided it (either way). "none": nothing on the job says either
   *  way, so "No" is the standing answer. */
  evidence: "job" | "none";
}

/**
 * THE ONE exportLimiting DERIVATION. `snapshot` is the project's parser snapshot (structured keys and
 * the design-note texts); `existingExportMode` the existing-system block's exportMode (normalize.ts
 * copies it from the same snapshot key; intake can set it too). Pure.
 *
 *   - "Yes" (job) when ANY source shows export limiting: exportMode non-export-pcs / ngom, a pcs /
 *     exportLimit value naming it (or a yes, or a kW figure), an explicit exportLimiting "Yes", or a
 *     design-note line naming a PCS / power control system / export limit / non-export / NGOM that
 *     is not negated where it stands and is not a UL 1741 PCS listing. Evidence of a limit wins over
 *     a "No" elsewhere, as both derivations had it.
 *   - "No" (job) when the design says it exports: exportMode "export", a pcs / exportLimit /
 *     exportLimiting "No" / "None" / "N/A", or a negated design-note line ("NO PCS").
 *   - "No" (none) otherwise — the standing answer, not the job's.
 */
export function exportLimitingFor(snapshot: Record<string, unknown> | null | undefined, existingExportMode?: unknown): ExportLimitingAnswer {
  const snap = (snapshot ?? {}) as Record<string, unknown>;
  const scalar = (v: unknown): string => (v == null || typeof v === "object" ? "" : String(v).trim());
  let yes = false;
  let no = false;

  for (const mode of [scalar(snap.exportMode), scalar(existingExportMode)]) {
    if (!mode) continue;
    if (/^export$/i.test(mode)) no = true;
    else if (EVIDENCE.test(mode)) yes = true;
  }
  for (const key of ["pcs", "exportLimit", "exportLimiting"]) {
    const v = scalar(snap[key]);
    if (!v) continue;
    if (NO_WORD.test(v)) no = true;
    else if (YES_WORD.test(v) || EVIDENCE.test(v) || (key === "exportLimit" && /\d/.test(v))) yes = true;
  }
  for (const key of DESIGN_NOTE_SOURCES) {
    const text = typeof snap[key] === "string" ? (snap[key] as string) : "";
    if (!text) continue;
    for (const line of text.split(/[\n.;]+/)) {
      const t = line.replace(/\s+/g, " ").replace(PCS_LISTING, " ");
      const rest = t.replace(NEGATED, " ");
      if (EVIDENCE.test(rest)) yes = true;
      else if (rest !== t) no = true;
    }
  }
  if (yes) return { value: "Yes", evidence: "job" };
  return { value: "No", evidence: no ? "job" : "none" };
}
