// THE FEE TABLE PRINTED ON THE AHJ'S OWN FORM AS A DATED, LOWER-TRUST CROSS-CHECK (#454).
//
// Owner ask 2026-10-31 ("can we use these as another way of the fee structure estimates", then
// "Cross check is good"): the fee tables printed on the stored AHJ blanks become a cross-check on
// the payment quote, never a replacement for a saved schedule, a recorded real fee or a verified
// row (hard rule 3).
//
//   DATA          every held printed table is tied to its blank's exact bytes, and every amount it
//                 carries is printed on that blank; the surcharges evaluated from the percentages
//                 reproduce the amounts the blanks print (B-01S $8.07, Tigard $21.60 / $201.60).
//                 The held Coos County blank ("Revised 2025") prints its fee column empty and
//                 carries no table.
//   AGREES        Marion B-01S + E-01 and Tigard building + electrical against schedules saved
//                 through the real write path at the printed figures: per-discipline "agrees".
//   DISAGREES     Coos County's 12/23/2022 printing ($79/$94/$156) against the adopted schedule
//                 ($135/$160/$265): the check says so by $62.72 and the quote does not move.
//   NEVER WINS    a saved schedule (seeded or verified), a recorded history fee and an entered
//                 actual each keep the amount; printed_form answers only below the valuation
//                 estimate (no schedule, no history, no valuation), graded "estimated".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "printed-form-fee-check-"));
process.env.AUTOPILOT_DB_PATH = path.join(temp, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.PROJECT_DOCS_DIR = path.join(temp, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(temp, "profiles");
process.env.BACKUP_DIR = path.join(temp, "backups");
process.env.SUBMISSION_SERVICE_FEE_USD = "0";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { buildPaymentQuote, buildProjectFeeSheet, recordActualPermitFee } = await import("../src/submissionFees");
const { saveFeeSchedule, newFeeDocumentLedger, markFeeScheduleVerified, feeScheduleProfileKey } = await import("../src/feeSchedules");
const { CURATED_AHJ_FORMS, curatedPrintedFeeTable, curatedPrintedFees } = await import("../src/curatedAhjForms");
const { printedFeeCompositions, printedFormCheck, composePrintedTable, heldPrintedFeeTables } = await import("../src/printedFormFees");
const { extractPdfTextItems } = await import("../src/pdfTables");
type Finding = import("../src/feeSchedules").FeeScheduleFinding;
type PrintedFeeTable = import("../src/curatedAhjForms").PrintedFeeTable;

const db = await openDatabase();
let passed = 0;
const failed: string[] = [];
const check = (name: string, cond: unknown, detail = ""): void => {
  if (cond) { passed++; console.log(`ok   - ${name}`); return; }
  failed.push(name);
  console.error(`FAIL - ${name}${detail ? `\n         ${detail.slice(0, 900)}` : ""}`);
};

const client = createClient(db, { companyName: "Printed Check Solar", billingMode: "per_submission", serviceFeeUsd: "0" });
const now = new Date().toISOString();
let seq = 0;
type P = { id: string; clientId: string; state: string; ahj: string; utility: string; systemSizeDcKw: number | null; systemSizeAcKw: number | null; parserSnapshot: Record<string, unknown> };
const project = (ahj: string, over: Partial<P> = {}): P => {
  const p: P = { id: `printed-${++seq}`, clientId: client.id, state: "OR", ahj, utility: "Pacific Power",
    systemSizeDcKw: 5, systemSizeAcKw: 4, parserSnapshot: { permitPathOverride: "prescriptive" }, ...over };
  db.run(
    `INSERT INTO projects (id, client_id, homeowner_name, state, ahj, utility, system_size_dc_kw, status, parser_json, created_at, updated_at)
     VALUES (?, ?, 'Synthetic Owner', ?, ?, ?, ?, 'ready_to_stage', ?, ?, ?)`,
    [p.id, p.clientId, p.state, p.ahj, p.utility, p.systemSizeDcKw, JSON.stringify(p.parserSnapshot), now, now],
  );
  return p;
};
const quote = (p: P, track = "permit") => buildPaymentQuote(db, p as never, track);

// The real write path, with the state surcharge re-derived from the cited document like research does.
const SURCHARGE_NOTE = "Note: A 12% surcharge fee as mandated by the State Building Codes Division is applied to all permit fees.";
const save = (ahj: string, discipline: "electrical" | "structural", url: string, brackets: Finding["brackets"], corpusLines: string[]): void => {
  const finding: Finding = {
    found: true, reason: "", basis: discipline === "structural" ? "flat" : "system_kw", brackets, notes: "",
    sourceUrl: url, sourceQuote: corpusLines[0], sourceKind: "official", paymentMethod: "portal",
  };
  const ledger = newFeeDocumentLedger();
  const corpus = [...corpusLines, SURCHARGE_NOTE].join("\n");
  ledger.evidence.push({ url, via: "http", status: 200, kind: "pdf", bytes: corpus.length, handed: 4 });
  ledger.corpus.push(corpus);
  saveFeeSchedule(db, { state: "OR", ahj, track: "permit", discipline }, finding, { corroborateAgainst: ledger });
};

const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join("backend/test/fixtures", name)));
const blankText = async (name: string): Promise<string> =>
  (await extractPdfTextItems(fixture(name))).map((i) => (i as { str?: string }).str ?? "").join(" ").replace(/\s+/g, " ");
