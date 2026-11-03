// A STALE PER-JOB PERMIT-PROCESS LOOKUP CAN BE REFRESHED OR VERIFIED BY A PERSON (#560).
//
// Saratoga Springs, UT's lookup cited the city's retired solar PDF (a 404) for its documents list, and
// nothing could correct it: a complete seeded row was never re-run, the job never passed `force`, a
// re-run that found nothing kept the dead list, the reference seed lost a same-day tie and replaced
// only its own permit, and QC counted the city form as missing while it was a page of the plan set.
//
// Pinned (synthetic AHJs, saved pages, no network, stub / throwing model):
//   A  a documents list cited to a page that 404s is refused as evidence (end to end, one read);
//   B  a forced re-run never CARRIES an earlier list whose cited page is gone now; a re-run without
//      `force` over a complete seeded row still asks nothing (status quo);
//   C  a person's refresh reaches the lookup WITH `force` (the job asks the model over a complete
//      seeded row); a verified row is refused (rule 3) and so is a run with no model key;
//   D  a named person verifies the row as it stands, or replaces its permits; a blank name writes
//      nothing; research never overwrites the verified row;
//   E  the reference seed's tie compares like with like, wins a same-day tie, and replaces every
//      runtime permit's documents list; a reboot writes nothing;
//   F  QC's required list counts the AHJ's own form as present when it is a page of the plan set —
//      never a cover sheet's index, another city's form, or a form with no plan-set file.
//
//   npx tsx backend/test/permitProcessRefresh.test.ts
import "./_isolate"; // FIRST
import { REPO } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectRecord, WebLookupResult } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pp-refresh-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.BACKUP_DIR = path.join(tmp, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmp, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(tmp, "profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.CODE_RESEARCH = "off";
process.env.SKIP_CODE_RESEARCH = "1";
process.env.DOCUMENT_FETCH = "off";
process.env.AHJ_FORM_DOWNLOADS = "off";
process.env.PORTAL_AUTOMATION = "off";
process.env.PERMIT_PROCESS_LOOKUP = "off";
process.env.ANTHROPIC_API_KEY = "";
delete process.env.SMTP_HOST;

const db = await (await import("../src/db")).openDatabase();
const reader = await import("../src/agencyPageReader");
const ppl = await import("../src/permitProcessLookup");
const pp = await import("../src/permitProcess");
const kb = await import("../src/knowledgeBase");
const rd = await import("../src/requiredDocuments");
const jobQueue = await import("../src/jobQueue");
clearInterval(jobQueue.startJobWorker(db));

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};
const g = (text: string, urls: string[]): WebLookupResult => ({ text, groundedSearches: 3, searches: 3, stopReason: "end_turn", resultUrls: urls, pagesRead: 0 });
/** A fake transport over saved pages; anything not listed is a 404. Records every request. */
function site(pages: Record<string, string>) {
  const requests: string[] = [];
  const fetch: import("../src/agencyPageReader").RawFetch = async (url) => {
    requests.push(url);
    const text = pages[url];
    if (text == null) return { ok: false, status: 404, contentType: "text/html", finalUrl: url, reason: "HTTP 404" };
    return { ok: true, status: 200, contentType: "text/html", text, bytes: new TextEncoder().encode(text), finalUrl: url, reason: "HTTP 200" };
  };
  return { fetch, requests };
}
const newReader = (fetch: import("../src/agencyPageReader").RawFetch) => { reader._resetPoliteness(); return reader.createPageReader({ fetch, minGapMs: 0, maxReads: 20 }); };
const html = (body: string) => `<html><head><title>Building</title></head><body><main>${body}</main></body></html>`;

const processPart = (city: string, PG: string) => JSON.stringify({
  issuingAgency: { value: city, sourceUrl: PG, quote: `The ${city} Building Department issues building permits.` },
  permitStructure: { value: null },
  permits: [{ discipline: "combo", label: "Residential solar", issuingAgency: { value: city, sourceUrl: PG, quote: `The ${city} Building Department issues building permits.` }, portalUrl: { value: null }, recordType: { value: null } }],
});
const docsPart = (url: string | null, items: string[] | null) => JSON.stringify({ permits: [{ discipline: "combo",
  documents: items ? { value: items, sourceUrl: url, quote: "Submit 2 plan sets and a disk with the solar application." } : { value: null, notFound: "no page lists the documents" },
  fee: { value: null } }] });
const llmFor = (city: string, PG: string, docs: { url: string | null; items: string[] | null }) => ({
  webLookup: async (i: { label: string }) => {
    if (i.label.endsWith(".process")) return g(processPart(city, PG), [PG]);
    if (i.label.endsWith(".documentsFees")) return g(docsPart(docs.url, docs.items), docs.url ? [docs.url] : [PG]);
    return g(JSON.stringify({ permits: [] }), [PG]);
  },
});
const combo = (lk: { permits: Array<{ discipline: string; documents: { value: unknown; notFound?: string } }> } | null) => lk!.permits.find((p) => p.discipline === "combo")!;

console.log("permit-process refresh / verify (#560)");

// ── A: a citation that 404s is not evidence ─────────────────────────────────────────────────
await check("A1 unit: a documents list cited to a page known gone is refused, with the reason; the same list on a live page is kept", () => {
  const DEAD = "https://www.wellscity-ut.gov/DocumentCenter/View/152";
  const parsed = (gone: string[]) => ppl.parseDocsFeesPart(docsPart(DEAD, ["2 plan sets", "a disk"]), [DEAD], "end_turn", new Map(), gone).byDiscipline.get("combo")!.documents;
  assert.equal(parsed([ppl.pageKey(DEAD)]).value, null, "gone -> not kept");
  assert.match(String(parsed([ppl.pageKey(DEAD)]).notFound), /no longer there/);
  assert.deepEqual(parsed([]).value, ["2 plan sets", "a disk"], "not known gone -> kept");
});

await check("A2 end to end: the lookup reads a cited documents page it has not read, finds a 404, and does not keep the list", async () => {
  const PG = "https://www.wellscity-ut.gov/220/Obtaining-a-Building-Permit";
  const DEAD = "https://www.wellscity-ut.gov/DocumentCenter/View/152";
  const s = site({ [PG]: html("<p>The City of Wells Crossing Building Department issues building permits.</p>") });
  const run = await ppl.runPermitProcessLookup(db, llmFor("City of Wells Crossing", PG, { url: DEAD, items: ["2 plan sets", "a disk"] }),
    { state: "UT", ahj: "City of Wells Crossing", force: true, reader: newReader(s.fetch) });
  assert.ok(run.saved, run.reason);
  const docs = combo(run.lookup).documents;
  assert.equal(docs.value, null, `the dead list was kept: ${JSON.stringify(docs)}`);
  assert.match(String(docs.notFound), /no longer there/);
  assert.ok(s.requests.includes(DEAD), "the cited page was read once");
});

// ── B: a re-run never carries an earlier list whose page is gone ───────────────────────────────
const seededRow = (ahj: string, url: string, items: string[]) => pp.savePermitProcessLookup(db, {
  state: "UT", ahj, lookedUpAt: "2026-10-06T15:00:00.000Z", model: "test-model",
  issuingAgency: { value: ahj, sourceUrl: url, quote: `${ahj} issues building permits`, origin: "lookup" },
  permitStructure: { value: "combo", sourceUrl: url, quote: "one combination permit", origin: "lookup" },
  permits: [{ discipline: "combo", label: "Residential solar",
    issuingAgency: { value: ahj, sourceUrl: url, quote: `${ahj} issues building permits`, origin: "lookup" },
    portalUrl: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "no portal named" },
    recordType: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "none" },
    documents: { value: items, sourceUrl: url, quote: "Submit 2 plan sets and a disk.", origin: "lookup" },
    fee: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "none" } }],
});

