// THE FORM FILLER PUTS EACH VALUE IN ITS OWN BOX (issue #428).
//
// The owner: "the form filling tool was still not filling stuff out right". The standalone Form
// Filler (/tools/form-filler → /api/tools/form-fill/auto and /batch) was run on eight public AHJ
// blanks in backend/test/fixtures with ONE synthetic row and every filled page was read back
// label by label. It put the permit number in Marion E-01's TOTAL PERMIT FEE box, the date in Coos
// County's "Date of Approval", "OR" in BCD 5952's City box, "OR" / "97999" alone in the owner's and
// the contractor's City/State/ZIP boxes, the company's phone, email and mailing address in the
// PROPERTY OWNER block of five forms, the homeowner's name in Yamhill's CONTRACTOR "Name:", the
// city over Tigard's page title and the phone over Tigard's "City/State/ZIP:" caption.
//
// Each check below reproduces one of those placements on the same public blank, by geometry and
// printed words alone (no model, no network): it fails on the matcher before #428.
//
//   npx tsx backend/test/formFillerRightBox.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { autoFillByFieldName } from "../src/formFiller";
import { autoPlaceFromData, extractLabels, splitBlankRuns, type AutoPlacement, type LabelItem } from "../src/formTextLayer";
import { matchSynonym, isCombinedCityStateZip, headerParty, keyAllowsParty, isApplicantBanner } from "../src/formFillSlots";

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures");
const blank = (f: string): Uint8Array => new Uint8Array(fs.readFileSync(path.join(FIXTURES, f)));

// The tool's data panel, as the operator fills it: the row (homeowner/site) and the company
// boilerplate ("applied to every form"). Synthetic; no account or meter number anywhere.
const ROW = {
  name: "Jordan Samplehouse", permitNumber: "TEST-428-001", street: "1428 Example Ave", city: "Sampleton", state: "OR", zip: "97999",
  date: "10/31/2026", installer: "Example Solar Co LLC", mailingAddress: "500 Vendor Way", phone: "(555) 010-4280", email: "permits@example-solar.test",
};

async function acro(file: string): Promise<{ text: (name: string) => string; matched: Record<string, string> }> {
  const r = await autoFillByFieldName(blank(file), ROW);
  const form = (await PDFDocument.load(r.filled)).getForm();
  return { text: (name) => form.getTextField(name).getText() ?? "", matched: Object.fromEntries(r.matched.map((m) => [m.key, m.field])) };
}

async function flat(file: string): Promise<{ items: LabelItem[]; byKey: Record<string, AutoPlacement>; placements: AutoPlacement[] }> {
  const items = await extractLabels(blank(file));
  const placements = autoPlaceFromData(items, ROW);
  return { items, byKey: Object.fromEntries(placements.map((p) => [p.key, p])), placements };
}

// ── The matching rules, by themselves ────────────────────────────────────────────────────────
await check("a synonym matches whole words only: 'permit' is not TOTAL PERMIT FEE nor a page title", () => {
  assert.equal(matchSynonym("permit", "TOTAL PERMIT FEE"), null);
  assert.equal(matchSynonym("permit", "Building Permit Application"), null);
  assert.equal(matchSynonym("city", "City of Tigard"), null);
  assert.equal(matchSynonym("date", "Date of Approval"), null);
  assert.equal(matchSynonym("contractor", "Contractor CCB license #:"), null, "another field's label");
  assert.equal(matchSynonym("contractor name", "Contractor’s name:"), 0);
  assert.equal(matchSynonym("phone number", "Phone number_2"), 0);
  assert.equal(matchSynonym("permit #", "Permit No.:"), 0);
});
await check("City/State/ZIP is one combined box; section headers are read, field captions are not headers", () => {
  assert.equal(isCombinedCityStateZip("CityStateZIP_2"), true);
  assert.equal(isCombinedCityStateZip("City/State/ Zip:"), true);
  assert.equal(isCombinedCityStateZip("City:"), false);
  assert.equal(headerParty("PROPERTY OWNER INFORMATION"), "owner");
  assert.equal(headerParty("CONTRACTOR INSTALLATION"), "contractor");
  assert.equal(headerParty("FOR OFFICE USE ONLY"), "office");
  assert.equal(headerParty("OWNER:"), "owner");
  assert.equal(headerParty("PROPERTY OWNER NAME"), null, "a caption, not a header");
  assert.equal(headerParty("Approved by:"), null);
  assert.equal(headerParty("APPLICANT TO PROVIDE ALL INFORMATION BELOW:"), null, "a sentence");
});
await check("the company's values never go in an owner, office or fee box; the homeowner's never in the contractor's", () => {
  assert.equal(keyAllowsParty("phone", "owner", "phone"), false);
  assert.equal(keyAllowsParty("phone", "contractor", "phone"), true);
  assert.equal(keyAllowsParty("phone", null, "phone"), true, "a form with no printed parties (a refund request) still fills");
  assert.equal(keyAllowsParty("name", "contractor", "name"), false);
  assert.equal(keyAllowsParty("name", "applicant", "applicant name"), true, "a synonym that names the party means it");
  assert.equal(keyAllowsParty("permitNumber", "office", "permit #"), false);
  assert.equal(keyAllowsParty("date", "owner", "date"), false, "the owner dates their own signature");
});