const money = (n: number) => n.toFixed(2);

try {
  // ═══ DATA: each printed table is the blank's own ═════════════════════════════════════════════
  const FIXTURE_FOR: Record<string, string> = {
    "City of Tigard Residential Building Permit Application": "tigard-building.pdf",
    "City of Tigard Electrical Permit Application": "tigard-electrical.pdf",
    "Coos County Electrical Permit Application": "coos-electrical.pdf",
    "Marion County Prescriptive Solar Photovoltaic Installation Permit Application (B-01S)": "marion-b-01s.pdf",
    "Marion County Renewable Electrical Energy Permit Application (E-01)": "marion-e-01.pdf",
  };
  const held = heldPrintedFeeTables();
  check("printed tables are held for Marion B-01S, Marion E-01, Tigard building and Tigard electrical — and not for the Coos blank",
    held.map((h) => h.formName).sort().join("|") === [
      "City of Tigard Electrical Permit Application", "City of Tigard Residential Building Permit Application",
      "Marion County Prescriptive Solar Photovoltaic Installation Permit Application (B-01S)",
      "Marion County Renewable Electrical Energy Permit Application (E-01)"].join("|"),
    JSON.stringify(held.map((h) => h.formName)));
  for (const source of CURATED_AHJ_FORMS) {
    const file = FIXTURE_FOR[source.formName];
    if (!file) continue;
    const bytes = fixture(file);
    check(`${file}: the fixture IS the curated blank (same sha256)`, createHash("sha256").update(bytes).digest("hex") === source.hash);
    const table = curatedPrintedFeeTable(source);
    const text = await blankText(file);
    if (!table) {
      // Every two-decimal number on the blank is a kVA bound ("5.01 kva to 15 kva", "25.01 to 50 kva").
      const amounts = text.match(/\b\d{1,4}\.\d\d\b(?!\s*(?:kva|to)\b)/gi) ?? [];
      check(`${file}: carries no printed table AND prints no fee amounts`, !amounts.length, amounts.join(" "));
      continue;
    }
    check(`${file}: the printed date is the blank's own words (or "" with the fetch date)`,
      table.printedDate ? text.includes(table.printedDate.replace(/ \(printed footer\)$/, "")) : table.copyFetched === "2026-09-27",
      table.printedDate);
    for (const l of table.lines) check(`${file}: "${l.label}" ${money(l.amountUsd)} is printed on the blank`, text.includes(money(l.amountUsd)));
    for (const s of table.surcharges) check(`${file}: the ${s.percent}% surcharge is printed on the blank, as a percentage`, text.includes(`${s.percent}%`) || text.includes(`${s.percent} %`));
    check(`${file}: surcharges are carried as percentages, never pre-multiplied amounts`,
      table.surcharges.every((s) => Object.keys(s).sort().join() === "label,percent"));
  }
  const b01sText = await blankText("marion-b-01s.pdf");
  const tigardText = await blankText("tigard-building.pdf");
  const marion4 = printedFeeCompositions(project("Marion County"));
  const b01s = marion4.compositions.find((c) => c.discipline === "structural");
  check("B-01S composition: (a) $67.25 + (b) 12% = $8.07 — the $8.07 the blank prints", b01s?.lines.map((l) => l.amountUsd).join() === "67.25,8.07" && b01sText.includes("8.07") && b01s.totalUsd === 75.32, JSON.stringify(b01s));
  const e01 = marion4.compositions.find((c) => c.discipline === "electrical");
  check("E-01 composition at 4 kVA: $79.00 + 12% $9.48 = $88.48", e01?.totalUsd === 88.48 && e01.printedDate === "06/20 (printed footer)", JSON.stringify(e01));
  const tigard10 = printedFeeCompositions(project("City of Tigard", { systemSizeAcKw: 10, systemSizeDcKw: 11 }));
  const tb = tigard10.compositions.find((c) => c.discipline === "structural");
  check("Tigard PV block: $180.00 + 12% = $21.60, total $201.60 — exactly what the blank prints",
    tb?.lines.map((l) => l.amountUsd).join() === "180,21.6" && tb.totalUsd === 201.6 && tigardText.includes("21.60") && tigardText.includes("201.60"), JSON.stringify(tb));
  const te = tigard10.compositions.find((c) => c.discipline === "electrical");
  check("Tigard renewable row 5.01-15 kVA at 10 kVA: $133.56 + 12% rounded per line $16.03 = $149.59", te?.totalUsd === 149.59, JSON.stringify(te));
  check("Tigard printed composition (both forms) = $351.19, the paid REP receipt amount recorded in feeSchedules.ts",
    Math.round((tb!.totalUsd + te!.totalUsd) * 100) / 100 === 351.19);
  check("the E-01 fill ladder is unchanged (Marion E-01 only; Tigard electrical's table is cross-check only)",
    JSON.stringify(curatedPrintedFees(fixture("marion-e-01.pdf"))?.tiers) === JSON.stringify([{ maxKva: 5, feeUsd: 79 }, { maxKva: 15, feeUsd: 94 }, { maxKva: 25, feeUsd: 156 }])
      && curatedPrintedFees(fixture("marion-e-01.pdf"))?.stateSurchargePercent === 12 && curatedPrintedFees(fixture("tigard-electrical.pdf")) == null);

  // A table that does not price the job says why, and is never composed.
  const eng = printedFeeCompositions(project("Marion County", { parserSnapshot: { permitPathOverride: "engineered" } }));
  check("an engineered job: the prescriptive B-01S does not price it (skipped, with the reason)",
    !eng.compositions.some((c) => c.discipline === "structural") && eng.skipped.some((s) => /prescriptive path/.test(s)), JSON.stringify(eng.skipped));
  const big = printedFeeCompositions(project("Marion County", { systemSizeAcKw: 30, systemSizeDcKw: 34 }));
  check("over 25 kVA: the per-kVA rows are never computed (skipped, with the reason)",
    !big.compositions.some((c) => c.discipline === "electrical") && big.skipped.some((s) => /per-kVA/.test(s)), JSON.stringify(big.skipped));

  // ═══ THE printed_form RUNG: below the valuation estimate, graded "estimated" ════════════════
  // Tigard before any schedule is saved: AC size on file, no DC, no contract → no valuation.
  const noValuation = project("City of Tigard", { systemSizeAcKw: 10, systemSizeDcKw: null });
  const qp = quote(noValuation);
  check("no schedule, no history, no valuation: the printed table answers — source printed_form, $351.19, estimated",
    qp.permitFeeSource === "printed_form" && qp.permitFeeUsd === 351.19 && qp.permitFeeConfidence === "estimated", `${qp.permitFeeSource} ${qp.permitFeeUsd} ${qp.permitFeeConfidence}`);
  check("  its basis names each printed form and its printed date, and says it may be out of date",
    /Rev 06\/17\/2015/.test(qp.permitFeeBasis) && /01\/25\/2023/.test(qp.permitFeeBasis) && /out of date/.test(qp.permitFeeBasis), qp.permitFeeBasis);
  check("  the cross-check does not compare the printed table with itself", qp.printedFormCheck?.verdict === "not_comparable", JSON.stringify(qp.printedFormCheck));
  const sheetLine = buildProjectFeeSheet(db, noValuation as never);
  const permitSheet = sheetLine.lines.find((l) => l.track === "permit");
  check("  the fee sheet does not call it known, and names the gap",
    permitSheet?.known === false && sheetLine.unknowns.some((u) => /printed on/.test(u) && /years out of date/.test(u)), JSON.stringify(sheetLine.unknowns));
  const withValuation = project("City of Tigard", { systemSizeAcKw: 10, systemSizeDcKw: 11 });
  const qv = quote(withValuation);
  check("with a valuation on file the estimate keeps the amount (printed_form ranks below it)",
    qv.permitFeeSource === "valuation_estimate", `${qv.permitFeeSource} ${qv.permitFeeUsd}`);
  check("  and the cross-check reports the printed composition beside it",
    qv.printedFormCheck?.printedUsd === 351.19 && ["agrees", "disagrees"].includes(qv.printedFormCheck.verdict)
      && qv.printedFormCheck.compared[0]?.what === "total", JSON.stringify(qv.printedFormCheck));
  const qn = quote(withValuation, "nem");
  check("the NEM track carries no printed-form check", qn.printedFormCheck === null);

  // ═══ AGREES: schedules saved at the printed figures ═══════════════════════════════════════════
  save("City of Tigard", "electrical", "https://example.test/tigard-electrical-fees.pdf",
    [{ maxKw: 5, feeUsd: 100.70, label: "Renewable energy 5 kva or less" }, { minKw: 5.01, maxKw: 15, feeUsd: 133.56, label: "Renewable energy 5.01 to 15 kva" }, { minKw: 15.01, maxKw: 25, feeUsd: 200.34, label: "Renewable energy 15.01 to 25 kva" }],
    ["Renewable energy 5 kva or less | $100.70", "Renewable energy 5.01 to 15 kva | $133.56", "Renewable energy 15.01 to 25 kva | $200.34"]);
  save("City of Tigard", "structural", "https://example.test/tigard-building-fees.pdf",
    [{ feeUsd: 180, label: "Photovoltaic solar panel system permit fee" }], ["Photovoltaic solar panel system permit fee | $180.00"]);
  const qt = quote(project("City of Tigard", { systemSizeAcKw: 10, systemSizeDcKw: 11 }));
  check("Tigard: the saved schedules price the job ($351.19, published_schedule)", qt.permitFeeSource === "published_schedule" && qt.permitFeeUsd === 351.19, `${qt.permitFeeSource} ${qt.permitFeeUsd}`);
  check("Tigard: the check AGREES, discipline by discipline", qt.printedFormCheck?.verdict === "agrees"
    && qt.printedFormCheck.compared.map((c) => `${c.what}:${c.differenceUsd}`).sort().join() === "electrical:0,structural:0", JSON.stringify(qt.printedFormCheck));
  check("  and lists the printed lines it compared, with each form's printed date",
    qt.printedFormCheck!.lines.length === 4 && qt.printedFormCheck!.forms.map((f) => f.printedDate).sort().join("|") === "01/25/2023 (printed footer)|Rev 06/17/2015");

  save("Marion County", "structural", "https://example.test/marion-building-fees.pdf",
    [{ feeUsd: 67.25, label: "Prescriptive solar permit fee" }], ["Prescriptive solar permit fee | $67.25"]);
  save("Marion County", "electrical", "https://example.test/marion-electrical-fees.pdf",
    [{ maxKw: 5, feeUsd: 79, label: "Solar 5 kva or less" }, { minKw: 5.01, maxKw: 15, feeUsd: 94, label: "Solar 5.01 to 15 kva" }, { minKw: 15.01, maxKw: 25, feeUsd: 156, label: "Solar 15.01 to 25 kva" }],
    ["Solar 5 kva or less | $79.00", "Solar 5.01 to 15 kva | $94.00", "Solar 15.01 to 25 kva | $156.00"]);
  const marionJob = project("Marion County");
  const qm = quote(marionJob);
  check("Marion: the saved schedules price the job ($75.32 + $88.48 = $163.80)", qm.permitFeeSource === "published_schedule" && qm.permitFeeUsd === 163.8, `${qm.permitFeeSource} ${qm.permitFeeUsd}`);
  check("Marion: the check AGREES with the B-01S and the E-01", qm.printedFormCheck?.verdict === "agrees"
    && qm.printedFormCheck.compared.length === 2 && /B-01S/.test(qm.printedFormCheck.note) && /E-01/.test(qm.printedFormCheck.note), JSON.stringify(qm.printedFormCheck));

  // ═══ A SAVED SCHEDULE IS NEVER OVERRIDDEN ═════════════════════════════════════════════════════
  save("Marion County", "structural", "https://example.test/marion-building-fees-2026.pdf",
    [{ feeUsd: 100, label: "Prescriptive solar permit fee (2026)" }], ["Prescriptive solar permit fee (2026) | $100.00"]);
  const qd = quote(project("Marion County"));
  check("a saved schedule that disagrees with the printed form keeps the amount ($112.00 + $88.48)",
    qd.permitFeeSource === "published_schedule" && qd.permitFeeUsd === 200.48, `${qd.permitFeeSource} ${qd.permitFeeUsd}`);
  check("  and the check DISAGREES on the structural permit by $36.68, as a note",
    qd.printedFormCheck?.verdict === "disagrees" && qd.printedFormCheck.differenceUsd === 36.68
      && qd.printedFormCheck.compared.find((c) => c.what === "structural")?.differenceUsd === 36.68
      && /structural permit is \$36\.68 more than printed/.test(qd.printedFormCheck.note) && /quote stands/.test(qd.printedFormCheck.note),
    JSON.stringify(qd.printedFormCheck));
  markFeeScheduleVerified(db, feeScheduleProfileKey({ state: "OR", ahj: "Marion County" }, "permit"), "permit", "Synthetic Verifier", "structural");
  const qverified = quote(project("Marion County"));
  check("a HUMAN-VERIFIED schedule keeps the amount too (hard rule 3)",
    qverified.permitFeeSource === "published_schedule" && qverified.permitFeeUsd === 200.48 && qverified.printedFormCheck?.verdict === "disagrees",
    `${qverified.permitFeeSource} ${qverified.permitFeeUsd} ${qverified.permitFeeConfidence}`);
  const recorded = recordActualPermitFee(db, marionJob as never, "permit", 250, "operator");
  check("an entered portal fee keeps the amount, and the check compares against it",
    recorded.permitFeeSource === "actual" && recorded.permitFeeUsd === 250 && recorded.printedFormCheck?.compared[0]?.what === "total"
      && recorded.printedFormCheck.verdict === "disagrees", JSON.stringify(recorded.printedFormCheck));
  // A recorded real fee (permit_fee_history) for an AHJ with no schedule, no valuation.
  db.run(`INSERT INTO permit_fee_history (id, state, ahj, utility, track, fee_usd, source, project_id, recorded_at) VALUES (?, 'OR', 'City of Historyville', '', 'permit', 210, 'operator', NULL, ?)`, ["hist-1", now]);
  const qh = quote(project("City of Historyville", { systemSizeDcKw: null }));
  check("a recorded history fee is never displaced by a printed table", qh.permitFeeSource === "learned_history" && qh.permitFeeUsd === 210, `${qh.permitFeeSource} ${qh.permitFeeUsd}`);
  check("  and an AHJ with no held form reports no printed table", qh.printedFormCheck?.verdict === "no_printed_table");

  // ═══ COOS COUNTY: the stale printed table, against the adopted schedule ══════════════════════
  save("City of Coos Bay", "electrical", "https://example.test/coos-adopted-fees.pdf",
    [{ maxKw: 5, feeUsd: 135, label: "5 kva or less" }, { minKw: 5.01, maxKw: 15, feeUsd: 160, label: "5.01 kva to 15 kva" }, { minKw: 15.01, maxKw: 25, feeUsd: 265, label: "15.01 kva to 25 kva" }],
    ["5 kva or less | $135.00", "5.01 kva to 15 kva | $160.00", "15.01 kva to 25 kva | $265.00"]);
  const coosJob = project("City of Coos Bay");
  const qc = quote(coosJob);
  check("Coos: the adopted schedule prices the 4 kVA job ($135.00 + 12% = $151.20)", qc.permitFeeSource === "published_schedule" && qc.permitFeeUsd === 151.2, `${qc.permitFeeSource} ${qc.permitFeeUsd}`);
  check("Coos: the held blank (Revised 2025) prints no amounts — the check says no printed table",
    qc.printedFormCheck?.verdict === "no_printed_table" && /prints? no fee amounts/.test(qc.printedFormCheck.note), JSON.stringify(qc.printedFormCheck));
  // The 12/23/2022 printing (documentDate.ts): $79 / $94 / $156 + the 12% state surcharge.
  const coos2022: PrintedFeeTable = {
    discipline: "electrical", printedDate: "Revised 12/23/2022",
    lines: [{ label: "5 kva or less", amountUsd: 79, maxKva: 5 }, { label: "5.01 kva to 15 kva", amountUsd: 94, maxKva: 15 }, { label: "15.01 kva to 25 kva", amountUsd: 156, maxKva: 25 }],
    autoMaxKva: 25, surcharges: [{ label: "12% surcharge (.12 x subtotal)", percent: 12 }],
  };
  const composed = composePrintedTable(coos2022, coosJob as never);
  const coosCheck = printedFormCheck(coosJob as never, qc.permitFeeUsd, qc.permitFeeSource,
    [{ discipline: "electrical", feeUsd: qc.permitFeeUsd }],
    { compositions: "reason" in composed ? [] : [{ discipline: "electrical", formName: "Coos County Electrical Permit Application", printedDate: coos2022.printedDate, sourceUrl: "", ...composed }],
      skipped: [], tablesHeld: 1, formsHeld: 1 });
  check("Coos 12/23/2022 printing against the adopted schedule: DISAGREES by $62.72 ($151.20 quoted, $88.48 printed — 1.70x)",
    coosCheck.verdict === "disagrees" && coosCheck.differenceUsd === 62.72 && coosCheck.printedUsd === 88.48
      && /\$62\.72 more than printed/.test(coosCheck.note) && /Revised 12\/23\/2022/.test(coosCheck.note), JSON.stringify(coosCheck));
  const qcAgain = quote(coosJob);
  check("  and the quote does not move", qcAgain.permitFeeUsd === 151.2 && qcAgain.permitFeeSource === "published_schedule");
  const stored = db.get<{ permit_fee_estimate_usd: number }>("SELECT permit_fee_estimate_usd FROM submission_payments WHERE project_id = ? AND track = 'permit'", [coosJob.id]);
  check("  nor the persisted quote row", stored?.permit_fee_estimate_usd === 151.2, JSON.stringify(stored));
  const scheduleRows = db.query<{ n: number }>("SELECT COUNT(*) AS n FROM fee_schedules WHERE notes LIKE '%printed%form%'");
  check("nothing printed is ever written to the fee store", Number(scheduleRows[0]?.n ?? 0) === 0);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

if (failed.length) {
  console.error(`printedFormFeeCheck: ${failed.length} FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`printedFormFeeCheck: ${passed} checks passed — printed fee tables are tied to their blanks, compose per line with percentage surcharges, agree with Marion and Tigard at the printed figures, flag Coos County's stale printing without moving the quote, and never displace a saved schedule, a verified row, a recorded fee or an entered actual`);
process.exit(0);
