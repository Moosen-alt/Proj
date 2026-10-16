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
//      The stopForReview in front of it stays.
//   4. THAT STEP IS STAMPED (#330) — in a SERVER-OWNED row (portal_recipe_draft_submits, migration
//      v49), never in steps_json, which every recipe save can write. The row names the step index,
//      the tenant the draft-created page was on, the label that was clicked, and the signature of the
//      WHOLE recipe it was seen with (recipeStepsSignature). It is written on the heal itself, or on a
//      later draft seen after a person clicked the last step that an earlier heal (its row, or its own
//      audit record) names — never on note text. A replay gets the stamp (draftSubmitStampForReplay)
//      only when the steps it replays are exactly those signed: any edit, relabel, re-aim, self-heal
//      or restore turns the click off until a person's click is again seen to make a draft. The
//      stamp is what lets a replay click that step ITSELF (portal-bot draftSubmitGate.ts), on that
//      tenant only, and only when the page after its click reads as draft-created again. It is never
//      isFinalSubmit, never read by the final-submit gate, and is deleted
//      (disarmDraftCreatingSubmit) the moment a replay's click produced anything but a draft.
// ---------------------------------------------------------------------------
import type { ProjectRecord, RecipeStep } from "../../shared/src/types";
import { addAuditLog } from "./audit";
import type { AppDb } from "./db";
import { asJson, parseJson, text as s } from "./json";
import { recipeStepsSignature, recipeStructureSignature, upsertRecipeNote } from "./portalRecipes";
import { nowIso } from "./time";
import { draftLabelKey, type DraftCreatingStamp } from "../../portal-bot/src/draftSubmitGate";

export const DRAFT_CREATED_ACTION = "portal.draft_created";
/** The incident (#330): a replay clicked a stamped draft-creating submit and the page after it did not read as a draft. */
export const DRAFT_SUBMIT_UNEXPECTED_ACTION = "portal.draft_submit_unexpected";
/** The note the heal writes on the step it healed. Information for a person only: nothing reads it
 *  as evidence (a recipe save can write any note). */
export const DRAFT_HEAL_NOTE = "creates a draft, not the filing (#302)";
/** The heal's own audit record — what lets a step healed before #330 be stamped later. */
export const DRAFT_HEALED_ACTION = "portal_recipe.draft_submit_healed";

/** What portal-bot reported (draftCreated.ts DraftCreatedRead + the clicked control's label). */
export interface ObservedDraft {
  applicationNumber: string;
  nextForm: string;
  evidence: string;
  strength: "created" | "status" | "";
  clickedLabel?: string;
  /** The tenant the draft-created page was on (portal-bot draftSubmitGate.draftTenantKey). Without
   *  it the step is healed but never stamped, so no replay clicks it (#330). */
  tenantKey?: string;
}

export interface PortalDraftRecord {
  applicationNumber: string;
  nextForm: string;
  track: string;
  recordedAt: string;
}

type Row = Record<string, unknown>;

const labelKey = (v: unknown): string => draftLabelKey(s(v));

/** The tenant the draft-created page was on, as the stamp stores it ("" = unknown: nothing is stamped). */
const draftTenant = (draft: ObservedDraft): string => s(draft.tenantKey).trim().slice(0, 200);

/** The signature a stamp is bound to: of the steps exactly as a later read of steps_json parses them. */
const signedSteps = (steps: RecipeStep[]): string => recipeStepsSignature(parseJson<RecipeStep[]>(asJson(steps), []));

/** The server-owned record (4 above), or null. */
function draftSubmitRow(db: AppDb, recipeId: string): Row | null {
  return db.get<Row>("SELECT * FROM portal_recipe_draft_submits WHERE recipe_id = ?", [recipeId]) ?? null;
}

