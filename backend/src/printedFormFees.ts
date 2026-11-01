// ---------------------------------------------------------------------------
// THE FEE TABLE PRINTED ON THE AHJ'S OWN FORM, HELD UP AGAINST THE QUOTE (#454).
//
// Owner ask 2026-10-31: "can we use these as another way of the fee structure estimates" — and,
// on the shape proposed, "Cross check is good". Several stored blanks print their fees:
// Marion County's B-01S ($67.25 + 12%) and E-01 (a kVA ladder), Tigard's prescriptive PV block
// ($180 + 12% = $201.60) and its renewable-energy ladder. Tigard's printed lines reproduce a real
// paid receipt to the cent ((133.56 + 180) + 12% per line = $351.19). Coos County's 12/23/2022
// revision printed $79/$94/$156 against an adopted $135/$160/$265. So a printed table is
// evidence, often good, sometimes years stale — a DATED, LOWER-TRUST source.
//
// What this module does with it, and nothing else:
//   - printedFeeCompositions: what the printed lines compose for THIS job (its discipline, its
//     size, its path), line by line, with each form's printed date. The engine's own rules:
//     a percentage surcharge rides the PERMIT line only, is evaluated (never stored
//     pre-multiplied), and rounds per line.
//   - printedFormCheck: the quote's permit amount beside that composition — agrees / disagrees
//     by $X / no printed table / not comparable. A NOTE. It never changes the quote.
//   - printedFormQuote: the printed composition as the AMOUNT, only at the very bottom of the
//     ladder (submissionFees: no saved schedule, no recorded history, and not even a valuation
//     to estimate from). It never stands in front of a saved schedule, a recorded real fee or a
//     human-verified row (hard rule 3), and it is graded "estimated".
//
// Read-only: nothing here writes, and nothing here is ever "verified".
// ---------------------------------------------------------------------------

import type { PermitFeeSource, PrintedFormFeeCheck, PrintedFormFeeLine, ProjectRecord } from "../../shared/src/types";
import { CURATED_AHJ_FORMS, curatedFormSourcesFor, curatedPrintedFeeTable, type PrintedFeeTable } from "./curatedAhjForms";
import { formAuthorityFor } from "./applicationDocsAgency";
import { resolvePermitPath } from "./permitPath";
import { logger } from "./logger";

/** Within this, the quote and the printed composition AGREE. Per-line rounding moves a cent or
 *  two; a real disagreement between a printed table and a schedule is dollars (Coos: $56+). */
export const PRINTED_FORM_TOLERANCE_USD = 1;

type PrintedProject = Pick<ProjectRecord, "state" | "ahj" | "systemSizeAcKw" | "systemSizeDcKw" | "parserSnapshot">;

/** What one printed table composes for one job. */
export interface PrintedComposition {
  discipline: "electrical" | "structural";
  formName: string;
  printedDate: string;
  sourceUrl: string;
  /** The permit line, then each surcharge evaluated on it. */
  lines: PrintedFormFeeLine[];
  totalUsd: number;
}

