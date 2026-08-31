/**
 * Is a stored quote figure a YEAR or one INVOICE? The two look identical and are not.
 *
 * ─── THE DOCUMENT THAT MADE THIS A FILE ─────────────────────────────────────
 * Q-ADPL-2026-27-0053, sent 31 Aug 2026. The row was right in every column:
 *
 *   36 seats · line rate Rs 325/seat/MONTH · commitment "monthly"
 *   billing_cycle "monthly" · subtotal Rs 11,700  (one month)
 *
 * The PDF printed "Rs 27/mo · Rs 975/mo · Annual contract value Rs 13,392". A twelfth of
 * the real price, on a GST document, because the renderer divided every figure by
 * invoices-per-year on the assumption that a stored figure is always an ANNUAL contract
 * value.
 *
 * That assumption is right for the common case and wrong for the other one:
 *
 *   annual_yearly + billed monthly   subtotal is a YEAR    -> divide by 12
 *   monthly (flex) + billed monthly  subtotal is a MONTH   -> divide by nothing
 *
 * `billing_cycle` cannot tell them apart — both say "monthly". The LINE's commitment can,
 * and `lib/quotes/commitment-rate.ts` already documents that boundary with three SQL
 * regression tests behind it: a monthly line's rate is per seat per MONTH, and
 * `record_payment` divides such a line by 1.0 rather than 12.0 for exactly this reason.
 * The renderer was the one place that had never been told.
 *
 * Pure and separate from the component so the arithmetic can be tested without rendering a
 * PDF — nothing in src/lib/pdf renders one in a test today, and a money rule that can only
 * be checked by opening a document is a money rule nobody checks.
 */

/** A line's commitment, as stored on `quotes.line_items[].commitment`. */
export type LineCommitmentLike = string | null | undefined;

/**
 * Does this line's rate ALREADY measure one invoice period?
 *
 * Only the flex tier does. Every `annual_*` commitment carries a per-YEAR rate.
 */
export function lineIsPerInvoice(commitment: LineCommitmentLike): boolean {
  return commitment === "monthly";
}

/**
 * What to divide a stored figure by to get the per-invoice figure.
 *
 * `invoicesPerYear` comes from the billing cycle (yearly 1 … monthly 12).
 */
export function perInvoiceDivisor(
  invoicesPerYear: number,
  commitment: LineCommitmentLike,
): number {
  return lineIsPerInvoice(commitment) ? 1 : invoicesPerYear;
}

/**
 * The year's value, whichever way the figure was stored.
 *
 * The mirror of the divisor: on an annual commitment the stored total IS the year; on a
 * monthly-flex line it is one month, so the year is twelve of them. Printing the stored
 * total under "Annual contract value" published a figure a twelfth of the truth — beside a
 * per-month figure that was correct, which is what made it hard to see.
 */
export function annualContractValue(
  storedTotal: number,
  invoicesPerYear: number,
  commitment: LineCommitmentLike,
): number {
  return lineIsPerInvoice(commitment)
    ? Math.round(storedTotal * invoicesPerYear)
    : storedTotal;
}