await check("B1 status quo: without `force`, a complete seeded row is not re-run (no model call)", async () => {
  seededRow("City of Ferndale Flats", "https://www.ferndaleflats-ut.gov/DocumentCenter/View/152", ["2 plan sets", "a disk"]);
  let asks = 0;
  const run = await ppl.runPermitProcessLookup(db, { webLookup: async () => { asks++; return g("{}", []); } }, { state: "UT", ahj: "City of Ferndale Flats", reader: null });
  assert.equal(run.saved, false);
  assert.match(run.reason, /already looked up/);
  assert.equal(asks, 0);
});

await check("B2 a forced re-run that finds no list does NOT carry the earlier list cited to a page that 404s now (it read that page once)", async () => {
  const PG = "https://www.ferndaleflats-ut.gov/220/Obtaining-a-Building-Permit";
  const DEAD = "https://www.ferndaleflats-ut.gov/DocumentCenter/View/152";
  const s = site({ [PG]: html("<p>The City of Ferndale Flats Building Department issues building permits.</p>") });
  const run = await ppl.runPermitProcessLookup(db, llmFor("City of Ferndale Flats", PG, { url: null, items: null }),
    { state: "UT", ahj: "City of Ferndale Flats", force: true, reader: newReader(s.fetch) });
  assert.ok(run.saved, run.reason);
  const docs = combo(run.lookup).documents;
  assert.equal(docs.value, null, `the dead list was carried: ${JSON.stringify(docs)}`);
  assert.match(String(docs.notFound), /no longer there/);
  assert.ok(s.requests.includes(DEAD), "the earlier citation was checked");
  assert.equal(combo(run.lookup).documents.value, null);
});

