// #512 — THE SIGNED-IN RECORD-LINK READ, IN REAL CHROMIUM, ON A LOCAL FIXTURE PORTAL ONLY.
//
// The fixture is a PowerClerk-shaped portal: a record page (/MvcProjects/LandingPage?ProjectId=…) that
// redirects a signed-out visitor to the portal's own sign-in page (/MvcAccount/Login?ReturnUrl=…), a
// sign-in form that sets a session cookie, and a record page carrying "Current Status … Status marked
// as …". The record page also runs a script that tries to POST a filing: the backstop must hold it.
//
//   MUST-PASS    signed out → the portal's own sign-in page is asked for its login (credentialFor gets
//                THAT page's URL), the sign-in holds, the record is read: its status text, signedIn
//                true; a second read on the same profile reuses a session the portal keeps (a
//                persistent cookie, flushed to the profile when the read closes) — signedIn false
//   MUST-EXCLUDE rule 1: the record page's own filing POST never reaches the server
//   MUST-EXCLUDE no login fits the sign-in page → nothing is typed (no POST to the sign-in form)
//   MUST-EXCLUDE a rejected password → sign_in_failed, reported as refused (loginRefused); an MFA
//                screen → mfa (never answered), never reported as refused
//   MUST-EXCLUDE a record link that leads to another host → off_host, nothing typed there
//
//   npx tsx portal-bot/src/recordLinkRead.dom.smoke.ts
import "./smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { readRecordLinkSignedIn } from "./recordLinkRead";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const posts: string[] = [];
const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
const LOGIN_FORM = (note = "") => page(`<h1>Log In</h1>${note}<form method="post" action="/MvcAccount/Login">
  <label for="UserName">Username</label><input id="UserName" name="UserName" type="text">
  <label for="Password">Password</label><input id="Password" name="Password" type="password">
  <button type="submit" id="loginBtn">Log In</button></form><a href="/forgot">Forgot password?</a>`);
let otherOrigin = "";

const server = http.createServer((req, res) => {
  const url = new URL(String(req.url), "http://127.0.0.1");
  const signedIn = /(?:^|;\s*)sess=ok/.test(String(req.headers.cookie ?? ""));
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      posts.push(url.pathname);
      if (url.pathname === "/MvcAccount/Login") {
        const form = new URLSearchParams(body);
        const user = form.get("UserName") ?? "";
        const pass = form.get("Password") ?? "";
        if (user === "mfa-user") { res.writeHead(200, { "Content-Type": "text/html" }); res.end(page(`<h1>Verify it's you</h1><p>Enter the verification code we sent to your phone.</p><input id="code" name="code" autocomplete="one-time-code"><button>Verify</button>`)); return; }
        // A persistent sign-in cookie (PowerClerk's "Remember me" shape): it is what a profile can carry
        // to the next check. A session-only cookie dies with the browser — the next check signs in again.
        if (user === "good-user" && pass === "good-pass") { res.writeHead(302, { "Set-Cookie": "sess=ok; Path=/; Max-Age=3600", Location: "/Home" }); res.end(); return; }
        res.writeHead(200, { "Content-Type": "text/html" }); res.end(LOGIN_FORM("<p>Invalid username or password.</p>")); return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" }); res.end("posted");
    });
    return;
  }
  if (url.pathname === "/MvcAccount/Login") { res.writeHead(200, { "Content-Type": "text/html" }); res.end(LOGIN_FORM()); return; }
  if (url.pathname === "/Home") { res.writeHead(200, { "Content-Type": "text/html" }); res.end(page(`<nav><a href="/MvcProjects/List">Projects</a> <a href="/MvcAccount/LogOff">Log Out</a></nav><h1>Welcome</h1>`)); return; }
  if (url.pathname === "/offhost") { res.writeHead(302, { Location: `${otherOrigin}/MvcAccount/Login` }); res.end(); return; }
  if (url.pathname === "/MvcProjects/LandingPage") {
    if (!signedIn) { res.writeHead(302, { Location: `/MvcAccount/Login?ReturnUrl=${encodeURIComponent(String(req.url))}` }); res.end(); return; }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(page(`<nav><a href="/MvcAccount/LogOff">Log Out</a></nav><h1>View/Edit: APP-123456</h1>
      <div class="steps"><span>Application Received</span><span>Technical Review</span><span>Field Work</span></div>
      <section><h2>Current Status</h2><p>Status marked as PP - Application Submitted on 10/30/2026 at 9:31 AM</p></section>
      <script>setTimeout(() => { fetch("/apply/submit", { method: "POST", body: "x=1" }).catch(() => 0); }, 200);</script>`));
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const other = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(LOGIN_FORM()); });
await new Promise<void>((r) => other.listen(0, "127.0.0.2", () => r()));
otherOrigin = `http://127.0.0.2:${(other.address() as { port: number }).port}`;

