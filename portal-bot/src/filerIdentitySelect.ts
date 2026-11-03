// WHO IS FILING, ON EVERY PATH THAT SELECTS IT (#518, #524).
//
// A portal's "Installer Company" list (and the existing-contact / contact-code list beside it)
// decides which company an application is filed under. On a shared filing account that list holds
// every client. #518 made the hand-coded PGE adapter take only this client's option; recipe replay,
// the learner and the gap-fill select through selectWithFallback (comboboxFill.ts), whose native
// pass takes the first option that CONTAINS the wanted text or is contained by it — right for
// "Schedule 7" vs "Schedule 7 - Residential", and a filing under someone else's company for
// "Sun Co" vs "Sun Co Northwest".
//
// So a select bound to one of these keys never goes near the contains match. It takes the option
// that is exactly the value, else the ONE option equal under case/space/punctuation folding (a
// company) or exactly the code by value or label (a contact code); it must be a native <select>
// whose options can be read; the choice is read back. Anything else throws FilerIdentityStop,
// naming the company, before anything is selected.
//
// Adds refusals only: every other select keeps selectWithFallback unchanged.

/** The binding keys whose select names WHO is filing. */
export const FILER_IDENTITY_FIELDS: ReadonlySet<string> = new Set([
  "installerCompanyName",
  "powerclerkExistingContact",
  "accelaContactCode",
]);

export function isFilerIdentityField(field: unknown): boolean {
  return typeof field === "string" && FILER_IDENTITY_FIELDS.has(field);
}

/** A select whose label names the INSTALLER'S company list ("Installer Company", "Contractor
 *  Company", "Installation Company"). Used where the planner chooses (learn, gap-fill): who is filing
 *  is answered from the client's own name there even when the planner bound nothing. */
