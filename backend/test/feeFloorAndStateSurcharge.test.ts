// #421 — TWO GENERIC RULES OF THE QUOTE, for every jurisdiction.
//
// 1. THE FLOOR. A published schedule that is FOUND but does not resolve (an unpriced line, an
//    unanswered condition) must never be quoted LOWER than the sum of the lines it could price.
//    Measured: both live City of Portland jobs printed the clamped 1.5%-of-valuation $150 beside
//    $739.55 / $881.77 of lines the same evaluation had priced. The quote now shows that sum as
//    what it is — "AT LEAST $X, PLUS <the unpriced items>" — and only when nothing priced does it
//    fall to the old path.
// 2. THE STATE SURCHARGE. Oregon levies 12% on every permit fee (ORS 455.210/455.220). A schedule
//    that holds it (on the bracket, or as a charge) is priced as before; one that holds none used
//    to get a notice ("PLUS the state surcharge … NOT included"). The quote now ADDS it, itemised,
//    on the permit lines only (and their services lines), never on a review, never twice, never off
//    the permit track, never in a state with no cited rule — and never inside the schedule's own
//    line amount, which a Confirm, a printed form and the electrical PDF read.
//
// Synthetic jurisdictions and invented amounts throughout.
// Run: npx tsx backend/test/feeFloorAndStateSurcharge.test.ts
import "./_isolate"; // FIRST
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectRecord } from "../../shared/src/types";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-floor-surcharge-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.sqlite");
process.env.SUBMISSION_SERVICE_FEE_USD = "0";
process.env.FEE_RESEARCH = "off";
process.env.ANTHROPIC_API_KEY = "";
delete process.env.PERMIT_FEE_ESTIMATE_RATE;
delete process.env.PERMIT_FEE_ESTIMATE_MIN_USD;
delete process.env.PERMIT_FEE_ESTIMATE_MAX_USD;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const F = await import("../src/feeSchedules");
const { buildPaymentQuote, buildProjectFeeSheet, feeConfirmRows } = await import("../src/submissionFees");

const db = await openDatabase();
let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
};

const URL = "https://fees.example.gov/schedule.pdf";
let seq = 0;
function put(state: string, ahj: string, discipline: string, basis: string, brackets: unknown[], track: "permit" | "nem" = "permit", utility = ""): void {
  const key = F.feeScheduleProfileKey({ state, ahj, utility }, track);
  const ts = new Date().toISOString();
  db.run(
    `INSERT INTO fee_schedules (id, profile_key, state, ahj, utility, track, basis, brackets_json, notes, source_url, source_quote,
       source_kind, confidence, first_seen_at, updated_at, verified_at, verified_by, payment_method, discipline, collected_by_profile_key,
       status, document_date, candidates_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, '', 'official', 'seeded', ?, ?, '', '', '', ?, '', 'ok', '', '[]')`,
    [`fs-${++seq}`, key, state, ahj, utility, track, basis, JSON.stringify(brackets), URL, ts, ts, discipline],
  );
}
const client = createClient(db, { companyName: "Synthetic Solar", billingMode: "monthly" });
function project(state: string, ahj: string, acKw: number | null, snapshot: Record<string, unknown> = { jobValue: "10000" }, utility = "Synthetic Power"): ProjectRecord {
  const pid = `p-${++seq}`;
  const now = new Date().toISOString();
  const dc = acKw == null ? null : acKw * 1.15;
  db.run(
    `INSERT INTO projects (id, client_id, homeowner_name, state, ahj, utility, system_size_dc_kw, system_size_ac_kw, status, parser_json, created_at, updated_at)
     VALUES (?, ?, 'Synthetic Owner', ?, ?, ?, ?, ?, 'ready_to_stage', ?, ?, ?)`,
    [pid, client.id, state, ahj, utility, dc, acKw, JSON.stringify(snapshot), now, now],
  );
  return { id: pid, clientId: client.id, state, ahj, utility, systemSizeDcKw: dc, systemSizeAcKw: acKw, totalExportKw: null, parserSnapshot: snapshot } as unknown as ProjectRecord;
}
const whenRequired = { label: "Electrical plan review (when required)", kind: "plan_review", amountUsd: 80, percentOf: "", conditional: true, condition: "when required or requested", appliesTo: "", quote: "Electrical plan review (when required) $80.00", sourceUrl: URL, matchedLine: "Electrical plan review (when required) | $ | 80.00" };

