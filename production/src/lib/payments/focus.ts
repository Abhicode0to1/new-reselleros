/**
 * /payments ?focus= — the set behind "Collected MTD" (R-118, 2 Oct 2026).
 *
 * The tile adds sales receipts (payments, status received) AND project receipts
 * (project_payments) for this IST month — the same helper as the dashboard
 * (lib/company/summary.ts#collectedInMonth). This list holds only the first kind, so the
 * banner states the project part instead of letting the rows look short.
 */
import { istMonth, toIstDate } from "@/lib/dates/ist";

export const PAYMENT_FOCI = ["", "received-month"] as const;
export type PaymentFocus = (typeof PAYMENT_FOCI)[number];

export function paymentInFocus(
  p: { status: string; received_at: string | null },
  focus: PaymentFocus,
  now: Date = new Date(),
): boolean {
  if (focus === "") return true;
  return p.status === "received" && !!p.received_at && toIstDate(p.received_at).slice(0, 7) === istMonth(now);
}

/** Project receipts in this IST month — the part of Collected MTD that lives on /projects. */
export function projectReceivedInMonth(
  rows: readonly { amount: number; received_at: string | null }[],
  now: Date = new Date(),
): number {
  return rows
    .filter((p) => !!p.received_at && toIstDate(p.received_at).slice(0, 7) === istMonth(now))
    .reduce((s, p) => s + p.amount, 0);
}