await check("B3 MUST-PASS: an earlier list whose page still answers is carried as before", async () => {
  const PG = "https://www.alderflats-ut.gov/220/Obtaining-a-Building-Permit";
  const LIVE = "https://www.alderflats-ut.gov/230/Solar-Checklist";
  seededRow("City of Alder Flats", LIVE, ["Plan set", "Site plan"]);
  const s = site({ [PG]: html("<p>The City of Alder Flats Building Department issues building permits.</p>"), [LIVE]: html("<p>Solar checklist: plan set, site plan.</p>") });
  const run = await ppl.runPermitProcessLookup(db, llmFor("City of Alder Flats", PG, { url: null, items: null }),
    { state: "UT", ahj: "City of Alder Flats", force: true, reader: newReader(s.fetch) });
  assert.deepEqual(combo(run.lookup).documents.value, ["Plan set", "Site plan"]);
});

// ── C: a person's refresh reaches the lookup with `force` ─────────────────────────────────────
await check("C1 refresh is refused while no model key is set (it could only fail), and for a verified row (rule 3)", async () => {
  const off = await ppl.queueProcessLookupRefresh(db, { id: "p-none", state: "UT", ahj: "City of Ferndale Flats" }, "Pat Synthetic");
  assert.equal(off.queued, false);
  assert.equal(off.status, 503);
  pp.savePermitProcessLookup(db, { ...(pp.getPermitProcessLookup(db, "UT", "City of Alder Flats")!), confidence: "verified" }, { verifiedBy: "Pat Synthetic" });
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
  delete process.env.PERMIT_PROCESS_LOOKUP;
  try {
    const verified = await ppl.queueProcessLookupRefresh(db, { id: "p-none", state: "UT", ahj: "City of Alder Flats" }, "Pat Synthetic");
    assert.equal(verified.queued, false);
    assert.equal(verified.status, 409);
    assert.match(verified.reason, /never overwrites/);
  } finally {
    process.env.ANTHROPIC_API_KEY = "";
    process.env.PERMIT_PROCESS_LOOKUP = "off";
  }
});

