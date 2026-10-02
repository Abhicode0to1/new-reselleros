/**
 * The price a catalogue row shows on /items (2 Oct 2026).
 *
 * Most rows are a per-seat monthly rate in `msrp`. A yearly-discount plan (the support
 * "(Yearly)" SKUs) keeps `msrp` at 0 and its whole-year total in `prices.annual_total`,
 * see lib/subscriptions/catalog-options.ts — so printing `msrp` showed "₹0/mo" for a
 * ₹9,996-a-year plan.
 */
export interface HeadlinePriceRow {
  msrp: number;
  prices?: unknown;
}

export function headlinePrice(it: HeadlinePriceRow): { amount: number; unit: "mo" | "yr" } {
  const total = (it.prices as { annual_total?: { msrp?: number } } | null | undefined)?.annual_total?.msrp;
  if (typeof total === "number" && total > 0 && !(it.msrp > 0)) return { amount: total, unit: "yr" };
  return { amount: it.msrp, unit: "mo" };
}

/** Support is our own service: no vendor cost, so a margin % on it means nothing. */
export function isOwnService(it: { vendor?: string | null }): boolean {
  return it.vendor === "support";
}
