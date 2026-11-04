// WHICH SUGGESTION IS THIS JOB'S? (#575)
//
// Pins typeaheadMatch.ts, the one predicate a search-as-you-type box is picked by (learner and
// replay alike):
//   MUST PICK    — the job's address as the portal words it (upper case, suffix spelled out, the
//                  city and ZIP after it, a parcel id in front of it); an exact non-address value.
//   PICK, SAID   — the only address on the list that differs from the job's ONLY in its street
//                  direction (S vs W, or a directional the project does not have): the portal's
//                  spelling, with a note (adjusted). The same line listed twice counts once.
//   MUST ASK     — two directions of the same house on the list (S and N); a direction plus any
//                  other difference; a unit the project does not name; the same address listed
//                  twice in two spellings; a city the suggestion names that is not the job's.
//   MUST REFUSE  — another house number, another street (Example vs Example Ridge), another suffix
//                  (Ct vs Dr), another ZIP; a containment match on a non-address value; the
//                  widget's own "No results" row.
// Plus what is typed (house + core name first, the house alone to widen) and how a fill is judged
// (by its binding first, never by "starts with a digit").
// All addresses are synthetic: invented streets, numbers and cities.
// Run: tsx portal-bot/src/typeaheadMatch.test.ts
import assert from "node:assert/strict";
import { addressQueries, chooseAddressSuggestion, chooseExactSuggestion, suggestionText, typeaheadMatchMode } from "./typeaheadMatch";
import { siteKey } from "./draftCreated";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const SITE = { street: "4821 W Quillfeather Dr", city: "Marrowvale", zip: "84999" };

// ---- MUST PICK ------------------------------------------------------------------------------
check("the job's address in the portal's own wording is picked", () => {
  const c = chooseAddressSuggestion(["4821 W QUILLFEATHER DRIVE, MARROWVALE, UT 84999"], SITE);
  assert.equal(c.kind, "pick");
  if (c.kind === "pick") assert.equal(c.index, 0);
});
check("...among neighbours on the same street (another number, another direction)", () => {
  const c = chooseAddressSuggestion([
    "4820 W QUILLFEATHER DR",
    "4821 S QUILLFEATHER DR",
    "4821 W QUILLFEATHER DR",
    "48210 W QUILLFEATHER DR",
  ], SITE);
  assert.equal(c.kind, "pick", JSON.stringify(c));
  if (c.kind === "pick") assert.equal(c.index, 2);
});
check("...with the suggestion naming no city or ZIP", () => {
  const c = chooseAddressSuggestion(["4821 W Quillfeather Dr"], SITE);
  assert.equal(c.kind, "pick", JSON.stringify(c));
});
check("...with a parcel id in front of the address", () => {
  const c = chooseAddressSuggestion(["12-345-0067 | 4821 W QUILLFEATHER DR MARROWVALE"], SITE);
  assert.equal(c.kind, "pick", JSON.stringify(c));
});
check("...with the direction spelled out on one side", () => {
  const c = chooseAddressSuggestion(["4821 West Quillfeather Dr"], SITE);
  assert.equal(c.kind, "pick", JSON.stringify(c));
});
check("...and a post-directional street matches its own post-directional", () => {
  const c = chooseAddressSuggestion(["210 Larkhollow Ave NW, Marrowvale"], { street: "210 Larkhollow Avenue NW", city: "Marrowvale" });
  assert.equal(c.kind, "pick", JSON.stringify(c));
});
check("an exact match beside a near miss is picked (the near miss is another door)", () => {
  const c = chooseAddressSuggestion(["4821 W QUILLFEATHER DR UNIT B", "4821 W QUILLFEATHER DR"], SITE);
  assert.equal(c.kind, "pick", JSON.stringify(c));
  if (c.kind === "pick") assert.equal(c.index, 1);
});

// ---- ONLY THE DIRECTION DIFFERS, THE ONLY SUCH ADDRESS: the portal's spelling, said ------------
check("a DIRECTION-only difference, the only such address on the list: picked in the portal's spelling, with a note", () => {
  const c = chooseAddressSuggestion(["4812 S QUILLFEATHER DR, MARROWVALE, UT 84999", "4821 S QUILLFEATHER DR, MARROWVALE, UT 84999"], SITE);
  assert.equal(c.kind, "pick", JSON.stringify(c));
  if (c.kind === "pick") {
    assert.equal(c.index, 1);
    assert.ok(c.adjusted, "the pick carries its note");
    assert.match(String(c.adjusted), /4821 S QUILLFEATHER DR/);
    assert.match(String(c.adjusted), /4821 W Quillfeather Dr/);
    assert.match(String(c.adjusted), /direction/);
  }
});
check("...the same line listed twice still counts as one (the live city's two identical rows)", () => {
  const c = chooseAddressSuggestion(["4821 S QUILLFEATHER DR", "4821 S QUILLFEATHER DR"], SITE);
  assert.equal(c.kind, "pick", JSON.stringify(c));
  if (c.kind === "pick") { assert.equal(c.index, 0); assert.ok(c.adjusted); }
});
check("...and a directional the project does not have is the same rule (the only such address: picked, said)", () => {
  const c = chooseAddressSuggestion(["77 N Brindlecove Ln"], { street: "77 Brindlecove Ln", city: "Marrowvale" });
  assert.equal(c.kind, "pick", JSON.stringify(c));
  if (c.kind === "pick") assert.ok(c.adjusted);
});
check("an exact match is never marked adjusted", () => {
  const c = chooseAddressSuggestion(["4821 W QUILLFEATHER DR"], SITE);
  assert.equal(c.kind, "pick", JSON.stringify(c));
  if (c.kind === "pick") assert.equal(c.adjusted, undefined);
});

