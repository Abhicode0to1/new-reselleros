/**
 * Quote in-place-edit guard — pure, unit-tested. Sibling of deletable.ts.
 *
 * ─── WHY ONLY A DRAFT MAY BE EDITED IN PLACE ────────────────────────────────
 * A draft has been shown to nobody. Changing it changes nothing anyone has seen, so
 * editing it in place is simply finishing the work.
 *
 * Every later state has left the building, and each one breaks differently if the same
 * row is quietly rewritten:
 *
 *   sent / viewed  — the customer is holding a PDF with the old figures. Editing the row
 *                    makes the copy they were sent unreproducible, and the next thing
 *                    anyone prints disagrees with the thing they were quoted.
 *   accepted       — they agreed to a number. Changing it afterwards is re-pricing a
 *                    closed negotiation without saying so.
 *   partial /
 *   received       — money has arrived against this total. Move the total and the
 *                    payment no longer reconciles against anything.
 *   invoiced       — a tax invoice exists. Under CGST §31 that document is the record;
 *                    its figures are not editable, and a correction is a credit or debit
 *                    note (§34). Editing the quote behind it produces a quote and an
 *                    invoice that disagree, with the invoice being the one that counts.
 *
 * In all of those the honest move is a NEW quote: duplicate, re-price, send. That leaves
 * both documents intact and the history readable, which is the whole point.
 *
 * `status` and `payment_status` are checked independently, on purpose. A quote can sit at
 * status `draft` while carrying a payment — the direct-invoice path and older imported
 * rows both produce that shape — and "draft" alone would wave it through.
 */
import type { Quote } from "@/lib/supabase/database.types";

/** Payment states that mean money has already moved against this quote. */
const MONEY_IN_FLIGHT: ReadonlySet<NonNullable<Quote["payment_status"]>> = new Set([
  "partial",
  "received",
  "invoiced",
]);

export interface QuoteEditBlock {
  /** What to show the operator. Says why, and what to do instead (§24). */
  reason: string;
  /** The next step that DOES work — duplicate into the builder, prefilled. */
  nextStep: string;
}

/**
 * Returns a block when this quote must not be edited in place, else null.
 *
 * Deliberately takes only the two fields it reads, so callers can pass a partial row and
 * so the test does not have to build a whole Quote.
 */
export function quoteEditBlockReason(
  q: Pick<Quote, "status" | "payment_status">,
): QuoteEditBlock | null {
  if (q.payment_status && MONEY_IN_FLIGHT.has(q.payment_status)) {
    const what =
      q.payment_status === "invoiced"
        ? "a tax invoice has been raised against it"
        : "a payment has been recorded against it";
    return {
      reason: `This quote cannot be edited — ${what}. Changing the total now would leave the money and the document disagreeing, and an invoice cannot be edited after it is issued (CGST §31; corrections are credit/debit notes).`,
      nextStep: "Duplicate it into a new quote and price that one instead.",
    };
  }

  if (q.status !== "draft") {
    return {
      reason: `This quote is ${q.status ?? "not a draft"} — the customer has already seen these figures. Editing it in place would make the copy they were sent unreproducible.`,
      nextStep: "Duplicate it into a new quote and price that one instead.",
    };
  }

  return null;
}

/** Convenience for hiding an Edit control. */
export function isQuoteEditableInPlace(q: Pick<Quote, "status" | "payment_status">): boolean {
  return quoteEditBlockReason(q) === null;
}
