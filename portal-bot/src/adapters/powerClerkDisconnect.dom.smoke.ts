// THE AC DISCONNECT SECTION A RECIPE NEVER SAW (issue #352) — real Chromium, the real replay path.
//
// PacifiCorp's PowerClerk shows "AC Disconnect Switch Required" as a formula of the rating that
// Calculate computes, and only when it turns true does it render a required section: "Disconnect
// Switch Manufacturer" *, "Disconnect Switch Model" * (plain text boxes), the knife-blade question
// and the distance-to-meter question (native Yes/No selects). The live recipe was learned on a
// 5.4 kW system, so it has no step for any of them; on a 16 kW job the replay clicked Calculate,
// swept the page with Calculate still spinning ("Needs to be recalculated"), clicked Next, and the
// application reached review with all four blank and `requiredStillEmpty: []`.
//
// A SYNTHETIC copy of that page (the section's labels and control shapes as captured; no customer
// data): the section is not in the page at all until a slow Calculate (spinner in its loader, the stale
// marker, a request the server answers after CALC_DELAY_MS) reports a rating over 10 kW. The recipe
// is shaped like the live one: export kW, the meter questions, Calculate, Next — NO disconnect step.
//
//   [A] client standard Eaton / DG221URB, the job never answered the distance question
//       → the four controls hold Eaton / DG221URB / Yes / Yes when the page is left, and the run
//         reaches review (the sweep saw all four as required);
//   [B] no plan-set part and no client standard → the run STOPS before Next, naming the disconnect
//       make and model in its first 300 characters; nothing is typed into either;
//   [C] a 6.2 kW job (the section never renders) with no standard → no stop, reaches review
//       (a question the portal did not ask is not a reason to stop);
//   [D] the job's own recorded distance answer ("No") wins over the standing "Yes";
//   [L] the LEARNER's Calculate (clickComputeButton) returns only once the result is on the page,
//       so its rescan sees the four controls and its policy pass records the two Yes/No answers.
//
// Imports only the adapters and shared types (no #352 module), so a kill check swaps
// recipeAdapter.ts / autoLearnAdapter.ts back to main and this file turns red.
//
//   npx tsx portal-bot/src/adapters/powerClerkDisconnect.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";
import { AutoLearnAdapter, EXTRACT_SEL, extractFieldsInPage, type LearnPlanner } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

/** How long the portal takes to answer Calculate — longer than the replay's own path from the
 *  Calculate click to the Next click, so a replay that does not wait for the result leaves first. */
const CALC_DELAY_MS = 3500;

const LABEL = {
  make: "Disconnect Switch Manufacturer",
  model: "Disconnect Switch Model",
  knife: "Please indicate if the AC disconnect(s) for this installation are manually operated, lockable, load break, accessible, and has a visible open (knife blade type).",
  dist: "Are the AC disconnect(s) for this installation within the states required distance from the utility meter?  (California - 3 Ft., Oregon - 10 Ft., Washington - 3 Ft.)",
  meterLoc: "Is this meter located inside a garage/residence/facility?",
  meterAccess: "Possible meter access issues?",
};

const req = (id: string, label: string, control: string): string =>
  `<div class="p-2"><div><label for="${id}" class="d-inline" data-test-role="input-label">${label}</label><span data-test-role="required-indicator" class="text-danger"> * </span></div><div class="mb-3">${control}</div></div>`;
const yesNo = (id: string, key: string): string =>
  `<select class="form-select" id="${id}" data-test-role="dropdownlist-element" required data-k="${key}"><option value="">Select...</option><option value="24449">Yes</option><option value="24450">No</option></select>`;

