// A SEARCH-AS-YOU-TYPE BOX IS TYPED INTO AND PICKED FROM (#575).
//
// The live shape (a Cityworks PublicAccess application, 2026-11-03): the application's "Location"
// is the city's GIS address search, an EDITABLE
//   <input data-cw-id="txtGISLocation" type="text" maxlength="100" role="combobox"
//          aria-autocomplete="list" aria-controls="list-…" aria-expanded="false">
// inside an Angular cw-ui-input-container, whose list does not exist until you type (the captured
// page holds no element with that id and no role=option at all). The learner upgraded every
// <input role=combobox> to a select, opened an empty list, picked nothing, and Next did nothing.
//
// This replica keeps that STRUCTURE (the container, the label-for, the aria-labelledby that points
// at nothing, the counter, the overlay container the list is rendered into after a debounce) with
// SYNTHETIC addresses only — invented streets, numbers and cities. Modes (?mode=):
//   exact      the job's address is listed among neighbours → picked, read back, and the REPLAY
//              re-finds it (and types THAT job's address for another job);
//   direction  the city lists the house under another street direction → nothing picked, the walk
//              stops with the question, the box is left empty; the replay stops the same way;
//   none       the box offers nothing → a NAMED failure within the fill's budget, box empty;
//   dupes      the same address listed twice → nothing picked, the question.
// MUST EXCLUDE: PowerClerk's readonly filtered-select and an editable combobox with no
// aria-autocomplete are still selects.
//
//   npx tsx portal-bot/src/adapters/typeaheadFill.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium, type Page } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { AutoLearnAdapter, EXTRACT_SEL, extractFieldsInPage, toExtractedField, type LearnPlanner, type LearnResult } from "./autoLearnAdapter";
import { RecipeAdapter } from "./recipeAdapter";
import { fillTypeahead } from "../typeaheadFill";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// ---- synthetic data ----------------------------------------------------------------------------
const JOB = { street: "4821 W Quillfeather Dr", city: "Marrowvale", state: "UT", zip: "84999" };
const OTHER_JOB = { street: "77 E Brindlecove Ln", city: "Marrowvale", state: "UT", zip: "84999" };
const BOOKS: Record<string, string[]> = {
  exact: [
    "4812 W QUILLFEATHER DR, MARROWVALE, UT 84999",
    "4821 W QUILLFEATHER RIDGE DR, MARROWVALE, UT 84999",
    "4821 W QUILLFEATHER DR, MARROWVALE, UT 84999",
    "4823 W QUILLFEATHER DR, MARROWVALE, UT 84999",
    "77 E BRINDLECOVE LN, MARROWVALE, UT 84999",
    "77 W BRINDLECOVE LN, MARROWVALE, UT 84999",
  ],
  direction: [
    "4812 S QUILLFEATHER DR, MARROWVALE, UT 84999",
    "4821 S QUILLFEATHER DR, MARROWVALE, UT 84999",
  ],
  none: [],
  dupes: [
    "4821 W QUILLFEATHER DR, MARROWVALE, UT 84999",
    "4821 W QUILLFEATHER DR, MARROWVALE, UT 84999",
  ],
};

