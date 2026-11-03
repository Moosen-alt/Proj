// A CLIENT'S PORTAL IDENTITY APPLIES ONLY ON THE PORTAL IT NAMES (#518).
//
// A portal identity row says what this client is called on ONE portal account (PowerClerk's
// "Installer Company" label) and that account's existing-contact code. Staging keyed the lookup on
// `portalProfile?.portal_type ?? "mock"`, and nothing writes portal_profiles, so every real run asked
// for "mock": a row keyed to a real portal never matched, and a row keyed "mock" matched every portal
// there is — another account's contact code included. On a shared filing account that is a filing
// under the wrong contact.
//
// Pinned:
//   (K)  portalIdentityKey: a URL names its portal by host; another PowerClerk tenant names none;
//        "utility" / "AHJ" / "" name none; "mock" is the mock portal.
//   (R)  stagingIdentityPortal: URLs that disagree name none; no URL and no profile is "mock".
//   (D)  stagingIdentityDisagreement names the hosts (never a full URL) when the URLs disagree, and
//        nothing when they agree — what prepareSubmission logs (Helm review of #527, carried by #524).
//   (A/B) clientStagingOverlay: the PGE row is used on PGE (label + contact) and NOT on another
//        PowerClerk tenant (legal name, no contact); the Accela row only on Oregon ePermitting.
//   (V)  the track card / approval sheet values (stagingFieldValues) key on the recipe's portal.
//   (S)  THE POINT, through the real prepareSubmission (browser stubbed): a recipe replay on a real
//        portal never gets the "mock" row's company or contact.
//
// KILL (verified by hand): restore `entry.portalType === portalType` in clientStagingOverlay and
// pass `portalType` at repository.ts' overlay -> (A), (B), (V) and (S) FAIL.
//
//   npx tsx backend/test/portalIdentityKeying.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("portal-identity-keying");
const { db, repo, recipes } = fx;
const { clientStagingOverlay, portalIdentityKey, stagingIdentityDisagreement, stagingIdentityPortal, updateClient } = await import("../src/clients");
const { stagingFieldValues } = await import("../src/recipeStageGapsView");

const PGE_URL = "https://pgenm.powerclerk.com/MvcAccount/Login";
const OTHER_PC_URL = "https://otherutility.powerclerk.com/MvcAccount/Login";
const ACCELA_OR_URL = "https://aca-oregon.accela.com/oregon/Default.aspx";
const LEGAL = "Replay Trust Solar LLC";

updateClient(db, fx.client.id, {
  portalIdentities: [
    { portalType: "powerclerk_pge", installerCompanyLabel: "Replay Trust Solar (PGE account)", installerContactCode: "PGE-CONTACT-11", notes: "" },
    { portalType: "accela_oregon", installerCompanyLabel: "Replay Trust Solar (Accela)", installerContactCode: "ACA-22", notes: "" },
    { portalType: "mock", installerCompanyLabel: "Mock Label Co", installerContactCode: "MOCK-99", notes: "" },
  ],
});
const job = { state: "OR", track: "nem" as string | null };

await check("(K) portalIdentityKey: hosts name their portal; other tenants and bare words name none", () => {
  assert.equal(portalIdentityKey(PGE_URL), "powerclerk_pge");
  assert.equal(portalIdentityKey("https://PGENM.powerclerk.com/x"), "powerclerk_pge");
  assert.equal(portalIdentityKey(ACCELA_OR_URL), "accela_oregon");
  assert.equal(portalIdentityKey(OTHER_PC_URL), "", "another PowerClerk tenant is not PGE's account");
  assert.equal(portalIdentityKey("https://aca-prod.accela.com/CORVALLIS"), "", "a city's own Accela tenant is not Oregon ePermitting");
  assert.equal(portalIdentityKey("powerclerk_pge"), "powerclerk_pge");
  assert.equal(portalIdentityKey("mock"), "mock");
  for (const none of ["utility", "AHJ", "", "PowerClerk", "not a url"]) assert.equal(portalIdentityKey(none), "", none);
});

await check("(R) stagingIdentityPortal: disagreeing URLs name none; no URL and no profile is the mock portal", () => {
  assert.equal(stagingIdentityPortal({ urls: [PGE_URL, "", PGE_URL], profilePortalType: "mock", isRealPortal: false }), "powerclerk_pge");
  assert.equal(stagingIdentityPortal({ urls: [PGE_URL, OTHER_PC_URL], profilePortalType: "mock", isRealPortal: false }), "");
  assert.equal(stagingIdentityPortal({ urls: ["https://permits.portland.example/apply"], profilePortalType: "mock", isRealPortal: false }), "");
  assert.equal(stagingIdentityPortal({ urls: ["", null], profilePortalType: "mock", isRealPortal: false }), "mock");
  assert.equal(stagingIdentityPortal({ urls: [], profilePortalType: "powerclerk_pge", isRealPortal: true }), "powerclerk_pge");
  assert.equal(stagingIdentityPortal({ urls: [OTHER_PC_URL], profilePortalType: "powerclerk_pge", isRealPortal: true }), "", "a URL outranks the profile");
});

