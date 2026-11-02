// THE RECORDER CLI'S SERVER AUTH (#433): what `npm run portal:record` sends to the server.
//
//   MUST  read the recorder token and the Cloudflare Access pair from env, flags winning;
//         send the token as x-recorder-token (the header backend/src/recorderTokens.ts reads);
//         send the Access headers only as a complete pair; warn before a token crosses plain
//         http:// to another machine; say what to do on a 401 / 403.
//   MUST NOT add a single header with nothing set: with sign-in off the requests stay exactly
//         what they were before #433.
//
// Run: npx tsx portal-bot/src/recordRecipeAuth.test.ts
import assert from "node:assert/strict";
import { RECORDER_TOKEN_HEADER } from "../../backend/src/recorderTokens";
import { explainServerRefusal, readRecorderServerAuth, recorderRequestHeaders, tokenWouldTravelInPlainText } from "./recordRecipe";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};
const NONE = { token: "", cfAccessClientId: "", cfAccessClientSecret: "" };

check("nothing set: no auth headers at all (sign-in off works as today)", () => {
  const auth = readRecorderServerAuth(["node", "rec", "--scope", "ahj"], {});
  assert.deepEqual(auth, NONE);
  assert.deepEqual(recorderRequestHeaders(auth), {});
  assert.deepEqual(recorderRequestHeaders(auth, { json: true }), { "content-type": "application/json" });
});

check("the token and the Access pair come from the environment", () => {
  const auth = readRecorderServerAuth(["node", "rec"], { RECORDER_TOKEN: " rt_env ", CF_ACCESS_CLIENT_ID: "id.access", CF_ACCESS_CLIENT_SECRET: "secret-env" });
  assert.deepEqual(auth, { token: "rt_env", cfAccessClientId: "id.access", cfAccessClientSecret: "secret-env" });
  assert.deepEqual(recorderRequestHeaders(auth, { json: true }), {
    "content-type": "application/json",
    "x-recorder-token": "rt_env",
    "CF-Access-Client-Id": "id.access",
    "CF-Access-Client-Secret": "secret-env",
  });
});

check("flags win over the environment", () => {
  const auth = readRecorderServerAuth(
    ["node", "rec", "--token", "rt_flag", "--cf-access-client-id", "id.flag", "--cf-access-client-secret", "secret-flag"],
    { RECORDER_TOKEN: "rt_env", CF_ACCESS_CLIENT_ID: "id.env", CF_ACCESS_CLIENT_SECRET: "secret-env" },
  );
  assert.deepEqual(auth, { token: "rt_flag", cfAccessClientId: "id.flag", cfAccessClientSecret: "secret-flag" });
});

check("half an Access pair is never sent", () => {
  assert.deepEqual(recorderRequestHeaders({ ...NONE, cfAccessClientId: "id.only" }), {});
  assert.deepEqual(recorderRequestHeaders({ ...NONE, cfAccessClientSecret: "secret-only" }), {});
});

check("the header the CLI sends is the one the server reads", () => {
  assert.ok(RECORDER_TOKEN_HEADER in recorderRequestHeaders({ ...NONE, token: "rt_x" }));
});

check("a token over plain http:// to another machine is flagged; https and this machine are not", () => {
  const t = { ...NONE, token: "rt_x" };
  assert.equal(tokenWouldTravelInPlainText("http://keelix.example.test", t), true);
  assert.equal(tokenWouldTravelInPlainText("http://192.168.1.20:4173", t), true);
  assert.equal(tokenWouldTravelInPlainText("https://keelix.example.test", t), false);
  assert.equal(tokenWouldTravelInPlainText("http://localhost:4173", t), false);
  assert.equal(tokenWouldTravelInPlainText("http://127.0.0.1:4173", t), false);
  assert.equal(tokenWouldTravelInPlainText("http://[::1]:4173", t), false);
  assert.equal(tokenWouldTravelInPlainText("http://keelix.example.test", NONE), false, "no token, nothing to warn about");
});

check("a refusal says what to do", () => {
  assert.match(explainServerRefusal(401, NONE), /sign-in on[\s\S]*Recorder tokens[\s\S]*RECORDER_TOKEN/);
  assert.match(explainServerRefusal(401, { ...NONE, token: "rt_x" }), /refused your recorder token/);
  assert.match(explainServerRefusal(403, NONE), /CF_ACCESS_CLIENT_ID/);
  assert.equal(explainServerRefusal(500, NONE), "");
});

console.log(failures === 0 ? "\nrecordRecipeAuth: all checks passed" : `\nrecordRecipeAuth: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
