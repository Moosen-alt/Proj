// THE AC DISCONNECT'S MAKE AND MODEL COME FROM THE PLAN SET (#384).
//
// Live, 2026-10-21 (PacifiCorp PowerClerk NEM): the SLD and equipment schedule named an Eaton
// DG-series switch, the parse kept only acDiscReq = "yes", and the operator typed "Disconnect Switch
// Manufacturer" / "Model" by hand. Two breaks: nothing read the part off the text, and the parser
// page never saved acDiscMakeModel (or the amps / fusing) into the snapshot even when the model read it.
//
//   MUST-PASS    a schedule row and an SLD callout naming an Eaton DG222-type switch fill
//                acDiscMakeModel (+ amps, fusing), cited by page; that part reaches the filing as
//                disconnectMake / disconnectModel and #353's unrecorded-control pass binds it; a
//                different part the model read is kept as a structured conflict.
//   MUST-EXCLUDE a DC / battery / rapid-shutdown disconnect's part, or the combiner's part written
//                just before the label, is never the AC disconnect's; two different AC parts fill
//                nothing; a set naming no part leaves the key empty, so the filing stays blank and
//                #353 stops by name; the distance-to-meter answer is never read off the document.
//
// Synthetic text only: no real homeowner, address, account or meter number.
//
//   npx tsx backend/test/acDisconnectIntake.test.ts
import "./_isolate";
import { REPO } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-disconnect-intake-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.AUTOPILOT_TEST_SEAMS = "1";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "AHJ_FORM_RESEARCH", "FEE_RESEARCH", "PORTAL_URL_RESEARCH", "RUN_TRIAGE", "UTILITY_FILING_LOOKUP"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const { readAcDisconnect, supplementAcDisconnect } = await import("../src/acDisconnectIntake");
const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const { createClient, updateClient } = await import("../src/clients");
const PR = await import("../src/portalRecipes");
const { answerForUnrecordedControl } = await import("../../portal-bot/src/unrecordedControls");

let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`ok   - ${name}`); }
  catch (err) { failed++; console.log(`FAIL - ${name}: ${err instanceof Error ? err.message : String(err)}`); }
};
const stub = (fields: Record<string, unknown> = {}) => ({ provider: "stub", fields, lowConfidenceFields: [], notes: "" }) as never;
type Out = { fields: Record<string, { value: unknown; evidence?: { sheet?: string; excerpt?: string } } | undefined>; conflicts?: Array<{ field: string; readings: Array<{ value: unknown }> }> };
const supplement = (text: string, fields: Record<string, unknown> = {}) => supplementAcDisconnect(stub(fields), text) as unknown as Out;
const val = (o: Out, k: string) => o.fields[k]?.value;

// A schedule whose combiner row (an Eaton load centre) sits right before the AC disconnect row.
const SCHEDULE = [
  "--- PAGE 3 ---",
  "PV-3 EQUIPMENT SCHEDULE EQUIPMENT QTY MANUFACTURER MODEL DESCRIPTION",
  "PV MODULE 20 EXAMPLE SOLAR XS-400 400W MONO",
  "COMBINER PANEL 1 EATON BR816L125RP 125A LOAD CENTER",
  "AC DISCONNECT 1 EATON DG222URB 60A, 240V, NON-FUSIBLE, NEMA 3R",
  "JUNCTION BOX 2 EXAMPLE BOX CO JB-1 NEMA 3R",
].join("\n");
// The SLD callout: the part written before the label.
const SLD = [
  "--- PAGE 4 ---",
  "PV-4 SINGLE LINE DIAGRAM (E) 200A MAIN SERVICE PANEL WITH 200A MAIN BREAKER (N) 40A/2P PV BREAKER",
  "(N) EATON DG222URB 60A NON-FUSIBLE AC DISCONNECT, VISIBLE, LOCKABLE, LABELED",
  "(E) UTILITY METER",
].join("\n");

