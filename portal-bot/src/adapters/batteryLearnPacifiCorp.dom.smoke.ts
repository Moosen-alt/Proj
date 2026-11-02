// THE PACIFICORP BATTERY LEARN, THREE WRONG THINGS ON ONE PAGE (#536) — real Chromium, the
// learner's own passes.
//
// Owner-requested battery learn on PacifiCorp NEM (2026-11-02, a synthetic job with one Enphase
// IQ Battery 5P). On Generation System Information the declaring tick was right, and then:
//   1. the equipment pass filled batteryModel against "Inverter Clone System Battery Inverter
//      Model" and the text landed in Total System Export (kW) — "Please enter a valid decimal
//      number" — with an `equipment_fill` event and no refusal;
//   2. the two REQUIRED battery attestations the tick revealed were left unchecked (owner ruling,
//      same day: on PacifiCorp battery jobs both are checked — Pacific Power allows no battery
//      export);
//   3. nothing recorded that the page ended with an invalid field or an unchecked required box.
//
// A SYNTHETIC page of that shape (labels as captured; no customer data). The per-render id is the
// mechanism the code already documents for PowerClerk ("#pcInputBase34 pointed at a different
// control on the next project"): here the section re-renders after the scrape — as it does when a
// box in it is ticked — and numbers the same controls in a different order, so the id the scrape
// recorded for "Battery Inverter Model" names Total System Export (kW) by the time the pass runs.
// The label selector is ambiguous (the cloned system repeats it), so resolution takes that id.
//
//   [A] stale id: the export box keeps its planned 3.25, nothing is typed, no step is recorded,
//       and the stray is reported (hand-off line + trust evidence). RED on main: 3.25 becomes the
//       battery model.
//   [B] a cloned box bound to the export box's model (the write lands where it was aimed AND in the
//       export box): the export box is put back to 3.25, no step is recorded, the stray is reported.
//       RED on main: the export box keeps the battery model and the step is recorded.
//   [C] the attestations: PacifiCorp + a battery job → both ticked, two `check` steps whose note
//       names the ruling; another utility, or a job without a battery → neither ticked, and the
//       planner's own tick of one is refused there. RED on main (nothing ticks them).
//   [D] trust evidence: a page ending with "Please enter a valid decimal number" and a required box
//       unchecked records both for that page (the review gate's acknowledgment is flagged as one).
//
//   npx tsx portal-bot/src/adapters/batteryLearnPacifiCorp.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium, type Page } from "playwright";
import type { RecipeStep } from "../../../shared/src/types";
import { AutoLearnAdapter, EXTRACT_SEL, extractFieldsInPage, toExtractedField, type ExtractedField, type LearnPlanner, type PageTrustEvidence } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const BATTERY_MODEL = "IQ Battery 5P";
const EXPORT_KW = "3.25";
const NO_BACKFEED = "The battery system will not backfeed into the grid.";
const TRANSFER = "The battery system includes a transfer switch (or equivalent) to ensure proper isolation before going off grid (islanding).";

