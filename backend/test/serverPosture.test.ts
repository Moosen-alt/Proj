// IS THIS SERVER SHARED? (#439) — the one answer the dashboard reads (via GET /api/auth/me) to hide
// or relabel the controls that read a path on the SERVER'S disk (MBOX Import Path, email watch,
// the folder scan, Launch record session). Pins:
//
//   SERVER_IS_SHARED=1/true                → shared, whatever else is set
//   SERVER_IS_SHARED=0/false               → not shared, whatever else is set
//   unset, sign-in on + non-loopback host  → shared (the hosted shape)
//   unset, anything else                   → not shared (the owner's own PC: nothing changes)
//   /api/auth/me carries the answer        → the frontend's only source
import assert from "node:assert/strict";
import { serverIsShared } from "../src/serverPosture";

let failures = 0;
const check = (label: string, fn: () => void | Promise<void>): Promise<void> =>
  Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok   - ${label}`))
    .catch((e) => { failures++; console.log(`FAIL - ${label}\n       ${e instanceof Error ? e.message : String(e)}`); });

await check("default (nothing set) is NOT shared — the owner's own install is unchanged", () => {
  assert.equal(serverIsShared({}), false);
});

await check("SERVER_IS_SHARED=1 / true / TRUE turns it on, even on loopback with sign-in off", () => {
  for (const v of ["1", "true", "TRUE", " 1 "]) assert.equal(serverIsShared({ SERVER_IS_SHARED: v }), true, v);
});

await check("sign-in on + a non-loopback SERVER_HOST is detected as shared", () => {
  assert.equal(serverIsShared({ AUTH_ENABLED: "true", SERVER_HOST: "0.0.0.0" }), true);
  assert.equal(serverIsShared({ AUTH_ENABLED: "TRUE", SERVER_HOST: "10.0.0.5" }), true);
});

await check("detection needs BOTH: sign-in off or a loopback host is not shared", () => {
  assert.equal(serverIsShared({ AUTH_ENABLED: "true" }), false, "auth on, default host");
  for (const h of ["127.0.0.1", "::1", "localhost"]) {
    assert.equal(serverIsShared({ AUTH_ENABLED: "true", SERVER_HOST: h }), false, h);
  }
  assert.equal(serverIsShared({ SERVER_HOST: "0.0.0.0", ALLOW_UNAUTHENTICATED_NETWORK: "1" }), false, "auth off");
  assert.equal(serverIsShared({ AUTH_ENABLED: "false", SERVER_HOST: "0.0.0.0" }), false, "auth explicitly off");
});

await check("SERVER_IS_SHARED=0 / false overrides the detection", () => {
  for (const v of ["0", "false", "FALSE"]) {
    assert.equal(serverIsShared({ SERVER_IS_SHARED: v, AUTH_ENABLED: "true", SERVER_HOST: "0.0.0.0" }), false, v);
  }
});

await check("an unrecognised SERVER_IS_SHARED value falls back to the detection", () => {
  assert.equal(serverIsShared({ SERVER_IS_SHARED: "yes-please" }), false);
  assert.equal(serverIsShared({ SERVER_IS_SHARED: "", AUTH_ENABLED: "true", SERVER_HOST: "0.0.0.0" }), true);
});

await check("GET /api/auth/me carries serverIsShared, read from the process env at call time", async () => {
  // auth.ts reads AUTH_ENABLED at import; with it off, me() touches neither the db nor the request.
  delete process.env.AUTH_ENABLED;
  const { me } = await import("../src/auth");
  const call = (): Record<string, unknown> => {
    let body: Record<string, unknown> = {};
    const res = { json: (b: Record<string, unknown>) => { body = b; } };
    me(null as never, {} as never, res as never);
    return body;
  };
  const before = process.env.SERVER_IS_SHARED;
  try {
    process.env.SERVER_IS_SHARED = "1";
    assert.deepEqual(call(), { enabled: false, user: null, serverIsShared: true });
    delete process.env.SERVER_IS_SHARED;
    assert.deepEqual(call(), { enabled: false, user: null, serverIsShared: false });
  } finally {
    if (before === undefined) delete process.env.SERVER_IS_SHARED;
    else process.env.SERVER_IS_SHARED = before;
  }
});

if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall serverPosture checks passed");
