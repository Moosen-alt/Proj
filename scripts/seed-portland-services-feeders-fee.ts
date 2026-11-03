// CITY OF PORTLAND'S SERVICES/FEEDERS LINES, READ OUT OF THE CITY'S OWN ELECTRICAL FEE SCHEDULE (#421).
//
// Measured 2026-11-03 on both live City of Portland jobs: each plan set upgrades the service to a
// 200 A main, so each electrical permit owes one "Services or feeders: 200 amps or less" line —
// and the stored electrical row (profile key or|city of portland|unknown, discipline electrical,
// seeded) did not record that line's amount. The evaluator rightly refused a total
// ("SERVICES/FEEDERS <=200A AMOUNT MISSING … the total stays UNRESOLVED rather than smaller").
// The amount is printed on page 1 of the very document the row already cites.
//
// Source: City of Portland / Portland Permitting & Development, Electrical Permit Fee Schedule,
// Effective Date: July 10, 2026 (3 pages), retrieved ONCE on 2026-11-03 over plain HTTP (200,
// application/pdf), rows paired BY COORDINATE with backend/src/pdfTables.ts (same printed line,
// left to right), not in the PDF's text order:
//   https://www.portland.gov/ppd/documents/electrical-permit-fee-schedule-city-portland-effective-july-10-2026/download
// The rows, verbatim, p.1:
//   "Services or Feeders: Installation, alteration or relocation"
//   "200 amps | $ | 212.00"
//   "201 to 400 amps | $ | 298.00"
//   "401 to 600 amps | $ | 391.00"
//   "601 to 1,000 amps | $ | 588.00"
//   "Over 1,000 amps or volts | $ 1,077.00"
//   "Reconnect only | $ | 190.00"
// (The renewable rows printed just below — "5 kva or less | $ | 212.00", "5.01 to 15 kva | $ |
// 298.00", "15.01 to 25 kva | $ | 391.00" — carry the same three amounts; they are a separate line
// item and are what the row's brackets already hold.)
//
// WHAT THIS WRITES. Two charges on every bracket of that ONE row, nothing else on any row:
//   · the <=200 A tier, $212.00. LABELLED "Services or feeders: 200 amps or less" — the Oregon
//     minimum-schedule wording the shared label grammar (shared/src/serviceLineLabels.ts) reads —
//     because Portland prints this tier as a bare "200 amps" (its next row is "201 to 400 amps"),
//     and that grammar is a portal replay binding key that must not be widened for one city. The
//     printed row is kept VERBATIM as the charge's evidence (matchedLine / quote), which is what the
//     fee sheet shows beside the amount.
//   · the 201-400 A tier, $298.00, label = the printed row (the grammar reads it as printed).
// Each is `conditional: false, appliesTo: "electrical"`: the evaluator bills a services line only
// when the job HAS one (feeSchedules.serviceFeederCharges, counted by serviceLineCounts — a battery,
// a service upgrade in its tier), and never otherwise (ancillaryCharges skips a stored services row).
// The 401-600 A and larger tiers are not written: no evaluator prices a service over 400 A (it is
// listed UNPRICED as "SERVICE UPGRADE TIER UNKNOWN"), so a stored amount for it would be read by
// nothing.
//
// RULES, each enforced below and pinned by backend/test/portlandServicesFeedersSeed.test.ts:
//   · DRY RUN by default; --apply writes.
//   · Hard rule 3: a row a person verified (verified_at set, or confidence 'verified') is REFUSED,
//     never edited. The row stays 'seeded'; a person promotes it with markFeeScheduleVerified.
//   · NOT through saveFeeSchedule: with no retrieval ledger that is the untrusted path, which strips
//     every stored ancillary charge and corroboration off the row (the state surcharge, the plan
//     review…). This edits brackets_json in place and keeps every other byte of every bracket.
//   · Idempotent: a bracket that already holds a <=200 A / 201-400 A services charge keeps it; a
//     second run reports "already present" and writes nothing.
//   · DURABILITY: a later automated research pass that re-saves this row replaces each bracket's
//     charge list with what IT finds; if it does not find these rows, they are gone again.
//
//   npx tsx scripts/seed-portland-services-feeders-fee.ts [--apply] [--db <path>]
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppDb } from "../backend/src/db";

export const PORTLAND_ELECTRICAL_SCHEDULE_URL =
  "https://www.portland.gov/ppd/documents/electrical-permit-fee-schedule-city-portland-effective-july-10-2026/download";
