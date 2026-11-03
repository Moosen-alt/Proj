// AN ADVANCE OFF A PAGE YOU JUST FILLED IS NEVER "AN EXTRA ADVANCE".
//
// PowerClerk's wizard reuses ONE contact block across consecutive pages: "Preparer
// Information" and "Customer Information" carry byte-identical labels — Name, Last,
// Address, City, State, Zip, Email, Phone — at the same URL, with the same control ids.
//
// The guard that skips an advance a jurisdiction does not need decides by LABEL OVERLAP:
// "the next section's fields are already on this page, so this Next is redundant." On a
// portal with identical contact blocks that is always true, so it skipped the real advance
// from Preparer to Customer and the homeowner steps wrote over the installer's.
//
// Measured on a live PacifiCorp interconnection application: Charles Bitton of TML
// INTERNATIONAL LLC, 808 SE Chkalov Dr, Vancouver WA — replaced in the PREPARER block by
// the homeowner Randal Rowland at his own site address. Both the recipe bindings
// (installerFirstName vs homeownerFirstName) and the backend resolution were CORRECT. Only
// replay's page tracking was wrong, which is why nothing upstream could catch it. Recorded
// steps carry section:"" so there is no heading to disambiguate with — but "we just wrote
// to this page" is decisive on its own and needs nothing recorded.
//
// Case 2 is the guard this must not break: a genuinely duplicate advance, with no fills
// between, still has to be skipped (the Oregon ePermitting page-count case).
//
// Case 3 is Case 2 with a required dropdown on every section that no recipe step touches: the
// replay's answer to such a control (issue #352) must not change which advances are skipped.
//
// Run: npx tsx portal-bot/src/adapters/identicalSections.dom.smoke.ts
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// One set of controls, reused by every section — the PowerClerk shape. Next banks the
// current values under the section name and clears the inputs for the next section, so
// whatever each section ENDED UP WITH is inspectable afterwards.
const PAGE = `<!doctype html><html><body>
  <h2 id="heading">Preparer Information</h2>
  <form id="f">
    <label for="f_name">Name</label><input id="f_name">
    <label for="f_last">Last</label><input id="f_last">
    <label for="f_addr">Address</label><input id="f_addr">
  </form>
  <button id="next" type="button">Next</button>
  <script>
    window.__sections = ['Preparer Information', 'Customer Information', 'System'];
    window.__at = 0;
    window.__saved = {};
    document.getElementById('next').addEventListener('click', function () {
      var name = document.getElementById('f_name');
      var last = document.getElementById('f_last');
      var addr = document.getElementById('f_addr');
      window.__saved[window.__sections[window.__at]] = {
        name: name.value, last: last.value, addr: addr.value,
      };
      if (window.__at < window.__sections.length - 1) window.__at++;
      name.value = ''; last.value = ''; addr.value = '';
      document.getElementById('heading').textContent = window.__sections[window.__at];
    });
  </script>
</body></html>`;

// CASE 3's page: the same wizard, plus ONE REQUIRED DROPDOWN ON EVERY SECTION THAT NO RECIPE STEP
// TOUCHES — PacifiCorp's knife-blade question, which the replay answers from the learner's standing
// policy answer (issue #352). Next banks it with the rest and resets it for the next section.
const KNIFE = "Please indicate if the AC disconnect(s) for this installation are manually operated, lockable, load break, accessible, and has a visible open (knife blade type).";
const PAGE_KB = PAGE
  .replace(`<label for="f_addr">Address</label><input id="f_addr">`,
    `<label for="f_addr">Address</label><input id="f_addr">
    <label for="f_kb">${KNIFE}</label><select id="f_kb" required><option value="">Select...</option><option value="1">Yes</option><option value="2">No</option></select>`)
  .replace(`name: name.value, last: last.value, addr: addr.value,`,
    `name: name.value, last: last.value, addr: addr.value,
        kb: (function (k) { return k.value ? k.options[k.selectedIndex].text : ''; })(document.getElementById('f_kb')),`)
  .replace(`name.value = ''; last.value = ''; addr.value = '';`,
    `name.value = ''; last.value = ''; addr.value = ''; document.getElementById('f_kb').value = '';`);

