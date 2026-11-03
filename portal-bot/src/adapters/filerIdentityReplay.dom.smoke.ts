// WHO IS FILING ON THE RECIPE / LEARN / GAP-FILL PATHS: THIS CLIENT'S COMPANY, OR THE RUN STOPS
// (#524) — real Chromium, the real RecipeAdapter.fillApplication, AutoLearnAdapter.applyFill and
// gapFillCurrentPage.
//
// #518 made the hand-coded PGE adapter take only this client's "Installer Company" option. Recipe
// replay (the path real NEM runs take), the learner and the gap-fill select through
// selectWithFallback, whose native pass takes the first option that CONTAINS the wanted text: a
// client "Sun Co" replayed onto "Sun Co Northwest" — another company on a shared filing account.
// A SYNTHETIC installer page (no customer data):
//
//   [A] replay, list holds "Sun Co Northwest" and no "Sun Co": the run fails naming "Sun Co" and the
//       control, nothing is selected, Next is never clicked;
//   [B] replay, the list spells it "SUN CO." : chosen (folded), the run reaches review — and a
//       non-identity select still takes the contains match ("Schedule 7" -> "Schedule 7 - Residential");
//   [C] replay, two options read as the client: stops, nothing selected;
//   [D] replay, the step is OPTIONAL: a miss still stops the run (never skipped as optional);
//   [E] replay, a contact code bound to powerclerkExistingContact matches only a longer code: stops;
//   [F] learner: a planner answer "Sun Co Northwest" bound to installerCompanyName selects nothing and
//       records nothing; an UNBOUND planner pick on an "Installer Company" list takes the client's own
//       name ("Sun Co." for "Sun Co") and is recorded BOUND to installerCompanyName;
//   [G] gap-fill: a grounded planner answer "Sun Co Northwest" (it "traces to" Sun Co) selects nothing
//       and is reported as refused;
//   [H] replay, an older recipe recorded the LEARN's company as a literal on the Installer Company list:
//       this client's own name is selected, never the recorded one;
//   [I] replay, "Replay Trust Solar LLC" takes "REPLAY TRUST SOLAR, LLC" (folded) over the longer
//       "Replay Trust Solar Pros" listed first; [J] "Replay Trust Solar" is refused "Replay Trust Solar Pros".
//
// KILL (verified by hand): drop `if (filerIdentity) return this.selectFilerIdentityStep(...)` and the
// literal-company rebinding in recipeAdapter.ts, the learner's filer guard and the gap-fill's -> every
// case but [B] FAILS ([A] [C] [D] [J]: "Sun Co Northwest" / "Replay Trust Solar Pros" selected and Next
// clicked; [H]: the learn's company selected; [F] [G]: the near match selected). [B] passes either way:
// it pins that the ordinary contains match still works for a select that is not a company.
//
//   npx tsx portal-bot/src/adapters/filerIdentityReplay.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";
import { AutoLearnAdapter, EXTRACT_SEL, toExtractedField, type ExtractedField, type LearnPlanner } from "./autoLearnAdapter";
import { gapFillCurrentPage } from "../llmGapFill";