// ---- MUST ASK -------------------------------------------------------------------------------
check("TWO directions of the same house number on the list (S and N, a grid city's two streets): ask, naming both", () => {
  const c = chooseAddressSuggestion(["4821 S QUILLFEATHER DR, MARROWVALE, UT 84999", "4821 N QUILLFEATHER DR, MARROWVALE, UT 84999"], SITE);
  assert.equal(c.kind, "ask", JSON.stringify(c));
  if (c.kind === "ask") {
    assert.match(c.question, /4821 S QUILLFEATHER DR/);
    assert.match(c.question, /4821 N QUILLFEATHER DR/);
    assert.match(c.question, /4821 W Quillfeather Dr/);
  }
});
check("a direction AND a unit that differ is not direction-only: ask", () => {
  const c = chooseAddressSuggestion(["4821 S QUILLFEATHER DR APT 3"], SITE);
  assert.equal(c.kind, "ask", JSON.stringify(c));
});
check("a unit the project does not name asks", () => {
  const c = chooseAddressSuggestion(["4821 W QUILLFEATHER DR APT 3"], SITE);
  assert.equal(c.kind, "ask", JSON.stringify(c));
});
check("a unit that disagrees asks", () => {
  const c = chooseAddressSuggestion(["4821 W QUILLFEATHER DR UNIT 7"], { ...SITE, street: "4821 W Quillfeather Dr Unit 2" });
  assert.equal(c.kind, "ask", JSON.stringify(c));
});
check("the same address listed twice (two parcels) is several equal candidates: ask", () => {
  const c = chooseAddressSuggestion(["4821 W QUILLFEATHER DR", "4821 W Quillfeather Drive"], SITE);
  assert.equal(c.kind, "ask", JSON.stringify(c));
  if (c.kind === "ask") assert.equal(c.candidates.length, 2);
});
check("a city the suggestion names that is not the job's asks", () => {
  const c = chooseAddressSuggestion(["4821 W QUILLFEATHER DR, THISTLEPORT"], SITE);
  assert.equal(c.kind, "ask", JSON.stringify(c));
});
check("several near misses ask once, listing them", () => {
  const c = chooseAddressSuggestion(["4821 S QUILLFEATHER DR", "4821 E QUILLFEATHER DR"], SITE);
  assert.equal(c.kind, "ask", JSON.stringify(c));
  if (c.kind === "ask") assert.equal(c.candidates.length, 2);
});

// ---- MUST REFUSE ----------------------------------------------------------------------------
check("another house number is not a match and not a near miss", () => {
  assert.equal(chooseAddressSuggestion(["4812 W QUILLFEATHER DR"], SITE).kind, "none");
});
check("another street that merely contains the name is refused (Quillfeather Ridge)", () => {
  assert.equal(chooseAddressSuggestion(["4821 W QUILLFEATHER RIDGE DR"], SITE).kind, "none");
});
check("another suffix is another street (Ct vs Dr)", () => {
  assert.equal(chooseAddressSuggestion(["4821 W QUILLFEATHER CT"], SITE).kind, "none");
});
check("...and so is the reverse, a Court project against a Drive suggestion", () => {
  assert.equal(chooseAddressSuggestion(["4821 W QUILLFEATHER DR"], { ...SITE, street: "4821 W Quillfeather Ct" }).kind, "none");
  assert.equal(chooseAddressSuggestion(["4821 W QUILLFEATHER COURT"], { ...SITE, street: "4821 W Quillfeather Ct" }).kind, "pick");
});
check("a leading NE is a directional, not Nebraska (the address still keys)", () => {
  const ne = { street: "3307 NE Saltmarsh St", city: "Marrowvale" };
  const exact = chooseAddressSuggestion(["3307 NE SALTMARSH ST"], ne);
  assert.equal(exact.kind, "pick");
  assert.equal(exact.kind === "pick" ? exact.adjusted : "x", undefined, "NE for NE is exact, no note");
  // NW alone is the direction-only exception (picked, said); NW beside NE is two streets (ask).
  const nwOnly = chooseAddressSuggestion(["3307 NW SALTMARSH ST"], ne);
  assert.equal(nwOnly.kind, "pick");
  assert.ok(nwOnly.kind === "pick" && nwOnly.adjusted);
  assert.equal(chooseAddressSuggestion(["3307 NW SALTMARSH ST", "3307 SW SALTMARSH ST"], ne).kind, "ask");
});
check("a leading Mt is Mount, not Montana", () => {
  const mt = { street: "58 Mt Corrowind Rd", city: "Marrowvale" };
  assert.equal(chooseAddressSuggestion(["58 MOUNT CORROWIND ROAD"], mt).kind, "pick");
});
check("another ZIP is another address", () => {
  assert.equal(chooseAddressSuggestion(["4821 W QUILLFEATHER DR 84111"], SITE).kind, "none");
});
check("the widget's own status row is not a suggestion", () => {
  assert.equal(suggestionText("No results found"), "");
  assert.equal(suggestionText("Searching..."), "");
  assert.equal(chooseAddressSuggestion(["No matching addresses"], SITE).kind, "none");
});
check("an empty list is none, and says so", () => {
  const c = chooseAddressSuggestion([], SITE);
  assert.equal(c.kind, "none");
  if (c.kind === "none") assert.match(c.why, /no suggestions/);
});

