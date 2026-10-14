// THE PLANNER'S USER HALF STAYS INSIDE ITS BUDGET ON A SYSTEM ADDITION (#303).
//
// Live NEM stage 2026-10-10 (a utility's PowerClerk, an existing-system project): the planner's user
// half measured 5301 tokens against the 4000 budget (planPortalFields.vision, 11556 chars) —
// CLAUDE.md's ~$10/run regression. The cause: resolveRecipeFieldValues (the replay map) spreads every
// parser-snapshot scalar under 400 chars, so the parser's narrative summaries (electricalCalcText,
// sitePlanNotesText, projectDescriptionText…) went to the model raw beside the designNotes digest
// that already carries their decision lines — and an addition's summaries are the longest the parser
// writes. This builds the planner payload through the real buildPortalPlanner and the real
// plannerUserMessage, for an existing-system project on a busy equipment page, and holds it to
// the live budget. Synthetic data only.
//   tsx backend/test/plannerBudget.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-budget-test-"));
  process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");
  process.env.AUTOPILOT_TEST_SEAMS = "1";
  const { openDatabase } = await import("../src/db");
  const { normalizeProject } = await import("../src/normalize");
  const { importSeededUtilityKnowledge } = await import("../src/knowledgeBase");
  const { createClient } = await import("../src/clients");
  const { buildPortalPlanner, plannerFieldView, setAutoLearnSeamsForTests } = await import("../src/autoLearn");
  const { plannerUserMessage, PLANNER_USER_TOKEN_BUDGET } = await import("../src/llm");
  const db = await openDatabase();

  let failures = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
    else console.log(`ok   - ${name}`);
  };

  // Tokens per character of THIS payload shape, from the live measurement the issue reports
  // (count_tokens on the real user half: 5301 tokens for 11556 chars). JSON of short keys and
  // numbers is token-dense; a generic 4-chars-per-token guess would let the regression through.
  const CHARS_PER_TOKEN = 11556 / 5301;
  const estimateTokens = (s: string) => Math.ceil(s.length / CHARS_PER_TOKEN);

  // A utility KB row the size a real imported one is (its notes are capped at 900 in the context).
  importSeededUtilityKnowledge(db, {
    state: "WA", utility: "Example Sound Energy",
    portalName: "PowerClerk", portalUrl: "https://example-nm.powerclerk.example/MvcAccount/Login",
    notes: [
      "Submit interconnection via PowerClerk; one application per service address.",
      "Visible-blade lockable AC disconnect required within 10 ft of the meter.",
      "Additions to an existing net-metered system must disclose the existing system size and equipment and the combined total.",
      "Production meter not required for residential net metering under 25 kW.",
      "Single-line diagram and site plan are required uploads; inverter spec sheet for every new inverter model.",
      "Smart inverter settings per the utility's interconnection standard (UL 1741 SB).",
      "Export limiting requires a PCS description and a certified PCS listing.",
      "Customer signature collected through the portal's e-sign after submittal.",
    ].join(" | "),
  });

  // The installer the work is for — its overlay (company, contact, licence) rides in the project map.
  const client = createClient(db, {
    companyName: "Example Solar Installers LLC", legalBusinessName: "Example Solar Installers LLC",
    contactName: "Riley Installer", businessEmail: "ops@example-installers.test", businessPhone: "(206) 555-0100",
    businessAddress: "9 Industry Way, Testville, WA 98000", electricalLicenseNumber: "EXAMPLI123AB",
    stateLicenses: [{ state: "WA", kind: "electrical_contractor", number: "EXAMPLI123AB" }],
  });

  // Synthetic secrets — the planner must never see any of them (rule 2).
  const ACCOUNT = "220011223344";
  const METER = "Z99887766";
  const AGREEMENT = "NEM-AGR-55443322";
  const APPLICATION = "APP-77665544";

  // A system addition, as the parser writes one: the narrative summaries run to the ~400-char cap
  // because its prompt asks it to describe existing + new + combined.
  const payload: Record<string, unknown> = {
    clientId: client.id, homeownerEmail: "pat.example@example.test", homeownerPhone: "2065550123",
    owner: "Pat Example", street: "100 Test Ave", city: "Testville", state: "WA", zip: "98000",
    ahj: "City of Testville", utility: "Example Sound Energy", account: ACCOUNT, meter: METER,
    dcKw: 5.28, acKw: 3.84, interco: "Load-side breaker", exportKw: 3.84,
    moduleMake: "Example Solar", moduleModel: "EX-400-BLK-G10", moduleWattage: 400, moduleQty: 12,
    pvMicroMake: "ExampleMicro", pvMicroModel: "EM8PLUS-72-2-US", pvMicroQty: 12, pvMicroOutputW: 1.21,
    existingSystem: "yes", existingDcKw: 5.16, existingAcKw: 4.2,
    existingModuleMake: "Legacy Solar", existingModuleModel: "LS 430 QD", existingModuleQty: 12,
    existingInvMake: "ExampleMicro", existingInvModel: "EM7PLUS-72-2-US", existingInvQty: 12,
    combinedDcKw: 10.44, combinedAcKw: 8.04,
    existingNemAgreementNumber: AGREEMENT, existingNemApplicationNumber: APPLICATION, nemTariff: "NEM2",
    busRating: "200A", mainBreaker: "200A", pvBreaker: "20A", acDiscReq: "yes", acDiscQty: 1,
    acDiscAmps: "60A", acDiscFused: "non-fusible", acDiscVoltage: "240V",
    roofMaterial: "Composition Shingle", mounting: "Roof Mount", snow: 25, deadLoad: 2.9,
    roofRafterSpacing: 24, wind: "B", windSpeed: 110, inverterSettings: "UL 1741 SB",
    azimuth: 180, tilt: 22, serviceVoltage: "240V", servicePhase: "single-phase",
    electricalCalcText:
      "SLD PV-4: 12 new EM8PLUS microinverters on one 20A branch circuit to a new combiner, then a 60A non-fusible AC disconnect and a 20A backfed breaker in the 200A MSP. Existing system: 12 EM7PLUS micros on its own 20A backfed breaker, retained. 705.12 120% rule: 200A bus, 200A main, 20A + 20A PV = 40A <= 40A allowed. Rapid shutdown per 690.12 via MLPE. Grounding per 690.47.",
    structuralCalcText:
      "Roof framing 2x6 rafters at 24 in OC, span 12 ft, Douglas fir #2. Ground snow 25 psf, PV dead load 2.9 psf, ultimate wind 110 mph exposure B, risk category II. Attachments at 48 in max spacing, 24 in within 3 ft of edges, lag screws into rafters with flashed mounts. Existing array attachments unchanged. No PE stamp shown on the plan set; framing adequacy stated by the designer, not sealed.",
    sitePlanNotesText:
      `Site plan PV-2: existing array (12 modules) on the south roof plane retained; new array (12 modules) on the west roof plane. Utility meter #${METER} on the east wall; new AC disconnect within 10 ft of the utility meter on the same wall. Main service panel inside garage. 3 ft fire pathways maintained on both arrays; no ground-mounted equipment and no trenching.`,
    roofPlanNotesText:
      "Two roof planes: south plane tilt 22 azimuth 180 (existing array), west plane tilt 22 azimuth 270 (new array). 36 in access pathways from eave to ridge on each plane, 18 in ridge setback each side. Module layout per plane on PV-3. Combined array coverage under 33% of the roof area.",
    labelsText:
      "PV label schedule per 690.12 and 705.10: rapid shutdown placard at service, AC disconnect label, backfed breaker warning at MSP, directory placard showing both the existing and the new PV system locations and their disconnects. Existing system labels retained and updated for the addition. Labels reflective, weather-resistant, permanently affixed.",
    projectDescriptionText:
      "System addition: install 5.28 kW DC / 3.84 kW AC of new roof-mounted PV (12 Example Solar EX-400 modules, 12 EM8PLUS microinverters) alongside an existing 5.16 kW DC / 4.2 kW AC system (12 Legacy Solar modules, 12 EM7PLUS micros) that remains in service. Combined system 10.44 kW DC / 8.04 kW AC. Load-side breaker interconnection in the 200A MSP.",
    locateCalloutText: "No excavation — roof mount only",
    notes: "Existing system equipment read from the site plan callouts only; verify the existing microinverter model against the existing interconnection agreement before submittal. Combined AC size computed as new + existing.",
    packetReadinessText: "Plan set present; utility bill present; meter photo present; existing interconnection agreement MISSING from the packet.",
  };
  const project = normalizeProject("p-303", payload as never);
  check("fixture: the project carries the existing-system block", project.existingSystem?.hasExistingSystem === true);
  const narrativeKeys = ["electricalCalcText", "structuralCalcText", "sitePlanNotesText", "roofPlanNotesText", "labelsText", "projectDescriptionText", "notes", "packetReadinessText"];
  // Under the resolver's 400-char scalar cap — the size that rides into the replay map (and, before
  // #303, into every planner call).
  check("fixture: every narrative is under the resolver's 400-char cap", narrativeKeys.every((k) => String(payload[k]).length <= 400),
    narrativeKeys.map((k) => `${k}=${String(payload[k]).length}`).join(" "));

  let sent: Record<string, any> | null = null;
  setAutoLearnSeamsForTests({
    llm: () => ({
      planPortalFields: async (input: Record<string, any>) => {
        sent = input;
        return { fills: [], navigateIndex: null, advanceIndex: null, finalSubmitIndex: null, atReview: false, confidence: "low", notes: "" };
      },
    }) as never,
  });
  const { planner, projectFields } = buildPortalPlanner(db, project, { portalType: "utility", scopeType: "utility" });

  // THE PAGE THE LIVE COUNT WAS TAKEN ON. countPlannerPrompt measures once per process — the run's
  // FIRST planner call, which on a PowerClerk NEM stage is the application's first form page: nav
  // chrome, one contact block, Save/Next. Sized so that with main's payload (the whole replay map)
  // this reproduces the live incident (~11.5k chars, over budget); the project half is what #303
  // shrinks.
  const fields: Array<{ label: string; fieldType: string; section?: string; options?: string[] }> = [];
  for (const label of ["Home", "Projects", "Tools", "Support", "My Account", "Log Out", "Privacy", "Terms of Use", "Previous page", "Next page", "help"]) {
    fields.push({ label, fieldType: "button" });
  }
  for (const label of ["First Name", "Last Name", "Company", "Street Address", "City", "State", "Zip", "Email", "Phone", "Account Number", "Meter Number", "Existing generation on site?"]) {
    fields.push({ label, fieldType: label.endsWith("?") || label === "State" ? "select" : "text", section: "Customer Information" });
  }
  for (const label of ["Save", "Previous", "Next"]) fields.push({ label, fieldType: "button" });

  const bodyText = ("Customer Information. Enter the customer of record exactly as it appears on the utility bill, the service address of the "
    + "generating facility, and whether generation already exists on site. Required fields are marked with an asterisk. ").repeat(5);
  await planner({
    url: "https://example-nm.powerclerk.example/MvcProjects/EditProject",
    pageTitle: "Edit Project",
    fields: fields as never,
    bodyText,
    alreadyFilledLabels: ["Customer First Name", "Customer Last Name", "Service Address", "Installer Company"],
  } as never);

  if (!sent) {
    check("the planner was called", false);
    process.exit(1);
  }
  const input = sent as Record<string, any>;
  const user = plannerUserMessage(input as never);
  const tokens = estimateTokens(user);
  // What main sent: the same page with the whole replay map as projectFields.
  const before = plannerUserMessage({ ...input, projectFields } as never);
  console.log(`     user half: ${user.length} chars ≈ ${tokens} tokens (budget ${PLANNER_USER_TOKEN_BUDGET}); with the whole map (main): ${before.length} chars ≈ ${estimateTokens(before)} tokens`);
  check("fixture: with the whole replay map the payload reproduces the live incident (over budget)", estimateTokens(before) > PLANNER_USER_TOKEN_BUDGET,
    `${estimateTokens(before)} tokens`);
  check("the planner's user half is inside the live budget", tokens <= PLANNER_USER_TOKEN_BUDGET, `${tokens} > ${PLANNER_USER_TOKEN_BUDGET}`);
  check("the kbContext is in the measured payload (a realistic page, not an empty one)", typeof input.kbContext === "string" && input.kbContext.length > 300);

  // No long parser blob reaches the model: no planner value but the digest is longer than a fill
  // value ever is (a redacted copy of a narrative counts too, so this is by length, not equality).
  const sentFields = input.projectFields as Record<string, string>;
  const blobs = Object.entries(sentFields).filter(([k, v]) => k !== "designNotes" && v.length > 200).map(([k]) => k);
  check("no raw parser narrative reaches the planner", blobs.length === 0, blobs.join(", "));
  for (const k of narrativeKeys) {
    check(`planner view leaves out ${k}`, !(k in sentFields));
  }

  // …and the signal survives: the digest carries the decision lines, short answers stay.
  check("designNotes carries the disconnect-to-meter line", /within 10 ft/i.test(sentFields.designNotes ?? ""), sentFields.designNotes);
  check("designNotes carries the existing-system line", /existing (array|system)/i.test(sentFields.designNotes ?? ""), sentFields.designNotes);
  check("a short parser answer still reaches the planner (locateCalloutText)", sentFields.locateCalloutText === "No excavation — roof mount only");
  check("the description-of-work fill value still reaches the planner", Boolean(sentFields.workDescription));

  // The existing-system keys the prompt names reach the planner once, not twice.
  for (const [k, v] of [["hasExistingSystem", "Yes"], ["existingSystemSizeDcKw", "5.16"], ["existingSystemSizeAcKw", "4.2"], ["totalSystemSizeDcKw", "10.44"],
    ["totalSystemSizeAcKw", "8.04"], ["existingInverterMake", "ExampleMicro"], ["existingInverterModel", "EM7PLUS-72-2-US"], ["existingInverterQty", "12"],
    ["existingModuleModel", "LS 430 QD"], ["existingModuleQty", "12"], ["nemTariff", "NEM2"]] as const) {
    check(`planner sees ${k}`, sentFields[k] === v, String(sentFields[k]));
  }
  for (const k of ["existingSystem", "existingDcKw", "existingAcKw", "combinedDcKw", "combinedAcKw", "existingInvMake", "existingInvModel", "existingInvQty"]) {
    check(`planner does not see the duplicate ${k}`, !(k in sentFields));
  }
  // …and so does every other raw parser key that only repeats its canonical key.
  for (const [raw, canonical] of [["owner", "homeownerName"], ["dcKw", "systemSizeDcKw"], ["interco", "interconnectionMethod"],
    ["pvMicroModel", "inverterModel"], ["pvMicroQty", "inverterQty"], ["moduleManufacturer", "moduleMake"], ["acDiscAmps", "disconnectAmps"]] as const) {
    check(`planner sees ${canonical}, not its echo ${raw}`, Boolean(sentFields[canonical]) && !(raw in sentFields), `${canonical}=${sentFields[canonical]} ${raw}=${sentFields[raw]}`);
  }
  // A raw key whose canonical twin is missing (or says something else) is the only copy: kept.
  const view = plannerFieldView({ combinedDcKw: "10.44", existingDcKw: "5.16", existingSystemSizeDcKw: "5.2" });
  check("a raw existing-system key with no canonical twin is kept", view.combinedDcKw === "10.44");
  check("a raw existing-system key that disagrees with its canonical twin is kept", view.existingDcKw === "5.16");

  // The learn's own fill/binding map is unchanged — only what the model is sent is compact.
  check("the returned projectFields still carries the narrative (binding map unchanged)", projectFields.projectDescriptionText === payload.projectDescriptionText);
  check("the returned projectFields still carries the raw aliases", projectFields.combinedDcKw === "10.44");

  // RULE 2: nothing account-linked reaches the model, embedded in prose or otherwise.
  const digitsOf = (s: string) => s.replace(/\D/g, "");
  const userDigits = digitsOf(user);
  for (const [name, secret] of [["account number", ACCOUNT], ["meter number", METER], ["existing NEM agreement number", AGREEMENT], ["existing NEM application number", APPLICATION]] as const) {
    check(`the ${name} never reaches the planner`, !user.includes(secret) && !userDigits.includes(digitsOf(secret)));
  }
  check("the planner view has no existingNem* key", !Object.keys(sentFields).some((k) => /^existingNem(Agreement|Application)Number$/.test(k)));

  if (failures) {
    console.error(`\nplannerBudget: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nplannerBudget: all checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
