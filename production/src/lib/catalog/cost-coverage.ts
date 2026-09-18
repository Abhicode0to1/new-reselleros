/**
 * How much of the catalogue has a vendor cost — and the average margin over the part
 * that does.
 *
 * ─── WHY THIS IS NOT A ONE-LINER IN THE PAGE ────────────────────────────────
 * It was, and it was wrong in a way nobody could see.
 *
 * `margin_pct` on a row with `wholesale = 0` is 100%: sale price minus nothing, over
 * sale price. Those rows were included in the catalogue's headline average, so a
 * catalogue where a third of the products had no cost recorded still reported a
 * healthy margin — the missing information was rendered as perfection.
 *
 * That average is the number an operator glances at to decide whether pricing is fine.
 * It read fine precisely when it was least able to know.
 *
 * The two halves are separated here so the average is taken over rows the app actually
 * has costs for, and the rest are counted and named instead of being averaged in.
 * Reported from the other end on 12 Sep 2026: /subscriptions warns "N subscriptions
 * cannot be checked — no wholesale price in the catalog", and /items, the page you go
 * to in order to fix that, showed those products as a plain "₹0".
 *
 * Money is whole rupees (AGENTS.md §1). `wholesale` is the vendor's price to us.
 */

/** The fields this needs. Kept minimal so tests do not build a whole Item row. */
export interface CostCoverageRow {
  /** Vendor cost to us, whole rupees. 0 or null means NOT RECORDED, not free. */
  wholesale: number | null;
  /** Sale margin percent, as stored. Meaningless on a row with no cost. */
  margin_pct: number;
}

export interface CostCoverage<T> {
  /** Rows with a real vendor cost. The only ones margin can be computed from. */
  priced: T[];
  /** Rows with no cost recorded. Named, counted, never averaged. */
  unpriced: T[];
  /**
   * Average margin percent over `priced` only, rounded to a whole percent.
   *
   * 0 when nothing is priced — and the caller must say so rather than printing "0%"
   * as though it were measured, which is why `priced.length` is returned too.
   */
  avgMarginPct: number;
}

/**
 * Split a catalogue into priced and unpriced, and average the margin over the priced.
 *
 * A cost is "recorded" only when it is greater than zero. Null, undefined and 0 all mean
 * the same thing here — nobody has entered it — and treating 0 as a real cost is exactly
 * what produced the 100% margins.
 *
 * Negative wholesale is treated as unrecorded too: it cannot be a real vendor price, and
 * averaging it in would push the headline the wrong way.
 */
export function catalogCostCoverage<T extends CostCoverageRow>(rows: readonly T[]): CostCoverage<T> {
  const priced: T[] = [];
  const unpriced: T[] = [];
  for (const r of rows) {
    if (typeof r.wholesale === "number" && r.wholesale > 0) priced.push(r);
    else unpriced.push(r);
  }
  const avgMarginPct = priced.length > 0
    ? Math.round(priced.reduce((s, r) => s + r.margin_pct, 0) / priced.length)
    : 0;
  return { priced, unpriced, avgMarginPct };
}
