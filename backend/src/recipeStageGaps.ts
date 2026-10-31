// THE STAGE GATE ASKS THE RECIPE WHAT IT WILL FILL (#445, owner 2026-10-31: "I need to get to the
// point where automated fill is right every time").
//
// Two pre-stage gates existed and neither read the whole recipe. validatePortalFields
// (repository.ts) is a FIXED list — for NEM the homeowner, address, account, meter, DC/AC size and
// utility — and openPerJobQuestions (recipeReplayBinding.ts) read only the three per-job answer
// keys. So a non-optional fill bound to any other project or client field (a preparer phone, an
// inverter model, a contractor licence) could be blank for this job, and the first anyone knew
// was the portal refusing Next, or worse, accepting a blank box — after a full portal run.
//
// This reads the steps AFTER bindRecipeForReplay (the steps the replay will actually execute,
// bound to THIS job) and lists, one entry per key:
//   question — a per-job answer key with no answer (openPerJobQuestions, unchanged);
//   field    — any other bound fill/select whose value is empty for this job;
//   document — an upload step whose docType has no document on file for this track.
// Optional steps never hold the stage. A literal (unbound) step never counts as missing: its
// recorded value is what the replay types. A step the REPLAY answers itself is not a gap either
// (a fee-tier box decided from the page, a battery declaration answered from hasBattery, a
// battery spec skipped on a job without storage, a box the binder blanked for a person) — the
// gate only names what a person can fix by filling a project or client field, so a gap it names is
// one the replay would really type blank.
//
// Pure: no DB, no browser. It refuses EARLIER and never answers a field (rule 1 untouched).
// RULE 2: a secret field (account, meter, ESI…) is named by a fixed label only, never by the
// step's recorded text, and no gap ever carries a value — there is none: a gap is an empty value.
import type { RecipeStageGap, RecipeStep } from "../../shared/src/types";
import { REPLAY_BLANK_FIELD, openPerJobQuestions } from "./recipeReplayBinding";
import { isPerJobAnswerKey } from "../../shared/src/perJobQuestions";
import { licenceKeyForLabel } from "../../shared/src/licenceKinds";
import { batteryControlKind, batteryControlOfStep, parseHasBattery } from "../../shared/src/batteryControls";
import { isSignatureNameLabel } from "../../shared/src/portalSafety";
import { parseFeeBracketFieldKey, readTierLabel } from "../../portal-bot/src/feeBracketQuantity";
import { isPlannerSecretKey } from "./projectSecrets";

export type { RecipeStageGap };
type RecipeStageGapWhere = RecipeStageGap["where"];

// Words a person reads for the keys a recipe binds most. Anything else falls back to the key
// spelled out ("installerPreparerPhone" → "Installer preparer phone").
const FIELD_NAMES: Record<string, string> = {
  homeownerName: "Homeowner name", homeownerFirstName: "Homeowner name (first)", homeownerLastName: "Homeowner name (last)",
  homeownerEmail: "Homeowner email", homeownerPhone: "Homeowner phone",
  ubAccountHolder: "Utility account holder (from the bill)", ubAccountHolderFirstName: "Utility account holder (first name, from the bill)",
  ubAccountHolderLastName: "Utility account holder (last name, from the bill)", ubAccountHolderEmail: "Account holder email",
  ubAccountHolderPhone: "Account holder phone",
  projectAddress: "Project address", street: "Project address (street)", city: "City", state: "State", zip: "Zip code",
  ahj: "AHJ", utility: "Utility",
  accountNumber: "Utility account number", meterNumber: "Meter number", esiId: "ESI ID",
  systemSizeDcKw: "DC system size (kW)", systemSizeAcKw: "AC system size (kW)", totalExportKw: "Export capacity (kW)",
  inverterManufacturer: "Inverter manufacturer", inverterMake: "Inverter manufacturer", inverterModel: "Inverter model",
  inverterQuantity: "Inverter quantity", inverterQty: "Inverter quantity",
  moduleManufacturer: "Module manufacturer", moduleMake: "Module manufacturer", moduleModel: "Module model",
  moduleQuantity: "Module quantity", moduleQty: "Module quantity", totalModuleQuantity: "Module quantity", moduleWattage: "Module wattage (W)",
  mainServiceRating: "Main service rating (A)",
  batteryManufacturer: "Battery manufacturer", batteryModel: "Battery model", batteryQuantity: "Battery quantity",
  essKwh: "Battery capacity (kWh)", batteryCapacityKwh: "Battery capacity (kWh)",
  installerCompanyName: "Installer company name", installerEmail: "Installer email", installerPhone: "Installer phone",
  installerAddress: "Installer address", installerStreet: "Installer street address", installerCityStateZip: "Installer city, state, zip",
  installerContactName: "Installer contact name", authorizedSignerName: "Authorized signer name",
  ccbLicenseNumber: "CCB / contractor licence number", electricalLicenseNumber: "Electrical licence number",
  workDescription: "Description of work", jobValue: "Job value", installDate: "Install date",
};

