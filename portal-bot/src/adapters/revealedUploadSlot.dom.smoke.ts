// AN UPLOAD SLOT THE PAGE'S OWN ANSWER REVEALS STILL GETS THE UPLOAD PASS (#529), IN REAL CHROMIUM.
//
// Live on PacifiCorp's PowerClerk NEM (2026-11-02): "Description of Service" shows its required
// "Upload a photo of meter where system will be interconnected" only after an answer on the same
// page. The upload pass ran at page entry (attached 0, missing 0), the page's fills ran, the
// re-scan logged the slot under revealed_controls — and no upload pass ran after that. The meter
// photo the project held was never attached, and nothing said the required slot was empty.
//
// A replica page: one select whose answer reveals (a beat later, as an AJAX render would) a
// required file input with accept=".pdf,.docx" whose change uploads (POST /UploadAttachment, as
// PowerClerk's uploader does), then Next to a review page.
//
//   [A] the project holds the meter photo (.jpg): it is attached as a PDF (the slot refuses the
//       image), the upload step is recorded after the answer that revealed the slot, and the
//       slot is not reported empty.
//   [B] the project holds no document at all: nothing is attached, and the hand-off names the
//       empty required meter-photo slot (it is never left blank silently).
//   [C] the project holds a plan set but no meter photo (#542): the split-mode substitute tier
//       used to file the PLAN SET into the required meter-photo slot and report nothing missing.
//       Now nothing is attached, no upload step is recorded, and the hand-off names the slot.
//   [D] the same page, but the revealed required slot is a generic "Plans" slot, and the project
//       holds only the plan set: the plan set IS still attached there (the fix must not over-refuse).
//
// Run: npx tsx portal-bot/src/adapters/revealedUploadSlot.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
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

const METER_LABEL = "Upload a photo of meter where system will be interconnected";
const serviceHtml = (slotLabel: string): string => `<h1>Description of Service</h1>
  <div class="form-group">
    <label for="where" class="control-label">Is the system interconnected at an existing meter? *</label>
    <select id="where" required>
      <option value="">--Select--</option>
      <option value="y">Yes</option>
      <option value="n">No</option>
    </select>
  </div>
  <div id="slot"></div>
  <button type="button" id="next" onclick="location.href='/review'">Next</button>
  <script>
    document.getElementById("where").addEventListener("change", function (ev) {
      if (ev.target.value !== "y" || document.getElementById("meter")) return;
      // Revealed a beat later, as PowerClerk's partial render does — never present at entry.
      setTimeout(function () {
        document.getElementById("slot").innerHTML =
          '<div class="form-group"><label for="meter" class="control-label">${slotLabel} *</label>' +
          '<input id="meter" type="file" accept=".docx, .pdf" required></div>';
        document.getElementById("meter").addEventListener("change", function (e2) {
          var fd = new FormData();
          fd.append("file", e2.target.files[0]);
          fetch("/UploadAttachment", { method: "POST", body: fd }).catch(function(){});
        });
      }, 400);
    });
  </script>`;

const REVIEW = `<h1>Review and Submit</h1>
  <p>Please review your application below before submitting. Once submitted, it cannot be changed.</p>
  <button type="button" id="submit" onclick="fetch('/SubmitApplication', {method:'POST', body:'x=1'}).catch(function(){});">Submit Application</button>`;