const CITE = "[Electrical Permit Fee Schedule, City of Portland, Effective Date: July 10, 2026, p.1; row read by coordinate pairing, retrieved 2026-11-03]";
const HEADING = "Services or Feeders: Installation, alteration or relocation";

/** The two charges, exactly as they are stored (FeeAncillaryCharge's shape). */
export const PORTLAND_SERVICE_FEEDER_CHARGES = [
  {
    label: "Services or feeders: 200 amps or less",
    kind: "other",
    amountUsd: 212,
    percentOf: "",
    conditional: false,
    condition: "Once per service or feeder this electrical permit installs, alters or relocates (a battery/ESS, a service upgrade to a main of 200 A or less). Portland prints this tier as \"200 amps\"; its next row is \"201 to 400 amps\".",
    appliesTo: "electrical",
    quote: `${HEADING} — 200 amps | $ | 212.00 ${CITE}`,
    sourceUrl: PORTLAND_ELECTRICAL_SCHEDULE_URL,
    matchedLine: `${HEADING} — 200 amps | $ | 212.00`,
  },
  {
    label: `${HEADING} — 201 to 400 amps`,
    kind: "other",
    amountUsd: 298,
    percentOf: "",
    conditional: false,
    condition: "Once per service or feeder this electrical permit installs, alters or relocates at 201 to 400 amps (a service upgrade to a main in that tier).",
    appliesTo: "electrical",
    quote: `${HEADING} — 201 to 400 amps | $ | 298.00 ${CITE}`,
    sourceUrl: PORTLAND_ELECTRICAL_SCHEDULE_URL,
    matchedLine: `${HEADING} — 201 to 400 amps | $ | 298.00`,
  },
] as const;

/** The notes segment the row gains. No " | " inside it: notes are " | "-joined segments. */
export const PORTLAND_SERVICE_FEEDER_NOTE =
  "SERVICES/FEEDERS LINES ADDED (#421, scripts/seed-portland-services-feeders-fee.ts): the <=200 A tier $212.00 "
  + "and the 201-400 A tier $298.00, read from p.1 of this row's own source (Electrical Permit Fee Schedule, effective "
  + "July 10, 2026; rows \"200 amps — $212.00\" and \"201 to 400 amps — $298.00\" under \"Services or Feeders: Installation, "
  + "alteration or relocation\"), retrieved 2026-11-03 and paired by coordinate. Billed only on a job with a services "
  + "line (battery/ESS or service upgrade). Seeded, not verified.";

export interface PortlandServiceFeederSeedOutcome {
  action: "would_write" | "written" | "already_present" | "refused_verified" | "refused_shape" | "missing";
  reason: string;
  scheduleId: string;
  /** Charges added (or that would be), summed over brackets. */
  added: number;
  brackets: number;
}

type Row = Record<string, unknown>;
const text = (v: unknown): string => (v == null ? "" : String(v));

