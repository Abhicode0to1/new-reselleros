/**
 * Reading a gateway event as a recurring-debit attempt.
 *
 * The companion to `mandate.ts`. That file decides what an event does to the
 * standing PERMISSION; this one decides what it says about a single DEBIT.
 *
 * Ported (adapted) from the DMS engine's `RecurringChargeAttempt` on 10 Sep 2026
 * — see the migration header for why the retry half was left out: Razorpay owns
 * the retry schedule on the Subscriptions flow, and a scheduler of ours would be
 * a guess about somebody else's.
 *
 * ─── WHY THE MAPPING IS DATA ─────────────────────────────────────────────────
 * Same reasoning as `GATEWAY_TRANSITIONS` in mandate.ts: written as a table so
 * the webhook cannot invent an outcome, and so an outcome this app records always
 * corresponds to something Razorpay actually said. An unmapped event records
 * NOTHING rather than a guess — `subscription.activated` is not a debit and a row
 * claiming it succeeded would overstate collections.
 */

/** What the gateway said happened to one debit. */
export type ChargeOutcome = "succeeded" | "failed" | "pending_retry" | "halted";

/**
 * Event → outcome. The four events that are about money moving, or failing to.
 *
 * `subscription.pending` is Razorpay telling us it is retrying on its own
 * schedule; `subscription.halted` is Razorpay telling us it has stopped. Both
 * map the mandate to `paused` (mandate.ts) — the difference between "watch this"
 * and "nothing will ever collect again" lives here.
 */
export const CHARGE_EVENTS: Record<string, ChargeOutcome> = {
  "subscription.charged": "succeeded",
  "payment.failed":       "failed",
  "subscription.pending": "pending_retry",
  "subscription.halted":  "halted",
};

export function chargeOutcomeFor(event: string): ChargeOutcome | null {
  return CHARGE_EVENTS[event] ?? null;
}

/**
 * Is this outcome one an operator has to do something about?
 *
 * `pending_retry` is deliberately NOT urgent: Razorpay is still trying and most
 * of those collect on the second attempt. Treating every retry as an incident
 * trains people to ignore the list, and then `halted` gets ignored too.
 */
export function needsAttention(outcome: ChargeOutcome): boolean {
  return outcome === "failed" || outcome === "halted";
}

export interface RazorpayPaymentEntity {
  id?: string;
  order_id?: string;
  amount?: number;
  error_code?: string | null;
  error_description?: string | null;
  created_at?: number;
  notes?: Record<string, string> | null;
}

export interface RazorpaySubscriptionEntity {
  id?: string;
  current_start?: number;
  charge_at?: number;
  notes?: Record<string, string> | null;
}

export interface ChargeAttemptFacts {
  outcome: ChargeOutcome;
  gatewayPaymentId: string | null;
  gatewayOrderId: string | null;
  gatewaySubscriptionId: string | null;
  /** ₹ WHOLE RUPEES, or null when the event carried no amount. */
  amount: number | null;
  errorCode: string | null;
  errorDescription: string | null;
  /** The gateway's own timestamp. Falls back to `now` when it sent none. */
  occurredAt: Date;
}

/**
 * Razorpay amounts are in PAISE. This app stores whole rupees (AGENTS.md), and
 * the conversion is the single most expensive line in any payments integration
 * to get wrong — a factor of 100 in either direction.
 *
 * Rounds rather than truncates: a ₹499.50 debit is ₹500 of money that moved, and
 * flooring it would quietly under-report collections. Returns null for an absent
 * amount rather than 0, because "no amount in the event" and "a zero-rupee
 * debit" are different claims.
 */
export function paiseToRupees(paise: number | null | undefined): number | null {
  if (paise === null || paise === undefined) return null;
  if (typeof paise !== "number" || !Number.isFinite(paise) || paise < 0) return null;
  return Math.round(paise / 100);
}

/**
 * Everything worth recording about one attempt, pulled out of the event.
 *
 * Pure, and takes the entities rather than the whole webhook body, so the whole
 * shape can be tested without a signature or a server.
 */
export function readChargeAttempt(
  event: string,
  payload: { payment?: RazorpayPaymentEntity; subscription?: RazorpaySubscriptionEntity },
  now: Date = new Date(),
): ChargeAttemptFacts | null {
  const outcome = chargeOutcomeFor(event);
  if (!outcome) return null;

  const p = payload.payment;
  const s = payload.subscription;

  /* Razorpay's `created_at` is UNIX SECONDS, not milliseconds. Multiplying is not
     optional: read as ms it lands in January 1970, and a failure chart keyed on
     it would put every decline off the left edge. */
  const stamp = p?.created_at ?? s?.current_start;
  const occurredAt =
    typeof stamp === "number" && Number.isFinite(stamp) && stamp > 0
      ? new Date(stamp * 1000)
      : now;

  return {
    outcome,
    gatewayPaymentId: p?.id?.trim() || null,
    gatewayOrderId: p?.order_id?.trim() || null,
    /* A payment.failed for a subscription debit carries the subscription id in
       notes; a subscription.* event has it as the entity id. */
    gatewaySubscriptionId:
      s?.id?.trim() ||
      p?.notes?.subscription_id?.trim() ||
      p?.notes?.subscriptionId?.trim() ||
      null,
    amount: paiseToRupees(p?.amount),
    errorCode: p?.error_code?.trim() || null,
    errorDescription: p?.error_description?.trim() || null,
    occurredAt,
  };
}

/**
 * How bad is it, for one subscription's recent history?
 *
 * Ordered newest-first by the caller. Returns the count of CONSECUTIVE failures
 * at the head — the number a person actually wants ("failing for a month" vs
 * "declined once last Tuesday") — and whether the gateway has given up.
 *
 * A success anywhere stops the count, because a subscription that failed twice
 * and then collected is not in trouble.
 */
export function chargeHealth(
  attempts: ReadonlyArray<{ outcome: ChargeOutcome }>,
): { consecutiveFailures: number; halted: boolean } {
  let consecutiveFailures = 0;
  let halted = false;

  for (const a of attempts) {
    if (a.outcome === "halted") {
      halted = true;
      /* Not a break: a halt is preceded by the declines that caused it, and the
         count of those is the useful number. */
      continue;
    }
    if (a.outcome === "failed") {
      consecutiveFailures += 1;
      continue;
    }
    if (a.outcome === "succeeded") break;
    /* pending_retry neither breaks the run nor counts as a failure — it is the
       same attempt still in flight. */
  }
  return { consecutiveFailures, halted };
}
