// ---------------------------------------------------------------------------
// A SUBMIT THAT ONLY MADE A DRAFT (#302) — what the backend does with it.
//
// PSE's PowerClerk tenant files in two parts: Part 1's Submit answers "Your draft application
// NEM-… has been created. Please continue to Interconnection Application - Part 2 to complete
// … and submit", and the filing is Part 2's own submit. When the page after a person's submit
// click reads that way (portal-bot draftCreated.ts), three things follow, and only these:
//
//   1. NOTHING WAS FILED. No submission is recorded and no record number is written — the
//      draft's number is not a filing's (captureConfirmation is never called for it).
//   2. THE DRAFT IS WRITTEN DOWN (an audit row, and the run's result_json when the run is known),
//      so the next stage opens THAT draft's next form instead of starting a second application
//      for the same house (owner ruling 2026-10-10: a second NEM number is a failure).
//   3. THE RECIPE STEP THAT WAS RECORDED AS THE FINAL SUBMIT STOPS BEING ONE — but only the step
//      whose label is what the person clicked, and only on the page's "created" wording, never on
//      a bare status. The heal can only REMOVE an isFinalSubmit flag: it never adds one, moves one,
//      or touches another step, so it can only make FEWER steps count as final (hard rule 1).
//      The stopForReview in front of it stays: a person still clicks that Submit.
// ---------------------------------------------------------------------------
import type { ProjectRecord, RecipeStep } from "../../shared/src/types";
import { addAuditLog } from "./audit";
import type { AppDb } from "./db";
import { asJson, parseJson, text as s } from "./json";
import { recipeStructureSignature, upsertRecipeNote } from "./portalRecipes";
import { nowIso } from "./time";

export const DRAFT_CREATED_ACTION = "portal.draft_created";

/** What portal-bot reported (draftCreated.ts DraftCreatedRead + the clicked control's label). */
export interface ObservedDraft {
  applicationNumber: string;
  nextForm: string;
  evidence: string;
  strength: "created" | "status" | "";
  clickedLabel?: string;
}

export interface PortalDraftRecord {
  applicationNumber: string;
  nextForm: string;
  track: string;
  recordedAt: string;
}

type Row = Record<string, unknown>;

const labelKey = (v: unknown): string => s(v).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The visible label a recorded click step was recorded under. */
function stepLabel(step: RecipeStep): string {
  const sel = (step.selector ?? {}) as Record<string, unknown>;
  return s(sel.name) || s(sel.text) || s(sel.label);
}

/**
 * THE HEAL (3 above). Returns what it did; never throws. Written only over the exact steps text it
 * read, so a human edit in between makes it a no-op (persistHealedSteps' discipline).
 */
export function healDraftCreatingFinalSubmit(
  db: AppDb,
  recipeId: string,
  draft: ObservedDraft,
  ctx: { projectId?: string | null; runId?: string | null } = {},
): { healed: boolean; why: string } {
  try {
    if (draft.strength !== "created") return { healed: false, why: "only a record status said draft — that never rewrites a recipe step" };
    const row = db.get<Row>("SELECT steps_json, notes FROM portal_recipes WHERE id = ?", [recipeId]);
    if (!row) return { healed: false, why: "the recipe no longer exists" };
    const steps = parseJson<RecipeStep[]>(s(row.steps_json) || "[]", []);
    const idx = steps.findIndex((st) => st && st.isFinalSubmit === true);
    if (idx < 0) return { healed: false, why: "no step of the recipe is flagged as the final submit" };
    const recorded = stepLabel(steps[idx]);
    const clicked = s(draft.clickedLabel);
    // THE RECORDED LABEL IS THE MATCHING KEY: the person must have clicked the step the recipe
    // calls final. An unknown click, or a different control, heals nothing.
    if (!clicked || !recorded || labelKey(clicked) !== labelKey(recorded)) {
      return { healed: false, why: `the click ("${clicked || "unknown"}") is not the recipe's final step ("${recorded || "unlabelled"}")` };
    }
    const { isFinalSubmit: _dropped, ...rest } = steps[idx];
    void _dropped;
    const where = draft.nextForm ? ` — the filing is in "${draft.nextForm}"` : "";
    steps[idx] = { ...rest, note: [s(rest.note), `creates a draft, not the filing (#302)${where}`].filter(Boolean).join(" | ") };
    const note = `[draft-creating submit ${nowIso().slice(0, 10)}: step ${idx + 1} ("${recorded}") only creates a draft${draft.applicationNumber ? ` (seen as ${draft.applicationNumber})` : ""}${where}; it is no longer the recipe's final submit]`;
    db.run(
      `UPDATE portal_recipes SET steps_json = ?, structure_sig = ?, auto_submit_enabled = 0, notes = ?, updated_at = ?
        WHERE id = ? AND steps_json = ?`,
      [asJson(steps), recipeStructureSignature(steps), upsertRecipeNote(row.notes, "draft-creating submit", note), nowIso(), recipeId, s(row.steps_json)],
    );
    if (Number(db.get<{ n: number }>("SELECT changes() AS n")?.n ?? 0) === 0) return { healed: false, why: "the recipe changed while the page was being read" };
    addAuditLog(db, ctx.projectId ?? null, "system", "submit capture", "portal_recipe.draft_submit_healed", {
      recipeId, stepIndex: idx, label: recorded.slice(0, 80), nextForm: draft.nextForm.slice(0, 90), runId: ctx.runId ?? null,
    });
    return { healed: true, why: `step ${idx + 1} ("${recorded}") is no longer flagged as the final submit` };
  } catch (err) {
    return { healed: false, why: `heal failed: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}` };
  }
}

