// A TRACKED FILING GETS A STATUS LINK IT CAN READ ON ITS OWN (#413).
//
// Owner 2026-10-29 (project 7ddfbe48, Lincoln County BLD/ELE + a PacifiCorp NEM): "I would rather them
// be auto-updated vs having to check on them all the time." None of the three targets had a link —
// they predate #400 — so every sweep logged "no portal URL or recipe to read" and the cards never
// moved, and said nothing about why.
//
// The sweep is the real runDuePermitChecks over targets, recipes, clients and profiles written
// through the real writers; only the browser and the network are stubbed (setStatusCheckSeamsForTests).
//
//   MUST-PASS    a permit target with only a record number and a learned portal gets the record link
//                the signed-in read found as its tracking_url (session material stripped), and the
//                NEXT sweep reads that link anonymously, classifies the CapDetail text, and never
//                signs in
//   MUST-EXCLUDE a link on another host, or a utility link on a permit filing (rule 5), is refused and
//                audited; a target that already has a link never has it replaced; a link reported
//                beside a sign-in wall is never stored
//   MUST-PASS    at most one record-list lookup per target per day: a second sweep inside the day does
//                not sign in, and says why on the card; a day later it does
//   MUST-PASS    rule 6: the legacy profile read uses THIS project's client's stored session, never
//                another client's; a client with none gets no other client's
//   MUST-PASS    the card says why (read_gap): "No portal recipe learned for <utility>" on a NEM filing
//                with nothing learned; "Login wall" when the signed-in read met a sign-in page; nothing
//                once a status is read
//
// Run: npx tsx backend/test/statusLinkBackfill.test.ts
import "./_isolate"; // FIRST — generated files land in a temp cwd, never the repo's backend/data
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("status-link-backfill");
const { db, repo, recipes } = fx;
process.env.PORTAL_AUTOSEED = "1"; // the live install's mode: an empty read is skipped, not mocked
process.env.PORTAL_FEE_READ = "off"; // the fee reader has its own suite; never the network here
const clients = await import("../src/clients");

const ACA = "https://aca-test.accela.com/TESTCOUNTY";
const CAP = `${ACA}/Cap/CapDetail.aspx?Module=Building&TabName=Building&capID1=26TMP&capID2=00000&capID3=00451&agencyCode=TESTCOUNTY`;
const REVIEW = { action: "stopForReview", selector: {} } as never;
const fill = (i: number) => ({ action: "fill", selector: { name: `f${i}` }, field: "homeownerName", note: `Field ${i}` }) as never;

type ScrapeCall = { adapter: string; apps: string[]; storagePath?: string };
const scrapes: ScrapeCall[] = [];
const fetched: string[] = [];
let scrapeText: string | null = null;
let scrapeLink = "";
let publicText: string | null = null;
repo.setStatusCheckSeamsForTests({
  checkStatus: (async (adapter: string, apps: string[], opts: { onRecordLink?: (l: string) => void; onReason?: (r: string) => void; encryptedStorageStatePath?: string }) => {
    scrapes.push({ adapter, apps, storagePath: opts.encryptedStorageStatePath });
    if (scrapeText && scrapeLink) opts.onRecordLink?.(scrapeLink);
    if (!scrapeText) opts.onReason?.("the application number is not on \"My Records\" — read 2 list page(s)");
    return scrapeText;
  }) as never,
  publicCheck: (async (url: string) => { fetched.push(url); return publicText; }) as never,
});

const target = (projectId: string, input: { targetType: "permit" | "nem"; permitNumber?: string; applicationNumber?: string; trackingUrl?: string; permitType?: string }) => {
  repo.createPermitCheckTarget(db, projectId, { portalUrl: "", jurisdiction: "Testcounty", portalName: "", ...input } as never);
  const id = db.get<{ id: string }>("SELECT id FROM permit_check_targets WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", [projectId])!.id;
  if (input.trackingUrl) db.run("UPDATE permit_check_targets SET tracking_url = ? WHERE id = ?", [input.trackingUrl, id]);
  return id;
};
const row = (id: string) => db.get<{ tracking_url: string; read_gap: string; link_lookup_at: string | null; latest_outcome: string | null }>(
  "SELECT tracking_url, read_gap, link_lookup_at, latest_outcome FROM permit_check_targets WHERE id = ?", [id])!;
