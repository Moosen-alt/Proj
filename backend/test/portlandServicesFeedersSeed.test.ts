// CITY OF PORTLAND, #421 — THE SERVICES/FEEDERS LINES, AND WHAT A PORTLAND QUOTE IS MADE OF.
//
// Measured 2026-11-03 on both live City of Portland jobs (each upgrades its service to a 200 A
// main): the stored electrical row did not record the "Services or feeders: 200 amps or less"
// amount, so the schedule refused a total and the quote fell to a clamped 1.5% guess of $150.
// scripts/seed-portland-services-feeders-fee.ts adds the line from p.1 of the row's own source.
//
// The rows here are SYNTHETIC, built to the production row's STRUCTURE (profile key, discipline,
// basis, the four renewable brackets, the five ancillary charges research stored on each, the
// structural ladder + 65% plan review). Printed fee descriptions and amounts only — no customer
// data. Sections:
//   1. the script: dry run writes nothing; --apply adds both tiers to every bracket and keeps every
//      other byte; a second run is a no-op; a person-verified row is refused (hard rule 3).
//   2. the evaluator with the lines stored: a 200 A upgrade bills $212 + the 12% the row holds as a
//      charge; a 300 A upgrade bills the 201-400 tier; a job with NO service line bills neither
//      and is not nulled.
//   3. the Portland composition, pinned against the two itemised billing summaries, line by line,
//      as far as the published rules reproduce them.
// Run: npx tsx backend/test/portlandServicesFeedersSeed.test.ts
import "./_isolate"; // FIRST
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectRecord } from "../../shared/src/types";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portland-services-feeders-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.sqlite");
process.env.SUBMISSION_SERVICE_FEE_USD = "0";
process.env.FEE_RESEARCH = "off";
process.env.ANTHROPIC_API_KEY = "";

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const F = await import("../src/feeSchedules");
const { buildPaymentQuote } = await import("../src/submissionFees");
const { isServiceFeeder200Label, isServiceFeeder400Label } = await import("../src/batteryServiceFeeder");
const { seedPortlandServicesFeeders, PORTLAND_SERVICE_FEEDER_CHARGES } = await import("../../scripts/seed-portland-services-feeders-fee");

const db = await openDatabase();
let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ELEC_URL = "https://www.portland.gov/ppd/documents/electrical-permit-fee-schedule-city-portland-effective-july-10-2026/download";
const APP_URL = "https://www.portland.gov/ppd/documents/electrical-renewable-energy-permit-application/download";
const BLDG_URL = "https://www.portland.gov/ppd/documents/building-and-other-permits-fee-schedule-city-portland-effective-july-10-2026/download";
const KEY = F.feeScheduleProfileKey({ state: "OR", ahj: "City of Portland" }, "permit");