/** 1 + 2 + 3 above, for either path (the learn's left-open window, or a replay's). Never throws. */
export function recordPortalDraft(
  db: AppDb,
  input: { projectId: string; track: string; draft: ObservedDraft; runId?: string | null; recipeId?: string | null; source: "learn" | "replay" },
): { healed: boolean; why: string } {
  const { projectId, track, draft } = input;
  const details = {
    track, applicationNumber: s(draft.applicationNumber).slice(0, 40), nextForm: s(draft.nextForm).slice(0, 90),
    strength: draft.strength, source: input.source, runId: input.runId ?? null, recipeId: input.recipeId ?? null,
    evidence: s(draft.evidence).replace(/\d{4,}/g, (m) => (s(draft.applicationNumber).includes(m) ? m : "####")).slice(0, 240),
  };
  try { addAuditLog(db, projectId, "portal_bot", "submit capture", DRAFT_CREATED_ACTION, details); } catch { /* best-effort */ }
  if (input.runId) {
    try {
      const run = db.get<Row>("SELECT result_json FROM portal_runs WHERE id = ?", [input.runId]);
      if (run) {
        const result = parseJson<Record<string, unknown>>(s(run.result_json) || "{}", {});
        db.run("UPDATE portal_runs SET result_json = ? WHERE id = ?", [asJson({ ...result, draftCreated: details }), input.runId]);
      }
    } catch { /* the audit row is the record the next stage reads */ }
  }
  return input.recipeId
    ? healDraftCreatingFinalSubmit(db, input.recipeId, draft, { projectId, runId: input.runId ?? null })
    : { healed: false, why: "no recipe to heal" };
}

/**
 * The project's open draft on this track: the latest one recorded, unless a filing on the track
 * was recorded after it (the draft was then completed and submitted). null = none on record.
 */
export function openPortalDraftFor(db: AppDb, projectId: string, track = "nem"): PortalDraftRecord | null {
  const rows = db.query<Row>(
    "SELECT details, created_at FROM audit_logs WHERE project_id = ? AND action = ? ORDER BY created_at DESC, rowid DESC LIMIT 20",
    [projectId, DRAFT_CREATED_ACTION],
  );
  for (const r of rows) {
    const d = parseJson<Record<string, unknown>>(s(r.details) || "{}", {});
    if (s(d.track) !== track) continue;
    const recordedAt = s(r.created_at);
    const filedSince = db.get<Row>(
      "SELECT id FROM submissions WHERE project_id = ? AND permit_type = ? AND status = 'submitted' AND COALESCE(submitted_at, created_at) >= ? LIMIT 1",
      [projectId, track, recordedAt],
    );
    if (filedSince) return null;
    return { applicationNumber: s(d.applicationNumber), nextForm: s(d.nextForm), track, recordedAt };
  }
  return null;
}

/**
 * What the draft's continuation needs and the project lacks (#302). PSE's Part 2 step 1
 * "Customer Information" validates the utility account number, the existing meter's serial,
 * the customer's name as on the bill and the service address against its own records. Names
 * only — never a value (the account and meter bind by name at the fill, hard rule 2).
 */
export function draftContinuationGaps(p: Pick<ProjectRecord, "accountNumber" | "meterNumber" | "homeownerName" | "projectAddress">): string[] {
  const gaps: string[] = [];
  if (!s(p.accountNumber).trim()) gaps.push("the utility account number");
  if (!s(p.meterNumber).trim()) gaps.push("the meter number");
  if (!s(p.homeownerName).trim()) gaps.push("the customer's name as on the bill");
  if (!s(p.projectAddress).trim()) gaps.push("the service address");
  return gaps;
}
