// EMAIL-IN INTAKE SENDER CHECK (#510): reading Authentication-Results (RFC 8601).
//
//   MUST PASS    — dmarc=pass for the From domain in the TOPMOST header; aligned spf=pass + dkim=pass
//                  (relaxed: a subdomain on either side); comments, quoted reasons and spaces
//                  around "=" do not confuse the reader; a stated dmarc=fail in any header refuses
//                  in both modes; with the switch off, no header goes on.
//   MUST NOT     — a pass from any header but the topmost counts (a sender can write its own lower
//                  down); a pass for another domain, a sibling domain or a bare suffix aligns; SPF
//                  or DKIM alone passes; no header passes with the switch on.
//
// Pure functions, no DB, no network. Synthetic domains only.
//   npx tsx backend/test/intakeAuth.test.ts
import assert from "node:assert/strict";
import {
  domainsAlign, dmarcFailStated, intakeAuthRefusal, intakeRequiresAuth, parseAuthenticationResults, senderAuthenticated,
} from "../src/intakeAuth";

let failures = 0;
const run = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.stack || err.message : String(err)}`); }
};

const FROM = "office@acme.example.test";

run("the reader takes authserv-id, methods, results and ptype.property values; comments and quotes do not split", () => {
  const r = parseAuthenticationResults(
    "mx.example.test 1; spf=pass (sender IP is 192.0.2.1; permitted) smtp.mailfrom=Bounce@Acme.Example.Test;\r\n" +
    "\tdkim = pass header.i=@acme.example.test header.s=s1; dmarc=pass reason=\"aligned; ok\" (p=NONE sp=NONE) header.from=acme.example.test",
  );
  assert.equal(r.authservId, "mx.example.test");
  assert.deepEqual(r.results.map((x) => `${x.method}=${x.result}`), ["spf=pass", "dkim=pass", "dmarc=pass"]);
  assert.equal(r.results[0].props["smtp.mailfrom"], "bounce@acme.example.test");
  assert.equal(r.results[1].props["header.i"], "@acme.example.test");
  assert.equal(r.results[2].props["header.from"], "acme.example.test");
  assert.deepEqual(parseAuthenticationResults("mx.example.test; none").results, []);
});

run("alignment: same domain or a subdomain either way; never a sibling, another domain or a bare suffix", () => {
  assert.ok(domainsAlign("acme.example.test", "acme.example.test"));
  assert.ok(domainsAlign("bounce@mail.acme.example.test", "acme.example.test"));
  assert.ok(domainsAlign("acme.example.test", "mail.acme.example.test"));
  assert.ok(!domainsAlign("evil-acme.example.test", "acme.example.test"));
  assert.ok(!domainsAlign("other.example.test", "acme.example.test"));
  assert.ok(!domainsAlign("test", "acme.test"), "a bare suffix aligned");
  assert.ok(!domainsAlign("", "acme.example.test"));
});

run("dmarc=pass in the topmost header authenticates; for another From domain it does not", () => {
  assert.ok(senderAuthenticated(["mx.example.test; dmarc=pass header.from=acme.example.test"], FROM));
  assert.ok(senderAuthenticated(["mx.example.test; dmarc=pass"], FROM), "a pass that names no domain is the provider's verdict on the From");
  assert.ok(!senderAuthenticated(["mx.example.test; dmarc=pass header.from=elsewhere.example.test"], FROM));
});

run("MUST-EXCLUDE: a pass in any header but the topmost does not count", () => {
  assert.ok(!senderAuthenticated(["mx.example.test; none", "mx.example.test; dmarc=pass header.from=acme.example.test"], FROM));
  assert.ok(!senderAuthenticated(["mx.example.test; dmarc=none header.from=acme.example.test", "forged.example.test; spf=pass smtp.mailfrom=acme.example.test; dkim=pass header.d=acme.example.test"], FROM));
});

run("aligned spf=pass AND dkim=pass authenticate without a DMARC line; either alone does not", () => {
  assert.ok(senderAuthenticated(["mx.example.test; spf=pass smtp.mailfrom=b@mail.acme.example.test; dkim=pass header.d=acme.example.test"], FROM));
  assert.ok(senderAuthenticated(["mx.example.test; spf=pass smtp.mailfrom=acme.example.test; dkim=fail header.d=other.example.test; dkim=pass header.d=acme.example.test"], FROM), "any aligned DKIM pass among several signatures");
  assert.ok(!senderAuthenticated(["mx.example.test; spf=pass smtp.mailfrom=acme.example.test"], FROM));
  assert.ok(!senderAuthenticated(["mx.example.test; dkim=pass header.d=acme.example.test"], FROM));
  assert.ok(!senderAuthenticated(["mx.example.test; spf=pass smtp.mailfrom=bulk.example.test; dkim=pass header.d=acme.example.test"], FROM), "unaligned SPF");
  assert.ok(!senderAuthenticated(["mx.example.test; spf=pass smtp.mailfrom=acme.example.test; dkim=pass header.d=bulk.example.test"], FROM), "unaligned DKIM");
  assert.ok(!senderAuthenticated(["mx.example.test; spf=pass; dkim=pass"], FROM), "passes that name no domain cannot be aligned");
});

run("no header, an empty or malformed From never authenticates", () => {
  assert.ok(!senderAuthenticated([], FROM));
  assert.ok(!senderAuthenticated(["mx.example.test; dmarc=pass"], ""));
  assert.ok(!senderAuthenticated(["mx.example.test; dmarc=pass"], "acme.example.test"));
});

run("the verdict: a stated fail refuses in both modes; no header refuses only with the switch on", () => {
  const fail = ["mx.example.test; spf=pass; dmarc=fail (p=reject) header.from=acme.example.test"];
  assert.equal(intakeAuthRefusal(fail, FROM, false), "dmarc_fail");
  assert.equal(intakeAuthRefusal(fail, FROM, true), "dmarc_fail");
  assert.ok(dmarcFailStated(["mx.example.test; none", "relay.example.test; dmarc=fail"]), "a fail is believed from any header");
  assert.equal(intakeAuthRefusal([], FROM, false), null, "the default mode changed");
  assert.equal(intakeAuthRefusal([], FROM, true), "not_authenticated");
  assert.equal(intakeAuthRefusal(["mx.example.test; dmarc=pass header.from=acme.example.test"], FROM, true), null);
});

run("the switch reads 1/true/on/yes, anything else is off", () => {
  for (const v of ["1", "true", "ON", " yes "]) assert.ok(intakeRequiresAuth({ EMAIL_INTAKE_REQUIRE_AUTH: v }), v);
  for (const v of [undefined, "", "0", "false", "off", "required"]) assert.ok(!intakeRequiresAuth({ EMAIL_INTAKE_REQUIRE_AUTH: v }), String(v));
});

console.log(failures ? `\n${failures} failure(s)` : "\nintakeAuth: all checks passed");
process.exit(failures ? 1 : 0);
