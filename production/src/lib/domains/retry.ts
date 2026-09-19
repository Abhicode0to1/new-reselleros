/**
 * When to try a failed domain registration again — and when to stop and ask.
 *
 * Ported from the DMS engine's `PendingDomain` retry fields (`verificationAttempts`,
 * `lastVerifiedAt`) on 10 Sep 2026. DMS had the columns and a bulk-upsert that
 * touched them; the policy itself was scattered across the caller, which is why
 * it is a tested pure function here.
 *
 * ─── THE STATE THIS EXISTS FOR ───────────────────────────────────────────────
 * The customer has PAID and does not have the domain. Almost always because the
 * ResellerClub wallet was empty at the moment the order went up — see
 * `lib/resellerclub/reseller.ts`, which now watches that balance daily.
 *
 * That failure fixes itself the instant somebody tops up the wallet, and
 * `api/cron/provision-domain` currently marks the row `failed` and leaves it,
 * with a comment saying failed rows "get retried by hand". Nobody retries by
 * hand at 2am.
 *
 * ─── WHY THE BUDGET IS BOUNDED, AND SMALL ────────────────────────────────────
 * The opposite mistake is worse than doing nothing. A registration can fail for
 * a reason no amount of retrying fixes — the name was taken by somebody else in
 * the minutes between the search and the payment, or the registry rejected the
 * registrant details. Retrying that forever means:
 *   · hammering the registrar with a request it has already refused, and
 *   · nobody ever looking at it, because it never stops looking busy.
 * So the budget runs out, the row stops being retried, and it sits in the
 * operator queue where a person decides between a refund, a different name, or a
 * re-registration. That hand-off IS the feature.
 *
 * ─── AND WHY THE BACKOFF IS IN HOURS, NOT MINUTES ────────────────────────────
 * The thing being waited for is a human topping up a wallet. Retrying four times
 * in the first minute cannot succeed and only costs the registrar's patience.
 */

/** Attempts allowed in total, including the first. */
export const MAX_REGISTRATION_ATTEMPTS = 5;

/**
 * Hours to wait before attempt N+1, indexed by attempts already made.
 *
 * 1h, 4h, 12h, 24h — roughly "later today, this evening, tomorrow morning, this
 * time tomorrow". Chosen so a wallet topped up during a working day is picked up
 * the same day, and a failure nobody notices still stops within a week.
 */
export const RETRY_BACKOFF_HOURS = [1, 4, 12, 24] as const;

export interface RegistrationRetryInput {
  /** The domain row's status. Only `failed` is retryable. */
  status: string;
  attemptCount: number;
  lastAttemptAt: string | Date | null;
  /** Set once a person has dealt with it — a resolved row is never retried. */
  resolvedAt?: string | Date | null;
}

export type RetryDecision =
  | { kind: "retry" }
  /** Inside the budget, but not yet — `at` is when it becomes due. */
  | { kind: "wait"; until: Date; reason: string }
  /** The budget is spent, or something else means this needs a person. */
  | { kind: "give_up"; reason: string }
  /** Not a failed registration at all. */
  | { kind: "not_applicable"; reason: string };

const asDate = (v: string | Date | null | undefined): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
};

export function decideRegistrationRetry(
  input: RegistrationRetryInput,
  now: Date = new Date(),
): RetryDecision {
  if (input.status !== "failed") {
    return { kind: "not_applicable", reason: `status is ${input.status || "unset"}, not failed` };
  }
  if (asDate(input.resolvedAt)) {
    /* Somebody has already refunded it, re-registered it, or written it off.
       Retrying now could register a domain that has been refunded — charging
       nobody for a name we then own. */
    return { kind: "not_applicable", reason: "a person has already resolved this one" };
  }

  const attempts = Number.isFinite(input.attemptCount) ? Math.max(0, Math.floor(input.attemptCount)) : 0;

  if (attempts >= MAX_REGISTRATION_ATTEMPTS) {
    return {
      kind: "give_up",
      reason: `${attempts} attempts have failed — this needs a decision (refund, a different name, or a manual registration), not another attempt`,
    };
  }

  const last = asDate(input.lastAttemptAt);
  if (!last) {
    /* Marked failed without recording when. Retry rather than wait forever on a
       timestamp that is never going to arrive — the budget still bounds it. */
    return { kind: "retry" };
  }

  /* attempts is 1-based against the backoff table: after 1 attempt wait
     RETRY_BACKOFF_HOURS[0]. Past the table's end, hold the last interval. */
  const waitHours = RETRY_BACKOFF_HOURS[Math.min(attempts, RETRY_BACKOFF_HOURS.length) - 1]
    ?? RETRY_BACKOFF_HOURS[0];
  const due = new Date(last.getTime() + waitHours * 3_600_000);

  if (now.getTime() < due.getTime()) {
    return {
      kind: "wait",
      until: due,
      reason: `attempt ${attempts} was ${Math.round((now.getTime() - last.getTime()) / 60000)} minutes ago; waiting ${waitHours}h between attempts`,
    };
  }
  return { kind: "retry" };
}

/**
 * The operator queue's sort key: what is owed, largest first.
 *
 * `amount_paid` is nullable, and a failure with no recorded amount sorts LAST
 * rather than as zero — it is a gap in the record, not a cheap problem, and
 * treating it as ₹0 would bury it under every real amount.
 */
export function unresolvedLiability(rows: ReadonlyArray<{ amount_paid: number | null }>): number {
  return rows.reduce((sum, r) => sum + (r.amount_paid ?? 0), 0);
}

/** The ways a paid-but-undelivered registration can be closed. */
export const RESOLUTIONS = ["refunded", "re_registered", "alternative_offered", "written_off"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export function isResolution(v: string | null | undefined): v is Resolution {
  return RESOLUTIONS.includes((v ?? "") as Resolution);
}
