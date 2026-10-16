// THE REPLAY'S OWN CLICK OF A KNOWN DRAFT-CREATING SUBMIT (#330) — the gate, pinned without a browser.
//
// Owner ruling 2026-10-16 ("Yes to PSE"): once a portal's Submit has been SEEN to create only a draft
// (the healed step, PR #325), a replay may click that same Submit itself. Pinned here:
//   (a) the one shape it allows: the recipe's last step, a click, healed AND stamped, on the stamp's
//       tenant, under the stamp's label, enabled for the run, not yet clicked;
//   (b) a step never healed (no stamp) is never clicked — whatever else holds;
//   (c) PORTAL_ALLOW_FINAL_SUBMIT and a run approval play no part: the answer is identical with the
//       switch on, off or unset, and the gate's source never reads either (nor the final-submit gate);
//   (d) a step flagged isFinalSubmit is never clicked here, stamp or not (rule 1's door is elsewhere);
//   (e) another tenant (another host, or another agency on a path-tenanted host), another label, a
//       step that is not last, a fee, a second click, a run not enabled: each refused, named;
//   (f) the page after the click: only the "created" wording reads as a draft; a receipt is
//       "filed"; a bare draft status, an error or a blank page is "other".
//
// KILL TESTS: drop the stamp check in draftCreatingClickRefusals → (b) fails; drop the tenant
// comparison → (e) fails; drop the isFinalSubmit refusal → (d) fails; accept strength "status" in
// readDraftAfterClick → (f) fails.
//
// Run: npx tsx portal-bot/src/draftSubmitGate.test.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RecipeStep } from "../../shared/src/types";
import { draftCreatingClickRefusals, draftStampOf, draftTenantKey, readDraftAfterClick } from "./draftSubmitGate";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// Synthetic: a two-part PowerClerk-shaped tenant (invented host), and the issue's wording.
const PORTAL = "https://twopart-utility.powerclerk.example/MvcProjects/ProjectForm?ProjectId=abc";
const TENANT = draftTenantKey(PORTAL);
const fill = (n: number): RecipeStep => ({ action: "fill", selector: { name: `f${n}` }, field: "homeownerName", note: `Field ${n}` } as RecipeStep);
const REVIEW: RecipeStep = { action: "stopForReview", selector: {} } as RecipeStep;
const healed = (over: Partial<RecipeStep> = {}): RecipeStep => ({
  action: "click", selector: { text: "Submit" }, note: "final submit | creates a draft, not the filing (#302)",
  draftCreatingSubmit: { tenantKey: TENANT, label: "Submit", healedAt: "2026-10-16T00:00:00.000Z" }, ...over,
} as RecipeStep);
const recipe = (last: RecipeStep, extra: RecipeStep[] = []): RecipeStep[] => [fill(1), fill(2), REVIEW, last, ...extra];
const ctx = (over: Partial<{ pageUrl: string; enabled: boolean; alreadyClicked: boolean }> = {}) => ({ pageUrl: PORTAL, enabled: true, alreadyClicked: false, ...over });
const show = (r: string[]): string => JSON.stringify(r);

// (a)
{
  const steps = recipe(healed());
  const r = draftCreatingClickRefusals(steps, steps.length - 1, ctx());
  check("(a) the healed, stamped last step on its own tenant may be clicked", r.length === 0, show(r));
  const other = draftCreatingClickRefusals(steps, steps.length - 1, ctx({ pageUrl: "https://twopart-utility.powerclerk.example/MvcAccount/Login" }));
  check("(a) the tenant is the host, not the page path (another page of the same tenant still counts)", other.length === 0, show(other));
}

