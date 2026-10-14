// THE RESUME AFTER THE HOMEOWNER SIGNS READS THE RECORD PAGE, NEVER GUESSES, AND STOPS IN FRONT OF
// STEP 5'S SUBMIT (#310).
//
// A synthetic PSE-shaped PowerClerk tenant (wording from #305 / #308, values invented): the account's
// application list, the draft's record page (its own status "Application Draft" beside a "Signature"
// card), Part 2 steps 1–3, step 4 "Project Agreements and Signature" (eSign, a status line, and a
// Request Signatures button that POSTs — counted, never to be clicked here), and step 5 "Next Steps"
// whose Submit POSTs the filing. Real Chromium, the learner with continueDraft.awaitingSignature (the
// stage the backend runs while the track waits on the signature):
//
//   (1) RECORD READS "Not yet previewed": no request ever went — the walk goes on and stages the
//       signature step again (#308's stop in front of Request Signatures). 0 POSTs.
//   (2) RECORD READS "Signature Requested": the run stops ON THE RECORD PAGE, awaiting customer
//       signature, and says why; no form is opened, 0 POSTs.
//   (3) RECORD READS "Signed": the walk opens Part 2, passes step 4 without clicking anything on it,
//       reaches step 5 and records its Submit as the ONE final step — NOT clicked, 0 POSTs (no
//       approval reached the run, and PORTAL_ALLOW_FINAL_SUBMIT is unset).
//   (3b) The same with PORTAL_ALLOW_FINAL_SUBMIT=1 alone: still 0 POSTs.
//   (4) RECORD READS "Processing" (unfamiliar), and a record with no signature status at all: the run
//       stops on the record page, awaiting customer signature, naming what it read. 0 POSTs.
//   (5) Record "Signed" but the signature step reads "Signature Requested": stops on step 4, awaiting,
//       nothing clicked, step 5 never reached.
//   (6) Two signers on the record, one "Signed" and one "Requested": not signed — stops on the record.
//   (7) The application's own "Status: Application Draft" is never read as a signature status.
//
// KILL TEST: skip the record-page read in openExistingDraft (`if (false && cd.awaitingSignature)`) →
// 12 checks across (1)–(6) fail: the run opens the form without reading the signature.
//
// Run: npx tsx portal-bot/src/adapters/signatureResume.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium } from "playwright";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";
import { readSignatureStatuses } from "./signatureStatusRead";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const shell = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><header><a href="/home">Program Home</a></header><main>${body}</main></body></html>`;
const step = (n: number, title: string, fields: Array<[string, string]>) => shell(`Part 2 - ${title}`, `
  <h1>Interconnection Application - Part 2</h1><h2>Step ${n} of 5: ${title}</h2><p>NEM-90017</p>
  <form action="/p2/${n + 1}" method="get">
    ${fields.map(([id, label]) => `<div><label for="${id}">${label}</label><input id="${id}" name="${id}"></div>`).join("")}
    <button type="submit">Next</button>
  </form>`);

// The draft's record page. `signature` is the Signature card's inner HTML.
const record = (signature: string) => shell("NEM-90017", `
  <h1>NEM-90017</h1><p>Status: Application Draft</p><p>1234 N Example St, Lynden</p>
  ${signature}
  <div class="card"><div class="card-header">Current Forms</div><table><tbody>
    <tr><td>PSE - Cancellation Form <button type="button" onclick="location.href='/cancel'">Begin</button></td><td>New Form</td></tr>
    <tr><td>Interconnection Application - Part 2 <button type="button" onclick="location.href='/p2/1'">Edit</button></td><td>In Progress</td></tr>
  </tbody></table></div>
  <div class="card"><div class="card-header">Previously Submitted Forms</div><table><tbody>
    <tr><td>Interconnection Application Part 1 (Preliminary Validation) <button type="button" onclick="location.href='/p1/view'">View</button></td><td>Submitted</td></tr>
  </tbody></table></div>`);
const sigCard = (status: string) => `<div class="card"><div class="card-header">Application Signature</div><p>Signature Status: ${status}</p></div>`;

const CONSENTS = [
  "I agree to the terms of PSE Schedule 150 (Net Metering for Renewable Energy Facilities).",
  "I agree to the terms of PSE Schedule 152 (Interconnection standards).",
];
// Step 4. Signed: consents ticked, eSign chosen, status read off the page. The Request Signatures
// button stays on the page (the worst case): it must never be clicked by a resume.
const step4 = (status: string, ticked: boolean) => shell("Part 2 - Project Agreements and Signature", `
  <h1>Interconnection Application - Part 2</h1><h2>Step 4 of 5: Project Agreements and Signature</h2><p>NEM-90017</p>
  <fieldset><legend>Agreements</legend>
    ${CONSENTS.map((t, i) => `<div class="required"><input type="checkbox" id="agree${i}" required ${ticked ? "checked" : ""}><label for="agree${i}">${t}</label></div>`).join("")}
  </fieldset>
  <fieldset id="sigblock"><legend>Application for Signature (Individual)</legend>
    <div><input type="radio" name="sigtype" id="esign" value="esign" ${ticked ? "checked" : ""}><label for="esign">eSign</label></div>
    <div><input type="radio" name="sigtype" id="upload" value="upload"><label for="upload">Sign and Upload</label></div>
    <div id="sigstatus">Status: <span id="st">${status}</span></div>
    <button type="button" id="preview" onclick="window.open('/preview-doc','_blank');document.getElementById('st').textContent='Previewed'">Preview Document</button>
    <button type="button" id="reqsig" onclick="fetch('/request-signatures',{method:'POST'})">Request Signatures</button>
  </fieldset>
  <button type="button" onclick="location.href='/p2/5'">Next</button>`);

let recordHtml = record(sigCard("Signed"));
let step4Html = step4("Signed", true);
const PAGES: Record<string, () => string> = {
  "/home": () => shell("Program Home", `
    <h1>Program Home</h1>
    <a href="/new" class="btn">Start a New Application</a>
    <table><thead><tr><th>Project</th><th>Status</th><th>Customer</th><th>Site</th></tr></thead><tbody>
      <tr><td><a href="/rec/80001">NEM-80001</a></td><td>Approved</td><td>Riley Sample</td><td>77 Other Rd, Lynden</td></tr>
      <tr><td><a href="/rec/90017">NEM-90017</a></td><td>Application Draft</td><td>Jordan Testcase</td><td>1234 N Example St, Lynden</td></tr>
    </tbody></table>`),
  "/rec/90017": () => recordHtml,
  "/p2/1": () => step(1, "Customer Information", [["cust", "Customer Name"]]),
  "/p2/2": () => step(2, "Installer", [["inst", "Installer Company"]]),
  "/p2/3": () => step(3, "System Details", [["kw", "System Size (kW DC)"]]),
  "/p2/4": () => step4Html,
  "/p2/5": () => shell("Part 2 - Next Steps", `
    <h1>Interconnection Application - Part 2</h1><h2>Step 5 of 5: Next Steps</h2>
    <p>SUBMIT application to PSE once customer signature is complete. Please review your application before submitting.</p>
    <form action="/submit" method="post"><label for="ack">Comments</label><input id="ack" name="ack"><button type="submit">Submit</button></form>`),
  "/preview-doc": () => "<!doctype html><title>Application for Signature</title><h1>Document</h1>",
};
const hits: string[] = [];
const posts: string[] = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  hits.push(url.pathname);
  if (req.method !== "GET" && req.method !== "HEAD") {
    posts.push(url.pathname);
    res.writeHead(200, { "content-type": "text/html" });
    res.end(shell("Submitted", "<p>Your application has been submitted.</p>"));
    return;
  }
  const html = PAGES[url.pathname]?.();
  res.writeHead(html ? 200 : 404, { "content-type": "text/html" });
  res.end(html ?? shell("Not found", `<h1>Not found</h1>`));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// Fill text boxes, advance by "Next"; at step 5 name its Submit as the final submit. Records whether
// the planner was ever asked to act on the signature step (it may only advance past it).
let step4PlannerClicks = 0;
const planner: LearnPlanner = async (req) => {
  const fills = req.fields.map((f, i) => ({ f, i })).filter((x) => x.f.fieldType === "text").map((x) => ({ selectorIndex: x.i, value: "Synthetic" }));
  const atReview = /Step 5 of 5: Next Steps/.test(req.bodyText);
  const next = req.fields.findIndex((f) => f.fieldType === "button" && /^next$/i.test(String(f.label ?? "").trim()));
  const submit = req.fields.findIndex((f) => f.fieldType === "button" && /^submit$/i.test(String(f.label ?? "").trim()));
  if (/Project Agreements and Signature/.test(req.bodyText) && next < 0) step4PlannerClicks++;
  if (atReview) return { fills, atReview, ...(submit >= 0 ? { finalSubmitSelectorIndex: submit } : {}) };
  return { fills, atReview, ...(next < 0 ? {} : { advanceSelectorIndex: next }) };
};
const PROJECT = { projectAddress: "1234 North Example Street, Lynden, WA, 98264", city: "Lynden", state: "WA", zip: "98264", homeownerName: "Jordan Testcase" };
const CONTINUE = { applicationNumber: "NEM-90017", nextForm: "Interconnection Application - Part 2", street: PROJECT.projectAddress, required: true, awaitingSignature: true };

const browser = await chromium.launch();
type Learned = Awaited<ReturnType<AutoLearnAdapter["learn"]>>;
const resume = async (opts: { record: string; step4?: string; allowFinalSubmit?: boolean }): Promise<{ r: Learned | null; msg: string }> => {
  recordHtml = opts.record;
  step4Html = opts.step4 ?? step4("Signed", true);
  const ctx = await browser.newContext();
  ctx.setDefaultTimeout(8000);
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  const page = await ctx.newPage();
  await page.goto(`${base}/home`);
  hits.length = 0; posts.length = 0;
  const adapter = new AutoLearnAdapter("Smoke PowerClerk", planner, { maxPages: 12, continueDraft: CONTINUE, allowFinalSubmit: opts.allowFinalSubmit === true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).page = page;
  let r: Learned | null = null;
  let threw = "";
  try { r = await adapter.learn({ portalUrl: `${base}/home` } as never, PROJECT as never); }
  catch (e) { threw = String(e).slice(0, 300); }
  await ctx.close().catch(() => null);
  return { r, msg: String(r?.message ?? threw).slice(0, 700) };
};
const openedNoForm = () => !["/p2/1", "/p2/2", "/p2/3", "/p2/4", "/p2/5", "/new", "/cancel", "/p1/view"].some((p) => hits.includes(p));

try {
  // (7) the reader itself, on the real DOM: the application's own status is not a signature status.
  {
    const ctx = await browser.newContext();
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await ctx.newPage();
    recordHtml = record(sigCard("Signed"));
    await page.goto(`${base}/rec/90017`);
    const read = await readSignatureStatuses(page);
    check("(7) the record page's signature status is read, and its own \"Status: Application Draft\" is not",
      read.length === 1 && read[0] === "Signed", JSON.stringify(read));
    recordHtml = record("");
    await page.goto(`${base}/rec/90017`);
    const none = await readSignatureStatuses(page);
    check("(7) a record with no signature card reads no signature status at all", none.length === 0, JSON.stringify(none));
    step4Html = step4("Signed", true);
    await page.goto(`${base}/p2/4`);
    const s4 = await readSignatureStatuses(page);
    check("(7) the signature step's own status line is read", s4.length === 1 && s4[0] === "Signed", JSON.stringify(s4));
    await ctx.close().catch(() => null);
  }

  // (1) not yet previewed: the walk stages the signature step again.
  {
    const { r, msg } = await resume({ record: record(sigCard("Not yet previewed")), step4: step4("Not yet previewed", false) });
    check("(1) record \"Not yet previewed\": read as never requested, and the walk goes on",
      r?.signatureCheck?.state === "not_requested" && hits.includes("/p2/4"), `check=${JSON.stringify(r?.signatureCheck)} hits=[${hits.join(",")}] ${msg}`);
    check("(1) the signature step is staged again and stops in front of Request Signatures: 0 POSTs, step 5 never reached",
      r?.signatureStep?.state === "awaiting_signature_request" && posts.length === 0 && !hits.includes("/p2/5"),
      `sig=${r?.signatureStep?.state} posts=[${posts.join(",")}] hits=[${hits.join(",")}]`);
  }

  // (2) requested: stop on the record page.
  {
    const { r, msg } = await resume({ record: record(sigCard("Signature Requested")) });
    check("(2) record \"Signature Requested\": awaiting customer signature, and the run says why",
      r?.signatureCheck?.state === "awaiting_customer_signature" && r?.signatureCheck?.where === "record" && /Signature Requested/.test(String(r?.signatureCheck?.why)) && /HOMEOWNER SIGNATURE/.test(msg),
      `check=${JSON.stringify(r?.signatureCheck)} ${msg}`);
    check("(2) stopped on the record page: no form opened, nothing posted, the page handed to a person",
      openedNoForm() && posts.length === 0 && r?.reachedReview === true && r?.continuedDraft?.applicationNumber === "NEM-90017",
      `hits=[${hits.join(",")}] posts=[${posts.join(",")}] reached=${r?.reachedReview}`);
  }

  // (3) signed: on to step 5, stop in front of its Submit.
  {
    step4PlannerClicks = 0;
    const { r, msg } = await resume({ record: record(sigCard("Signed")) });
    check("(3) record \"Signed\": read as signed on the record page",
      r?.signatureCheck?.state === "signed" && r?.signatureCheck?.where === "record", `check=${JSON.stringify(r?.signatureCheck)} ${msg}`);
    check("(3) the walk opened Part 2 and reached step 5's review",
      ["/rec/90017", "/p2/1", "/p2/4", "/p2/5"].every((p) => hits.includes(p)) && r?.reachedReview === true, `hits=[${hits.join(",")}] reached=${r?.reachedReview} ${msg}`);
    check("(3) nothing on the signature step was clicked: no preview, no Request Signatures, no re-staging",
      !hits.includes("/preview-doc") && !posts.includes("/request-signatures") && !r?.signatureStep && step4PlannerClicks === 0,
      `hits=[${hits.join(",")}] posts=[${posts.join(",")}] sig=${JSON.stringify(r?.signatureStep)?.slice(0, 120)}`);
    const steps = r?.steps ?? [];
    const finals = steps.filter((s) => s.isFinalSubmit === true);
    const last = steps[steps.length - 1];
    check("(3) step 5's Submit is the ONE final step, last, recorded and NOT clicked: 0 POSTs",
      finals.length === 1 && last?.isFinalSubmit === true && /NOT clicked/.test(String(last?.note)) && posts.length === 0 && r?.finalSubmitRecorded === true,
      `finals=${finals.length} posts=[${posts.join(",")}] last=${JSON.stringify(last).slice(0, 200)}`);
  }

  // (3b) PORTAL_ALLOW_FINAL_SUBMIT=1 alone (the gate refused the run, so no delegation reached it).
  {
    process.env.PORTAL_ALLOW_FINAL_SUBMIT = "1";
    try {
      const { r } = await resume({ record: record(sigCard("Signed")), allowFinalSubmit: false });
      check("(3b) PORTAL_ALLOW_FINAL_SUBMIT=1 without an approved run: the Submit is still not clicked (0 POSTs)",
        posts.length === 0 && r?.finalSubmitRecorded === true && hits.includes("/p2/5"), `posts=[${posts.join(",")}] hits=[${hits.join(",")}]`);
    } finally { delete process.env.PORTAL_ALLOW_FINAL_SUBMIT; }
  }

  // (4) unreadable: an unfamiliar status, and no status at all.
  {
    const { r, msg } = await resume({ record: record(sigCard("Processing")) });
    check("(4) record \"Processing\" (unfamiliar): awaiting customer signature, naming what it read; no form opened, 0 POSTs",
      r?.signatureCheck?.state === "awaiting_customer_signature" && r?.signatureCheck?.reading === "unreadable" && /"Processing"/.test(String(r?.signatureCheck?.why))
        && openedNoForm() && posts.length === 0,
      `check=${JSON.stringify(r?.signatureCheck)} hits=[${hits.join(",")}] ${msg}`);
    const none = await resume({ record: record("") });
    check("(4) a record with no signature status: awaiting customer signature, \"no signature status\"; no form opened",
      none.r?.signatureCheck?.state === "awaiting_customer_signature" && /no signature status/.test(String(none.r?.signatureCheck?.why)) && openedNoForm() && posts.length === 0,
      `check=${JSON.stringify(none.r?.signatureCheck)} hits=[${hits.join(",")}]`);
  }

  // (5) record signed, step 4 not.
  {
    const { r, msg } = await resume({ record: record(sigCard("Signed")), step4: step4("Signature Requested", true) });
    check("(5) record \"Signed\" but the signature step reads requested: stops there, awaiting, nothing clicked, step 5 never reached",
      r?.signatureCheck?.state === "awaiting_customer_signature" && r?.signatureCheck?.where === "signature step"
        && hits.includes("/p2/4") && !hits.includes("/p2/5") && posts.length === 0 && !hits.includes("/preview-doc"),
      `check=${JSON.stringify(r?.signatureCheck)} hits=[${hits.join(",")}] posts=[${posts.join(",")}] ${msg}`);
  }

  // (6) two signers, one not signed.
  {
    const table = `<div class="card"><div class="card-header">Signatures</div><table><thead><tr><th>Signer</th><th>Status</th></tr></thead><tbody>
      <tr><td>Account Holder</td><td>Signed</td></tr><tr><td>Co-Applicant</td><td>Requested</td></tr></tbody></table></div>`;
    const { r } = await resume({ record: record(table) });
    check("(6) two signers, one \"Requested\": not signed — stops on the record page, 0 POSTs",
      r?.signatureCheck?.state === "awaiting_customer_signature" && r?.signatureCheck?.statuses.join("|") === "Signed|Requested" && openedNoForm() && posts.length === 0,
      `check=${JSON.stringify(r?.signatureCheck)} hits=[${hits.join(",")}]`);
  }
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} signature-resume check(s) FAILED.`); process.exit(1); }
console.log("\nAll signature-resume checks passed (real Chromium).");
process.exit(0);