// PowerClerk-shaped markup: a label, a red required asterisk, a Bootstrap control; the export box
// validates as a decimal and shows the portal's own message under it when it does not.
const SPEC_PAGE = (variant: string): string => `<!doctype html><html><head><style>
  body { font: 14px sans-serif; padding: 16px; } .p-2 { padding: 4px 0; }
  .invalid-feedback { display: none; color: #b00; } .is-invalid + .invalid-feedback { display: block; }
</style></head><body>
  <h2>Generation System Information</h2>
  <div class="panel"><h3 class="panel-title">Inverter Clone System</h3><div id="sec"></div></div>
<script>
  const VARIANT = ${JSON.stringify(variant)};
  // Each control's state survives a re-render (the portal's model), only its id is per-render.
  const model = { bim1: "", bim2: "", exp: ${JSON.stringify(EXPORT_KW)} };
  const rows = {
    bim1: (id) => '<div class="p-2"><label for="' + id + '">Battery Inverter Model</label><input class="form-control" type="text" id="' + id + '" data-k="bim1"></div>',
    bim2: (id) => '<div class="p-2"><label for="' + id + '">Battery Inverter Model</label><input class="form-control" type="text" id="' + id + '" data-k="bim2"></div>',
    exp: (id) => '<div class="p-2"><label for="' + id + '">Total System Export (kW)</label><span class="text-danger"> * </span><input class="form-control" type="text" id="' + id + '" data-k="exp"><div class="invalid-feedback">Please enter a valid decimal number</div></div>',
  };
  function render(order) {
    let n = 41;
    document.getElementById("sec").innerHTML = order.map((k) => rows[k]("pcInputBase" + (n++))).join("");
    for (const el of document.querySelectorAll("#sec input")) {
      el.value = model[el.dataset.k];
      el.addEventListener("input", () => {
        model[el.dataset.k] = el.value;
        // [B] the cloned box's binding points at the export box's model as well.
        if (VARIANT === "binding" && el.dataset.k === "bim1") {
          model.exp = el.value;
          const exp = document.querySelector('#sec input[data-k="exp"]');
          if (exp) exp.value = el.value;
        }
        validate();
      });
    }
    validate();
  }
  function validate() {
    const exp = document.querySelector('#sec input[data-k="exp"]');
    if (!exp) return;
    exp.classList.toggle("is-invalid", !/^\\s*\\d+(\\.\\d+)?\\s*$/.test(exp.value));
  }
  render(["bim1", "bim2", "exp"]);
  window.__rerender = () => render(["exp", "bim2", "bim1"]);
</script></body></html>`;

const ATTEST_PAGE = `<!doctype html><html><head><style>body { font: 14px sans-serif; padding: 16px; }</style></head><body>
  <h2>Generation System Information</h2>
  <div class="p-2"><label><input type="checkbox" id="inc" checked> This system includes battery storage</label></div>
  <div class="p-2"><input type="checkbox" id="bf" data-test-role="checkbox-element"><label for="bf">${NO_BACKFEED}</label><span class="text-danger"> * </span></div>
  <div class="p-2"><input type="checkbox" id="ts" data-test-role="checkbox-element"><label for="ts">${TRANSFER}</label><span class="text-danger"> * </span></div>
  <div class="p-2"><input type="checkbox" id="ack" required><label for="ack">I understand my form will not be submitted until I click Submit *</label></div>
</body></html>`;

