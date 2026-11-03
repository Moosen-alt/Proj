// PREFLIGHT ON THE LINUX SERVER: TRUST_PROXY, CLOUDFLARE ACCESS, AND NO WINDOWS-ONLY ADVICE (#437).
//
//   MUST-PASS    TRUST_PROXY=uniquelocal in a container, a hop count, or loopback on a bare host
//                are PASS; Access answering /health with its sign-in redirect and /status reaching
//                the app's page is PASS on both probe lines.
//   MUST-EXCLUDE TRUST_PROXY unset INSIDE a container (every teammate one address: one person's
//                typos lock the team out) and `true` (client-written X-Forwarded-For dodges the
//                lockout) are not PASS; the app's own /health answering from outside is a FAIL (no
//                Access in front); /status bounced to the Cloudflare sign-in is a FAIL (customer
//                links dead); Windows-only advice (firewall Public profile, install-watchdog.ps1,
//                drive-letter "same drive") is not printed on Linux.
//
// The pure checks (backend/src/opsEdgePosture.ts) are pinned directly; the wiring is pinned by
// running scripts/ops/preflight.ts --probe-edge against a local stand-in for Cloudflare.
// Run: npx tsx backend/test/opsPreflightEdge.test.ts
import { REPO, ISOLATED_CWD } from "./_isolate";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import type { ProbeAnswer } from "../src/opsEdgePosture";
const { classifyEdgeProbe, exposedHostAdvice, trustProxyRow, watchdogInstallHint } = await import("../src/opsEdgePosture");

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const linuxDocker = { platform: "linux", inContainer: true };
const linuxBare = { platform: "linux", inContainer: false };
const windows = { platform: "win32", inContainer: false };

console.log("edge posture: TRUST_PROXY");
await check("MUST-EXCLUDE: unset inside a container is a WARN that names uniquelocal", () => {
  const r = trustProxyRow({}, linuxDocker);
  assert.equal(r.verdict, "WARN");
  assert.match(r.detail, /TRUST_PROXY=uniquelocal/);
});
await check("unset on a bare host (tunnel on this machine, loopback hop) is a PASS", () => {
  assert.equal(trustProxyRow({}, linuxBare).verdict, "PASS");
  assert.equal(trustProxyRow({}, windows).verdict, "PASS");
});
await check("MUST-EXCLUDE: true (trust every hop) is a WARN, any case", () => {
  assert.equal(trustProxyRow({ TRUST_PROXY: "true" }, linuxDocker).verdict, "WARN");
  assert.equal(trustProxyRow({ TRUST_PROXY: " TRUE " }, linuxBare).verdict, "WARN");
});
await check("MUST-EXCLUDE: false (headers ignored) is a WARN", () => {
  assert.equal(trustProxyRow({ TRUST_PROXY: "false" }, linuxDocker).verdict, "WARN");
});
await check("uniquelocal, a hop count and a CIDR are PASS", () => {
  for (const v of ["uniquelocal", "1", "172.16.0.0/12", "loopback, uniquelocal"]) {
    assert.equal(trustProxyRow({ TRUST_PROXY: v }, linuxDocker).verdict, "PASS", v);
  }
});

console.log("edge posture: wording per platform");
await check("Windows keeps its firewall-profile and scheduled-task advice", () => {
  assert.match(exposedHostAdvice(windows), /Public profile/);
  assert.match(watchdogInstallHint(windows), /install-watchdog\.ps1/);
});
await check("MUST-EXCLUDE: Linux never gets the Windows advice", () => {
  for (const s of [linuxDocker, linuxBare]) {
    assert.doesNotMatch(exposedHostAdvice(s), /Public profile/);
    assert.doesNotMatch(watchdogInstallHint(s), /\.ps1/);
  }
  assert.match(exposedHostAdvice(linuxDocker), /127\.0\.0\.1 only/);
  assert.match(watchdogInstallHint(linuxBare), /keelix-watchdog\.timer/);
});

console.log("edge posture: the outside probe");
const answer = (o: Partial<ProbeAnswer>): ProbeAnswer => ({ status: 200, location: "", contentType: "", viaCloudflare: true, bodyStart: "", ...o });
const accessRedirect = answer({ status: 302, location: "https://keelix.cloudflareaccess.com/cdn-cgi/access/login/keelix.example.com?kid=x" });
const appHealth = answer({ contentType: "application/json", bodyStart: '{"ok":true,"service":"Solar Submission Autopilot","version":"x"}' });
const appStatusPage = answer({ contentType: "text/html; charset=UTF-8", bodyStart: "<!doctype html>" });
const verdicts = (rows: { check: string; verdict: string }[]): Record<string, string> => Object.fromEntries(rows.map((r) => [r.check, r.verdict]));
await check("Access in front + bypass working: PASS on every line", () => {
  assert.deepEqual(verdicts(classifyEdgeProbe(accessRedirect, appStatusPage)),
    { "Access on staff paths": "PASS", "Access bypass": "PASS", "via Cloudflare": "PASS" });
});
await check("MUST-EXCLUDE: the app's own /health from outside is a FAIL (no Access in front)", () => {
  assert.equal(verdicts(classifyEdgeProbe(appHealth, appStatusPage))["Access on staff paths"], "FAIL");
});
await check("MUST-EXCLUDE: /status bounced to the Cloudflare sign-in is a FAIL (customer links dead)", () => {
  assert.equal(verdicts(classifyEdgeProbe(accessRedirect, accessRedirect))["Access bypass"], "FAIL");
});
await check("no answer, or an answer that is neither, is a WARN (never a PASS)", () => {
  const v = verdicts(classifyEdgeProbe(null, answer({ status: 502 })));
  assert.equal(v["Access on staff paths"], "WARN");
  assert.equal(v["Access bypass"], "WARN");
  assert.equal(verdicts(classifyEdgeProbe(answer({ status: 403 }), null))["Access on staff paths"], "WARN");
});
await check("MUST-EXCLUDE: a redirect to the app's own /login is not mistaken for Access", () => {
  assert.equal(verdicts(classifyEdgeProbe(answer({ status: 302, location: "/login" }), appStatusPage))["Access on staff paths"], "WARN");
});
await check("no cf-ray on any answer: WARN, not answered through Cloudflare", () => {
  const v = verdicts(classifyEdgeProbe({ ...accessRedirect, viaCloudflare: false }, { ...appStatusPage, viaCloudflare: false }));
  assert.equal(v["via Cloudflare"], "WARN");
});

