import { createHash } from "node:crypto";
import type { PaidFeeReceipt } from "../../shared/src/types";
import type { AppDb } from "./db";
import { nowIso } from "./time";

const dollars = (s: string | undefined): number | null => {
  if (!s) return null;
  const n = Number(s.replace(/[,$\s]/g, ""));
  return Number.isFinite(n) && n >= 0 && n < 1e7 ? n : null;
};
const money = "([\\d,]+\\.\\s*\\d{2})";
const grab = (t: string, pattern: string) => new RegExp(pattern, "i").exec(t)?.[1];
const near = (a: number | null, b: number | null) => a != null && b != null && Math.abs(a - b) <= 0.015;

/** A processor ID read after `label`, healed when the PDF wrapped it across lines.
 * It arrives, after whitespace normalisation, as "010126X1A-AAAA1111-BB22-CC33- DD44- EEEE5555FFFF".
 * A chunk ending in "-" is a wrap point, not the end of the identity — and this string is
 * the dedupe key, so it must not depend on where the PDF happened to break the line.
 * Continuations join case-SENSITIVELY and must carry a digit, so a following heading
 * ("Approval Code") is never swallowed. */
function wrappedId(t: string, label: string): string {
  let id = grab(t, `${label}\\s*([A-Z0-9-]+)`) || "";
  if (id.endsWith("-")) {
    const run = new RegExp(`${label}\\s*((?:[A-Z\\d-]+ )*[A-Z\\d-]+(?![a-z]))`).exec(t)?.[1];
    if (run && run.startsWith(id)) {
      for (const chunk of run.split(" ").slice(1)) {
        if (!id.endsWith("-") || !/\d/.test(chunk)) break;
        id += chunk;
      }
    }
  }
  return id;
}

/** Elavon "Order Confirmation" emails, by the merchant profile the authority pays through.
 * A profile is only trusted with its issuer's own wording beside it (Clackamas County's
 * Building Codes profile is "DTD BUILDING CODES", which on its own names no county), and
 * Clackamas prints the record it was paid for as an "Invoice Number" — kept as that, not
 * promoted to a permit number, because that is the shape the first one was recorded in. */
const ELAVON_PROFILES: ReadonlyArray<{ profile: string; jurisdiction: string; issuer: RegExp; invoice: boolean }> = [
  { profile: "CITY OF BEAVERTON PERMITS", jurisdiction: "City of Beaverton", issuer: /./, invoice: false },
  { profile: "DTD BUILDING CODES", jurisdiction: "Clackamas County", issuer: /@clackamas\.us\b/i, invoice: true },
];

/** Narrow receipt formats with explicit payment proof and a unique identifier.
 * Invoices, quotes, bundled orders and service-fee-only emails are not totals.
 *
 * NOT RECEIPTS, on purpose (#421): a permit card or permit printout that states the fees
 * paid to date (Newberg's issued permit "TOTAL PERMIT FEE'S PAID", Clackamas County's
 * "Total Fees / Total Payments / Balance Due" printout) is a running total of payments that
 * have their own receipts — $223.21 on a Newberg card is the $96.59 plan-review receipt plus
 * the $126.62 permit receipt — so reading one as a payment counts the money twice. An
 * authority's billing summary is an assessment (Portland prints "Paid To Date $0.00"), and
 * an email that only confirms a payment of the same record that an authority's own receipt
 * already identifies better (the Avolve "Portal Payment Receipt") carries no id that could
 * dedupe against that receipt. Planning-only payments with no record or fee description
 * (an Xpress Bill Pay "Planning Fees" line, a county planning "Order Results" email) name
 * nothing a permit schedule can be held against. All of these stay null. */
