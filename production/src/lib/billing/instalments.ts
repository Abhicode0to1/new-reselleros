/**
 * Which subscriptions bill per period, and what their instalments are.
 *
 * The decisions the billing cron makes, kept pure so they can be tested without a
 * database — the route is left as plumbing.
 *
 * ─── ONLY CYCLES THAT ACTUALLY SPLIT ────────────────────────────────────────
 * A yearly term splits into exactly one period, which is what the quote path
 * already does. Routing yearly through instalments as well would mean two things
 * could invoice the same money, so yearly is deliberately excluded here — the same
 * line the database trigger draws in 20260817110200. If these two ever disagree,
 * either every yearly subscription stops being invoiced or every one is invoiced
 * twice, so they are written to be read together.
 */
import type { BillingCycle, Subscription } from "@/lib/supabase/database.types";
import { subscriptionSchedule } from "./subscription-schedule";

/** The cycles that produce more than one invoice per term. */
export const SPLIT_CYCLES: readonly BillingCycle[] = ["monthly", "quarterly", "half_yearly"] as const;

export function isSplitBilled(cycle: BillingCycle | null | undefined): boolean {
  return cycle != null && SPLIT_CYCLES.includes(cycle);
}

/** One instalment, in the shape the subscription_billings row takes. */
export interface PlannedInstalment {
  termStart:     string;
  periodIndex:   number;
  billOn:        string;
  periodStart:   string;
  periodEnd:     string;
  taxableAmount: number;
}

type ScheduleFields = Pick<Subscription, "mrr" | "billing_cycle" | "term_months"> & {
  start_date:   string | null;
  renewal_date: string | null;
};

/**
 * The instalments of the CURRENT term.
 *
 * term_start is the first period's start, and it is what separates one term's
 * instalments from the next term's in the unique key. period_index restarts at 1
 * every term, so without it a renewal's first instalment collides with the original
 * term's first instalment and silently never bills.
 */
export function plannedInstalments(sub: ScheduleFields): PlannedInstalment[] {
  if (!isSplitBilled(sub.billing_cycle)) return [];

  const periods = subscriptionSchedule(sub);
  if (periods.length === 0) return [];

  const termStart = periods[0].periodStart;
  return periods.map((p) => ({
    termStart,
    periodIndex:   p.index,
    billOn:        p.billOn,
    periodStart:   p.periodStart,
    periodEnd:     p.periodEnd,
    taxableAmount: p.amount,
  }));
}

/**
 * Why this subscription must NOT be billed by instalment right now — or null when
 * it may be.
 *
 * ─── THE TERM MAY ALREADY HAVE BEEN COLLECTED ───────────────────────────────
 * Today's sell path charges the customer the WHOLE term when they accept a quote:
 * /api/public/quote/[id]/pay takes quote.amount, and record_payment closes the quote
 * as received. Raising instalment invoices on top of that bills a customer a second
 * time for money they have already paid.
 *
 * So a term that has been collected is skipped, and the reason is returned rather
 * than the subscription being quietly dropped from the run. A cron that reports
 * "0 invoices raised" is indistinguishable from a broken one, which is how the
 * renewal engine's own dry-run mode came to exist.
 *
 * This is the honest boundary of split billing today: the machinery bills correctly,
 * but nothing collects per instalment yet, so it only engages once a subscription is
 * genuinely sold on a pay-as-you-go footing.
 */
export interface InstalmentSkip {
  code:   "not_split_billed" | "term_already_collected" | "no_schedule";
  reason: string;
}

export function instalmentSkip(args: {
  cycle:        BillingCycle | null | undefined;
  /** ₹ already received against the quote this subscription was sold on. */
  quotePaid:    number | null | undefined;
  /** ₹ the quote was for, GST-inclusive. */
  quoteAmount:  number | null | undefined;
  scheduleSize: number;
}): InstalmentSkip | null {
  if (!isSplitBilled(args.cycle)) {
    return { code: "not_split_billed", reason: "Billed yearly — invoiced from the quote, not per period." };
  }
  if (args.scheduleSize === 0) {
    return { code: "no_schedule", reason: "No term dates or no MRR, so there is nothing to lay instalments against." };
  }

  const paid   = args.quotePaid ?? 0;
  const amount = args.quoteAmount ?? 0;
  /* `>=` not `===`: an overpayment is still a collected term, and billing it again
     because ₹1 extra arrived would be absurd. */
  if (amount > 0 && paid >= amount) {
    return {
      code: "term_already_collected",
      reason: `The whole term was collected up front (₹${paid.toLocaleString("en-IN")} of ₹${amount.toLocaleString("en-IN")}). Instalment invoices would bill it twice.`,
    };
  }
  return null;
}

/**
 * Which of these instalments are due to be invoiced today.
 *
 * `<=` and not `===`: a cron that missed a day must catch up rather than skip the
 * period forever. Raising it is safe because raise_subscription_billing is
 * idempotent — a period already invoiced returns its existing invoice.
 */
export function instalmentsDue<T extends { billOn: string; invoiceId: string | null }>(
  rows: readonly T[],
  todayISO: string,
): T[] {
  return rows.filter((r) => r.invoiceId == null && r.billOn <= todayISO);
}
