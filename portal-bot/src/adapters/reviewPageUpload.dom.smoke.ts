// THE FINAL PAGE THAT READS AS REVIEW STILL GETS ITS ATTACHMENTS — ATTACH-ONLY (#383, hard rule 1).
//
// Live on PacifiCorp's PowerClerk NEM (2026-10-21): the attachments live on the LAST page, the
// one that also carries the review text, the terms box and Submit. The learner read it as review
// and logged upload_skipped_on_review, so "Upload a photo of meter where system will be
// interconnected" was never filled, though the project held the meter photo.
//
// The fix lets the upload pass run on such a page before the stop at review, attach-only: a
// native file input whose label names a document we hold, set directly. Nothing is clicked, no
// substitute document is filed, and the run still stops at review, naming what it left empty.
//
// A replica final page: review text, the terms box, a Submit that would POST /SubmitApplication,
// a required meter-photo file input whose change uploads (POST /UploadAttachment, as PowerClerk's
// uploader does), and a required "Browse" widget whose click would POST /BrowseClicked.
//
//   [A] the project holds the meter photo: it is attached (the ONLY non-GET that reaches the
//       server is the upload), the Browse widget is never clicked and is named in the hand-off,
//       nothing is submitted, and the run stops at review.
//   [B] the project holds NO meter photo (only the plan set): nothing is attached — the plan set
//       is never substituted — no non-GET reaches the server, the meter-photo slot is named in
//       the hand-off, and the run stops at review.
//
// Run: npx tsx portal-bot/src/adapters/reviewPageUpload.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// The walk reaches the final page from a form page, as the live run did (a review screen is a
// summary of what was ENTERED, so a page met before any entry is never read as one).
const P1 = `<h1>Step 1: Applicant</h1><form action="/final" method="get">
  <label for="a">Contact Name</label><input id="a" name="a">
  <button type="submit">Next</button></form>`;

const FINAL = `<h1>Review and Submit</h1>
  <p>Please review your application below before submitting. Once submitted, it cannot be changed.</p>
  <h3>Attachments</h3>
  <div class="form-group">
    <label for="meter" class="control-label">Upload a photo of meter where system will be interconnected *</label>
    <input id="meter" type="file" required>
  </div>
  <div class="form-group">
    <label class="control-label">Single-line diagram *</label>
    <button type="button" id="browse" onclick="fetch('/BrowseClicked', {method:'POST', body:'x=1'}).catch(function(){});">Browse</button>
  </div>
  <div class="form-group">
    <label for="terms">I agree to the terms and conditions</label><input id="terms" type="checkbox">
  </div>
  <button type="button" id="submit" onclick="fetch('/SubmitApplication', {method:'POST', body:'x=1'}).catch(function(){});">Submit Application</button>
  <script>
    document.getElementById("meter").addEventListener("change", function (ev) {
      var fd = new FormData();
      fd.append("file", ev.target.files[0]);
      fetch("/UploadAttachment", { method: "POST", body: fd }).catch(function(){});
    });
  </script>`;

