// WHO IS FILING: THE INSTALLER COMPANY AND THE EXISTING CONTACT ARE THIS CLIENT'S, OR THE RUN STOPS
// (#518) — real Chromium, the real PowerClerkAdapter.fillApplication.
//
// The PGE adapter selected the "Installer Company" option whose label was exactly the client's name,
// and when there was none it selected the list's FIRST option and moved on — no error, nothing on the
// review banner. On a shared filing account that list holds every client, so a name that did not
// match exactly was an application filed under another company. The existing-contact select swallowed
// a miss the same way. A SYNTHETIC copy of the wizard (preparer -> customer -> installer company ->
// system page; no customer data):
//
//   [A] the client's company is not on the list -> fillApplication fails naming the company and
//       "Installer Company"; the run never clicks Next on that page; nothing was selected (the first
//       option, another company, is never chosen);
//   [B] the list spells the client's name with other case/punctuation ("REPLAY TRUST SOLAR, LLC") ->
//       that option is chosen and the run goes on; the client's contact code is NOT on the system
//       page's existing-contact list -> the run stops there naming "Existing contact", nothing selected;
//   [C] a longer name that only starts with the client's ("Replay Trust Solar Pros") is not the client;
//   [D] helpers: two options that read as the client stop the run; no list stops it; an empty company
//       stops it; a contact code on the list (by value or label) is selected and read back.
//
// KILL (verified by hand): restore the `selectOption({ index: 1 })` fallback at the call site ->
// [A] FAILS (the run selects "Other Solar Co" and leaves the page).
//
//   npx tsx portal-bot/src/adapters/powerClerkInstallerCompany.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import type { ProjectRecord } from "../../../shared/src/types";
import { PowerClerkAdapter, selectExistingContact, selectInstallerCompany } from "./powerClerk";

process.env.POWERCLERK_SETTLE_MS = "1";
process.env.POWERCLERK_SECTION_READY_MS = "3000";