/** Writes the record (4 above). The ONLY writer of portal_recipe_draft_submits besides the disarm's delete. */
function writeDraftSubmitRow(db: AppDb, recipeId: string, rec: { stepIndex: number; stepsSig: string; tenantKey: string; label: string; healedAt: string }): void {
  db.run(
    `INSERT INTO portal_recipe_draft_submits (recipe_id, step_index, steps_sig, tenant_key, label, healed_at, armed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(recipe_id) DO UPDATE SET step_index = excluded.step_index, steps_sig = excluded.steps_sig,
       tenant_key = excluded.tenant_key, label = excluded.label, healed_at = excluded.healed_at, armed_at = excluded.armed_at`,
    [recipeId, rec.stepIndex, rec.stepsSig, rec.tenantKey, rec.label.slice(0, 120), rec.healedAt, rec.tenantKey ? nowIso() : ""],
  );
}

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
    if (idx < 0) return armHealedDraftStep(db, recipeId, steps, draft, ctx);
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
    steps[idx] = { ...rest, note: [s(rest.note), `${DRAFT_HEAL_NOTE}${where}`].filter(Boolean).join(" | ") };
    const tenant = draftTenant(draft);
    const note = `[draft-creating submit ${nowIso().slice(0, 10)}: step ${idx + 1} ("${recorded}") only creates a draft${draft.applicationNumber ? ` (seen as ${draft.applicationNumber})` : ""}${where}; it is no longer the recipe's final submit]`;
    db.run(
      `UPDATE portal_recipes SET steps_json = ?, structure_sig = ?, auto_submit_enabled = 0, notes = ?, updated_at = ?
        WHERE id = ? AND steps_json = ?`,
      [asJson(steps), recipeStructureSignature(steps), upsertRecipeNote(row.notes, "draft-creating submit", note), nowIso(), recipeId, s(row.steps_json)],
    );
    if (Number(db.get<{ n: number }>("SELECT changes() AS n")?.n ?? 0) === 0) return { healed: false, why: "the recipe changed while the page was being read" };
    // 4 above: the record, bound to the steps the heal just wrote. Without a tenant it is "healed,
    // not yet stamped": a later draft seen after a person's click of this step stamps it.
    writeDraftSubmitRow(db, recipeId, { stepIndex: idx, stepsSig: signedSteps(steps), tenantKey: tenant, label: recorded, healedAt: nowIso() });
    addAuditLog(db, ctx.projectId ?? null, "system", "submit capture", DRAFT_HEALED_ACTION, {
      recipeId, stepIndex: idx, label: recorded.slice(0, 80), nextForm: draft.nextForm.slice(0, 90), runId: ctx.runId ?? null,
      stampedTenant: tenant || null,
    });
    return { healed: true, why: `step ${idx + 1} ("${recorded}") is no longer flagged as the final submit` };
  } catch (err) {
    return { healed: false, why: `heal failed: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}` };
  }
}

/**
 * The heal's own record that steps[idx] of this recipe, under this label, was healed: the server-owned
 * row (any tenant, any signature), or — for a heal written before #330 — its audit record. Never the
 * step's note, which any save can write.
 */
function healRecordFor(db: AppDb, recipeId: string, idx: number, label: string): boolean {
  const row = draftSubmitRow(db, recipeId);
  if (row && Number(row.step_index) === idx && labelKey(row.label) === labelKey(label)) return true;
  const audits = db.query<Row>("SELECT details FROM audit_logs WHERE action = ? AND details LIKE ?", [DRAFT_HEALED_ACTION, `%${recipeId}%`]);
  return audits.some((a) => {
    const d = parseJson<Record<string, unknown>>(s(a.details) || "{}", {});
    return s(d.recipeId) === recipeId && Number(d.stepIndex) === idx && labelKey(d.label) === labelKey(label);
  });
}

/**
 * 4 above, for a step already healed (a heal with no tenant on the page read, one written before #330,
 * or one whose recipe has changed since): the draft is seen again after a person clicked the recipe's
 * LAST step, which a heal record names (healRecordFor), which is not flagged final, and whose label is
 * what was clicked. Only the "created" wording, only that one step, and bound to the steps as they
 * are now. Writes nothing to the recipe. Never throws.
 */