/** A key that lives on the CLIENT (the solar company) rather than the project. */
const CLIENT_KEY = /^(installer|contractor|company|business|legalBusiness|authorizedSigner|signer|preparer|ccb|electricalLicen|licen|csl|hic|ubi|workersComp|insurance)/i;

const spellKey = (key: string): string => {
  const s = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return s ? s[0].toUpperCase() + s.slice(1) : key;
};
export function gapFieldName(key: string): string {
  return FIELD_NAMES[key] ?? spellKey(key);
}
function docTypeName(docType: string): string {
  const s = docType.replace(/[_-]+/g, " ").trim();
  return s ? `${s[0].toUpperCase()}${s.slice(1)}` : docType;
}
const one = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();
const labelOf = (s: RecipeStep): string =>
  one(s.selector?.label || s.selector?.name || s.selector?.placeholder || s.selector?.text || s.note || s.field || "").slice(0, 140);

/** The recorded e-signature box — the same reading the replay makes (recipeAdapter isSignatureStep):
 *  its value is always the client's authorized signer, whatever key it is bound to. */
function isSignatureStep(step: RecipeStep): boolean {
  if (/^e-signature:/i.test(String(step.note ?? ""))) return true;
  if (step.action !== "fill") return false;
  const sel = (step.selector ?? {}) as NonNullable<RecipeStep["selector"]> & { fallbacks?: Array<{ label?: string; placeholder?: string; css?: string }> };
  const words = (s: unknown): string => String(s ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[#_\-.[\]="']+/g, " ");
  const names = [sel.label, sel.placeholder, sel.name, words(sel.css), ...(sel.fallbacks ?? []).map((f) => f.label ?? f.placeholder ?? words(f.css))]
    .map((s) => String(s ?? "").trim()).filter(Boolean);
  return names.some((n) => isSignatureNameLabel(n));
}

/**
 * The key whose value the replay will type into this step for THIS job, or null when the step is
 * not a project/client field a person fills: unbound (a literal), blanked by the binder for a
 * person, a key the value dictionary does not define (a planner-invented name — the replay's own
 * literal fallback decides it), or a step the replay answers itself.
 */
function gateKeyFor(step: RecipeStep, fieldValues: Record<string, string>): string | null {
  const field = String(step.field ?? "");
  if (!field || field === REPLAY_BLANK_FIELD) return null;
  const label = `${step.selector?.label ?? ""} ${step.note ?? ""}`;
  // A kVA fee-tier box is decided from the page's own tier labels; the boxes for other tiers are
  // blank by design.
  if (step.action === "fill") {
    const tier = readTierLabel(String(step.selector?.label || step.note || ""));
    if (parseFeeBracketFieldKey(field) || (tier && tier.kind !== "wind")) return null;
  }
  // Storage: the declaration is answered from hasBattery; a battery's spec is skipped on a job
  // without storage (and replays as recorded while hasBattery is unknown).
  const battery = batteryControlKind(`${label} ${field}`, { control: batteryControlOfStep(step), options: (step as { options?: unknown[] }).options });
  if (battery === "declaration") return null;
  if (battery === "spec") {
    if (parseHasBattery(fieldValues.hasBattery) !== true) return null;
    if (/\bcapacity\b|kwh/i.test(label) && String(fieldValues.essKwh ?? fieldValues.batteryCapacityKwh ?? "").trim()) return null;
  }
  // The signature box is typed as the client's authorized signer, whatever key it is bound to.
  if (isSignatureStep(step)) return "authorizedSignerName";
  // A licence box reads the kind its label names; a kind with no key is blank for a person.
  const lic = licenceKeyForLabel(field, String(step.selector?.label || step.selector?.name || step.selector?.text || step.note || ""));
  if (lic) return lic.key ?? null;
  if (!Object.prototype.hasOwnProperty.call(fieldValues, field)) return null;
  return field;
}

/** The value the replay types for that key (equipment models prefer the portal's certified name). */
function hasGateValue(key: string, fieldValues: Record<string, string>): boolean {
  if (String(fieldValues[key] ?? "").trim()) return true;
  if (/model$/i.test(key) && String(fieldValues[`${key}Certified`] ?? "").trim()) return true;
  return false;
}

/**
 * EVERY INPUT THE RECIPE WILL FILL THAT THIS JOB DOES NOT HAVE — the bound steps (after
 * bindRecipeForReplay), the job's field values (the replay's own dictionary) and the documents
 * the run is handed (packagedDocumentsByType). One entry per key; optional steps never hold the
 * stage; a literal step never counts. `clientKeys` names the keys the client record supplies
 * (clientStagingOverlay), so a gap says where to fill it.
 */
export function recipeStageGaps(
  steps: RecipeStep[],
  fieldValues: Record<string, string>,
  docsByType: Record<string, string>,
  opts: { clientKeys?: Iterable<string> } = {},
): RecipeStageGap[] {
  const clientKeys = new Set(opts.clientKeys ?? []);
  const out: RecipeStageGap[] = [];
  const seen = new Set<string>();
  // The per-job questions: the existing predicate, unchanged (same keys, same labels).
  for (const q of openPerJobQuestions(steps, fieldValues)) {
    seen.add(`field:${q.key}`);
    out.push({ kind: "question", key: q.key, label: q.label, fieldName: gapFieldName(q.key), where: "portal_questions", secret: false });
  }
  for (const s of steps) {
    if (s.optional || s.phase === "correct") continue;
    if (s.action === "upload") {
      const docType = String(s.docType ?? "").trim();
      if (!docType || docsByType[docType] || seen.has(`doc:${docType}`)) continue;
      // A battery's document on a job without storage is skipped by the replay.
      const battery = batteryControlKind(`${s.selector?.label ?? ""} ${s.note ?? ""} ${docType}`, { control: "file" });
      if (battery && parseHasBattery(fieldValues.hasBattery) !== true) continue;
      seen.add(`doc:${docType}`);
      out.push({ kind: "document", key: docType, label: labelOf(s).replace(/^upload\s+[a-z0-9_]+:\s*/i, ""), fieldName: docTypeName(docType), where: "documents", secret: false });
      continue;
    }
    if (s.action !== "fill" && s.action !== "select") continue;
    if (isPerJobAnswerKey(s.field)) continue;
    const key = gateKeyFor(s, fieldValues);
    if (!key || seen.has(`field:${key}`) || hasGateValue(key, fieldValues)) continue;
    seen.add(`field:${key}`);
    const secret = isPlannerSecretKey(key) || Boolean(s.sensitive);
    out.push({
      kind: "field", key,
      // RULE 2: a secret box is named by its field's fixed label, never by recorded text.
      label: secret ? gapFieldName(key) : labelOf(s),
      fieldName: gapFieldName(key),
      where: clientKeys.has(key) || CLIENT_KEY.test(key) ? "client" : "project",
      secret,
    });
  }
  return out;
}

const WHERE_WORDS: Record<RecipeStageGapWhere, string> = {
  project: "the project", client: "the client record", documents: "the project's documents", portal_questions: "the project's portal questions",
};
/** One plain line per gap: the portal's box, and what to fill where. */
export function describeStageGap(g: RecipeStageGap): string {
  if (g.kind === "document") return `"${g.label || g.fieldName}" needs a ${g.fieldName} document (upload it to ${WHERE_WORDS.documents})`;
  if (g.kind === "question") return `"${g.label}" (answer it under ${WHERE_WORDS.portal_questions}, or send the intake link)`;
  return `"${g.label}" needs ${g.fieldName} (fill it on ${WHERE_WORDS[g.where]})`;
}

/** The 409's sentence. Names every gap; carries no value (rule 2). */
export function stageGapsRefusal(gaps: RecipeStageGap[], portalLabel: string): string {
  const fields = gaps.filter((g) => g.kind !== "question");
  const questions = gaps.filter((g) => g.kind === "question");
  const parts: string[] = [];
  if (fields.length) {
    parts.push(`the recipe for ${portalLabel} fills ${fields.length === 1 ? "a box" : `${fields.length} boxes`} this job has no value for — ${fields.map(describeStageGap).join("; ")}`);
  }
  if (questions.length) {
    parts.push(`${portalLabel} asks ${questions.length === 1 ? "a question" : `${questions.length} questions`} only a person can answer for this job — ${questions.map(describeStageGap).join("; ")}. The recorded answer belonged to another job, so it is never replayed`);
  }
  return `Staging paused before opening the portal: ${parts.join(". Also, ")}. Fill ${gaps.length === 1 ? "it" : "them"}, then stage again. Nothing was opened.`;
}
