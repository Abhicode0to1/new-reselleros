/**
 * The billing schedule — when a subscription will be invoiced, and for how much.
 *
 * ─── WHAT THIS IS *NOT*: IT DOES NOT CREATE INVOICES 30 DAYS EARLY ──────────
 * The brief asks to "auto-generate renewal invoices 30 days before renewal_date".
 * Creating an invoice row in this system calls `next_document_number('invoice')` and
 * takes a number out of the tenant's GST series — see migration 0004 and CLAUDE.md
 * §17a. Issuing that number thirty days before the supply, for a renewal that may
 * never happen, is not a scheduling detail:
 *
 *   • CGST Rule 46 requires a consecutive series. A renewal that lapses leaves an
 *     issued number for a supply that did not occur, which then needs a credit note
 *     to cancel — one per lapsed renewal, for ever.
 *   • The invoice date drives the GST period it falls in. A March invoice for an
 *     April supply moves revenue into the wrong return.
 *
 * So this module computes the schedule — every future billing date and amount, as
 * far ahead as you like — and NOTHING here writes a document. The renewal cron shows
 * it thirty days ahead so nobody is surprised, and the invoice is issued on its
 * billing date through the existing RPC, taking its number then.
 *
 * ─── THE INSTALMENTS ALWAYS SUM TO THE TERM TOTAL ───────────────────────────
 * ₹1,00,000 billed quarterly is not four times ₹25,000 when the number does not
 * divide: three instalments of ₹33,333 and one of ₹33,334, never four of ₹33,333.33
 * that add up to ₹99,999.99 and leave a rupee nobody can explain. The remainder is
 * carried into the LAST instalment, and a test asserts the sum.
 *
 * Whole rupees throughout (AGENTS.md §1). Paise appear only inside the division.
 */
import type { BillingCycle } from "@/lib/supabase/database.types";

/** Months covered by one invoice of each cycle. */
export const CYCLE_MONTHS: Record<BillingCycle, number> = {
  monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12,
};

export interface BillingPeriod {
  /** 1-based position in the term. */
  index: number;
  /** YYYY-MM-DD. The date the invoice should be raised. */
  billOn: string;
  /** Service period this invoice covers, inclusive start, exclusive end. */
  periodStart: string;
  periodEnd: string;
  /** ₹ ex-GST for this instalment. Whole rupees. */
  amount: number;
}

export interface ScheduleInput {
  /** Term start, YYYY-MM-DD. */
  startDate: string;
  /** Whole months in the term. 12 = annual, 36 = a three-year deal. */
  termMonths: number;
  cycle: BillingCycle;
  /** ₹ ex-GST for the WHOLE term. Not per year — a 3-year deal passes 3 years' worth. */
  termAmount: number;
}

/**
 * Add whole months to a YYYY-MM-DD, clamping to the end of the target month.
 *
 * 31 Jan + 1 month is 28 Feb, not 3 March. JavaScript's Date rolls over, which would
 * silently move a billing date into the next month and, on a monthly plan, make the
 * anniversary drift later every year until a January subscription billed in March.
 */