const posts: string[] = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method !== "GET" && req.method !== "HEAD") {
    posts.push(`${req.method} ${url.pathname}`);
    req.resume();
    req.on("end", () => { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); });
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><html><head><title>PowerClerk replica</title></head><body>${url.pathname === "/final" ? FINAL : P1}</body></html>`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zz-review-upload-"));
const meterPhoto = path.join(dir, "ZZTEST-meter-photo.jpg");
fs.writeFileSync(meterPhoto, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]));
const planSet = path.join(dir, "ZZTEST-plan-set.pdf");
fs.writeFileSync(planSet, "%PDF-1.4\n% placeholder\n");

// Page 1: fill the text box and advance by Next. The final page: declare review, fill nothing
// (the review stop is the planner's; the upload pass is the learner's own).
const planner: LearnPlanner = async (req) => {
  const atReview = req.fields.some((f) => f.fieldType === "file" || /submit application/i.test(String(f.label ?? "")));
  if (atReview) return { fills: [], atReview: true };
  const fills = req.fields.map((f, i) => ({ f, i })).filter((x) => x.f.fieldType === "text").map((x) => ({ selectorIndex: x.i, value: "ZZ Test" }));
  const next = req.fields.findIndex((f) => f.fieldType === "button" && /^next$/i.test(String(f.label ?? "").trim()));
  return { fills, atReview: false, ...(next >= 0 ? { advanceSelectorIndex: next } : {}) };
};

const browser = await chromium.launch();
try {
  for (const which of ["A", "B"] as const) {
    console.log(which === "A" ? "\n[A] the project holds the meter photo" : "\n[B] the project holds no meter photo (plan set only)");
    const ctx = await browser.newContext();
    ctx.setDefaultTimeout(8000);
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await ctx.newPage();
    await page.goto(`${base}/p1`);
    posts.length = 0;
    const docsByType: Record<string, string> = which === "A" ? { meter_photo: meterPhoto, plan_set: planSet } : { plan_set: planSet };
    const adapter = new AutoLearnAdapter("PowerClerk Replica", planner, { maxPages: 4, docsByType });
    const events: Array<Record<string, unknown>> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).page = page;
    const holder = adapter as unknown as { debug?: { event: (e: Record<string, unknown>) => void } };
    if (holder.debug && typeof holder.debug.event === "function") {
      const orig = holder.debug.event.bind(holder.debug);
      holder.debug.event = (e) => { events.push(e); orig(e); };
    } else holder.debug = { event: (e) => { events.push(e); } };
    let r: Awaited<ReturnType<AutoLearnAdapter["learn"]>> | null = null;
    let threw = "";
    try {
      r = await adapter.learn({ portalUrl: `${base}/p1` } as never,
        { projectAddress: "1 Test St, Springfield, IL, 62701", city: "Springfield", state: "IL", zip: "62701", homeownerName: "T" } as never);
    } catch (e) { threw = String(e).slice(0, 200); }
    // Let any late request land before reading what reached the server.
    await new Promise((res) => setTimeout(res, 800));
    const inputHolds = await page.evaluate(() => (document.getElementById("meter") as HTMLInputElement | null)?.files?.length ?? 0).catch(() => -1);
    await ctx.close().catch(() => null);
    const msg = String(r?.message ?? threw);
    const uploads = (r?.steps ?? []).filter((s) => s.action === "upload");
    const missing = r?.missingRequiredDocs ?? [];

    check("premise: the upload pass ran on the review page, attach-only",
      events.some((e) => e.type === "upload_phase_start" && e.attachOnly === true), JSON.stringify(events.filter((e) => /^upload/.test(String(e.type)))));
    check("nothing was submitted: no POST /SubmitApplication, no step recorded or clicked as the final submit",
      !posts.some((p) => p.endsWith("/SubmitApplication")) && !(r?.steps ?? []).some((s) => s.isFinalSubmit === true && /final submit: .*\(clicked/i.test(String(s.note ?? ""))),
      `posts=[${posts.join(",")}]`);
    check("the custom Browse widget was never clicked (no POST /BrowseClicked)", !posts.some((p) => p.endsWith("/BrowseClicked")), `posts=[${posts.join(",")}]`);
    check("the run stopped at review", r?.reachedReview === true && /reached the review screen/.test(msg), `reachedReview=${r?.reachedReview} ${msg.slice(0, 300)}`);
    check("the hand-off names the Browse slot it left for a person",
      missing.some((m) => /single-line diagram/i.test(m)) && /single-line diagram/i.test(msg), `missing=${JSON.stringify(missing)}`);
    if (which === "A") {
      check("[A] the meter photo was attached and recorded as an upload step",
        inputHolds === 1 && uploads.length === 1 && uploads[0].docType === "meter_photo", `inputHolds=${inputHolds} uploads=${JSON.stringify(uploads)}`);
      check("[A] the ONLY non-GET that reached the server is the upload itself",
        posts.length === 1 && posts[0] === "POST /UploadAttachment", `posts=[${posts.join(",")}]`);
      check("[A] the meter-photo slot is not reported empty", !missing.some((m) => /photo of meter/i.test(m)), JSON.stringify(missing));
    } else {
      check("[B] nothing was attached — the plan set was never substituted into the meter-photo slot",
        inputHolds === 0 && uploads.length === 0, `inputHolds=${inputHolds} uploads=${JSON.stringify(uploads)}`);
      check("[B] no non-GET reached the server", posts.length === 0, `posts=[${posts.join(",")}]`);
      check("[B] the hand-off names the empty meter-photo slot",
        missing.some((m) => /photo of meter/i.test(m)) && /photo of meter/i.test(msg), `missing=${JSON.stringify(missing)} ${msg.slice(0, 300)}`);
    }
  }
} finally {
  await browser.close().catch(() => null);
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
if (failures) { console.error(`\n${failures} review-page-upload check(s) FAILED.`); process.exit(1); }
console.log("\nAll review-page-upload checks passed (real Chromium).");
process.exit(0);
