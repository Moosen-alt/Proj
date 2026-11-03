// #436 PR1 — THE STAGED DRAFT'S REFERENCE: every refusal of stagedDraftReference, by name.
//
// The reader and the row's one writer keep the draft id and review link EXACTLY (PR2 binds them) or
// refuse both — never a masked look-alike. Pure, no browser.
//   MUST-PASS  PowerClerk 204411 / 42199 / AB12345CDE / QS6TY7QARSY7 and an Accela capID come back
//              exactly, refused "".
//   MUST-EXCL  one input per refusal branch → draftId "" AND reviewLink "", and the named reason:
//              empty link; over 1000 characters (refused, never cut); does not parse; not http(s);
//              a user name or password; a project secret in the link (plain, with separators,
//              percent-encoded, "+"-encoded spaces) or in the id; an email address; no id; an id
//              that is not id-shaped; a link that is not in its kept form (session material); an id
//              that is not the link's own.
//
// KILL: replace stagedDraftReference's body with `return { draftId, reviewLink: link, refused: "" }`
// (after the two trims) → every MUST-EXCL check fails.
//
//   npx tsx portal-bot/src/stagedDraftReference.test.ts
import assert from "node:assert/strict";
import { STAGED_LINK_MAX, stagedDraftReference } from "./stagedDraftReference";

let failures = 0;
let total = 0;
const check = (label: string, fn: () => void): void => {
  total++;
  try { fn(); console.log(`  ok   - ${label}`); } catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

// Synthetic only.
const ACCOUNT = "8814402937";
const METER = "55120938";
const SECRETS = [ACCOUNT, METER];
const PC = "https://utility.powerclerk.example/MvcProjects/EditForm";

check("MUST-PASS: the portal's own id and link come back exactly", () => {
  for (const [link, id] of [
    [`${PC}?ProjectId=204411&FormId=9`, "204411"],
    [`${PC}?ProjectId=42199&FormId=9`, "42199"],
    [`${PC}?ProjectId=AB12345CDE&FormId=9`, "AB12345CDE"],
    [`${PC}?ProjectId=QS6TY7QARSY7&FormId=9`, "QS6TY7QARSY7"],
    ["https://aca.example.gov/Cap/CapEdit.aspx?capID1=26CAP&capID2=00000&capID3=00ABC", "26CAP-00000-00ABC"],
  ] as const) {
    assert.deepEqual(stagedDraftReference(id, link, SECRETS), { draftId: id, reviewLink: link, refused: "" }, link);
  }
});

const refused = (label: string, id: string, link: string, want: RegExp): void => {
  check(`MUST-EXCL: ${label}`, () => {
    const r = stagedDraftReference(id, link, SECRETS);
    assert.equal(r.draftId, "", "the id was kept");
    assert.equal(r.reviewLink, "", "the link was kept");
    assert.match(r.refused, want);
  });
};
refused("an empty link", "204411", "", /link is empty/);
refused(`a link over ${STAGED_LINK_MAX} characters (refused, never cut)`, "204411", `${PC}?ProjectId=204411&FormId=9&x=${"a".repeat(STAGED_LINK_MAX)}`, /longer than 1000 characters/);
refused("a link that does not parse", "204411", "not a url at all", /does not parse/);
refused("a link that is not http(s)", "204411", "ftp://utility.powerclerk.example/MvcProjects/EditForm?ProjectId=204411", /not an http\(s\) link/);
refused("a link with a user name and password", "204411", "https://op:pw@utility.powerclerk.example/MvcProjects/EditForm?ProjectId=204411&FormId=9", /user name or password/);
refused("the account as the id, plain", ACCOUNT, `${PC}?ProjectId=${ACCOUNT}&FormId=9`, /carries one of the project's own account or meter numbers/);
refused("the account with separators", "8814-402-937", `${PC}?ProjectId=8814-402-937&FormId=9`, /carries one of the project's own/);
refused("the meter in another kept parameter, percent-encoded spaces", "204411", `${PC}?ProjectId=204411&FormId=9&id=55%20120%20938`, /carries one of the project's own/);
refused("the account with '+'-encoded spaces in the link only", "204411", `${PC}?ProjectId=204411&FormId=9&id=8814+402+937`, /carries one of the project's own/);
refused("a secret in the id alone", `X${ACCOUNT}`, `${PC}?ProjectId=204411&FormId=9`, /carries one of the project's own/);
refused("an email address in the link", "204411", `${PC}?ProjectId=204411&FormId=9&id=avery%40example.com`, /carries an email address/);
refused("no id", "", `${PC}?FormId=9`, /carries no draft id/);
refused("an id that is not id-shaped", "2044 11", `${PC}?ProjectId=2044%2011&FormId=9`, /not id-shaped/);
refused("a link not in its kept form (a session token)", "204411", `${PC}?ProjectId=204411&FormId=9&sessionToken=abc`, /not in its kept form/);
refused("an id that is not the link's own", "204412", `${PC}?ProjectId=204411&FormId=9`, /not the one the review page's link carries/);

console.log(failures === 0 ? `\nAll ${total}/${total} stagedDraftReference checks passed.` : `\n${failures}/${total} stagedDraftReference check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