const server = http.createServer((q, r) => {
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(String(q.url ?? "").startsWith("/kb") ? PAGE_KB : PAGE);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const mkRecipe = (steps: RecipeStep[]) => ({
  id: "is1", scopeType: "utility", profileKey: "or||pacific power", state: "OR", ahj: "", utility: "Pacific Power",
  portalPlatform: "powerclerk", portalUrl: url, status: "complete", version: 1, steps,
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe);

// BOTH CONTACT BLOCKS ARE BOUND, AND TO DIFFERENT KEYS — WHICH IS THE POINT OF THE SMOKE.
//
// These steps used to freeze the literals with no `field`, and since 3e42fec the
// cross-project guard refuses an unbound literal that looks like project data:
// looksLikeProjectData("Address", "808 SE Chkalov Dr") is true, and with the bare-"Name"
// widening so is looksLikeProjectData("Name", "Charles"). Both addresses and both names came
// back BLANK, so the two sections were indistinguishable by being equally empty and the
// subject of this test — that the installer's details stay in the preparer block and the
// homeowner's land in the customer block — was no longer being measured at all.
//
// A real recorded step carries the binding, and the live PacifiCorp recipe this file was
// written from carries exactly these: installerFirstName/installerLastName/installerStreet in
// the preparer block, homeownerFirstName/homeownerLastName/street in the customer block. Two
// DISTINCT key sets resolving two DISTINCT values, so a section that gets the wrong one still
// fails the way the unbound version used to — binding both blocks to one key would make this
// smoke pass while testing nothing.
//
// installerFirstName/installerLastName are absent from RECIPE_FIELD_DESCRIPTIONS but are NOT
// unanswerable: resolveRecipeFieldValues derives them by splitting the client overlay's
// installerContactName (the `installerSplit` block), and autoLearn's bindableFields is the
// UNION of that resolved map with the descriptions dictionary. A key the resolver cannot
// answer would turn each literal into a permanent blank, which is worse than the red here.
const FIELD_VALUES: Record<string, string> = {
  installerFirstName: "Charles", installerLastName: "Bitton", installerStreet: "808 SE Chkalov Dr",
  homeownerFirstName: "Randal", homeownerLastName: "Rowland", street: "7625 NW Logan Rd",
};

const f = (css: string, field: string, note: string): RecipeStep =>
  ({ action: "fill", phase: "fill", selector: { css }, field, value: FIELD_VALUES[field], note } as RecipeStep);
const advance: RecipeStep = { action: "click", phase: "fill", selector: { css: "#next" }, note: "advance: Next" } as RecipeStep;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

// CASE 1 — installer section, advance, homeowner section. The two sections are
// indistinguishable by label, which is exactly the live shape.
const p1 = await context.newPage();
await p1.goto(url);
const a1 = new RecipeAdapter(mkRecipe([
  f("#f_name", "installerFirstName", "Name"), f("#f_last", "installerLastName", "Last"), f("#f_addr", "installerStreet", "Address"),
  advance,
  f("#f_name", "homeownerFirstName", "Name"), f("#f_last", "homeownerLastName", "Last"), f("#f_addr", "street", "Address"),
  advance,
]), FIELD_VALUES, {}, { autoSubmit: false });
(a1 as unknown as { page: unknown }).page = p1;
const r1 = await a1.fillApplication({} as never);
const saved = await p1.evaluate(() => (window as unknown as { __saved: Record<string, { name: string; last: string; addr: string }> }).__saved);

check("the replay completes", () => {
  assert.equal(r1.ok, true, `run failed: ${String(r1.message ?? "").slice(0, 200)}`);
});
check("the INSTALLER's details survive in the preparer section", () => {
  assert.deepEqual(saved["Preparer Information"], { name: "Charles", last: "Bitton", addr: "808 SE Chkalov Dr" },
    `the homeowner overwrote the installer — got ${JSON.stringify(saved["Preparer Information"])}`);
});
check("the HOMEOWNER's details land in the customer section", () => {
  assert.deepEqual(saved["Customer Information"], { name: "Randal", last: "Rowland", addr: "7625 NW Logan Rd" },
    `got ${JSON.stringify(saved["Customer Information"])}`);
});

// CASE 2 — THE GUARD THIS MUST NOT BREAK. Two advances in a row with NO fills between:
// the recipe carries one more advance than this portal needs, and skipping it is correct.
// Reaching "System" would mean we sailed past the customer page.
const p2 = await context.newPage();
await p2.goto(url);
const a2 = new RecipeAdapter(mkRecipe([
  advance,
  advance,
  f("#f_name", "homeownerFirstName", "Name"), f("#f_last", "homeownerLastName", "Last"), f("#f_addr", "street", "Address"),
]), FIELD_VALUES, {}, { autoSubmit: false });
(a2 as unknown as { page: unknown }).page = p2;
const r2 = await a2.fillApplication({} as never);
const heading = await p2.locator("#heading").innerText();

check("a genuinely duplicate advance is still skipped", () => {
  assert.equal(r2.ok, true, `run failed: ${String(r2.message ?? "").slice(0, 200)}`);
  assert.equal(heading, "Customer Information",
    `the redundant advance was taken and the run overshot to ${JSON.stringify(heading)}`);
});

// CASE 3 — CASE 2 ON A PAGE WITH A REQUIRED CONTROL THE RECIPE NEVER RECORDED (PR #353 round 2).
//
// The replay answers a required control its recipe has no step for before it leaves a page
// (issue #352). That answer must never decide whether an advance is "extra": run before the skip
// guard, its fill marked the page as written, the guard stood down, the duplicate Next was clicked,
// and the homeowner's details were typed one page too far — onto "System". The skip has to read
// exactly as it did before #352 (Case 2), and the unrecorded answer is given only on the advance
// that actually leaves the page, and on the page the run ends on.
const p3 = await context.newPage();
await p3.goto(`${url}kb`);
const a3 = new RecipeAdapter(mkRecipe([
  advance,
  advance,
  f("#f_name", "homeownerFirstName", "Name"), f("#f_last", "homeownerLastName", "Last"), f("#f_addr", "street", "Address"),
]), FIELD_VALUES, {}, { autoSubmit: false });
(a3 as unknown as { page: unknown }).page = p3;
const r3 = await a3.fillApplication({} as never);
const heading3 = await p3.locator("#heading").innerText();
const live3 = await p3.evaluate(() => ({
  name: (document.getElementById("f_name") as HTMLInputElement).value,
  last: (document.getElementById("f_last") as HTMLInputElement).value,
  addr: (document.getElementById("f_addr") as HTMLInputElement).value,
  kb: (() => { const k = document.getElementById("f_kb") as HTMLSelectElement; return k.value ? k.options[k.selectedIndex].text : ""; })(),
}));
const saved3 = await p3.evaluate(() => (window as unknown as { __saved: Record<string, { name: string; last: string; addr: string; kb: string }> }).__saved);
const data3 = ((r3 as unknown as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
const drift3 = ((data3.driftWarnings as string[] | undefined) ?? []);
const story3 = `ok=${r3.ok} heading=${JSON.stringify(heading3)} live=${JSON.stringify(live3)} saved=${JSON.stringify(saved3)} message=${String(r3.message ?? "").slice(0, 200)}`;

check("[3] the duplicate advance is skipped exactly as without the unrecorded answer (the drift note says so)", () => {
  assert.ok(drift3.some((w) => w.includes("skipped an advance this jurisdiction does not need")),
    `no skip noted — drift: ${JSON.stringify(drift3).slice(0, 400)}; ${story3}`);
});
check("[3] the run ends on the customer section, not one page past it", () => {
  assert.equal(r3.ok, true, story3);
  assert.equal(heading3, "Customer Information", `overshot — ${story3}`);
  assert.equal(saved3["Customer Information"], undefined, `the customer section was left — ${story3}`);
});
check("[3] the homeowner's details are typed on the customer section (the section showing when they were typed)", () => {
  // One set of inputs serves every section, so the values alone do not say WHERE they went: the
  // heading showing above them does.
  assert.deepEqual({ section: heading3, name: live3.name, last: live3.last, addr: live3.addr },
    { section: "Customer Information", name: "Randal", last: "Rowland", addr: "7625 NW Logan Rd" }, story3);
});
check("[3] the unrecorded required control is answered on the page the real advance leaves, and on the page the run ends on", () => {
  assert.equal(saved3["Preparer Information"]?.kb, "Yes", story3);
  assert.equal(live3.kb, "Yes", story3);
});

await browser.close();
server.close();

if (failures > 0) {
  console.error(`\n${failures} identical-section smoke test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll identical-section smoke tests passed (real Chromium).");
process.exit(0);
