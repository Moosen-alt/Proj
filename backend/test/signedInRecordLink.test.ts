// A LOGIN-WALLED RECORD LINK IS READ WITH THE CLIENT'S OWN STORED LOGIN (#512).
//
// Live install 2026-11-02: the owner pasted a PacifiCorp PowerClerk project link
// (MvcProjects/LandingPage?ProgramId=…&ProjectId=…) into a NEM card. With no PacifiCorp recipe and no
// saved session, the sweep read the link anonymously, met the sign-in page and recorded nothing,
// although the client's own PacifiCorp login was stored. The sweep now signs in with THAT login and
// reads the record through its own link (portal-bot readRecordLinkSignedIn: live-proven read-only on
// that card the same day, with the owner watching).
//
// The sweep is the real runDuePermitChecks over targets and credentials written through the real
// writers; only the browser and the network are stubbed (setStatusCheckSeamsForTests).
//
//   MUST-PASS    a NEM card whose link answers with a sign-in page, and a stored login of the
//                project's client for that link's host → the signed-in link read runs once, with that
//                link and that login, on a profile of its own; its status is recorded (source
//                "portal") and the card's read gap is cleared — also when the anonymous read saw only
//                an empty shell (the live PowerClerk login is drawn by script: null, not a "wall")
//   MUST-EXCLUDE the link's page is public (no sign-in wall) → no sign-in is spent
//   MUST-EXCLUDE rule 5/6: a login stored only for ANOTHER host, or another client's login for this
//                host → never used; the card says no login is stored for the host
//   MUST-EXCLUDE a sign-in that fails → nothing recorded, the known status kept (#412), the card says
//                the sign-in failed
//   MUST-PASS    login health: a REFUSED sign-in marks the login stale (recordLoginOutcome), so the
//                next check types nothing and says so; a later accepted sign-in lifts it
//   MUST-EXCLUDE a login whose record says the portal sends a code at every sign-in is never typed by
//                a scheduled read (each check would send the client a code)
//
// Run: npx tsx backend/test/signedInRecordLink.test.ts
import "./_isolate"; // FIRST — generated files land in a temp cwd, never the repo's backend/data
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret";
const fx = await setupStageFixture("signed-in-record-link");
const { db, repo, client } = fx;
process.env.PORTAL_AUTOSEED = "1"; // the live install's mode: an empty read is skipped, not mocked
process.env.PORTAL_FEE_READ = "off"; // the fee reader has its own suite; never the network here
const { createPortalCredential, listStaleCredentials, recordLoginOutcome } = await import("../src/portalCredentials");
const { createClient } = await import("../src/clients");

const HOST = "testpower.powerclerk.com";
const LINK = `https://${HOST}/MvcProjects/LandingPage?ProgramId=PROG1&ProjectId=PROJ1`;
// Where the portal leads a signed-out record: ITS OWN sign-in page (PowerClerk: /MvcAccount/Login).
const SIGN_IN_PAGE = `https://${HOST}/MvcAccount/Login?ReturnUrl=%2fMvcProjects%2fLandingPage`;
const WALL = "Log In Username Password Remember me Forgot password? Log In";
const RECORD = "View/Edit: APP-**3456 Application Received Technical Review Current Status Status marked as PP - Application Submitted on 10/30/2026";

type LinkCall = { url: string; apps: string[]; username?: string; atRecordUrl?: string; otherTenant?: string; userDataDir?: string };
const linkCalls: LinkCall[] = [];
let linkAnswer: { text: string | null; reason: string; outcome: string; signedIn: boolean; loginRefused?: boolean } = { text: RECORD, reason: "", outcome: "read", signedIn: true };
let publicAnswer: string | null = WALL;
repo.setStatusCheckSeamsForTests({
  checkStatus: (async () => null) as never, // no recipe and no saved session on this utility: never reached
  publicCheck: (async () => publicAnswer) as never,
  signedInLink: (async (url: string, apps: string[], opts: { credentialFor?: (u: string) => { username: string } | null; userDataDir?: string }) => {
    // Probes first (what the record URL itself, or another tenant's sign-in on the same host, would
    // get), then — last, as the real reader's one call — the login for the sign-in page the portal
    // led to. No login for it: nothing is typed, as in the real reader.
    const atRecordUrl = opts.credentialFor?.(url)?.username ?? "(none)";
    const otherTenant = opts.credentialFor?.(`https://${HOST}/OTHERTENANT/Login.aspx`)?.username ?? "(none)";
    const username = opts.credentialFor?.(SIGN_IN_PAGE)?.username;
    linkCalls.push({ url, apps, userDataDir: opts.userDataDir, username, atRecordUrl, otherTenant });
    if (!username) return { text: null, reason: `no stored login fits ${HOST}'s sign-in page on this client; nothing was typed`, outcome: "no_credential", signedIn: false };
    return linkAnswer;
  }) as never,
});