/** One sweep over exactly these targets. */
const sweep = async (...ids: string[]) => {
  db.run("UPDATE permit_check_targets SET active = 0");
  for (const t of ids) db.run("UPDATE permit_check_targets SET active = 1, next_check_at = NULL WHERE id = ?", [t]);
  scrapes.length = 0;
  fetched.length = 0;
  await repo.runDuePermitChecks(db, "all");
};
const audited = (action: string, targetId: string) => fx.audits(action).map((a) => JSON.parse(a.details)).filter((d) => d.targetId === targetId);

// The county's learned portal (an Accela tenant), written through the real recipe writers.
const county = recipes.startPortalRecording(db, { scopeType: "ahj", state: "OR", ahj: "Testcounty", portalUrl: `${ACA}/Login.aspx`, portalPlatform: "accela", createdBy: "test" });
recipes.savePortalRecipeSteps(db, county.id, [fill(1), fill(2), REVIEW], { status: "complete" });
const countyProject = () => fx.newProject({ ahj: "Testcounty", utility: "Nowhere Power Co" });

await check("(k1) MUST-PASS the signed-in read's record link becomes the tracking_url; the next sweep reads it anonymously", async () => {
  const t = target(countyProject(), { targetType: "permit", permitNumber: "519-26-001666-ELEC", permitType: "electrical" });
  scrapeText = "Date: 10/16/2026 | Record Number: 519-26-001666-ELEC | Status: In Review";
  scrapeLink = `${CAP}&ticket=SESSION-abc123&culture=en-US`;
  await sweep(t);
  assert.equal(scrapes.length, 1, "the signed-in read did not run");
  assert.equal(row(t).tracking_url, CAP, "the link was not stored, or kept session material");
  assert.equal(audited("permit_target.status_link_found", t).length, 1);
  assert.equal(row(t).read_gap, "", "a read status left a gap on the card");

  // The following sweep: the CapDetail page, read anonymously; no sign-in.
  publicText = "Record 519-26-001666-ELEC: Residential Electrical Record Status: Permit Issued Expiration Date: 04/16/2027";
  await sweep(t);
  publicText = null;
  assert.deepEqual(scrapes, [], "a permit filing with a status link still signed in");
  assert.deepEqual(fetched, [CAP], "the stored link was not the one read");
  assert.equal(row(t).latest_outcome, "issued", `CapDetail text classified as ${row(t).latest_outcome}`);
});

await check("(k2) MUST-EXCLUDE a link on another host, or a utility link on a permit filing, is refused and audited", async () => {
  for (const [n, link] of [["519-26-001670-STR", "https://aca-other.accela.com/TESTCOUNTY/Cap/CapDetail.aspx?capID1=1&capID2=2&capID3=3"],
    ["519-26-001671-STR", "https://pacificorpnetmetering.powerclerk.com/MvcProjects/EditProject?ProjectId=99"],
    ["519-26-001672-STR", `https://aca-test.accela.com/OTHERCOUNTY/Cap/CapDetail.aspx?capID1=1&capID2=2&capID3=3`]] as const) {
    const t = target(countyProject(), { targetType: "permit", permitNumber: n });
    scrapeText = `Record Number: ${n} | Status: In Review`;
    scrapeLink = link;
    await sweep(t);
    assert.equal(row(t).tracking_url, "", `${link} was stored on a permit filing`);
    assert.equal(audited("permit_target.status_link_refused", t).length, 1, `${link} refusal not audited`);
  }
});

await check("(k3) MUST-EXCLUDE a target that already has a link never has it replaced", async () => {
  const pasted = `${ACA}/Cap/CapDetail.aspx?Module=Building&capID1=26TMP&capID2=00000&capID3=00999`;
  const t = target(countyProject(), { targetType: "permit", permitNumber: "519-26-001680-STR", trackingUrl: pasted });
  publicText = null; // the pasted link reads nothing this time, so the signed-in read runs
  scrapeText = "Record Number: 519-26-001680-STR | Status: In Review";
  scrapeLink = CAP;
  await sweep(t);
  assert.equal(scrapes.length, 1, "the signed-in fallback did not run");
  assert.equal(row(t).tracking_url, pasted, "a pasted link was overwritten");
});

await check("(k4) MUST-EXCLUDE a link reported beside a sign-in wall is never stored", async () => {
  const t = target(countyProject(), { targetType: "permit", permitNumber: "519-26-001681-STR" });
  scrapeText = "Log in Username Password Forgot password? Register a new account";
  scrapeLink = CAP;
  await sweep(t);
  assert.equal(row(t).tracking_url, "");
  assert.match(row(t).read_gap, /^Login wall: aca-test\.accela\.com showed its sign-in page\. Link a portal login for Replay Trust Solar LLC on aca-test\.accela\.com, or record the status by hand\.$/);
});

