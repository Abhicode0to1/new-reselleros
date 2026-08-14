/**
 * Microsoft NCE 168-hour cancellation window.
 *
 * ─── WHAT MICROSOFT'S RULE ACTUALLY IS ──────────────────────────────────────
 * On New Commerce Experience, a subscription may be cancelled or have its seat
 * count REDUCED only within 168 hours (7 calendar days) of the term starting.
 * After that the reseller owes Microsoft for the full committed term whatever the
 * customer does. Seats can still be ADDED at any time — the restriction is
 * one-directional.
 *
 * ─── WHY THIS GUARD EXISTS IN OUR APP AT ALL ────────────────────────────────
 * Microsoft enforces it on their side regardless. The damage without a guard here
 * is not that the reduction fails upstream — it is that it SUCCEEDS in ResellerOS
 * and nowhere else. The operator sees 5 seats, Microsoft bills 10, and the
 * difference is discovered on the distributor invoice weeks later with no record
 * of who changed what. Blocking it locally keeps our number and the number we are
 * actually charged the same.
 *
 * ─── THE WINDOW IS COUNTED IN DAYS, NOT HOURS ───────────────────────────────
 * "168 hours" and "7 days" are the same rule stated two ways, and hours are the
 * worse choice here: `start_date` is a DATE column with no time of day, so any
 * hour arithmetic would be inventing precision the data does not have. Counting
 * calendar days from start_date is honest about what we know.
 *
 * ─── THE BOUNDARY LEANS TOWARDS BLOCKING, AND THAT IS THE SAFE SIDE ─────────
 * The window covers days 0–6; day 7 onwards is locked. A first draft of this
 * header argued the opposite — that allowing day 7 was "the risky side deliberately
 * chosen" — and had the risk backwards. Compare the two failures:
 *
 *   allow a reduction Microsoft refuses  → our DB says 5 seats, Microsoft bills
 *                                          10, nobody finds out until the
 *                                          distributor invoice. SILENT.
 *   block one Microsoft would have taken → the operator is annoyed and rings the
 *                                          distributor. RECOVERABLE.
 *
 * Blocking a day early is the cheap mistake, so the boundary sits there. If our
 * start_date is a day behind Microsoft's, we refuse slightly early rather than let
 * a drift through. `lockWarning()` below makes days 4–6 visibly the last chance,
 * so the wall is never a surprise.
 *
 * Pure — no dates from the environment, no database. `today` is always passed in.
 */
import { daysBetweenDates } from "./proration";

/** Microsoft's window: 168 hours. */
export const NCE_WINDOW_DAYS = 7;

export interface NceLockInput {
  /** Only 'microsoft' is governed by NCE. Everything else is unaffected. */
  vendor:        string | null | undefined;
  /** Term start, YYYY-MM-DD. Null means we cannot judge — see the result. */
  startDate:     string | null | undefined;
  /** Today, YYYY-MM-DD. Passed in so this stays testable and deterministic. */
  today:         string;
  currentSeats:  number;
  /** The seat count being saved. Equal or higher is never blocked. */
  nextSeats:     number;
  /** The status being saved. 'cancelled' is a cancellation; others are not. */
  nextStatus:    string | null | undefined;
}

export type NceLockAction = "reduce_seats" | "cancel" | "both";

export interface NceLockResult {
  /** True when this change must be refused. */
  locked:     boolean;
  /** What the operator was trying to do, when it is a governed action. */
  action:     NceLockAction | null;
  /** Days since the term started. Negative means it has not begun. */
  dayssince:  number | null;
  /** Days of window left, 0 once it has closed. Null when not applicable. */
  daysLeft:   number | null;
  /** Plain-language reason plus the next step (CLAUDE.md §24). '' when allowed. */
  reason:     string;
}

const ALLOWED: NceLockResult = { locked: false, action: null, dayssince: null, daysLeft: null, reason: "" };

