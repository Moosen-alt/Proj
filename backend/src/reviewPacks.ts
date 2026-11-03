// ---------------------------------------------------------------------------
// Review packs — the HYBRID review-gate engine (general building plans).
//
// A "pack" is how a work type gets reviewed:
//   - solar_pv_residential — the DETERMINISTIC pack: the full reviewer engine
//     (code rules + plan-set/permit-path/utility checks). Findings carry full
//     authority; blockers gate staging.
//   - everything else (reroof, water_heater, adu, deck, general) — served by
//     the LLM GENERAL REVIEW mode: Claude vision over the rendered plan pages,
//     grounded in the jurisdiction's adopted-codes context. Those findings are
//     ALWAYS advisory: category "ai_review", severity capped at warning, never
//     counted as blockers, and explicitly labeled AI-assisted pre-review.
// The AI mode can also run ALONGSIDE the solar pack as a second opinion.
//
// Adding a deterministic pack for a new work type = add an entry here with an
// `evaluate` and it automatically takes authority over the AI-only mode.
// ---------------------------------------------------------------------------
import type {
  AiPlanReviewResult,
  LLMProvider,
  ProjectRecord,
  ReviewerFinding,
  ReviewerReport,
  ReviewWorkType,
} from "../../shared/src/types";
import type { EffectiveCodeContext } from "./codeProfiles";
import { buildReviewerReport } from "./reviewerEngine";
import { nowIso } from "./time";

export interface ReviewPackInfo {
  workType: ReviewWorkType;
  label: string;
  description: string;
  /** True when a hand-built deterministic rule pack exists for this work type. */
  deterministic: boolean;
}

export const REVIEW_PACKS: ReviewPackInfo[] = [
  { workType: "solar_pv_residential", label: "Residential rooftop solar PV", deterministic: true, description: "Full deterministic review: electrical (SLD, interconnection, rapid shutdown), structural prescriptive screens, fire access, equipment schedule — plus optional AI second opinion." },
  { workType: "reroof", label: "Re-roof", deterministic: false, description: "AI-assisted pre-review against the jurisdiction's adopted residential/building code." },
  { workType: "water_heater", label: "Water heater replacement", deterministic: false, description: "AI-assisted pre-review (plumbing/mechanical/energy code signals)." },
  { workType: "adu", label: "Accessory dwelling unit (ADU)", deterministic: false, description: "AI-assisted pre-review: completeness + code-conformance signals for ADU plan sets." },
  { workType: "deck", label: "Deck", deterministic: false, description: "AI-assisted pre-review: footings, ledger, guards, spans per the adopted residential code." },
  { workType: "general", label: "General / other permit", deterministic: false, description: "AI-assisted pre-review for any other permit plan set." },
];

export function reviewPackFor(workType: string): ReviewPackInfo {
  return REVIEW_PACKS.find((p) => p.workType === workType) ?? REVIEW_PACKS[REVIEW_PACKS.length - 1];
}

// Render the jurisdiction context into the grounding text the AI reviewer sees.
export function codeSummaryForPrompt(ctx: EffectiveCodeContext): string {
  const lines: string[] = [];
  for (const c of ctx.adoptedCodes) {
    lines.push(`- ${c.code} ${c.edition}${c.title ? ` (${c.title})` : ""}${c.notes ? ` — ${c.notes}` : ""}`);
  }
  for (const a of ctx.amendments) lines.push(`- LOCAL AMENDMENT ${a.code}${a.section ? ` ${a.section}` : ""}: ${a.summary}`);
  const d = ctx.designCriteria;
  const crit = [
    d.groundSnowLoadPsf != null ? `ground snow ${d.groundSnowLoadPsf} psf` : "",
    d.windSpeedMph != null ? `wind ${d.windSpeedMph} mph` : "",
    d.windExposure ? `exposure ${d.windExposure}` : "",
    d.seismicDesignCategory ? `seismic ${d.seismicDesignCategory}` : "",
    d.frostDepthIn != null ? `frost depth ${d.frostDepthIn} in` : "",
  ].filter(Boolean).join(", ");
  if (crit) lines.push(`- DESIGN CRITERIA: ${crit}`);
  return lines.join("\n");
}