await check("(k5) MUST-PASS at most one record-list lookup per target per day, and the card says so", async () => {
  const t = target(countyProject(), { targetType: "permit", permitNumber: "519-26-001690-STR" });
  scrapeText = null; // the account's list does not show it
  await sweep(t);
  assert.equal(scrapes.length, 1);
  assert.ok(row(t).link_lookup_at, "the lookup was not stamped");
  assert.match(row(t).read_gap, /not in the account's record list\. Paste the record link/);
  await sweep(t);
  assert.deepEqual(scrapes, [], "the record list was walked twice in a day");
  assert.match(row(t).read_gap, /already searched for this filing's link in the last day/);
  db.run("UPDATE permit_check_targets SET link_lookup_at = ? WHERE id = ?", [new Date(Date.now() - 25 * 3600_000).toISOString(), t]);
  await sweep(t);
  assert.equal(scrapes.length, 1, "a day later the lookup did not run again");
});

await check("(k6) MUST-PASS rule 6: the legacy profile read uses this client's session, never another client's", async () => {
  const other = clients.createClient(db, { companyName: "Other Solar Co", legalBusinessName: "Other Solar Co", businessEmail: "ops@other.test" } as never);
  const third = clients.createClient(db, { companyName: "Third Solar Co", legalBusinessName: "Third Solar Co", businessEmail: "ops@third.test" } as never);
  const profile = (clientId: string, state: string, at: string) => db.run(
    "INSERT INTO portal_profiles (id, client_id, portal_name, portal_type, encrypted_storage_state, created_at) VALUES (?, ?, 'Oregon ePermitting', 'accela_oregon', ?, ?)",
    [`pp-${state}`, clientId, state, at]);
  profile(fx.client.id, "/profiles/own.enc", "2026-10-01T00:00:00.000Z");
  profile(other.id, "/profiles/other.enc", "2026-10-30T00:00:00.000Z"); // NEWER: the old query took it
  scrapeText = null;
  const own = target(fx.newProject({ ahj: "Nowhere County", utility: "Nowhere Power Co" }), { targetType: "permit", permitNumber: "519-26-001700-STR" });
  await sweep(own);
  assert.deepEqual(scrapes.map((s) => s.storagePath), ["/profiles/own.enc"], `read with ${JSON.stringify(scrapes)}`);
  const pid = repo.createProject(db, { clientId: third.id, owner: "Third Owner", street: "9 Elm St", city: "Salem", state: "OR", zip: "97301", ahj: "Nowhere County", utility: "Nowhere Power Co" } as never).project.id;
  const theirs = target(pid, { targetType: "permit", permitNumber: "519-26-001701-STR" });
  await sweep(theirs);
  assert.deepEqual(scrapes, [], "a client with no profile was read with another client's session");
  db.run("DELETE FROM portal_profiles");
});

await check("(k7) MUST-PASS the card says why: no recipe learned for the utility; nothing once a status is read", async () => {
  const t = target(fx.newProject({ ahj: "Testcounty", utility: "Nowhere Power Co" }), { targetType: "nem", applicationNumber: "APP-120001", permitType: "nem" });
  await sweep(t);
  assert.deepEqual(scrapes, []);
  assert.equal(row(t).read_gap,
    "No portal recipe learned for Nowhere Power Co yet, and its record pages need a login, so the monitor cannot read this filing. Record the status by hand until the portal is learned.");
  const detail = repo.getProjectDetail(db, db.get<{ project_id: string }>("SELECT project_id FROM permit_check_targets WHERE id = ?", [t])!.project_id);
  assert.equal(detail.permitCheckTargets.find((x) => x.id === t)?.readGap, row(t).read_gap, "the card's target does not carry the line");
  // A status read clears it.
  db.run("UPDATE permit_check_targets SET tracking_url = 'https://nowhere-power.example/status/APP-120001' WHERE id = ?", [t]);
  publicText = "Application APP-120001 Status: Engineering Review";
  await sweep(t);
  publicText = null;
  assert.equal(row(t).read_gap, "", "a read status left the gap line on the card");
});

await check("(k8) MUST-PASS a filing with no number says to add one", async () => {
  const t = target(countyProject(), { targetType: "permit" });
  await sweep(t);
  assert.match(row(t).read_gap, /^No application or permit number on this filing yet\./);
});

repo.setStatusCheckSeamsForTests(null);
finish("statusLinkBackfill");