await check("(D) stagingIdentityDisagreement: hosts and their identity types when the URLs disagree; null when they agree", () => {
  const d = stagingIdentityDisagreement([ACCELA_OR_URL, "", "https://permits.coos.example/info?token=abc123"]);
  assert.ok(d, "disagreeing URLs must be named");
  assert.deepEqual(d!.hosts, ["aca-oregon.accela.com", "permits.coos.example"]);
  assert.deepEqual(d!.keys, ["accela_oregon", ""]);
  assert.ok(!JSON.stringify(d).includes("token"), "never a full URL (a query can carry a token)");
  assert.equal(stagingIdentityDisagreement([PGE_URL, "https://pgenm.powerclerk.com/Other", null]), null, "one portal, two pages: agree");
  assert.equal(stagingIdentityDisagreement(["https://permits.portland.example/apply"]), null, "one URL cannot disagree");
  assert.equal(stagingIdentityDisagreement(["https://a.example/", "https://b.example/"]), null, "two hosts that both name no portal: nothing was dropped");
  assert.ok(stagingIdentityDisagreement([PGE_URL, OTHER_PC_URL]), "PGE vs another tenant");
});

await check("(A) the PGE identity row is used on PGE: its label and its contact code", () => {
  const o = clientStagingOverlay(db, fx.client.id, PGE_URL, job);
  assert.equal(o.installerCompanyName, "Replay Trust Solar (PGE account)");
  assert.equal(o.powerclerkExistingContact, "PGE-CONTACT-11");
});

await check("(B) ...and NOT on another PowerClerk tenant, a permit host, or a bare word: legal name, no contact", () => {
  for (const portal of [OTHER_PC_URL, "https://permits.portland.example/apply", "utility", "AHJ", ""]) {
    const o = clientStagingOverlay(db, fx.client.id, portal, job);
    assert.equal(o.installerCompanyName, LEGAL, portal);
    assert.equal(o.powerclerkExistingContact, undefined, `${portal}: ${o.powerclerkExistingContact}`);
    assert.equal(o.accelaContactCode, undefined, portal);
  }
  const aca = clientStagingOverlay(db, fx.client.id, ACCELA_OR_URL, { state: "OR", track: "building" });
  assert.equal(aca.installerCompanyName, "Replay Trust Solar (Accela)");
  assert.equal(aca.accelaContactCode, "ACA-22");
  const mock = clientStagingOverlay(db, fx.client.id, "mock", job);
  assert.equal(mock.installerCompanyName, "Mock Label Co", "the mock row is the mock portal's");
});

await check("(V) stagingFieldValues keys on the recipe's portal: PGE recipe -> PGE row; another tenant -> legal name", () => {
  const pid = fx.newProject();
  const project = repo.getProjectDetail(db, pid).project;
  const pge = stagingFieldValues(db, project, "nem", PGE_URL);
  assert.equal(pge.values.installerCompanyName, "Replay Trust Solar (PGE account)");
  assert.equal(pge.values.powerclerkExistingContact, "PGE-CONTACT-11");
  const other = stagingFieldValues(db, project, "nem", OTHER_PC_URL);
  assert.equal(other.values.installerCompanyName, LEGAL);
  assert.equal(other.values.powerclerkExistingContact, undefined);
  // No recipe passed: the track's own complete recipe names the portal.
  const r = recipes.startPortalRecording(db, { scopeType: "utility", state: "OR", utility: "PGE", portalUrl: PGE_URL, portalPlatform: "powerclerk", createdBy: "test" });
  recipes.savePortalRecipeSteps(db, r.id, [...fx.fills(2), fx.REVIEW], { status: "complete", notes: "test" });
  const viaRecipe = stagingFieldValues(db, project, "nem");
  assert.equal(viaRecipe.values.installerCompanyName, "Replay Trust Solar (PGE account)");
  // Never the mock row in a view.
  assert.notEqual(stagingFieldValues(db, project, "building", "").values.installerCompanyName, "Mock Label Co");
});

let seenCompany = "";
let seenContact: string | undefined = "";
let seenSnapshotCompany = "";
fx.stubRunner(async (_recipe, project, fields) => {
  seenCompany = String((fields as Record<string, string>).installerCompanyName ?? "");
  seenContact = (fields as Record<string, string>).powerclerkExistingContact;
  seenSnapshotCompany = String((project as { parserSnapshot?: Record<string, unknown> }).parserSnapshot?.installerCompanyName ?? "");
  return { ok: true, finalSubmitClicked: false, steps: [{ ok: true, message: "reached review" }] } as never;
});

await check("(S) THE POINT: a real recipe replay never files the 'mock' row's company or contact", async () => {
  fx.completeRecipe();
  const pid = fx.newProject();
  await repo.prepareSubmission(db, pid);
  assert.ok(seenCompany, "setup: the recipe runner never ran");
  assert.equal(seenCompany, LEGAL, `replay values: ${seenCompany}`);
  assert.equal(seenSnapshotCompany, LEGAL, `staged snapshot: ${seenSnapshotCompany}`);
  assert.equal(seenContact, undefined, `contact: ${seenContact}`);
});

finish("portal-identity-keying");
