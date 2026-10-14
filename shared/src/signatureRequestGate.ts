// ---------------------------------------------------------------------------------------------
// MAY AUTOMATION CLICK "REQUEST SIGNATURES"? (#308; owner ruling 2026-10-14 on #305: "Auto").
//
// PSE's PowerClerk Part 2 step 4 ends in "Application for Signature (Individual)": eSign, then
// Preview Document, then Request Signatures, which sends a DocuSign email from PowerClerk to the
// PSE account holder. It FILES NOTHING (the filing is step 5's Submit, after the homeowner signs),
// so hard rule 1's gate (portalSafety.mayClickFinalSubmit / repository.automaticSubmitRefusals)
// is not asked and is not changed. But it is an outward action on a live portal: it emails a
// customer. The owner ruled the bot may click it once a named person has approved the staged
// application FOR THIS RUN. Nothing else is authority:
//
//   - a named person's approval of exactly this run (portal_signature_request_approvals, claimed
//     by id before the first staging gate and burned if any gate refuses: signatureRequestApproval.ts);
//   - PORTAL_ALLOW_FINAL_SUBMIT is NOT read here. It is the final-submit switch, and "=1 alone"
//     must never send a homeowner an email. This function takes no environment at all;
//   - the page must be in the state the person approved: eSign chosen (never Sign and Upload),
//     every required consent ticked, the document previewed, ONE request control, and no request
//     already sent (a second click would email the homeowner twice).
//
// The default, with no approval, is the stop in front of Request Signatures (review state
// "awaiting signature request"); a person clicks it, or approves a run that does.
// ---------------------------------------------------------------------------------------------

export interface SignatureRequestApproval {
  /** The named person who approved this run's signature request. */
  approver: string;
  /** The run the approval names (its id IS that run's id). */
  runId: string;
}

/** What the step-4 page reads as, at the moment of the click. */
export interface SignatureRequestPageState {
  /** How many "Request Signatures" controls the page offers (exactly one is clickable). */
  requestControls: number;
  /** Preview Document completed in this run (a document opened, downloaded, or the status moved). */
  previewed: boolean;
  /** The signature type selected on the page: eSign, Sign and Upload, or "" when unreadable. */
  signatureType: "esign" | "sign_and_upload" | "";
  /** Every REQUIRED consent on the page is ticked. */
  consentsComplete: boolean;
  /** The signature status the page shows ("Not yet previewed", "Requested", ...), raw. */
  status: string;
}

export interface SignatureRequestContext {
  /** The approval this run claimed, or null. Never a standing per-portal or per-recipe arm. */
  runApproval: SignatureRequestApproval | null | undefined;
  /** This run's id. */
  runId: string | null | undefined;
  page: SignatureRequestPageState | null | undefined;
}

/** A status that says the request already went (or the homeowner already signed). */
const SIGNATURE_ALREADY_REQUESTED = /\b(requested|sent|delivered|awaiting\s+(customer\s+|homeowner\s+)?signatures?|out\s+for\s+signature|signed|completed?)\b/i;

/** Does the signature status say a request already went? A negated word ("Not yet requested",
 *  "Not signed") says the opposite and is cut first; an empty status says nothing. */
export function signatureStatusSaysRequested(status: string | null | undefined): boolean {
  const t = String(status ?? "").replace(/\bnot\s+(yet\s+)?[a-z]+/gi, " ").replace(/\bun(signed|sent|requested)\b/gi, " ");
  return SIGNATURE_ALREADY_REQUESTED.test(t);
}

/** Every reason automation may NOT click Request Signatures in this run. Empty only when all hold. */
export function signatureRequestRefusals(ctx: SignatureRequestContext | null | undefined): string[] {
  if (!ctx) return ["no context"];
  const out: string[] = [];
  const a = ctx.runApproval;
  const approver = a && typeof a.approver === "string" ? a.approver.trim() : "";
  const approvedRun = a && typeof a.runId === "string" ? a.runId.trim() : "";
  const runId = typeof ctx.runId === "string" ? ctx.runId.trim() : "";
  if (!a) out.push("no named person approved this run's signature request");
  else {
    if (!approver) out.push("the approval names no approver");
    if (!approvedRun || !runId || approvedRun !== runId) out.push("the approval is for a different run");
  }
  const p = ctx.page;
  if (!p) {
    out.push("the signature step was not read");
    return out;
  }
  if (p.requestControls !== 1) out.push(`the page offers ${p.requestControls} Request Signatures controls, not exactly one`);
  if (p.signatureType !== "esign") out.push(p.signatureType === "sign_and_upload" ? "Sign and Upload is selected, not eSign" : "eSign is not selected");
  if (!p.consentsComplete) out.push("a required consent is not ticked");
  if (!p.previewed) out.push("the document was not previewed in this run");
  if (signatureStatusSaysRequested(p.status)) out.push(`the signature status already reads "${String(p.status).slice(0, 60)}" — a second request would email the homeowner again`);
  return out;
}

/** THE decision: may automation click Request Signatures in this run? */
export function mayRequestSignatures(ctx: SignatureRequestContext | null | undefined): boolean {
  return signatureRequestRefusals(ctx).length === 0;
}

/** The one sentence a person reads about this gate (stop messages, the dashboard). */
export const SIGNATURE_REQUEST_GATE_SENTENCE =
  "Request Signatures (the utility's DocuSign email to the homeowner) is clicked by the bot only in a run a named person "
  + "approved (Approve & request signatures); otherwise the run stops in front of it for a person. It is never the filing, "
  + "and Sign and Upload is never chosen by the bot.";
