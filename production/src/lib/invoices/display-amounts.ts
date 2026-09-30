/**
 * R-066 — the money breakdown the invoice DETAIL screen shows, and hands to the tax
 * invoice dialog and both PDF buttons.
 *
 * ─── THE BUG ────────────────────────────────────────────────────────────────
 * The invoice preview derived everything from the parent quote:
 *
 *     const subtotal = quote?.subtotal ?? invoice.amount;    // ← here
 *     const taxable  = subtotal - discount;
 *     const tax      = Math.round(taxable * (taxRate / 100));
 *
 * `invoice.amount` is the GST-INCLUSIVE gross. So with no quote the gross was treated
 * as the taxable base and 18% was charged on top of tax that was already in it:
 * INV-FBB9-2026-27-0003 showed "Tax Total ₹1,06,200 (18%)" on a ₹5,90,000 invoice whose
 * real GST is ₹90,000. Not a rounding drift — 18% of the wrong number, ₹16,200 out on
 * one invoice, and the GST report beside it said ₹90,000 the whole time.
 *
 * `quote` is null for project-milestone and subscription-instalment invoices, which
 * carry their own lines and never link a quote. It is ALSO undefined for the first
 * render of every invoice, because useQuoteByInvoiceId is an async query — so the wrong
 * figure flashed on screen for quote-backed invoices too, and settled before anyone
 * could point at it.
 *
 * ─── THE FIX IS NOT NEW ARITHMETIC ──────────────────────────────────────────
 * The right answer was already written twice and this screen used neither:
 *
 *   lib/pdf/build-props.ts    invoiceAmounts() — frozen columns, else back out
 *   generate_invoice (SQL)    round(gross * 100.0 / (100 + rate)), tax = gross − taxable
 *
 * and the invoice row has carried `taxable_value`, `tax_amount`, `tax_rate` and
 * `inter_state` since migration 0116 — written on every issue, frozen afterwards. So
 * this file adds no formula. It picks the source, and it picks the SAME source the
 * server-side PDF builder picks, which is what build-props' own header already promises
 * ("the amount math mirrors the invoice detail page EXACTLY — don't diverge"). That
 * promise was false; this is what makes it true.
 *
 * ─── WHAT IS DELIBERATELY NOT DECIDED HERE ──────────────────────────────────
 * When a quote IS present, this prefers the quote — exactly as buildInvoicePdfProps
 * does — even though the invoice's own frozen split is the legal document. Those agree
 * today, because generate_invoice computes the frozen values from that same quote. They
 * could diverge only if a quote were edited after its invoice was issued, and which one
 * should then win is a question for the owner, not a thing to settle inside a bug fix.
 * The tax invoice dialog already resolves it the other way (`invoice.taxable_value ??`),
 * so the inconsistency is real and is on the board rather than quietly picked here.
 */
import { quoteAmounts, invoiceAmounts } from "@/lib/pdf/build-props";
import type { Invoice, Quote } from "@/lib/supabase/database.types";

/** subtotal / discount / taxable / tax / total, as the detail screen displays them. */
export type DisplayAmounts = ReturnType<typeof invoiceAmounts>;

/** What the invoice detail screen should show for this invoice. */
export function invoiceDisplayAmounts(
  invoice: Pick<Invoice, "amount" | "taxable_value" | "tax_amount" | "tax_rate">,
  quote?: Pick<Quote, "subtotal" | "discount_pct" | "tax_rate" | "amount"> | null,
): DisplayAmounts {
  /* No quote — and that is the ordinary case for a project-milestone or subscription
     instalment invoice, not an error state. The invoice's own frozen split answers it;
     only an invoice issued before 0116 falls through to backing the tax out of the
     gross, which is what the database itself does in the same situation. */
  return quote ? quoteAmounts(quote) : invoiceAmounts(invoice);
}
