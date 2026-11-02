// THE APPROVAL SHEET (#486): WHAT APPROVE & AUTO-SUBMIT IS ABOUT TO FILE, ON ONE SCREEN.
//
// The one human review left in the NEM path is the legality check (NEM_OPERATOR_RUNBOOK §3): the
// operator reads the project against the bill and the plan set, then presses Approve & auto-submit.
// The prompt used to be a fixed paragraph that showed none of the values about to be filed, so a
// wrong-bill or wrong-size job could be approved without anyone looking at the numbers. This builds
// the sheet the prompt now shows: the applicant, the property owner, the service address, the
// utility (or the issuing agency), the account and meter numbers (last 4 only), the DC/AC size, the
// modules, inverter and battery, the submitting company and its signer, each with where it came
// from, and every disagreement between sources named first.
//
// THE VALUES ARE THE REPLAY'S OWN. They come from stagingFieldValues (recipeStageGapsView.ts) — the
// issuer view, the client overlay and resolveRecipeFieldValues, assembled the way prepareSubmission
// assembles them — never from a second copy of that resolution. What the sheet adds is the cross-
// check against the bill readings and the plan set's own equipment schedule.
//
// WHAT IT NEVER DOES:
//   · Rule 1: it decides nothing. The approve request and the gate (mayClickFinalSubmit /
//     automaticSubmitRefusals) are untouched; a mismatch here is shown, not enforced. Approving is
//     the same single action as before.
//   · Rule 2: an account or meter number leaves the server masked to its last 4, the bill's
//     readings included; every string on the sheet is scrubbed of the project's secrets before it
//     is returned (belt and braces: no row is meant to carry one). Nothing here reaches a model.
//   · It writes nothing (a read path; approvalSheet.test pins total_changes()).
import type {
  ApprovalSheet, ApprovalSheetIssue, ApprovalSheetRow, ApprovalSheetSource, ProjectRecord, SubmittalTrackType,
} from "../../shared/src/types";
import type { AppDb } from "./db";
import { batteryStatus } from "./batteryServiceFeeder";
import { compactAlnum, fieldAliases } from "./normalize";
import { projectSecretValues } from "./projectSecrets";
import { stagingFieldValues } from "./recipeStageGapsView";
import { redactSecretValues } from "../../shared/src/portalSafety";
import { parseStreetName, parseStreetNumber } from "../../portal-bot/src/addressParse";

/** An account / meter number as the sheet shows it: the last 4 only. A value of 4 characters or
 *  fewer is not shown at all — its "last 4" would be the whole number. */
