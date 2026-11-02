// OPS TEST SEND (#493): ONE MESSAGE, TO THE ONE ADDRESS NAMED, AND THE SMTP SERVER'S OWN ANSWER.
//
// scripts/ops/test-email.ts is the runbook's proof that client email leaves the box. It drives REAL
// nodemailer against a fake SMTP server on this process's loop.
//
//   MUST-PASS    an accepted send exits 0 and prints the server's 250 line; the mail went to exactly
//                the --to address and carries PUBLIC_BASE_URL; sign-in is used when SMTP_USER is set.
//                A refusal prints the server's code and exits 1; a dead server exits 1 with its code.
//   MUST-EXCLUDE no --to, or a list / display-name / header-break address, is a usage error that
//                sends nothing; SMTP unset sends nothing and names the lines to add; SMTP_PASS never
//                appears in the output, even when the server echoes it back.
// Run: npx tsx backend/test/opsTestEmail.test.ts
import { REPO, ISOLATED_CWD } from "./_isolate";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net, { type AddressInfo } from "node:net";
import path from "node:path";

const PASSWORD = "smtp-pw-Okonkwo-5512";
let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// A fake SMTP server: records envelopes and data, signs in anyone, and refuses RCPT for
// refuse@ops.invalid with an answer that echoes the password (a hostile/buggy server).
interface Session { auth: string; rcpt: string[]; data: string }
const sessions: Session[] = [];
const smtp = net.createServer((sock) => {
  const s: Session = { auth: "", rcpt: [], data: "" };
  sessions.push(s);
  let buf = "";
  let inData = false;
  sock.write("220 fake.smtp.invalid ESMTP\r\n");
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\r\n")) >= 0) {
      const lineIn = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (inData) {
        if (lineIn === ".") {
          // Quoted-printable soft-wraps long lines ("=\n"): decode, so assertions see what a person reads.
          inData = false;
          s.data = Buffer.from(s.data.replace(/=\n/g, "").replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8");
          sock.write("250 2.0.0 Ok: queued as TEST493\r\n");
        }
        else s.data += `${lineIn}\n`;
        continue;
      }
      const cmd = lineIn.slice(0, 4).toUpperCase();
      if (cmd === "EHLO") sock.write("250-fake.smtp.invalid\r\n250 AUTH PLAIN LOGIN\r\n");
      else if (cmd === "HELO") sock.write("250 fake.smtp.invalid\r\n");
      else if (cmd === "AUTH") { s.auth = lineIn; sock.write("235 2.7.0 Authentication successful\r\n"); }
      else if (cmd === "RCPT") {
        const to = /<([^>]*)>/.exec(lineIn)?.[1] ?? "";
        if (to === "refuse@ops.invalid") sock.write(`550 5.1.1 <${to}> rejected for login ${PASSWORD}\r\n`);
        else { s.rcpt.push(to); sock.write("250 OK\r\n"); }
      }
      else if (cmd === "DATA") { inData = true; sock.write("354 go ahead\r\n"); }
      else if (cmd === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
      else sock.write("250 OK\r\n");
    }
  });
});
await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
const port = String((smtp.address() as AddressInfo).port);