let failures = 0;
const check = async (label: string, fn: () => Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const assert = (cond: unknown, msg: string): void => { if (!cond) throw new Error(msg); };

const COMPANY = "Replay Trust Solar LLC";
const opts = (labels: string[]): string =>
  `<option value="">Select...</option>${labels.map((l, i) => `<option value="v${i + 1}">${l}</option>`).join("")}`;

// Each case is its own wizard under /<case>/.
const CASES: Record<string, { companies: string[]; contacts: string[] }> = {
  A: { companies: ["Other Solar Co", "Third Solar LLC"], contacts: [] },
  B: { companies: ["Other Solar Co", "REPLAY TRUST SOLAR, LLC"], contacts: ["Other Solar Co contact (OC-1)"] },
  C: { companies: ["Replay Trust Solar Pros", "Other Solar Co"], contacts: [] },
};
const page = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;
const next = (href: string): string => `<a href="${href}">Next</a>`;
const server = http.createServer((req, res) => {
  const m = /^\/([A-Z])\/p(\d)/.exec(String(req.url));
  const c = m ? CASES[m[1]] : undefined;
  res.setHeader("content-type", "text/html");
  if (!m || !c) { res.statusCode = 404; res.end("nope"); return; }
  const base = `/${m[1]}`;
  switch (m[2]) {
    case "1": res.end(page(`<h2>Preparer Information</h2><input placeholder="Company"><input placeholder="Email">${next(`${base}/p2`)}`)); return;
    case "2": res.end(page(`<fieldset><legend>PGE Customer Information</legend><label for="st">State</label><select id="st"><option value="">Select</option><option value="OR">OR</option><option value="WA">WA</option></select><input placeholder="Zip Code"></fieldset>${next(`${base}/p3`)}`)); return;
    case "3": res.end(page(`<h2>Installer</h2><label for="ic">Installer Company</label><select id="ic">${opts(c.companies)}</select>`
      + `<button type="button" onclick="sessionStorage.setItem('ic', document.getElementById('ic').selectedOptions[0].textContent); location.href='${base}/p4'">Next</button>`)); return;
    case "4": res.end(page(`<h2>System</h2><label for="ec">Existing contact to use for this contact</label><select id="ec"><option value="">New Contact</option>${c.contacts.map((l, i) => `<option value="OC-${i + 1}">${l}</option>`).join("")}</select><input aria-label="Main Service Entrance Rating">`)); return;
    default: res.statusCode = 404; res.end("nope");
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const browser = await chromium.launch();
const project = (company: string, contact = ""): ProjectRecord => ({
  id: "installer-company-smoke", clientId: "client-1", homeownerName: "", projectAddress: "", city: "", state: "OR", zip: "",
  ahj: "Testville", utility: "PGE", accountNumber: "", meterNumber: "",
  parserSnapshot: {
    installerCompanyName: company, installerEmail: "ops@replaytrust.test",
    ...(contact ? { powerclerkExistingContact: contact } : {}),
  },
} as unknown as ProjectRecord);

const runCase = async (key: string, proj: ProjectRecord) => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(`${origin}/${key}/p1`);
  const adapter = new PowerClerkAdapter();
  (adapter as unknown as { page: unknown }).page = p;
  // Bounded: a run that does NOT stop walks on through every later page (minutes of timeouts), so
  // past 45s it counts as "did not stop" and the checks below go red instead of hanging.
  const result = await Promise.race([
    adapter.fillApplication(proj),
    new Promise<{ ok: boolean; message: string }>((r) => setTimeout(() => r({ ok: true, message: "TIMED OUT — the run did not stop" }), 45_000)),
  ]);
  const url = p.url();
  const ic = await p.evaluate(() => sessionStorage.getItem("ic")).catch(() => null);
  const valueOf = async (sel: string) => ((await p.locator(sel).count()) ? p.locator(sel).inputValue({ timeout: 2000 }) : null);
  const icNow = await valueOf("#ic");
  const ecNow = await valueOf("#ec");
  await ctx.close();
  return { result, url, ic, icNow, ecNow };
};

try {
  await check("[A] company not on the list: the run stops on that page, names the company, selects nothing", async () => {
    const r = await runCase("A", project(COMPANY));
    assert(!r.result.ok, `run reported ok: ${r.result.message}`);
    assert(/Installer Company/.test(r.result.message), r.result.message);
    assert(r.result.message.includes(COMPANY), `company not named: ${r.result.message}`);
    assert(r.url.endsWith("/A/p3"), `the run left the installer page: ${r.url}`);
    assert(r.icNow === "", `something was selected: ${r.icNow}`);
    assert(r.ic === null, `Next was clicked with "${r.ic}" selected`);
  });

  await check("[B] the client's name with other case/punctuation is chosen; a contact code not on the list stops the run", async () => {
    const r = await runCase("B", project(COMPANY, "PGE-CONTACT-11"));
    assert(r.ic === "REPLAY TRUST SOLAR, LLC", `installer page saved with "${r.ic}"`);
    assert(r.url.endsWith("/B/p4"), `run not on the system page: ${r.url}`);
    assert(!r.result.ok, `run reported ok: ${r.result.message}`);
    assert(/Existing contact/.test(r.result.message), r.result.message);
    assert(r.result.message.includes("PGE-CONTACT-11"), r.result.message);
    assert(r.ecNow === "", `a contact was selected: ${r.ecNow}`);
  });

  await check("[C] a longer name that only starts with the client's is not the client", async () => {
    const r = await runCase("C", project("Replay Trust Solar"));
    assert(!r.result.ok, `run reported ok: ${r.result.message}`);
    assert(/Installer Company/.test(r.result.message), r.result.message);
    assert(r.url.endsWith("/C/p3") && r.icNow === "", `url ${r.url}, selected ${r.icNow}`);
  });

  await check("[D] helpers: ambiguous, missing list, empty company stop; a listed contact is selected and read back", async () => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    const throws = async (fn: () => Promise<void>, re: RegExp, what: string) => {
      let msg = "";
      try { await fn(); } catch (e) { msg = e instanceof Error ? e.message : String(e); }
      assert(re.test(msg), `${what}: expected a stop matching ${re}, got "${msg}"`);
    };
    await p.setContent(page(`<label for="ic">Installer Company</label><select id="ic">${opts(["Replay Trust Solar LLC", "REPLAY TRUST SOLAR, LLC", "Other"])}</select>`));
    await selectInstallerCompany(p, COMPANY); // the exact label wins over a folded twin
    assert((await p.locator("#ic").inputValue()) === "v1", "exact label not chosen");
    await p.setContent(page(`<label for="ic">Installer Company</label><select id="ic">${opts(["Replay Trust Solar, LLC", "REPLAY TRUST SOLAR LLC"])}</select>`));
    await throws(() => selectInstallerCompany(p, COMPANY), /2 options/, "two folded matches");
    assert((await p.locator("#ic").inputValue()) === "", "an ambiguous list was answered");
    await p.setContent(page(`<p>No list here</p>`));
    await throws(() => selectInstallerCompany(p, COMPANY), /no Installer Company list/, "no list");
    await throws(() => selectInstallerCompany(p, ""), /no submitting company/, "empty company");
    await p.setContent(page(`<label for="ec">Existing contact to use for this contact</label><select id="ec"><option value="">New Contact</option><option value="OC-1">Other (OC-1)</option><option value="PGE-CONTACT-11">Replay Trust ops</option></select>`));
    await selectExistingContact(p, "PGE-CONTACT-11", COMPANY);
    assert((await p.locator("#ec").inputValue()) === "PGE-CONTACT-11", "listed contact not selected");
    await selectExistingContact(p, "Other (OC-1)", COMPANY); // a label is a match too
    assert((await p.locator("#ec").inputValue()) === "OC-1", "contact by label not selected");
    await p.setContent(page(`<p>No list here</p>`));
    await throws(() => selectExistingContact(p, "PGE-CONTACT-11", COMPANY), /no existing-contact list/, "no contact list");
    await ctx.close();
  });
} finally {
  await browser.close();
  server.close();
}

if (failures) { console.error(`\n${failures} installer-company smoke check(s) failed.`); process.exit(1); }
console.log("\nAll installer-company smoke checks passed.");
process.exit(0);
