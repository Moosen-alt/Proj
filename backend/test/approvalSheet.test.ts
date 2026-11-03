// THE APPROVAL SHEET (#486): APPROVE & AUTO-SUBMIT SHOWS WHAT IS ABOUT TO BE FILED.
//
// The approve prompt was a fixed paragraph (APPROVE_AUTO_SUBMIT_LEDE) that showed none of the values
// about to be filed. GET /api/projects/:id/approval-sheet?track=… now serves the replay's own values
// for that filing, each with its source, every disagreement with the bill or the plan set first.
// Pinned here (synthetic data only):
//   (V) THE REPLAY'S VALUES: the sheet's rows are read from stagingFieldValues — the dictionary the
//       stage gate and the replay are handed — never a second resolution.
//   (C) A CLEAN PROJECT: the bill's account, meter and service address and the plan set's own module
//       and inverter schedule all agree → no mismatch, no missing value; the checks say "match".
//   (M) ONE PROJECT WITH MISMATCHES: a bill address on another street, a bill account number that
//       differs, an AC size the inverters do not add up to → each is named in words and listed FIRST.
//   (S) RULE 2: the account and meter (the project's AND the bill's readings) appear only as the last
//       4; the whole number never appears anywhere in the response, even when a parsed address line
//       carries it.
//   (P) PROVENANCE: a review-queue verification reads "set by a person", the bill-image read reads
//       "utility bill", and a later edit whose fields are not recorded drops back to "project record".
//   (T) A PERMIT TRACK shows the issuing agency and no account / meter rows.
//   (G) RULE 1: the gate (automaticSubmitRefusals) answers the same before and after the sheet is read,
//       and the sheet module calls no gate function, no stage route, no recipe writer and no SQL write.
//   (W) A READ: building the sheet writes nothing (total_changes()).
//   (D) THE DASHBOARD: the sheet's HTML lists the red items before the table and escapes every value;
//       with no sheet (an older server) the plain confirm is still shown, and says so.
//   (R) THE ROUTE on a real server with sign-in on: 200 with masked ids for this org's project; another
//       org's project → 404 (never 403); a bad track → 400; signed out → 401.
// What this does NOT change (rule 1): the approve request (POST prepare-submission) and the gate
// (mayClickFinalSubmit / automaticSubmitRefusals) — approveAutoSubmitName.test and
// approveRailOneDoor.test still pin the request body the click posts, unchanged.
//
// KILL TESTS (each run): drop the address cross-check → (M1) fails; read the raw bill holder instead
// of values.ubAccountHolder → (V) fails; make the final scrub a no-op → (S3) fails; return the raw
// accountNumber AND drop the scrub → (C)(S1)(R2) fail (either alone is caught by the other: the
// scrub is the second leg on purpose); drop the issue sort → (M2)(R2) fail.
//
// Run: npx tsx backend/test/approvalSheet.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { REPO } from "./_isolate";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("approval-sheet");
const { db, repo } = fx;
const { buildApprovalSheet, maskLast4 } = await import("../src/approvalSheet");
const { stagingFieldValues } = await import("../src/recipeStageGapsView");
const { addAuditLog } = await import("../src/audit");
const { DEFAULT_ORG_ID } = await import("../src/db");

const ACCOUNT = "1234567890";
const METER = "987654321";
const sheetFor = (projectId: string, track: "nem" | "building" = "nem") => buildApprovalSheet(db, repo.getProjectDetail(db, projectId).project, track);
const rowOf = (sheet: ReturnType<typeof sheetFor>, key: string) => {
  const r = sheet.rows.find((x) => x.key === key);
  assert.ok(r, `no ${key} row: ${JSON.stringify(sheet.rows.map((x) => x.key))}`);
  return r!;
};
const red = (sheet: ReturnType<typeof sheetFor>) => sheet.issues.filter((i) => i.kind !== "note");