const uploads: Array<{ filename: string; isPdf: boolean }> = [];
const posts: string[] = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method !== "GET" && req.method !== "HEAD") {
    posts.push(`${req.method} ${url.pathname}`);
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (url.pathname === "/UploadAttachment") {
        const body = Buffer.concat(chunks).toString("latin1");
        uploads.push({ filename: /filename="([^"]*)"/.exec(body)?.[1] ?? "", isPdf: body.includes("%PDF-") });
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  const body = url.pathname === "/review" ? REVIEW : serviceHtml(url.pathname === "/service-plans" ? "Plans" : METER_LABEL);
  res.end(`<!doctype html><html><head><title>PowerClerk replica</title></head><body>${body}</body></html>`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zz-revealed-upload-"));
const meterPhoto = path.join(dir, "ZZTEST-meter-photo.jpg");
const planSet = path.join(dir, "ZZTEST-plan-set.pdf");
fs.writeFileSync(planSet, "%PDF-1.4\n% placeholder\n");

// The service page: answer the select "Yes" and advance by Next. The review page: declare review.
const plannerCalls: string[] = [];
const planner: LearnPlanner = async (req) => {
  plannerCalls.push(String(req.pageTitle ?? ""));
  if (req.fields.some((f) => /submit application/i.test(String(f.label ?? "")))) return { fills: [], atReview: true };
  const fills = req.fields.map((f, i) => ({ f, i }))
    .filter((x) => x.f.fieldType === "select" && !(req.alreadyFilledLabels ?? []).includes(String(x.f.label ?? "")))
    .map((x) => ({ selectorIndex: x.i, value: "Yes" }));
  const next = req.fields.findIndex((f) => f.fieldType === "button" && /^next$/i.test(String(f.label ?? "").trim()));
  return { fills, atReview: false, ...(next >= 0 ? { advanceSelectorIndex: next } : {}) };
};

const browser = await chromium.launch();
try {
  // A real JPEG for the meter photo (pdf-lib must be able to embed it): a screenshot, big
  // enough (> 4 KB) that Node's readFileSync hands pdf-lib its own buffer, not a pooled slice
  // — a real photo always is.
  {
    const p = await browser.newPage({ viewport: { width: 320, height: 240 } });
    await p.setContent("<body style='margin:0;height:240px;background:linear-gradient(45deg,#4a7,#a47,#47a)'>"
      + "<p style='font:20px serif'>ZZTEST meter photo placeholder 0123456789</p></body>");
    fs.writeFileSync(meterPhoto, await p.screenshot({ type: "jpeg", quality: 90 }));
    await p.close();
  }

  for (const which of ["A", "B", "C", "D"] as const) {
    console.log(which === "A" ? "\n[A] the project holds the meter photo (.jpg)"
      : which === "B" ? "\n[B] the project holds no document"
      : which === "C" ? "\n[C] the project holds a plan set but no meter photo (#542)"
      : "\n[D] a generic required \"Plans\" slot, plan set only: the substitute still applies");
    const servicePath = which === "D" ? "/service-plans" : "/service";
    const slotRe = which === "D" ? /\bplans\b/i : /photo of meter/i;
    const ctx = await browser.newContext();
    ctx.setDefaultTimeout(8000);
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await ctx.newPage();
    await page.goto(`${base}${servicePath}`);
    posts.length = 0;
    uploads.length = 0;
    const docsByType: Record<string, string> = which === "A" ? { meter_photo: meterPhoto, plan_set: planSet }
      : which === "C" || which === "D" ? { plan_set: planSet } : {};
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
      r = await adapter.learn({ portalUrl: `${base}${servicePath}` } as never,
        { projectAddress: "1 Test St, Springfield, IL, 62701", city: "Springfield", state: "IL", zip: "62701", homeownerName: "T" } as never);
    } catch (e) { threw = String(e).slice(0, 200); }
    await new Promise((res) => setTimeout(res, 800)); // let a late request land
    await ctx.close().catch(() => null);
    const msg = String(r?.message ?? threw);
    const steps = r?.steps ?? [];
    const uploadSteps = steps.filter((s) => s.action === "upload");
    const missing = r?.missingRequiredDocs ?? [];
    const uploadEvents = JSON.stringify(events.filter((e) => /^upload|revealed|image_to_pdf/.test(String(e.type))));
    if (process.env.SMOKE_VERBOSE === "1") console.log(uploadEvents);

    check("premise: the slot was NOT on the page when the entry upload pass ran",
      events.some((e) => e.type === "upload_phase_done" && e.page === 1 && e.pass === undefined && e.attached === 0 && e.missing === 0), uploadEvents);
    check("premise: the answer was recorded (select → Yes)",
      steps.some((s) => s.action === "select" || (s.action === "fill" && /exist/i.test(String(s.note ?? "")))), JSON.stringify(steps.map((s) => `${s.action}:${s.note ?? ""}`)));
    check("the revealed slot got an upload pass of its own",
      events.some((e) => e.type === "upload_revealed_slots" && slotRe.test(String(e.labels ?? ""))), uploadEvents);
    check("nothing was submitted (no POST /SubmitApplication)", !posts.some((p) => p.endsWith("/SubmitApplication")), `posts=[${posts.join(",")}]`);
    check("the run stopped at review", r?.reachedReview === true, `reachedReview=${r?.reachedReview} ${msg.slice(0, 300)}`);
    if (which === "A") {
      check("[A] the meter photo was attached — as a PDF, since the slot refuses an image",
        uploads.length === 1 && uploads[0].isPdf && /\.pdf$/i.test(uploads[0].filename), JSON.stringify(uploads));
      check("[A] the upload is recorded as a meter_photo step",
        uploadSteps.length === 1 && uploadSteps[0].docType === "meter_photo", JSON.stringify(uploadSteps));
      const answerAt = steps.findIndex((s) => s.action === "select" || s.action === "fill");
      const uploadAt = steps.findIndex((s) => s.action === "upload");
      check("[A] the upload step comes AFTER the answer that revealed the slot, so a replay meets it in order",
        answerAt >= 0 && uploadAt > answerAt, `answerAt=${answerAt} uploadAt=${uploadAt}`);
      check("[A] the meter-photo slot is not reported empty", !missing.some((m) => /photo of meter/i.test(m)), JSON.stringify(missing));
    } else if (which === "D") {
      check("[D] the plan set was attached to the generic Plans slot",
        uploads.length === 1 && /plan-set\.pdf$/i.test(uploads[0].filename), JSON.stringify(uploads));
      check("[D] …recorded as a plan_set upload step",
        uploadSteps.length === 1 && uploadSteps[0].docType === "plan_set", JSON.stringify(uploadSteps));
      check("[D] …and the Plans slot is not reported empty", !missing.some((m) => /\bplans\b/i.test(m)), JSON.stringify(missing));
    } else {
      check(`[${which}] nothing was attached${which === "C" ? " — the plan set is not filed into the meter-photo slot" : ""}`,
        uploads.length === 0 && uploadSteps.length === 0, `uploads=${JSON.stringify(uploads)} steps=${JSON.stringify(uploadSteps)}`);
      check(`[${which}] the hand-off names the empty required meter-photo slot`,
        missing.some((m) => /photo of meter/i.test(m)) && /photo of meter/i.test(msg), `missing=${JSON.stringify(missing)} ${msg.slice(0, 300)}`);
    }
  }
} finally {
  await browser.close().catch(() => null);
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
if (failures) { console.error(`\n${failures} revealed-upload-slot check(s) FAILED.`); process.exit(1); }
console.log("\nAll revealed-upload-slot checks passed (real Chromium).");
process.exit(0);