// ---- the replica ---------------------------------------------------------------------------------
const formPage = (mode: string): string => `<!doctype html><html><head><title>PublicAccess</title>
<style>
  body{font:14px sans-serif;margin:0;padding:16px}
  cw-ui-input-container{display:block;margin:8px 0;width:420px}
  .input-content input{width:400px;padding:4px}
  .cdk-overlay-container{position:fixed;top:0;left:0;width:0;height:0;z-index:1000}
  .cw-ui-autocomplete-panel{position:fixed;top:150px;left:16px;width:420px;background:#fff;border:1px solid #888}
  .cw-option{padding:4px 8px;cursor:pointer}
  .cw-error{color:#b00}
</style></head><body>
<div class="createHeader"><span>Application:</span> <span>SOLAR - Synthetic</span></div>
<div class="controlHeader"><div class="stepNumber">1</div><span>Main</span></div>
<cw-ui-grid-column class="cwGridLayout col-12-xs">
<cw-ui-input-container layoutid="txtCaseName" divider-color="accent" class="valid empty">
  <div class="above"><label for="cw-ui-input-1000000000000001"> Project Name </label><span trailing="" class="hint counter"> 0 / 80 </span></div>
  <div class="input-content"><div class="leading"></div><input data-cw-id="txtCaseName" maxlength="80" type="text" id="cw-ui-input-1000000000000001" placeholder="" aria-describedby="cw-ui-input-1000000000000001-desc cw-ui-input-1000000000000001-length" aria-labelledby="cw-ui-input-1000000000000001-label" class="ng-untouched ng-pristine ng-valid"><div class="trailing"></div></div>
  <div class="below"><span class="hint" id="cw-ui-input-1000000000000001-desc"></span></div>
</cw-ui-input-container>
</cw-ui-grid-column>
<cw-ui-grid-column class="cwGridLayout col-12-xs">
<cw-ui-input-container layoutid="txtGISLocation" divider-color="accent" class="valid empty">
  <div class="above"><label for="cw-ui-input-2000000000000002"> Location </label><span trailing="" class="hint counter"> 0 / 100 </span></div>
  <div class="input-content"><div class="leading"></div><input data-cw-id="txtGISLocation" maxlength="100" type="text" id="cw-ui-input-2000000000000002" placeholder="" aria-describedby="cw-ui-input-2000000000000002-desc cw-ui-input-2000000000000002-length" aria-labelledby="cw-ui-input-2000000000000002-label" class="ng-untouched ng-pristine ng-valid" aria-controls="list-cw-ui-input-2000000000000002" aria-autocomplete="list" aria-expanded="false" role="combobox"><div class="trailing"></div></div>
  <div class="below"><span class="hint" id="cw-ui-input-2000000000000002-desc"></span></div>
</cw-ui-input-container>
</cw-ui-grid-column>
<div id="err" class="cw-error"></div>
<div id="picked"></div>
<button type="button" id="cancel">Cancel</button>
<button type="button" id="next">Next</button>
<div class="cdk-overlay-container"></div>
<script>
  var BOOK = ${JSON.stringify(BOOKS[mode] ?? (mode === "slow" ? BOOKS.exact : []))};
  var MODE = ${JSON.stringify(mode)};
  var box = document.getElementById("cw-ui-input-2000000000000002");
  var overlay = document.querySelector(".cdk-overlay-container");
  var picked = null; var timer = null;
  window.__searches = [];
  function close() { overlay.innerHTML = ""; box.setAttribute("aria-expanded", "false"); }
  function render(q) {
    close();
    var words = q.toLowerCase().split(/\\s+/).filter(Boolean);
    var hits = BOOK.filter(function (a) {
      var toks = a.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ");
      return words.every(function (w) { return toks.some(function (t) { return t.indexOf(w) === 0; }); });
    });
    window.__searches.push(q);
    var panel = document.createElement("div");
    panel.className = "cw-ui-autocomplete-panel";
    panel.setAttribute("role", "listbox");
    panel.id = "list-cw-ui-input-2000000000000002";
    if (!hits.length) {
      var none = document.createElement("div"); none.className = "cw-no-results"; none.textContent = "No results found";
      panel.appendChild(none);
    }
    hits.forEach(function (a) {
      var o = document.createElement("div");
      o.className = "cw-option"; o.setAttribute("role", "option"); o.textContent = a;
      o.addEventListener("mousedown", function (e) { e.preventDefault(); });
      o.addEventListener("click", function () {
        box.value = a; picked = a; close();
        document.getElementById("picked").textContent = "PICKED " + a;
      });
      panel.appendChild(o);
    });
    overlay.appendChild(panel);
    box.setAttribute("aria-expanded", "true");
  }
  box.addEventListener("input", function () {
    picked = null; document.getElementById("picked").textContent = "";
    clearTimeout(timer);
    var q = box.value.trim();
    if (q.length < 3) { close(); return; }
    if (MODE === "slow") {
      // A slow GIS search (the live city's): the panel opens at once with only a progress bar,
      // and the suggestions arrive 9 s later, longer than one query's own wait.
      close();
      var loadingPanel = document.createElement("div");
      loadingPanel.className = "cw-ui-autocomplete-panel"; loadingPanel.setAttribute("role", "listbox");
      loadingPanel.id = "list-cw-ui-input-2000000000000002";
      var bar = document.createElement("div"); bar.className = "cw-progress-bar"; bar.setAttribute("role", "progressbar");
      bar.style.cssText = "height:4px;background:#1976d2";
      loadingPanel.appendChild(bar); overlay.appendChild(loadingPanel); box.setAttribute("aria-expanded", "true");
      timer = setTimeout(function () { render(q); }, 9000);
      return;
    }
    // The GIS search answers after a debounce and a round trip.
    timer = setTimeout(function () { render(q); }, 350);
  });
  document.getElementById("next").addEventListener("click", function () {
    if (!picked || box.value !== picked) { document.getElementById("err").textContent = "Location is required"; return; }
    location.href = "/review?mode=" + MODE;
  });
</script></body></html>`;