// ── 1. THE FLOOR (Washington: no state surcharge rule, so the floor is the schedule's alone) ────
console.log("\n1. THE FLOOR");
put("WA", "City of Floorville", "", "system_kw", [{ minKw: 0, maxKw: 25, feeUsd: 400, label: "Solar PV, 25 kVA or less | $ | 400.00", ancillaryCharges: [whenRequired] }]);
{
  // jobValue $10,000 -> valuation $4,000 -> 1.5% = $60, clamped UP to $150: the guess sits $250
  // BELOW the line the schedule priced, which is exactly the live Portland shape.
  const p = project("WA", "City of Floorville", 7);
  const q = buildPaymentQuote(db, p, "permit");
  check("1a. a schedule that priced a line and left a condition unanswered quotes the priced line as a FLOOR — never the $150 guess below it",
    q.permitFeeUsd === 400 && q.permitFeeIsFloor === true && q.permitFeeSource === "published_schedule" && q.permitFeeConfidence === "estimated",
    `${q.permitFeeUsd} ${q.permitFeeSource} ${q.permitFeeConfidence} ${q.permitFeeBasis.slice(0, 160)}`);
  check("1b. …it says AT LEAST, names what is left out, and keeps the schedule's own UNRESOLVED reason word for word",
    /^AT LEAST \$400\.00 — /.test(q.permitFeeBasis) && q.permitFeeBasis.includes('PLUS "Electrical plan review (when required)", not yet priced')
      && /was found but did not resolve: CONDITIONAL CHARGE UNRESOLVED/.test(q.permitFeeBasis) && /total stays UNRESOLVED rather than smaller/.test(q.permitFeeBasis),
    q.permitFeeBasis.slice(0, 400));
  const sheet = buildProjectFeeSheet(db, p);
  const line = sheet.lines.find((l) => l.track === "permit")!;
  check("1c. the sheet: a floor is not knowledge (known:false), not confirmable, flagged feeIsFloor, and listed as AT LEAST under unknowns",
    line.feeIsFloor === true && line.known === false && line.confirmable === false
      && sheet.unknowns.some((u) => /^Permit fee for City of Floorville is AT LEAST \$400\.00, not a known fee/.test(u)),
    JSON.stringify(sheet.unknowns).slice(0, 300));
  // NOTHING PRICED KEEPS TODAY'S PATH: no system size, so the only line misses.
  const unsized = buildPaymentQuote(db, project("WA", "City of Floorville", null), "permit");
  check("1d. MUST-EXCLUDE: where no line priced, today's behaviour stays — no floor, the old ladder and the schedule's reason",
    !unsized.permitFeeIsFloor && unsized.permitFeeSource !== "published_schedule" && !/AT LEAST/.test(unsized.permitFeeBasis)
      && /was found but did not resolve: City of Floorville: Schedule brackets on system size/.test(unsized.permitFeeBasis),
    `${unsized.permitFeeSource} ${unsized.permitFeeBasis.slice(0, 200)}`);
}
{
  // TWO PERMITS, ONE UNRESOLVED: the priced permit is the floor, the other is named.
  put("WA", "City of Halfbay", "structural", "flat", [{ feeUsd: 200, label: "Solar structural permit | $ | 200.00" }]);
  // A basis no evaluator reads (two lines, basis "other"): the line refuses — "needs a human to read it".
  put("WA", "City of Halfbay", "electrical", "other", [{ feeUsd: 90, label: "Electrical, residential | $ | 90.00" }, { feeUsd: 140, label: "Electrical, commercial | $ | 140.00" }]);
  const q = buildPaymentQuote(db, project("WA", "City of Halfbay", 7, {}), "permit");
  check("1e. two permits, one refused (a basis a human has to read): AT LEAST the priced one, PLUS the other permit by name",
    q.permitFeeUsd === 200 && q.permitFeeIsFloor === true && /PLUS the City of Halfbay electrical permit, not yet priced/.test(q.permitFeeBasis),
    `${q.permitFeeUsd} ${q.permitFeeBasis.slice(0, 200)}`);
  const r = F.feeForProject(db, project("WA", "City of Halfbay", 7, {}), "permit")!;
  check("1f. the schedule's own answer stays a refusal: feeUsd null, the floor reported beside it, the gap named",
    r.feeUsd === null && r.pricedSubtotalUsd === 200 && JSON.stringify(r.unpricedItems) === JSON.stringify(["the City of Halfbay electrical permit"]),
    JSON.stringify({ f: r.feeUsd, s: r.pricedSubtotalUsd, u: r.unpricedItems }));
}
{
  // THE FLOOR NEVER QUOTES LOWER THAN THE GUESS IT REPLACED. jobValue $75,000 -> valuation $30,000
  // -> 1.5% = $450, inside the clamp: the guess sits $250 ABOVE the $200 the schedule priced. The
  // floor is a true lower bound, but quoting it would print a SMALLER number than the ladder did
  // before the floor existed — the mirror of the Portland defect. The quote is the larger of the two.
  put("WA", "City of Lowfloor", "", "system_kw", [{ minKw: 0, maxKw: 25, feeUsd: 200, label: "Solar PV, 25 kVA or less | $ | 200.00", ancillaryCharges: [whenRequired] }]);
  const q = buildPaymentQuote(db, project("WA", "City of Lowfloor", 7, { jobValue: "75000" }), "permit");
  check("1g. a floor BELOW the valuation estimate never lowers the quote: the $450 estimate stands, not AT LEAST $200",
    q.permitFeeUsd === 450 && q.permitFeeSource === "valuation_estimate" && q.permitFeeConfidence === "estimated" && !q.permitFeeIsFloor,
    `${q.permitFeeUsd} ${q.permitFeeSource} ${q.permitFeeConfidence} floor=${q.permitFeeIsFloor} ${q.permitFeeBasis.slice(0, 160)}`);
  check("1h. …and the floor is still said beside it: the basis names the $200 priced and the item left out",
    /^Rough estimate: /.test(q.permitFeeBasis) && q.permitFeeBasis.includes('The schedule DID price part of this filing: AT LEAST $200.00, PLUS "Electrical plan review (when required)", not yet priced')
      && /was found but did not resolve: CONDITIONAL CHARGE UNRESOLVED/.test(q.permitFeeBasis),
    q.permitFeeBasis.slice(0, 500));
}