await check("C2 the refresh job runs the lookup WITH `force`: over a complete seeded row the model is asked (the job used to stop at 'already looked up')", async () => {
  const { ClaudeLLMProvider } = await import("../src/llm");
  const real = ClaudeLLMProvider.prototype.webLookup;
  let asks = 0;
  ClaudeLLMProvider.prototype.webLookup = async function () { asks++; throw new Error("stub: no network in tests"); };
  seededRow("City of Juniper Bench", "https://www.juniperbench-ut.gov/DocumentCenter/View/152", ["2 plan sets"]);
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
  delete process.env.PERMIT_PROCESS_LOOKUP;
  try {
    db.run("UPDATE job_queue SET status = 'failed', error = 'parked by test' WHERE status = 'pending'");
    const r = await ppl.queueProcessLookupRefresh(db, { id: "p-none", state: "UT", ahj: "City of Juniper Bench" }, "Pat Synthetic");
    assert.equal(r.queued, true, r.reason);
    assert.equal(r.status, 202);
    const again = await ppl.queueProcessLookupRefresh(db, { id: "p-none", state: "UT", ahj: "City of Juniper Bench" }, "Pat Synthetic");
    assert.equal(again.jobId, r.jobId, "a second request while one is pending is the same job");
    const payload = JSON.parse(String(db.get<{ payload: string }>("SELECT payload FROM job_queue WHERE id = ?", [r.jobId!])?.payload));
    assert.equal(payload.force, "1");
    assert.ok(await jobQueue.processNextJob(db), "the worker ran the job");
    assert.ok(asks >= 1, `the forced lookup asked the model ${asks} time(s)`);
  } finally {
    ClaudeLLMProvider.prototype.webLookup = real;
    process.env.ANTHROPIC_API_KEY = "";
    process.env.PERMIT_PROCESS_LOOKUP = "off";
  }
});

// ── D: a named person verifies or replaces ──────────────────────────────────────────────────
await check("D1 a blank name writes nothing; a named person verifies the row as it stands", () => {
  const blank = pp.verifyPermitProcessLookup(db, { state: "UT", ahj: "City of Juniper Bench" }, { verifiedBy: "   " });
  assert.equal(blank.saved, false);
  assert.equal(pp.getPermitProcessLookup(db, "UT", "City of Juniper Bench")!.confidence, "seeded");
  const r = pp.verifyPermitProcessLookup(db, { state: "UT", ahj: "City of Juniper Bench" }, { verifiedBy: "Pat Synthetic" });
  assert.ok(r.saved, r.reason);
  const lk = pp.getPermitProcessLookup(db, "UT", "City of Juniper Bench")!;
  assert.equal(lk.confidence, "verified");
  assert.equal(lk.verifiedBy, "Pat Synthetic");
  assert.deepEqual(combo(lk).documents.value, ["2 plan sets"], "verified as it stood");
  assert.ok((lk.notes ?? []).some((n) => /Verified by Pat Synthetic .* as it stood/.test(n)));
});

await check("D2 a named person replaces the permits: the stated list lands (origin operator), unlisted permits are dropped, the rest is carried", () => {
  seededRow("City of Quail Hollow", "https://www.quailhollow-ut.gov/DocumentCenter/View/152", ["2 plan sets", "a disk", "2014 NEC"]);
  const LIVE = "https://www.quailhollow-ut.gov/220/Obtaining-a-Building-Permit";
  const bad = pp.verifyPermitProcessLookup(db, { state: "UT", ahj: "City of Quail Hollow" }, { verifiedBy: "Pat Synthetic", permits: [{ discipline: "combo", documents: { value: ["Plans"], sourceUrl: "not a url" } }] });
  assert.equal(bad.saved, false, "a fact without its page is refused");
  const r = pp.verifyPermitProcessLookup(db, { state: "UT", ahj: "City of Quail Hollow" }, {
    verifiedBy: "Pat Synthetic",
    permits: [{ discipline: "combo", documents: { value: ["Plans and specifications", "Digital copy via the portal"], sourceUrl: LIVE, quote: "Plans and specification are required with all applications." } }],
  });
  assert.ok(r.saved, r.reason);
  const lk = pp.getPermitProcessLookup(db, "UT", "City of Quail Hollow")!;
  assert.equal(lk.confidence, "verified");
  const docs = combo(lk).documents as { value: string[]; sourceUrl: string; origin: string };
  assert.deepEqual(docs.value, ["Plans and specifications", "Digital copy via the portal"]);
  assert.equal(docs.sourceUrl, LIVE);
  assert.equal(docs.origin, "operator");
  assert.equal((combo(lk) as unknown as { issuingAgency: { value: string } }).issuingAgency.value, "City of Quail Hollow", "carried");
  assert.deepEqual(rd.lookupRequiredList({ state: "UT", ahj: "City of Quail Hollow" }).items, ["Plans and specifications", "Digital copy via the portal"]);
});