await check("MUST-PASS: an equipment-schedule row fills the AC disconnect's make + model, amps and fusing, cited by page", () => {
  const out = supplement(SCHEDULE);
  assert.equal(val(out, "acDiscMakeModel"), "Eaton DG222URB");
  assert.equal(val(out, "acDiscAmps"), "60A");
  assert.equal(val(out, "acDiscFused"), "non-fusible");
  assert.match(String(out.fields.acDiscMakeModel?.evidence?.sheet), /Page 3/);
  assert.match(String(out.fields.acDiscMakeModel?.evidence?.excerpt), /AC DISCONNECT 1 EATON DG222URB/);
});

await check("MUST-PASS: an SLD callout (part before the label) fills the same part; schedule + SLD agreeing is one part", () => {
  const sld = supplement(SLD);
  assert.equal(val(sld, "acDiscMakeModel"), "Eaton DG222URB");
  assert.equal(val(sld, "acDiscAmps"), "60A");
  assert.equal(val(sld, "acDiscFused"), "non-fusible");
  const both = supplement(`${SCHEDULE}\n${SLD}`);
  assert.equal(val(both, "acDiscMakeModel"), "Eaton DG222URB");
  assert.ok(!both.conflicts?.length, "the same part on two sheets is no conflict");
  // A "MODEL:" lead and a fused switch read the same way.
  const labelled = supplement("--- PAGE 2 ---\nAC DISCONNECT: SQUARE D MODEL: D222NRB 60A FUSED W/ 40A FUSES");
  assert.equal(val(labelled, "acDiscMakeModel"), "Square D D222NRB");
  assert.equal(val(labelled, "acDiscAmps"), "60A");
  assert.equal(val(labelled, "acDiscFused"), "fusible");
});

await check("MUST-EXCLUDE: an AC + DC pair binds only the AC part, whichever comes first", () => {
  const acFirst = supplement("--- PAGE 4 ---\nAC DISCONNECT: EATON DG222URB 60A NON-FUSIBLE DC DISCONNECT: SQUARE D DU221RB 30A");
  assert.equal(val(acFirst, "acDiscMakeModel"), "Eaton DG222URB");
  const dcFirst = supplement("--- PAGE 4 ---\nDC DISCONNECT: SQUARE D DU221RB 30A AC DISCONNECT: EATON DG222URB 60A");
  assert.equal(val(dcFirst, "acDiscMakeModel"), "Eaton DG222URB");
  assert.equal(val(dcFirst, "acDiscAmps"), "60A", "the DC switch's 30A is not the AC disconnect's");
  const noAcRating = supplement("--- PAGE 4 ---\nDC DISCONNECT: SQUARE D DU221RB 30A AC DISCONNECT: EATON DG222URB");
  assert.equal(val(noAcRating, "acDiscMakeModel"), "Eaton DG222URB");
  assert.equal(val(noAcRating, "acDiscAmps"), undefined, "the DC switch's 30A, written right before the AC label, is not read as the AC rating");
  const dcSld = supplement("--- PAGE 4 ---\n(N) SQUARE D DU221RB 30A DC DISCONNECT (N) 60A NON-FUSIBLE AC DISCONNECT EATON DG222URB");
  assert.equal(val(dcSld, "acDiscMakeModel"), "Eaton DG222URB");
});

await check("MUST-EXCLUDE: a DC, rapid-shutdown or battery disconnect's part alone fills nothing", () => {
  for (const text of [
    "--- PAGE 4 ---\nDC DISCONNECT: EATON DG221URB 30A NON-FUSIBLE",
    "--- PAGE 4 ---\nDC/AC DISCONNECT EATON DG221URB",
    "--- PAGE 4 ---\nRAPID SHUTDOWN INITIATOR SWITCH EATON DG221URB",
    "--- PAGE 4 ---\nBATTERY AC DISCONNECT SIEMENS GNF322R 60A",
    "--- PAGE 4 ---\nGENERATOR AC DISCONNECT SQUARE D DU222RB",
  ]) {
    const out = supplement(text);
    assert.equal(val(out, "acDiscMakeModel"), undefined, text);
  }
  // The battery's AC disconnect beside the system's: only the system's binds.
  const pair = supplement("--- PAGE 4 ---\nBATTERY AC DISCONNECT SIEMENS GNF322R 60A. AC DISCONNECT EATON DG222URB 30A");
  assert.equal(val(pair, "acDiscMakeModel"), "Eaton DG222URB");
  assert.equal(val(pair, "acDiscAmps"), "30A");
});