// The five charges research stored on every electrical bracket (production shape).
const electricalAncillaries = [
  { label: "State surcharge (12% of permit fee)", kind: "surcharge", percent: 12, percentOf: "permit fee", conditional: false, condition: "", appliesTo: "", quote: "State surcharge (12% of permit fee) [Electrical Renewable Energy Permit Application, fee-calculation block, p.1]", sourceUrl: APP_URL, matchedLine: "State surcharge (12% of permit fee)" },
  { label: "Plan Review Fee — 25% of total electrical permit fee - Maximum number of allowable checksheets: 2", kind: "plan_review", percent: 25, percentOf: "total electrical permit fee", conditional: true, condition: "Only when electrical plan review is required. The schedule flags plan review for 'Solar Generation System Over 25 KVA (Plan Review Required)'.", appliesTo: "electrical", quote: "Plan Review Fee | 25% of total electrical permit fee", sourceUrl: ELEC_URL, matchedLine: "Plan Review Fee — 25% of total electrical permit fee - Maximum number of allowable checksheets: 2" },
  { label: "Additional checksheet fee - per checksheet | $ | 324.00", kind: "plan_review", amountUsd: 324, percentOf: "", conditional: true, condition: "Charged per checksheet beyond the 2 allowable checksheets on a plan-reviewed electrical permit.", appliesTo: "electrical", quote: "Additional checksheet fee - per checksheet | $ | 324.00", sourceUrl: ELEC_URL, matchedLine: "Additional checksheet fee - per checksheet | $ | 324.00" },
  { label: "Each additional inspection | $ | 228.00", kind: "other", amountUsd: 228, percentOf: "", conditional: true, condition: "Applies only to inspections beyond the number allowed by the permit.", appliesTo: "electrical", quote: "Each additional inspection | $ | 228.00", sourceUrl: ELEC_URL, matchedLine: "Each additional inspection | $ | 228.00" },
  { label: "Reinspection and Additional Fees — Fee - per inspection | $ | 161.00", kind: "other", amountUsd: 161, percentOf: "", conditional: true, condition: "Only on a failed/repeat inspection.", appliesTo: "electrical", quote: "Fee - per inspection | $ | 161.00", sourceUrl: ELEC_URL, matchedLine: "Reinspection and Additional Fees — Fee - per inspection | $ | 161.00" },
];
const renewable = (fees: [number, number, number]) => [
  { minKw: 0, maxKw: 5, feeUsd: fees[0], label: `Renewable Energy: Installation, alteration or relocation — 5 kva or less | $ | ${fees[0].toFixed(2)}`, ancillaryCharges: electricalAncillaries },
  { minKw: 5.01, maxKw: 15, feeUsd: fees[1], label: `Renewable Energy: Installation, alteration or relocation — 5.01 to 15 kva | $ | ${fees[1].toFixed(2)}`, ancillaryCharges: electricalAncillaries },
  { minKw: 15.01, maxKw: 25, feeUsd: fees[2], label: `Renewable Energy: Installation, alteration or relocation — 15.01 to 25 kva | $ | ${fees[2].toFixed(2)}`, ancillaryCharges: electricalAncillaries },
  { minKw: 25.01, maxKw: 100, feeUsd: 15.52, label: "Solar Generation System Over 25 KVA (Plan Review Required) — Each kva over 25.012 up to 100 kva | $ | 15.52 (per kva)", ancillaryCharges: electricalAncillaries },
];
// The structural row: research stored the 65% plan review (unconditional) and NO state surcharge.
const planReview65 = { label: "Plan Review/Process Fee", kind: "plan_review", percent: 65, percentOf: "the building permit fee (original submittal, maximum of 2 allowable checksheets)", conditional: false, condition: "", appliesTo: "structural", quote: "Plan Review/Process Fee — For the original submittal - 65% of the building permit fee", sourceUrl: BLDG_URL, matchedLine: "Plan Review/Process Fee — For the original submittal - 65% of the building permit fee, maximum of 2 allowable checksheets" };

let seq = 0;
function putSchedule(discipline: "electrical" | "structural", basis: string, brackets: unknown[], opts: { confidence?: string; verifiedAt?: string } = {}): string {
  db.run("DELETE FROM fee_schedules WHERE profile_key = ? AND track = 'permit' AND discipline = ?", [KEY, discipline]);
  const ts = new Date().toISOString();
  const rid = `pdx-${discipline}-${++seq}`;
  db.run(
    `INSERT INTO fee_schedules (id, profile_key, state, ahj, utility, track, basis, brackets_json, notes, source_url, source_quote,
       source_kind, confidence, first_seen_at, updated_at, verified_at, verified_by, payment_method, discipline, collected_by_profile_key,
       status, document_date, candidates_json)
     VALUES (?, ?, 'OR', 'City of Portland', '', 'permit', ?, ?, 'ELECTRICAL permit only — synthetic fixture', ?, '', 'official', ?, ?, ?, ?, '', '', ?, '', 'ok', '', '[]')`,
    [rid, KEY, basis, JSON.stringify(brackets), discipline === "electrical" ? ELEC_URL : BLDG_URL, opts.confidence ?? "seeded", ts, ts, opts.verifiedAt ?? "", discipline],
  );
  return rid;
}
const rawBrackets = (): string => String(db.get<{ b: string }>("SELECT brackets_json AS b FROM fee_schedules WHERE profile_key = ? AND discipline = 'electrical'", [KEY])?.b ?? "");