// --- the wiring: preflight --probe-edge against a stand-in edge --------------------------------
// 127.0.0.2 is loopback on Linux and Windows, and preflight does not count it as "this machine's
// localhost" the way it does 127.0.0.1, so it stands in for a public hostname here.
function standIn(mode: "access" | "open"): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    res.setHeader("cf-ray", "8f00000000000000-SEA");
    if (req.url === "/health") {
      if (mode === "access") { res.writeHead(302, { location: "https://keelix.cloudflareaccess.com/cdn-cgi/access/login/x" }); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true,"service":"Solar Submission Autopilot"}'); return;
    }
    if (req.url === "/status") { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>Status</title>"); return; }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.2", () => {
    resolve({ url: `http://127.0.0.2:${(server.address() as AddressInfo).port}`, close: () => server.close() });
  }));
}
function preflight(env: Record<string, string>, args: string[]): Promise<string> {
  const base: Record<string, string> = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", TEMP: process.env.TEMP ?? "", TMP: process.env.TMP ?? "" };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs"), path.join(REPO, "scripts", "ops", "preflight.ts"), ...args], {
      cwd: ISOLATED_CWD, env: { ...base, ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const t = setTimeout(() => child.kill(), 120_000);
    child.on("close", () => { clearTimeout(t); resolve(out); });
  });
}
const line = (out: string, name: string): string => out.split(/\r?\n/).find((l) => new RegExp(`^\\s+(PASS|WARN|FAIL)\\s+${name}\\s`).test(l)) ?? `<no line for ${name}>`;
const backupDir = path.join(ISOLATED_CWD, "edge-backups");
fs.mkdirSync(backupDir, { recursive: true });
const common = { AUTOPILOT_DB_PATH: path.join(ISOLATED_CWD, "none.sqlite"), BACKUP_DIR: backupDir, AUTH_ENABLED: "true", TRUST_PROXY: "uniquelocal" };

console.log("edge posture: preflight wiring");
const behindAccess = await standIn("access");
const outA = await preflight({ ...common, PUBLIC_BASE_URL: behindAccess.url, SERVER_HOST: "0.0.0.0" }, ["--probe-edge"]);
behindAccess.close();
await check("--probe-edge behind Access: both probe lines PASS", () => {
  assert.match(line(outA, "Access on staff paths"), /PASS/, outA);
  assert.match(line(outA, "Access bypass"), /PASS/);
});
await check("the TRUST_PROXY line is printed on every run", () => assert.match(line(outA, "TRUST_PROXY"), /PASS .*uniquelocal/));
await check(`the SERVER_HOST and watchdog advice match this platform (${process.platform})`, () => {
  if (process.platform === "win32") {
    assert.match(line(outA, "SERVER_HOST"), /Public profile/);
  } else {
    assert.doesNotMatch(line(outA, "SERVER_HOST"), /Public profile/);
    assert.doesNotMatch(line(outA, "watchdog running"), /\.ps1/);
  }
});
const wideOpen = await standIn("open");
const outO = await preflight({ ...common, PUBLIC_BASE_URL: wideOpen.url }, ["--probe-edge"]);
wideOpen.close();
await check("MUST-EXCLUDE: --probe-edge with no Access in front FAILs and exits 1", () => {
  assert.match(line(outO, "Access on staff paths"), /FAIL/, outO);
  assert.match(outO, /PREFLIGHT: \d+ FAIL/);
});
const outPlain = await preflight({ ...common, PUBLIC_BASE_URL: "https://keelix.example.invalid" }, []);
await check("without --probe-edge nothing is fetched (no probe lines)", () => {
  assert.doesNotMatch(outPlain, /Access on staff paths|Access bypass/);
});
if (process.platform !== "win32") {
  const second = path.join(ISOLATED_CWD, "edge-second");
  fs.mkdirSync(second, { recursive: true });
  fs.writeFileSync(path.join(second, `autopilot-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`), "x");
  const outSame = await preflight({ ...common, BACKUP_SECOND_DIR: second }, []);
  await check("MUST-EXCLUDE: on Linux a second dir on the database's own filesystem says so (device id, not drive letter)", () => {
    assert.match(line(outSame, "BACKUP_SECOND_DIR"), /same filesystem as the database or BACKUP_DIR: not off the box/);
    assert.doesNotMatch(line(outSame, "BACKUP_SECOND_DIR"), /cloud-synced/);
  });
}

if (failures) { console.error(`\n${failures} edge-posture check(s) FAILED.`); process.exit(1); }
console.log("\nAll edge-posture checks passed.");
