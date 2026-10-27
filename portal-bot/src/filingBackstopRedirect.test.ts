// #358: which redirects re-send the request (and so are judged as a fresh request before Chromium
// follows them), and how a refused redirect reads. The real-browser cells are in
// filingBackstopRedirect.dom.smoke.ts.
import { backstopSentLine, describeBackstopAbort, isStoppingAbort, redirectKeepsMethod } from "./filingBackstop";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`ok   - ${label}`);
  else { failures++; console.error(`FAIL - ${label}${detail ? ` (${detail})` : ""}`); }
};

for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
  check(`307 keeps ${m}`, redirectKeepsMethod(307, m));
  check(`308 keeps ${m}`, redirectKeepsMethod(308, m));
  check(`303 turns ${m} into a GET`, !redirectKeepsMethod(303, m));
}
check("301 / 302 turn a POST into a GET", !redirectKeepsMethod(301, "POST") && !redirectKeepsMethod(302, "post"));
check("301 / 302 keep a PUT and a DELETE", redirectKeepsMethod(301, "PUT") && redirectKeepsMethod(302, "DELETE"));
check("a 200 and a 304 are not redirects", !redirectKeepsMethod(200, "POST") && !redirectKeepsMethod(304, "PUT"));

const hop = { rule: "filing-url" as const, method: "POST", where: "http://127.0.0.1:9/SubmitApplication", why: "a filing endpoint, and no named approval covers this request (run)", resourceType: "document", redirect: { from: "http://127.0.0.1:9/step", status: 307, hop: 1 } };
const line = describeBackstopAbort(hop);
check("a refused redirect names its status, the request that reached the portal and the Location it was not followed to",
  /REFUSED A 307 REDIRECT of POST http:\/\/127\.0\.0\.1:9\/step \(that request reached the portal\) to http:\/\/127\.0\.0\.1:9\/SubmitApplication/.test(line) && /not followed$/.test(line), line);
check("…and never says it aborted the first request", !/BACKSTOP ABORTED/.test(line), line);
check("a refused redirect stops the run", isStoppingAbort(hop));
const sent = backstopSentLine(hop);
check("a refused redirect's stop says the first request reached the portal and never \"Nothing was sent\"",
  /The request to http:\/\/127\.0\.0\.1:9\/step reached the portal, which answered with a 307 redirect/.test(sent) && !/nothing was sent/i.test(sent), sent);
check("an ordinary abort still says nothing was sent", backstopSentLine({ ...hop, redirect: undefined }) === "Nothing was sent.");
check("a later hop says how many redirects in a row", /redirect 3 in a row/.test(describeBackstopAbort({ ...hop, redirect: { ...hop.redirect, hop: 3 } })));

if (failures) { console.error(`\nfilingBackstopRedirect: ${failures} FAILED`); process.exit(1); }
console.log("\nfilingBackstopRedirect: all checks passed");