await check("MUST-EXCLUDE: the combiner's part written just before the AC disconnect label is the combiner's", () => {
  const out = supplement("--- PAGE 3 ---\nCOMBINER PANEL EATON BR816L125RP AC DISCONNECT 60A NON-FUSIBLE 240V");
  assert.equal(val(out, "acDiscMakeModel"), undefined);
  assert.equal(val(out, "acDiscAmps"), "60A", "the rating still reads");
  // The prompt's own trap wording (llm.ts): the Eaton part is the COMBINER.
  const trap = supplement("COMBINER PANEL 1 EATON BR STYLE 1-INCH LOAD CENTER 816L125RP AC DISCONNECT 1 60A NON-FUSIBLE");
  assert.equal(val(trap, "acDiscMakeModel"), undefined);
});

await check("MUST-EXCLUDE: two different AC parts fill nothing and go to review; a make or a part number alone names no part", () => {
  const two = supplement("--- PAGE 3 ---\nAC DISCONNECT 1 EATON DG222URB 60A\n--- PAGE 4 ---\n(N) SQUARE D DU222RB AC DISCONNECT");
  assert.equal(val(two, "acDiscMakeModel"), undefined);
  assert.equal(two.conflicts?.find((c) => c.field === "acDiscMakeModel")?.readings.length, 2);
  assert.equal(val(supplement("AC DISCONNECT EATON 60A NON-FUSIBLE"), "acDiscMakeModel"), undefined, "a make with no part number");
  assert.equal(val(supplement("AC DISCONNECT DG222URB 60A"), "acDiscMakeModel"), undefined, "a part number with no make");
  assert.equal(val(supplement("AC DISCONNECT ACME WIDGETS AW2000 60A"), "acDiscMakeModel"), undefined, "an unlisted maker is never guessed");
});

await check("MUST-PASS: a different part the model read is kept as a conflict; an agreeing one is not; the model's amps stand", () => {
  const differ = supplement(SCHEDULE, { acDiscMakeModel: { value: "Eaton BR816L125RP", confidence: 0.6, evidence: { source: "plan_set", sheet: "PV-3", excerpt: "EATON BR816L125RP" } } });
  assert.equal(val(differ, "acDiscMakeModel"), "Eaton DG222URB");
  const c = differ.conflicts?.find((x) => x.field === "acDiscMakeModel");
  assert.deepEqual(c?.readings.map((r) => r.value), ["Eaton DG222URB", "Eaton BR816L125RP"]);
  const agree = supplement(SCHEDULE, { acDiscMakeModel: { value: "EATON DG222URB", confidence: 0.8 }, acDiscAmps: { value: "60 A", confidence: 0.8 } });
  assert.ok(!agree.conflicts?.length);
  assert.equal(val(agree, "acDiscAmps"), "60 A", "a value the model read is not overwritten");
});

await check("MUST-EXCLUDE: a set that names no part leaves the key empty; nothing reads the distance-to-meter answer", () => {
  const none = supplement("--- PAGE 4 ---\n(N) 60A NON-FUSIBLE AC DISCONNECT, 240V, VISIBLE, LOCKABLE, LABELED, WITHIN 10 FT OF THE UTILITY METER");
  assert.equal(val(none, "acDiscMakeModel"), undefined);
  assert.equal(val(none, "acDiscAmps"), "60A");
  assert.equal(val(none, "disconnectWithin10ft"), undefined);
  assert.deepEqual(readAcDisconnect("").parts, []);
});

