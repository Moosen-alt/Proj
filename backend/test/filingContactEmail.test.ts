// THE FILING SERVICE'S OWN EMAIL GOES IN A SEPARATE SLOT, NEVER IN SOMEONE ELSE'S (#520).
//
// Owner request 2026-11-02: put the filing service's tracking email (FILING_CONTACT_EMAIL) in a form's
// separate applicant / agent / additional-contact email slot. Owner ruling 2026-11-02 20:32 UTC: "we
// still need the ho to get the nem email though" — on PowerClerk the HOMEOWNER stays in the Applicant
// email box (the utility sends the e-signature and NEM mail there); the filing address is additive.
//
//   1. the one slot predicate (shared/src/filingContactEmail): both slots present → the contractor keeps
//      the client's email and the applicant / agent box takes the filing contact's; one company slot
//      only → nothing changes; NEM Applicant / customer / owner boxes never; a contact dialog's own
//      email box never; setting off → nothing.
//      On NEM the PREPARER's email takes it (owner direction 2026-11-02 21:25 UTC); the hand-coded
//      PowerClerk Preparer email reads it from the client overlay (powerClerk.preparerEmailFor).
//   2. the learn-time planner pass (autoLearn.applyFilingContactEmail), the same rules on a plan.
//   3. the replay binder (recipeReplayBinding R12): by label, never by literal; a NEM Applicant step is
//      untouched with the setting on, and one mis-bound to the filing key goes back to the homeowner.
//   4. the field dictionary (resolveRecipeFieldValues): the key only when the setting is set; the
//      PowerClerk Applicant step (powerClerk.fillApplicantEmail) still fills the HOMEOWNER's email with
//      the setting on; the planner never sees the key (plannerFieldView).
//
// KILLS (each run by hand; each turns this file red):
//   (a) filingContactEmail.emailSlotKind: drop the `nem && applicants?` owner line → NEM Applicant
//       Email takes the filing address.
//   (b) planFilingContactEmails: `return opts.track === "permit"` → `return true` for agentRole → the
//       one-slot form swaps the contractor's email.
//   (c) recipeReplayBinding R12: delete the `if (!filingSlot.has(index))` rebind → the NEM Applicant
//       step keeps the filing key.
//
//   npx tsx backend/test/filingContactEmail.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RecipeStep } from "../../shared/src/types";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "filing-contact-email-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.FILING_CONTACT_EMAIL;

