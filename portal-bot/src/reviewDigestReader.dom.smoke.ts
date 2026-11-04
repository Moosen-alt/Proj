// #436 PR1 — THE ONE READER, IN A REAL BROWSER: ARIA STATE CONTROLS AND SHADOW ROOTS (reviewDigest.ts).
//
// A skeptic flipped a role="radio" toggle, a role="switch" and a role="checkbox", and an input inside an
// OPEN shadow root, between two reads of the same page: the digest did not change and the page read
// approvable. Real target portals have this shape (ComEd's NEM drawer is Angular Material
// mat-button-toggles: <button role="radio" aria-checked>). Each pair below is the SAME page read
// twice with ONE change between the reads, served from 127.0.0.1 (never a real portal); the digest is
// built by the real builder with a fixed key and nonce.
//
//   MUST-PASS  stable: every page read twice with no change gives the same digest, approvable.
//   MUST-EXCL  aria-radio: a role=radio toggle in a radiogroup moves → a different digest; the item
//              reads "Application category: Net Billing" = checked.
//   MUST-EXCL  aria-switch / aria-checkbox / aria-pressed: each flipped alone → a different digest.
//   MUST-EXCL  aria-odd: aria-checked="yes" → "no" (no ARIA value) → a different digest (an unknown
//              value is kept as written, never read as "unchecked").
//   MUST-EXCL  aria-selected-row: a selectable table row's aria-selected flips → a different digest,
//              and its cells are still read.
//   MUST-EXCL  comed: the portal's own drawer markup, one mat-button-toggle's aria-checked flipped.
//   MUST-EXCL  shadow-input: an input inside an open shadow root 7.2 → 9.9 → a different digest, and
//              the input is read by its shadow label.
//   MUST-EXCL  shadow-text: a text line inside an open shadow root changes → a different digest
//              (body.innerText leaves shadow text out).
//   MUST-EXCL  closed: a page holding a CLOSED shadow root is refused by name, never hashed.
//
// Kill (each turns exactly its own check red): readDigestPageInPage: isAria → false → every aria-*
// and comed check reads the same digest. collect(): skip el.shadowRoot → shadow-input fails. Drop the
// shadowText pass → shadow-text fails. readDigestPage: skip closedShadowRootCount → closed reads
// approvable.
//
//   npx tsx portal-bot/src/reviewDigestReader.dom.smoke.ts
import "./smokeArtifactDirs";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { buildStagedReviewCapture, readDigestPage, type DigestKey, type RawDigestReading } from "./reviewDigest";

let failures = 0;
let total = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  total++;
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const COMED = fs.readFileSync(path.join(here, "adapters", "fixtures", "comed-drawer.html"), "utf8");
const KEY: DigestKey = { key: crypto.createHash("sha256").update("reader-smoke-key").digest(), keyId: "7070707070707070" };
const NONCE = "abcdefabcdefabcdefabcdefabcdef01";

