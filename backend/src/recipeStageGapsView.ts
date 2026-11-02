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
import { clientStagingOverlay, stagingIdentityPortal } from "./clients";
import { issuingAgencyFor, projectForTrack } from "./permitProcess";
import { findCompleteRecipeForProject, resolveRecipeFieldValues } from "./portalRecipes";
import { recipeDisciplineForTrack } from "./portalChannel";
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

/** THE REPLAY'S VALUE DICTIONARY FOR ONE TRACK, assembled the way prepareSubmission assembles it:
 *  the track's issuer view, the client's staging overlay over its snapshot, then
 *  resolveRecipeFieldValues. One helper so the track card (stage gaps) and the approval sheet
 *  (#486) read the values the replay binds, never a second copy. Read-only. Throws on a read
 *  failure; each caller decides how to fail. */
export function stagingFieldValues(db: AppDb, project: ProjectRecord, track: SubmittalTrackType, recipeUrl?: string): {
  portalProject: ProjectRecord; portalType: string; overlay: Record<string, string>; values: Record<string, string>;
} {
  const portalProject = projectForTrack(project, track);
  const portalType = stagingPortalType(db, project, track);
  // THE CLIENT'S PORTAL IDENTITY FOR THE PORTAL THE REPLAY OPENS (#518), as prepareSubmission keys it:
  // the recipe's URL (the caller's, else this track's own complete recipe), else a stored profile.
  // Never the mock portal's row: these views describe a real filing, and a track with no recipe may
  // still stage on a real portal through the learner.
  const runIdentity = stagingIdentityPortal({
    urls: [recipeUrl ?? trackRecipeUrl(db, portalProject, track)],
    profilePortalType: portalType,
    isRealPortal: portalType !== "mock",
  });
  const identityPortal = runIdentity === "mock" ? "" : runIdentity;
  const overlay = clientStagingOverlay(db, project.clientId ?? null, identityPortal, { state: String(project.state ?? ""), track });
  const stagedProject = Object.keys(overlay).length > 0
    ? { ...portalProject, parserSnapshot: { ...portalProject.parserSnapshot, ...overlay } }
    : portalProject;
  return { portalProject, portalType, overlay, values: resolveRecipeFieldValues(db, stagedProject, identityPortal, track) };
}

/** The portal URL of this track's own complete recipe (what the next stage replays), "" when none. */
function trackRecipeUrl(db: AppDb, portalProject: ProjectRecord, track: SubmittalTrackType): string {
  const scopeType = track === "nem" ? "utility" : "ahj";
  const recipe = findCompleteRecipeForProject(db, {
    scopeType, state: portalProject.state, ahj: portalProject.ahj, utility: portalProject.utility,
    ...(scopeType === "ahj" ? { discipline: recipeDisciplineForTrack(track) } : {}),
  });
  return String(recipe?.portalUrl ?? "");
}

/** The gaps for one track's own complete recipe. [] when nothing is missing, or on any read
 *  failure (the card never blocks; the stage gate decides). */
export function stageGapsForTrack(
  db: AppDb, project: ProjectRecord, track: SubmittalTrackType, recipe: Pick<PortalRecipe, "steps" | "portalUrl"> | null,
): RecipeStageGap[] {
  if (!recipe || !Array.isArray(recipe.steps) || !recipe.steps.length) return [];
  try {
    const { portalProject, overlay, values } = stagingFieldValues(db, project, track, String(recipe.portalUrl ?? ""));
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
