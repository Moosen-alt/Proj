// THE SIGNATURE-REQUEST STEP IS STAGED AND STOPS IN FRONT OF REQUEST SIGNATURES; ONLY A RUN A NAMED
// PERSON APPROVED CLICKS IT, ONCE (#308; owner ruling 2026-10-14 on #305: "Auto").
//
// PSE PowerClerk Part 2 step 4 "Project Agreements and Signature", rebuilt from the field inventory in
// #305 with synthetic values only: four required consents, an optional production-meter box that
// speaks of a charge, then "Application for Signature (Individual)" with eSign / Sign and Upload,
// Preview Document (opens the document in a window), Request Signatures (a POST that emails the
// homeowner, here counted), a status line, and Sign and Upload's Browse. Real Chromium:
//
//   (1) THE DEFAULT STOP. The learner ticks the four required consents (never the optional one),
//       selects eSign (never Sign and Upload), clicks Preview Document (a document window opened; the
//       status moves to "Previewed"), and stops: 0 signature-request POSTs, no upload, review state
//       "awaiting_signature_request", Request Signatures recorded as a stopForReview marker with
//       outwardAction "request_signatures" (never a click, never isFinalSubmit), the consent texts in
//       the hand-off notes, a review screenshot, and the planner never asked about this page.
//   (2) PORTAL_ALLOW_FINAL_SUBMIT=1 ALONE does not click it: 0 POSTs.
//   (3) An approval for ANOTHER run is refused (spent, named): 0 POSTs.
//   (4) A named person's approval of THIS run: exactly 1 POST, the status reads "Signature Requested",
//       review state "awaiting_customer_signature".
//   (5) Sign and Upload pre-selected on the page: the run selects eSign; Sign and Upload stays unchosen.
//   (6) A request already sent ("Signature Requested") with an approval: nothing is clicked again.
//   (7) Reached mid-walk (the planner fills step 3 and advances): step 4 is staged, never planned.
//
// Run: npx tsx portal-bot/src/adapters/signatureRequest.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium } from "playwright";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const CONSENTS = [
  "I agree to the terms of PSE Schedule 150 (Net Metering for Renewable Energy Facilities).",
  "I agree to the terms of PSE Schedule 152 (Interconnection standards).",
  "I understand PSE will review and approve this application and may revise it.",
  "I am responsible for the meter location and the required clearance around it.",
];

const step4 = (opts: { preselect?: "upload" | ""; status?: string }) => `<!doctype html><html><head><title>Part 2 - Project Agreements and Signature</title>
<style>.required label::after{content:" *";color:red}</style></head><body><main>
  <h1>Interconnection Application - Part 2</h1><h2>Step 4 of 5: Project Agreements and Signature</h2>
  <p>NEM-90017</p>
  <fieldset><legend>Agreements</legend>
    ${CONSENTS.map((t, i) => `<div class="required"><input type="checkbox" id="agree${i}" required><label for="agree${i}">${t}</label></div>`).join("")}
    <div><input type="checkbox" id="prodmeter"><label for="prodmeter">Optional: I request a PSE production meter and agree to the associated charges.</label></div>
  </fieldset>
  <fieldset id="sigblock"><legend>Application for Signature (Individual)</legend>
    <div><input type="radio" name="sigtype" id="esign" value="esign"><label for="esign">eSign</label></div>
    <div><input type="radio" name="sigtype" id="upload" value="upload" ${opts.preselect === "upload" ? "checked" : ""}><label for="upload">Sign and Upload</label></div>
    <div id="sigstatus">Status: <span id="st">${opts.status ?? "Not yet previewed"}</span></div>
    <button type="button" id="preview">Preview Document</button>
    <button type="button" id="reqsig">Request Signatures</button>
    <div id="uploadrow"><label for="signedfile">Signed application</label><input type="file" id="signedfile"><button type="button" id="browse" onclick="fetch('/upload-signed',{method:'POST'})">Browse</button></div>
  </fieldset>
  <button type="button" onclick="location.href='/p2/5'">Next</button>
</main>
<script>
  document.getElementById("preview").addEventListener("click", function () {
    window.open("/preview-doc", "_blank");
    document.getElementById("st").textContent = "Previewed";
  });
  document.getElementById("reqsig").addEventListener("click", function () {
    fetch("/request-signatures", { method: "POST" }).then(function () {
      document.getElementById("st").textContent = "Signature Requested";
    });
  });
</script></body></html>`;