function armHealedDraftStep(
  db: AppDb,
  recipeId: string,
  steps: RecipeStep[],
  draft: ObservedDraft,
  ctx: { projectId?: string | null; runId?: string | null },
): { healed: boolean; why: string } {
  const none = "no step of the recipe is flagged as the final submit";
  const idx = steps.length - 1;
  const step = steps[idx];
  if (!step || step.action !== "click" || step.isFinalSubmit === true) return { healed: false, why: none };
  const recorded = stepLabel(step);
  const clicked = s(draft.clickedLabel);
  if (!clicked || !recorded || labelKey(clicked) !== labelKey(recorded)) return { healed: false, why: `${none}; the click ("${clicked || "unknown"}") is not the recipe's last step ("${recorded || "unlabelled"}")` };
  if (!healRecordFor(db, recipeId, idx, recorded)) return { healed: false, why: `${none}; no heal is on record for step ${idx + 1} ("${recorded}")` };
  const tenant = draftTenant(draft);
  if (!tenant) return { healed: false, why: `${none}; the page's tenant is unknown, so the healed step is not stamped` };
  const sig = signedSteps(steps);
  const row = draftSubmitRow(db, recipeId);
  if (row && s(row.tenant_key) === tenant && s(row.steps_sig) === sig && Number(row.step_index) === idx) {
    return { healed: false, why: `${none}; the healed step is already stamped for ${tenant}` };
  }
  writeDraftSubmitRow(db, recipeId, { stepIndex: idx, stepsSig: sig, tenantKey: tenant, label: recorded, healedAt: nowIso() });
  addAuditLog(db, ctx.projectId ?? null, "system", "submit capture", "portal_recipe.draft_submit_stamped", {
    recipeId, stepIndex: idx, label: recorded.slice(0, 80), stampedTenant: tenant, stepsSig: sig, runId: ctx.runId ?? null,
  });
  return { healed: false, why: `step ${idx + 1} ("${recorded}") was already healed; now stamped for ${tenant}` };
}

/**
 * WHAT A REPLAY OF THESE EXACT STEPS MAY CLICK ITSELF (#330), or null. The server-owned record, only
 * when it is stamped (a tenant), names the LAST step, and was signed over exactly `steps` — the steps
 * the replay read, before anything binds them. Any change to the recipe since (a save, a relabel, a
 * re-aimed step, a self-heal, a restored snapshot) is a different signature, and the answer is null:
 * the replay stops for a person, as before #330. Reads only; never throws.
 */
export function draftSubmitStampForReplay(db: AppDb, recipeId: string, steps: RecipeStep[]): DraftCreatingStamp | null {
  try {
    const row = draftSubmitRow(db, recipeId);
    if (!row) return null;
    const list = Array.isArray(steps) ? steps : [];
    const tenantKey = s(row.tenant_key).trim();
    const label = s(row.label).trim();
    const idx = Number(row.step_index);
    if (!tenantKey || !label || idx !== list.length - 1) return null;
    if (s(row.steps_sig) !== recipeStepsSignature(list)) return null;
    return { stepIndex: idx, tenantKey, label, healedAt: s(row.healed_at) };
  } catch {
    return null;
  }
}

/**
 * THE INCIDENT'S OTHER HALF (#330): a replay clicked a stamped draft-creating step and the page after
 * it did not read as a draft. The record is deleted, so no replay clicks it again until a person's
 * click of it is again seen to create a draft — whatever steps are later written back. Only removes;
 * never throws.
 */
export function disarmDraftCreatingSubmit(db: AppDb, recipeId: string, ctx: { projectId?: string | null; runId?: string | null; why?: string } = {}): boolean {
  try {
    db.run("DELETE FROM portal_recipe_draft_submits WHERE recipe_id = ?", [recipeId]);
    if (Number(db.get<{ n: number }>("SELECT changes() AS n")?.n ?? 0) === 0) return false;
    addAuditLog(db, ctx.projectId ?? null, "system", "portal staging", "portal_recipe.draft_submit_disarmed", {
      recipeId, runId: ctx.runId ?? null, why: s(ctx.why).slice(0, 200),
    });
    return true;
  } catch {
    return false;
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