await check("D3 research never overwrites the verified row (rule 3), forced or not", async () => {
  let asks = 0;
  const run = await ppl.runPermitProcessLookup(db, { webLookup: async () => { asks++; return g("{}", []); } }, { state: "UT", ahj: "City of Quail Hollow", force: true, reader: null });
  assert.equal(run.saved, false);
  assert.match(run.reason, /verified/);
  assert.equal(asks, 0);
});

// ── E: the reference seed's tie rule and coverage ─────────────────────────────────────────────
await check("E1 runtimeRowIsNewer compares like with like: a same-day date is a tie the reference wins; a later day, or a timestamp on/after, wins for the runtime row", () => {
  assert.equal(kb.runtimeRowIsNewer("2026-10-06T15:00:00.000Z", "2026-10-06"), false, "same day: the reference wins");
  assert.equal(kb.runtimeRowIsNewer("2026-10-07T00:00:01.000Z", "2026-10-06"), true);
  assert.equal(kb.runtimeRowIsNewer("2026-10-05T23:59:59.000Z", "2026-10-06"), false);
  assert.equal(kb.runtimeRowIsNewer("2026-10-06T15:00:00.000Z", "2026-10-06T14:00:00.000Z"), true);
  assert.equal(kb.runtimeRowIsNewer("2026-10-06T13:00:00.000Z", "2026-10-06T14:00:00.000Z"), false);
  assert.equal(kb.runtimeRowIsNewer("2026-10-06T13:00:00.000Z", "not a date"), true, "an unreadable observedAt never overwrites");
});

await check("E2 Saratoga Springs (reference read 2026-10-06): a runtime row saved that same day takes the reference's list, and its own stale list is superseded on every permit; a reboot writes nothing", async () => {
  const ref = JSON.parse(fs.readFileSync(path.join(REPO, "backend", "data", "reference-ahj-processes.json"), "utf8")) as { profiles: Array<{ state: string; ahj: string; documents?: { items: string[]; sourceUrl: string; observedAt: string } }> };
  const prof = ref.profiles.find((p) => /Saratoga Springs/.test(p.ahj) && p.state === "UT");
  assert.ok(prof?.documents, "fixture: the reference row carries a documents list");
  const day = prof!.documents!.observedAt;
  seededRow(prof!.ahj, "https://www.saratogasprings-ut.gov/DocumentCenter/View/152", ["2 plan sets", "a disk", "2014 NEC / 2015 I-codes"]);
  db.run("UPDATE permit_process_lookups SET updated_at = ? WHERE profile_key = ?", [`${day}T18:30:00.000Z`, pp.permitProcessKey("UT", prof!.ahj)]);
  kb.seedInitialKnowledgeBase(db);
  const lk = pp.getPermitProcessLookup(db, "UT", prof!.ahj)!;
  assert.equal(lk.model, "test-model", "the runtime row is kept (its agency, portal, fee), not replaced");
  assert.deepEqual(lk.permits.map((p) => p.label), ["Residential solar", kb.REFERENCE_CHECKLIST_LABEL]);
  assert.equal(combo(lk).documents.value, null, "the stale runtime list is superseded");
  assert.match(String(combo(lk).documents.notFound), /superseded by .*published checklist/);
  assert.deepEqual(rd.lookupRequiredList({ state: "UT", ahj: prof!.ahj }).items, prof!.documents!.items);
  const before = db.get<{ payload_json: string; updated_at: string }>("SELECT payload_json, updated_at FROM permit_process_lookups WHERE profile_key = ?", [pp.permitProcessKey("UT", prof!.ahj)])!;
  kb.seedInitialKnowledgeBase(db);
  const after = db.get<{ payload_json: string; updated_at: string }>("SELECT payload_json, updated_at FROM permit_process_lookups WHERE profile_key = ?", [pp.permitProcessKey("UT", prof!.ahj)])!;
  assert.equal(after.updated_at, before.updated_at, "a reboot rewrites nothing");
  assert.equal(after.payload_json, before.payload_json);
});

