/**
 * How a subscription's term and renewal distance are presented.
 *
 * These two live in `lib` rather than inside the page because `term().months`
 * multiplies MRR into a rupee figure the operator reads off the screen
 * ("Annual · ₹16,200"). Misclassifying a quarterly subscription as annual would
 * show four times the real renewal amount — that is money display, so it gets a
 * test rather than a hope.
 */
import { daysBetween } from "@/lib/utils";

export interface Term {
  label: string;
  /** Canonical months for the bucket — matches the label, so the total the
   *  operator reads always agrees with the term they are told it is. */
  months: number;
}

/**
 * Billing term, derived from the start↔renewal span.
 *
 * `months` comes back alongside the label because MRR alone misleads. Every
 * subscription in this tenant is annual, so a card reading "₹1,350 /mo" hides
 * the ₹16,200 that will actually be invoiced at renewal — which is the number
 * needed when picking up the phone.
 */
export function term(start: string | null | undefined, renewal: string | null | undefined): Term | null {
  if (!start || !renewal) return null;
  const span = daysBetween(start, renewal);
  // A renewal date before the start date is corrupt data, not a term.
  if (!Number.isFinite(span) || span <= 0) return null;
  const m = Math.round(span / 30.44);
  if (m <= 1) return { label: "Monthly",     months: 1  };
  if (m <= 4) return { label: "Quarterly",   months: 3  };
  if (m <= 8) return { label: "Half-yearly", months: 6  };
  return       { label: "Annual",      months: 12 };
}

/**
 * How far away the renewal is, in words.
 *
 * WHY THIS EXISTS. The subscription card showed only a date ("23 Jul 2027")
 * plus a "Xd" badge gated at 30 days. Every one of this tenant's 54
 * subscriptions renews 181–365 days out, so that badge never rendered once —
 * the page's own "Expiring 30d" tab reads 0 — and the operator was left doing
 * date arithmetic in their head on a phone.
 *
 * Exact days while it is close enough to act on; months beyond that, because
 * "in 344 days" is a number nobody can feel.
 */
export function renewalDistance(days: number): string {
  if (!Number.isFinite(days)) return "—";
  if (days < 0)   return `${Math.abs(days)}d overdue`;
  if (days === 0) return "due today";
  if (days === 1) return "in 1 day";
  if (days <= 60) return `in ${days} days`;
  return `in ~${Math.round(days / 30.44)} months`;
}
