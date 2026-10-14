// ---------------------------------------------------------------------------------------------
// HAS THE HOMEOWNER SIGNED? (#310: resume after the homeowner signs).
//
// After Request Signatures (#308), PSE's PowerClerk record shows the DocuSign status of the
// application ("Not yet previewed" -> requested -> signed) while the application itself sits as
// "Application Draft / Unsubmitted". The filing is Part 2 step 5's Submit, and it waits on that
// signature. This module reads the statuses a page shows and answers ONE question: is every one of
// them, positively, signed?
//
// The same discipline as signatureRequestGate (the request click): EVERY status is read, and a
// status counts as complete only on a positive match. "Pending Signature", "Declined", "Voided",
// "Partially signed", an empty read or a word this module does not know is NOT signed: the track
// stays "awaiting customer signature" and the answer names why. Nothing here is guessed from the
// application's own status: "Application Draft" says nothing about the signature.
//
// It decides no click. The step 5 Submit after a complete signature goes through hard rule 1's gate
// (portalSafety.mayClickFinalSubmit / repository.automaticSubmitRefusals) unchanged.
// ---------------------------------------------------------------------------------------------
import { signatureStatusReadsUnrequested } from "./signatureRequestGate";

/** How ONE signature status reads. */
export type SignatureStatusReading = "signed" | "requested" | "not_requested" | "unfamiliar";

/** How the page's signature statuses read, all together. */
export type SignatureCompletionReading = "signed" | "requested" | "not_requested" | "unreadable";

export interface SignatureCompletion {
  reading: SignatureCompletionReading;
  /** True only when every status read says, positively, signed. */
  signed: boolean;
  /** One sentence for a person: what the page said, and why it does or does not count. */
  why: string;
  /** The statuses read (each capped), for the run's record. */
  statuses: string[];
}

const squash = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();

// A who/when tail a portal may put after the status word: "Signed on 10/12/2026", "Completed by
// Jordan Testcase", "Signed - 10/12/2026 3:14 PM". Only "on/by/at …" or a date/time: any other
// trailing words ("Completed Preview") make the status something this module does not know.
const TAIL = String.raw`(?:\s*(?:[,;:–—-]+\s*|\s+)(?:(?:on|by|at)\s+[\w/.:,' -]{1,48}|\d[\d/.:, -]{3,24}(?:\s*[ap]\.?m\.?)?))?`;

// SIGNED, POSITIVELY: the whole status says the signing is done. "Preview Completed" (a
// not-yet-requested state), "Signature Requested", "Partially Signed" and "Signed by 1 of 2" do not
// match: the status must be one of these phrases, alone or with a who/when tail.
const SIGNED = new RegExp(
  String.raw`^\s*(?:(?:all\s+)?(?:signatures?|documents?|envelope)\s+)?(?:fully\s+|e-?)?(?:signed|executed|completed?)${TAIL}\s*\.?\s*$`
  + "|"
  + String.raw`^\s*(?:all\s+)?signatures?\s+(?:received|complete(?:d)?|captured)${TAIL}\s*\.?\s*$`
  + "|"
  + String.raw`^\s*(?:signature|signing|envelope|docusign)\s+(?:complete(?:d)?|finished)${TAIL}\s*\.?\s*$`,
  "i",
);

// Words that turn an otherwise-signed status into something else. Read first, so "Signed by 1 of 2",
// "Partially Signed", "Not signed", "Unsigned" and "Signing declined" never count as complete.
const NOT_DONE = /\b(?:not|un|partial(?:ly)?|pending|awaiting|waiting|declined|voided|void|cancel(?:led|ed)?|expired|rejected|failed|error|incomplete|\d+\s+of\s+\d+|resen[dt]|correct(?:ed|ion))\b|\bunsigned\b/i;

// REQUESTED, POSITIVELY: the request went and the homeowner has not signed yet.
const REQUESTED = new RegExp(
  String.raw`^\s*(?:signatures?\s+|e-?signature\s+|envelope\s+|docusign\s+)?(?:requested|sent|delivered|emailed|viewed|opened)${TAIL}\s*\.?\s*$`
  + "|"
  + String.raw`^\s*(?:pending|awaiting|waiting\s+(?:on|for))\s+(?:the\s+)?(?:customer\s+|homeowner\s+|signer\s+|account\s+holder\s+)?(?:e-?)?signatures?${TAIL}\s*\.?\s*$`
  + "|"
  + String.raw`^\s*(?:signature\s+)?(?:request\s+)?(?:sent|out)\s+(?:for|to)\s+(?:e-?)?signatures?${TAIL}\s*\.?\s*$`
  + "|"
  + String.raw`^\s*(?:signature\s+requested|request(?:ed)?\s+sent|out\s+for\s+signature)${TAIL}\s*\.?\s*$`,
  "i",
);

/** Read ONE signature status. Anything this module does not positively recognise is "unfamiliar". */
export function readSignatureStatus(status: string | null | undefined): SignatureStatusReading {
  const t = squash(status);
  if (!t) return "unfamiliar";
  if (SIGNED.test(t) && !NOT_DONE.test(t)) return "signed";
  if (REQUESTED.test(t) && !/\b(?:not|un)\b|\bdeclined|\bvoid/i.test(t)) return "requested";
  if (signatureStatusReadsUnrequested(t)) return "not_requested";
  return "unfamiliar";
}

/**
 * Every signature status the page shows, read together. Signed only when there is at least one and
 * every one reads signed. One unfamiliar status (or none at all) makes the whole read "unreadable":
 * a person looks at the portal; nothing proceeds on a guess.
 */
export function signatureCompletion(statuses: ReadonlyArray<string | null | undefined> | null | undefined): SignatureCompletion {
  const list = (Array.isArray(statuses) ? statuses : []).map(squash).filter(Boolean).map((s) => s.slice(0, 80));
  if (!list.length) {
    return { reading: "unreadable", signed: false, statuses: [], why: "no signature status could be read on the page" };
  }
  const readings = list.map((s) => ({ s, r: readSignatureStatus(s) }));
  const odd = readings.find((x) => x.r === "unfamiliar");
  if (odd) {
    return { reading: "unreadable", signed: false, statuses: list, why: `the signature status reads "${odd.s}", which is not a status the bot recognises as signed, requested or not yet requested` };
  }
  if (readings.every((x) => x.r === "signed")) {
    return { reading: "signed", signed: true, statuses: list, why: `every signature status reads signed (${list.map((s) => `"${s}"`).join(", ")})` };
  }
  if (readings.every((x) => x.r === "not_requested")) {
    return { reading: "not_requested", signed: false, statuses: list, why: `the signature status reads "${list[0]}": no signature request has been sent` };
  }
  const waiting = readings.find((x) => x.r !== "signed") ?? readings[0];
  return { reading: "requested", signed: false, statuses: list, why: `the signature status reads "${waiting.s}": the homeowner has not signed yet` };
}
