// ---------------------------------------------------------------------------
// A KNOWN DRAFT-CREATING SUBMIT MAY BE CLICKED BY THE REPLAY ITSELF (#330, owner ruling 2026-10-16:
// "Yes to PSE").
//
// PSE's PowerClerk tenant answers Part 1's Submit with "Your draft application NEM-… has been
// created. Please continue to Interconnection Application - Part 2 …" (draftCreated.ts). Once that
// page has been SEEN after a click of a recipe's recorded final submit, the backend heals that step
// (backend/src/portalDraft.ts): the isFinalSubmit flag comes off, and the backend STAMPS it in a
// server-owned record (portal_recipe_draft_submits — never in the recipe's steps, which any recipe
// save can write) with the step index, the tenant it was seen on, the label that was clicked, and
// the signature of the whole recipe. Until #330 a person still clicked it, so a PSE job took two
// runs with a human click between them.
//
// This module is the ONE answer to "may the replay click this step itself?". It is NOT the
// final-submit gate and never stands in for it:
//   - a step flagged isFinalSubmit is never clicked here (that click belongs to mayClickFinalSubmit /
//     automaticSubmitRefusals, CLAUDE.md rule 1, unchanged);
//   - PORTAL_ALLOW_FINAL_SUBMIT and a named run approval are never read: they neither allow nor
//     refuse this click (draftSubmitGate.test pins both ways);
//   - a step that was never healed (no stamp) is never clicked. The stamp reaches this module only
//     as a run option the backend passes (draftSubmitStampForReplay): for the NEM track's own recipe
//     (the track whose next stage continues a draft instead of starting the application again), and
//     only when the steps being replayed are EXACTLY the steps the draft was seen with (any edit,
//     relabel, re-aimed step, self-heal or restored snapshot turns it off). A field on a recipe step
//     is never read as one;
//   - the stamp only counts on the tenant it was seen on, for the label that was clicked, on the
//     step it names, which must be the recipe's LAST step, once per run.
// THE LIVE CHECK IS THE LABEL. A generic "Submit" on the page is not by itself proof it is Part 1's:
// what makes it so is that every step before it — the whole of Part 1 as the draft was seen with it —
// replayed unchanged (the signature), and that the page after the click must read as draft-created.
// And the click is only half of it: the page it produces must read as draft-created
// (readDraftAfterClick). Anything else — a receipt, a filed status, a page that cannot be read —
// stops the run, is recorded as an incident, and the track never reads as filed (recipeAdapter
// clickDraftCreatingSubmit, repository prepareSubmission).
// ---------------------------------------------------------------------------
import { isPathTenantedHost, portalHostOf, portalTenantKey } from "../../backend/src/portalChannel";
import { classifySubmissionText, isPayFee } from "../../shared/src/portalSafety";
import type { RecipeStep } from "../../shared/src/types";
import { readDraftCreated, type DraftCreatedRead } from "./draftCreated";

/** The backend's stamp for this run (portalDraft.draftSubmitStampForReplay), never a step field. */
export interface DraftCreatingStamp {
  /** The step it names, in the steps the replay runs (the backend maps it through the replay binding). */
  stepIndex: number;
  /** draftTenantKey of the page that said the draft was created. */
  tenantKey: string;
  /** The recorded label of the step that was clicked (the heal's matching key). */
  label: string;
  /** When the draft-created page was seen (ISO). */
  healedAt: string;
}

/**
 * THE TENANT a page belongs to, for this decision: the host (a PowerClerk tenant is its own
 * subdomain: <utility>.powerclerk.com), and on a host where one instance serves many agencies by
 * path or query (portalChannel's shared instances: Accela ACA, citizenserve …) the tenant key
 * that names the agency. "" when the URL is not an http(s) page — and "" never matches.
 */
export function draftTenantKey(url: string | null | undefined): string {
  const host = portalHostOf(url);
  if (!host) return "";
  return isPathTenantedHost(host) ? portalTenantKey(url) : host;
}

/** The visible label a recorded click step was recorded under (the heal's own reading). */
export function draftStepLabel(step: RecipeStep | null | undefined): string {
  const sel = (step?.selector ?? {}) as Record<string, unknown>;
  return String(sel.name || sel.text || sel.label || "").trim();
}