const hits: string[] = [];
const posts: string[] = [];
let page4 = step4({});
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  hits.push(url.pathname);
  if (req.method !== "GET" && req.method !== "HEAD") {
    posts.push(url.pathname);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  if (url.pathname === "/p2/3") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>Part 2 - System Information</title><main><h1>Interconnection Application - Part 2</h1><h2>Step 3 of 5: System Information</h2>
      <form action="/p2/4" method="get"><label for="kw">System Size (kW DC)</label><input id="kw" name="kw"><button type="submit">Next</button></form></main>`);
    return;
  }
  if (url.pathname === "/p2/4") { res.writeHead(200, { "content-type": "text/html" }); res.end(page4); return; }
  if (url.pathname === "/preview-doc") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>Application for Signature</title><h1>This document is for customer review, signature and submittal to PSE.</h1><p>Print Name ____ Signature ____ Date ____</p>");
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><title>${url.pathname}</title><h1>${url.pathname}</h1>`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// The planner must never be asked about the signature step: it is staged deterministically.
let plannerCallsOnStep4 = 0;
const planner: LearnPlanner = async (req) => {
  if (/Project Agreements and Signature/.test(req.bodyText)) plannerCallsOnStep4++;
  const fills = req.fields.map((f, i) => ({ f, i })).filter((x) => x.f.fieldType === "text").map((x) => ({ selectorIndex: x.i, value: "8.6" }));
  const next = req.fields.findIndex((f) => f.fieldType === "button" && /^next$/i.test(String(f.label ?? "").trim()));
  return { fills, atReview: false, ...(next >= 0 ? { advanceSelectorIndex: next } : {}) };
};
const PROJECT = { projectAddress: "1234 North Example Street, Lynden, WA, 98264", city: "Lynden", state: "WA", zip: "98264", homeownerName: "Jordan Testcase" };

const browser = await chromium.launch();
type Learned = Awaited<ReturnType<AutoLearnAdapter["learn"]>>;
const run = async (label: string, html: string, adapterOpts: ConstructorParameters<typeof AutoLearnAdapter>[2] = {}, startPath = "/p2/4"): Promise<{ r: Learned | null; threw: string; checked: Record<string, boolean>; sigType: string }> => {
  page4 = html;
  const ctx = await browser.newContext();
  ctx.setDefaultTimeout(8000);
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  const page = await ctx.newPage();
  await page.goto(`${base}${startPath}`);
  hits.length = 0; posts.length = 0;
  const adapter = new AutoLearnAdapter("Smoke PowerClerk", planner, { maxPages: 4, ...adapterOpts });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).page = page;
  let r: Learned | null = null;
  let threw = "";
  try { r = await adapter.learn({ portalUrl: `${base}${startPath}` } as never, PROJECT as never); }
  catch (e) { threw = `${label}: ${String(e).slice(0, 300)}`; }
  const checked = await page.evaluate(() => {
    const o: Record<string, boolean> = {};
    document.querySelectorAll("input[type=checkbox]").forEach((el) => { o[el.id] = (el as HTMLInputElement).checked; });
    return o;
  }).catch(() => ({} as Record<string, boolean>));
  const sigType = await page.evaluate(() => (document.querySelector("input[name=sigtype]:checked") as HTMLInputElement | null)?.value ?? "").catch(() => "");
  await ctx.close().catch(() => null);
  return { r, threw, checked, sigType };
};