export async function seedPortlandServicesFeeders(db: AppDb, opts: { apply: boolean }): Promise<PortlandServiceFeederSeedOutcome> {
  const { feeScheduleProfileKey, getFeeSchedule } = await import("../backend/src/feeSchedules");
  const { isServiceFeeder200Label, isServiceFeeder400Label } = await import("../backend/src/batteryServiceFeeder");
  const key = feeScheduleProfileKey({ state: "OR", ahj: "City of Portland" }, "permit");
  const record = getFeeSchedule(db, key, "permit", "electrical");
  const row = db.get<Row>("SELECT id, brackets_json, notes, confidence, verified_at, basis, status FROM fee_schedules WHERE profile_key = ? AND track = 'permit' AND discipline = 'electrical'", [key]);
  if (!record || !row) return { action: "missing", reason: `no City of Portland electrical row under ${key}`, scheduleId: "", added: 0, brackets: 0 };
  const id = text(row.id);
  // HARD RULE 3, checked on the raw columns as well as the mapped record.
  if (text(row.verified_at).trim() || text(row.confidence) === "verified" || record.confidence === "verified") {
    return { action: "refused_verified", reason: "a person verified this row — research never edits it (hard rule 3); add the lines by hand if they are missing", scheduleId: id, added: 0, brackets: record.brackets.length };
  }
  if (record.basis !== "system_kw" || record.status !== "ok" || !record.brackets.length) {
    return { action: "refused_shape", reason: `expected an ok system_kw row with brackets, found basis=${record.basis} status=${record.status} brackets=${record.brackets.length}`, scheduleId: id, added: 0, brackets: record.brackets.length };
  }
  let raw: unknown;
  try { raw = JSON.parse(text(row.brackets_json) || "[]"); } catch { raw = null; }
  if (!Array.isArray(raw) || raw.length !== record.brackets.length) {
    return { action: "refused_shape", reason: "brackets_json does not parse to the row's brackets", scheduleId: id, added: 0, brackets: record.brackets.length };
  }
  let added = 0;
  const next = (raw as Row[]).map((b) => {
    const list = Array.isArray(b.ancillaryCharges) ? [...(b.ancillaryCharges as Row[])] : [];
    const has200 = list.some((c) => isServiceFeeder200Label(text(c.label)));
    const has400 = list.some((c) => isServiceFeeder400Label(text(c.label)));
    if (!has200) { list.push({ ...PORTLAND_SERVICE_FEEDER_CHARGES[0] }); added++; }
    if (!has400) { list.push({ ...PORTLAND_SERVICE_FEEDER_CHARGES[1] }); added++; }
    return { ...b, ancillaryCharges: list };
  });
  if (!added) return { action: "already_present", reason: "every bracket already holds both services/feeders lines", scheduleId: id, added: 0, brackets: next.length };
  if (!opts.apply) return { action: "would_write", reason: "dry run — nothing written", scheduleId: id, added, brackets: next.length };
  const notes = text(row.notes);
  const mergedNotes = notes.includes("SERVICES/FEEDERS LINES ADDED (#421") ? notes : [notes, PORTLAND_SERVICE_FEEDER_NOTE].filter((s) => s.trim()).join(" | ");
  // The WHERE re-checks rule 3 at write time, so a verify landing between the read and the write wins.
  db.run(
    "UPDATE fee_schedules SET brackets_json = ?, notes = ?, updated_at = ? WHERE id = ? AND confidence = 'seeded' AND COALESCE(verified_at, '') = ''",
    [JSON.stringify(next), mergedNotes, new Date().toISOString(), id],
  );
  // READ BACK THROUGH THE REAL (trusted) PARSER: the lines must survive the storage boundary
  // (normalizeAncillaryCharges) on every bracket, or nothing usable was written.
  const after = getFeeSchedule(db, key, "permit", "electrical");
  const kept = (after?.brackets ?? []).every((b) => (b.ancillaryCharges ?? []).some((c) => isServiceFeeder200Label(c.label) && c.amountUsd === 212)
    && (b.ancillaryCharges ?? []).some((c) => isServiceFeeder400Label(c.label) && c.amountUsd === 298));
  if (!kept || after?.confidence !== "seeded") {
    return { action: "refused_verified", reason: "the row changed under the write (verified, or re-saved) — nothing usable was written; re-run the dry run", scheduleId: id, added: 0, brackets: next.length };
  }
  return { action: "written", reason: "", scheduleId: id, added, brackets: next.length };
}

// CLI — runs only when invoked directly, so the test imports the function without a run happening.
const invokedDirectly = ((): boolean => {
  try {
    return !!process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  await import("dotenv/config");
  const argv = process.argv.slice(2);
  const dbArg = argv.indexOf("--db") >= 0 ? argv[argv.indexOf("--db") + 1] : "";
  process.env.AUTOPILOT_DB_PATH = dbArg || process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite";
  const apply = argv.includes("--apply");
  const { openDatabase } = await import("../backend/src/db");
  const db = await openDatabase();
  console.log(`\nCity of Portland electrical — services/feeders lines (${apply ? "APPLY" : "dry run"}) on ${process.env.AUTOPILOT_DB_PATH}`);
  for (const c of PORTLAND_SERVICE_FEEDER_CHARGES) console.log(`  $${c.amountUsd.toFixed(2)}  ${c.label}\n           printed: "${c.matchedLine}"`);
  console.log(`  source: ${PORTLAND_ELECTRICAL_SCHEDULE_URL}`);
  const outcome = await seedPortlandServicesFeeders(db, { apply });
  console.log(`\n  ${outcome.action}${outcome.reason ? ` — ${outcome.reason}` : ""} (row ${outcome.scheduleId.slice(0, 8) || "-"}, ${outcome.added} charge(s) over ${outcome.brackets} bracket(s))`);
  if (!apply && outcome.action === "would_write") console.log("  re-run with --apply to write (take a restore point first on production).");
  console.log("");
  process.exit(outcome.action === "refused_shape" || outcome.action === "missing" ? 1 : 0);
}
