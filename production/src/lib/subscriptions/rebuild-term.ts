/**
 * The term of a subscription being REBUILT from its quote line.
 *
 * Split out of the recreate-subscription route so it can be tested without a request, a
 * session and a database — and because the same three numbers are decided in two places.
 * `record_payment` builds this row when the money lands; the route rebuilds it when that
 * row is lost. They have to agree, and they did not: the route hard-coded a twelfth and a
 * +1 year, so after 20260822120000 taught record_payment about monthly terms, a rebuilt
 * monthly subscription came back with a twelfth of its MRR and a renewal a year away.
 *
 * Found while using the route to backfill a real quote (Q-TEST-2026-27-0009), which is the
 * only reason anybody looked: nothing warns you when two builders of the same row drift.
 */
import { addMonthsClamped } from "@/lib/billing/schedule";

export interface RebuildInput {
  /** The line's price tier, as stored. Anything but 'monthly' is treated as an annual term. */
  commitment?: string | null;
  /** Per-seat price for ONE term — the month's price on a monthly line, the year's otherwise. */
  rate?: number | null;
  qty?: number | null;
  /** Term start, YYYY-MM-DD. */
  startDate: string;
}

export interface RebuiltTerm {
  /** 1 or 12. Drives the reminder ladder — see lib/renewals/cadence.ts. */
  termMonths: number;
  /** Whole rupees per month; the column is an integer. */
  mrr: number;
  /** YYYY-MM-DD, one term after the start. */
  renewalDate: string;
}

export function rebuildTerm(input: RebuildInput): RebuiltTerm {
  const isMonthly = (input.commitment ?? "").trim().toLowerCase() === "monthly";
  const termMonths = isMonthly ? 1 : 12;
  const seats = input.qty ?? 0;

  /* A monthly line's rate is already one month of money, so dividing it by twelve would
     report a tenth of the real MRR. An annual line's rate is the year, which is where the
     twelfth belongs and where it came from. */
  const mrr = Math.round(((input.rate ?? 0) * seats) / termMonths);

  /* Clamped, like Postgres: 31 Jan + 1 month is 28 Feb, and 29 Feb + 1 year is 28 Feb.
     Plain JS Date rolls both over into the next month, which would have put a renewal a
     day or three after the service actually lapsed. */
  return { termMonths, mrr, renewalDate: addMonthsClamped(input.startDate, termMonths) };
}
