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
  /**
   * Stable server-recognisable SKU, e.g. "hosting:standard". OPTIONAL and set by
   * the "Buy now" buttons. The checkout API re-prices every line from this SKU
   * server-side and NEVER trusts `unitPrice` from the client — a line without a
   * recognised SKU can't be charged online (it's sent to a quote instead).
   */
  sku?: string;
  /**
   * Domain lines only: the full name being registered ("acme.in"). The checkout
   * API refuses a `domain:<tld>` line without it — the name is what gets
   * registered, and a TLD alone ("Domain .in") told nobody which one was paid for.
   */
  domain?: string;
  /**
   * Domain lines only (R-156): the registration term picked, 1–10 (absent → 1), the total
   * price of each offered term as the search showed it, and whether the line was added as
   * the ₹0 domain bundled with yearly hosting (first year free, later years charged).
   * Display only — the checkout re-prices the term from the registry.
   */
  years?: number;
  yearPrices?: Record<string, number>;
  bundleFree?: boolean;
}

/** A domain line's price for a term: the term's total, less the free first year when bundled. */
export function domainTermPrice(yearPrices: Record<string, number> | undefined, years: number, bundleFree?: boolean): number | null {
  const total = yearPrices?.[String(years)];
  if (total === undefined) return null;
  if (!bundleFree) return total;
  return Math.max(0, total - (yearPrices?.["1"] ?? 0));
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
/**
 * A line that is always exactly one: a free hosting trial (one per customer — a
 * "5 ×" trial is meaningless), a domain (one name is one registration; the
 * checkout already refuses a quantity above one) and a hosting plan (one plan is
 * one account on one domain; checkout sets up one hosting account per order, see
 * lib/checkout/hosting-limit.ts). No stepper is shown for these, adding one again
 * never bumps it, and a stored quantity is put back to 1.
 */
export function isSingleUnit(line: Pick<CartLine, "sku">): boolean {
  const sku = (line.sku ?? "").toLowerCase();
  return sku.startsWith("hosting-trial:") || sku.startsWith("domain:") || sku.startsWith("hosting:");
}

/**
 * Why a single-unit line is fixed at 1, in the words shown under its locked quantity
 * control (owner, 30 Sep 2026: "there should be a quantity option like others but it
 * should stay locked at 1"). Null for a line whose quantity can change.
 */
export function singleUnitNote(line: Pick<CartLine, "sku">): string | null {
  const sku = (line.sku ?? "").toLowerCase();
  if (sku.startsWith("hosting-trial:")) return "1 per customer";
  if (sku.startsWith("hosting:")) return "1 per order";
  if (sku.startsWith("domain:")) return "1 per domain";
  return null;
}

export function isTrialLine(line: Pick<CartLine, "sku">): boolean {
  return (line.sku ?? "").toLowerCase().startsWith("hosting-trial:");
}

export function cycleLabel(cycle: Cycle): string {
  return cycle === "monthly" ? "Recurring monthly" : cycle === "yearly" ? "Renews yearly" : "One time";
}