let failures = 0;
const check = async (label: string, fn: () => Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const assert = (cond: unknown, msg: string): void => { if (!cond) throw new Error(msg); };

const opts = (labels: string[]): string =>
  `<option value="">Select...</option>${labels.map((l, i) => `<option value="v${i + 1}">${l}</option>`).join("")}`;
const CASES: Record<string, { companies: string[]; contacts?: string[] }> = {
  A: { companies: ["Sun Co Northwest", "Other Solar Co"] },
  B: { companies: ["Other Solar Co", "SUN CO."] },
  C: { companies: ["Sun Co", "SUN CO", "Other Solar Co"] },
  D: { companies: ["Sun Co Northwest"] },
  E: { companies: ["Sun Co"], contacts: ["PGE-110"] },
  F: { companies: ["Sun Co Northwest", "Other Solar Co", "Sun Co."] },
  G: { companies: ["Sun Co Northwest", "Other Solar Co"] },
  H: { companies: ["Other Solar Co", "Sun Co"] },
  I: { companies: ["Replay Trust Solar Pros", "REPLAY TRUST SOLAR, LLC"] },
  J: { companies: ["Replay Trust Solar Pros", "Other Solar Co"] },
};
const page = (c: string): string => {
  const k = CASES[c];
  const contacts = k.contacts
    ? `<label for="ec">Existing contact to use for this contact</label><select id="ec"><option value="">New Contact</option>${k.contacts.map((x) => `<option value="${x}">Sun Co contact (${x})</option>`).join("")}</select>`
    : "";
  return `<!doctype html><html><body><h2>Installer</h2><form onsubmit="return false">
    <label for="rs">Rate Schedule</label><select id="rs"><option value="">Select...</option><option value="s7">Schedule 7 - Residential</option><option value="s32">Schedule 32 - Small Commercial</option></select>
    <label for="ic">Installer Company</label><select id="ic" required>${opts(k.companies)}</select>
    ${contacts}
    <a href="/${c}/review" onclick="sessionStorage.setItem('ic', document.getElementById('ic').selectedOptions[0].textContent); sessionStorage.setItem('rs', document.getElementById('rs').selectedOptions[0].textContent)">Next</a>
  </form></body></html>`;
};
const server = http.createServer((req, res) => {
  const m = /^\/([A-Z])\/(form|review)/.exec(String(req.url));
  res.setHeader("content-type", "text/html");
  if (!m || !CASES[m[1]]) { res.statusCode = 404; res.end("nope"); return; }
  res.end(m[2] === "form" ? page(m[1]) : `<!doctype html><html><body><h1>Review your application</h1><p>Review and submit</p></body></html>`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const recipe = (c: string, opts2: { optional?: boolean; contact?: boolean; literal?: string } = {}): PortalRecipe => ({
  id: `filer-identity-${c}`, scopeType: "utility", profileKey: "or||pge", state: "OR", ahj: "", utility: "PGE",
  portalPlatform: "fixture", portalUrl: `${origin}/${c}/form`, status: "complete", version: 1, createdBy: "s", createdAt: "", updatedAt: "", notes: "",
  steps: [
    { action: "goto", value: `${origin}/${c}/form`, note: "open" },
    { action: "select", selector: { label: "Rate Schedule" }, value: "Schedule 7", note: "Rate Schedule" },
    { action: "select", selector: { label: "Installer Company" }, note: "Installer Company", ...(opts2.literal ? { value: opts2.literal } : { field: "installerCompanyName" }), ...(opts2.optional ? { optional: true } : {}) },
    ...(opts2.contact ? [{ action: "select", selector: { label: "Existing contact to use for this contact" }, field: "powerclerkExistingContact", note: "Existing contact" }] : []),
    { action: "click", selector: { role: "link", name: "Next", exact: true }, note: "advance: Next" },
    { action: "stopForReview" },
  ] as RecipeStep[],
} as unknown as PortalRecipe);

const browser = await chromium.launch();
const newPage = async () => {
  const ctx = await browser.newContext();
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  return { ctx, p: await ctx.newPage() };
};

const replay = async (c: string, values: Record<string, string>, o: { optional?: boolean; contact?: boolean; literal?: string } = {}) => {
  const { ctx, p } = await newPage();
  const adapter = new RecipeAdapter(recipe(c, o), values, {}, {} as never);
  (adapter as unknown as { page: unknown }).page = p;
  const result = await Promise.race([
    adapter.fillApplication({} as ProjectRecord).catch((e) => ({ ok: false, message: String(e) })),
    new Promise<{ ok: boolean; message: string }>((r) => setTimeout(() => r({ ok: true, message: "TIMED OUT — the run did not stop" }), 90_000)),
  ]);
  const url = p.url();
  const next = await p.evaluate(() => sessionStorage.getItem("ic")).catch(() => null);
  const nextRs = await p.evaluate(() => sessionStorage.getItem("rs")).catch(() => null);
  const read = async (sel: string) => ((await p.locator(sel).count()) ? p.locator(sel).evaluate((el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent ?? "") : null);
  const ic = await read("#ic");
  const rs = await read("#rs");
  const ec = await read("#ec");
  await ctx.close();
  return { result: result as { ok: boolean; message: string }, url, next, nextRs, ic, rs, ec };
};

try {
  await check("[A] replay: \"Sun Co\" is not on the list — the run stops naming it, nothing selected, Next never clicked", async () => {
    const r = await replay("A", { installerCompanyName: "Sun Co" });
    assert(!r.result.ok, `run reported ok: ${r.result.message}`);
    assert(r.result.message.includes("\"Sun Co\"") && /Installer Company/.test(r.result.message), r.result.message);
    assert(r.ic === "Select...", `selected: ${r.ic}`);
    assert(r.next === null && r.url.endsWith("/A/form"), `Next clicked (${r.next}) / left the page (${r.url})`);
    console.log(`         (the run said: ${r.result.message.slice(0, 260)})`);
  });

  await check("[B] replay: \"SUN CO.\" is the client folded — chosen, run reaches review; Schedule 7 still takes the contains match", async () => {
    const r = await replay("B", { installerCompanyName: "Sun Co" });
    assert(r.next === "SUN CO.", `Next saw "${r.next}" (message: ${r.result.message})`);
    assert(r.url.endsWith("/B/review"), `not on review: ${r.url} (${r.result.message})`);
    assert(r.result.ok, `run failed: ${r.result.message}`);
    assert(r.nextRs === "Schedule 7 - Residential", `schedule saved as: ${r.nextRs}`);
  });

  await check("[C] replay: two options read as the client — stops, nothing selected", async () => {
    const r = await replay("C", { installerCompanyName: "Sun Co." });
    assert(!r.result.ok && /2 options/.test(r.result.message), r.result.message);
    assert(r.ic === "Select..." && r.next === null, `selected ${r.ic}, next ${r.next}`);
  });

  await check("[D] replay: an OPTIONAL company step that misses still stops the run", async () => {
    const r = await replay("D", { installerCompanyName: "Sun Co" }, { optional: true });
    assert(!r.result.ok && r.result.message.includes("\"Sun Co\""), r.result.message);
    assert(r.ic === "Select..." && r.next === null, `selected ${r.ic}, next ${r.next}`);
  });

  await check("[E] replay: contact code PGE-11 matches only PGE-110 — stops naming the code, no contact chosen", async () => {
    const r = await replay("E", { installerCompanyName: "Sun Co", powerclerkExistingContact: "PGE-11" }, { contact: true });
    assert(!r.result.ok && r.result.message.includes("PGE-11") && /Existing contact/.test(r.result.message), r.result.message);
    assert(r.ic === "Sun Co", `company: ${r.ic}`);
    assert(r.ec === "New Contact" && r.next === null, `contact ${r.ec}, next ${r.next}`);
  });

  await check("[H] replay: a recorded LITERAL company (the learn's) on the Installer Company list — this client's name is selected instead", async () => {
    const r = await replay("H", { installerCompanyName: "Sun Co" }, { literal: "Other Solar Co" });
    assert(r.next === "Sun Co", `Next saw "${r.next}" (message: ${r.result.message})`);
    assert(r.result.ok, `run failed: ${r.result.message}`);
  });

  await check("[I] replay: \"Replay Trust Solar LLC\" takes \"REPLAY TRUST SOLAR, LLC\", never the \"Replay Trust Solar Pros\" listed first", async () => {
    const r = await replay("I", { installerCompanyName: "Replay Trust Solar LLC" });
    assert(r.next === "REPLAY TRUST SOLAR, LLC", `Next saw "${r.next}" (message: ${r.result.message})`);
    assert(r.result.ok, `run failed: ${r.result.message}`);
  });

  await check("[J] replay: \"Replay Trust Solar\" is not \"Replay Trust Solar Pros\" — stops, nothing selected", async () => {
    const r = await replay("J", { installerCompanyName: "Replay Trust Solar" });
    assert(!r.result.ok && r.result.message.includes("\"Replay Trust Solar\""), r.result.message);
    assert(r.ic === "Select..." && r.next === null, `selected ${r.ic}, next ${r.next}`);
  });

  type Internals = {
    extractAllFrames(sel: string): Promise<Array<Parameters<typeof toExtractedField>[0]>>;
    applyFill(f: ExtractedField, r: { value: string; field?: string }, s: boolean): Promise<RecipeStep | null>;
    filerIdentityRefused: string[];
  };
  const learnOn = async (c: string, company: string, fillReq: { value: string; field?: string }) => {
    const { ctx, p } = await newPage();
    await p.goto(`${origin}/${c}/form`);
    const planner = (async () => ({ fills: [], atReview: false })) as unknown as LearnPlanner;
    const adapter = new AutoLearnAdapter("PGE PowerClerk", planner, { policyProfile: "residential_nem", contactIdentity: { companyName: company } } as never);
    (adapter as unknown as { page: unknown }).page = p;
    const internals = adapter as unknown as Internals;
    const fields = (await internals.extractAllFrames(EXTRACT_SEL)).map(toExtractedField);
    const f = fields.find((x) => /installer company/i.test(x.label));
    assert(f, `no Installer Company field extracted: ${fields.map((x) => x.label).join(", ")}`);
    const step = await internals.applyFill(f!, fillReq, false);
    const ic = await p.locator("#ic").evaluate((el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent ?? "");
    const refused = [...(internals.filerIdentityRefused ?? [])];
    await ctx.close();
    return { step, ic, refused, fillReq };
  };

  await check("[F] learner: a bound \"Sun Co Northwest\" answer selects and records nothing; an unbound pick on the list takes the client's own name, BOUND", async () => {
    const bad = await learnOn("A", "Sun Co", { value: "Sun Co Northwest", field: "installerCompanyName" });
    assert(bad.step === null, `a step was recorded: ${JSON.stringify(bad.step)}`);
    assert(bad.ic === "Select...", `selected: ${bad.ic}`);
    assert(bad.refused.some((m) => m.includes("\"Sun Co\"")), `refusal not said: ${JSON.stringify(bad.refused)}`);
    const pick = await learnOn("F", "Sun Co", { value: "Other Solar Co" });
    assert(pick.ic === "Sun Co.", `selected: ${pick.ic}`);
    assert(pick.step?.field === "installerCompanyName" && !pick.step?.value, `step: ${JSON.stringify(pick.step)}`);
    assert(pick.fillReq.value === "Sun Co.", `the read-back would ask for "${pick.fillReq.value}"`);
  });

  await check("[G] gap-fill: a grounded \"Sun Co Northwest\" answer for the company selects nothing and is reported refused", async () => {
    const { ctx, p } = await newPage();
    await p.goto(`${origin}/G/form`);
    const planner = (async (req: { fields: ExtractedField[] }) => ({
      fills: req.fields.map((f, i) => (/installer company/i.test(f.label) ? { selectorIndex: i, value: "Sun Co Northwest", field: "installerCompanyName" } : null)).filter(Boolean),
      atReview: false,
    })) as unknown as LearnPlanner;
    const out = await gapFillCurrentPage(p, planner, { installerCompanyName: "Sun Co" });
    const ic = await p.locator("#ic").evaluate((el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent ?? "");
    await ctx.close();
    assert(ic === "Select...", `selected: ${ic}`);
    assert(out.filerIdentityRefused.some((m) => m.includes("\"Sun Co\"")), `not reported: ${JSON.stringify(out)}`);
    assert(!out.filled.some((l) => /installer company/i.test(l)), `reported filled: ${out.filled.join(", ")}`);
  });
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} filer-identity check(s) FAILED.`); process.exit(1); }
console.log("\nAll filer-identity checks passed (real Chromium).");
process.exit(0);
