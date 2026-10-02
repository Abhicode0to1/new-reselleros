/**
 * /quotes ?focus= — the exact set behind each money tile (R-118, 2 Oct 2026).
 *
 * The tiles are summed WITH these predicates and the list filters by them, so the number on
 * a tile and the rows it opens cannot disagree. Before this, "Out for review" (sent + viewed)
 * opened the Sent tab only, and "Accepted" (every accepted quote) opened a tab that leaves
 * out the ones already invoiced.
 */
export const QUOTE_FOCI = ["", "review", "accepted", "partial", "to-invoice"] as const;
export type QuoteFocus = (typeof QUOTE_FOCI)[number];

export const QUOTE_FOCUS_LABEL: Record<Exclude<QuoteFocus, "">, string> = {
  review: "Out for review — sent or viewed, waiting on the customer",
  accepted: "Accepted — including ones already invoiced",
  partial: "Part-paid — some money in, balance still due",
  "to-invoice": "Paid, GST invoice not raised yet",
};

/* partial / to-invoice are the /payments tiles "Partial Quotes" and "Awaiting GST Invoice":
   quotes by payment_status, which no quotes tab isolates (Awaiting payment is wider). */
export function quoteInFocus(q: { status: string; payment_status?: string | null }, focus: QuoteFocus): boolean {
  if (focus === "") return true;
  if (focus === "review") return q.status === "sent" || q.status === "viewed";
  if (focus === "partial") return q.payment_status === "partial";
  if (focus === "to-invoice") return q.payment_status === "received";
  return q.status === "accepted";
}

/** Sum of amount over the quotes in a focus — what the tile shows. */
export function focusValue(quotes: readonly { status: string; amount?: number | null }[], focus: QuoteFocus): number {
  return quotes.filter((q) => quoteInFocus(q, focus)).reduce((s, q) => s + (q.amount ?? 0), 0);
}