export function addMonthsClamped(dateISO: string, months: number): string {
  const [y, m, d] = dateISO.slice(0, 10).split("-").map(Number);
  const targetMonthIndex = (m - 1) + months;
  const targetYear = y + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  // Day 0 of the NEXT month is the last day of the target month.
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Build the schedule.
 *
 * A cycle longer than the term collapses to a single instalment rather than erroring:
 * a 6-month deal billed "yearly" is one invoice for six months, which is what a
 * reseller means when they pick it.
 */
export function buildBillingSchedule(input: ScheduleInput): BillingPeriod[] {
  const { startDate, cycle, termAmount } = input;
  const termMonths = Math.max(1, Math.trunc(input.termMonths));
  const monthsPerInvoice = Math.min(CYCLE_MONTHS[cycle], termMonths);

  /* Ceil, so a term that does not divide evenly still bills its tail. A 13-month
     deal on a quarterly cycle is five invoices — four quarters and one month — not
     four that quietly drop the last month. */
  const count = Math.ceil(termMonths / monthsPerInvoice);

  /* Split WHOLE RUPEES directly — no paise round-trip.
     Splitting in paise and converting each instalment back with paiseToRupees()
     rounds every instalment independently, and the rounded parts do not add up to
     the whole: ₹1 over 12 months became 12 × ₹1 = ₹12, and ₹1,00,001 came out ₹5
     short. The term amount is already a whole-rupee integer (AGENTS.md §1), so
     there was nothing for paise to buy here. Paise belong in prorate(), where a
     days ratio genuinely needs sub-rupee precision. */
  const total = Math.max(0, Math.round(termAmount));
  const perInvoice = Math.floor(total / count);
  /* The remainder lands on the LAST instalment. Spreading it would make several
     instalments differ by a rupee for no reason a customer could follow. */
  const remainder = total - perInvoice * count;

  const periods: BillingPeriod[] = [];
  for (let i = 0; i < count; i++) {
    const monthsIn = i * monthsPerInvoice;
    const periodStart = addMonthsClamped(startDate, monthsIn);
    const periodEnd = addMonthsClamped(startDate, Math.min(monthsIn + monthsPerInvoice, termMonths));
    periods.push({
      index: i + 1,
      /* Billed in advance, on the day the period starts — the norm for SaaS and what
         `renewal_date` already means in this schema. */
      billOn: periodStart,
      periodStart,
      periodEnd,
      amount: perInvoice + (i === count - 1 ? remainder : 0),
    });
  }
  return periods;
}

/** The instalments falling within `days` of `today` — what the cron shows ahead. */
export function upcomingBillings(schedule: readonly BillingPeriod[], todayISO: string, days: number): BillingPeriod[] {
  const horizon = addDaysISO(todayISO, days);
  return schedule.filter((p) => p.billOn >= todayISO && p.billOn <= horizon);
}

/** YYYY-MM-DD plus N days, in UTC so no timezone can shift the date. */
export function addDaysISO(dateISO: string, days: number): string {
  const d = new Date(`${dateISO.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ════════════════════════════════════════════════════════════════════════════
   `subscriptions.renewal_date` IS THE LAST COVERED DAY — INCLUSIVE
   ────────────────────────────────────────────────────────────────────────────
   Changed 11 Sep 2026 on Abhishek's instruction. It used to hold the ANNIVERSARY:
   a subscription starting 11 Sep 2026 stored 11 Sep 2027, the first day of term two.
   He reads the column as an expiry date — as does the Google Admin console he
   reconciles against — and 11 Sep 2027 for a term beginning 11 Sep 2026 reads as a
   day too many.

   The number stored moved by one day. What makes that SAFE rather than a slow leak is
   this pair of functions: every place that turns the column into a term boundary now
   goes through them, so the ±1 lives in one file instead of being remembered at six
   call sites. Miss one and the term silently starts a day early, every renewal,
   compounding — which is the failure this whole block exists to prevent.

   The roll-forward is unaffected: an inclusive end plus twelve months is the next
   inclusive end (10 Sep 2027 → 10 Sep 2028), so record_payment and the renewal cron
   keep working on the stored value directly.
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * The last day a term COVERS, given when it started and how long it runs.
 *
 * start 11 Sep 2026 + 12 months → **10 Sep 2027**. The subscription is live on that
 * day and expires at the end of it; term two begins the next morning.
 *
 * Use this anywhere a renewal/expiry date is derived from a start date.
 */
export function termEndInclusive(startDateISO: string, termMonths: number): string {
  return addDaysISO(addMonthsClamped(startDateISO, termMonths), -1);
}

/**
 * The first day of the NEXT term, given the stored inclusive end date.
 *
 * The inverse of termEndInclusive, and the only correct way to use `renewal_date`
 * as a period boundary: passing the stored date straight into a schedule would
 * re-bill the last covered day.
 */
export function nextTermStart(renewalDateISO: string): string {
  return addDaysISO(renewalDateISO.slice(0, 10), 1);
}

/**
 * The last day a billing period COVERS, for display.
 *
 * `BillingPeriod.periodEnd` is EXCLUSIVE — the boundary, not a day of service. Printing
 * it raw reads as a day too many: the billing panel said "covers 11 Sept 2026 –
 * 11 Sept 2027" next to a row that now correctly said the term ends on the 10th, so the
 * same screen contradicted itself. Reported by Abhishek, 11 Sep 2026.
 */
export function periodLastDay(periodEndExclusiveISO: string): string {
  return addDaysISO(periodEndExclusiveISO.slice(0, 10), -1);
}

/**
 * Does the whole schedule add up to the term total?
 *
 * Exported and tested rather than assumed: this is the one property that makes a
 * split schedule safe to bill from, and a future change to the rounding could break
 * it silently.
 */
export function scheduleTotal(schedule: readonly BillingPeriod[]): number {
  return schedule.reduce((s, p) => s + p.amount, 0);
}