// Map the LLM's advisory observations onto the ReviewerFinding contract. The hard
// caps live HERE (not just in the prompt): category ai_review, severity ≤ warning,
// installerCallout false — so a prompt drift can never mint an AI blocker.
export function aiResultToFindings(ai: AiPlanReviewResult, ctx: EffectiveCodeContext): ReviewerFinding[] {
  const out: ReviewerFinding[] = ai.findings.map((f, i) => ({
    id: `ai.review.${i + 1}`,
    severity: f.severity === "callout" ? "callout" : "warning",
    category: "ai_review",
    title: `[AI pre-review] ${f.title}`,
    message: f.message,
    cityFeedback: f.message,
    designTeamAction: "AI-assisted observation — a human reviewer confirms against the adopted code before acting.",
    evidenceNeeded: f.sheetRef ? [`See ${f.sheetRef}`] : [],
    codeReferences: f.codeFamily
      ? [ctx.citationFor(f.codeFamily, f.codeSection || "", f.title)]
      : [],
    installerCallout: false,
  }));
  // AN INCOMPLETE REVIEW IS NOT A CLEAN ONE (#531). A real provider whose answer was cut off,
  // unreadable or failed says so on the report: an AI section with no findings would otherwise
  // read as "the AI found nothing". A warning, so it asks for action, but category ai_review like
  // every AI item, so it can never block. Anything but an explicit "complete" counts.
  if (ai.provider !== "stub" && ai.completeness !== "complete") {
    const why = ai.notes || "AI review incomplete: the model's answer did not come back whole.";
    const message = `${why} The AI pre-review did not finish, so its findings are partial or missing. An empty AI section here does NOT mean the plan set has no issues.`;
    out.push({
      id: "ai.review.incomplete",
      severity: "warning",
      category: "ai_review",
      title: "[AI pre-review] AI review incomplete",
      message,
      cityFeedback: message,
      designTeamAction: "Re-run the review, or have a human reviewer read the sheets the AI pass could not cover.",
      evidenceNeeded: [],
      codeReferences: [],
      installerCallout: false,
    });
  }
  if (ai.provider === "stub" && ai.notes) {
    out.push({
      id: "ai.review.unavailable",
      severity: "callout",
      category: "ai_review",
      title: "[AI pre-review] Unavailable",
      message: ai.notes,
      cityFeedback: ai.notes,
      designTeamAction: "Configure ANTHROPIC_API_KEY to enable AI-assisted pre-review.",
      evidenceNeeded: [],
      codeReferences: [],
      installerCallout: false,
    });
  }
  return out;
}

/** The summary every reader of an incomplete review sees: the API's aiSummary and the
 *  review_submissions.ai_summary column both take it from here. Empty must never stand for an
 *  incomplete review, because an empty AI summary reads as "nothing found". */
export function withIncompleteSummary(ai: AiPlanReviewResult): AiPlanReviewResult {
  if (ai.provider === "stub" || ai.completeness === "complete") return ai;
  const why = (ai.notes || "AI review incomplete: the model's answer did not come back whole.").slice(0, 400);
  const partial = ai.summary ? ` Partial assessment: ${ai.summary}` : "";
  return { ...ai, summary: `${why} Its findings are partial; this does not mean nothing was found.${partial}`.slice(0, 1500) };
}

/** Run the hybrid review for a work type. The deterministic solar pack keeps its
 *  exact engine path; AI-served work types produce an advisory-only report. */
export async function runReviewPack(input: {
  workType: ReviewWorkType;
  project: ProjectRecord;
  ctx: EffectiveCodeContext;
  llm: LLMProvider;
  /** Rendered plan-page PNGs (base64) for the AI pass; empty = text-only. */
  pageImagesBase64?: string[];
  extractedText?: string;
  /** Also run the AI second opinion beside the deterministic solar pack. */
  includeAiSecondOpinion?: boolean;
}): Promise<{ report: ReviewerReport; ai: AiPlanReviewResult | null }> {
  const pack = reviewPackFor(input.workType);
  const jurisdictionLabel = [input.ctx.ahj, input.ctx.state].filter(Boolean).join(", ") || "the jurisdiction";

  // A call that FAILS is an incomplete review too, on either path: the AI pass was asked for and
  // did not run. (Before #531 the solar second opinion swallowed the error and left nothing on the
  // report; the AI-served path told the reader to configure an API key that was configured.)
  const runAi = async (): Promise<AiPlanReviewResult> => {
    let ai: AiPlanReviewResult;
    try {
      ai = await input.llm.reviewPlanSetGeneral({
        workType: input.workType,
        jurisdictionLabel,
        codeSummary: codeSummaryForPrompt(input.ctx),
        verifiedProfile: input.ctx.verified,
        pageImagesBase64: input.pageImagesBase64 ?? [],
        extractedText: input.extractedText,
        applicantFacts: {
          address: input.project.projectAddress,
          systemSizeDcKw: input.project.systemSizeDcKw ? String(input.project.systemSizeDcKw) : "",
        },
      });
    } catch (err) {
      ai = {
        provider: "claude", completeness: "incomplete", findings: [], summary: "", confidence: "low",
        notes: `AI review incomplete: the AI review call failed (${err instanceof Error ? err.message : String(err)}).`,
      };
    }
    return withIncompleteSummary(ai);
  };

  if (pack.deterministic) {
    const report = buildReviewerReport(input.project, { codeContext: input.ctx });
    let ai: AiPlanReviewResult | null = null;
    if (input.includeAiSecondOpinion && (input.pageImagesBase64?.length || input.extractedText)) {
      ai = await runAi();
      report.findings.push(...aiResultToFindings(ai, input.ctx));
    }
    return { report, ai };
  }

  // AI-served work type: advisory-only report (no deterministic findings exist).
  const ai = await runAi();
  const report: ReviewerReport = {
    projectId: input.project.id,
    generatedAt: nowIso(),
    matchedProcessProfile: null,
    findings: aiResultToFindings(ai, input.ctx),
    installerCallouts: [],
    finalSubmitGate: {
      mustShowAhjPreviewWindow: true,
      finalSubmitButtonAloneIsEnough: false,
      requirements: ["AI-assisted pre-review only — a human plans examiner completes the review."],
    },
  };
  return { report, ai };
}