// END TO END: the extraction's fields, saved as the parser page saves them, reach the filing.
const db = await openDatabase();
const client = createClient(db, {
  companyName: "Alpha Solar Test Co", legalBusinessName: "Alpha Solar Test Co LLC", contactName: "Avery Alpha",
  businessAddress: "808 SE Test Dr", businessCity: "Vancouver", businessState: "WA", businessZip: "98683",
  businessPhone: "5035550100", businessEmail: "ops@alpha.example",
});
const fill = (extra: Record<string, unknown>) => {
  const p = R.getProjectDetail(db, R.createProject(db, {
    clientId: client.id, owner: "Pat Example", street: "10 Bay St", city: "Coos Bay", state: "OR", zip: "97420",
    ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "16.1", acKw: "16", acDiscReq: "yes", ...extra,
  } as never).project.id).project;
  return PR.resolveRecipeFieldValues(db, p, "utility", null) as Record<string, string>;
};
const snapshotOf = (o: Out) => Object.fromEntries(Object.entries(o.fields).map(([k, f]) => [k, f?.value]));
const MAKE = { label: "Disconnect Switch Manufacturer", fieldType: "text" };
const MODEL = { label: "Disconnect Switch Model", fieldType: "text" };

await check("MUST-PASS: the plan set's Eaton DG222URB reaches the filing and #353's pass binds it (over the client's standard part)", () => {
  updateClient(db, client.id, { standardDisconnectMake: "Eaton", standardDisconnectModel: "DG221URB" });
  const f = fill(snapshotOf(supplement(`${SCHEDULE}\n${SLD}`)));
  assert.deepEqual([f.disconnectMake, f.disconnectModel, f.disconnectMakeModel], ["Eaton", "DG222URB", "Eaton DG222URB"]);
  assert.deepEqual(answerForUnrecordedControl(MAKE, f, "nem"), { kind: "bound", key: "disconnectMake", value: "Eaton" });
  assert.deepEqual(answerForUnrecordedControl(MODEL, f, "nem"), { kind: "bound", key: "disconnectModel", value: "DG222URB" });
});

await check("MUST-EXCLUDE: no part on the set and no standard part -> the keys stay empty and #353 stops by name", () => {
  updateClient(db, client.id, { standardDisconnectMake: "", standardDisconnectModel: "" });
  const f = fill(snapshotOf(supplement("--- PAGE 4 ---\n(N) 60A NON-FUSIBLE AC DISCONNECT, 240V DC DISCONNECT: EATON DG221URB")));
  assert.deepEqual([f.disconnectMake, f.disconnectModel, f.disconnectMakeModel], ["", "", ""]);
  assert.deepEqual(answerForUnrecordedControl(MAKE, f, "nem"), { kind: "bound", key: "disconnectMake", value: "" });
});

await check("WIRING: /api/parser/llm-extract runs the AC disconnect read on the text response", () => {
  const server = fs.readFileSync(path.join(REPO, "backend", "src", "server.ts"), "utf8");
  const route = server.slice(server.indexOf('app.post("/api/parser/llm-extract"'));
  const body = route.slice(0, route.indexOf("\n}));"));
  assert.match(body, /supplementAcDisconnect\(extraction, planText\)/);
});

await check("PARSER PAGE: the AC disconnect's part and rating are saved into the snapshot; the distance answer is not", () => {
  const html = fs.readFileSync(process.env.PARSER_HTML_PATH || path.join(REPO, "frontend", "parser.html"), "utf8");
  const keys = /const LLM_SNAPSHOT_KEYS = new Set\(\[([\s\S]*?)\]\);/.exec(html)?.[1] ?? "";
  for (const k of ["acDiscMakeModel", "acDiscAmps", "acDiscFused"]) assert.ok(keys.includes(`'${k}'`), `${k} is an LLM snapshot key`);
  assert.ok(!keys.includes("'disconnectWithin10ft'"), "a person's answer is never a snapshot key");
});

db.close();
if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