try {
  // (1) the default stop
  {
    const { r, threw, checked, sigType } = await run("default", step4({}));
    const sig = r?.signatureStep;
    const msg = String(r?.message ?? threw).slice(0, 500);
    check("(1) the four required consents are ticked; the optional charge-worded box is not",
      [0, 1, 2, 3].every((i) => checked[`agree${i}`] === true) && checked.prodmeter === false, `checked=${JSON.stringify(checked)} ${msg}`);
    check("(1) eSign is selected, never Sign and Upload", sigType === "esign" && sig?.signatureType === "esign", `sigType=${sigType} sig=${sig?.signatureType}`);
    check("(1) Preview Document opened the document and the status moved to Previewed",
      hits.includes("/preview-doc") && sig?.preview.kind === "window" && /previewed/i.test(String(sig?.statusAfter)), `hits=[${hits.join(",")}] preview=${JSON.stringify(sig?.preview)} status=${sig?.statusAfter}`);
    check("(1) Request Signatures is NOT clicked (0 POSTs) and Browse is never touched",
      posts.length === 0 && sig?.requestClicked === false, `posts=[${posts.join(",")}] clicked=${sig?.requestClicked}`);
    check("(1) the review state is awaiting_signature_request and the run reached review",
      sig?.state === "awaiting_signature_request" && r?.reachedReview === true && r?.ok === true, `state=${sig?.state} reached=${r?.reachedReview} ok=${r?.ok} ${msg}`);
    const steps = r?.steps ?? [];
    const stop = steps.find((s) => s.outwardAction === "request_signatures");
    check("(1) Request Signatures is recorded as a stopForReview marker: not final, not a click, nothing flagged final",
      stop?.action === "stopForReview" && stop?.isFinalSubmit === false && !steps.some((s) => s.isFinalSubmit === true)
        && !steps.some((s) => s.action === "click" && /request\s+signatures/i.test(String(s.note ?? "") + JSON.stringify(s.selector ?? {}))),
      `steps=${JSON.stringify(steps).slice(0, 600)}`);
    const notes = (r?.reviewHandoffNotes ?? []).join(" ");
    check("(1) the consent texts are a review note (what the homeowner agrees to), not a stop",
      CONSENTS.every((c) => notes.includes(c.slice(0, 40))), `notes=${notes.slice(0, 400)}`);
    check("(1) the review screenshot was taken after the preview", typeof r?.reviewScreenshotBase64 === "string" && r.reviewScreenshotBase64.length > 1000, `shot=${r?.reviewScreenshotBase64?.length}`);
    check("(1) the planner was never asked about the signature step", plannerCallsOnStep4 === 0, `calls=${plannerCallsOnStep4}`);
    check("(1) the walk did not go on to step 5", !hits.includes("/p2/5"), `hits=[${hits.join(",")}]`);
  }

  // (2) PORTAL_ALLOW_FINAL_SUBMIT=1 alone
  {
    process.env.PORTAL_ALLOW_FINAL_SUBMIT = "1";
    const { r } = await run("env-only", step4({}), { allowFinalSubmit: true });
    delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
    check("(2) PORTAL_ALLOW_FINAL_SUBMIT=1 (and allowFinalSubmit) without an approval: Request Signatures is not clicked",
      posts.length === 0 && r?.signatureStep?.state === "awaiting_signature_request", `posts=[${posts.join(",")}] state=${r?.signatureStep?.state}`);
  }

  // (3) an approval for another run
  {
    const { r } = await run("other-run", step4({}), { signatureRequestApproval: { approver: "Pat Approver", runId: "run-OTHER" }, runId: "run-1" });
    const sig = r?.signatureStep;
    check("(3) an approval of ANOTHER run is refused, named, and nothing is posted",
      posts.length === 0 && sig?.requestClicked === false && sig?.refusals.some((x) => /different run/.test(x)) === true && sig?.state === "awaiting_signature_request",
      `posts=[${posts.join(",")}] refusals=${JSON.stringify(sig?.refusals)}`);
  }

  // (4) a named person's approval of this run
  {
    const { r } = await run("approved", step4({}), { signatureRequestApproval: { approver: "Pat Approver", runId: "run-1" }, runId: "run-1" });
    const sig = r?.signatureStep;
    check("(4) the approved run clicks Request Signatures exactly once",
      posts.filter((p) => p === "/request-signatures").length === 1 && posts.length === 1 && sig?.requestClicked === true, `posts=[${posts.join(",")}] ${String(r?.message).slice(0, 300)}`);
    check("(4) the status reads requested and the track waits on the homeowner's signature",
      /signature requested/i.test(String(sig?.statusAfter)) && sig?.state === "awaiting_customer_signature" && sig?.approvedBy === "Pat Approver",
      `status=${sig?.statusAfter} state=${sig?.state} by=${sig?.approvedBy}`);
    check("(4) still nothing flagged final: Request Signatures is not the filing", !(r?.steps ?? []).some((s) => s.isFinalSubmit === true) && r?.finalSubmitRecorded === false,
      `final=${r?.finalSubmitRecorded}`);
  }

  // (5) Sign and Upload pre-selected
  {
    const { r, sigType } = await run("preselected-upload", step4({ preselect: "upload" }));
    check("(5) Sign and Upload pre-selected on the page: the run selects eSign instead and uploads nothing",
      sigType === "esign" && r?.signatureStep?.signatureType === "esign" && !posts.includes("/upload-signed"), `sigType=${sigType} posts=[${posts.join(",")}]`);
  }

  // (6) a request already sent
  {
    const { r } = await run("already", step4({ status: "Signature Requested" }), { signatureRequestApproval: { approver: "Pat Approver", runId: "run-1" }, runId: "run-1" });
    const sig = r?.signatureStep;
    check("(6) a request already sent is never sent again, even in an approved run",
      posts.length === 0 && sig?.requestClicked === false && sig?.state === "awaiting_customer_signature", `posts=[${posts.join(",")}] state=${sig?.state}`);
  }

  // (7) reached mid-walk: the planner fills step 3 and advances; step 4 is then staged, not planned.
  {
    plannerCallsOnStep4 = 0;
    const { r } = await run("mid-walk", step4({}), {}, "/p2/3");
    check("(7) reached from step 3 mid-walk: step 4 is staged and stops, the planner never plans it, 0 POSTs",
      hits.includes("/p2/4") && r?.signatureStep?.state === "awaiting_signature_request" && plannerCallsOnStep4 === 0 && posts.length === 0 && !hits.includes("/p2/5"),
      `hits=[${hits.join(",")}] state=${r?.signatureStep?.state} planner=${plannerCallsOnStep4} posts=[${posts.join(",")}] ${String(r?.message).slice(0, 300)}`);
  }
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} signature-request check(s) FAILED.`); process.exit(1); }
console.log("\nAll signature-request checks passed (real Chromium).");
process.exit(0);
