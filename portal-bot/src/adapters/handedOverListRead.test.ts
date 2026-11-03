// #333 round 5 (Helm item 7, decision 6) — ON THE HANDED-OVER PATH, #400'S ACCOUNT-LIST READ SITS ON TOP
// OF THE CAPTURE'S OWN JUDGEMENT, NEVER IN PLACE OF IT.
//
// After a person's click on a handed-over review page, captureSubmissionConfirmation judges the page
// against the review's own reading (judgeCompletion). When the page has no number of its own, #400's
// before/after list diff may still find exactly one new application in the account's list:
//   1. on a page judged to BE the completion, that one new row is the filing: recorded high, from the
//      account list, with the row's own link;
//   2. on a page NOT judged the completion, the same row is only a candidate for a person to confirm
//      (a draft lists too): low, no record number, the row offered with its link.
// Pinned through the real method on a stub page (no Chromium): the page's own reading and the judgement
// are stubbed, the list diff, the link choice and the downgrade are the code's own.
//
// GUARD PINS, green on the tree by design (the merge built the branch in 3ab2827d). Kills, measured in a
// throwaway tree: never downgrade (drop the `!judged.confirmed` branch) → case 2 red; always downgrade
// (the branch without `!judged.confirmed`) → case 1 red.
//
//   npx tsx portal-bot/src/adapters/handedOverListRead.test.ts
import type { PortalRecipe } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";
import { readApplicationLedgerInPage, recordLinkForNumberInPage, type LedgerEntry, type SubmitRecordRead } from "./submissionLedger";

let failures = 0;
let total = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  total++;
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const recipe = {
  id: "handed-over-list-read", scopeType: "utility", profileKey: "or|fernhollow-power|", state: "OR", ahj: "", utility: "Fernhollow Power",
  portalPlatform: "fixture", portalUrl: "https://portal.example/login", status: "complete", version: 1, createdBy: "test", createdAt: "", updatedAt: "", notes: "",
  steps: [],
} as unknown as PortalRecipe;

// The account's list before the click (read at openSubmission) and after it (on the page the person is left on).
const OLD: LedgerEntry = { id: "APP-110001", href: "https://portal.example/projects/110001", row: "APP-110001 Submitted 10/01/2026" };
const NEW: LedgerEntry = { id: "APP-110002", href: "https://portal.example/projects/110002", row: "APP-110002 Submitted 10/30/2026" };

interface Internals {
  page: unknown; ledgerBefore: LedgerEntry[] | null; reviewReading: unknown;
  readPageForCapture: () => Promise<unknown>;
  judgeCompletion: (read: unknown, at: number) => { number: string; confirmed: boolean; stillReview: boolean };
  reopenHumanSubmit: () => void;
  captureSubmissionConfirmation: () => Promise<{ ok: boolean; message: string; data?: Record<string, unknown> }>;
}

const captureAfterClick = async (confirmed: boolean): Promise<{ message: string; recordRead: SubmitRecordRead | undefined; reopened: boolean }> => {
  const adapter = new RecipeAdapter(recipe, {}, {}, {}) as unknown as Internals;
  adapter.page = {
    url: () => "https://portal.example/projects",
    waitForLoadState: async () => undefined,
    locator: () => ({ innerText: async () => "Your projects" }),
    evaluate: async (fn: unknown) => {
      if (fn === readApplicationLedgerInPage) return [OLD, NEW];
      if (fn === recordLinkForNumberInPage) return "";
      throw new Error("unexpected page.evaluate in this test");
    },
  };
  adapter.ledgerBefore = [OLD];
  adapter.reviewReading = { numbers: new Set<string>(), filingControl: "Submit", completionPhrase: null };
  adapter.readPageForCapture = async () => ({ text: "Your projects", cellFree: "Your projects", filingControl: "", reviewPage: false });
  adapter.judgeCompletion = () => ({ number: "", confirmed, stillReview: false });
  let reopened = false;
  adapter.reopenHumanSubmit = () => { reopened = true; };
  const r = await adapter.captureSubmissionConfirmation();
  return { message: r.message, recordRead: r.data?.recordRead as SubmitRecordRead | undefined, reopened };
};

console.log("\n#333 round 5 — #400's list read on the handed-over path (decision 6)");
{
  const r = await captureAfterClick(true);
  check("1. a page judged the completion, no number on it, one new row in the list: recorded HIGH from the account list",
    r.recordRead?.confidence === "high" && r.recordRead.source === "account_list" && r.recordRead.recordNumber === NEW.id, JSON.stringify(r));
  check("1. …with the new row's own link", r.recordRead?.recordLink === NEW.href, JSON.stringify(r.recordRead));
  check("1. …and the watch is not reopened (the page is not the review)", r.reopened === false, JSON.stringify(r));
}
{
  const r = await captureAfterClick(false);
  check("2. a page NOT judged the completion, the same one new row: never recorded — low, no record number",
    r.recordRead?.confidence === "low" && r.recordRead.recordNumber === "" && r.recordRead.source === "none", JSON.stringify(r));
  check("2. …the row is offered as a candidate for a person to confirm, with its link",
    (r.recordRead?.candidates ?? []).length === 1 && r.recordRead!.candidates[0].recordNumber === NEW.id && r.recordRead!.candidates[0].recordLink === NEW.href && r.recordRead!.candidates[0].source === "account_list",
    JSON.stringify(r.recordRead));
  check("2. …and the message says the page does not read as the completion", /does not read as the application's completion/.test(r.message), r.message);
}

if (failures) {
  console.error(`\n${failures}/${total} handedOverListRead check(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll ${total}/${total} handedOverListRead checks passed.`);
