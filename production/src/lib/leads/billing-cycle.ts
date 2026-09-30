/**
 * R-071 (migration 20260930200000): how a deal will be billed, and who the prospect buys
 * from today. Pure, tested (billing-cycle.test.ts).
 *
 * ─── WHY `value` STAYS ANNUAL ───────────────────────────────────────────────
 * `leads.value` is summed everywhere a pipeline number appears — forecast.ts (open pipeline,
 * weighted forecast), the Kanban column totals (lead_counts().stage_totals), the dashboard
 * KPIs and the "hot" rule (value ≥ ₹1,00,000). If a monthly deal stored seats × price and a
 * yearly one seats × price × 12, every one of those sums would add months to years and
 * nobody would see it. So the cycle is DESCRIPTIVE: value is always the annual deal value
 * (seats × price per seat per month × 12), and a monthly deal additionally shows what one
 * month's bill is.
 */
export type BillingCycle = "monthly" | "yearly";

export const BILLING_CYCLE_OPTIONS: ReadonlyArray<{ value: BillingCycle; label: string }> = [
  { value: "yearly",  label: "Yearly (annual billing)" },
  { value: "monthly", label: "Monthly (billed every month)" },
];

export function billingCycleLabel(c: string | null | undefined): string {
  if (c === "monthly") return "Monthly";
  if (c === "yearly") return "Yearly";
  return "";
}

/** One month's bill for an annual deal value, whole rupees; null when there is no value. */
export function monthlyBill(annualValue: number | null | undefined): number | null {
  if (!annualValue || annualValue <= 0 || !Number.isFinite(annualValue)) return null;
  return Math.round(annualValue / 12);
}

/** Form value → column value: "" / anything unknown → null. */
export function toBillingCycle(v: string | null | undefined): BillingCycle | null {
  return v === "monthly" || v === "yearly" ? v : null;
}
