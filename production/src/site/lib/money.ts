/**
 * Indian-format rupees, and the cart arithmetic — the handoff's formulas, verbatim:
 *
 *   gross    = Σ unitPrice × qty
 *   subtotal = gross − discount        (coupon applies to gross, BEFORE GST)
 *   gst      = subtotal × 0.18
 *   payable  = subtotal + gst
 *   recurring = Σ monthly lines, displayed × 1.18
 *
 * One module, because the drawer, the cart page and the checkout all show the same money —
 * three copies of this arithmetic is how a drawer total comes to disagree with the checkout
 * button, which on a commerce site is the least-forgivable class of bug.
 */
export function rupee(n: number): string {
  return "₹" + Math.round(n).toLocaleString("en-IN");
}

export type Cycle = "monthly" | "yearly" | "once";

export interface CartLine {
  /** Stable identity for steppers/removal. */
  key: string;
  label: string;
  detail: string;
  unitPrice: number;
  qty: number;
  /** What one unit is — "seat/month", "year", "mailbox". Renders as "40 × ₹736 per seat/month". */
  unit: string;
  cycle: Cycle;
}

/** The two launch coupons from the handoff. Percent off the gross, before GST. */
export const COUPONS: Readonly<Record<string, number>> = {
  ANUTECH10: 0.10,
  MIGRATE15: 0.15,
};

export const GST_RATE = 0.18;

export interface CartTotals {
  gross: number;
  discountRate: number;
  discount: number;
  subtotal: number;
  gst: number;
  payable: number;
  /** Monthly-cycle lines only, pre-GST. The UI shows `recurring × 1.18` per month. */
  recurring: number;
}

export function cartTotals(lines: readonly CartLine[], couponCode: string): CartTotals {
  const gross = lines.reduce((n, l) => n + l.unitPrice * l.qty, 0);
  const discountRate = COUPONS[couponCode.trim().toUpperCase()] ?? 0;
  const discount = gross * discountRate;
  const subtotal = gross - discount;
  const gst = subtotal * GST_RATE;
  return {
    gross,
    discountRate,
    discount,
    subtotal,
    gst,
    payable: subtotal + gst,
    recurring: lines.filter((l) => l.cycle === "monthly").reduce((n, l) => n + l.unitPrice * l.qty, 0),
  };
}

/** "Recurring monthly" | "Renews yearly" | "One time" — the cart row's cycle label. */
export function cycleLabel(cycle: Cycle): string {
  return cycle === "monthly" ? "Recurring monthly" : cycle === "yearly" ? "Renews yearly" : "One time";
}