const outputs: string[] = [];
// spawn, not spawnSync: the fake server lives on THIS process's event loop. A clean environment:
// only what the scenario names, so a developer's own SMTP_* can never be used.
const run = (argv: string[], env: Record<string, string>): Promise<{ code: number; out: string }> => new Promise((resolve) => {
  const base: Record<string, string> = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", TEMP: process.env.TEMP ?? "", TMP: process.env.TMP ?? "" };
  const child = spawn(process.execPath, [path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs"), path.join(REPO, "scripts", "ops", "test-email.ts"), ...argv],
    { cwd: ISOLATED_CWD, env: { ...base, ...env } });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const timer = setTimeout(() => child.kill(), 120_000);
  child.on("close", (code) => { clearTimeout(timer); outputs.push(out); resolve({ code: code ?? -1, out }); });
});
const SMTP = {
  SMTP_HOST: "127.0.0.1", SMTP_PORT: port, SMTP_SECURE: "false", SMTP_FROM: "Keelix <updates@ops.invalid>",
  SMTP_USER: "updates@ops.invalid", SMTP_PASS: PASSWORD,
  PUBLIC_BASE_URL: "https://keelix.ops.invalid", WATCHDOG_NAME: "Keelix test box",
};

console.log("test-email: an accepted send");
let r = await run(["--to", "owner@ops.invalid"], SMTP);
check("exits 0 and prints the server's own answer line", () => {
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /answer\s+250 2\.0\.0 Ok: queued as TEST493/);
  assert.match(r.out, /TEST EMAIL: ACCEPTED/);
});
check("one message, to exactly the --to address, signed in with SMTP_USER", () => {
  const sent = sessions.filter((s) => s.data);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].rcpt, ["owner@ops.invalid"]);
  assert.match(sent[0].auth, /^AUTH (PLAIN|LOGIN)/);
});
check("the message names the server and the address client links will start with", () => {
  const data = sessions.filter((s) => s.data)[0].data;
  assert.match(data, /Subject: Keelix test message from Keelix test box/);
  assert.match(data, /Links in client emails will start with: https:\/\/keelix\.ops\.invalid/);
});
r = await run(["--to", "owner@ops.invalid"], { ...SMTP, PUBLIC_BASE_URL: "" });
check("with PUBLIC_BASE_URL unset the message says the links would be dead", () => {
  assert.equal(r.code, 0, r.out);
  assert.match(sessions.filter((s) => s.data).at(-1)!.data, /PUBLIC_BASE_URL is NOT set/);
});

console.log("test-email: refusals are reported, with the server's code");
const before = sessions.filter((s) => s.data).length;
r = await run(["--to", "refuse@ops.invalid"], SMTP);
check("a refused recipient exits 1 and prints the 550 answer", () => {
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /answer\s+550 5\.1\.1/);
  assert.match(r.out, /TEST EMAIL: NOT SENT/);
  assert.equal(sessions.filter((s) => s.data).length, before);
});
check("MUST-EXCLUDE: the password the server echoed back is scrubbed", () => {
  assert.ok(!r.out.includes(PASSWORD), r.out);
  assert.match(r.out, /\[redacted\]/);
});
r = await run(["--to", "owner@ops.invalid"], { ...SMTP, SMTP_PORT: "1" });
check("a server that does not answer exits 1 with the error code", () => {
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NOT SENT/);
  assert.match(r.out, /\[(ECONNREFUSED|ESOCKET|ECONNECTION|ETIMEDOUT)\]/);
});

console.log("test-email: what it refuses to do");
const sentBefore = sessions.length;
for (const [label, argv] of [
  ["no --to", []],
  ["--to with no address", ["--to"]],
  ["a list of addresses", ["--to", "a@ops.invalid,b@ops.invalid"]],
  ["a display name", ["--to", "Owner <owner@ops.invalid>"]],
  ["a header break", ["--to", "owner@ops.invalid\r\nBcc: x@ops.invalid"]],
] as [string, string[]][]) {
  r = await run(argv, SMTP);
  check(`MUST-EXCLUDE: ${label} is a usage error (exit 2) and sends nothing`, () => {
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /usage:/);
  });
}
r = await run(["--to", "owner@ops.invalid"], { PUBLIC_BASE_URL: "https://keelix.ops.invalid", SMTP_FROM: "x@ops.invalid" });
check("MUST-EXCLUDE: SMTP unset sends nothing, exits 1 and names the lines to add", () => {
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /SMTP is not configured.*drafts/);
  assert.match(r.out, /SMTP_HOST=<server>/);
});
check("...and none of those runs opened a connection", () => assert.equal(sessions.length, sentBefore));
check("MUST-EXCLUDE: SMTP_PASS appears in no output", () => assert.ok(!outputs.join("\n").includes(PASSWORD)));

smtp.close();
if (failures) { console.error(`\n${failures} test-email check(s) FAILED.`); process.exit(1); }
console.log("\nAll test-email checks passed.");