export interface PrintedCompositions {
  compositions: PrintedComposition[];
  /** Printed tables held for this job's authority that do not price THIS job, and why. */
  skipped: string[];
  /** How many printed tables are held for this job's authority at all. */
  tablesHeld: number;
  /** How many forms are held for it (printed table or not) — "no printed table" vs "no form". */
  formsHeld: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The kVA the renewable rows are about — the same reading the form fill uses (ahjForms.systemKva):
 *  AC first, DC when AC is missing. */
function systemKva(project: PrintedProject): number {
  const ac = Number(project.systemSizeAcKw);
  if (Number.isFinite(ac) && ac > 0) return ac;
  const dc = Number(project.systemSizeDcKw);
  return Number.isFinite(dc) && dc > 0 ? dc : 0;
}

function pathOf(project: PrintedProject): "prescriptive" | "engineered" | "unknown" {
  try {
    return resolvePermitPath(project).path;
  } catch {
    return "unknown";
  }
}

/** The agency whose forms this job files, per form type (a City of Jefferson job files Marion
 *  County's) — the same answer the forms gate uses, falling back to the AHJ itself. */
function authorityFor(project: PrintedProject, formType: string): string {
  try {
    return formAuthorityFor(project, formType).name || project.ahj;
  } catch {
    return project.ahj;
  }
}

function datedName(c: { formName: string; printedDate: string }): string {
  return `${c.formName} (${c.printedDate || "no printed date"})`;
}

/** Evaluate one printed table for one job: the permit line it lands on, then each percentage
 *  surcharge on that line, rounded per line. { reason } when the table does not price the job. */
export function composePrintedTable(table: PrintedFeeTable, project: PrintedProject, path: string = pathOf(project)): { lines: PrintedFormFeeLine[]; totalUsd: number } | { reason: string } {
  if (table.path === "prescriptive" && path === "engineered") {
    return { reason: "prices only the prescriptive path, and this job is engineered" };
  }
  let permit = table.lines.length === 1 && table.lines[0].maxKva == null ? table.lines[0] : null;
  if (!permit) {
    const kva = systemKva(project);
    if (kva <= 0) return { reason: "needs the system size, and none is on the project" };
    if (table.autoMaxKva != null && kva > table.autoMaxKva) {
      return { reason: `prices a ${kva} kVA system with per-kVA math and plan review, which is not computed` };
    }
    // INCLUSIVE upper bounds, ascending — matching feeSchedules.matchBracket and the form fill.
    permit = table.lines.find((l) => l.maxKva != null && kva <= l.maxKva) ?? null;
    if (!permit) return { reason: `prints no row for a ${kva} kVA system` };
  }
  const base = round2(permit.amountUsd);
  const lines: PrintedFormFeeLine[] = [{ label: permit.label, amountUsd: base, kind: "permit", discipline: table.discipline }];
  for (const s of table.surcharges) {
    lines.push({ label: s.label, amountUsd: round2(base * s.percent / 100), kind: "surcharge", percent: s.percent, discipline: table.discipline });
  }
  return { lines, totalUsd: round2(lines.reduce((sum, l) => sum + l.amountUsd, 0)) };
}

/** What every printed table held for this job's authority composes for it. */
export function printedFeeCompositions(project: PrintedProject): PrintedCompositions {
  const out: PrintedCompositions = { compositions: [], skipped: [], tablesHeld: 0, formsHeld: 0 };
  if (!String(project.ahj ?? "").trim() || !String(project.state ?? "").trim()) return out;
  const path = pathOf(project);
  const seen = new Set<string>();
  for (const formType of ["building_application", "electrical_application"]) {
    for (const source of curatedFormSourcesFor(authorityFor(project, formType), project.state)) {
      if (source.formType !== formType || seen.has(source.hash)) continue;
      seen.add(source.hash);
      out.formsHeld++;
      const table = curatedPrintedFeeTable(source);
      if (!table) continue;
      out.tablesHeld++;
      const composed = composePrintedTable(table, project, path);
      if ("reason" in composed) {
        out.skipped.push(`${datedName({ formName: source.formName, printedDate: table.printedDate })} ${composed.reason}`);
        continue;
      }
      out.compositions.push({
        discipline: table.discipline, formName: source.formName, printedDate: table.printedDate, sourceUrl: source.url,
        lines: composed.lines, totalUsd: composed.totalUsd,
      });
    }
  }
  return out;
}

/** How the quote's amount was split by discipline, when the schedule that produced it said. */
export interface QuotedDisciplineLine {
  discipline: string;
  feeUsd: number | null;
}

/** THE CROSS-CHECK. `quotedUsd`/`quotedSource` are the quote's own permit amount and where it came
 *  from; `disciplineLines` the schedule's per-discipline split, used only when that amount IS the
 *  schedule's (each printed form is then compared with its own discipline's line). Never changes
 *  anything — the caller attaches the result beside the amount. */
export function printedFormCheck(
  project: PrintedProject,
  quotedUsd: number | null,
  quotedSource: PermitFeeSource,
  disciplineLines: QuotedDisciplineLine[] = [],
  /** The compositions to compare — the held forms' own by default. A seam for a table the store does
   *  not hold as a blank (the regression suite's Coos County 12/23/2022 printing). */
  compositions?: PrintedCompositions,
): PrintedFormFeeCheck {
  let printed: PrintedCompositions;
  try {
    printed = compositions ?? printedFeeCompositions(project);
  } catch (err) {
    logger.warn("fees", "printed form fee cross-check failed — reported as no printed table", { err: err instanceof Error ? err.message : String(err) });
    printed = { compositions: [], skipped: [], tablesHeld: 0, formsHeld: 0 };
  }
  const forms = printed.compositions.map((c) => ({ formName: c.formName, printedDate: c.printedDate, sourceUrl: c.sourceUrl, discipline: c.discipline, totalUsd: c.totalUsd }));
  const lines = printed.compositions.flatMap((c) => c.lines);
  const printedUsd = printed.compositions.length ? round2(printed.compositions.reduce((s, c) => s + c.totalUsd, 0)) : null;
  const base = { printedUsd, quotedUsd, quotedSource, forms, lines, skipped: printed.skipped };
  const skippedClause = printed.skipped.length ? ` Not priced from a printed table: ${printed.skipped.join("; ")}.` : "";

  if (!printed.tablesHeld) {
    return { ...base, verdict: "no_printed_table", differenceUsd: null, compared: [],
      note: printed.formsHeld
        ? `The form${printed.formsHeld === 1 ? "" : "s"} held for ${project.ahj} print${printed.formsHeld === 1 ? "s" : ""} no fee amounts, so there is no printed table to cross-check this quote against.`
        : `No form held for ${project.ahj} prints a fee table, so there is nothing printed to cross-check this quote against.` };
  }
  if (!printed.compositions.length) {
    return { ...base, verdict: "not_comparable", differenceUsd: null, compared: [],
      note: `A printed fee table is held for ${project.ahj}, but it does not price this job.${skippedClause}` };
  }
  if (quotedSource === "printed_form") {
    return { ...base, verdict: "not_comparable", differenceUsd: null, compared: [],
      note: "The quote IS the printed table (nothing else prices this job yet), so there is nothing independent to compare it with." };
  }
  if (quotedUsd == null) {
    return { ...base, verdict: "not_comparable", differenceUsd: null, compared: [],
      note: `The printed table composes $${printedUsd!.toFixed(2)} for this job, but the quote has no amount to compare it with.${skippedClause}` };
  }

  // PER DISCIPLINE WHEN THE SCHEDULE SPLIT IT: Marion's E-01 against the schedule's electrical line,
  // its B-01S against the structural one — never a two-permit total against one form's table.
  const compared: PrintedFormFeeCheck["compared"] = [];
  const split = quotedSource === "published_schedule" ? disciplineLines.filter((l) => l.discipline === "electrical" || l.discipline === "structural") : [];
  if (split.length) {
    for (const c of printed.compositions) {
      const line = split.find((l) => l.discipline === c.discipline);
      if (!line || line.feeUsd == null) continue;
      compared.push({ what: c.discipline, printedUsd: c.totalUsd, quotedUsd: round2(line.feeUsd), differenceUsd: round2(line.feeUsd - c.totalUsd) });
    }
  } else if (!printed.skipped.length) {
    // A WHOLE-QUOTE comparison only when the printed tables price every form they cover for this
    // job: a total against a partial composition would "disagree" by the part nobody printed.
    compared.push({ what: "total", printedUsd: printedUsd!, quotedUsd: round2(quotedUsd), differenceUsd: round2(quotedUsd - printedUsd!) });
  }
  if (!compared.length) {
    return { ...base, verdict: "not_comparable", differenceUsd: null, compared,
      note: `The printed table composes $${printedUsd!.toFixed(2)} for this job, but it does not cover the same permits as the quote, so the two are not compared.${skippedClause}` };
  }
  const differenceUsd = round2(compared.reduce((s, c) => s + c.differenceUsd, 0));
  const off = compared.filter((c) => Math.abs(c.differenceUsd) > PRINTED_FORM_TOLERANCE_USD);
  const which = printed.compositions.map(datedName).join(" and ");
  if (!off.length) {
    return { ...base, verdict: "agrees", differenceUsd, compared,
      note: `Agrees with the fee table printed on ${which}: $${compared.reduce((s, c) => s + c.printedUsd, 0).toFixed(2)} printed for this job.${skippedClause}` };
  }
  const parts = off.map((c) => `${c.what === "total" ? "the quote" : `the ${c.what} permit`} is $${Math.abs(c.differenceUsd).toFixed(2)} ${c.differenceUsd > 0 ? "more" : "less"} than printed ($${c.quotedUsd.toFixed(2)} quoted, $${c.printedUsd.toFixed(2)} printed)`);
  return { ...base, verdict: "disagrees", differenceUsd, compared,
    note: `Cross-check: ${parts.join("; ")} on ${which}. The quote stands — a printed table can be years out of date (Coos County's ran 1.70x under its adopted schedule) — but check the AHJ's current schedule before quoting the customer.${skippedClause}` };
}

/** THE LAST RUNG: the printed composition as the amount, for submissionFees only when no saved
 *  schedule, no recorded history and no valuation estimate exist. null when it does not price the
 *  whole job (a partial composition would quote low as if complete). */
export function printedFormQuote(project: PrintedProject): { feeUsd: number; basis: string } | null {
  let printed: PrintedCompositions;
  try {
    printed = printedFeeCompositions(project);
  } catch {
    return null;
  }
  if (!printed.compositions.length || printed.skipped.length) return null;
  const feeUsd = round2(printed.compositions.reduce((s, c) => s + c.totalUsd, 0));
  const itemised = printed.compositions
    .map((c) => `${datedName(c)}: ${c.lines.map((l) => `${l.label} $${l.amountUsd.toFixed(2)}`).join(" + ")}`)
    .join("; ");
  return {
    feeUsd,
    basis: `The fee table printed on the AHJ's own form — ${itemised}. No saved fee schedule, no recorded fee and no valuation are on file, so this is the only figure available; a printed table can be years out of date, so true it up from the portal's own fee screen.`,
  };
}

/** Every printed table held, for tests and the review: [authority, formName, table]. */
export function heldPrintedFeeTables(): Array<{ ahj: string; formName: string; table: PrintedFeeTable }> {
  return CURATED_AHJ_FORMS.flatMap((s) => {
    const table = curatedPrintedFeeTable(s);
    return table ? [{ ahj: s.ahj, formName: s.formName, table }] : [];
  });
}
