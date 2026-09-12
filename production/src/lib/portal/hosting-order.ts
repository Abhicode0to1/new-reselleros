/**
 * What a portal hosting order is made of — the parts with no I/O in them.
 *
 * Split out of /api/portal/checkout/hosting so the two things most likely to be
 * got wrong can be tested without a database, a session or Razorpay:
 *
 *   1. THE MONEY. Whole rupees, end to end (CLAUDE.md §13). `quotes.subtotal`
 *      and `quotes.amount` are integer columns, and a fractional total does not
 *      round on the way in — it is refused, or silently truncated, depending on
 *      the driver. Rounding here, once, is what keeps the invoice and the
 *      Razorpay order agreeing to the paisa.
 *
 *   2. THE HAND-OFF TO THE WEBHOOK. Nothing in the checkout route activates
 *      hosting; /api/webhooks/razorpay does, and it decides WHAT was bought by
 *      reading `item_id` out of each line (`vendorForQuote`) and falling back to
 *      sniffing the word "hosting" out of the plan label (`vendorFromPlan`).
 *      Both of those are strings this file produces. Get either wrong and the
 *      payment still succeeds, the invoice still raises, and the hosting is
 *      simply never provisioned — a failure with no error anywhere in it, which
 *      is exactly the kind that needs a test rather than a careful reading.
 */

/** GST on web hosting (SAC 998315). */
export const HOSTING_GST_RATE = 18;

export interface HostingOrderTotals {
  /** Pre-tax, whole rupees. */
  subtotal: number;
  /** Payable including GST, whole rupees — what Razorpay is asked for. */
  amount: number;
  /** The tax rate stamped on the quote, so the invoice can restate it. */
  taxRate: number;
}

/**
 * Totals for one hosting plan at its catalogue price.
 *
 * Rounds the price first and the total second, on purpose: rounding only at the
 * end lets a fractional catalogue price (the DMS engine publishes 49.99) reach
 * `subtotal`, which is an integer column.
 */
export function hostingOrderTotals(msrp: number, rate: number = HOSTING_GST_RATE): HostingOrderTotals {
  /* `Number(x) || 0` catches NaN, null and "" — but NOT Infinity, which is
     truthy and survives Math.round as Infinity. This function's whole promise is
     an integer, and `expect(Number.isInteger(subtotal))` is what caught it, so
     the guard is finiteness rather than falsiness. */
  const n = Number(msrp);
  const subtotal = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  return {
    subtotal,
    amount: Math.round(subtotal * (1 + rate / 100)),
    taxRate: rate,
  };
}

/**
 * The `quotes.plan` label.
 *
 * Must contain the word "hosting": it is the webhook's FALLBACK identification
 * when a line carries no item_id (`vendorFromPlan` tests `p.includes("hosting")`).
 * Matches the shape the public cart writes — `hosting-starter` — so the two
 * checkouts produce quotes the webhook reads identically.
 */
export function hostingPlanLabel(planIdOrItemId: string): string {
  const stem = (planIdOrItemId || "").trim().toLowerCase() || "plan";
  return `hosting-${stem}`;
}

export interface HostingLineItem {
  id: string;
  /** The catalogue row. `vendorForQuote` reads THIS to resolve the vendor. */
  item_id: string;
  name: string;
  qty: number;
  rate: number;
  cost: number;
}

/**
 * The single line a hosting order is. `item_id` is not decoration: it is the
 * authoritative path the webhook uses, and the plan label is only the backstop.
 */
export function hostingLineItem(args: {
  quoteId: string;
  itemId: string;
  planName: string;
  domain: string;
  rate: number;
}): HostingLineItem {
  return {
    id: `${args.quoteId}-1`,
    item_id: args.itemId,
    name: `${args.planName} — ${args.domain}`,
    qty: 1,
    rate: Math.max(0, Math.round(Number(args.rate) || 0)),
    cost: 0,
  };
}
