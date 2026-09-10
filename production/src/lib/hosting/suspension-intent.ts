/**
 * Which way does DirectAdmin need moving to match our record?
 *
 * ─── WHY THIS IS A FUNCTION AND NOT AN `if` IN THE CRON ─────────────────────
 * Because getting it backwards suspends every live website this reseller has.
 *
 * The cron reads rows with a due `next_action_at` and decides, from the row's
 * status, whether to call `daSuspendAccount` or `daUnsuspendAccount`. Those are
 * opposite actions on somebody's live hosting, chosen by one comparison. If that
 * comparison inverted — a `!==` for an `===`, a swapped pair of branches — the
 * job would take down every `active` account whose `next_action_at` happened to
 * be set, and the failure would look like a mass outage with no error anywhere.
 *
 * So the decision is one pure function with its own tests, and the cron only
 * dispatches on the answer. Same split as `lib/domains/lifecycle.ts` beside
 * `asset-sweep`, and for a sharper reason.
 *
 * ─── `next_action_at` MEANS "THE SERVER HAS NOT BEEN TOLD" ──────────────────
 * Both directions use the same column, and clearing it is what marks the work
 * done. `refund_payment` stamps it when it suspends; the restore route stamps it
 * when it un-suspends. A null means our record and the server agree, which is
 * why the queue query and "is there anything to do" are the same question.
 */

/** The statuses a hosting row can hold. */
export type HostingSuspensionStatus =
  | "pending"
  | "active"
  | "suspended"
  | "expired"
  | "terminated"
  | "failed";

export type ServerIntent =
  /** Tell DirectAdmin to suspend. */
  | { action: "suspend" }
  /** Tell DirectAdmin to un-suspend. */
  | { action: "restore" }
  /**
   * Nothing to send. `reason` is for the run's report, so an operator reading
   * "17 rows, 0 sent" can see why rather than assuming the job is broken.
   */
  | { action: "none"; reason: string };

export function serverIntentFor(row: {
  status: HostingSuspensionStatus;
  /** ISO, or null when our record and the server already agree. */
  nextActionAt: string | null;
  daUsername: string | null;
  /** Soft-deleted rows are not touched at all. */
  deletedAt?: string | null;
  now: Date;
}): ServerIntent {
  if (row.deletedAt) {
    return { action: "none", reason: "the row is deleted" };
  }
  if (!row.nextActionAt) {
    return { action: "none", reason: "nothing queued — our record and the server agree" };
  }
  if (new Date(row.nextActionAt).getTime() > row.now.getTime()) {
    return { action: "none", reason: "not due yet" };
  }
  /* No username means provisioning never created an account, so there is nothing
     on the server to move in either direction. The caller clears the date on this
     one — no amount of retrying finds an account that does not exist. */
  if (!row.daUsername) {
    return { action: "none", reason: "no DirectAdmin username — nothing on the server to move" };
  }

  /* The only two statuses that describe a server state we can act on.
     Written as an explicit allow-list rather than `status === "suspended" ?
     suspend : restore`, because that shape sends RESTORE for `terminated`,
     `expired`, `failed` and `pending` — un-suspending an account that should be
     off, or that does not exist. */
  if (row.status === "suspended") return { action: "suspend" };
  if (row.status === "active") return { action: "restore" };

  return {
    action: "none",
    reason: `status is ${row.status}, which is not a state DirectAdmin can be moved to from here`,
  };
}
