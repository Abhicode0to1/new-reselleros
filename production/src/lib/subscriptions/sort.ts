/**
 * Sorting the subscriptions table by whichever column was clicked.
 *
 * ─── WHY THIS IS NOT `rows.sort((a,b) => a[key] - b[key])` ──────────────────
 * Every column in that table has a way of being wrong that a generic comparator gets
 * wrong quietly:
 *
 *   dates        `start_date` and `renewal_date` are nullable, and a null sorted as ""
 *                lands at one end as if it were the earliest date in the book.
 *   margin       unknown for most rows (no catalogue cost), and unknown is NOT zero —
 *                sorting it as 0 puts every unpriced subscription in the middle of the
 *                healthy ones, which is the one place nobody looks for a problem.
 *   seats        an integer, so it must not go through localeCompare — "10" sorts
 *                before "9" as text.
 *   text         customer names come from imports with mixed case and stray spaces.
 *
 * So each key names its own value, and "unknown" is carried as null all the way to the
 * comparator, which always sinks it. Whichever direction you sort, a row we know nothing
 * about goes last: it is not the biggest and it is not the smallest.
 */
import type { Subscription } from "@/lib/supabase/database.types";

export type SubSortKey =
  | "customer" | "plan" | "vendor" | "seats" | "mrr" | "margin"
  | "started" | "renewal" | "status";

export type SortDir = "asc" | "desc";

export interface SubSort {
  key: SubSortKey;
  dir: SortDir;
}

/** ₹/month margin for a row, or null when the catalogue cannot price it. */
export type MarginOf = (sub: Subscription) => number | null;

/**
 * Which direction a column should start in when first clicked.
 *
 * Text reads naturally A→Z; money, seats and margin are asked about biggest-first
 * ("who is worth most", "where is the margin worst" — the latter is why margin starts
 * ascending, not descending); dates are asked about soonest-first.
 */
export function defaultDirFor(key: SubSortKey): SortDir {
  switch (key) {
    case "mrr":
    case "seats":
      return "desc";
    case "margin":
      /* Worst first. A margin sort is a hunt for the bad ones — starting at the
         healthiest end means scrolling past everything that is fine. */
      return "asc";
    default:
      return "asc";
  }
}

export function sortSubscriptions(
  rows: readonly Subscription[],
  sort: SubSort,
  marginOf?: MarginOf,
): Subscription[] {
  const value = (s: Subscription): string | number | null => {
    switch (sort.key) {
      case "customer": return (s.customer_name ?? "").trim().toLowerCase() || null;
      case "plan":     return (s.plan ?? "").trim().toLowerCase() || null;
      case "vendor":   return (s.vendor ?? "").trim().toLowerCase() || null;
      case "status":   return (s.status ?? "").trim().toLowerCase() || null;
      case "seats":    return s.seats ?? null;
      case "mrr":      return s.mrr ?? null;
      case "margin":   return marginOf ? marginOf(s) : null;
      case "started":  return dateKey(s.start_date);
      case "renewal":  return dateKey(s.renewal_date);
    }
  };

  /* Stable by contract: equal rows keep the order they arrived in, which is the
     newest-first default. So sorting by Vendor still shows the newest Google
     subscription at the top of the Google block, rather than a random one. */
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);

    /* Unknown sinks in BOTH directions — it is not a small value, it is an absent one.
       Returning the comparison un-negated for these is deliberate: negating it below
       would float every unpriced row to the top on a descending sort, which is exactly
       the "failure as a plausible value" this codebase keeps finding. */
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;

    const cmp = typeof va === "number" && typeof vb === "number"
      ? va - vb
      : String(va).localeCompare(String(vb));
    return sort.dir === "asc" ? cmp : -cmp;
  });
}

/**
 * A date as a sortable number, or null when there is nothing usable.
 *
 * Not `Date.parse` on the raw value: these columns hold both `2026-08-29` and full
 * timestamps, and an empty string parses to NaN — which makes every comparison false and
 * silently disables the sort rather than failing.
 */
function dateKey(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}