const nemTarget = (projectId: string) => {
  repo.createPermitCheckTarget(db, projectId, { targetType: "nem", applicationNumber: "APP-123456", portalUrl: LINK, portalName: HOST } as never);
  return db.get<{ id: string }>("SELECT id FROM permit_check_targets WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", [projectId])!.id;
};
const sweep = async (...ids: string[]) => {
  db.run("UPDATE permit_check_targets SET active = 0");
  for (const t of ids) db.run("UPDATE permit_check_targets SET active = 1, next_check_at = NULL WHERE id = ?", [t]);
  linkCalls.length = 0;
  await repo.runDuePermitChecks(db, "all");
};
const targetRow = (id: string) => db.get<{ latest_outcome: string | null; read_gap: string }>("SELECT latest_outcome, read_gap FROM permit_check_targets WHERE id = ?", [id])!;
const checksOf = (id: string) => db.query<{ source: string; raw_status_text: string }>("SELECT source, raw_status_text FROM permit_status_checks WHERE target_id = ? ORDER BY created_at DESC", [id]);

// The fixture client's own login for the link's host (rule 6: the project's client).
createPortalCredential(db, client.id, { portalUrl: `https://${HOST}/MvcAccount/Login`, username: "own-user", password: "own-pass" });

await check("(s1) MUST-PASS a sign-in wall + the client's stored login for that host → one signed-in read of the card's own link; its status is recorded and the read gap cleared", async () => {
  publicAnswer = WALL;
  linkAnswer = { text: RECORD, reason: "", outcome: "read", signedIn: true };
  const t = nemTarget(fx.newProject({ utility: "Testpower Co" }));
  await sweep(t);
  assert.equal(linkCalls.length, 1, "the signed-in link read did not run (the #512 bug: the wall ended the check)");
  assert.equal(linkCalls[0].url, LINK, "it read something other than the card's own link");
  assert.deepEqual(linkCalls[0].apps, ["APP-123456"]);
  assert.equal(linkCalls[0].username, "own-user", "the portal's own sign-in page did not get the client's login stored for it");
  // The shared-host guard stands: a login is matched to the SIGN-IN PAGE (host + first path segment),
  // so the record URL itself (/MvcProjects/…) or another tenant's sign-in on the same host gets none.
  assert.equal(linkCalls[0].atRecordUrl, "(none)", "a login was matched to the record URL's path instead of the sign-in page");
  assert.equal(linkCalls[0].otherTenant, "(none)", "another tenant's sign-in page on the same host got this login");
  assert.ok(/status-read/i.test(String(linkCalls[0].userDataDir)), `not a profile of its own (a staging window's profile would be waited on or closed): ${linkCalls[0].userDataDir}`);
  const rows = checksOf(t);
  assert.equal(rows.length, 1, "the read status was not recorded");
  assert.equal(rows[0].source, "portal");
  assert.ok(rows[0].raw_status_text.includes("Application Submitted"), rows[0].raw_status_text);
  assert.equal(targetRow(t).read_gap, "", "the card still says it cannot read the filing");
});

await check("(s1b) MUST-PASS the LIVE PowerClerk shape: the anonymous read sees an empty shell (a sign-in form drawn by script reads as null, not as a wall) → the signed-in read still runs and reads the record", async () => {
  // Live 2026-11-02: PacifiCorp's record link redirected to /MvcAccount/Login, and the plain fetch's
  // text was null — publicLink "no_status", never "wall". A door keyed on the wall never opened.
  publicAnswer = null;
  linkAnswer = { text: RECORD, reason: "", outcome: "read", signedIn: true };
  const t = nemTarget(fx.newProject({ utility: "Testpower Co" }));
  await sweep(t);
  assert.equal(linkCalls.length, 1, "an anonymous read that saw nothing did not hand the link to the signed-in read");
  assert.equal(linkCalls[0].username, "own-user");
  assert.equal(checksOf(t)[0]?.source, "portal");
  assert.equal(targetRow(t).read_gap, "");
  publicAnswer = WALL;
});

await check("(s2) MUST-EXCLUDE a public record page (no sign-in wall) → no sign-in is spent", async () => {
  publicAnswer = "Record APP-123456 Status: Approved — the public record page, read anonymously";
  const t = nemTarget(fx.newProject({ utility: "Testpower Co" }));
  await sweep(t);
  assert.equal(linkCalls.length, 0, "a sign-in was spent on a page that reads without one");
  assert.equal(checksOf(t)[0]?.source, "public_url");
  publicAnswer = WALL;
});

await check("(s3) MUST-EXCLUDE rule 5: a login stored only for ANOTHER host is never used; the card says no login is stored for this host", async () => {
  const other = createClient(db, { companyName: "Other Host Solar", ccbLicenseNumber: "765432" });
  createPortalCredential(db, other.id, { portalUrl: "https://elsewhere.powerclerk.com/MvcAccount/Login", username: "elsewhere-user", password: "x" });
  const p = repo.createProject(db, { clientId: other.id, owner: "Host Owner", street: "9 Host Way", city: "Testville", state: "OR", zip: "97000", ahj: "Testville", utility: "Testpower Co" } as never).project.id;
  const t = nemTarget(p);
  await sweep(t);
  assert.equal(linkCalls.length, 0, "a login stored for another host was used on this one");
  assert.ok(/login|sign/i.test(targetRow(t).read_gap), `the card does not say why: ${JSON.stringify(targetRow(t).read_gap)}`);
});