// (b)
{
  const plain = { action: "click", selector: { text: "Submit" }, note: "final submit | creates a draft, not the filing (#302)" } as RecipeStep;
  const steps = recipe(plain);
  const r = draftCreatingClickRefusals(steps, steps.length - 1, ctx());
  check("(b) a step never healed (no stamp) is never clicked, even with the heal's own note", r.some((x) => /never healed/.test(x)), show(r));
  const partial = recipe({ ...plain, draftCreatingSubmit: { tenantKey: "", label: "Submit", healedAt: "" } } as RecipeStep);
  check("(b) a stamp without a tenant is no stamp", draftStampOf(partial[partial.length - 1]) === null
    && draftCreatingClickRefusals(partial, partial.length - 1, ctx()).some((x) => /never healed/.test(x)));
}

// (c)
{
  const prev = process.env.PORTAL_ALLOW_FINAL_SUBMIT;
  const cases: Array<[string, RecipeStep[]]> = [["allowed", recipe(healed())], ["never healed", recipe({ action: "click", selector: { text: "Submit" } } as RecipeStep)], ["flagged", recipe(healed({ isFinalSubmit: true }))]];
  const answers = (): string => cases.map(([, st]) => show(draftCreatingClickRefusals(st, st.length - 1, ctx()))).join(" / ");
  delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
  const unset = answers();
  process.env.PORTAL_ALLOW_FINAL_SUBMIT = "1";
  const on = answers();
  process.env.PORTAL_ALLOW_FINAL_SUBMIT = "0";
  const off = answers();
  if (prev === undefined) delete process.env.PORTAL_ALLOW_FINAL_SUBMIT; else process.env.PORTAL_ALLOW_FINAL_SUBMIT = prev;
  check("(c) PORTAL_ALLOW_FINAL_SUBMIT changes nothing: the same answers with the switch unset, 1 and 0", unset === on && on === off, `unset=${unset}\non=${on}\noff=${off}`);
  // The gate's own source: no environment switch, no approval, no final-submit gate.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "draftSubmitGate.ts"), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
  const reads = ["PORTAL_ALLOW_FINAL_SUBMIT", "process.env", "runApproval", "approval", "autoSubmit", "mayClickFinalSubmit", "automaticSubmitRefusals", "finalSubmitRefusals"].filter((w) => src.includes(w));
  check("(c) the gate's code reads no environment switch, no run approval, no auto-submit arm and not the final-submit gate", reads.length === 0, `reads: ${reads.join(", ")}`);
}

// (d)
{
  const steps = recipe(healed({ isFinalSubmit: true }));
  const r = draftCreatingClickRefusals(steps, steps.length - 1, ctx());
  check("(d) a step flagged isFinalSubmit is refused here even with a stamp — the final-submit gate owns it", r.some((x) => /flagged as the final submit/.test(x)), show(r));
}