export const draftLabelKey = (v: unknown): string => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The run's stamp, when it is a complete one (a tenant, a label and a step index). */
export function completeStamp(stamp: DraftCreatingStamp | null | undefined): DraftCreatingStamp | null {
  if (!stamp || typeof stamp !== "object") return null;
  const tenantKey = String(stamp.tenantKey ?? "").trim();
  const label = String(stamp.label ?? "").trim();
  const stepIndex = Number(stamp.stepIndex);
  if (!tenantKey || !label || !Number.isInteger(stepIndex) || stepIndex < 0) return null;
  return { stepIndex, tenantKey, label, healedAt: String(stamp.healedAt ?? "") };
}

export interface DraftClickContext {
  /** The URL of the page the click would happen on. */
  pageUrl: string;
  /** The backend's stamp for this run (RecipeAdapter options.draftSubmitStamp), or null: none. */
  stamp: DraftCreatingStamp | null;
  /** A draft-creating click was already made (or attempted) in this run. */
  alreadyClicked: boolean;
}

/**
 * Why the replay may NOT click steps[idx] as a known draft-creating submit. [] = it may.
 * Reads the recipe, the backend's stamp for this run and the page URL only: no environment variable,
 * no approval, no auto-submit arm, and never a stamp-like field on a step.
 */
export function draftCreatingClickRefusals(steps: RecipeStep[], idx: number, ctx: DraftClickContext): string[] {
  const out: string[] = [];
  const list = Array.isArray(steps) ? steps : [];
  const step = list[idx];
  if (!step) return [...out, "there is no such step"];
  if (step.action !== "click") out.push(`the step is a ${String(step.action)}, not a click`);
  if (step.isFinalSubmit === true) out.push("the step is flagged as the final submit — that click goes only through the final-submit gate");
  const stamp = completeStamp(ctx.stamp);
  if (!stamp) {
    out.push("the step was never healed from a draft-created page on this portal (no stamp for these exact steps on this run)");
    return out;
  }
  if (stamp.stepIndex !== idx) out.push(`the stamp names step ${stamp.stepIndex + 1}, not this one`);
  if (idx !== list.length - 1) out.push("the step is not the recipe's last step");
  const recorded = draftStepLabel(step);
  if (!recorded || draftLabelKey(recorded) !== draftLabelKey(stamp.label)) {
    out.push(`the step's label ("${recorded || "unlabelled"}") is not the one that was seen to create a draft ("${stamp.label}")`);
  }
  if (isPayFee(recorded) || isPayFee(stamp.label)) out.push(`"${recorded || stamp.label}" pays a fee`);
  const here = draftTenantKey(ctx.pageUrl);
  if (!here || here !== stamp.tenantKey) {
    out.push(`this page (${here || "an unreadable URL"}) is not the tenant the draft was seen on (${stamp.tenantKey})`);
  }
  if (ctx.alreadyClicked) out.push("a draft-creating submit was already clicked in this run");
  return out;
}

export type DraftAfterClick =
  | { verdict: "draft"; read: DraftCreatedRead; evidence: string }
  | { verdict: "filed" | "other"; read: DraftCreatedRead; evidence: string };

/**
 * THE PAGE AFTER THE CLICK. Only the "created" wording counts (a bare "Application Draft" status
 * on a page is not proof the click made the draft). A page that says the application was
 * submitted/received is "filed"; anything else — an error, a review page that did not move, a
 * blank page — is "other". Both stop the run.
 */
export function readDraftAfterClick(bodyText: string | null | undefined): DraftAfterClick {
  const text = String(bodyText ?? "").replace(/\s+/g, " ").trim();
  const read = readDraftCreated(text);
  if (read.draft && read.strength === "created") return { verdict: "draft", read, evidence: read.evidence };
  const filed = classifySubmissionText(text);
  if (filed.verdict === "accepted") return { verdict: "filed", read, evidence: String(filed.evidence ?? "").slice(0, 200) };
  return { verdict: "other", read, evidence: text.slice(0, 200) };
}