const REVIEW = `<!doctype html><html><head><title>Review Application</title></head><body>
<h1>Review</h1><p>Review your application before you submit it.</p>
<button type="button" id="submit">Submit Application</button></body></html>`;

// MUST EXCLUDE shapes, for the classifier.
const CLASSIFY = `<!doctype html><html><head><title>Classify</title></head><body>
  <label for="pcMfr">Manufacturer</label>
  <input id="pcMfr" role="combobox" aria-haspopup="listbox" aria-label="Manufacturer" class="visually-hidden" readonly>
  <label for="cb">County</label><input id="cb" role="combobox" aria-label="County" autocomplete="off">
  <label for="ta">Contractor</label><input id="ta" type="search" role="combobox" aria-autocomplete="both">
  <label for="tro">Parcel</label><input id="tro" type="text" role="combobox" aria-autocomplete="list" readonly>
</body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://x");
  res.writeHead(200, { "Content-Type": "text/html" });
  if (u.pathname === "/review") return res.end(REVIEW);
  if (u.pathname === "/classify") return res.end(CLASSIFY);
  if (u.pathname === "/framed") return res.end(`<!doctype html><html><head><title>Framed</title></head><body><h1>Wizard</h1><iframe id="app" name="app" src="/?mode=exact" style="width:700px;height:500px"></iframe></body></html>`);
  res.end(formPage(u.searchParams.get("mode") || "exact"));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

const planner: LearnPlanner = async (req) => {
  if (/review/i.test(req.pageTitle || "")) return { fills: [], atReview: true };
  const fills: Array<{ selectorIndex: number; value: string; field?: string }> = [];
  const name = req.fields.findIndex((f) => f.label === "Project Name");
  const loc = req.fields.findIndex((f) => f.label === "Location");
  if (name >= 0) fills.push({ selectorIndex: name, value: "Synthetic Test Job", field: "projectName" });
  if (loc >= 0) fills.push({ selectorIndex: loc, value: JOB.street, field: "street" });
  const next = req.fields.findIndex((f) => f.label === "Next");
  return { fills, atReview: false, ...(next >= 0 ? { advanceSelectorIndex: next } : {}) };
};

const read = async (page: Page): Promise<{ value: string; picked: string }> => ({
  value: await page.locator("#cw-ui-input-2000000000000002").inputValue().catch(() => "(gone)"),
  picked: ((await page.locator("#picked").textContent().catch(() => "")) ?? "").trim(),
});

async function learn(mode: string, maxPages = 2): Promise<{ result: LearnResult; page: Page; ms: number; before: { value: string; picked: string } }> {
  const page = await ctx.newPage();
  const url = `${base}/?mode=${mode}`;
  await page.goto(url);
  const adapter = new AutoLearnAdapter(`Typeahead ${mode}`, planner, { maxPages, siteIdentity: { city: JOB.city, zip: JOB.zip } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).page = page;
  const t0 = Date.now();
  const result = await adapter.learn(
    { portalUrl: url } as never,
    { projectAddress: `${JOB.street}, ${JOB.city}, ${JOB.state}, ${JOB.zip}`, city: JOB.city, state: JOB.state, zip: JOB.zip, homeownerName: "Synthetic Owner", permitType: "building" } as never,
  );
  const ms = Date.now() - t0;
  // What the box holds where the walk ended (the review page has no box).
  const before = /\/review/.test(page.url()) ? { value: "(advanced)", picked: "(advanced)" } : await read(page);
  return { result, page, ms, before };
}

async function replay(mode: string, step: RecipeStep, job: typeof JOB): Promise<{ data: Record<string, unknown>; ok: boolean; message: string; page: Page; after: { value: string; picked: string }; ms: number }> {
  const page = await ctx.newPage();
  const url = `${base}/?mode=${mode}`;
  const recipe = {
    id: `r-${mode}`, scopeType: "ahj", profileKey: "ut|marrowvale|x", state: "UT", ahj: "Marrowvale", utility: "",
    portalPlatform: "cityworks", portalUrl: url, status: "complete", version: 1,
    steps: [{ action: "goto", phase: "open", value: url, note: "entry url" }, step],
    createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "structural",
  } as unknown as PortalRecipe;
  const adapter = new RecipeAdapter(recipe, { street: job.street, city: job.city, zip: job.zip, projectAddress: `${job.street}, ${job.city}, ${job.state}, ${job.zip}` }, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = page;
  const t0 = Date.now();
  const r = await adapter.fillApplication({} as never);
  const ms = Date.now() - t0;
  return { data: (r.data ?? {}) as Record<string, unknown>, ok: r.ok, message: String(r.message ?? ""), page, after: await read(page), ms };
}

// ---- A) CLASSIFICATION ---------------------------------------------------------------------------
{
  const page = await ctx.newPage();
  await page.goto(`${base}/?mode=exact`);
  const fields = (await page.$$eval(EXTRACT_SEL, extractFieldsInPage)).map(toExtractedField);
  const location = fields.find((f) => f.label === "Location");
  const name = fields.find((f) => f.label === "Project Name");
  console.log(`   location: ${location?.fieldType}/${location?.fillStrategy ?? "-"}; project name: ${name?.fieldType}/${name?.fillStrategy ?? "-"}`);
  check("the GIS Location box (editable role=combobox, aria-autocomplete=list) is a TYPEAHEAD text field, not a select",
    location?.fieldType === "text" && location?.fillStrategy === "typeahead",
    `got ${location?.fieldType}/${location?.fillStrategy} — as a select the list is opened empty and nothing is picked`);
  check("...and its label is still the matching key",
    location?.selector?.label === "Location", `selector ${JSON.stringify(location?.selector)}`);
  check("an ordinary text box carries no strategy", name?.fieldType === "text" && !name?.fillStrategy, `${name?.fieldType}/${name?.fillStrategy}`);
  await page.goto(`${base}/classify`);
  const raws = await page.$$eval(EXTRACT_SEL, extractFieldsInPage);
  const by = (id: string) => raws.find((r) => r.id === id);
  check("MUST EXCLUDE: PowerClerk's readonly filtered-select stays a select", by("pcMfr")?.fieldType === "select" && !by("pcMfr")?.typeahead, JSON.stringify(by("pcMfr")));
  check("MUST EXCLUDE: an editable combobox with no aria-autocomplete stays a select", by("cb")?.fieldType === "select" && !by("cb")?.typeahead, JSON.stringify(by("cb")));
  check("MUST EXCLUDE: a readonly box that says aria-autocomplete=list is not typed into", by("tro")?.fieldType === "select" && !by("tro")?.typeahead, JSON.stringify(by("tro")));
  check("a search-type combobox with aria-autocomplete=both is a typeahead", by("ta")?.fieldType === "text" && by("ta")?.typeahead === true, JSON.stringify(by("ta")));
  await page.close();
}

// ---- B) LEARN, EXACT: picked, read back, recorded with the strategy and the binding ---------------
let recorded: RecipeStep | undefined;
{
  const { result, page, ms } = await learn("exact");
  recorded = result.steps.find((s) => s.action === "fill" && s.note === "Location");
  console.log(`   learn exact: ${ms} ms, steps=${JSON.stringify(result.steps.map((s) => `${s.action}:${s.note ?? ""}${s.fillStrategy ? `[${s.fillStrategy}]` : ""}`))}`);
  check("learn: the job's address was picked and the application advanced",
    /\/review/.test(page.url()), `ended at ${page.url()}; misses=${JSON.stringify(result.typeaheadMisses)} message=${result.message.slice(0, 300)}`);
  check("learn: the step is recorded as a typeahead fill, BOUND to the street (never the suggestion's text)",
    recorded?.fillStrategy === "typeahead" && recorded?.field === "street" && !recorded?.value,
    `recorded ${JSON.stringify(recorded)}`);
  check("learn: nothing is reported as not picked", !result.typeaheadMisses?.length, JSON.stringify(result.typeaheadMisses));
  await page.close();
}

// ---- C) REPLAY, EXACT: the replay re-finds it — and types THAT job's address ----------------------
if (recorded) {
  const r = await replay("exact", recorded, JOB);
  console.log(`   replay exact: ${r.ms} ms ok=${r.ok} value=${JSON.stringify(r.after.value)} picked=${JSON.stringify(r.after.picked)} skipped=${JSON.stringify(r.data.skipped)}`);
  check("replay: the recorded typeahead step picks the job's suggestion",
    r.after.picked === "PICKED 4821 W QUILLFEATHER DR, MARROWVALE, UT 84999" && r.after.value === "4821 W QUILLFEATHER DR, MARROWVALE, UT 84999",
    `picked=${JSON.stringify(r.after.picked)} value=${JSON.stringify(r.after.value)} — a plain fill types the address and nobody picks it`);
  check("replay: the step is not skipped", Array.isArray(r.data.skipped) && (r.data.skipped as string[]).length === 0, JSON.stringify(r.data.skipped));
  const other = await replay("exact", recorded, OTHER_JOB);
  console.log(`   replay other job: picked=${JSON.stringify(other.after.picked)}`);
  check("replay: for ANOTHER job it types and picks that job's address (E, not its W neighbour)",
    other.after.picked === "PICKED 77 E BRINDLECOVE LN, MARROWVALE, UT 84999", `picked=${JSON.stringify(other.after.picked)}`);
  await r.page.close();
  await other.page.close();
} else {
  check("replay: a recorded typeahead step to replay", false, "the learn recorded no Location step");
}

// ---- D) LEARN, DIRECTION MISMATCH: nothing picked, the question, the box empty --------------------
{
  const { result, page, ms, before } = await learn("direction");
  console.log(`   learn direction: ${ms} ms stop=${result.stopReason} box=${JSON.stringify(before.value)} picked=${JSON.stringify(before.picked)}`);
  console.log(`   message: ${result.message.slice(0, 400)}`);
  check("learn: a direction mismatch stops the walk with the question",
    result.stopReason === "typeahead_question", `stopReason=${result.stopReason}; message=${result.message.slice(0, 300)}`);
  check("...naming the portal's address and the project's",
    /4821 S QUILLFEATHER DR/.test(result.message) && /4821 W Quillfeather Dr/.test(result.message) && /Use the portal's\?/.test(result.message),
    result.message.slice(0, 400));
  check("...with NOTHING picked and the box left empty",
    before.picked === "" && before.value === "", `picked=${JSON.stringify(before.picked)} value=${JSON.stringify(before.value)}`);
  check("...and no typeahead step recorded for it",
    !result.steps.some((s) => s.note === "Location"), JSON.stringify(result.steps.map((s) => s.note)));
  await page.close();
}

// ---- E) REPLAY, DIRECTION MISMATCH: stops the same way ---------------------------------------------
if (recorded) {
  const r = await replay("direction", recorded, JOB);
  console.log(`   replay direction: ok=${r.ok} value=${JSON.stringify(r.after.value)} message=${r.message.slice(0, 200)}`);
  check("replay: a direction mismatch stops the run for a person, named",
    !r.ok && /Stopped for a person/.test(r.message) && /4821 S QUILLFEATHER DR/.test(r.message), r.message.slice(0, 300));
  check("...nothing picked, the box empty",
    r.after.picked === "" && r.after.value === "", `picked=${JSON.stringify(r.after.picked)} value=${JSON.stringify(r.after.value)}`);
  await r.page.close();
}

// ---- E2) A SLOW LIST: a panel that shows a progress bar is still loading, not empty ---------------
{
  const page = await ctx.newPage();
  await page.goto(`${base}/?mode=slow`);
  const t0 = Date.now();
  const out = await fillTypeahead(page, page.locator("#cw-ui-input-2000000000000002"), {
    value: JOB.street, mode: "site", site: { street: JOB.street, city: JOB.city, zip: JOB.zip },
  });
  const ms = Date.now() - t0;
  const after = await read(page);
  console.log(`   slow list: ${ms} ms outcome=${out.outcome} after=${JSON.stringify(after)}`);
  check("slow list (9 s behind a progress bar): the fill waits while it loads and picks the job's address",
    out.outcome === "picked" && after.value === "4821 W QUILLFEATHER DR, MARROWVALE, UT 84999" && /^PICKED 4821 W QUILLFEATHER DR/.test(after.picked),
    JSON.stringify({ outcome: out.outcome, after }));
  check("...within the fill's 30 s budget", ms < 30_000, `${ms} ms`);
  await page.close();
}

// ---- F) NO SUGGESTIONS: a named failure, within the fill's budget ---------------------------------
{
  const page = await ctx.newPage();
  await page.goto(`${base}/?mode=none`);
  const t0 = Date.now();
  const out = await fillTypeahead(page, page.locator("#cw-ui-input-2000000000000002"), {
    value: JOB.street, mode: "site", site: { street: JOB.street, city: JOB.city, zip: JOB.zip },
  });
  const ms = Date.now() - t0;
  const searches = await page.evaluate(() => (window as unknown as { __searches: string[] }).__searches);
  const after = await read(page);
  console.log(`   no suggestions: ${ms} ms outcome=${out.outcome} why=${"why" in out ? out.why : ""} searched=${JSON.stringify(searches)}`);
  check("no suggestions is a NAMED outcome, not a pick", out.outcome === "no_suggestions" && /offered no suggestions/.test("why" in out ? out.why : ""), JSON.stringify(out));
  check("...after widening from house + street to the house number alone",
    JSON.stringify(searches) === JSON.stringify(["4821 Quillfeather", "4821"]), JSON.stringify(searches));
  check("...within the fill's 30 s budget", ms < 30_000, `${ms} ms`);
  check("...and the box is left empty", after.value === "" && after.picked === "", JSON.stringify(after));
  await page.close();
  if (recorded) {
    const r = await replay("none", recorded, JOB);
    const warnings = (r.data.driftWarnings as string[] | undefined) ?? [];
    console.log(`   replay none: ${r.ms} ms skipped=${JSON.stringify(r.data.skipped)} warnings=${JSON.stringify(warnings.filter((w) => /Location/.test(w)))}`);
    check("replay: no suggestions is a FAILED step with its reason, never a silent accept",
      Array.isArray(r.data.skipped) && (r.data.skipped as string[]).length === 1
        && warnings.some((w) => /^FAILED "Location"/.test(w) && /offered no suggestions/.test(w)),
      `skipped=${JSON.stringify(r.data.skipped)} warnings=${JSON.stringify(warnings)}`);
    check("...and the box is left empty", r.after.value === "", JSON.stringify(r.after));
    await r.page.close();
  }
  // The LEARN's hand-off, which is what an operator reads on a live learn: the miss is named.
  const l = await learn("none", 1);
  console.log(`   learn none: ${l.ms} ms misses=${JSON.stringify(l.result.typeaheadMisses)} box=${JSON.stringify(l.before.value)}`);
  check("learn: no suggestions is said in the result and the message (📍 Not picked), not dropped",
    (l.result.typeaheadMisses ?? []).some((m) => /^"Location"/.test(m) && /offered no suggestions/.test(m))
      && /📍 Not picked — "Location"/.test(l.result.message),
    `misses=${JSON.stringify(l.result.typeaheadMisses)} message=${l.result.message.slice(0, 300)}`);
  check("...with no step recorded for it and the box left empty",
    !l.result.steps.some((s) => s.note === "Location") && l.before.value === "" && l.before.picked === "",
    `steps=${JSON.stringify(l.result.steps.map((s) => s.note))} box=${JSON.stringify(l.before)}`);
  await l.page.close();
}

// ---- G) SEVERAL EQUAL CANDIDATES: nothing picked ---------------------------------------------------
{
  const { result, page, before } = await learn("dupes");
  console.log(`   learn dupes: stop=${result.stopReason} box=${JSON.stringify(before.value)}`);
  check("learn: the same address listed twice picks nothing and asks which",
    result.stopReason === "typeahead_question" && /2 entries/.test(result.message) && before.value === "" && before.picked === "",
    `stop=${result.stopReason} box=${JSON.stringify(before)} message=${result.message.slice(0, 300)}`);
  await page.close();
}

// ---- H) THE BOX INSIDE AN IFRAME: its list is read and clicked in its own frame ---------------------
{
  const page = await ctx.newPage();
  await page.goto(`${base}/framed`);
  const frame = page.frameLocator("#app");
  await frame.locator("#cw-ui-input-2000000000000002").waitFor({ timeout: 10_000 });
  const out = await fillTypeahead(page, frame.locator("#cw-ui-input-2000000000000002"), {
    value: JOB.street, mode: "site", site: { street: JOB.street, city: JOB.city, zip: JOB.zip },
  });
  const pickedText = ((await frame.locator("#picked").textContent().catch(() => "")) ?? "").trim();
  console.log(`   framed: outcome=${out.outcome} picked=${JSON.stringify(pickedText)}`);
  check("a typeahead inside an iframe is read and picked in its own frame",
    out.outcome === "picked" && pickedText === "PICKED 4821 W QUILLFEATHER DR, MARROWVALE, UT 84999",
    `outcome=${JSON.stringify(out)} picked=${JSON.stringify(pickedText)} — reading the top document finds no list`);
  await page.close();
}

await browser.close();
server.close();
console.log(failures === 0 ? "typeaheadFill.dom.smoke: PASS" : `typeaheadFill.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