/**
 * Should this edit be refused under NCE?
 *
 * Returns `locked: false` for everything that is not a Microsoft reduction or
 * cancellation — including a missing start_date, because refusing an edit on
 * data we never captured would trap the operator with no way out, and the §24
 * rule is that a block must always leave a path forward. That case is surfaced by
 * `lockWarning()` instead, so it is visible without being immovable.
 */
export function checkNceLock(input: NceLockInput): NceLockResult {
  if ((input.vendor ?? "").toLowerCase() !== "microsoft") return ALLOWED;

  const reducing  = Number.isFinite(input.nextSeats) && Number.isFinite(input.currentSeats)
    && input.nextSeats < input.currentSeats;
  const cancelling = (input.nextStatus ?? "").toLowerCase() === "cancelled";
  if (!reducing && !cancelling) return ALLOWED;

  const action: NceLockAction = reducing && cancelling ? "both" : reducing ? "reduce_seats" : "cancel";

  // Unknown start date → cannot judge, so do not block. Flagged by lockWarning().
  if (!input.startDate) return { ...ALLOWED, action };

  let days: number;
  try {
    days = daysBetweenDates(input.startDate, input.today);
  } catch {
    return { ...ALLOWED, action };   // unparseable date — same reasoning
  }

  // Term has not started yet: nothing to be locked out of.
  if (days < 0) return { ...ALLOWED, action, dayssince: days, daysLeft: NCE_WINDOW_DAYS };

  const daysLeft = Math.max(0, NCE_WINDOW_DAYS - days);
  if (daysLeft > 0) {
    return { locked: false, action, dayssince: days, daysLeft, reason: "" };
  }

  const what = action === "cancel"
    ? "cancel this subscription"
    : action === "both"
      ? "cancel this subscription or reduce its seats"
      : `reduce seats from ${input.currentSeats} to ${input.nextSeats}`;

  return {
    locked:    true,
    action,
    dayssince: days,
    daysLeft:  0,
    reason:
      `Microsoft NCE: you can only ${what} within ${NCE_WINDOW_DAYS} days of the term starting ` +
      `(${input.startDate}). That was ${days} days ago, so Microsoft will bill the full committed ` +
      `term regardless — changing the number here would only make ResellerOS disagree with your ` +
      `distributor invoice. To stop the renewal instead, turn OFF auto-renew, or raise a reduction ` +
      `with your distributor for the NEXT term.`,
  };
}

/**
 * A heads-up while the change is still permitted — the opposite job to the block.
 *
 * A hard wall on day 8 with silence on day 6 is a bad trade for an operator who
 * had no way to know a deadline existed. Returns null when there is nothing worth
 * saying.
 */
export function lockWarning(input: NceLockInput): string | null {
  if ((input.vendor ?? "").toLowerCase() !== "microsoft") return null;

  if (!input.startDate) {
    return "This is a Microsoft NCE subscription with no start date recorded, so the 7-day " +
           "cancellation window cannot be checked. Add the start date — Microsoft still enforces it.";
  }

  /* Days are computed HERE rather than by asking checkNceLock.
     A first version passed it `nextSeats: currentSeats, nextStatus: "active"` to
     borrow the arithmetic — but that is not a reduction or a cancellation, so
     checkNceLock correctly short-circuits to ALLOWED with `dayssince: null`, and
     this function returned null on every single day. It looked implemented and
     warned nobody, once. */
  let days: number;
  try {
    days = daysBetweenDates(input.startDate, input.today);
  } catch {
    return null;
  }

  if (days < 0) return null;                       // term has not started
  const daysLeft = NCE_WINDOW_DAYS - days;         // 7 on day 0, 1 on day 6
  if (daysLeft <= 0) return null;                  // already locked — the block speaks
  if (daysLeft > 3) return null;                   // only worth saying near the edge

  return `Microsoft NCE: ${daysLeft} day${daysLeft === 1 ? "" : "s"} left to cancel or reduce seats. ` +
         `After that the full committed term is payable.`;
}
