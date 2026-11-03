// ---------------------------------------------------------------------------
// THE OWNER'S PAID RECEIPTS, READ AS PAID (#421).
//
// Portland quotes read low, and the owner's own receipts are the truth to hold a quote against.
// The receipt reader knew six narrow formats and read 41 of 86 receipt-like PDFs on the owner's
// machine. These are the families it could not read, each mirrored from a real document's
// STRUCTURE (labels, layout, line order, as the production text extractor yields it) with
// invented identifiers, names and addresses. Amounts are real ones.
//
//   MUST READ    — City of Portland's online payment receipt; Washington County's processor
//                  confirmation; Newberg's emailed "Payment Received"; Clackamas County's Elavon
//                  email and its own Accela receipt; City of Bend's InvoiceCloud confirmation.
//   MUST DEDUPE  — Clackamas County's receipt and the Elavon email are ONE payment: same
//                  identity, same authority amount, only the processor's fee differs. Reading
//                  both must leave one row, reported as a duplicate, never a "conflict".
//   MUST REFUSE  — a running total (permit card, permit printout), an assessment (a billing
//                  summary with $0.00 paid to date), a confirmation with no id that could dedupe
//                  against the authority's receipt, planning-only payments, multi-permit payments,
//                  and documents that are not permit fees at all.
//
//   npx tsx backend/test/feeReceiptFormats.test.ts
// ---------------------------------------------------------------------------
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fee-receipt-formats-"));
process.env.AUTOPILOT_DB_PATH = path.join(temp, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.ANTHROPIC_API_KEY = "";
process.env.FEE_RESEARCH = "off";

const { openDatabase } = await import("../src/db");
const { parsePaidFeeReceipt, recordPaidFeeReceipt } = await import("../src/feeReceipts");
const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// City of Portland's online payment receipt, printed from the mail client. Five bills on one
// payment; the Order ID is the payment's identity. No permit number is printed.
const PORTLAND_RECEIPT = `Example User <user@example.com>  Online Payment Receipt  1 message  Portland.Receipts@portlandoregon.gov  <Portland.Receipts@portlandoregon.gov>  Wed, Jun 17, 2026 at 2:33 PM  Payment Receipt Confirmation  Your payment was successfully processed. You may print this receipt page for your records by selecting Print.  Transaction Summary  Description  Amount  City of Portland Online Payments  $1,225.83  Total Amount Paid  $1,225.83  Transaction Detail  The following amounts will be remitted back to the City of Portland.  SKU  Description  Unit Price  Quantity  Amount  9000001  Bill Number 9100001  $390.00  1  $390.00  9000001  Bill Number 9100002  $170.78  1  $170.78  9000001  Bill Number 9100003  $298.09  1  $298.09  9000001  Bill Number 9100004  $316.96  1  $316.96  9000001  Bill Number 9100005  $50.00  1  $50.00  Total Amount Paid  $1,225.83  Customer Information  Customer Name  J DOE  Company Name  Example Solar LLC  Local Reference ID  1000000_2026-06- 17T13:31:47  Receipt Date  6/17/2026  Receipt Time  01:33:55 PM PDT  Payment Information  Payment Type  Credit Card  Credit Card Type  VISA  Credit Card Number  ******0000  6/17/26, 2:39 PM  Infinity Example Mail - Online Payment Receipt  https://mail.example.com/mail/u/1/?view=pt  1/2
Payment Receipt Confirmation  Your payment was successfully processed.  Payment Information  Order ID  900000001  Name on Credit Card  J Doe  Billing Information  Billing Address  1 Example Way  6/17/26, 2:39 PM  2/2`;

// Portland's Billing Summary as the production extractor flattens it: an ASSESSMENT. The TOTAL
// row prints Fee Amount, Paid To Date ($0.00) and Balance; nothing on it has been paid.
const PORTLAND_BILLING_SUMMARY = `Generated 07/31/2026 02:07 PM by EXAMPLE from DSPPROD  PORTLAND, OREGON  Today's Date:7/31/2026 IVR Number:  9999999  City of Portland, PP&D - Report Code: 1000002  Site Address:  1 EXAMPLE ST  EXAMPLE SOLAR  Permit Number: 26-999999-000-00-RS  Residential 1 & 2 Family Permit Portland, OR 97201  Billing Summary  Phone: 503-823-7300  APPLICANT  Phone:  1900 SW 4th Ave, Suite 5000 CITY OF  TOTAL  $1,175.83  $0.00  Fee Code  Fee Description  Fee Amount  Paid To Date  Balance  $31.94 Building Permit St. Sur. $266.15 Building Permit RS $298.09 Sub Total  $0.00  $298.09 $33.96 Electrical Permit St Sur $283.00 Electrical Permit RS $316.96 Sub Total  $0.00  $316.96 $119.00 Zoning Inspection Fee $51.78 Development Services Fee - RS $170.78 Sub Total  $0.00  $170.78 $217.00 Land Use Plan Review Res $173.00 Bldg Plan Rvw/Processing RS/MI/MP $390.00 Sub Total  $0.00  $390.00  141 171 Bill #9200001 144 173 Bill #9200002 120 2468 Bill #9200003 244 2485 Bill #9200004 $1,175.83 * *  * Fees marked with an asterisk are due at application.  Notice:  CITY CONTACT  This document is not a permit. This document may not represent all fees owing for this permit. All fees are subject to change based on new or corrected information.  PORTLAND PERMITTING & DEVELOPMENT`;

// Washington County's payment processor confirmation (fisgov), with the service fee split.
const WASHINGTON_COUNTY_CONFIRMATION = `Example User <user@example.com>  Washington County Online Application - Payment Confirmation  1 message  donotreply@fisgov.com  <donotreply@fisgov.com>  Thu, Jun 18, 2026 at 11:26 AM  To: user@example.com  This e-mail will serve as confirmation that your payment was received by Washington County Land Use and Transportation / Building Permits.  The transaction information is listed below:  Confirmation/Transaction Number:  3900000001  OAS Request Number :  ELEC-SSA-99999  Date and Time:  6/18/2026 10:25:59 AM  Payment Method:  VI  | 0000  Payment Amount:  $384.16  Service Fee:  $9.41  Total Payment Amount:  $393.57  Billing Details  Name:  J DOE  Address:  1 Example Way  Payment Details  Subtotal:  $384.16  Service Fee:  $9.41  Total Amount:  $393.57  Thank you for your payment.`;

// Newberg's OpenGov receipt as EMAILED ("Payment Received"): the mail client's own abbreviated
// header date comes first, and the receipt id is printed "Receipt #NNNN" on the second page.
const NEWBERG_EMAILED = `$96.59  Permit Email <permit@example.com>  Payment Received  1 message  noreply@opengov.com  <noreply@opengov.com>  Fri, Jun 5, 2026 at 1:26 PM  Reply-To: noreply@opengov.com  City of Newberg, OR  $96.59 Paid  via Credit Card  Thanks for using the Online Service Center  J Doe  June 5, 2026  Plan Review Fees  BLD-26-999 - *Building Permit  BLDG- Technology Fee  $4.60  BLD-Solar Plan Review Fee  $91.99  No processing fees  Total Paid  $96.59  6/5/26, 1:31 PM  1/2
Powered by  Receipt #9876  6/5/26, 1:31 PM  2/2`;

// Clackamas County's card payment through Elavon (profile "DTD BUILDING CODES"). The record it
// paid is printed as the Invoice Number; the transaction id wraps across two lines.
const CLACKAMAS_ELAVON = `Example User <user@example.com>  Order Confirmation  1 message  DTD BUILDING CODES  <noreply@elavon.com>  Mon, Jun 8, 2026 at 10:39 AM  Reply-To: DTDFinancial@clackamas.us  To: user@example.com  $281.33 USD  Your payment has been approved  Profile Name  DTD BUILDING CODES  Transaction Type  SALE  Payment  VISA  00**********0000  Transaction ID  010126X1A-AAAA1111-BB22-CC33- DD44- EEEE5555FFFF  Approval Code  111111  Approval Message  APPROVAL  Transaction Date/Time  06/08/2026 09:39:54 AM  Amount  $273.80 USD  Service Fee Profile Name  DTD BUILDING CODES FEE  Service Fee Transaction ID  010126X1A-99998888-7777-6666- 5555-444433332222  Service Fee Approval Code  222222  Service Fee Transaction Date/Time  06/08/2026 12:39:55 PM  Invoice Number  RE009901  Service Fee  $7.53 USD  Total of all charges and fees  $281.33 USD  Your account payment is being made to: DTD BUILDING CODES,  150 BEAVERCREEK RD OREGON CITY , OR, 97045, US, 503-742-4400,  DTDFinancial@clackamas.us  Total  $281.33 USD  Bill To  J DOE  Please remember that this transaction includes a non-refundable Service Fee collected by Elavon that will appear on your credit or debit card statement as "Elavon-Service Fee".`;

// Clackamas County's own Accela receipt for the SAME payment: its Reference No is the Elavon
// transaction id (wrapped at a different point), and it prints no processor fee.
const CLACKAMAS_ACCELA = `Example User <user@example.com>  Receipt for RE009901  1 message  donotreply-clackamas@accela.com  <donotreply-clackamas@accela.com>  Mon, Jun 8, 2026 at 10:40 AM  To: user@example.com  RECEIPT NUMBER:  9990001  RECEIPT DATE:  6/8/2026  PROCESSED BY:  ADMIN  RECEIPT  RECORD:  RE009901  STATUS:  Pending  RECORD NAME:  PRESCRIPTIVE SOLAR - ROOF MOUNT 9.2 kW  TYPE:  Building - Solar  DESCRIPTION:  PRESCRIPTIVE SOLAR - ROOF MOUNT 9.2 kW - Install roof-mounted photovoltaic system.  VALUATION:  18000  ADDRESS:  1 EXAMPLE LN EXAMPLE OR 97000  APPLICANT:  J DOE  PROFESSIONAL:  EXAMPLE SOLAR LLC  TYPE:  Contractor  FEES  Code  Description  Notes  Quantity  Amount  1109BSI  Prescriptive Flat Fee Solar Installation  1.00  $240.00  DSS01  Technology Fee (3% of total permit fee; not to exceed $5.)  5.00  $5.00  1528  State Surcharge  1.00  $28.80  TOTAL  $273.80  PAYMENT  Method  Paid By  Comments  Date  Amount  Credit Card  J DOE  6/8/2026  $273.80  Reference No:  010126X1A-AAAA1111-BB22-CC33- DD44-EEEE5555FFFF  Protect Your Information  Scammers impersonating county staff are on the rise.  Building Codes Division | Development Services Building |  150 Beavercreek Road I Oregon City, OR 97045  WWW.CLACKAMAS.US`;

// City of Bend's permit-center payment through InvoiceCloud. The extractor reads the figures
// positionally: the labels arrive at the top, the three amounts after SUBTOTAL.
const BEND_INVOICECLOUD = `(541) 388-5580  Transaction Detail  SERVICE FEE  GRAND TOTAL  City of Bend Permit Center  Billing Information  J Doe  1 Example Way  user@example.com  XXXXXXXXXXXX0000  10/21/2026 1:28:02 PM  Approved 333333  Invoices  Type  Account #  Invoice #  Amount  Online Permit Center Web Payment  999001  $337.84  SUBTOTAL  $337.84  $11.32  $349.16  10/21/26, 2:28 PM  Payment Confirmation | City of Bend Permit Center  https://www.invoicecloud.com/portal/2/CloudPaymentConfirmation.aspx?pg=00000000-0000-0000-0000-000000000000  1/1`;

check("Portland's online payment receipt reads as a paid, unlinked City of Portland payment", () => {
  const r = parsePaidFeeReceipt(PORTLAND_RECEIPT);
  assert.ok(r, "the receipt was not read");
  assert.equal(r.jurisdiction, "City of Portland");
  assert.equal(r.receiptNumber, "900000001", "the Order ID (printed on the second page) is the identity");
  assert.equal(r.permitNumber, "", "no permit number is printed, so none is invented");
  assert.equal(r.authorityAmountUsd, 1225.83);
  assert.equal(r.processingFeeUsd, 0);
  assert.equal(r.totalPaidUsd, 1225.83);
  assert.equal(r.paidAt, "6/17/2026");
});

check("Portland: a bill line that does not add up refuses the whole receipt", () => {
  assert.equal(parsePaidFeeReceipt(PORTLAND_RECEIPT.replace("$170.78  1  $170.78", "$170.78  1  $180.78")), null);
  assert.equal(parsePaidFeeReceipt(PORTLAND_RECEIPT.replace("Order ID  900000001", "Order ID  900000001 Order ID 900000002")), null,
    "two order ids are two payments, not one");
});

check("Portland's billing summary is an assessment ($0.00 paid to date), never a paid receipt", () => {
  assert.equal(parsePaidFeeReceipt(PORTLAND_BILLING_SUMMARY), null);
});

check("Washington County's processor confirmation splits the county's amount from the service fee", () => {
  const r = parsePaidFeeReceipt(WASHINGTON_COUNTY_CONFIRMATION);
  assert.ok(r, "the confirmation was not read");
  assert.equal(r.jurisdiction, "Washington County");
  assert.equal(r.permitNumber, "ELEC-SSA-99999");
  assert.equal(r.receiptNumber, "3900000001");
  assert.equal(r.authorityAmountUsd, 384.16);
  assert.equal(r.processingFeeUsd, 9.41);
  assert.equal(r.totalPaidUsd, 393.57);
  assert.equal(r.paidAt, "6/18/2026");
  assert.equal(parsePaidFeeReceipt(WASHINGTON_COUNTY_CONFIRMATION.replace("Total Amount:  $393.57", "Total Amount:  $394.57")), null,
    "a repeated split that disagrees refuses");
});

check("an ELE-prefixed record (ELEC-SSA, ELE26) is an electrical permit", () => {
  assert.equal(parsePaidFeeReceipt(WASHINGTON_COUNTY_CONFIRMATION)?.discipline, "electrical");
});

check("Newberg's emailed receipt reads its \"Receipt #NNNN\" id", () => {
  const r = parsePaidFeeReceipt(NEWBERG_EMAILED);
  assert.ok(r, "the emailed receipt was not read");
  assert.equal(r.receiptNumber, "9876");
  assert.equal(r.permitNumber, "BLD-26-999");
  assert.equal(r.authorityAmountUsd, 96.59);
});

check("Newberg's emailed receipt is dated by the authority's printed date, not the mail header's", () => {
  assert.equal(parsePaidFeeReceipt(NEWBERG_EMAILED)?.paidAt, "June 5, 2026");
});

check("Clackamas County's Elavon email reads the county's amount, the service fee and the record as invoice", () => {
  const r = parsePaidFeeReceipt(CLACKAMAS_ELAVON);
  assert.ok(r, "the Elavon email was not read");
  assert.equal(r.jurisdiction, "Clackamas County");
  assert.equal(r.permitNumber, "");
  assert.equal(r.invoiceNumber, "RE009901");
  assert.equal(r.receiptNumber, "010126X1A-AAAA1111-BB22-CC33-DD44-EEEE5555FFFF", "the wrapped transaction id heals");
  assert.equal(r.authorityAmountUsd, 273.8);
  assert.equal(r.processingFeeUsd, 7.53);
  assert.equal(r.totalPaidUsd, 281.33);
  assert.equal(r.paidAt, "06/08/2026");
});

check("the stored shape keeps invoiceNumber after permitNumber (a re-read must match the row already on file)", () => {
  const r = parsePaidFeeReceipt(CLACKAMAS_ELAVON);
  assert.deepEqual(Object.keys(r ?? {}), ["jurisdiction", "permitNumber", "invoiceNumber", "receiptNumber", "discipline",
    "authorityAmountUsd", "processingFeeUsd", "totalPaidUsd", "paidAt"]);
});

check("the DTD BUILDING CODES profile without Clackamas County's own wording is not Clackamas County", () => {
  assert.equal(parsePaidFeeReceipt(CLACKAMAS_ELAVON.replace(/DTDFinancial@clackamas\.us/g, "billing@example.gov")), null);
});

check("Clackamas County's own receipt reads the same payment under the Elavon transaction id", () => {
  const r = parsePaidFeeReceipt(CLACKAMAS_ACCELA);
  assert.ok(r, "the county receipt was not read");
  assert.equal(r.jurisdiction, "Clackamas County");
  assert.equal(r.receiptNumber, parsePaidFeeReceipt(CLACKAMAS_ELAVON)?.receiptNumber, "same identity as the Elavon email");
  assert.equal(r.invoiceNumber, "RE009901");
  assert.equal(r.permitNumber, "");
  assert.equal(r.discipline, "building", "the record type (Building - Solar) names the discipline");
  assert.equal(r.authorityAmountUsd, 273.8);
  assert.equal(r.processingFeeUsd, 0);
  assert.equal(r.paidAt, "6/8/2026");
});

check("Clackamas County's receipt refuses a fee table that does not add up or a payment that is not the total", () => {
  assert.equal(parsePaidFeeReceipt(CLACKAMAS_ACCELA.replace("1.00  $28.80", "1.00  $29.80")), null);
  assert.equal(parsePaidFeeReceipt(CLACKAMAS_ACCELA.replace("6/8/2026  $273.80  Reference", "6/8/2026  $200.00  Reference")), null);
});

check("City of Bend's InvoiceCloud confirmation splits the permit payment from the service fee", () => {
  const r = parsePaidFeeReceipt(BEND_INVOICECLOUD);
  assert.ok(r, "the confirmation was not read");
  assert.equal(r.jurisdiction, "City of Bend");
  assert.equal(r.receiptNumber, "999001", "the invoice number, not the card approval code");
  assert.equal(r.permitNumber, "");
  assert.equal(r.authorityAmountUsd, 337.84);
  assert.equal(r.processingFeeUsd, 11.32);
  assert.equal(r.totalPaidUsd, 349.16);
  assert.equal(r.paidAt, "10/21/2026");
  assert.equal(parsePaidFeeReceipt(BEND_INVOICECLOUD.replace("$11.32  $349.16", "$11.32  $359.16")), null, "a+b must equal c");
});

check("one Clackamas payment read from both documents is one row, reported as a duplicate", () => {
  const elavon = parsePaidFeeReceipt(CLACKAMAS_ELAVON)!, county = parsePaidFeeReceipt(CLACKAMAS_ACCELA)!;
  const before = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM permit_fee_history")!.n;
  assert.equal(recordPaidFeeReceipt(db, elavon).recorded, true);
  const again = recordPaidFeeReceipt(db, county);
  assert.equal(again.recorded, false);
  assert.match(again.reason, /^duplicate receipt/, `reason was: ${again.reason}`);
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM permit_fee_history")!.n, before + 1);
  assert.match(recordPaidFeeReceipt(db, { ...county, authorityAmountUsd: 200, totalPaidUsd: 200 }).reason, /conflicting/,
    "a different authority amount under the same identity is still a conflict");
});

// ---- Documents that must stay unread --------------------------------------------------------

check("a Clackamas County permit printout (Total Fees / Total Payments / Balance Due) is a running total, not a payment", () => {
  assert.equal(parsePaidFeeReceipt(`B UILDING  C ODES  D IVISION  D EVELOPMENT  S ERVICES  B UILDING  150  B EAVERCREEK  R OAD |  O REGON  C ITY,  OR  97045  Technology Fee (3% of total permit fee; not to exceed $5.)  5  $5.00  Prescriptive Flat Fee Solar Installation  1  $240.00  State Surcharge  1  $28.80  Total Fees:  $273.80  Total Payments:  $273.80  Balance Due:  $0.00  Conditions:  Permit #:  Type:  Status:  RE009901  NA / Solar  Issued  1 EXAMPLE LN EXAMPLE, OR 97000  $18,000.00  05/26/2026  06/12/2026  P. 503.742.4240  WWW.CLACKAMAS.US`), null);
});

check("Newberg's issued permit card (TOTAL PERMIT FEE'S PAID) is a running total, not a payment", () => {
  assert.equal(parsePaidFeeReceipt(`PERMIT #:  BLD-26-999  ISSUE DATE:  June 8, 2026  General Questions:  503. 537.1240  Email Address: building@newbergoregon.gov  BUILDING PERMIT  BUILDING DEPARTMENT  SITE ADDRESS:  1 EXAMPLE ST Newberg, OR 97132,  TOTAL PERMIT FEE'S PAID:  $223.21  APPLICANT:  J DOE  NEWBERG CITY HALL  414 E FIRST ST  Web address: newbergoregon.gov`), null);
});

check("a portal payment confirmation with no transaction or receipt id (Avolve) is not recorded beside the county's receipt", () => {
  assert.equal(parsePaidFeeReceipt(`Example User <user@example.com>  Portal Payment Receipt - #RE009901  1 message  DoNotReplyCLOR@avolvesoftware.com  COMPLETED PAYMENT RECEIPT  This is an Online Submission receipt of payment for order #:  RE009901 , on date:  5/11/2026 6:31:22 PM .  Applicant:  J DOE  Signature Date:  5/11/2026 6:31:22 PM  Request name:  RE009901  Amount paid:  $273.80  Approval #:  999999`), null);
});

check("planning-only payments with no record or fee description stay unread", () => {
  assert.equal(parsePaidFeeReceipt(`5/1/2026 12:33 PM  J Doe  Confirmation Number: 999999999  Your Xpress Bill Pay payment confirmation  noreply@xpressbillpay.com  Success  Item  Amount  City of Molalla  Planning Fees: J Doe  $115.00  Transaction Number: 999999998  Total  $115.00  Pay Method: Visa****0000`), null);
  assert.equal(parsePaidFeeReceipt(`Order Confirmation  LINCOLN COUNTY PLANNING  <noreply@elavon.com>  Order Results  Profile Name:  LINCOLN COUNTY  Transaction ID:  010526X18-AAAA0000-1111-2222- 3333-444455556666  Date/Time:  05/01/2026 02:14:45 PM  Transaction Type:  SALE  Approval Message:  APPROVAL  Approval Code:  999999  Order Section  Card Number :  ************0000  Amount :  $396.44 USD`), null);
});

check("one payment across two permits is not split by guesswork", () => {
  assert.equal(parsePaidFeeReceipt(`Thank you for your payment  City of Gresham OR  1333 NW Eastman Parkway, Gresham, OR 97030  Transaction details  Date: October 29, 2026 01:39 PM PDT  Permit: ELER-26-99999 | Invoice: INV-99999  $179.20  Permit: RENEW-26-99998 | Invoice: INV-99998  $476.60  Subtotal  $655.80  Processing fee  $24.59  Total  $680.39  Confirmation number: TYLX999999999  Transaction type: Purchase  https://cityofgreshamor.tylerportico.com/payments/checkout/receipt/0000`), null);
  assert.equal(parsePaidFeeReceipt(`Thank you for your payment!  Transaction #:  99999  Date:  05/07/2026 1:40 PM  Amount:  $593.06  Record:  J Doe  (Prescriptive Solar Permit)  Fees  SOL2026-99991  SOL2026-99992  Prescriptive solar permit fee  ID SOL2026-99991  Amount Due  $253.45  Prescriptive solar permit fee  ID SOL2026-99992  Amount Due  $253.45  Return - CIVICS  https://prod.buildinginbeaverton.org/return`), null);
});

check("documents that are not permit fees stay unread", () => {
  assert.equal(parsePaidFeeReceipt(`Receipt Summary  Total Transaction Fees:  $59.00  Total Payment Received:  $59.00  Receipt Details  Fees  Description / Transaction Type  Filing #  Work Order #  Filing Status  Filing Fees  Certificate of Organization  -  Example LLC  0000000000000A  W000000000000000  Approved  $59.00  Total  $59.00  Payment Information  Credit Card  0000000000  $59.00`), null);
  assert.equal(parsePaidFeeReceipt(`Fwd: Payment Reminder for your Sungage Financial Account  We are reaching out today with a friendly reminder about your upcoming payment in the amount of $306.44 that is due on 10/17/2026. If you've already made your payment, THANK YOU!`), null);
});

db.close();
fs.rmSync(temp, { recursive: true, force: true });
if (failures) {
  console.error(`feeReceiptFormats: ${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("feeReceiptFormats: Portland, Washington County, Newberg, Clackamas County and Bend receipts read; one payment from two documents is one row; running totals, assessments and planning-only payments stay unread");
}