const LINK = `${base}/MvcProjects/LandingPage?ProgramId=PROG1&ProjectId=PROJ1`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "record-link-read-"));
const asked: string[] = [];
const good = (u: string) => { asked.push(u); return { username: "good-user", password: "good-pass" }; };

try {
  console.log("#512 signed-in record-link read (local fixture only)");
  {
    const r = await readRecordLinkSignedIn(LINK, ["APP-123456"], { credentialFor: good, userDataDir: profile, headless: true });
    check("signed out → the record is read after signing in: its status text, signedIn true", r.outcome === "read" && r.signedIn === true && /Application Submitted/.test(String(r.text)), JSON.stringify(r));
    check("…the login was asked for the portal's OWN sign-in page (credentialFor got /MvcAccount/Login, never the record URL)", asked.length === 1 && /\/MvcAccount\/Login/.test(asked[0]) && !/LandingPage\?/.test(asked[0].split("?")[0]), JSON.stringify(asked));
    check("rule 1: the record page's own filing POST never reached the server (the backstop held it)", !posts.includes("/apply/submit"), JSON.stringify(posts));
  }
  {
    asked.length = 0;
    const r = await readRecordLinkSignedIn(LINK, ["APP-123456"], { credentialFor: good, userDataDir: profile, headless: true });
    check("a second read on the same profile reuses the session: read, signedIn false, no login asked", r.outcome === "read" && r.signedIn === false && asked.length === 0, JSON.stringify({ r, asked }));
  }
  {
    const before = posts.filter((p) => p === "/MvcAccount/Login").length;
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "record-link-read-"));
    const r = await readRecordLinkSignedIn(LINK, ["APP-123456"], { credentialFor: () => null, userDataDir: fresh, headless: true });
    check("no stored login fits the sign-in page → no_credential, and nothing is typed (no sign-in POST)", r.outcome === "no_credential" && posts.filter((p) => p === "/MvcAccount/Login").length === before, JSON.stringify(r));
  }
  {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "record-link-read-"));
    const r = await readRecordLinkSignedIn(LINK, ["APP-123456"], { credentialFor: () => ({ username: "good-user", password: "wrong" }), userDataDir: fresh, headless: true });
    check("a rejected password → sign_in_failed, nothing read, and reported as REFUSED (the caller marks the login stale)", r.outcome === "sign_in_failed" && r.text === null && r.loginRefused === true, JSON.stringify(r));
  }
  {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "record-link-read-"));
    const r = await readRecordLinkSignedIn(LINK, ["APP-123456"], { credentialFor: () => ({ username: "mfa-user", password: "x" }), userDataDir: fresh, headless: true });
    check("an MFA screen at sign-in → mfa, never answered, and NOT reported as a refused login", r.outcome === "mfa" && r.text === null && !r.loginRefused, JSON.stringify(r));
  }
  {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "record-link-read-"));
    let typed = false;
    const r = await readRecordLinkSignedIn(`${base}/offhost`, ["APP-123456"], { credentialFor: () => { typed = true; return { username: "good-user", password: "good-pass" }; }, userDataDir: fresh, headless: true });
    check("a record link that leads to another host's sign-in → off_host, and no login is even looked up for it", r.outcome === "off_host" && !typed, JSON.stringify({ r, typed }));
  }
} finally {
  server.close();
  other.close();
}

if (failures) { console.error(`\n${failures} record-link-read check(s) FAILED.`); process.exit(1); }
console.log("\nAll record-link-read checks passed.");