// ── 2. THE STATE SURCHARGE ──────────────────────────────────────────────────────────────────────
console.log("\n2. THE STATE SURCHARGE");
const heldOnBracket = { percent: 12, quote: "State surcharge (12% of permit fee)", sourceUrl: URL };
put("OR", "City of Surchargeville", "structural", "flat", [{ feeUsd: 200, label: "Solar structural permit | $ | 200.00" }]);
put("OR", "City of Surchargeville", "electrical", "system_kw", [{ minKw: 0, maxKw: 25, feeUsd: 150, label: "Renewable energy, 25 kVA or less | $ | 150.00", stateSurcharge: heldOnBracket }]);
{
  const p = project("OR", "City of Surchargeville", 7);
  const r = F.feeForProject(db, p, "permit")!;
  const st = r.lines.find((l) => l.discipline === "structural")!;
  const el = r.lines.find((l) => l.discipline === "electrical")!;
  check("2a. the SCHEDULE's answer is unchanged: structural $200 (reported as owing a modeled 12% of $200), electrical $168 (holds its own)",
    r.feeUsd === 368 && st.feeUsd === 200 && st.modeledStateSurcharge?.percent === 12 && st.modeledStateSurcharge?.ofUsd === 200
      && el.feeUsd === 168 && !el.modeledStateSurcharge,
    JSON.stringify({ t: r.feeUsd, st: [st.feeUsd, st.modeledStateSurcharge], el: [el.feeUsd, el.modeledStateSurcharge] }));
  const q = buildPaymentQuote(db, p, "permit");
  const added = q.permitFeeCharges.filter((c) => c.kind === "state_surcharge" && !c.partOfLineFee);
  check("2b. the QUOTE adds the 12% the structural row does not hold — $368 + $24 = $392 — as ONE itemised charge on that permit only",
    q.permitFeeUsd === 392 && added.length === 1 && added[0].amountUsd === 24 && /City of Surchargeville building\/structural permit fee/.test(added[0].label)
      && /ORS 455\.210/.test(added[0].quote),
    `${q.permitFeeUsd} ${JSON.stringify(added)}`);
  check("2c. …says so in the basis, and no longer announces it as missing",
    /INCLUDES \$24\.00 of state surcharge the schedule does not print/.test(q.permitFeeBasis) && !/NOT included in this amount/.test(q.permitFeeBasis),
    q.permitFeeBasis.slice(-300));
  check("2d. MUST-EXCLUDE: what a Confirm would vouch for is the schedule's own bracket amounts ($200, $168) — never the modeled surcharge",
    feeConfirmRows(db, p, "permit").filter((r) => r.kind === "bracket").map((r) => r.feeUsd).sort().join(",") === "168,200",
    JSON.stringify(feeConfirmRows(db, p, "permit").map((r) => [r.kind, r.feeUsd])));
}
{
  put("WA", "City of Nosurcharge", "", "flat", [{ feeUsd: 200, label: "Solar permit | $ | 200.00" }]);
  const q = buildPaymentQuote(db, project("WA", "City of Nosurcharge", 7), "permit");
  check("2e. MUST-EXCLUDE: a state with no cited surcharge rule gets nothing added",
    q.permitFeeUsd === 200 && !q.permitFeeCharges.some((c) => c.kind === "state_surcharge"), `${q.permitFeeUsd}`);
  put("OR", "City of Allin", "", "flat", [{ feeUsd: 224, label: "Solar permit, total fee including state surcharge | $ | 224.00" }]);
  const qi = buildPaymentQuote(db, project("OR", "City of Allin", 7), "permit");
  check("2f. MUST-EXCLUDE: a printed fee that says it includes surcharges is not surcharged again",
    qi.permitFeeUsd === 224 && !qi.permitFeeCharges.some((c) => c.kind === "state_surcharge"), `${qi.permitFeeUsd}`);
  put("OR", "", "", "flat", [{ feeUsd: 100, label: "Interconnection application fee | $ | 100.00" }], "nem", "Synthetic Power");
  const qn = buildPaymentQuote(db, project("OR", "City of Allin", 7), "nem");
  check("2g. MUST-EXCLUDE: never on the interconnection (NEM) track", qn.permitFeeUsd === 100 && !qn.permitFeeCharges.some((c) => c.kind === "state_surcharge"), `${qn.permitFeeUsd}`);
}
{
  // A services line on an electrical row holding NO surcharge: the modeled 12% is OF the permit and
  // its services line together ($150 + $50), and never of anything else on the filing.
  const svc = { label: "Services or feeders: 200 amps or less", kind: "other", amountUsd: 50, percentOf: "", conditional: false, condition: "", appliesTo: "electrical", quote: "Services or feeders: 200 amps or less | $ | 50.00", sourceUrl: URL, matchedLine: "Services or feeders: 200 amps or less | $ | 50.00" };
  const review = { label: "Electrical plan review | $ | 40.00", kind: "plan_review", amountUsd: 40, percentOf: "", conditional: false, condition: "", appliesTo: "electrical", quote: "Electrical plan review $40.00", sourceUrl: URL, matchedLine: "Electrical plan review | $ | 40.00" };
  put("OR", "City of Servicebay", "electrical", "system_kw", [{ minKw: 0, maxKw: 25, feeUsd: 150, label: "Renewable energy, 25 kVA or less | $ | 150.00", ancillaryCharges: [svc, review] }]);
  const p = project("OR", "City of Servicebay", 7, { scopeText: "Main panel upgrade to 200A", mainBreaker: "200A", hasBattery: "No", jobValue: "10000" });
  const q = buildPaymentQuote(db, p, "permit");
  const added = q.permitFeeCharges.filter((c) => c.kind === "state_surcharge" && !c.partOfLineFee);
  check("2h. the modeled 12% covers the permit AND its services line ($150 + $50 -> $24), not the $40 review: $150 + $50 + $40 + $24 = $264",
    q.permitFeeUsd === 264 && added.length === 1 && added[0].amountUsd === 24 && /12% of \$200\.00/.test(added[0].quote),
    `${q.permitFeeUsd} ${JSON.stringify(added)}`);
}

db.close();
console.log(failures ? `\n${failures} FAILED` : "\nall fee floor + state surcharge checks passed");
process.exit(failures ? 1 : 0);
