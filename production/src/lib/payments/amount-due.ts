/**
 * What is actually still owed on an invoice.
 *
 * THIS IS A MONEY FUNCTION. Getting it wrong in one direction asks a customer
 * to pay again for something they have already paid — the single worst bug this
 * product can ship, because it costs the customer real money and costs the
 * reseller the relationship. Getting it wrong in the other direction asks for
 * too little, which is merely annoying and recoverable. So when a value is
 * missing or contradictory, this function biases toward asking for LESS.
 *
 * Two independent things reduce the balance, and they are stored separately:
 *
 *   1. `net_payable` = amount − adjusted advances (migration 0005). Advances are
 *      money taken BEFORE the invoice existed, folded in when it was raised.
 *   2. `paid_amount` = receipts against the invoice AFTER it was raised. Today
 *      only project-milestone receipts land here, via the trigger in migration
 *      0184, whose own column comment states the rule this file implements:
 *      "Outstanding = amount - paid_amount unless status=paid".
 *
 * Subtracting only one of the two — which is what every caller did before this
 * file existed — overstates the balance by the other. In production right now
 * that is INV-ET-2026-27-0013: ₹6,85,000 invoiced, ₹5,40,000 already received,
 * and `net_payable` still reading the full ₹6,85,000.
 *
 * The two are disjoint in practice (advances are consumed at invoice creation;
 * project receipts arrive later), so subtracting both is not double-counting.
 */

/** Only the fields that bear on the balance — any invoice-shaped row will do. */
export interface InvoiceBalanceFields {
  amount?: number | null;
  net_payable?: number | null;
  paid_amount?: number | null;
  status?: string | null;
}

/**
 * Rupees still owed. Never negative, never NaN. Returns 0 whenever the invoice
 * is settled or cancelled, or when the numbers are unusable — and 0 means
 * "don't ask for money", which is the safe direction.
 */
export function invoiceAmountDue(inv: InvoiceBalanceFields): number {
  // `paid` and `void` are terminal: no balance regardless of the arithmetic.
  // Checked first so a stale number can never resurrect a settled invoice —
  // INV-ET-2026-27-0001 is exactly that case (fully paid, `net_payable` still
  // showing the full ₹5,40,000).
  const status = (inv.status ?? "").toLowerCase();
  if (status === "paid" || status === "void") return 0;

  const gross = num(inv.net_payable) ?? num(inv.amount);
  if (gross === null) return 0;   // unknown total → ask for nothing

  return Math.max(0, gross - (num(inv.paid_amount) ?? 0));
}

function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
