/**
 * Whether a paid quote may activate seats by itself.
 *
 * Pure, and it says NO for two reasons that are both facts about this deployment rather than
 * caution in general. Both were measured on 25 Aug 2026.
 *
 * ─── REASON ONE: THE PAYMENT MAY NOT BE MONEY ───────────────────────────────
 * `tenant_secrets.razorpay_key_id` on production starts `rzp_test_`. A test-mode payment
 * behaves exactly like a real one from the code's point of view: the customer completes a
 * checkout, Razorpay fires `payment.captured`, the webhook verifies the signature, and the
 * amount matches the quote. Nothing distinguishes it except the key prefix — and it settles
 * ZERO RUPEES.
 *
 * "Auto-provision on payment received" therefore means, today: anybody who reaches a test
 * checkout gets seats activated for free, automatically, in seconds, with no human in the loop
 * to notice. That is not a risk to be weighed against convenience; it is the feature working
 * exactly as specified and giving the product away.
 *
 * So the key prefix is a HARD gate. Not a dial, not a config, not overridable — `mode: "test"`
 * can never reach `activate`. The dial gates whether we may act unattended; this gates whether
 * the thing we would be acting on is real.
 *
 * ─── REASON TWO: THERE IS NOTHING TO CALL ───────────────────────────────────
 * `src/lib/google-csp/` does not exist. The Google Workspace Reseller API needs an approved
 * reseller agreement and OAuth credentials, and the setup wizard's own step 4 describes it as
 * "preview of the 5–7 day application" — the application has not been made. "Seats activate ho
 * jayengi 5 seconds mein" has no endpoint behind it.
 *
 * What this module does instead is QUEUE the activation with everything needed to perform it,
 * so that the day CSP access exists it is one adapter away — and meanwhile the desk sees "paid,
 * awaiting activation" instead of the nothing it sees today. A queue that a person drains is
 * not the feature that was asked for; it is the honest version of it, and it is strictly better
 * than the current state where a paid quote produces no activation signal at all.
 */

export type ProvisioningVendor = "google" | "microsoft" | "zoho" | "other";

export type ProvisioningOutcome =
  /** Everything is real and wired — go. Cannot be reached today; see the header. */
  | { action: "activate"; reason: string }
  /** Write the request and leave it for a person. */
  | { action: "queue"; reason: string; blocker: ProvisioningBlocker }
  /** Do not even queue — the payment is not something to act on. */
  | { action: "refuse"; reason: string };

export type ProvisioningBlocker =
  | "test_mode_payment"
  | "vendor_api_not_configured"
  | "dial_not_auto"
  | "vendor_unsupported";

export interface ProvisioningInput {
  /** From `razorpayMode(key_id)`. The HARD gate — see the header. */
  paymentMode: "live" | "test";
  /** True only when the webhook verified the signature AND the amount matched the quote. */
  paymentVerified: boolean;
  /** ₹ received, whole rupees. */
  amountPaid: number;
  /** ₹ the quote asked for, whole rupees. */
  amountExpected: number;
  vendor: ProvisioningVendor;
  seats: number;
  /** Does a reseller-API adapter exist and hold credentials for this vendor? */
  vendorApiConfigured: boolean;
  /** `provisioning.activate` resolved from the autonomy dial. */
  dialMode: "off" | "hold" | "auto";
}

/**
 * How much less than the quote we will still act on.
 *
 * Zero. A part payment is a conversation, not an activation: seats handed over against half the
 * money are seats somebody has to claw back, and the customer has done nothing wrong. Written as
 * a named constant rather than a bare `!==` so the intent is not mistaken for an oversight.
 */
export const UNDERPAYMENT_TOLERANCE = 0;

export function decideProvisioning(input: ProvisioningInput): ProvisioningOutcome {
  if (!input.paymentVerified) {
    return {
      action: "refuse",
      reason: "the payment was not verified — nothing is provisioned on an unverified event",
    };
  }

  if (input.seats <= 0 || !Number.isInteger(input.seats)) {
    return { action: "refuse", reason: `${input.seats} is not a seat count that can be activated` };
  }

  const shortfall = input.amountExpected - input.amountPaid;
  if (shortfall > UNDERPAYMENT_TOLERANCE) {
    /* Refuse rather than queue: a queued request implies "activate this once you can", and a
       part-paid quote should not be activated later either. It needs a person and a
       conversation. */
    return {
      action: "refuse",
      reason:
        `Rs ${shortfall.toLocaleString("en-IN")} short of the quoted amount — a part payment is ` +
        "a conversation, not an activation",
    };
  }

  /* ── THE HARD GATE ──────────────────────────────────────────────────────────
     Checked before the dial, and not overridable by it. The dial answers "may we act
     unattended"; this answers "is there anything real to act on". A test-mode payment settles
     nothing, so activating against it gives the product away — and it looks identical to a real
     payment everywhere except the key prefix. */
  if (input.paymentMode === "test") {
    return {
      action: "queue",
      blocker: "test_mode_payment",
      reason:
        "this payment came through a TEST-mode Razorpay key, so no money settled — the seats " +
        "are queued and will not be activated automatically at any dial setting. Switch to live " +
        "keys in Settings → Integrations before this can complete on its own.",
    };
  }

  if (input.vendor !== "google") {
    /* Microsoft and Zoho have their own partner APIs and their own agreements. Naming the
       limitation beats a generic failure that reads like a bug. */
    return {
      action: "queue",
      blocker: "vendor_unsupported",
      reason: `${input.vendor} seats are activated in the vendor's own console — no reseller API is wired for it`,
    };
  }

  if (!input.vendorApiConfigured) {
    return {
      action: "queue",
      blocker: "vendor_api_not_configured",
      reason:
        "the Google Workspace Reseller API is not connected — the reseller agreement and OAuth " +
        "credentials are a 5–7 day application that has not been made. The activation is queued " +
        "with everything it needs.",
    };
  }

  if (input.dialMode !== "auto") {
    return {
      action: "queue",
      blocker: "dial_not_auto",
      reason: `provisioning is set to "${input.dialMode}" for this workspace — queued for a person to release`,
    };
  }

  return {
    action: "activate",
    reason: `payment verified in live mode, ${input.seats} seats, reseller API connected`,
  };
}

/**
 * The line the desk reads on a queued activation.
 *
 * Says what was paid, what is waiting, and what is blocking it — in that order, because the
 * operator's first question is "has the money arrived" and their second is "what do I do".
 */
export function queuedLine(input: {
  customerName: string;
  seats: number;
  amountPaid: number;
  outcome: Extract<ProvisioningOutcome, { action: "queue" }>;
}): string {
  return (
    `${input.customerName || "A customer"} paid Rs ${input.amountPaid.toLocaleString("en-IN")} — ` +
    `${input.seats} seat${input.seats === 1 ? "" : "s"} waiting to be activated. ` +
    input.outcome.reason
  );
}