export function maskLast4(value: string | null | undefined): string {
  const compact = String(value ?? "").replace(/[\s\-–—.#/]/g, "");
  if (!compact) return "";
  if (compact.length <= 4) return "on file (too short to mask)";
  return `•••• ${compact.slice(-4)}`;
}

const str = (v: unknown): string => (v == null ? "" : String(v).trim());
const num = (v: unknown): number | null => {
  const m = str(v).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  const n = m ? Number(m[0]) : NaN;
  return Number.isFinite(n) ? n : null;
};
const kw = (n: number): string => `${Math.round(n * 100) / 100} kW`;
/** Two sizes disagree when they differ by more than 3% (and more than 0.05 kW): a rounding on the
 *  title block never reads as a mismatch, a missing panel or a wrong inverter count does. */
const sizesDisagree = (a: number, b: number): boolean => Math.abs(a - b) > Math.max(0.05, 0.03 * Math.max(a, b));

/** WHO WROTE THIS FIELD LAST, as far as the audit trail can prove it. Read newest first: a
 *  review-queue verification of this field is a person's word; the bill-image read that wrote it is
 *  the bill; ANY other project edit in between ends the search, because which fields an edit
 *  touched is not stored — so the sheet falls back to "project record" rather than claiming a
 *  source it cannot prove. */
function lastWriterOf(db: AppDb, projectId: string, field: "accountNumber" | "meterNumber"): "person" | "bill" | null {
  const names = new Set([field, ...(fieldAliases[field] ?? [])]);
  let rows: Array<{ action: string; details: string }> = [];
  try {
    rows = db.query<{ action: string; details: string }>(
      `SELECT action, details FROM audit_logs WHERE project_id = ?
         AND action IN ('project.updated_from_parser_snapshot', 'project.fields_read_from_document', 'human_review.updated')
       ORDER BY rowid DESC LIMIT 50`,
      [projectId],
    );
  } catch { return null; }
  for (const row of rows) {
    let d: Record<string, unknown> = {};
    try { d = JSON.parse(row.details || "{}") as Record<string, unknown>; } catch { d = {}; }
    if (row.action === "human_review.updated") {
      if (names.has(str(d.fieldName)) && str(d.action) !== "reject") return "person";
      continue; // another field's review: says nothing about this one
    }
    if (row.action === "project.fields_read_from_document") {
      if (Array.isArray(d.fields) && d.fields.map(String).includes(field)) return "bill";
      continue;
    }
    return null; // an edit whose fields are not recorded: no claim either way
  }
  return null;
}

/** Name tokens (2+ letters), titles dropped — "PROF CHRIS A IVY" → chris, ivy. */
function nameTokens(name: string): Set<string> {
  return new Set(str(name).toLowerCase().replace(/^(mr|mrs|ms|miss|dr|prof)\.?\s+/, "").split(/[^a-z]+/).filter((t) => t.length >= 2));
}

/** The street NUMBER and CORE NAME of a street line, normalised ("925 N Grant St." → 925 / grant). */
function streetKey(address: string): { number: string; name: string } {
  return {
    number: str(parseStreetNumber(address)).toLowerCase(),
    name: str(parseStreetName(address)).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
  };
}

const SOURCE_TEXT: Record<ApprovalSheetSource, string> = {
  bill: "Utility bill",
  plan_set: "Plan set (as saved on the project)",
  person: "Set by a person",
  client: "Submitting company's record",
  project: "Project record",
  derived: "Worked out by the replay",
};

/**
 * The sheet for one filing. `track` is the track the Approve & auto-submit button belongs to.
 * Throws only on a project that cannot be read at all (the route's 404); everything else degrades
 * to "not on file" rows — the sheet never blocks the approval, the gate decides.
 */
export function buildApprovalSheet(db: AppDb, project: ProjectRecord, track: SubmittalTrackType): ApprovalSheet {
  const category: "utility" | "permit" = track === "nem" ? "utility" : "permit";
  const { portalProject, values } = stagingFieldValues(db, project, track);
  const snap = (project.parserSnapshot || {}) as Record<string, unknown>;
  const rows: ApprovalSheetRow[] = [];
  const issues: ApprovalSheetIssue[] = [];
  const row = (r: ApprovalSheetRow): ApprovalSheetRow => { rows.push(r); return r; };
  const src = (source: ApprovalSheetSource, detail = ""): Pick<ApprovalSheetRow, "source" | "sourceLabel"> =>
    ({ source, sourceLabel: detail ? `${SOURCE_TEXT[source]} (${detail})` : SOURCE_TEXT[source] });
  const missing = (r: ApprovalSheetRow, why = "") => {
    r.check = "missing";
    issues.push({ kind: "missing", rowKey: r.key, text: `${r.label}: not on file${why ? ` — ${why}` : ""}.` });
  };
  const mismatch = (r: ApprovalSheetRow, text: string) => {
    r.check = "mismatch";
    r.checkNote = text;
    issues.push({ kind: "mismatch", rowKey: r.key, text: `${r.label}: ${text}` });
  };
  const note = (rowKey: string, text: string) => issues.push({ kind: "note", rowKey, text });

  // ── WHO ─────────────────────────────────────────────────────────────────────────────────────
  const homeowner = str(values.homeownerName);
  const billHolderRaw = str(snap.ubAccountHolder);
  if (category === "utility") {
    // An interconnection is filed under the name on the bill (resolveRecipeFieldValues ubAccountHolder,
    // accountHolders.nemApplicantName); the property owner is its own line on the form.
    const applicant = str(values.ubAccountHolder);
    const r = row({
      key: "applicant", label: "Applicant (the bill's account holder)", value: applicant,
      ...(billHolderRaw ? src("bill", "account holder") : src("project", "no account holder read from a bill; the homeowner is used")),
    });
    if (!applicant) missing(r);
    else if (homeowner && applicant.toLowerCase() !== homeowner.toLowerCase()) {
      const shared = [...nameTokens(applicant)].some((t) => nameTokens(homeowner).has(t));
      if (!shared) note("applicant", `The application files under the bill's account holder "${applicant}", while the property owner on the project is "${homeowner}". That is right for a joint or different account holder; confirm it with the installer if it is not expected.`);
    }
  }
  const owner = row({ key: "homeowner", label: "Property owner", value: homeowner, ...src("project") });
  if (!homeowner) missing(owner);

  // ── WHERE ───────────────────────────────────────────────────────────────────────────────────
  const address = [str(values.projectAddress), [str(values.city), str(values.state), str(values.zip)].filter(Boolean).join(" ")]
    .filter(Boolean).join(", ");
  const addr = row({ key: "address", label: "Service address", value: address, ...src("project") });
  if (!str(values.projectAddress)) missing(addr);
  else {
    const billAddress = str(snap.ubServiceAddress);
    if (billAddress) {
      const a = streetKey(str(values.projectAddress));
      const b = streetKey(billAddress);
      if (a.number && b.number && a.name && b.name && (a.number !== b.number || a.name !== b.name)) {
        mismatch(addr, `the utility bill's service address reads "${billAddress}".`);
      } else if (a.number && a.name && a.number === b.number && a.name === b.name) {
        addr.check = "match";
        addr.checkNote = "Matches the utility bill's service address.";
      }
    }
  }

  if (category === "utility") {
    const utility = str(values.utility);
    const r = row({ key: "utility", label: "Utility", value: utility, ...src("project") });
    if (!utility) missing(r);
  } else {
    // The agency that issues THIS permit (projectForTrack): the project AHJ, or a per-track issuer.
    const ahj = str(values.ahj);
    const view = (portalProject as ProjectRecord & { trackView?: { source?: string } }).trackView;
    const r = row({
      key: "ahj", label: "Issuing agency", value: ahj,
      ...(view?.source === "operator" ? src("person", "this track's issuer") : view?.source ? src("derived", "this track's issuer, from the permit lookup") : src("project", "AHJ")),
    });
    if (!ahj) missing(r);
  }

  // ── THE ACCOUNT, CHECKED AGAINST THE BILL (rule 2: last 4 only) ─────────────────────────────
  if (category === "utility") {
    const idRow = (key: "account" | "meter", field: "accountNumber" | "meterNumber", label: string, billKey: string) => {
      const value = str(values[field]);
      const writer = lastWriterOf(db, project.id, field);
      const billReading = str(snap[billKey]);
      const r = row({
        key, label, value: maskLast4(value), masked: true,
        ...(writer === "person" ? src("person", "verified in the review queue")
          : writer === "bill" ? src("bill", "read from the bill image")
          : src("project")),
      });
      if (!value) { missing(r, "it is read from the customer's utility bill"); return r; }
      if (billReading) {
        const same = field === "accountNumber"
          ? value.replace(/\D/g, "") === billReading.replace(/\D/g, "")
          : compactAlnum(value) === compactAlnum(billReading);
        if (same) {
          r.check = "match";
          r.checkNote = "Matches the number read from the utility bill.";
          if (r.source === "project") Object.assign(r, src("bill", "matches the bill's reading"));
        } else {
          mismatch(r, `the utility bill reads ${maskLast4(billReading)}, the filing would carry ${maskLast4(value)}.`);
        }
      }
      return r;
    };
    idRow("account", "accountNumber", "Utility account number", "ubAccountNumber");
    const meter = idRow("meter", "meterNumber", "Meter number", "ubMeterNumber");
    // The parser page's bill/meter-photo cross-check verdict. Its text can carry digits, so only the
    // verdict is used here — never echoed.
    const verdict = str(snap.ubMeterVerification);
    if (meter.check !== "mismatch" && /mismatch/i.test(verdict)) {
      mismatch(meter, "the meter photo / bill cross-check on the parser page reads a MISMATCH.");
    } else if (!meter.check && /DIGITS MATCH|LIKELY MATCH/i.test(verdict)) {
      meter.check = "match";
      meter.checkNote = "The meter photo / bill cross-check reads a match.";
    }
  }

  // ── WHAT: SIZE AND EQUIPMENT, CHECKED AGAINST THE PLAN SET'S OWN SCHEDULE ───────────────────
  const dc = num(values.systemSizeDcKw);
  const ac = num(values.systemSizeAcKw);
  const dcRow = row({ key: "dcKw", label: "System size (DC)", value: dc == null ? "" : kw(dc), ...src("plan_set") });
  const acRow = row({ key: "acKw", label: "System size (AC)", value: ac == null ? "" : kw(ac), ...src("plan_set") });
  if (dc == null) missing(dcRow);
  if (ac == null && category === "utility") missing(acRow);

  const moduleQty = num(values.moduleQuantity || values.moduleQty);
  const moduleW = num(values.moduleWattage);
  const moduleName = [str(values.moduleManufacturer || values.moduleMake), str(values.moduleModel)].filter(Boolean).join(" ");
  // DC = modules × module watts. The plan set's own equipment schedule against the size on the job.
  if (dc != null && moduleQty && moduleW && moduleQty > 0 && moduleW > 0) {
    const derived = (moduleQty * moduleW) / 1000;
    if (sizesDisagree(dc, derived)) mismatch(dcRow, `the plan set's modules add up to ${kw(derived)} (${moduleQty} × ${moduleW} W), not ${kw(dc)}.`);
    else { dcRow.check = "match"; dcRow.checkNote = `Matches the modules: ${moduleQty} × ${moduleW} W.`; }
  }
  const invQty = num(values.inverterQty || values.inverterQuantity);
  const invOutRaw = num(values.invOutputW || values.pvMicroOutputW);
  const invName = [str(values.inverterMake || values.inverterManufacturer), str(values.inverterModel)].filter(Boolean).join(" ");
  const battery = batteryStatus(values as Record<string, unknown>);
  // AC = inverters × inverter output — only where that is the whole story: a battery (a hybrid or
  // battery inverter adds or caps AC) or an existing system on the same service (the totals are
  // combined) makes the sum a different number on purpose, so no cross-check is claimed there.
  if (ac != null && invQty && invOutRaw && invQty > 0 && invOutRaw > 0 && battery !== "yes" && !project.existingSystem?.hasExistingSystem) {
    // An output written in kW (≤ 30) is read as kW; a residential inverter's watts never are.
    const perUnitKw = invOutRaw <= 30 ? invOutRaw : invOutRaw / 1000;
    const derived = invQty * perUnitKw;
    const perUnit = invOutRaw <= 30 ? kw(invOutRaw) : `${invOutRaw} W`;
    if (sizesDisagree(ac, derived)) mismatch(acRow, `the plan set's inverters add up to ${kw(derived)} (${invQty} × ${perUnit}), not ${kw(ac)}.`);
    else { acRow.check = "match"; acRow.checkNote = `Matches the inverters: ${invQty} × ${perUnit}.`; }
  }

  const certifiedModule = str(values.moduleModelCertified);
  const modules = row({
    key: "modules", label: "Modules",
    value: moduleName ? `${moduleQty ? `${moduleQty} × ` : ""}${moduleName}${moduleW ? ` (${moduleW} W)` : ""}${certifiedModule && certifiedModule !== str(values.moduleModel) ? ` — files as "${certifiedModule}"` : ""}` : "",
    ...src("plan_set"),
  });
  if (!moduleName) note(modules.key, "No module make or model is on the project.");
  const certifiedInverter = str(values.inverterModelCertified);
  const inverter = row({
    key: "inverter", label: "Inverter",
    value: invName ? `${invQty ? `${invQty} × ` : ""}${invName}${certifiedInverter && certifiedInverter !== str(values.inverterModel) ? ` — files as "${certifiedInverter}"` : ""}` : "",
    ...src("plan_set"),
  });
  if (!invName) note(inverter.key, "No inverter make or model is on the project.");
  const batteryName = [str(values.batteryManufacturer || values.batteryMake), str(values.batteryModel)].filter(Boolean).join(" ");
  const batteryQty = num(values.batteryQuantity || values.batteryQty);
  row({
    key: "battery", label: "Battery",
    value: battery === "yes"
      ? `${batteryQty ? `${batteryQty} × ` : ""}${batteryName || "a battery (model not on file)"}`
      : battery === "no" ? "None — filed as solar PV only" : "",
    ...(battery === "unknown" ? src("project", "nothing on file says whether there is a battery") : src("plan_set")),
  });
  if (battery === "unknown") note("battery", "Nothing on the project says whether the system has a battery.");

  // ── BY WHOM ─────────────────────────────────────────────────────────────────────────────────
  const company = str(values.installerCompanyName);
  const companyRow = row({ key: "client", label: "Submitting company", value: company, ...src("client") });
  if (!company) missing(companyRow, "no submitting company is linked to the project");
  const signer = [str(values.authorizedSignerName), str(values.authorizedSignerTitle)].filter(Boolean).join(", ");
  row({ key: "signer", label: "Signer", value: signer, ...src("client", "authorized signer") });
  if (!str(values.authorizedSignerName)) note("signer", "No authorized signer is on the submitting company's record.");

  // RULE 2, BELT AND BRACES: no string on the sheet carries a whole secret. The rows above only ever
  // put a masked id in a value, but a parsed field can hold a number it should not (a bill address
  // line with the account on it), so every string is scrubbed against the project's secrets.
  const secrets = new Set<string>([...projectSecretValues(project), str(values.accountNumber), str(values.meterNumber)].filter((s) => s.length >= 4));
  const scrub = (s: string): string => (s ? redactSecretValues(s, secrets, (hit) => maskLast4(hit)) : s);
  for (const r of rows) {
    r.value = scrub(r.value);
    r.sourceLabel = scrub(r.sourceLabel);
    if (r.checkNote) r.checkNote = scrub(r.checkNote);
  }
  for (const i of issues) i.text = scrub(i.text);

  const order = { mismatch: 0, missing: 1, note: 2 } as const;
  issues.sort((a, b) => order[a.kind] - order[b.kind]);
  return { projectId: project.id, track, category, rows, issues };
}
