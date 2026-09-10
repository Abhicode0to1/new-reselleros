/**
 * When to try telling DirectAdmin again, after a suspension failed to land.
 *
 * ─── WHY THIS IS ITS OWN FILE ────────────────────────────────────────────────
 * It is the only decision in `/api/cron/hosting-suspend` that can be wrong in a
 * way nobody notices. Everything else in that route either works or leaves an
 * error on the row; a broken back-off just quietly changes how hard we hammer
 * somebody's server, or how long a refunded website stays online. Same split the
 * rest of this repo uses — `lib/domains/lifecycle.ts` beside `asset-sweep`, and
 * `lib/portal/nav-scroll.ts` beside the nav.
 *
 * ─── WHY IT BACKS OFF AT ALL ─────────────────────────────────────────────────
 * The likeliest first failure is a blip, so the first retry is soon. After that
 * the likeliest cause is our IP not being allowed, or the box being down, and
 * neither of those is fixed by asking again in fifteen minutes. Retrying hard
 * against a server that is refusing us turns one problem into two, and the
 * failure is already on the row where a person can see it.
 *
 * ─── AND WHY IT NEVER GIVES UP ───────────────────────────────────────────────
 * There is no attempt limit and no "dead" state. A suspension that never lands
 * means a customer's website is still serving after their money went back, so
 * abandoning the attempt would leave that true forever with nothing still trying.
 * The interval flattens out at a day and stays there.
 */

/**
 * Minutes to wait, indexed by how many attempts have now been made. Past the end
 * of the list the last value repeats — see `suspendRetryDelayMinutes`.
 *
 * 15m → 1h → 4h → daily.
 */
export const SUSPEND_BACKOFF_MINUTES = [15, 60, 240, 1440] as const;

/**
 * How long to wait after `attempts` failed attempts.
 *
 * `attempts` is the count AFTER incrementing, so the first failure passes 1.
 * Anything at or past the end of the table gets the final (daily) interval.
 */
export function suspendRetryDelayMinutes(attempts: number): number {
  /* Defensive on both ends. A negative or zero count should not reach here, and
     if it does the answer that cannot cause harm is the SHORTEST wait, not an
     `undefined` that becomes `NaN` milliseconds and a date of "Invalid Date" —
     which Postgres rejects, so the row would keep its old due date and the item
     would be retried in a tight loop. */
  const i = Math.min(Math.max(Math.floor(attempts) - 1, 0), SUSPEND_BACKOFF_MINUTES.length - 1);
  return SUSPEND_BACKOFF_MINUTES[i];
}

/** The timestamp to store in `hosting_accounts.next_action_at`. */
export function nextSuspendAttemptAt(attempts: number, now: Date): string {
  return new Date(now.getTime() + suspendRetryDelayMinutes(attempts) * 60_000).toISOString();
}