// ---- ANY OTHER LOOKUP: exact or nothing ------------------------------------------------------
check("a non-address value is picked on an exact match (case and punctuation ignored)", () => {
  const c = chooseExactSuggestion(["Bramblecrest Solar Co", "Bramblecrest Solar Co., Northwest"], "BRAMBLECREST SOLAR CO.");
  assert.equal(c.kind, "pick", JSON.stringify(c));
  if (c.kind === "pick") assert.equal(c.index, 0);
});
check("MUST EXCLUDE: a containment is not a match (Sun Co is not Sun Co Northwest)", () => {
  assert.equal(chooseExactSuggestion(["Bramblecrest Solar Co Northwest"], "Bramblecrest Solar Co").kind, "none");
});
check("two identical entries ask", () => {
  assert.equal(chooseExactSuggestion(["Bramblecrest Solar Co", "Bramblecrest Solar Co"], "Bramblecrest Solar Co").kind, "ask");
});

// ---- WHAT IS TYPED --------------------------------------------------------------------------
check("an address is typed as house number + core name, then the house number alone", () => {
  assert.deepEqual(addressQueries("4821 W Quillfeather Dr"), ["4821 Quillfeather", "4821"]);
  assert.deepEqual(addressQueries("4821 W Quillfeather Dr, Marrowvale, UT, 84999"), ["4821 Quillfeather", "4821"]);
});
check("an address with no house number is typed as its street line", () => {
  assert.deepEqual(addressQueries("Rural Route Quillfeather"), ["Rural Route Quillfeather"]);
});

// ---- HOW A FILL IS JUDGED -------------------------------------------------------------------
check("bound to the project's street: judged as the job's site (city/ZIP checked)", () => {
  assert.equal(typeaheadMatchMode({ field: "street", label: "Location", value: "4821 W Quillfeather Dr" }), "site");
  assert.equal(typeaheadMatchMode({ field: "projectAddress", label: "Anything", value: "x" }), "site");
});
check("an unbound literal of the job's own street is the site too", () => {
  assert.equal(typeaheadMatchMode({ label: "Location", value: "4821 W QUILLFEATHER DR", projectStreet: "4821 W Quillfeather Dr" }), "site");
});
check("another address in an address box is judged as an address, without the job's city", () => {
  assert.equal(typeaheadMatchMode({ field: "installerAddress", label: "Mailing Address", value: "9 Copperfen Way", projectStreet: "4821 W Quillfeather Dr" }), "address");
});
check("MUST EXCLUDE: a value that merely starts with a digit is not an address", () => {
  assert.equal(typeaheadMatchMode({ label: "Service size", value: "200 Amp", projectStreet: "4821 W Quillfeather Dr" }), "exact");
  assert.equal(typeaheadMatchMode({ label: "Contractor", value: "Bramblecrest Solar Co" }), "exact");
});

// ---- THE SHARED SITE KEY: dirs added, nothing else moved -------------------------------------
check("siteKey reads the directionals and leaves words / suffix / unit as before", () => {
  const k = siteKey({ street: "4821 W Quillfeather Dr", city: "Marrowvale" });
  assert.ok(k);
  assert.deepEqual(k!.dirs, ["w"]);
  assert.deepEqual(k!.words, ["quillfeather"]);
  assert.equal(k!.suffix, "dr");
  const post = siteKey({ street: "210 Larkhollow Ave NW Unit 4" });
  assert.deepEqual(post!.dirs, ["nw"]);
  assert.equal(post!.suffix, "ave");
  const none = siteKey({ street: "77 Brindlecove Ln" });
  assert.deepEqual(none!.dirs, []);
});

if (failures) { console.error(`\n${failures} typeaheadMatch check(s) failed`); process.exit(1); }
console.log("\ntypeaheadMatch: all checks passed");