export function parsePaidFeeReceipt(raw: string): PaidFeeReceipt | null {
  const t = raw.replace(/\s+/g, " ");
  let jurisdiction = "", permitNumber = "", receiptNumber = "", paidAt = "", invoiceNumber = "";
  let unmatchedPermit = false;
  let recordDiscipline: PaidFeeReceipt["discipline"] | "" = "";
  let amount: number | null = null, processing = 0, total: number | null = null;
  const elavon = /Your payment has been approved/i.test(t) && /Total of all charges and fees/i.test(t)
    ? ELAVON_PROFILES.find((p) => new RegExp(`Profile Name ${p.profile} Transaction Type`, "i").test(t) && p.issuer.test(t))
    : undefined;
  if (/Transaction Receipt/i.test(t) && /Fees Paid/i.test(t)) {
    if (!/\bOR\s+\d{5}\b|State of Oregon/i.test(t)) return null;
    const permits = [...t.matchAll(/Record ID:\s*([A-Z0-9-]+)/gi)];
    if (permits.length !== 1) return null;
    permitNumber = permits[0][1];
    receiptNumber = grab(t, "Receipt Number:\\s*(\\d+)") || "";
    paidAt = grab(t, "Receipt Date:\\s*([0-9/]+)") || "";
    const issuer = /Receipt Date:\s*[0-9/]+\s+(.+?)\s+(?:\d{2,5}\s|Community Development Dept|PO Box)/i.exec(t)?.[1] || "";
    jurisdiction = issuer.replace(/\s+(?:Building Department|Building Codes Division)$/i, "").trim();
    total = dollars(grab(t, `Receipt Total:\\s*\\$${money}`));
    amount = total;
  } else if (/City of Tigard/.test(t) && /Transaction type:\s*Purchase/i.test(t)) {
    const permits = [...t.matchAll(/Permit:\s*([A-Z0-9-]+)/gi)];
    if (permits.length !== 1) return null;
    jurisdiction = "City of Tigard"; permitNumber = permits[0][1];
    receiptNumber = grab(t, "Confirmation number:\\s*([A-Z0-9]+)") || "";
    paidAt = grab(t, "Date:\\s*([A-Za-z]+ \\d{1,2}, \\d{4})") || "";
    amount = dollars(grab(t, `Subtotal\\s*\\$${money}`));
    processing = dollars(grab(t, `Processing fee\\s*\\$${money}`)) ?? 0;
    total = dollars(grab(t, `(?<![a-z])Total\\s*\\$${money}`));
  } else if (/City of Newberg, OR/.test(t) && /Total paid/i.test(t)) {
    const permits = [...new Set([...t.matchAll(/\b(BLD-\d{2}-\d+)\b/g)].map(m => m[1]))];
    if (permits.length !== 1 || !/No processing fees/i.test(t)) return null;
    jurisdiction = "City of Newberg"; permitNumber = permits[0];
    // The extractor may render "Receipt number # NNNN" with a space after the
    // hash — same printed receipt, different text-run spacing. The emailed copy
    // ("Payment Received") prints it as "Receipt #NNNN".
    receiptNumber = grab(t, "Receipt (?:number\\s*)?#\\s*(\\d+)") || "";
    // The emailed copy opens with the mail client's own "Fri, Jun 5, 2026" header;
    // the receipt's date is the one the authority printed ("June 5, 2026").
    paidAt = grab(t, "(?<![A-Za-z]{3}, )\\b([A-Za-z]+ \\d{1,2}, \\d{4})") || "";
    amount = total = dollars(grab(t, `Total paid\\s*\\$${money}`));
  } else if (/permits\.cityofsalem\.net/.test(t) && /Payment Receipt/i.test(t)) {
    const permits = [...new Set([...t.matchAll(/(?<!\d)(\d{2}-\d{6}-\d{2}-(?:DW|E))\b/g)].map(m => m[1]))];
    if (permits.length !== 1) return null;
    jurisdiction = "City of Salem"; permitNumber = permits[0];
    receiptNumber = /\b(\d{8})\s+[A-Za-z]+ \d{1,2}, \d{4}/.exec(t)?.[1] || "";
    paidAt = grab(t, "([A-Za-z]+ \\d{1,2}, \\d{4})") || "";
    amount = total = dollars(grab(t, `Total Paid\\s*:\\s*(?:Please Note:\\s*)?\\$${money}`));
  } else if (/washingtoncountyor\.gov/.test(t) && /Your application has been submitted/i.test(t)) {
    jurisdiction = "Washington County";
    permitNumber = grab(t, "Request Number:\\s*([A-Z0-9-]+)") || "";
    receiptNumber = grab(t, "Approval #:\\s*(\\d+)") || "";
    paidAt = grab(t, "Signature Date:\\s*([0-9/]+)") || "";
    amount = total = dollars(grab(t, `Amount:\\s*\\$${money}`));
  } else if (/@fisgov\.com\b/i.test(t) && /payment was received by Washington County Land Use and Transportation/i.test(t)) {
    // The county's payment processor confirms the same payment the portal's "application
    // has been submitted" email reports: its Confirmation/Transaction Number is that email's
    // "Approval #" and its OAS Request Number is that email's "Request Number", so both
    // documents land on one identity.
    const requests = [...new Set([...t.matchAll(/OAS Request Number\s*:\s*([A-Z]+-[A-Z]+-\d+)\b/gi)].map(m => m[1]))];
    if (requests.length !== 1) return null;
    jurisdiction = "Washington County"; permitNumber = requests[0];
    receiptNumber = grab(t, "Confirmation/Transaction Number:\\s*(\\d+)") || "";
    paidAt = grab(t, "Date and Time:\\s*([0-9/]+)") || "";
    amount = dollars(grab(t, `(?<!Total )Payment Amount:\\s*\\$${money}`));
    processing = dollars(grab(t, `Service Fee:\\s*\\$${money}`)) ?? 0;
    total = dollars(grab(t, `Total Payment Amount:\\s*\\$${money}`));
    // The "Payment Details" block repeats the split; where printed it must agree.
    const sub = dollars(grab(t, `Subtotal:\\s*\\$${money}`)), all = dollars(grab(t, `Total Amount:\\s*\\$${money}`));
    if ((sub != null && !near(sub, amount)) || (all != null && !near(all, total))) return null;
  } else if (/Portland\.Receipts@portlandoregon\.gov/i.test(t) && /Your payment was successfully processed/i.test(t)
    && /remitted back to the City of Portland/i.test(t)) {
    // City of Portland's online payment receipt. It names the BILLS it paid (each billing
    // summary bill is one line), not a permit, so the payment stays unlinked to a record.
    // Every printed figure has to agree: each bill line (unit x quantity), their sum, the
    // "City of Portland Online Payments" line and each "Total Amount Paid".
    const orders = [...new Set([...t.matchAll(/Order ID\s*(\d{6,})\b/gi)].map(m => m[1]))];
    const paid = [...new Set([...t.matchAll(new RegExp(`Total Amount Paid\\s*\\$${money}`, "gi"))].map(m => dollars(m[1])))];
    const bills = [...t.matchAll(new RegExp(`Bill Number\\s*\\d+\\s*\\$${money}\\s*(\\d+)\\s*\\$${money}`, "gi"))];
    if (orders.length !== 1 || paid.length !== 1 || paid[0] == null || !bills.length) return null;
    let billed = 0;
    for (const b of bills) {
      const unit = dollars(b[1]), line = dollars(b[3]);
      if (unit == null || line == null || !near(unit * Number(b[2]), line)) return null;
      billed += line;
    }
    if (!near(billed, paid[0]) || !near(dollars(grab(t, `City of Portland Online Payments\\s*\\$${money}`)), paid[0])) return null;
    jurisdiction = "City of Portland"; receiptNumber = orders[0];
    paidAt = grab(t, "Receipt Date\\s*([0-9/]+)") || "";
    amount = total = paid[0];
    unmatchedPermit = true;
  } else if (/donotreply-clackamas@accela\.com/i.test(t) && /RECEIPT NUMBER:/.test(t) && /\bFEES Code Description\b/.test(t)) {
    // Clackamas County's own receipt for a record. Its payment "Reference No" is the Elavon
    // transaction the card payment went through, so it is read as that receipt's identity —
    // the Elavon email for the same payment then lands on the same row instead of a second one.
    const records = [...new Set([...t.matchAll(/\bRECORD:\s*([A-Z]{1,3}\d{5,})\b/g)].map(m => m[1]))];
    const feesAt = t.search(/\bFEES Code Description\b/), payAt = t.search(/\bPAYMENT Method\b/);
    if (records.length !== 1 || payAt < feesAt) return null;
    const fees = t.slice(feesAt, payAt), pay = t.slice(payAt);
    const feeTotal = dollars(grab(fees, `\\bTOTAL\\s*\\$${money}`));
    const feeLines = [...fees.matchAll(/\b\d+\.\d{2}\s+\$([\d,]+\.\d{2})\b/g)];
    const payments = [...pay.matchAll(new RegExp(`(\\d{1,2}/\\d{1,2}/\\d{4})\\s*\\$${money}\\s*Reference No:`, "gi"))];
    if (!feeLines.length || payments.length !== 1 || feeTotal == null
      || !near(feeLines.reduce((s, m) => s + (dollars(m[1]) ?? NaN), 0), feeTotal)) return null;
    const paidNow = dollars(payments[0][2]);
    if (!near(paidNow, feeTotal)) return null;
    jurisdiction = "Clackamas County"; invoiceNumber = records[0];
    receiptNumber = wrappedId(pay, "Reference No:");
    paidAt = grab(t, "RECEIPT DATE:\\s*([0-9/]+)") || "";
    amount = total = paidNow;
    const type = grab(t, "RECORD NAME:.*?\\bTYPE:\\s*([A-Za-z]+)") || "";
    recordDiscipline = /^Electrical$/i.test(type) ? "electrical" : /^Building$/i.test(type) ? "building" : "unknown";
    unmatchedPermit = true;
  } else if (/City of Bend Permit Center/i.test(t) && /invoicecloud\.com/i.test(t) && /\bApproved \d+\b/.test(t)
    && /SERVICE FEE/.test(t) && /GRAND TOTAL/.test(t)) {
    // InvoiceCloud's confirmation for the city's permit center. The extractor reads its
    // figures positionally ("SUBTOTAL $a $b $c" = subtotal, service fee, grand total), so the
    // reading is held to arithmetic: one invoice line equal to the subtotal, and a + b = c.
    const lines = [...t.matchAll(new RegExp(`Online Permit Center Web Payment\\s*(\\d+)\\s*\\$${money}`, "gi"))];
    const m = new RegExp(`SUBTOTAL\\s*\\$${money}\\s*\\$${money}\\s*\\$${money}`, "i").exec(t);
    if (lines.length !== 1 || !m || !near(dollars(lines[0][2]), dollars(m[1]))) return null;
    jurisdiction = "City of Bend"; receiptNumber = lines[0][1];
    paidAt = grab(t, "(\\d{1,2}/\\d{1,2}/\\d{4}) \\d{1,2}:\\d{2}:\\d{2} [AP]M\\s*Approved") || "";
    amount = dollars(m[1]); processing = dollars(m[2]) ?? 0; total = dollars(m[3]);
    unmatchedPermit = true;
  } else if (elavon) {
    // Some exports bundle a processor-only email before the actual payment.
    // Read the authority transaction, never the first dollar amount in the PDF.
    const main = t.slice(t.search(new RegExp(`Profile Name ${elavon.profile} Transaction Type`, "i")));
    jurisdiction = elavon.jurisdiction;
    receiptNumber = wrappedId(main, "(?<!Fee )Transaction ID");
    paidAt = grab(main, "(?<!Fee )Transaction Date/Time\\s*([0-9/]+)") || "";
    amount = dollars(grab(main, `(?<![a-z])Amount\\s*\\$${money}`));
    processing = dollars(grab(main, `Service Fee\\s*\\$${money}`)) ?? 0;
    total = dollars(grab(main, `Total of all charges and fees\\s*\\$${money}`));
    if (elavon.invoice) {
      invoiceNumber = grab(main, "Invoice Number\\s*([A-Z]{1,3}\\d{5,})\\b") || "";
      if (!invoiceNumber) return null;
    }
    // Printed Application ID values such as "1"/"1234" are not a permit
    // identity. Keep the payment unlinked until an operator reconciles it.
    unmatchedPermit = true;
  } else return null;
  if (!jurisdiction || (!permitNumber && !unmatchedPermit) || !receiptNumber || !paidAt || amount == null || total == null
    || Math.abs(amount + processing - total) > 0.015) return null;
  const discipline = recordDiscipline || (/(?:-ELEC|-E)$|^REP|^ELE/i.test(permitNumber) ? "electrical"
    : /(?:-STR|-DW)$|^BLD/i.test(permitNumber) ? "building" : "unknown");
  // Key order is part of the stored source string, which is how a re-read is told apart from a
  // conflict: invoiceNumber sits after permitNumber, as in the receipts already on file.
  return { jurisdiction, permitNumber, ...(invoiceNumber ? { invoiceNumber } : {}), receiptNumber, discipline,
    authorityAmountUsd: amount, processingFeeUsd: processing, totalPaidUsd: total, paidAt };
}