await check("an 'applicant to provide all information below' line is a banner; a sentence about items below is not (#446)", () => {
  assert.equal(isApplicantBanner("APPLICANT TO PROVIDE ALL INFORMATION BELOW:"), true);
  assert.equal(isApplicantBanner("Applicant to complete all information below"), true);
  assert.equal(isApplicantBanner("If “No” is selected for any item below, or if the supporting structure is a manufactured dwelling, the project"), false);
  assert.equal(isApplicantBanner("below."), false);
  assert.equal(isApplicantBanner("APPLICANT"), false);
});

// ── AcroForm blanks (the tool's "fillable form" door) ────────────────────────────────────────
await check("Marion E-01: the permit number never lands in TOTAL PERMIT FEE; the owner-install date stays blank", async () => {
  const f = await acro("marion-e-01.pdf");
  assert.equal(f.text("TOTAL PERMIT FEE"), "");
  assert.notEqual(f.matched.permitNumber, "TOTAL PERMIT FEE");
  assert.equal(f.text("Date"), "", "the Date beside the Property Owner Installation signature");
});
await check("Marion E-01: one combined City/State/ZIP on the job site; the owner's and contractor's are not given OR / 97999", async () => {
  const f = await acro("marion-e-01.pdf");
  assert.equal(f.text("CityStateZip"), "Sampleton, OR 97999");
  assert.equal(f.text("CityState ZIP"), "");
  assert.equal(f.text("CityStateZIP"), "");
});
await check("Marion E-01 / B-01S / Coos: the company's phone, email and address go in the CONTRACTOR block, not the owner's", async () => {
  for (const file of ["marion-e-01.pdf", "marion-b-01s.pdf", "coos-electrical.pdf"]) {
    const f = await acro(file);
    assert.equal(f.text("Phone_2"), ROW.phone, `${file}: contractor phone`);
    assert.equal(f.text("Email_2"), ROW.email, `${file}: contractor email`);
    assert.equal(f.text("Address_2"), ROW.mailingAddress, `${file}: contractor address`);
    assert.equal(f.text("Phone"), "", `${file}: owner phone`);
    assert.equal(f.text("Email"), "", `${file}: owner email`);
    assert.equal(f.text("Business name"), ROW.installer, `${file}: business name`);
  }
});
await check("Coos: nothing in 'Date of Approval'; the job site City/State/ZIP gets all three; the others none", async () => {
  const f = await acro("coos-electrical.pdf");
  assert.equal(f.text("Date of Approval"), "");
  assert.equal(f.text("CityStateZIP"), "Sampleton, OR 97999");
  assert.equal(f.text("CityStateZIP_2"), "");
  assert.equal(f.text("CityStateZIP_3"), "");
  assert.equal(f.text("Name"), ROW.name);
});
await check("BCD 5952: the box NAMED 'State  Oregon' is printed 'City:' and gets the city; the owner's phone box stays the owner's", async () => {
  const f = await acro("bcd-5952-2024.pdf");
  assert.equal(f.text("State  Oregon"), "Sampleton");
  assert.equal(f.text("Phone number"), "", "PART I owner phone");
  assert.equal(f.text("Phone number_2"), ROW.phone, "PART II contractor phone");
  assert.equal(f.text("Contractors name"), ROW.installer);
  assert.equal(f.text("Property owner name"), ROW.name);
});