const { emailSlotKind, planFilingContactEmails, FILING_CONTACT_EMAIL_KEY } = await import("../../shared/src/filingContactEmail");
const { applyFilingContactEmail, plannerFieldView } = await import("../src/autoLearn");
const { bindRecipeForReplay, REPLAY_BLANK_FIELD } = await import("../src/recipeReplayBinding");
const { filingContactEmailSetting } = await import("../src/filingContact");
const { fillApplicantEmail, preparerEmailFor } = await import("../../portal-bot/src/adapters/powerClerk");
const { clientStagingOverlay, createClient } = await import("../src/clients");
const { openDatabase } = await import("../src/db");
const { createProject, getProjectDetail } = await import("../src/repository");
const { resolveRecipeFieldValues, deadFieldBindings } = await import("../src/portalRecipes");

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   - ${name}`);
};

const FILING = "tracking@filing-service.test";
const CLIENT = "office@kestrel-solar.test";
const OWNER = "homeowner.mockdata@example.test";

// ─────────────────────────────────────────────────────────────────────────────
// 1. The one slot predicate.
// ─────────────────────────────────────────────────────────────────────────────
const permit = { track: "permit" as const, enabled: true };
const nem = { track: "nem" as const, enabled: true };

{
  const plan = planFilingContactEmails([
    { label: "Contractor Email", section: "Contractor Information" },
    { label: "Applicant Email", section: "Applicant" },
    { label: "Owner Email", section: "Property Owner" },
  ], permit);
  check("BOTH SLOTS (permit): the contractor's box keeps the client's email, the applicant box takes the filing contact's, the owner's never",
    plan[0] === false && plan[1] === true && plan[2] === false, JSON.stringify(plan));
}
{
  const plan = planFilingContactEmails([
    { label: "Email", section: "Licensed Professional" },
    { label: "Email", section: "Applicant Information" },
  ], permit);
  check("BOTH SLOTS by section only: a bare Email under Applicant beside the contractor's takes the filing contact's",
    plan[0] === false && plan[1] === true, JSON.stringify(plan));
}
for (const boxes of [
  [{ label: "Applicant Email", section: "Applicant" }, { label: "Owner Email", section: "Property Owner" }],
  [{ label: "Email", section: "Applicant Information" }],
  [{ label: "Contractor Email", section: "Contractor" }, { label: "Homeowner Email" }],
  [{ label: "Email", section: "Owner/Applicant" }, { label: "Contractor Email" }],
]) {
  const plan = planFilingContactEmails(boxes, permit);
  check(`ONE COMPANY SLOT only (or an ambiguous owner block): nothing is swapped — ${JSON.stringify(boxes.map((b) => b.label + "@" + (b.section ?? "")))}`,
    plan.every((v) => v === false), JSON.stringify(plan));
}
{
  // PowerClerk's NEM shape: Applicant (the customer), Installer, and an extra contact.
  const boxes = [
    { label: "Email", section: "Applicant Information" },
    { label: "Applicant Email" },
    { label: "Email", section: "Installer Information" },
    { label: "Email", section: "Customer Information" },
    { label: "Alternate Contact Email" },
    { label: "Additional Contact Email", section: "Applicant Information" },
  ];
  const plan = planFilingContactEmails(boxes, nem);
  check("NEM: the Applicant (= the homeowner) and the customer boxes NEVER take the filing contact's email",
    plan[0] === false && plan[1] === false && plan[3] === false && emailSlotKind(boxes[0], nem) === "owner" && emailSlotKind(boxes[1], nem) === "owner",
    JSON.stringify(plan));
  check("NEM: the installer's own box keeps the client's email", plan[2] === false && emailSlotKind(boxes[2], nem) === "company");
  check("NEM: a separate Alternate Contact Email takes it; one inside the Applicant's (customer's) block does not",
    plan[4] === true && plan[5] === false, JSON.stringify(plan));
  check("NEM: an agent-role label is never the filing contact's on an interconnection",
    planFilingContactEmails([{ label: "Contractor Email" }, { label: "Correspondence Email" }], nem).every((v) => !v));
}
{
  // Owner direction 2026-11-02 21:25 UTC: on NEM the PREPARER (the one submitting) can be the filing service.
  const boxes = [
    { label: "Email", section: "Preparer Information" },
    { label: "Email", section: "PGE Customer Information" },
    { label: "Email", section: "Applicant Information" },
  ];
  const plan = planFilingContactEmails(boxes, nem);
  check("NEM PREPARER: the preparer's email takes the filing contact's; the customer / Applicant boxes still never",
    plan[0] === true && plan[1] === false && plan[2] === false && emailSlotKind(boxes[0], nem) === "preparer", JSON.stringify(plan));
  check("PERMIT preparer: only beside the contractor's own email box",
    planFilingContactEmails([{ label: "Preparer Email" }], permit)[0] === false
      && planFilingContactEmails([{ label: "Contractor Email" }, { label: "Preparer Email" }], permit)[1] === true);
}
{
  const plan = planFilingContactEmails([
    { label: "E-mail:", section: "Applicant", inContactBlock: true },
    { label: "Secondary E-mail:", section: "Applicant", inContactBlock: true },
    { label: "Secondary E-mail:", section: "Property Owner", inContactBlock: true },
    { label: "Secondary E-mail:" },
  ], permit);
  check("CONTACT DIALOG: its own E-mail stays the contact's; the company's Secondary E-mail takes it; the owner's or an unnamed one never",
    plan[0] === false && plan[1] === true && plan[2] === false && plan[3] === false, JSON.stringify(plan));
}
check("SETTING OFF: every box is left to the existing rules",
  planFilingContactEmails([{ label: "Contractor Email" }, { label: "Applicant Email" }, { label: "Additional Contact Email" }], { track: "permit", enabled: false }).every((v) => !v));
check("non-email boxes are never a slot", emailSlotKind({ label: "Applicant Name", section: "Applicant" }, { track: "permit" }) === null);

// ─────────────────────────────────────────────────────────────────────────────
// 2. The learn-time planner pass.
// ─────────────────────────────────────────────────────────────────────────────
const projectFields = { installerEmail: CLIENT, homeownerEmail: OWNER, [FILING_CONTACT_EMAIL_KEY]: FILING };
{
  const fields = [
    { label: "Email", fieldType: "text", section: "Applicant Information" },
    { label: "Email", fieldType: "text", section: "Installer Information" },
    { label: "Alternate Contact Email", fieldType: "text" },
    { label: "Receive email notifications", fieldType: "checkbox" },
  ];
  const fills = [
    { selectorIndex: 0, value: OWNER, field: "homeownerEmail" },
    { selectorIndex: 1, value: CLIENT, field: "installerEmail" },
  ];
  const before = JSON.stringify(fills.slice(0, 2));
  applyFilingContactEmail(fields, fills, { track: "nem", value: FILING, projectFields });
  check("LEARN NEM: the Applicant step is UNCHANGED (homeowner's email) and the installer's keeps the client's — setting on",
    JSON.stringify(fills.slice(0, 2)) === before, JSON.stringify(fills));
  const alt = fills.find((f) => f.selectorIndex === 2);
  check("LEARN NEM: the alternate contact box is filled with the filing contact's email, BOUND (never a literal)",
    alt?.value === FILING && alt?.field === FILING_CONTACT_EMAIL_KEY, JSON.stringify(alt));
  check("LEARN: a checkbox is never filled", !fills.some((f) => f.selectorIndex === 3));

  const misplaced = [{ selectorIndex: 0, value: FILING, field: undefined as string | undefined }];
  applyFilingContactEmail(fields, misplaced, { track: "nem", value: FILING, projectFields });
  check("LEARN NEM: the filing address typed into the Applicant box is put back to the HOMEOWNER's",
    misplaced[0].value === OWNER && misplaced[0].field === "homeownerEmail", JSON.stringify(misplaced));
}
{
  const fields = [
    { label: "Contractor Email", fieldType: "text" },
    { label: "Applicant Email", fieldType: "text" },
  ];
  const fills = [
    { selectorIndex: 0, value: CLIENT, field: "installerEmail" },
    { selectorIndex: 1, value: CLIENT, field: "installerEmail" },
  ];
  applyFilingContactEmail(fields, fills, { track: "electrical", value: FILING, projectFields });
  check("LEARN PERMIT both slots: contractor keeps the client's, applicant takes the filing contact's (bound)",
    fills[0].value === CLIENT && fills[0].field === "installerEmail" && fills[1].value === FILING && fills[1].field === FILING_CONTACT_EMAIL_KEY,
    JSON.stringify(fills));

  const single = [{ selectorIndex: 0, value: CLIENT, field: "installerEmail" }];
  applyFilingContactEmail([{ label: "Applicant Email", fieldType: "text" }], single, { track: "building", value: FILING, projectFields });
  check("LEARN PERMIT one slot: the client's email stays", single[0].value === CLIENT && single[0].field === "installerEmail", JSON.stringify(single));

  const off = [{ selectorIndex: 0, value: CLIENT, field: "installerEmail" }, { selectorIndex: 1, value: CLIENT, field: "installerEmail" }];
  const offBefore = JSON.stringify(off);
  applyFilingContactEmail(fields, off, { track: "electrical", value: "", projectFields });
  check("LEARN setting off: the plan is untouched", JSON.stringify(off) === offBefore, JSON.stringify(off));
}
check("the planner (the model) never sees the filing contact key",
  !(FILING_CONTACT_EMAIL_KEY in plannerFieldView({ ...projectFields })) && plannerFieldView({ ...projectFields }).installerEmail === CLIENT);

// ─────────────────────────────────────────────────────────────────────────────
// 3. The replay binder (R12).
// ─────────────────────────────────────────────────────────────────────────────
const fill = (label: string, extra: Partial<RecipeStep> = {}): RecipeStep => ({ action: "fill", selector: { label }, note: label, ...extra });
const bind = (steps: RecipeStep[], track: string, on: boolean) => bindRecipeForReplay({
  steps, project: { state: "OR", ahj: "City of Fernhollow" }, track, borrowed: null, agency: null,
  fieldValues: { installerEmail: CLIENT, homeownerEmail: OWNER, ...(on ? { [FILING_CONTACT_EMAIL_KEY]: FILING } : {}) },
});
{
  const steps = [
    fill("Email", { field: "homeownerEmail", fingerprint: { section: "Applicant Information" } as never }),
    fill("Email", { field: "installerEmail", fingerprint: { section: "Installer Information" } as never }),
    fill("Alternate Contact Email", { value: FILING }),
  ];
  const b = bind(steps, "nem", true);
  check("REPLAY NEM, setting on: the PowerClerk Applicant step is UNCHANGED (homeownerEmail)",
    b.steps[0].field === "homeownerEmail" && !b.changes.some((c) => c.index === 0), JSON.stringify(b.steps[0]));
  check("REPLAY NEM: the installer's step keeps installerEmail", b.steps[1].field === "installerEmail");
  check("REPLAY NEM: a recorded literal address in the alternate contact box binds to the key, never the literal",
    b.steps[2].field === FILING_CONTACT_EMAIL_KEY && b.steps[2].value === undefined, JSON.stringify(b.steps[2]));

  const wrong = bind([fill("Email", { field: FILING_CONTACT_EMAIL_KEY, fingerprint: { section: "Applicant Information" } as never })], "nem", true);
  check("REPLAY NEM: an Applicant step bound to the filing key goes back to the HOMEOWNER's email",
    wrong.steps[0].field === "homeownerEmail" && wrong.changes.some((c) => c.kind === "rebound" && /homeowner/.test(c.reason)), JSON.stringify(wrong));
}
{
  const steps = [fill("Contractor Email", { field: "installerEmail" }), fill("Applicant Email", { field: "installerEmail" })];
  const on = bind(steps, "electrical", true);
  check("REPLAY PERMIT both slots, setting on: applicant rebinds to the filing key, contractor keeps installerEmail",
    on.steps[0].field === "installerEmail" && on.steps[1].field === FILING_CONTACT_EMAIL_KEY, JSON.stringify(on.steps));
  const off = bind(steps, "electrical", false);
  check("REPLAY setting off: nothing changes", off.steps.every((s) => s.field === "installerEmail") && off.changes.length === 0, JSON.stringify(off.changes));
  const single = bind([fill("Applicant Email", { field: "installerEmail" })], "building", true);
  check("REPLAY PERMIT one slot: the client's email stays", single.steps[0].field === "installerEmail" && single.changes.length === 0);
  const single2 = bind([fill("Applicant Email", { field: FILING_CONTACT_EMAIL_KEY })], "building", true);
  check("REPLAY PERMIT one slot bound to the filing key: back to the contractor's",
    single2.steps[0].field === "installerEmail", JSON.stringify(single2.steps));
  const offBound = bind([fill("Contractor Email", { field: "installerEmail" }), fill("Applicant Email", { field: FILING_CONTACT_EMAIL_KEY }), fill("Additional Contact Email", { field: FILING_CONTACT_EMAIL_KEY })], "electrical", false);
  check("REPLAY setting off, steps already bound to the key: the applicant box gets the contractor's (as before), the extra contact's is blank",
    offBound.steps[1].field === "installerEmail" && offBound.steps[2].field === REPLAY_BLANK_FIELD, JSON.stringify(offBound.steps));
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The setting and the field dictionary; the PowerClerk Applicant step.
// ─────────────────────────────────────────────────────────────────────────────
check("setting: unset / not an address → \"\"; an address → itself",
  filingContactEmailSetting({}) === "" && filingContactEmailSetting({ FILING_CONTACT_EMAIL: "Keelix" }) === ""
    && filingContactEmailSetting({ FILING_CONTACT_EMAIL: ` ${FILING} ` }) === FILING);

check("a step bound to the filing key is never a DEAD binding, setting off (R12 replays it as before)",
  deadFieldBindings([{ action: "fill", selector: { label: "Applicant Email" }, field: FILING_CONTACT_EMAIL_KEY }], { installerEmail: CLIENT }).length === 0);

const db = await openDatabase();
const created = createProject(db, {
  state: "OR", ahj: "City of Fernhollow", utility: "Portland General Electric", projectAddress: "5060 Synthetic Ave",
  city: "Fernhollow", zip: "97498", dcKw: 7.2, homeownerName: "Finley Mockdata", homeownerEmail: OWNER,
} as never);
const project = getProjectDetail(db, created.project.id).project;
const client = createClient(db, { companyName: "Kestrel Solar Test", businessEmail: CLIENT } as never);
const stagingOff = clientStagingOverlay(db, client.id, "utility", { state: "OR", track: "nem" });
const valuesOff = resolveRecipeFieldValues(db, project as never, "utility", "nem");
check("DICTIONARY setting off: no filing contact key at all (today's dictionary)", !(FILING_CONTACT_EMAIL_KEY in valuesOff));
process.env.FILING_CONTACT_EMAIL = FILING;
const valuesOn = resolveRecipeFieldValues(db, project as never, "utility", "nem");
const stagingOn = clientStagingOverlay(db, client.id, "utility", { state: "OR", track: "nem" });
check("DICTIONARY setting on: the key carries the setting", valuesOn[FILING_CONTACT_EMAIL_KEY] === FILING, String(valuesOn[FILING_CONTACT_EMAIL_KEY]));
check("DICTIONARY setting on: homeownerEmail is still the homeowner's", valuesOn.homeownerEmail === OWNER, String(valuesOn.homeownerEmail));
check("DICTIONARY setting on: the client overlay (what the hand-coded adapters read) carries it beside installerEmail, never in place of it",
  stagingOn.filingContactEmail === FILING && stagingOff.filingContactEmail === undefined && stagingOn.installerEmail === stagingOff.installerEmail);
check("POWERCLERK Preparer email: the filing contact's when set, the installer's when not",
  preparerEmailFor({ filingContactEmail: FILING }, CLIENT) === FILING && preparerEmailFor({}, CLIENT) === CLIENT
    && preparerEmailFor({ filingContactEmail: "not an address" }, CLIENT) === CLIENT);
{
  let typed = "";
  await fillApplicantEmail(valuesOn, { reportedMissing: [] }, async (email) => { typed = email; });
  check("POWERCLERK Applicant step with the setting on: types the HOMEOWNER's email (the utility's e-signature goes there)",
    typed === OWNER, typed);
}
delete process.env.FILING_CONTACT_EMAIL;
db.close?.();
fs.rmSync(tmpDir, { recursive: true, force: true });

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nfilingContactEmail: all checks passed");
