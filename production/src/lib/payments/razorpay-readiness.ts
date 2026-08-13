/**
 * How ready is a tenant's Razorpay integration — and ready for WHAT.
 *
 * Razorpay is two independent halves, and the product treated them as one:
 *
 *   COLLECT     key_id + key_secret. Lets the checkout take the customer's money.
 *   RECONCILE   webhook_secret. Lets ResellerOS find out that it happened.
 *
 * The webhook route verifies every event against the tenant's webhook secret and
 * fails closed — correct, and the only safe choice, since that signature is the
 * sole thing standing between a real payment event and a forged one. But with the
 * first half configured and the second half missing, the two behaviours combine
 * into the worst possible outcome: the customer pays, Razorpay POSTs the event,
 * the route answers 401, and nothing in the app ever moves. The quote stays
 * "pending", the lead never reaches won, no tax invoice is raised, no receipt
 * voucher is issued, MRR does not move — while the money is sitting in the
 * Razorpay settlement account. Nobody finds out until someone reconciles by hand.
 *
 * Production has exactly this state today: tenant fbb976f1 has key_id and
 * key_secret set, razorpay_webhook_secret null, and not one of the 37 recorded
 * payments was created by the webhook — every "razorpay" payment was typed in by
 * hand. The integration has never once worked end to end.
 *
 * It stayed invisible because `configured` was defined as
 * `Boolean(key_id && key_secret)` and the Settings card rendered that as
 * "Accepting payments". Which was true, and was the wrong thing to measure.
 *
 * So readiness is deliberately not a boolean here. Half-configured is its own
 * state with its own name, and it is the state that loses money.
 */

export type RazorpayState =
  /** No credentials — the buy page runs in simulation, nothing is at risk. */
  | "not_configured"
  /** Can take money, cannot hear about it. The dangerous one. */
  | "collect_only"
  /** Both halves present. */
  | "ready";

export interface RazorpayReadiness {
  state: RazorpayState;
  /** Checkout can charge a customer. */
  canCollect: boolean;
  /** Payments flow back into quotes, leads, invoices and MRR by themselves. */
  canReconcile: boolean;
  /** Whether this state needs to interrupt the operator. */
  severity: "none" | "info" | "critical";
  /** One line, plain language, no jargon — shown on the integration card. */
  headline: string;
  /** What will actually happen, and what to do. Null when nothing is wrong. */
  detail: string | null;
}

export interface RazorpaySecrets {
  keyId?: string | null;
  keySecret?: string | null;
  webhookSecret?: string | null;
}

const has = (v?: string | null) => typeof v === "string" && v.trim().length > 0;

export function razorpayReadiness(s: RazorpaySecrets): RazorpayReadiness {
  const canCollect   = has(s.keyId) && has(s.keySecret);
  const canReconcile = canCollect && has(s.webhookSecret);

  if (!canCollect) {
    return {
      state: "not_configured", canCollect: false, canReconcile: false,
      severity: "info",
      headline: "Buy page in simulation mode",
      detail: null,   // Nothing is broken: no money can move either way.
    };
  }

  if (!canReconcile) {
    return {
      state: "collect_only", canCollect: true, canReconcile: false,
      severity: "critical",
      headline: "Taking payments — but not recording them",
      detail:
        "Customers can pay, but Razorpay's confirmation is rejected because the webhook " +
        "signing secret is missing. Every payment will have to be entered by hand, and " +
        "until you do, the quote stays unpaid, no tax invoice is raised and MRR does not " +
        "move. Add the webhook secret from Razorpay Dashboard → Settings → Webhooks.",
    };
  }

  return {
    state: "ready", canCollect: true, canReconcile: true,
    severity: "none",
    headline: "Accepting payments",
    detail: null,
  };
}

/**
 * Is this the live gateway or the test one? Razorpay encodes it in the key
 * prefix, so the key is the single source of truth — a stored `mode` column can
 * drift from the key it describes, and being wrong about this means either test
 * payments booked as revenue or real customers hitting a sandbox.
 */
export function razorpayMode(keyId?: string | null): "live" | "test" {
  return typeof keyId === "string" && keyId.startsWith("rzp_live_") ? "live" : "test";
}