// The fixture's plan set: 20 × 430 W = 8.6 kW DC, 20 × 325 W = 6.5 kW AC. Its street is "<100+n> Solar Way".
const clean = fx.newProject({ ubAccountHolder: "", ubAccountNumber: ACCOUNT, ubMeterNumber: METER } as never);
const cleanStreet = repo.getProjectDetail(db, clean).project.projectAddress;
repo.updateProject(db, clean, { ubServiceAddress: `${cleanStreet.split(",")[0]}, Portland, OR 97201` });
const mixed = fx.newProject({ acKw: "7.6" } as never);
repo.updateProject(db, mixed, { ubServiceAddress: "77 Elsewhere Rd, Portland, OR 97201", ubAccountNumber: "1234567899", ubMeterNumber: METER, ubAccountHolder: "Casey Different" });

await check("(V) the rows carry the replay's own values (stagingFieldValues), never a second resolution", () => {
  const project = repo.getProjectDetail(db, mixed).project;
  const { values } = stagingFieldValues(db, project, "nem");
  const sheet = sheetFor(mixed);
  assert.equal(rowOf(sheet, "applicant").value, values.ubAccountHolder);
  assert.equal(rowOf(sheet, "applicant").value, "Casey Different", "the NEM files under the bill's account holder");
  assert.equal(rowOf(sheet, "homeowner").value, values.homeownerName);
  assert.equal(rowOf(sheet, "utility").value, values.utility);
  assert.equal(rowOf(sheet, "dcKw").value, `${Number(values.systemSizeDcKw)} kW`);
  assert.equal(rowOf(sheet, "client").value, values.installerCompanyName);
  assert.ok(rowOf(sheet, "client").value, "the submitting company comes from the client overlay");
  assert.ok(rowOf(sheet, "address").value.startsWith(values.projectAddress), rowOf(sheet, "address").value);
});

await check("(C) a clean project: bill and plan set agree, so nothing is red and the checks read match", () => {
  const sheet = sheetFor(clean);
  assert.deepEqual(red(sheet), [], JSON.stringify(sheet.issues));
  for (const k of ["address", "account", "meter", "dcKw", "acKw"]) assert.equal(rowOf(sheet, k).check, "match", `${k}: ${JSON.stringify(rowOf(sheet, k))}`);
  assert.equal(rowOf(sheet, "account").value, "•••• 7890");
  assert.equal(rowOf(sheet, "meter").value, "•••• 4321");
  assert.equal(rowOf(sheet, "account").source, "bill", "an account matching the bill's reading is sourced to the bill");
  assert.equal(rowOf(sheet, "dcKw").source, "plan_set");
  assert.equal(rowOf(sheet, "battery").value, "None — filed as solar PV only");
});