// ── Flat blanks (the tool's "drop values to review" door) ────────────────────────────────────
/** No value overprints printed words (writing lines and the value's own label excepted). */
function overprints(items: LabelItem[], placements: AutoPlacement[]): string[] {
  const words = splitBlankRuns(items).filter((i) => !i.blank && !/^[\s_.]*$/.test(i.str));
  const out: string[] = [];
  for (const p of placements) {
    const w = p.text.length * p.size * 0.5;
    const hit = words.find((i) => i.page === p.page && i.str !== p.label
      && p.x < i.x + i.width - 0.5 && p.x + w > i.x + 0.5 && p.y - 1.5 < i.y + i.height * 0.75 - 0.5 && p.y + p.size * 0.75 > i.y - 1 + 0.5);
    if (hit) out.push(`${p.key} over "${hit.str}"`);
  }
  return out;
}
await check("Tigard building: no permit number in FOR OFFICE USE ONLY; the owner's name in PROPERTY OWNER, not the signature block", async () => {
  const f = await flat("tigard-building.pdf");
  assert.equal(f.byKey.permitNumber, undefined);
  assert.equal(f.byKey.name?.label, "Name:");
  assert.equal(f.byKey.street?.label, "Job site address:");
  assert.equal(f.byKey.city?.text, "Sampleton, OR 97999");
});
await check("Tigard building + electrical: the phone goes after the printed '(   )', never over the next caption; nothing overprints", async () => {
  for (const file of ["tigard-building.pdf", "tigard-electrical.pdf"]) {
    const f = await flat(file);
    const phone = f.byKey.phone;
    assert.ok(phone, `${file}: phone placed`);
    const close = f.items.find((i) => i.page === phone.page && Math.abs(i.y - phone.y) <= 2 && /\)/.test(i.str) && i.x < phone.x);
    assert.ok(close, `${file}: phone sits right of the printed ')'`);
    assert.deepEqual(overprints(f.items, f.placements), [], file);
  }
});
await check("Tigard electrical: the city is not drawn over the page title 'City of Tigard'", async () => {
  const f = await flat("tigard-electrical.pdf");
  assert.equal(f.byKey.city?.label, "City/State/ZIP:");
});
await check("Yamhill: the homeowner in PROPERTY OWNER 'Name:', the company in CONTRACTOR 'Name:', the date not in the fee table", async () => {
  const f = await flat("yamhill-building-application.pdf");
  assert.ok(f.byKey.name && f.byKey.installer, "both placed");
  assert.ok(f.byKey.name.y > f.byKey.installer.y + 60, "owner block sits above the contractor block");
  assert.equal(f.byKey.installer.label, "Name:");
  assert.ok(f.byKey.date && f.byKey.date.y > 700, "the application date at the top, not 'Date' in BUILDING PERMIT FEES");
  assert.ok(f.byKey.permitNumber && f.byKey.permitNumber.y >= 760, "Permit No. on its own writing line");
});
await check("Valencia: the company's address is not written in the owner's MAILING ADDRESS row; the company goes in the agent row's 'Company'", async () => {
  const f = await flat("valencia-multi-purpose-permit-application.pdf");
  assert.equal(f.byKey.mailingAddress, undefined);
  assert.equal(f.byKey.installer?.label, "Company");
  assert.deepEqual(overprints(f.items, f.placements), []);
});
await check("Albuquerque E-Plan: the owner's name on its NAME line (not over 'OWNER:'); the company's under CONTRACTOR:", async () => {
  const f = await flat("abq-eplan-application.pdf");
  const name = f.byKey.name;
  const nameLbl = f.items.find((i) => i.str === "NAME" && Math.abs(i.y - (name?.y ?? -99)) <= 1);
  assert.ok(nameLbl && name.x > nameLbl.x + nameLbl.width, "right of the NAME caption on its own line");
  assert.ok(f.byKey.installer && f.byKey.installer.y < name.y - 100, "the company in the CONTRACTOR block, far below the owner's");
  assert.equal(f.byKey.street?.label, "CONSTRUCTION ADDRESS:");
  // Its captions sit LEFT of drawn lines, stacked a line apart: the company phone goes on the
  // contractor's PHONE line, not above it on the ADDRESS line (and not the owner's PHONE).
  const phone = f.byKey.phone;
  const phoneLbl = f.items.find((i) => i.str === "PHONE" && Math.abs(i.y - (phone?.y ?? -99)) <= 1);
  assert.ok(phoneLbl && phone.x > phoneLbl.x + phoneLbl.width && phone.y < f.byKey.installer.y, `phone at ${JSON.stringify(phone)}`);
  assert.deepEqual(overprints(f.items, f.placements), []);
});