const server = http.createServer((q, r) => {
  const u = new URL(q.url ?? "/", "http://x");
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(u.pathname === "/attest" ? ATTEST_PAGE : SPEC_PAGE(u.searchParams.get("variant") ?? "stale"));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

const noPlanner = (async () => ({ fills: [], atReview: false })) as unknown as LearnPlanner;
type Internals = {
  page: unknown;
  fillEquipmentSelects(fields: ExtractedField[], already: string[], steps: RecipeStep[]): Promise<number>;
  applyBatteryAttestations(already: string[]): Promise<Array<{ step: RecipeStep }>>;
  applyFill(field: ExtractedField, req: { value: string; field?: string }, sensitive: boolean): Promise<RecipeStep | null>;
  recordPageTrustEvidence(page: number, url: string): Promise<void>;
  trustEvidence: PageTrustEvidence[];
  equipmentStrays: string[];
};
const learnerOn = (page: Page, portalName: string, hasBattery: boolean | undefined): Internals => {
  const l = new AutoLearnAdapter(portalName, noPlanner, {
    policyProfile: "residential_nem", hasBattery,
    equipment: { batteryMake: "Enphase Energy Inc.", batteryModel: BATTERY_MODEL, batteryQuantity: "1" },
  });
  const i = l as unknown as Internals;
  i.page = page;
  // On main (the kill check) these do not exist: report each check red rather than crash.
  if (typeof i.applyBatteryAttestations !== "function") i.applyBatteryAttestations = async () => [];
  if (typeof i.recordPageTrustEvidence !== "function") i.recordPageTrustEvidence = async () => {};
  i.trustEvidence ??= [];
  i.equipmentStrays ??= [];
  return i;
};
const scrape = async (page: Page): Promise<ExtractedField[]> =>
  ((await page.$$eval(EXTRACT_SEL, extractFieldsInPage as never)) as never[]).map((r) => toExtractedField(r));
const valueOf = (page: Page, k: string): Promise<string> => page.locator(`#sec input[data-k="${k}"]`).inputValue();

for (const variant of ["stale", "binding"] as const) {
  const tag = variant === "stale" ? "[A]" : "[B]";
  console.log(`\n${tag} ${variant === "stale" ? "the scraped id now names the export box" : "the cloned box is bound to the export box too"}`);
  const page = await context.newPage();
  await page.goto(`${base}/?variant=${variant}`);
  const fields = await scrape(page);
  if (variant === "stale") await page.evaluate(() => (window as unknown as { __rerender(): void }).__rerender());
  const learner = learnerOn(page, "PacifiCorp", true);
  const steps: RecipeStep[] = [];
  await learner.fillEquipmentSelects(fields, [], steps);
  const exp = await valueOf(page, "exp");
  const bim = await valueOf(page, "bim2");
  console.log(`   export=${JSON.stringify(exp)} clone's Battery Inverter Model=${JSON.stringify(bim)} steps=${JSON.stringify(steps.map((s) => s.field ?? s.note))}`);
  check(`${tag} THE LIVE BUG: Total System Export (kW) keeps its planned ${EXPORT_KW}`, exp === EXPORT_KW,
    `export holds ${JSON.stringify(exp)} — the battery model went into the export box`);
  // The first box's field was scraped as #pcInputBase41 (the label is repeated, so that id is its
  // primary): [A] that id now names the export box, [B] it is the right box but its write reached
  // the export box too. Either way a recipe step on it would repeat the damage on every replay.
  check(`${tag} ...and no step is recorded on that control (a replay would repeat the write)`,
    !steps.some((s) => s.selector?.css === "#pcInputBase41"), JSON.stringify(steps.map((s) => s.selector)));
  check(`${tag} ...and the stray is reported, naming the export box`,
    learner.equipmentStrays.some((l) => /Total System Export/i.test(l)), JSON.stringify(learner.equipmentStrays));
  await learner.recordPageTrustEvidence(1, page.url());
  const ev = learner.trustEvidence[0];
  check(`${tag} ...and it is the page's trust evidence`, !!ev && ev.strayWrites.some((l) => /Total System Export/i.test(l)), JSON.stringify(learner.trustEvidence));
  check(`${tag} ...the cloned system's own box still gets its model`, bim === BATTERY_MODEL, `clone box holds ${JSON.stringify(bim)}`);
  check(`${tag} ...and the export box shows no validation error at the end`, !!ev && !ev.validationErrors.length, JSON.stringify(ev?.validationErrors));
  await page.close();
}

console.log("\n[C] the battery attestations the declaring tick revealed");
{
  const run = async (portalName: string, hasBattery: boolean | undefined) => {
    const page = await context.newPage();
    await page.goto(`${base}/attest`);
    const learner = learnerOn(page, portalName, hasBattery);
    const out = await learner.applyBatteryAttestations([]);
    const bf = await page.locator("#bf").isChecked();
    const ts = await page.locator("#ts").isChecked();
    const ack = await page.locator("#ack").isChecked();
    return { page, learner, out, bf, ts, ack };
  };
  const pc = await run("PacifiCorp", true);
  console.log(`   PacifiCorp, battery: backfeed=${pc.bf} transfer=${pc.ts} notes=${JSON.stringify(pc.out.map((o) => String(o.step.note).slice(0, 70)))}`);
  check("[C] PacifiCorp battery job: both attestations are ticked", pc.bf && pc.ts, `backfeed=${pc.bf} transfer=${pc.ts}`);
  check("[C] ...recorded as replayable checks whose note names the owner's ruling",
    pc.out.length === 2 && pc.out.every((o) => o.step.action === "check" && /^battery attestation:/.test(String(o.step.note)) && /owner ruling 2026-11-02/.test(String(o.step.note))),
    JSON.stringify(pc.out.map((o) => o.step)));
  check("[C] ...and nothing else on the page is ticked (not the review acknowledgment)", !pc.ack);
  await pc.page.close();

  const pp = await run("Pacific Power", true);
  check("[C] 'Pacific Power' (PacifiCorp's Oregon name) is the same ruling", pp.bf && pp.ts, `backfeed=${pp.bf} transfer=${pp.ts}`);
  await pp.page.close();

  const other = await run("Portland General Electric", true);
  check("[C] a utility with no ruling: neither is ticked", !other.bf && !other.ts && other.out.length === 0, `backfeed=${other.bf} transfer=${other.ts}`);
  // The planner's own tick on an unruled portal is refused (a statement on the filing is not its call).
  const fieldsOther = await scrape(other.page);
  const bfField = fieldsOther.find((f) => f.label === NO_BACKFEED);
  const plannerTick = bfField ? await other.learner.applyFill(bfField, { value: "true" }, false) : null;
  check("[C] ...and the planner's own tick of one is refused there", !!bfField && plannerTick === null && !(await other.page.locator("#bf").isChecked()),
    `field=${!!bfField} step=${JSON.stringify(plannerTick)}`);
  await other.page.close();

  const noBattery = await run("PacifiCorp", false);
  check("[C] a PacifiCorp job WITHOUT a battery: neither is ticked", !noBattery.bf && !noBattery.ts && noBattery.out.length === 0);
  await noBattery.page.close();
  const unknown = await run("PacifiCorp", undefined);
  check("[C] ...nor while the project is silent about a battery", !unknown.bf && !unknown.ts && unknown.out.length === 0);
  await unknown.page.close();
}

console.log("\n[D] the page ends with an invalid field and a required box unchecked");
{
  const page = await context.newPage();
  await page.goto(`${base}/attest`);
  // The export box from the spec page, typed with the battery model (what the live run left).
  await page.evaluate((v) => {
    document.body.insertAdjacentHTML("beforeend", '<div class="p-2"><label for="ex">Total System Export (kW)</label><span class="text-danger"> * </span><input class="form-control is-invalid" type="text" id="ex"><div class="invalid-feedback" style="display:block">Please enter a valid decimal number</div></div>');
    (document.getElementById("ex") as HTMLInputElement).value = v;
  }, BATTERY_MODEL);
  const learner = learnerOn(page, "Portland General Electric", true);
  await learner.recordPageTrustEvidence(4, page.url());
  const ev = learner.trustEvidence[0];
  console.log(`   ${JSON.stringify(ev)}`);
  check("[D] the visible validation error is recorded, named by its field",
    !!ev && ev.page === 4 && ev.validationErrors.some((e) => /^Total System Export \(kW\): Please enter a valid decimal number$/.test(e)), JSON.stringify(ev?.validationErrors));
  check("[D] each required checkbox left unchecked is recorded",
    !!ev && [NO_BACKFEED, TRANSFER].every((l) => ev.requiredUnchecked.some((u) => u.label === l && !u.acknowledgment)), JSON.stringify(ev?.requiredUnchecked));
  check("[D] ...the review gate's acknowledgment is recorded AS one (left for a person by design)",
    !!ev && ev.requiredUnchecked.some((u) => /will not be submitted until/i.test(u.label) && u.acknowledgment), JSON.stringify(ev?.requiredUnchecked));
  check("[D] ...a box that is not required is not (the declaring tick is checked anyway)",
    !!ev && !ev.requiredUnchecked.some((u) => /includes battery storage/i.test(u.label)), JSON.stringify(ev?.requiredUnchecked));
  // A clean page records nothing.
  await page.locator("#bf").check(); await page.locator("#ts").check(); await page.locator("#ack").check();
  await page.evaluate(() => { const ex = document.getElementById("ex") as HTMLInputElement; ex.value = "3.25"; ex.classList.remove("is-invalid"); (ex.nextElementSibling as HTMLElement).style.display = "none"; });
  const clean = learnerOn(page, "Portland General Electric", true);
  await clean.recordPageTrustEvidence(5, page.url());
  check("[D] a page that ends clean records no evidence", clean.trustEvidence.length === 0, JSON.stringify(clean.trustEvidence));
  await page.close();
}

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} batteryLearnPacifiCorp.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log("\nAll batteryLearnPacifiCorp.dom.smoke checks passed (real Chromium).");
process.exit(0);
