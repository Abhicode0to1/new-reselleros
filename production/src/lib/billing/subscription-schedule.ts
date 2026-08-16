/**
 * A subscription's billing schedule — the bridge from a stored row to `schedule.ts`.
 *
 * Kept apart from schedule.ts so the arithmetic stays pure and testable without a
 * database shape in it, and so this file can carry the one thing that is genuinely
 * about THIS schema: the term amount is not stored, it is derived from `mrr`.
 *
 * ─── WHY mrr × 12 AND NOT A STORED TERM PRICE ───────────────────────────────
 * `subscriptions` has no term-total column — it has `mrr`, which is what every other
 * revenue figure in this app is built on. Deriving the term from it keeps this
 * schedule consistent with the dashboard, the renewals list and the P&L. Inventing a
 * separate term price here would give the same subscription two different values
 * depending on which screen you were looking at, which is the failure this codebase
 * has already paid for three times over.
 *
 * A multi-year term is mrr × term_months — NOT mrr × 12 × years-with-a-discount.
 * Any multi-year discount is already inside the agreed mrr.
 */
import type { Subscription } from "@/lib/supabase/database.types";
import { buildBillingSchedule, upcomingBillings, type BillingPeriod } from "./schedule";

/** How far ahead the renewal cron shows what is coming. Matches the T-30 heads-up. */
export const BILLING_LOOKAHEAD_DAYS = 30;

type ScheduleFields = Pick<Subscription, "mrr" | "billing_cycle" | "term_months"> & {
  start_date: string | null;
  renewal_date: string | null;
};

/**
 * The schedule for the CURRENT term.
 *
 * Anchored on `renewal_date` minus the term rather than on `start_date`: a
 * subscription renewed three times has a start_date from years ago, and laying the
 * schedule from there would bill a term that ended in 2023. Falls back to start_date
 * only when there is no renewal date at all, and returns an empty schedule rather
 * than guessing when there is neither.
 */
export function subscriptionSchedule(sub: ScheduleFields): BillingPeriod[] {
  const termMonths = Math.max(1, sub.term_months ?? 12);
  const cycle = sub.billing_cycle ?? "yearly";
  const termAmount = Math.max(0, Math.round((sub.mrr ?? 0) * termMonths));

  let start: string | null = null;
  if (sub.renewal_date) {
    start = addMonths(sub.renewal_date.slice(0, 10), -termMonths);
  } else if (sub.start_date) {
    start = sub.start_date.slice(0, 10);
  }
  if (!start || termAmount <= 0) return [];

  return buildBillingSchedule({ startDate: start, termMonths, cycle, termAmount });
}

/** The NEXT term — what the customer is being asked to renew into. */
export function nextTermSchedule(sub: ScheduleFields): BillingPeriod[] {
  if (!sub.renewal_date) return [];
  const termMonths = Math.max(1, sub.term_months ?? 12);
  const termAmount = Math.max(0, Math.round((sub.mrr ?? 0) * termMonths));
  if (termAmount <= 0) return [];
  return buildBillingSchedule({
    startDate: sub.renewal_date.slice(0, 10),
    termMonths,
    cycle: sub.billing_cycle ?? "yearly",
    termAmount,
  });
}

/**
 * What falls due in the next `days` — current term first, then the next.
 *
 * Both terms are considered because the interesting window is exactly the one that
 * straddles a renewal: at T-30 the useful answer is "the renewal instalment", which
 * lives in the NEXT term and would be invisible if only the current one was scanned.
 */
export function upcomingForSubscription(
  sub: ScheduleFields,
  todayISO: string,
  days: number = BILLING_LOOKAHEAD_DAYS,
): BillingPeriod[] {
  return [
    ...upcomingBillings(subscriptionSchedule(sub), todayISO, days),
    ...upcomingBillings(nextTermSchedule(sub), todayISO, days),
  ];
}

/** Re-implemented locally to keep schedule.ts free of imports from here. */
function addMonths(dateISO: string, months: number): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  const idx = (m - 1) + months;
  const year = y + Math.floor(idx / 12);
  const mon = ((idx % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, mon + 1, 0)).getUTCDate();
  return `${year}-${String(mon + 1).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
}