const doc = (body: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>Review and Submit</title></head><body><h1>Review and Submit</h1>${body}</body></html>`;
const PAGES: Record<string, (q: URLSearchParams) => string> = {
  aria: (q) => doc(`
    <div role="radiogroup" aria-label="Application category">
      <button type="button" role="radio" aria-checked="${q.get("radio") === "1" ? "false" : "true"}">Net Metering</button>
      <button type="button" role="radio" aria-checked="${q.get("radio") === "1" ? "true" : "false"}">Net Billing</button>
    </div>
    <div><span id="swl">Export limiting</span> <button type="button" role="switch" aria-labelledby="swl" aria-checked="${q.get("sw") ?? "true"}" style="width:30px;height:16px"></button></div>
    <div><span role="checkbox" aria-checked="${q.get("cb") ?? "true"}" tabindex="0">I attest the system is islanding-protected</span></div>
    <div><button type="button" aria-pressed="${q.get("pr") ?? "false"}">Battery included</button></div>
    <div><span role="checkbox" aria-checked="${q.get("odd") ?? "yes"}" tabindex="0">Customer is the account holder</span></div>
    <table><tr><th>Meter</th><th>Location</th></tr><tr aria-selected="${q.get("row") ?? "true"}"><td>Main</td><td>North wall</td></tr></table>`),
  comed: (q) => {
    // The portal's own markup; flip the FIRST mat-button-toggle when asked.
    const html = q.get("flip") === "1" ? COMED.replace('aria-checked="false"', 'aria-checked="true"') : COMED;
    return html.replace("<body>", "<head><title>Review and Submit</title></head><body>");
  },
  shadow: (q) => doc(`
    <p>System details</p>
    <system-field></system-field>
    <script>
      customElements.define("system-field", class extends HTMLElement {
        connectedCallback() {
          const r = this.attachShadow({ mode: "open" });
          r.innerHTML = '<label>System Size (kW) <input value="${q.get("v") ?? "7.2"}"></label><p>Inverter: ${q.get("t") ?? "IQ8M"}</p>';
        }
      });
    </script>`),
  closed: () => doc(`
    <label>System Size (kW) <input value="7.2"></label>
    <sealed-field></sealed-field>
    <script>
      customElements.define("sealed-field", class extends HTMLElement {
        connectedCallback() { const r = this.attachShadow({ mode: "closed" }); r.innerHTML = '<label>Battery <input value="none"></label>'; }
      });
    </script>`),
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const make = PAGES[url.pathname.replace(/^\//, "")] as ((q: URLSearchParams) => string) | undefined;
  res.writeHead(make ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
  res.end(make ? make(url.searchParams) : "<h1>Not found</h1>");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const REVIEW = (p: string, q = "") => `${base}/${p}?ProjectId=QS6TY7QARSY7${q ? `&${q}` : ""}`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext()).newPage();
  const readAt = async (url: string): Promise<{ r: RawDigestReading; digest: string; approvable: boolean; why: string[] }> => {
    await page.goto(url, { waitUntil: "load" });
    const r = await readDigestPage(page);
    const c = buildStagedReviewCapture({
      walk: { sections: [{ step: "review", where: url, first: r, second: r, unreadable: r.unreadable }], reasons: [], stepsFound: 0, stepsRead: 0, writesBlocked: 0, reviewUrl: url },
      secrets: [], key: KEY, nonce: NONCE,
    });
    return { r, digest: c.digest, approvable: c.approvable, why: c.why };
  };
  const pair = async (label: string, p: string, q0: string, q1: string): Promise<void> => {
    const a = await readAt(REVIEW(p, q0));
    const b = await readAt(REVIEW(p, q1));
    check(`${label}: both reads approvable`, a.approvable && b.approvable, `${a.why.join("; ")} / ${b.why.join("; ")}`);
    check(`${label}: ONE change between two reads → a different digest`, a.digest !== "" && b.digest !== "" && a.digest !== b.digest, `${a.digest} vs ${b.digest}`);
  };

  console.log("\n1. MUST-PASS: each page, read twice unchanged, gives the same digest");
  for (const p of ["aria", "comed", "shadow"]) {
    const a = await readAt(REVIEW(p));
    const b = await readAt(REVIEW(p));
    check(`stable: ${p}`, a.approvable && a.digest !== "" && a.digest === b.digest, `${a.why.join("; ")} ${a.digest} vs ${b.digest}`);
  }

  console.log("\n2. MUST-EXCLUDE: an ARIA state control's change is seen");
  {
    const a = await readAt(REVIEW("aria", "radio=1"));
    const item = a.r.items.find((i) => i.label === "Application category: Net Billing");
    check("aria-radio: the toggle reads by its group and its own name, with its state", item?.value === "checked", JSON.stringify(a.r.items.filter((i) => i.kind === "check")));
    const sw = a.r.items.find((i) => i.label === "Export limiting");
    check("aria-switch: the switch reads by its aria-labelledby name", sw?.value === "checked", JSON.stringify(sw));
  }
  await pair("aria-radio", "aria", "", "radio=1");
  await pair("aria-switch", "aria", "", "sw=false");
  await pair("aria-checkbox", "aria", "", "cb=false");
  await pair("aria-pressed", "aria", "", "pr=true");
  await pair("aria-odd (aria-checked yes → no)", "aria", "", "odd=no");
  await pair("aria-selected-row", "aria", "", "row=false");
  {
    const a = await readAt(REVIEW("aria"));
    check("aria-selected-row: the row's cells are still read", a.r.items.some((i) => i.kind === "row" && i.label === "Main" && i.value === "North wall"), JSON.stringify(a.r.items.filter((i) => i.kind === "row")));
  }
  await pair("comed (the portal's own mat-button-toggle)", "comed", "", "flip=1");

  console.log("\n3. MUST-EXCLUDE: an open shadow root's input and text are read");
  {
    const a = await readAt(REVIEW("shadow"));
    check("shadow-input: the input is read by its shadow label", a.r.items.some((i) => i.kind === "field" && i.label === "System Size (kW)" && i.value === "7.2"), JSON.stringify(a.r.items));
  }
  await pair("shadow-input (7.2 → 9.9)", "shadow", "", "v=9.9");
  await pair("shadow-text (IQ8M → IQ8X)", "shadow", "", "t=IQ8X");

  console.log("\n4. MUST-EXCLUDE: a closed shadow root is refused by name");
  {
    const a = await readAt(REVIEW("closed"));
    check("closed: unreadable, named", a.r.unreadable === "the page holds 1 closed shadow root(s), whose controls a page script cannot read", a.r.unreadable);
    check("closed: not approvable, no digest, nothing hashed", !a.approvable && a.digest === "" && a.r.items.length === 0, `${a.approvable} ${a.digest}`);
  }
} finally {
  await browser.close().catch(() => null);
  server.close();
}

console.log(failures === 0 ? `\nAll ${total}/${total} reviewDigestReader checks passed.` : `\n${failures}/${total} reviewDigestReader check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
