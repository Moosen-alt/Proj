// THE TRACK CARD READS THE SAME GAPS THE STAGE GATE REFUSES ON (#445). Before anyone clicks Stage,
// the card names every box the track's recipe will fill that this job has no value for, and every
// document its uploads need that is not on file — so the person fills them first instead of
// learning about them from a 409 (or, before #445, from the portal).
//
// It assembles the replay's inputs the way prepareSubmission does — the track's issuer view
// (projectForTrack), the client's staging overlay, the replay's own value dictionary
// (resolveRecipeFieldValues), the replay binding, and THIS track's packaged documents — and asks
// the one predicate (recipeStageGaps). Read-only: it writes no row (the card is a read path).
// The stage gate stays the authority: it re-reads at stage time, against the recipe staging
// actually resolves (a borrowed recipe included), which the card does not.
import type { PortalRecipe, ProjectRecord, RecipeStageGap, SubmittalTrackType } from "../../shared/src/types";
import type { AppDb } from "./db";
import { clientStagingOverlay } from "./clients";
import { issuingAgencyFor, projectForTrack } from "./permitProcess";
import { resolveRecipeFieldValues } from "./portalRecipes";
import { bindRecipeForReplay } from "./recipeReplayBinding";
import { recipeStageGaps } from "./recipeStageGaps";
import { submissionDocumentsByType } from "./submissionDocuments";

/** The portal type prepareSubmission keys the value dictionary and the overlay by: the newest
 *  stored portal profile of this track's kind, else "mock" (the same query, read-only). */
function stagingPortalType(db: AppDb, project: ProjectRecord, track: SubmittalTrackType): string {
  const pinned = typeof project.parserSnapshot?.["portal_profile_id"] === "string" ? String(project.parserSnapshot["portal_profile_id"]) : "";
  const types = track === "nem" ? ["powerclerk_pge"] : ["accela_oregon"];
  const row = pinned
    ? db.get<{ portal_type?: string }>("SELECT portal_type FROM portal_profiles WHERE id = ?", [pinned])
    : db.get<{ portal_type?: string }>(`SELECT portal_type FROM portal_profiles WHERE portal_type IN (${types.map(() => "?").join(", ")}) ORDER BY created_at DESC LIMIT 1`, types);
  return row?.portal_type ?? "mock";
}

/** The gaps for one track's own complete recipe. [] when nothing is missing, or on any read
 *  failure (the card never blocks; the stage gate decides). */
export function stageGapsForTrack(
  db: AppDb, project: ProjectRecord, track: SubmittalTrackType, recipe: Pick<PortalRecipe, "steps" | "portalUrl"> | null,
): RecipeStageGap[] {
  if (!recipe || !Array.isArray(recipe.steps) || !recipe.steps.length) return [];
  try {
    const portalProject = projectForTrack(project, track);
    const portalType = stagingPortalType(db, project, track);
    const overlay = clientStagingOverlay(db, project.clientId ?? null, portalType, { state: String(project.state ?? ""), track });
    const stagedProject = Object.keys(overlay).length > 0
      ? { ...portalProject, parserSnapshot: { ...portalProject.parserSnapshot, ...overlay } }
      : portalProject;
    const values = resolveRecipeFieldValues(db, stagedProject, portalType, track);
    const binding = bindRecipeForReplay({
      steps: recipe.steps, portalUrl: recipe.portalUrl, project: portalProject, fieldValues: values, track,
      borrowed: null, agency: issuingAgencyFor(portalProject, track),
    });
    const docs = submissionDocumentsByType(db, project, track);
    return recipeStageGaps(binding.steps, { ...values, ...binding.fieldValues }, docs, { clientKeys: Object.keys(overlay) });
  } catch {
    return [];
  }
}