// (e)
{
  const steps = recipe(healed());
  const last = steps.length - 1;
  const refusedFor = (r: string[], re: RegExp) => r.length > 0 && r.some((x) => re.test(x));
  const otherHost = draftCreatingClickRefusals(steps, last, ctx({ pageUrl: "https://another-utility.powerclerk.example/MvcProjects/ProjectForm" }));
  check("(e) another tenant's page (another PowerClerk subdomain)", refusedFor(otherHost, /not the tenant/), show(otherHost));
  const noUrl = draftCreatingClickRefusals(steps, last, ctx({ pageUrl: "" }));
  check("(e) a page whose URL cannot be read", refusedFor(noUrl, /not the tenant/), show(noUrl));
  // A path-tenanted host (one Accela instance, many agencies): the agency is part of the tenant.
  const acaA = "https://aca-prod.accela.example.invalid/CITYA/Cap/CapEdit.aspx";
  const acaKeyA = draftTenantKey("https://aca-prod.accela.com/CITYA/Cap/CapEdit.aspx");
  const acaKeyB = draftTenantKey("https://aca-prod.accela.com/CITYB/Cap/CapEdit.aspx");
  check("(e) on a path-tenanted host the agency segment is part of the tenant", Boolean(acaKeyA) && acaKeyA !== acaKeyB, `${acaKeyA} vs ${acaKeyB} (${acaA})`);
  const acaSteps = recipe(healed({ draftCreatingSubmit: { tenantKey: acaKeyA, label: "Submit", healedAt: "" } }));
  const acaOther = draftCreatingClickRefusals(acaSteps, acaSteps.length - 1, ctx({ pageUrl: "https://aca-prod.accela.com/CITYB/Cap/CapEdit.aspx" }));
  const acaSame = draftCreatingClickRefusals(acaSteps, acaSteps.length - 1, ctx({ pageUrl: "https://aca-prod.accela.com/CITYA/Cap/CapConfirm.aspx" }));
  check("(e) another agency on the same shared host is refused; the same agency is not", refusedFor(acaOther, /not the tenant/) && acaSame.length === 0, `other=${show(acaOther)} same=${show(acaSame)}`);
  const relabelled = recipe(healed({ selector: { text: "Submit and Pay" } }));
  const lab = draftCreatingClickRefusals(relabelled, relabelled.length - 1, ctx());
  check("(e) a step whose label is not the stamped one", refusedFor(lab, /is not the one that was seen/), show(lab));
  const notLast = recipe(healed(), [fill(3)]);
  const nl = draftCreatingClickRefusals(notLast, notLast.length - 2, ctx());
  check("(e) a stamped step with steps after it", refusedFor(nl, /not the recipe's last step/), show(nl));
  const fee = recipe(healed({ selector: { text: "Pay Fees" }, draftCreatingSubmit: { tenantKey: TENANT, label: "Pay Fees", healedAt: "" } }));
  const fr = draftCreatingClickRefusals(fee, fee.length - 1, ctx());
  check("(e) a fee control, even stamped", refusedFor(fr, /pays a fee/), show(fr));
  const twice = draftCreatingClickRefusals(steps, last, ctx({ alreadyClicked: true }));
  check("(e) a second click in one run", refusedFor(twice, /already clicked/), show(twice));
  const off = draftCreatingClickRefusals(steps, last, ctx({ enabled: false }));
  check("(e) a run the backend did not enable (another track, a borrowed recipe)", refusedFor(off, /may not click/), show(off));
  const notClick = recipe(healed({ action: "press" } as Partial<RecipeStep>));
  const nc = draftCreatingClickRefusals(notClick, notClick.length - 1, ctx());
  check("(e) a stamped step that is not a click", refusedFor(nc, /not a click/), show(nc));
}

// (f)
{
  const pse = "Your draft application NEM-90017 has been created. Please continue to Interconnection Application - Part 2 to complete your interconnection application and submit to PSE.";
  const d = readDraftAfterClick(`Program Home ${pse} Return to Program Home`);
  check("(f) PSE's draft-created page reads as a draft, with its number and next form",
    d.verdict === "draft" && d.read.applicationNumber === "NEM-90017" && d.read.nextForm === "Interconnection Application - Part 2", JSON.stringify(d));
  const receipt = readDraftAfterClick("Thank you. Your application has been submitted. Record Number: NEM-90017");
  check("(f) a receipt is a filing, never a draft", receipt.verdict === "filed", JSON.stringify(receipt));
  const both = readDraftAfterClick(`${pse} Your application has been submitted.`);
  check("(f) a page that says a draft was created AND that the application was submitted is not a draft", both.verdict !== "draft", JSON.stringify(both));
  const status = readDraftAfterClick("NEM-90017 Status: Application Draft. Current Forms: Interconnection Application - Part 2 [Begin]");
  check("(f) a bare draft status is not proof the click made the draft", status.verdict === "other", JSON.stringify(status));
  const error = readDraftAfterClick("An error has occurred. Please try again later.");
  check("(f) an error page is not a draft", error.verdict === "other", JSON.stringify(error));
  check("(f) a blank page is not a draft", readDraftAfterClick("").verdict === "other" && readDraftAfterClick(null).verdict === "other");
}

if (failures) { console.error(`\n${failures} draft-submit gate check(s) FAILED.`); process.exit(1); }
console.log("\nAll draft-submit gate checks passed.");
process.exit(0);