await check("(M1) mismatches are named in words: bill address, bill account, inverter AC sum", () => {
  const sheet = sheetFor(mixed);
  const byRow = Object.fromEntries(red(sheet).map((i) => [i.rowKey, i]));
  assert.equal(byRow.address?.kind, "mismatch", JSON.stringify(sheet.issues));
  assert.match(byRow.address.text, /Service address: the utility bill's service address reads "77 Elsewhere Rd/);
  assert.equal(byRow.account?.kind, "mismatch");
  assert.match(byRow.account.text, /the utility bill reads •••• 7899, the filing would carry •••• 7890/);
  assert.equal(byRow.acKw?.kind, "mismatch");
  assert.match(byRow.acKw.text, /inverters add up to 6\.5 kW \(20 × 325 W\), not 7\.6 kW/);
  assert.equal(byRow.meter, undefined, "the meter agrees with the bill: no mismatch");
  assert.equal(rowOf(sheet, "dcKw").check, "match", "the DC size still matches the modules");
});

await check("(M2) the mismatches are listed first, and a different account holder is a note, not a mismatch", () => {
  const sheet = sheetFor(mixed);
  const kinds = sheet.issues.map((i) => i.kind);
  const firstNonMismatch = kinds.findIndex((k) => k !== "mismatch");
  assert.ok(firstNonMismatch >= 3, JSON.stringify(kinds));
  assert.ok(kinds.slice(firstNonMismatch).every((k) => k !== "mismatch"), JSON.stringify(kinds));
  const holder = sheet.issues.find((i) => i.rowKey === "applicant");
  assert.equal(holder?.kind, "note", JSON.stringify(sheet.issues));
  assert.match(holder!.text, /files under the bill's account holder "Casey Different"/);
});

await check("(S1) RULE 2: no whole account or meter number anywhere in the sheet — the project's or the bill's", () => {
  for (const id of [clean, mixed]) {
    const json = JSON.stringify(sheetFor(id));
    for (const secret of [ACCOUNT, METER, "1234567899"]) assert.ok(!json.includes(secret), `the sheet carried ${secret}: ${json}`);
  }
});

await check("(S2) a missing account number is a red 'not on file', and says it is read from the bill", () => {
  const id = fx.newProject({ account: "" } as never);
  const sheet = sheetFor(id);
  const r = rowOf(sheet, "account");
  assert.equal(r.value, "");
  assert.equal(r.check, "missing");
  assert.ok(sheet.issues.some((i) => i.kind === "missing" && i.rowKey === "account" && /read from the customer's utility bill/.test(i.text)), JSON.stringify(sheet.issues));
});

await check("(S3) a parsed line that carries the account number is scrubbed to the last 4", () => {
  const id = fx.newProject();
  repo.updateProject(db, id, { ubServiceAddress: `9 Leak Ln acct ${ACCOUNT.slice(0, 5)}-${ACCOUNT.slice(5)}, Portland, OR 97201` });
  const json = JSON.stringify(sheetFor(id));
  assert.ok(!json.replace(/\D/g, "").includes(ACCOUNT), `the account reached the sheet: ${json}`);
  assert.match(json, /9 Leak Ln acct •••• 7890/);
  assert.equal(maskLast4("12-34"), "on file (too short to mask)", "a 4-character id is never shown: its last 4 is the whole number");
});

await check("(P) provenance: a review-queue verification is a person, the bill-image read is the bill, a later edit is the project record", () => {
  const id = fx.newProject();
  assert.equal(rowOf(sheetFor(id), "account").source, "project", "no recorded writer: the project record");
  addAuditLog(db, id, "system", "bill vision", "project.fields_read_from_document", { fields: ["accountNumber"], fromDocuments: ["utility_bill"] });
  assert.equal(rowOf(sheetFor(id), "account").source, "bill");
  assert.match(rowOf(sheetFor(id), "account").sourceLabel, /read from the bill image/);
  assert.equal(rowOf(sheetFor(id), "meter").source, "project", "the bill read wrote only the account");
  addAuditLog(db, id, "human", "dashboard", "human_review.updated", { reviewItemId: "r1", action: "approve", fieldName: "meterNumber" });
  assert.equal(rowOf(sheetFor(id), "meter").source, "person");
  assert.equal(rowOf(sheetFor(id), "account").source, "bill", "a review of another field says nothing about this one");
  repo.updateProject(db, id, { homeownerEmail: "later@example.test" });
  assert.equal(rowOf(sheetFor(id), "account").source, "project", "MUST-EXCLUDE: a later edit (fields not recorded) still credited to the bill");
  assert.equal(rowOf(sheetFor(id), "meter").source, "project");
});

await check("(T) a permit track shows the issuing agency and no account or meter rows", () => {
  const sheet = sheetFor(clean, "building");
  assert.equal(sheet.category, "permit");
  assert.equal(rowOf(sheet, "ahj").value, "Portland");
  assert.ok(!sheet.rows.some((r) => r.key === "account" || r.key === "meter" || r.key === "applicant"), JSON.stringify(sheet.rows.map((r) => r.key)));
});

await check("(G) RULE 1: reading the sheet leaves the gate's answer as it was, and the sheet module never reaches the gate or a recipe", () => {
  const recipe = fx.completeRecipe();
  const ask = (approver: string | null) => repo.automaticSubmitRefusals(db, {
    recipeId: recipe.id, runId: "run-sheet", runApproval: approver ? { approver, runId: "run-sheet" } : null, env: { PORTAL_ALLOW_FINAL_SUBMIT: "1" },
  });
  const before = [ask(null), ask("Pat Approver")];
  for (const id of [clean, mixed]) sheetFor(id);
  assert.deepEqual([ask(null), ask("Pat Approver")], before, "the gate answered differently after the sheet was read");
  // Source-level: the sheet is a read beside the gate, never a door into it.
  const src = fs.readFileSync(path.join(REPO, "backend", "src", "approvalSheet.ts"), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  for (const forbidden of [/automaticSubmitRefusals|mayClickFinalSubmit|finalSubmitRefusals/, /prepareSubmission|prepare-submission/, /portal_recipes|savePortalRecipe/, /\b(INSERT|UPDATE|DELETE)\b/, /addAuditLog/]) {
    assert.doesNotMatch(src, forbidden, `approvalSheet.ts reaches ${forbidden}`);
  }
});

await check("(W) building the sheet writes nothing", () => {
  const changes = () => db.get<{ n: number }>("SELECT total_changes() AS n")!.n;
  const before = changes();
  for (const id of [clean, mixed]) { sheetFor(id, "nem"); sheetFor(id, "building"); }
  assert.equal(changes(), before, "the approval sheet wrote a row");
});

// ── (D) the dashboard's sheet ─────────────────────────────────────────────────────────────────
const dashboard = fs.readFileSync(path.join(REPO, "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
const lift = (name: string): string => {
  const re = new RegExp(`^(?:async )?function ${name}\\(|^const ${name} = `, "m");
  const m = re.exec(dashboard);
  if (!m) throw new Error(`dashboard.js: could not find ${name}`);
  const isConst = m[0].startsWith("const");
  let i = isConst ? m.index + m[0].length : dashboard.indexOf("{", dashboard.indexOf(")", m.index));
  if (isConst && !"{[(".includes(dashboard[i])) { const semi = dashboard.indexOf(";\n", i); return dashboard.slice(m.index, semi + 1); }
  let depth = 0;
  for (; i < dashboard.length; i++) {
    const ch = dashboard[i];
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") { depth--; if (depth === 0) { i++; break; } }
  }
  return dashboard.slice(m.index, i) + (isConst ? ";" : "");
};
const ui = (stubs: Record<string, unknown>) => new Function(...Object.keys(stubs),
  `${["esc", "humanize", "APPROVE_AUTO_SUBMIT_LEDE", "approvalSheetHtml", "confirmApprovalSheet"].map(lift).join("\n\n")}\nreturn { approvalSheetHtml, confirmApprovalSheet };`,
)(...Object.values(stubs)) as { approvalSheetHtml: (s: unknown, who: string) => string; confirmApprovalSheet: (t: string, who?: string) => Promise<boolean> };

await check("(D1) the sheet's HTML lists the red items before the table, and escapes every value", () => {
  const sheet = sheetFor(mixed);
  sheet.rows.find((r) => r.key === "homeowner")!.value = "<img src=x onerror=alert(1)>";
  const html = ui({ state: {}, api: async () => ({}), confirm: () => true }).approvalSheetHtml(sheet, "Pat Approver");
  assert.ok(html.indexOf("data-approval-mismatches") >= 0 && html.indexOf("data-approval-mismatches") < html.indexOf("<table"), "the mismatches are not above the table");
  assert.match(html, /3 things disagree or are missing/);
  assert.match(html, /77 Elsewhere Rd/);
  assert.ok(!html.includes("<img src=x"), "MUST-EXCLUDE: an unescaped value");
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /Recorded as:<\/strong> Pat Approver/);
  assert.match(html, /PORTAL_ALLOW_FINAL_SUBMIT/, "the gate's three conditions are still stated");
  const cleanHtml = ui({ state: {}, api: async () => ({}), confirm: () => true }).approvalSheetHtml(sheetFor(clean), "");
  assert.match(cleanHtml, /data-approval-clean/);
});

await check("(D2) no sheet from the server: the plain confirm is still shown, says so, and its answer decides", async () => {
  for (const answer of [true, false]) {
    const asked: string[] = [];
    const lib = ui({ state: { selectedProjectId: "p1" }, api: async () => { throw new Error("404"); }, confirm: (t: string) => { asked.push(t); return answer; } });
    assert.equal(await lib.confirmApprovalSheet("nem", "you"), answer);
    assert.equal(asked.length, 1);
    assert.match(asked[0], /approval sheet could not be loaded/);
    assert.match(asked[0], /Recorded as: you/);
  }
});

// ── (R) the route, on a real server (fixtures written BEFORE it boots; reads only after) ─────────
const OTHER_ORG = "org-approval-beta";
db.run("INSERT OR IGNORE INTO orgs (id, name, edition, created_at) VALUES (?, ?, 'full', ?)", [OTHER_ORG, "Beta Solar", new Date().toISOString()]);
const theirs = fx.newProject();
db.run("UPDATE projects SET org_id = ? WHERE id = ?", [OTHER_ORG, theirs]);
assert.equal(db.get<{ org_id: string }>("SELECT org_id FROM projects WHERE id = ?", [mixed])?.org_id, DEFAULT_ORG_ID);
const dbPath = String(process.env.AUTOPILOT_DB_PATH);
// Text extraction runs in the background after each document save; let it land before the handle closes.
for (let i = 0; i < 200; i++) {
  if (!db.get<{ n: number }>("SELECT COUNT(*) AS n FROM project_documents WHERE COALESCE(extracted_text, '') = ''")?.n) break;
  await new Promise((r) => setTimeout(r, 25));
}
db.close();

const PORT = 5640 + Math.floor(Math.random() * 30);
const BASE = `http://127.0.0.1:${PORT}`;
const env: Record<string, string | undefined> = {
  ...process.env, AUTOPILOT_DB_PATH: dbPath, AUTOPILOT_AUTO_START: "0", PORT: String(PORT), SEED_TEST_INSTALLER: "false",
  MONITOR_INTERVAL_MINUTES: "0", LOG_LEVEL: "warn", ANTHROPIC_API_KEY: "", CODE_RESEARCH: "off",
  SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
  AUTH_ENABLED: "true", ADMIN_EMAIL: "admin@approval.test", ADMIN_PASSWORD: "approval-test-password-1", NO_PROXY: "*", no_proxy: "*",
};
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) env[k] = "off";
const server = spawn(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "backend/src/server.ts")], {
  env: env as NodeJS.ProcessEnv, cwd: REPO, stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout?.on("data", (d) => { serverLog += String(d); });
server.stderr?.on("data", (d) => { serverLog += String(d); });
try {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up yet */ }
    if (i === 89) throw new Error(`server never came up:\n${serverLog.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const auditCount = () => {
    const h = new Database(dbPath, { readonly: true });
    try { return (h.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE project_id IN (?, ?)").get(mixed, theirs) as { n: number }).n; } finally { h.close(); }
  };
  const get = (id: string, track: string, cookie = "") => fetch(`${BASE}/api/projects/${id}/approval-sheet?track=${track}`, { headers: cookie ? { cookie } : {} });

  await check("(R1) signed out → 401", async () => {
    assert.equal((await get(mixed, "nem")).status, 401);
  });
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@approval.test", password: "approval-test-password-1" }),
  });
  const cookie = String(login.headers.get("set-cookie") || "").split(";")[0];
  const before = auditCount();
  await check("(R2) this org's project → 200, the sheet with masked ids, and nothing written", async () => {
    const res = await get(mixed, "nem", cookie);
    const text = await res.text();
    assert.equal(res.status, 200, text.slice(0, 300));
    const { sheet } = JSON.parse(text) as { sheet: { rows: Array<{ key: string; value: string }>; issues: Array<{ kind: string }> } };
    assert.equal(sheet.rows.find((r) => r.key === "account")?.value, "•••• 7890");
    assert.equal(sheet.issues[0]?.kind, "mismatch");
    for (const secret of [ACCOUNT, METER, "1234567899"]) assert.ok(!text.includes(secret), `the response carried ${secret}`);
  });
  await check("(R3) MUST-EXCLUDE: another org's project → 404, never 403", async () => {
    const res = await get(theirs, "nem", cookie);
    assert.equal(res.status, 404, await res.text());
  });
  await check("(R4) a track that is not a filing → 400", async () => {
    assert.equal((await get(mixed, "everything", cookie)).status, 400);
  });
  await check("(R5) the route wrote no audit row", () => {
    assert.equal(auditCount(), before);
  });
} finally {
  server.kill("SIGTERM");
}

finish("approval sheet");
