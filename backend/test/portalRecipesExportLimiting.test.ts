// exportLimiting: ONE DERIVATION FOR LEARN AND REPLAY, AND "NO EVIDENCE" IS NOT "THE JOB SAYS NO" (#356).
//
// The replay map (resolveRecipeFieldValues) read only the snapshot's exportMode / pcs / exportLimit;
// the learner (buildPortalPlanner) read the design notes too. A PCS named only in the design notes was
// "Yes" at one and "No" at the other, and a no-evidence "No" read as the job's own answer once PR #353
// typed it into an unrecorded export question. Pinned here, through the real resolver and the real
// planner map, on synthetic projects:
//   - a PCS only in the design notes → "Yes" at learn AND replay;
//   - no evidence → "No", flagged as no evidence (the standing answer), and the flag never reaches the
//     planner's view (rule 2 / LLM cost: no new text to a model);
//   - an explicit "No" from the design → "No", from the job (flag empty).
//
// Run: npx tsx backend/test/portalRecipesExportLimiting.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-limiting-test-"));
  process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");
  const { openDatabase } = await import("../src/db");
  const { resolveRecipeFieldValues } = await import("../src/portalRecipes");
  const { buildPortalPlanner, plannerFieldView } = await import("../src/autoLearn");
  const { EXPORT_LIMITING_NO_EVIDENCE_KEY, exportLimitingFor } = await import("../../shared/src/exportLimiting");
  const db = await openDatabase();

  let failures = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
    else console.log(`ok   - ${name}`);
  };

  const project = (id: string, parserSnapshot: Record<string, unknown>) => ({
    id, clientId: null, homeownerName: "Test Person", projectAddress: "1 Example St",
    city: "Testville", state: "OR", zip: "97000", ahj: "Testville", utility: "Example Power",
    systemSizeDcKw: 8, systemSizeAcKw: 7.6, totalExportKw: null, interconnectionMethod: "",
    status: "parsed", currentStage: "", parserConfidenceSummary: "",
    parserSnapshot, createdAt: "2026-01-01", updatedAt: "2026-01-01",
  }) as never;
  const both = (p: never) => {
    const replay = resolveRecipeFieldValues(db, p, "powerclerk", "nem");
    const learn = buildPortalPlanner(db, p, { portalType: "powerclerk", scopeType: "utility" }).projectFields;
    return { replay, learn };
  };
  const flag = (m: Record<string, string>): string => String(m[EXPORT_LIMITING_NO_EVIDENCE_KEY] ?? "");

  // 1. A PCS ONLY IN THE DESIGN NOTES (no structured key says anything).
  {
    const p = project("p-notes-pcs", {
      sitePlanNotesText: "NEW PV SYSTEM ON EXISTING ROOF.\nPOWER CONTROL SYSTEM (PCS) CONFIGURED FOR NON-EXPORT OPERATION.\nAC DISCONNECT WITHIN 10 FT OF METER.",
    });
    const { replay, learn } = both(p);
    check("PCS only in the design notes → replay exportLimiting \"Yes\"", replay.exportLimiting === "Yes", replay.exportLimiting);
    check("PCS only in the design notes → learn exportLimiting \"Yes\" (the same answer)", learn.exportLimiting === "Yes", learn.exportLimiting);
    check("PCS only in the design notes → the job's own evidence (flag empty)", flag(replay) === "", flag(replay));
  }
  // The design digest's own topic lines carry an export limit the snapshot keys do not.
  {
    const p = project("p-notes-limit", { electricalCalcText: "SYSTEM EXPORT LIMIT 5 KW PER UTILITY" });
    const { replay, learn } = both(p);
    check("an export limit only in the electrical notes → \"Yes\" at both", replay.exportLimiting === "Yes" && learn.exportLimiting === "Yes", `${replay.exportLimiting}/${learn.exportLimiting}`);
  }

  // 2. NO EVIDENCE EITHER WAY.
  {
    const p = project("p-none", { sitePlanNotesText: "NEW PV SYSTEM ON EXISTING ROOF. AC DISCONNECT WITHIN 10 FT OF METER." });
    const { replay, learn } = both(p);
    check("no evidence → replay exportLimiting \"No\" (the standing answer, still emitted for bound steps)", replay.exportLimiting === "No", replay.exportLimiting);
    check("no evidence → learn exportLimiting \"No\"", learn.exportLimiting === "No", learn.exportLimiting);
    check("no evidence → flagged as no evidence on the job (\"1\")", flag(replay) === "1", JSON.stringify(flag(replay)));
    const view = plannerFieldView(learn);
    check("the no-evidence flag never reaches the planner's view (no new text to a model)", !(EXPORT_LIMITING_NO_EVIDENCE_KEY in view), Object.keys(view).filter((k) => /export/i.test(k)).join(","));
    check("the planner still gets exportLimiting itself", view.exportLimiting === "No", String(view.exportLimiting));
  }
  // A UL 1741 PCS LISTING is a certification on a data sheet, not a configured limit.
  {
    const p = project("p-listing", { planSetExtractedText: "INVERTER: IQ8PLUS-72-2-US, UL 1741 SB, UL 1741 PCS CRD LISTED" });
    const { replay, learn } = both(p);
    check("a UL 1741 PCS listing alone → \"No\", no evidence", replay.exportLimiting === "No" && learn.exportLimiting === "No" && flag(replay) === "1", `${replay.exportLimiting}/${learn.exportLimiting}/${flag(replay)}`);
  }

  // 3. AN EXPLICIT "NO" FROM THE DESIGN.
  {
    const p = project("p-exports", { exportMode: "export" });
    const { replay, learn } = both(p);
    check("exportMode \"export\" → \"No\" at both", replay.exportLimiting === "No" && learn.exportLimiting === "No", `${replay.exportLimiting}/${learn.exportLimiting}`);
    check("exportMode \"export\" → the job's own answer (flag empty)", flag(replay) === "", JSON.stringify(flag(replay)));
  }
  {
    const p = project("p-no-limit", { sitePlanNotesText: "NO EXPORT LIMIT. NO PCS REQUIRED." });
    const { replay, learn } = both(p);
    check("design notes \"NO EXPORT LIMIT. NO PCS\" → \"No\" at both (the shared regex alone read it as \"Yes\")", replay.exportLimiting === "No" && learn.exportLimiting === "No", `${replay.exportLimiting}/${learn.exportLimiting}`);
    check("design notes \"NO PCS\" → the job's own answer (flag empty)", flag(replay) === "", JSON.stringify(flag(replay)));
  }
  {
    const p = project("p-pcs-none", { pcs: "None" });
    check("pcs \"None\" → \"No\", the job's own", exportLimitingFor({ pcs: "None" }).value === "No" && flag(resolveRecipeFieldValues(db, p, "powerclerk", "nem")) === "");
  }

  // The structured keys still decide as before.
  for (const [snap, want] of [
    [{ exportMode: "non-export-pcs" }, "Yes"],
    [{ exportMode: "ngom" }, "Yes"],
    [{ pcs: "Tesla PCS" }, "Yes"],
    [{ exportLimit: "export limit 10 kW" }, "Yes"],
  ] as Array<[Record<string, unknown>, string]>) {
    const got = exportLimitingFor(snap);
    check(`structured ${JSON.stringify(snap)} → ${want} (job)`, got.value === want && got.evidence === "job", JSON.stringify(got));
  }
  // Evidence of a limit wins over a "No" elsewhere, as both derivations had it.
  check("a limit anywhere wins over a \"No\" elsewhere", exportLimitingFor({ exportMode: "export", sitePlanNotesText: "PCS LIMITS EXPORT TO 0 KW" }).value === "Yes");
  // The existing-system block's exportMode is read too (the resolver's own map carries it).
  check("the existing-system exportMode is read", exportLimitingFor({}, "non-export-pcs").value === "Yes");

  if (failures) {
    console.error(`\n${failures} exportLimiting check(s) FAILED.`);
    process.exit(1);
  }
  console.log("\nAll exportLimiting checks passed.");
}

main().catch((err) => { console.error(err); process.exit(1); });