await check("(s4) MUST-EXCLUDE rule 6: another client's login for THIS host is never used", async () => {
  const stranger = createClient(db, { companyName: "Stranger Solar", ccbLicenseNumber: "111222" });
  const p = repo.createProject(db, { clientId: stranger.id, owner: "Stranger Owner", street: "7 Stranger Way", city: "Testville", state: "OR", zip: "97000", ahj: "Testville", utility: "Testpower Co" } as never).project.id;
  const t = nemTarget(p);
  await sweep(t);
  assert.equal(linkCalls.length, 0, "the fixture client's login was used on another client's filing");
});

await check("(s5) MUST-EXCLUDE a sign-in that fails → nothing recorded, the known status kept (#412), the card says the sign-in failed", async () => {
  linkAnswer = { text: RECORD, reason: "", outcome: "read", signedIn: true };
  const t = nemTarget(fx.newProject({ utility: "Testpower Co" }));
  await sweep(t); // a first, good read: the card has a known status
  const known = targetRow(t).latest_outcome;
  assert.ok(known, "the first read recorded no status");
  linkAnswer = { text: null, reason: `the sign-in failed on ${HOST} (still_on_login)`, outcome: "sign_in_failed", signedIn: false };
  await sweep(t);
  assert.equal(linkCalls.length, 1);
  assert.equal(checksOf(t).length, 1, "a failed sign-in was recorded as a status");
  assert.equal(targetRow(t).latest_outcome, known, "a failed sign-in changed the known status");
  assert.ok(/sign/i.test(targetRow(t).read_gap), `the card does not say the sign-in failed: ${JSON.stringify(targetRow(t).read_gap)}`);
});

const STORED_URL = `https://${HOST}/MvcAccount/Login`;
const isStale = (clientId: string) => listStaleCredentials(db, clientId).some((c) => c.portalUrl === STORED_URL);

await check("(s6) MUST-PASS login health: a sign-in the portal REFUSED marks the client's login stale, the next check types nothing and says why, and a later accepted sign-in lifts it", async () => {
  const t = nemTarget(fx.newProject({ utility: "Testpower Co" }));
  linkAnswer = { text: null, reason: `the sign-in failed on ${HOST} (still_on_login)`, outcome: "sign_in_failed", signedIn: false, loginRefused: true };
  await sweep(t);
  assert.equal(linkCalls[0]?.username, "own-user");
  assert.ok(isStale(client.id), "a refused sign-in was not recorded against the login (the next check would knock again)");
  await sweep(t);
  assert.equal(linkCalls.length, 1);
  assert.equal(linkCalls[0].username, undefined, "a login the portal refused was typed again — repeated attempts lock the account");
  assert.ok(/refused/i.test(targetRow(t).read_gap), `the card does not say the login was refused: ${JSON.stringify(targetRow(t).read_gap)}`);
  // A supervised run signs in with it (the real writer): the block lifts, and the read signs in again.
  recordLoginOutcome(db, client.id, STORED_URL, { ok: true, note: "supervised run" });
  linkAnswer = { text: RECORD, reason: "", outcome: "read", signedIn: true };
  await sweep(t);
  assert.equal(linkCalls[0].username, "own-user");
  assert.ok(!isStale(client.id));
  assert.equal(targetRow(t).read_gap, "");
});

await check("(s7) MUST-EXCLUDE a login whose record says the portal sends a code at every sign-in is never typed by a scheduled read; the card says why", async () => {
  const mfaClient = createClient(db, { companyName: "Code Solar", ccbLicenseNumber: "333444" });
  createPortalCredential(db, mfaClient.id, { portalUrl: STORED_URL, username: "code-user", password: "x", mfaRequired: true, mfaCodeDestination: "office inbox" });
  const p = repo.createProject(db, { clientId: mfaClient.id, owner: "Code Owner", street: "5 Code Way", city: "Testville", state: "OR", zip: "97000", ahj: "Testville", utility: "Testpower Co" } as never).project.id;
  const t = nemTarget(p);
  await sweep(t);
  assert.equal(linkCalls.length, 1);
  assert.equal(linkCalls[0].username, undefined, "a code-at-every-sign-in login was typed by a scheduled read (each check would send the client a code)");
  assert.ok(/code/i.test(targetRow(t).read_gap), `the card does not say why: ${JSON.stringify(targetRow(t).read_gap)}`);
  // (A never-checked card still gets its honest "manual check required" row; nothing READ is recorded.)
  assert.ok(!checksOf(t).some((c) => c.source === "portal"), "a status was recorded as read from the portal");
});

finish("signed-in-record-link");
