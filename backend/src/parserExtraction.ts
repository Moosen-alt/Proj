// THE PARSER'S SERVER HALF, IN ONE PLACE.
//
// The Parser page reads the documents' text in the browser and posts it to
// /api/parser/llm-extract; this is what that route does with it: the model's read, the
// deterministic supplements (structural intake, the packet's own application page, the AC
// disconnect callout), the hybrid image-page merge, and the client suggestion from the plan
// set's title block. Email-in intake (#489) reads the same documents on the server and calls the
// same function, so the two doors cannot disagree about what a plan set says.
import type { AppDb } from "./db";
import type { ClientResolution, LLMProvider, ParserExtractionResponse } from "../../shared/src/types";
import { logger } from "./logger";

export interface ParserExtractionInput {
  planText?: string;
  utilityBillText?: string;
  meterText?: string;
  structuralLetterText?: string;
  defaultState?: string;
  /** The hybrid plan set's image-page read (/api/parser/plan-scan-extract), merged UNDER the text read. */
  planImageRead?: unknown;
}

/**
 * Extract project fields from document text. `orgFilter` scopes the client suggestion (the same
 * filter every other read takes: a string is one org, null every org). Model errors propagate to
 * the caller, which owns how they are reported; a failed client suggestion never takes down a
 * parse that otherwise worked.
 */
export async function extractParserFields(
  db: AppDb,
  llm: LLMProvider,
  input: ParserExtractionInput,
  orgFilter: string | null,
): Promise<ParserExtractionResponse> {
  const planText = input.planText ?? "";
  const result = await llm.extractProjectFields({
    planText,
    utilityBillText: input.utilityBillText ?? "",
    meterText: input.meterText ?? "",
    structuralLetterText: input.structuralLetterText ?? "",
    defaultState: input.defaultState,
  });
  const { supplementStructuralIntake } = await import("./structuralIntake");
  let extraction = supplementStructuralIntake(result, planText);
  // The packet's own permit application / contract page (contract value, homeowner phone) and
  // the racking callouts, read deterministically with their source page cited (#201).
  const { supplementPacketApplication } = await import("./packetApplication");
  extraction = supplementPacketApplication(extraction, planText);
  // The AC disconnect's make / model (and amps / fusing) from its own SLD / schedule callout (#384).
  const { supplementAcDisconnect } = await import("./acDisconnectIntake");
  extraction = supplementAcDisconnect(extraction, planText);
  // HYBRID PLAN SET: the parser page first posted the PDF to /api/parser/plan-scan-extract, which
  // read the set's image-only pages (datasheets pasted in as pictures) by vision; that read rides
  // back here and is merged UNDER this text read — the text wins every field it answered
  // (scannedPlanSet.mergeImagePageRead validates the posted shape).
  if (input.planImageRead && typeof input.planImageRead === "object") {
    const { mergeImagePageRead } = await import("./scannedPlanSet");
    extraction = mergeImagePageRead(extraction, input.planImageRead);
  }
  // WHICH COMPANY IS THIS? The prompt has always read the title-block installer and
  // always dropped it. Resolve it here, on the response the parser page already
  // waits for, so the (still required) client picker can fill itself instead of
  // asking the coordinator to pick blind. Tenancy-scoped with the same org filter
  // every other read uses — suggesting another tenant's company would be exactly
  // the cross-company error this feature exists to prevent. A resolution failure
  // must never take down a parse that otherwise worked.
  let clientResolution: ClientResolution | undefined;
  try {
    const { resolveClientForExtraction } = await import("./clientMatch");
    clientResolution = resolveClientForExtraction(db, extraction.fields, orgFilter, planText);
  } catch (err) {
    logger.warn("parser", "client resolution failed — parse returned without a client suggestion", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { ...extraction, clientResolution };
}