// ── F: the AHJ's own form as a page of the plan set ───────────────────────────────────────────
await check("F1 the AHJ's own form bound into the plan set counts as present (advisory list row); a cover-sheet index, another city's form, or no plan-set file does not", () => {
  const formPage = "CITY OF QUAIL HOLLOW BUILDING PERMIT APPLICATION  Job Address: ____  Property Owner: ____  Contractor: ____  License No.: ____  Valuation: ____  Applicant Signature: ____ Date: ____";
  const cover = "COVER SHEET  SHEET NO. PV-1  City of Quail Hollow  Sheet index: PV-1 cover, PV-2 site plan, building permit application  Owner name: ____ Contractor: ____ Phone ____ Signature ____";
  const otherCity = "CITY OF ELK BENCH BUILDING PERMIT APPLICATION  Job Address  Property Owner  Contractor  License No.  Applicant Signature";
  const project = (text: string): ProjectRecord => ({ id: "p-f", state: "UT", ahj: "City of Quail Hollow", parserSnapshot: { planSetExtractedText: text } } as unknown as ProjectRecord);
  const slots = ["building_application", "permit_application"];
  assert.equal(rd.formPageInPlanSet(project(`PV-1 SITE PLAN scale: 1/8\n${formPage}\nPV-3 SLD`), slots, { plan_set: "/x/plan.pdf" }), true, "the form page");
  assert.equal(rd.formPageInPlanSet(project(cover), slots, { plan_set: "/x/plan.pdf" }), false, "a cover sheet's index");
  assert.equal(rd.formPageInPlanSet(project(otherCity), slots, { plan_set: "/x/plan.pdf" }), false, "another city's form");
  assert.equal(rd.formPageInPlanSet(project(formPage), slots, {}), false, "no plan-set file");
  assert.equal(rd.formPageInPlanSet(project(formPage), ["electrical_application"], { plan_set: "/x/plan.pdf" }), false, "a building form is not the electrical application");
});

await check("F2 QC's required list: the city form inside the plan set is not counted missing", async () => {
  const { createClient } = await import("../src/clients");
  const { createProject, getProjectDetail } = await import("../src/repository");
  const { saveProjectDocument } = await import("../src/projectDocuments");
  // The verified Quail Hollow row (D2) names two documents; add the city's form to it.
  pp.verifyPermitProcessLookup(db, { state: "UT", ahj: "City of Quail Hollow" }, {
    verifiedBy: "Pat Synthetic",
    permits: [{ discipline: "combo", documents: { value: ["Plans and specifications", "City of Quail Hollow building permit application"], sourceUrl: "https://www.quailhollow-ut.gov/220/Obtaining-a-Building-Permit" } }],
  });
  const client = createClient(db, { companyName: "Refresh Test Solar", ccbLicenseNumber: "560560" });
  const d = createProject(db, { clientId: client.id, owner: "Synthetic Owner", street: "1 Test Way", city: "Quail Hollow", state: "UT", zip: "99999", ahj: "City of Quail Hollow", utility: "Synthetic Power" } as never);
  db.run("UPDATE job_queue SET status = 'failed', error = 'parked by test' WHERE status = 'pending'");
  const doc = saveProjectDocument(db, d.project.id, { docType: "plan_set", filename: "plan.pdf", contentType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% plan\n"), source: "upload" });
  const formPage = "CITY OF QUAIL HOLLOW BUILDING PERMIT APPLICATION  Job Address: ____  Property Owner: ____  Contractor: ____  License No.: ____  Applicant Signature: ____";
  db.run("UPDATE project_documents SET extracted_text = ? WHERE id = ?", [`PV-1 SITE PLAN scale: 1/8\n${formPage}`, (doc as { id: string }).id]);
  const project = getProjectDetail(db, d.project.id).project;
  const list = rd.requiredListCheck(db, project, rd.documentInventory(db, project));
  const form = list.items.find((i) => /building permit application/i.test(i.text));
  assert.ok(form, JSON.stringify(list.items));
  assert.equal(form!.present, true, JSON.stringify(form));
  assert.equal(form!.via, "a page of the plan set");
  assert.ok(!list.missing.some((m) => /building permit application/i.test(m.text)), "not counted missing");
});

db.close();
if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\npermitProcessRefresh: all checks passed");
process.exit(0);