/** Store components under a source namespace excluded from whole-filing quotes.
 * Stable jurisdiction/receipt/permit identity deduplicates differently named PDFs.
 * No customer name, address, payment instrument or raw receipt text is shared. */
export function recordPaidFeeReceipt(db: AppDb, receipt: PaidFeeReceipt, projectId: string | null = null) {
  const key = createHash("sha256").update(`${receipt.jurisdiction.toLowerCase()}|${receipt.receiptNumber}|${receipt.permitNumber}`).digest("hex");
  const id = `receipt-${key}`;
  const source = `receipt_component:${JSON.stringify(receipt)}`;
  const prior = db.get<{ source: string }>("SELECT source FROM permit_fee_history WHERE id = ?", [id]);
  if (prior) {
    if (prior.source === source) return { recorded: false, reason: "duplicate receipt" };
    // One payment, two documents: Clackamas County's own receipt and the Elavon email for the
    // same card payment share its transaction id, and both print the authority's amount — only
    // the processor's fee is missing from the county's copy. Same identity and same authority
    // amount is the same payment; a different authority amount is a real conflict.
    let priorAmount = NaN;
    try { priorAmount = Number((JSON.parse(prior.source.slice("receipt_component:".length)) as PaidFeeReceipt).authorityAmountUsd); } catch { /* conflict */ }
    return { recorded: false, reason: near(priorAmount, receipt.authorityAmountUsd)
      ? "duplicate receipt (the same payment, read from another document)" : "conflicting receipt; review required" };
  }
  const amounts = [receipt.authorityAmountUsd, receipt.processingFeeUsd, receipt.otherFeeUsd ?? 0, receipt.totalPaidUsd];
  if (!receipt.jurisdiction || !receipt.receiptNumber || !receipt.paidAt || amounts.some(n => !Number.isFinite(n) || n < 0)
    || Math.abs(amounts[0] + amounts[1] + amounts[2] - amounts[3]) > 0.015) throw new Error("Receipt amounts or identity are inconsistent.");
  db.run("INSERT INTO permit_fee_history(id,state,ahj,utility,track,fee_usd,source,project_id,recorded_at) VALUES(?, 'OR', ?, '', 'permit', ?, ?, ?, ?)",
    [id, receipt.jurisdiction, receipt.authorityAmountUsd, source, projectId, nowIso()]);
  // L5: a paid receipt is evidence about the seeded schedule for its jurisdiction. Hold it up
  // against that schedule and, where they disagree, raise ONE deduped operator review item —
  // never a schedule change (rule 3). Lazy import (feeSchedules is heavy and sits in a cycle-
  // prone neighbourhood); best-effort, a receipt is recorded whatever the comparison says.
  void import("./feeSchedules").then((fees) => {
    const report = fees.reconcileReceiptsWithSchedules(db);
    const touched = report.results.filter((r) => r.receipts.some((x) => x.jurisdiction === receipt.jurisdiction.replace(/\s+/g, " ").trim()));
    fees.raiseReceiptContradictionReviews(db, { ...report, results: touched });
  }).catch(() => null);
  return { recorded: true, reason: "Paid component recorded; excluded from whole-filing estimates." };
}

export function paidFeeReceiptsForProject(db: AppDb, projectId: string): PaidFeeReceipt[] {
  return db.query<{ source: string }>("SELECT source FROM permit_fee_history WHERE project_id = ? AND source LIKE 'receipt_component:%' ORDER BY recorded_at", [projectId])
    .flatMap(row => { try { return [JSON.parse(row.source.slice(18)) as PaidFeeReceipt]; } catch { return []; } });
}