// ── More than one company block (issue #447) ────────────────────────────────────────────────
await check("Tigard building + electrical: the company's name, address and phone go in BOTH the APPLICANT and the CONTRACTOR block (#447)", async () => {
  for (const file of ["tigard-building.pdf", "tigard-electrical.pdf"]) {
    const f = await flat(file);
    const head = (str: string) => f.items.find((i) => i.str.trim() === str);
    const applicant = head("APPLICANT");
    const contractor = head("CONTRACTOR");
    assert.ok(applicant && contractor && applicant.page === contractor.page && applicant.y > contractor.y, `${file}: both headers`);
    const owner = f.items.find((i) => i.page === applicant.page && /^(PROPERTY )?OWNER$/.test(i.str.trim()));
    for (const key of ["installer", "mailingAddress", "phone"]) {
      const at = f.placements.filter((p) => p.key === key);
      const inApplicant = at.filter((p) => p.page === applicant.page && p.y < applicant.y && p.y > contractor.y);
      const inContractor = at.filter((p) => p.page === contractor.page && p.y < contractor.y);
      assert.equal(inApplicant.length, 1, `${file}: ${key} once in APPLICANT (${JSON.stringify(at)})`);
      assert.equal(inContractor.length, 1, `${file}: ${key} once in CONTRACTOR (${JSON.stringify(at)})`);
      assert.equal(at.length, 2, `${file}: ${key} nowhere else`);
      assert.ok(!owner || at.every((p) => p.page !== owner.page || p.y < applicant.y), `${file}: ${key} not in the owner block`);
    }
    assert.equal(f.placements.filter((p) => p.key === "installer").every((p) => p.label === "Business name:"), true, `${file}: on each block's Business name line`);
    assert.equal(f.placements.filter((p) => p.key === "name").length, 1, `${file}: the homeowner once, in the owner block`);
    assert.deepEqual(overprints(f.items, f.placements), [], file);
  }
});
await check("single company block forms fill each value once: Yamhill's bare APPLICANT 'Name:' is not taken for the company (#447)", async () => {
  for (const file of ["yamhill-building-application.pdf", "abq-eplan-application.pdf", "valencia-multi-purpose-permit-application.pdf"]) {
    const f = await flat(file);
    const keys = f.placements.map((p) => p.key);
    assert.deepEqual(keys, [...new Set(keys)], `${file}: one box per key`);
  }
  for (const file of ["marion-e-01.pdf", "marion-b-01s.pdf", "coos-electrical.pdf", "bcd-5952-2024.pdf"]) {
    const r = await autoFillByFieldName(blank(file), ROW);
    const keys = r.matched.map((m) => m.key);
    assert.deepEqual(keys, [...new Set(keys)], `${file}: one box per key`);
  }
});

// ── An agency's box above the applicant's banner (issue #446) ──────────────────────────────
await check("Albuquerque E-Plan: the permit number stays out of the city's top-right PERMIT # above 'APPLICANT TO PROVIDE ALL INFORMATION BELOW' (#446)", async () => {
  const f = await flat("abq-eplan-application.pdf");
  const banner = f.items.find((i) => /APPLICANT TO PROVIDE ALL INFORMATION BELOW/.test(i.str));
  assert.ok(banner, "the banner is printed");
  assert.equal(f.byKey.permitNumber, undefined, `permit number placed at ${JSON.stringify(f.byKey.permitNumber)}`);
  assert.ok(f.placements.every((p) => p.page !== banner.page || p.y < banner.y), "nothing written above the banner");
  for (const key of ["name", "street", "zip", "date", "installer", "mailingAddress", "phone"]) assert.ok(f.byKey[key], `${key} still placed below it`);
});

console.log(`\nformFillerRightBox: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
