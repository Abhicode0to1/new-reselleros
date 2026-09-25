/**
 * What can honestly be said about net profit — including when the cost of goods is
 * not recorded.
 *
 * Cost of goods is never negative. So even without it, revenue − expenses is a CEILING
 * on net profit. When that ceiling is already below zero, the period is certainly a
 * loss of at least that much — a fact, not a guess — and saying "Unknown" hides it.
 * Only when the ceiling is positive is the sign genuinely unknown.
 */
import type { PnlPeriod } from "./pnl";

export type NetProfitView =
  | { kind: "known"; value: number }            // profit (≥ 0) or loss (< 0), exact
  | { kind: "loss-at-least"; value: number }    // positive number: the minimum loss
  | { kind: "profit-at-most"; value: number };  // ceiling ≥ 0; could still be a loss

export function netProfitView(m: Pick<PnlPeriod, "netProfit" | "revenue" | "expenses"> & { cogs?: number }): NetProfitView {
  if (m.netProfit !== null) return { kind: "known", value: m.netProfit };
  /* `cogs` here is only the KNOWN part (project delivery cost) — the licence part is what is unknown. */
  const ceiling = m.revenue - (m.cogs ?? 0) - m.expenses;
  return ceiling < 0 ? { kind: "loss-at-least", value: -ceiling } : { kind: "profit-at-most", value: ceiling };
}