const client = createClient(db, { companyName: "Synthetic Solar", billingMode: "monthly" });
let pseq = 0;
function project(acKw: number, snapshot: Record<string, unknown>): ProjectRecord {
  const pid = `pdx-project-${++pseq}`;
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO projects (id, client_id, homeowner_name, state, ahj, utility, system_size_dc_kw, system_size_ac_kw, status, parser_json, created_at, updated_at)
     VALUES (?, ?, 'Synthetic Owner', 'OR', 'City of Portland', 'PGE', ?, ?, 'ready_to_stage', ?, ?, ?)`,
    [pid, client.id, acKw * 1.15, acKw, JSON.stringify(snapshot), now, now],
  );
  return { id: pid, clientId: client.id, state: "OR", ahj: "City of Portland", utility: "PGE", systemSizeDcKw: acKw * 1.15, systemSizeAcKw: acKw, totalExportKw: null, parserSnapshot: snapshot } as unknown as ProjectRecord;
}
const MPU_200 = { scopeText: "Main panel upgrade to 200A", mainBreaker: "200A", hasBattery: "No", jobValue: "20000" };
const MPU_300 = { scopeText: "Main panel upgrade to 300A", mainBreaker: "300A", hasBattery: "No", jobValue: "20000" };
const NO_SERVICE = { hasBattery: "No", jobValue: "20000" };

// ── 1. THE SCRIPT ─────────────────────────────────────────────────────────────────────────────
console.log("\n1. THE SCRIPT");
check("1a. the stored labels are what the ONE label grammar reads: the <=200 A tier as <=200 A, the 201-400 A row as 201-400 A, never crossed",
  isServiceFeeder200Label(PORTLAND_SERVICE_FEEDER_CHARGES[0].label) && !isServiceFeeder400Label(PORTLAND_SERVICE_FEEDER_CHARGES[0].label)
    && isServiceFeeder400Label(PORTLAND_SERVICE_FEEDER_CHARGES[1].label) && !isServiceFeeder200Label(PORTLAND_SERVICE_FEEDER_CHARGES[1].label));
check("1b. the evidence is the PRINTED row, verbatim — Portland prints the tier as \"200 amps\"",
  PORTLAND_SERVICE_FEEDER_CHARGES[0].matchedLine === "Services or Feeders: Installation, alteration or relocation — 200 amps | $ | 212.00"
    && PORTLAND_SERVICE_FEEDER_CHARGES[1].matchedLine === "Services or Feeders: Installation, alteration or relocation — 201 to 400 amps | $ | 298.00");

putSchedule("electrical", "system_kw", renewable([212, 298, 391]));
const original = rawBrackets();
const dry = await seedPortlandServicesFeeders(db, { apply: false });
check("1c. DRY RUN by default: it says what it would add (2 lines x 4 brackets) and writes nothing",
  dry.action === "would_write" && dry.added === 8 && rawBrackets() === original, JSON.stringify(dry));

const applied = await seedPortlandServicesFeeders(db, { apply: true });
const after = F.getFeeSchedule(db, KEY, "permit", "electrical")!;
check("1d. --apply: written, and every bracket now holds both tiers at the printed amounts",
  applied.action === "written" && applied.added === 8
    && after.brackets.every((b) => (b.ancillaryCharges ?? []).some((c) => isServiceFeeder200Label(c.label) && c.amountUsd === 212)
      && (b.ancillaryCharges ?? []).some((c) => isServiceFeeder400Label(c.label) && c.amountUsd === 298)),
  JSON.stringify(applied));
const before = JSON.parse(original) as Array<Record<string, unknown>>;
const now = JSON.parse(rawBrackets()) as Array<Record<string, unknown>>;
check("1e. …and nothing else moved: each bracket's other fields and its five research charges are byte-identical",
  now.length === before.length && now.every((b, i) => {
    const { ancillaryCharges: a, ...rest } = b;
    const { ancillaryCharges: a0, ...rest0 } = before[i];
    return JSON.stringify(rest) === JSON.stringify(rest0) && JSON.stringify((a as unknown[]).slice(0, 5)) === JSON.stringify(a0);
  }));
check("1f. the row stays SEEDED and its notes gain the citation once",
  after.confidence === "seeded" && !after.verifiedAt && (after.notes.match(/SERVICES\/FEEDERS LINES ADDED \(#421/g) ?? []).length === 1);
const twice = rawBrackets();
const again = await seedPortlandServicesFeeders(db, { apply: true });
check("1g. IDEMPOTENT: a second --apply reports already_present and writes nothing",
  again.action === "already_present" && rawBrackets() === twice, JSON.stringify(again));

putSchedule("electrical", "system_kw", renewable([212, 298, 391]));
F.markFeeScheduleVerified(db, KEY, "permit", "Synthetic Person", "electrical");
const verifiedBefore = rawBrackets();
const refused = await seedPortlandServicesFeeders(db, { apply: true });
check("1h. HARD RULE 3: a person-verified row is refused and left exactly as it was",
  refused.action === "refused_verified" && rawBrackets() === verifiedBefore, JSON.stringify(refused));
putSchedule("electrical", "system_kw", renewable([212, 298, 391]), { verifiedAt: "2026-10-01T00:00:00.000Z" });
const stampOnly = rawBrackets();
check("1i. …and so is a row carrying only a verified_at stamp",
  (await seedPortlandServicesFeeders(db, { apply: true })).action === "refused_verified" && rawBrackets() === stampOnly);

// ── 2. THE EVALUATOR WITH THE LINES STORED ────────────────────────────────────────────────────
console.log("\n2. THE EVALUATOR WITH THE LINES STORED");
putSchedule("electrical", "system_kw", renewable([212, 298, 391]));
db.run("DELETE FROM fee_schedules WHERE profile_key = ? AND discipline = 'structural'", [KEY]);
{
  const p = project(3.84, MPU_200);
  const unseeded = F.feeForProject(db, p, "electrical")!;
  check("2a. PRECONDITION (the live defect): without the stored line, a 200 A upgrade leaves the total UNRESOLVED and names the line",
    unseeded.feeUsd === null && /SERVICES\/FEEDERS <=200A AMOUNT MISSING/.test(unseeded.reason) && unseeded.pricedSubtotalUsd === 237.44,
    JSON.stringify({ f: unseeded.feeUsd, floor: unseeded.pricedSubtotalUsd, r: unseeded.reason.slice(0, 80) }));
  await seedPortlandServicesFeeders(db, { apply: true });
  const r = F.feeForProject(db, p, "electrical")!;
  const kinds = r.charges.filter((c) => !c.partOfLineFee).map((c) => `${c.kind}:${c.amountUsd}`);
  check("2b. a 200 A upgrade bills the $212 line AND the 12% the row holds as a charge on it — $212 + $25.44 + $212 + $25.44",
    r.feeUsd === 474.88 && kinds.includes("service_feeder_200a:212") && kinds.includes("service_feeder_200a_state_surcharge:25.44"),
    `${r.feeUsd} ${JSON.stringify(kinds)}`);
  const p3 = project(3.84, MPU_300);
  const r3 = F.feeForProject(db, p3, "electrical")!;
  check("2c. a 300 A upgrade bills the 201-400 A tier ($298 + $35.76), not the <=200 A one",
    r3.feeUsd === 571.2 && r3.charges.some((c) => c.kind === "service_feeder_400a" && c.amountUsd === 298) && !r3.charges.some((c) => c.kind === "service_feeder_200a"),
    `${r3.feeUsd}`);
  const pv = project(5.376, NO_SERVICE);
  const rv = F.feeForProject(db, pv, "electrical")!;
  check("2d. MUST-EXCLUDE: a job with NO service line bills neither stored line and is not nulled by them — $298 + $35.76",
    rv.feeUsd === 333.76 && !rv.charges.some((c) => /services or feeders/i.test(c.label)), `${rv.feeUsd} ${JSON.stringify(rv.charges.map((c) => c.label.slice(0, 30)))}`);
}

// ── 3. THE PORTLAND COMPOSITION ───────────────────────────────────────────────────────────────
// The two itemised City of Portland billing summaries, amounts only:
//   (A) a Residential 1&2 Family filing, $1,175.83:
//       Building Permit RS $266.15 + St. Sur. 12% $31.94 + Electrical Permit RS $283.00 + St Sur 12%
//       $33.96 + Bldg Plan Rvw/Processing RS/MI/MP $173.00 (65% of the building permit)
//       + Zoning Inspection Fee $119.00 + Development Services Fee - RS $51.78
//       + Land Use Plan Review Res $217.00
//   (B) the $762.93 filing already modelled in feeSchedules.ts (3.072 kW AC):
//       Building Permit RS $153.00 + St Sur $18.36 + Electrical Permit RS $201.00 + St Sur $24.12
//       + Bldg Plan Rvw/Processing $99.45 + Fire - Plan Review $50.00 + Land Use Plan Review Res $217.00
// BOTH PREDATE THE JULY 10, 2026 SCHEDULES. $201 and $283 are the prior renewable brackets ($201 /
// $283 / $372 — the stored row's own notes); today's are $212 / $298 / $391. So the PERMIT BASES are
// set to the receipt-era figures below, and what is pinned is the COMPOSITION: every rule the
// published schedules state reproduces its receipt line to the cent. The lines no stored rule
// prices are named as the gap, by amount.
console.log("\n3. THE PORTLAND COMPOSITION");
async function composition(buildingBase: number, renewableFees: [number, number, number], acKw: number) {
  putSchedule("structural", "flat", [{ feeUsd: buildingBase, label: `Building Permit RS (receipt-era amount) | $ | ${buildingBase.toFixed(2)}`, ancillaryCharges: [planReview65] }]);
  putSchedule("electrical", "system_kw", renewable(renewableFees));
  await seedPortlandServicesFeeders(db, { apply: true });
  const q = buildPaymentQuote(db, project(acKw, NO_SERVICE), "permit");
  const priced = (kind: string, pred: (label: string) => boolean = () => true) => q.permitFeeCharges.filter((c) => c.kind === kind && pred(c.label)).map((c) => c.amountUsd);
  return { q, priced };
}
{
  const { q, priced } = await composition(266.15, [201, 283, 372], 6.4);
  check("3a. (A) Building Permit RS $266.15", JSON.stringify(priced("permit", (l) => /Building Permit/.test(l))) === "[266.15]");
  check("3b. (A) its St. Sur. $31.94 — 12% the stored row does not hold, which the quote now adds", JSON.stringify(priced("state_surcharge", (l) => /building\/structural/.test(l))) === "[31.94]", JSON.stringify(q.permitFeeCharges.map((c) => [c.kind, c.amountUsd])));
  check("3c. (A) Electrical Permit RS $283.00 and its St Sur $33.96 (held by the row, as a charge)",
    JSON.stringify(priced("permit", (l) => /Renewable/.test(l))) === "[283]" && JSON.stringify(priced("surcharge")) === "[33.96]");
  check("3d. (A) Bldg Plan Rvw/Processing $173.00 — 65% of the building permit", JSON.stringify(priced("plan_review", (l) => /Plan Review\/Process/.test(l))) === "[173]");
  check("3e. (A) the quote is exactly those five lines: $788.05 — the receipt's $1,175.83 less $387.78",
    q.permitFeeUsd === 788.05 && q.permitFeeSource === "published_schedule" && Math.abs(1175.83 - 788.05 - (119 + 51.78 + 217)) < 0.005, `${q.permitFeeUsd}`);
  // NOT REPRODUCED: Zoning Inspection Fee $119.00, Development Services Fee - RS $51.78, Land Use Plan
  // Review Res $217.00 — no stored row holds a rule for them (see the #421 report).
}
{
  const { q, priced } = await composition(153, [201, 283, 372], 3.072);
  check("3f. (B) Building Permit RS $153.00 + St Sur $18.36 (modeled) + Plan Rvw $99.45 (65%)",
    JSON.stringify(priced("permit", (l) => /Building Permit/.test(l))) === "[153]" && JSON.stringify(priced("state_surcharge")) === "[18.36]"
      && JSON.stringify(priced("plan_review", (l) => /Plan Review\/Process/.test(l))) === "[99.45]");
  check("3g. (B) Electrical Permit RS $201.00 + St Sur $24.12", JSON.stringify(priced("permit", (l) => /Renewable/.test(l))) === "[201]" && JSON.stringify(priced("surcharge")) === "[24.12]");
  check("3h. (B) the quote is $495.93 — the receipt's $762.93 less exactly Fire Plan Review $50 + Land Use Plan Review Res $217",
    q.permitFeeUsd === 495.93 && Math.abs(762.93 - 495.93 - (50 + 217)) < 0.005, `${q.permitFeeUsd}`);
}
{
  // TODAY'S rows (2026 renewable brackets, a production-shaped ladder rung) with and without a 200 A
  // upgrade: the services line and its 12% join the electrical permit, and only there.
  putSchedule("structural", "valuation", [{ minValuationUsd: 2001, maxValuationUsd: 25000, feeUsd: 220.85, label: "$2,001 - $25,000 | Fee for the first $2,000 | $ 220.85 ; For each additional $1,000 or fraction thereof up to and including $25,000 | $ | 13.91", ancillaryCharges: [planReview65] }]);
  putSchedule("electrical", "system_kw", renewable([212, 298, 391]));
  await seedPortlandServicesFeeders(db, { apply: true });
  const without = buildPaymentQuote(db, project(3.84, { ...NO_SERVICE, jobValue: "18993.60" }), "permit");
  const withMpu = buildPaymentQuote(db, project(3.84, { ...MPU_200, jobValue: "18993.60" }), "permit");
  const sum = (q: typeof without) => Math.round(q.permitFeeCharges.filter((c) => c.amountUsd != null).reduce((s, c) => s + (c.amountUsd ?? 0), 0) * 100) / 100;
  check("3i. today, no service line: building ladder + its 12% + 65% plan review + renewable $212 + its 12% — and the sum of the itemised lines IS the quote",
    without.permitFeeUsd === sum(without) && !without.permitFeeIsFloor && !without.permitFeeCharges.some((c) => /services or feeders/i.test(c.label)), `${without.permitFeeUsd} vs ${sum(without)}`);
  check("3j. today, a 200 A upgrade: the same plus $212 + $25.44 — never the clamped $150, never a floor",
    withMpu.permitFeeUsd === Math.round((without.permitFeeUsd! + 237.44) * 100) / 100 && withMpu.permitFeeUsd === sum(withMpu) && !withMpu.permitFeeIsFloor,
    `${withMpu.permitFeeUsd} vs ${without.permitFeeUsd}`);
}

db.close();
console.log(failures ? `\n${failures} FAILED` : "\nall Portland services/feeders + composition checks passed");
process.exit(failures ? 1 : 0);
