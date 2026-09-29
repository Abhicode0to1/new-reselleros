/**
 * Is this quote PDF still an offer, or a receipt for money already taken?
 *
 * R-034 (Pawan, 29 Sep 2026). A customer who pays from the DMS panel gets the
 * quote PDF back as their bill, and it still read "QUOTATION", "Valid until
 * <date>" and "Payment terms: Net 7 days from acceptance" — on an order that was
 * paid minutes earlier (seen on Q-2222-2026-27-0020, ₹708 paid). Three separate
 * sentences all telling a paying customer they still owe the money.
 *
 * The decision lives here rather than inside QuotePDF for the reason the PDF's own
 * `upiQrDataUrl` comment gives: the renderer cannot see payment state, and two
 * copies of "is it paid" is how the header and the footer end up disagreeing.
 * One function, one answer, asserted by a test.
 */
import type { Quote } from "@/lib/supabase/database.types";

/**
 * Payment states where the money is IN and nothing is owed on this document.
 *
 * `partial` is deliberately absent: part of the balance is genuinely still due,
 * so the validity window and the payment terms are still the truth for it.
 *
 * `invoiced` is present because a tax invoice was raised against money that
 * arrived — "Net 7 days from acceptance" is exactly as wrong there as it is on a
 * `received` quote, even though the customer's statutory document is the invoice.
 */
const SETTLED: ReadonlySet<string> = new Set(["received", "invoiced"]);

export function quoteIsPaid(q: Pick<Quote, "payment_status">): boolean {
  return Boolean(q.payment_status && SETTLED.has(q.payment_status));
}

/**
 * The word at the top of the document, and in its PDF metadata.
 *
 * "Paid order" and not "Invoice": this is not a GST tax invoice and must never be
 * mistaken for one — that document comes from `generate_invoice` with its own
 * gapless number (§17a). Naming it "Invoice" here would put a second, unnumbered
 * invoice-shaped paper in the customer's hands.
 */
export function quoteDocumentLabel(args: { paid: boolean; isRenewal?: boolean }): string {
  if (args.paid) return args.isRenewal ? "Renewal order · Paid" : "Paid order";
  return args.isRenewal ? "Renewal Quotation" : "Quotation";
}