export const INSTALLER_COMPANY_LIST_LABEL = /\b(installer|installing|installation|contractor)('?s)?\s+company\b/i;

/** The filer-identity key a planner-chosen select answers, or "": the planner's binding when it is
 *  one, else the company for a select whose label names the installer's company list. */
export function filerIdentityFieldForSelect(label: unknown, binding: unknown): string {
  if (isFilerIdentityField(binding)) return String(binding);
  return INSTALLER_COMPANY_LIST_LABEL.test(String(label ?? "")) ? "installerCompanyName" : "";
}

/** A company list matches by name; a contact list matches by code. */
export function filerIdentityKind(field: string): "company" | "contact" {
  return field === "installerCompanyName" ? "company" : "contact";
}

/** Case, spacing and punctuation folded: "Acme Solar, LLC" and "ACME SOLAR LLC" are one name.
 *  Words are never dropped or reordered, so "Acme Solar" never matches "Acme Solar Pros". */
export function normalizeCompanyLabel(v: string): string {
  return String(v ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

export type SelectOptionView = { value: string; label: string };

const isPlaceholder = (o: SelectOptionView): boolean =>
  o.value === "" || o.label === "" || /^(please\s+)?select\b\W*$|^-+\s*select\s*-+$|^select\W*$/i.test(o.label);

/**
 * The one option that is this client's, or why there is none. Pure (no page): the same answer the
 * PGE adapter's selectInstallerCompany gives, for any list.
 *  - company: the exact label wins; otherwise the options whose label folds to the same name. Zero
 *    or two-plus is a refusal.
 *  - contact: the code must be exactly one option's value or label.
 */
export function matchFilerIdentityOption(
  options: SelectOptionView[], want: string, kind: "company" | "contact",
): { hit: SelectOptionView } | { why: string } {
  const w = String(want ?? "").replace(/\s+/g, " ").trim();
  const real = options.filter((o) => !isPlaceholder(o));
  let hits: SelectOptionView[];
  if (kind === "company") {
    const exact = real.filter((o) => o.label === w);
    const folded = normalizeCompanyLabel(w);
    hits = exact.length ? exact : (folded ? real.filter((o) => normalizeCompanyLabel(o.label) === folded) : []);
    if (hits.length === 0) return { why: `"${w}" is not on this list` };
    if (hits.length > 1) return { why: `${hits.length} options on this list read as "${w}"` };
  } else {
    hits = real.filter((o) => o.value === w || o.label === w);
    if (hits.length === 0) return { why: `the contact code "${w}" is not on this list` };
    if (hits.length > 1) return { why: `${hits.length} options on this list match the contact code "${w}"` };
  }
  return { hit: hits[0] };
}

/** Thrown when a filer-identity select cannot be made this client's. Replay stops the run on it
 *  (never retried, healed or skipped as optional); the learner and gap-fill leave the control alone. */
export class FilerIdentityStop extends Error {
  constructor(message: string, public readonly field: string) {
    super(message);
    this.name = "FilerIdentityStop";
  }
}

/** The stop's sentence: what failed, the company, and what a person does about it. */
export function filerIdentityStopMessage(input: { field: string; control: string; company: string; code?: string; why: string }): string {
  const control = input.control.replace(/\s+/g, " ").trim().slice(0, 60) || (input.field === "installerCompanyName" ? "Installer Company" : "contact");
  const company = input.company.trim() || "the submitting company";
  const fix = input.field === "installerCompanyName"
    ? `Add "${company}" to the portal account's list, or set this client's portal identity to the company's exact label on that list.`
    : `Check ${company}'s portal identity contact code${input.code ? ` ("${input.code}")` : ""} against this account's list.`;
  return `${control}: ${input.why} — stopped so the application is not filed under another company. ${fix}`;
}

/** Read a control's options and current selection in one evaluate; null for a non-<select>. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readNativeSelect(loc: any): Promise<{ options: SelectOptionView[]; selected: SelectOptionView | null } | null> {
  if (!loc || typeof loc.evaluate !== "function") return null;
  return loc.evaluate((el: Element) => {
    if ((el.tagName || "").toLowerCase() !== "select") return null;
    const s = el as HTMLSelectElement;
    const view = (o: HTMLOptionElement) => ({ value: String(o.value ?? ""), label: String(o.textContent ?? "").replace(/\s+/g, " ").trim() });
    const opts = Array.from(s.options).map(view);
    const cur = s.selectedIndex >= 0 ? view(s.options[s.selectedIndex]) : null;
    return { options: opts, selected: cur };
  }, undefined, { timeout: 5000 }).catch(() => null);
}

/** Does this option read as nothing chosen (empty value or a "Select..." prompt)? */
export function isUnansweredOption(o: SelectOptionView | null): boolean {
  return !o || isPlaceholder(o);
}

/**
 * Select THIS client's option on a filer-identity list, or throw FilerIdentityStop. Nothing is
 * selected unless exactly one option is the client's; the selection is read back. `company` is the
 * submitting company's name for the message (for a company list it is also `value`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function selectFilerIdentity(loc: any, input: { field: string; value: string; control: string; company: string }): Promise<SelectOptionView> {
  const kind = filerIdentityKind(input.field);
  const want = String(input.value ?? "").replace(/\s+/g, " ").trim();
  const stop = (why: string): FilerIdentityStop => new FilerIdentityStop(
    filerIdentityStopMessage({ field: input.field, control: input.control, company: input.company || (kind === "company" ? want : ""), code: kind === "contact" ? want : undefined, why }),
    input.field,
  );
  if (!want) throw stop(kind === "company" ? "no submitting company on the project" : "no contact code on file for this client");
  const read = await readNativeSelect(loc);
  // A styled widget exposes no option list to read, and its own type-and-pick matching is the
  // contains match this module exists to keep away from the company.
  if (!read) throw stop("the control is not a plain dropdown whose options can be read");
  const m = matchFilerIdentityOption(read.options, want, kind);
  if ("why" in m) throw stop(m.why);
  await loc.selectOption(m.hit.value, { timeout: 5000 });
  await assertFilerIdentityHeld(loc, m.hit, input);
  return m.hit;
}

/** The control still shows the option chosen for this client, or FilerIdentityStop. Used right after
 *  the pick and again after the portal's commit / autosave settled. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function assertFilerIdentityHeld(loc: any, hit: SelectOptionView, input: { field: string; value: string; control: string; company: string }): Promise<void> {
  const kind = filerIdentityKind(input.field);
  const now = (await readNativeSelect(loc))?.selected ?? null;
  const same = !!now && now.value === hit.value
    && (kind === "company" ? normalizeCompanyLabel(now.label) === normalizeCompanyLabel(hit.label) : now.label === hit.label);
  if (!same) {
    const want = String(input.value ?? "").trim();
    throw new FilerIdentityStop(
      filerIdentityStopMessage({ field: input.field, control: input.control, company: input.company || (kind === "company" ? want : ""), code: kind === "contact" ? want : undefined, why: `the list did not keep "${hit.label}" selected (it shows "${now?.label ?? ""}")` }),
      input.field,
    );
  }
}