// The section as PowerClerk renders it: NOT in the page at all until the computed rating requires it
// (v-if — the learn captures before Calculate hold no trace of it), then rendered whole.
const SECTION = `<div class="literal-element"><b>Pacific Power requires a knife blade type, visible, lockable disconnect.</b></div>
${req("DMAKEInput", LABEL.make, '<input class="form-control" type="text" id="DMAKEInput" data-test-role="textbox-element" maxlength="2048" required data-k="discMake">')}
${req("DMODELInput", LABEL.model, '<input class="form-control" type="text" id="DMODELInput" data-test-role="textbox-element" maxlength="2048" required data-k="discModel">')}
${req("DTYPEInput", LABEL.knife, yesNo("DTYPEInput", "discKnife"))}
${req("DDISTInput", LABEL.dist, yesNo("DDISTInput", "discDist"))}
`;

const SPEC_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{font:14px sans-serif;padding:12px} .loader{display:flex;justify-content:center}
  .spinner-border{width:24px;height:24px;border:3px solid #888;border-right-color:transparent;border-radius:50%;animation:s .8s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}} .stale{color:#c00}
</style></head><body>
  <h2>Generation System Information</h2>
  ${req("EXPORTKWInput", "Total System Export (kW)", '<input class="form-control" type="text" id="EXPORTKWInput" data-test-role="textbox-element" required data-k="exportKw">')}
  <div class="row"><div class="col-6"><b>System Rating:</b> <span data-test-role="dc-rating-output" id="rating" class="stale">Needs to be recalculated</span></div>
    <div class="col"><div data-test-role="calculate-btn-loader"><button type="button" data-test-role="calculate-btn" class="btn" id="calc">Calculate</button><div class="d-flex loader" id="loader"></div></div></div></div>
  <div data-type="FormulaResultElement"><span data-test-role="input-label">AC Disconnect Switch Required</span><div id="discReq">false</div></div>
  <div id="discSlot"></div>
  ${req("MLOCInput", LABEL.meterLoc, yesNo("MLOCInput", "meterLoc"))}
  ${req("MACCInput", LABEL.meterAccess, '<select class="form-select" id="MACCInput" data-test-role="dropdownlist-element" required data-k="meterAccess"><option value="">Select...</option><option value="13">None</option><option value="14">Dog at residence</option><option value="15">Locked gate</option><option value="17">Other</option></select>')}
  <button id="next" type="button">Next</button>
  <script>
    var server = { exportKw: "", discMake: "", discModel: "", discKnife: "", discDist: "", meterLoc: "", meterAccess: "", calculated: false };
    window.__server = server;
    // PER-FIELD AUTOSAVE on blur / change (a select saves its visible option text).
    function wire(root) {
      var els = root.querySelectorAll("[data-k]");
      for (var i = 0; i < els.length; i++) (function (el) {
        var save = function () { server[el.getAttribute("data-k")] = el.tagName === "SELECT" ? (el.value ? el.options[el.selectedIndex].text : "") : el.value; };
        el.addEventListener(el.tagName === "SELECT" ? "change" : "blur", save);
      })(els[i]);
    }
    wire(document);
    var SECTION = ${JSON.stringify(SECTION)};
    // CALCULATE: spinner in the loader, the stale marker stays, the server answers later; the
    // disconnect section renders only when the computed rating requires it (over 10 kW here).
    document.getElementById("calc").addEventListener("click", function () {
      var loader = document.getElementById("loader");
      loader.innerHTML = '<div class="spinner-border" role="status"></div>';
      var ms = new URLSearchParams(location.search).get("calcMs") || "";
      fetch("/calc?kw=" + encodeURIComponent(server.exportKw || "0") + "&ms=" + ms).then(function (r) { return r.json(); }).then(function (res) {
        loader.innerHTML = "";
        var rating = document.getElementById("rating");
        rating.textContent = res.kw + " kW DC"; rating.className = "";
        server.calculated = true;
        var required = res.kw > 10;
        document.getElementById("discReq").textContent = String(required);
        var slot = document.getElementById("discSlot");
        if (required && !slot.children.length) { slot.innerHTML = SECTION; wire(slot); }
        if (!required) slot.innerHTML = "";
      });
    });
    document.getElementById("next").addEventListener("click", function () {
      sessionStorage.setItem("srv", JSON.stringify(server));
      location.href = "/review";
    });
  </script>
</body></html>`;

const REVIEW_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <h1>Review and Submit</h1>
  <p>Please review your application before submitting.</p>
  <div id="out"></div>
  <button type="button" id="submitapp">Submit Application</button>
  <script>
    var s = JSON.parse(sessionStorage.getItem("srv") || "{}");
    window.__server = s;
    document.getElementById("out").innerHTML = "<table>"
      + "<tr><td>Total System Export (kW)</td><td>" + (s.exportKw || "") + "</td></tr>"
      + "<tr><td>Disconnect Switch Manufacturer</td><td>" + (s.discMake || "") + "</td></tr>"
      + "<tr><td>Disconnect Switch Model</td><td>" + (s.discModel || "") + "</td></tr>"
      + "<tr><td>Knife blade</td><td>" + (s.discKnife || "") + "</td></tr>"
      + "<tr><td>Within required distance</td><td>" + (s.discDist || "") + "</td></tr>"
      + "<tr><td>Meter location</td><td>" + (s.meterLoc || "") + "</td></tr>"
      + "<tr><td>Meter access</td><td>" + (s.meterAccess || "") + "</td></tr></table>";
    document.getElementById("submitapp").addEventListener("click", function () { window.__filed = true; });
  </script>
</body></html>`;

const server = http.createServer((q, r) => {
  const url = new URL(String(q.url ?? "/"), "http://fixture.invalid");
  if (url.pathname === "/calc") {
    const kw = Number(url.searchParams.get("kw") || 0);
    const ms = Number(url.searchParams.get("ms") || 0) || CALC_DELAY_MS;
    setTimeout(() => { r.writeHead(200, { "Content-Type": "application/json" }); r.end(JSON.stringify({ kw })); }, ms);
    return;
  }
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(url.pathname.startsWith("/review") ? REVIEW_PAGE : SPEC_PAGE);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// Shaped like the live PacifiCorp recipe's system page: the export kW bound, the meter questions as
// portal literals, Calculate, Next — and no step for any disconnect control.
const recipe = (url: string): PortalRecipe => ({
  id: "pc352", scopeType: "utility", profileKey: "or|unknown|pacificorp", state: "OR", ahj: "", utility: "PacifiCorp",
  portalPlatform: "auto-learned", portalUrl: url, status: "complete", version: 1,
  steps: [
    { action: "fill", phase: "fill", selector: { label: "Total System Export (kW)", fallbacks: [{ css: "#EXPORTKWInput" }] }, field: "totalExportKw", note: "Total System Export (kW)" },
    { action: "select", phase: "fill", selector: { label: LABEL.meterLoc, fallbacks: [{ css: "#MLOCInput" }] }, value: "No", note: LABEL.meterLoc },
    { action: "select", phase: "fill", selector: { label: LABEL.meterAccess, fallbacks: [{ css: "#MACCInput" }] }, value: "None", note: LABEL.meterAccess },
    { action: "click", phase: "fill", selector: { role: "button", name: "Calculate", exact: true }, note: "compute totals: Calculate" },
    { action: "click", phase: "fill", selector: { role: "button", name: "Next", exact: true }, note: "advance: Next" },
    { action: "stopForReview", phase: "review", note: "review" },
  ] as RecipeStep[],
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe);

type Committed = Record<string, string | boolean>;
const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const run = async (fields: Record<string, string>) => {
  const p = await context.newPage();
  await p.goto(`${base}/`);
  const a = new RecipeAdapter(recipe(`${base}/`), fields, {}, { autoSubmit: false });
  (a as unknown as { page: unknown }).page = p;
  const r = await a.fillApplication({} as never);
  const committed = await p.evaluate(() => (window as unknown as { __server: Record<string, string | boolean> }).__server);
  const filed = await p.evaluate(() => (window as unknown as { __filed?: boolean }).__filed === true);
  const url = p.url();
  await p.close();
  const data = ((r as unknown as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
  return { r, data, committed: committed as Committed, filed, url };
};
const outline = (w: Awaited<ReturnType<typeof run>>): string =>
  `ok=${w.r.ok} url=${w.url.replace(base, "")} committed=${JSON.stringify(w.committed)} message=${String(w.r.message ?? "").slice(0, 300)} drift=${JSON.stringify(w.data.driftWarnings ?? []).slice(0, 400)}`;
const atReview = (w: Awaited<ReturnType<typeof run>>): boolean => w.url.endsWith("/review");

// ---------------------------------------------------------------------------
console.log("\n[A] 16.1 kW, client standard Eaton / DG221URB, distance never answered by the job");
const A = await run({ totalExportKw: "16.128", disconnectMake: "Eaton", disconnectModel: "DG221URB", disconnectWithin10ft: "" });
console.log(`   ${outline(A)}`);
check("[A] the run reaches review", A.r.ok === true && atReview(A), outline(A));
check("[A] Disconnect Switch Manufacturer = Eaton (the client's standard part, bound)", A.committed.discMake === "Eaton", outline(A));
check("[A] Disconnect Switch Model = DG221URB", A.committed.discModel === "DG221URB", outline(A));
check("[A] the knife-blade question = Yes (the learner's standing policy answer)", A.committed.discKnife === "Yes", outline(A));
check("[A] the distance question = Yes (the operator's standing answer; the job recorded none)", A.committed.discDist === "Yes", outline(A));
check("[A] the recorded steps still ran (meter questions, export kW)",
  A.committed.meterLoc === "No" && A.committed.meterAccess === "None" && A.committed.exportKw === "16.128", outline(A));
{
  const seen = ((A.data.requiredFieldsSeen as string[] | undefined) ?? []).join(" | ");
  check("[A] the required sweep saw the disconnect section (requiredFieldsSeen names all four)",
    [LABEL.make, LABEL.model, LABEL.knife.slice(0, 40), LABEL.dist.slice(0, 40)].every((l) => seen.includes(l)), seen.slice(0, 600));
  const blanks = (A.data.requiredStillEmpty as string[] | undefined) ?? [];
  check("[A] nothing required was left blank", blanks.length === 0, JSON.stringify(blanks));
}
check("[A] nothing was filed", A.filed === false, outline(A));

console.log("\n[B] 16.1 kW, no plan-set part and no client standard");
const B = await run({ totalExportKw: "16.128", disconnectMake: "", disconnectModel: "", disconnectWithin10ft: "" });
console.log(`   ${outline(B)}`);
const bMsg = String(B.r.message ?? "");
check("[B] the run stops before review (Next never clicked)", B.r.ok === false && !atReview(B), outline(B));
check("[B] the stop names the disconnect make AND model within the first 300 characters",
  bMsg.slice(0, 300).includes(LABEL.make) && bMsg.slice(0, 300).includes(LABEL.model), bMsg.slice(0, 320));
check("[B] nothing was typed into the make or model (never blank-filled, never guessed)",
  B.committed.discMake === "" && B.committed.discModel === "", outline(B));
check("[B] the stop is a person's to finish (needsHuman)", B.data.needsHuman === true, JSON.stringify(Object.keys(B.data)));
check("[B] nothing was filed", B.filed === false, outline(B));

console.log("\n[C] 6.2 kW (the section never renders), no client standard");
const C = await run({ totalExportKw: "6.2", disconnectMake: "", disconnectModel: "", disconnectWithin10ft: "" });
console.log(`   ${outline(C)}`);
check("[C] no stop: a question the portal did not ask is not a reason to stop — the run reaches review",
  C.r.ok === true && atReview(C), outline(C));
check("[C] nothing was answered in the hidden section", !C.committed.discMake && !C.committed.discModel && !C.committed.discKnife && !C.committed.discDist, outline(C));

console.log("\n[D] 16.1 kW, the job recorded its own distance answer: No");
const D = await run({ totalExportKw: "16.128", disconnectMake: "Eaton", disconnectModel: "DG221URB", disconnectWithin10ft: "No" });
console.log(`   ${outline(D)}`);
check("[D] the job's own answer wins over the standing Yes", D.committed.discDist === "No" && atReview(D), outline(D));

// ---------------------------------------------------------------------------
// [L] THE LEARNER'S Calculate: a fresh learn must SEE the section to record it. The learner clicks
// Calculate once its rescans converge (clickComputeButton) and re-scans the page when it returns —
// so the section has to be on the page by then. The portal here answers in 12 s, past the learner's
// 6 s network-idle wait: what clickComputeButton waits on must be the page's own result.
console.log("\n[L] the learner's Calculate returns only once the result (and the section it reveals) is on the page");
{
  const learner = new AutoLearnAdapter("PacifiCorp (synthetic)", (async () => ({ fills: [], atReview: false })) as unknown as LearnPlanner, { policyProfile: "residential_nem" });
  const lp = await context.newPage();
  await lp.goto(`${base}/?calcMs=12000`);
  await lp.fill("#EXPORTKWInput", "16.128");
  await lp.locator("#EXPORTKWInput").blur();
  (learner as unknown as { page: unknown }).page = lp;
  const internals = learner as unknown as {
    clickComputeButton(steps: RecipeStep[]): Promise<boolean>;
    applyPolicyDefaults(labels: string[]): Promise<Array<{ step: RecipeStep }>>;
  };
  const steps: RecipeStep[] = [];
  const t0 = Date.now();
  const clicked = await internals.clickComputeButton(steps);
  const secs = Math.round((Date.now() - t0) / 100) / 10;
  const labels = ((await lp.$$eval(EXTRACT_SEL, extractFieldsInPage as never)) as Array<{ label?: string }>).map((f) => String(f.label ?? ""));
  console.log(`   clicked=${clicked} after ${secs}s; disconnect controls extracted: ${JSON.stringify(labels.filter((l) => /disconnect/i.test(l)).map((l) => l.slice(0, 40)))}`);
  check("[L] Calculate is clicked and recorded as a replayable \"compute totals\" step",
    clicked && steps.some((s) => s.action === "click" && /^compute totals\b/i.test(String(s.note ?? ""))), JSON.stringify(steps));
  const shown = await Promise.all(["#DMAKEInput", "#DMODELInput", "#DTYPEInput", "#DDISTInput"].map((sel) => lp.locator(sel).isVisible().catch(() => false)));
  check("[L] when it returns, the rescan sees all four disconnect controls (on the page, visible)",
    shown.every(Boolean) && [LABEL.make, LABEL.model, LABEL.knife.slice(0, 40), LABEL.dist.slice(0, 40)].every((l) => labels.some((x) => x.includes(l))),
    `after ${secs}s visible=${JSON.stringify(shown)}; the page extraction holds: ${JSON.stringify(labels.slice(0, 20))}`);
  const policy = await internals.applyPolicyDefaults([]);
  const notes = policy.map((p) => String(p.step.note ?? ""));
  check("[L] ...so the learner's policy pass records the knife-blade and distance answers (Yes)",
    notes.some((n) => n.includes(LABEL.knife.slice(0, 60)) && /Yes$/.test(n)) && notes.some((n) => n.includes(LABEL.dist.slice(0, 60)) && /Yes$/.test(n)), JSON.stringify(notes));
  await lp.close();
}

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} powerClerkDisconnect.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log("\nAll powerClerkDisconnect.dom.smoke checks passed (real Chromium).");
process.exit(0);
