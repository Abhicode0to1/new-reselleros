import { describe, it, expect } from "vitest";
import {
  chargeOutcomeFor,
  needsAttention,
  paiseToRupees,
  readChargeAttempt,
  chargeHealth,
  CHARGE_EVENTS,
} from "./charge-attempts";

/**
 * The failure being guarded against: autopay stops collecting and the customer
 * keeps the service. Nothing errors on our side — the debit is simply declined —
 * so the first anyone notices is an unpaid renewal everybody assumed was
 * automatic.
 *
 * Before this, `payment.failed` was ignored outright while the webhook's own
 * header claimed "log so Pardeep can follow up".
 */

const NOW = new Date("2026-09-10T12:00:00Z");

describe("only events that are about a debit are recorded", () => {
  it("maps the four money events", () => {
    expect(chargeOutcomeFor("subscription.charged")).toBe("succeeded");
    expect(chargeOutcomeFor("payment.failed")).toBe("failed");
    expect(chargeOutcomeFor("subscription.pending")).toBe("pending_retry");
    expect(chargeOutcomeFor("subscription.halted")).toBe("halted");
  });

  it("records NOTHING for an event that is not a debit", () => {
    /* `subscription.activated` is permission, not money. A row claiming it
       succeeded would overstate collections. */
    for (const e of ["subscription.activated", "subscription.authenticated",
                     "subscription.cancelled", "payment.captured", "order.paid", "", "nonsense"]) {
      expect(chargeOutcomeFor(e), e).toBeNull();
      expect(readChargeAttempt(e, { payment: { id: "pay_1" } }, NOW), e).toBeNull();
    }
  });

  it("keeps halted apart from failed, because they need different actions", () => {
    /* One is a decline to watch. The other means nothing will EVER collect until
       the customer authorises a new mandate. mandate.ts maps both to `paused`,
       which is why the distinction has to live here. */
    expect(CHARGE_EVENTS["subscription.halted"]).not.toBe(CHARGE_EVENTS["payment.failed"]);
  });
});

describe("needsAttention", () => {
  it("flags a decline and a halt", () => {
    expect(needsAttention("failed")).toBe(true);
    expect(needsAttention("halted")).toBe(true);
  });

  it("does NOT flag a retry in flight", () => {
    /* Most of those collect on the second attempt. Treating every retry as an
       incident trains people to ignore the list — and then the halts get ignored
       too, which is the one that actually costs money. */
    expect(needsAttention("pending_retry")).toBe(false);
    expect(needsAttention("succeeded")).toBe(false);
  });
});

describe("paiseToRupees — the factor-of-100 line", () => {
  it("converts", () => {
    expect(paiseToRupees(120000)).toBe(1200);
    expect(paiseToRupees(0)).toBe(0);
  });

  it("rounds rather than truncating", () => {
    /* ₹499.50 is ₹500 of money that moved; flooring quietly under-reports. */
    expect(paiseToRupees(49950)).toBe(500);
    expect(paiseToRupees(49949)).toBe(499);
  });

  it("returns null for an absent amount, not 0", () => {
    /* "The event carried no amount" and "a zero-rupee debit" are different
       claims, and a halted subscription genuinely carries none. */
    expect(paiseToRupees(null)).toBeNull();
    expect(paiseToRupees(undefined)).toBeNull();
    expect(paiseToRupees(NaN)).toBeNull();
    expect(paiseToRupees(-100)).toBeNull();
    expect(paiseToRupees("120000" as unknown as number)).toBeNull();
  });
});

describe("readChargeAttempt", () => {
  it("reads a failed subscription debit", () => {
    const got = readChargeAttempt("payment.failed", {
      payment: {
        id: "pay_abc",
        order_id: "order_xyz",
        amount: 120000,
        error_code: "BAD_REQUEST_ERROR",
        error_description: "Your card has insufficient funds",
        created_at: 1788955200, // 2026-09-09T12:00:00Z — deliberately NOT `NOW`
        notes: { subscription_id: "sub_123" },
      },
    }, NOW);

    expect(got).toEqual({
      outcome: "failed",
      gatewayPaymentId: "pay_abc",
      gatewayOrderId: "order_xyz",
      gatewaySubscriptionId: "sub_123",
      amount: 1200,
      errorCode: "BAD_REQUEST_ERROR",
      errorDescription: "Your card has insufficient funds",
      occurredAt: new Date("2026-09-09T12:00:00Z"),
    });
  });

  it("treats the gateway timestamp as SECONDS, not milliseconds", () => {
    /* Read as ms it lands in Jan 1970 and every decline falls off the left edge
       of any chart keyed on it.

       The value is a day before `NOW` on purpose. The first version of this test
       used 1789041600, which IS `NOW` to the second — so it passed whether the
       gateway stamp was used or the fallback fired, and proved neither. */
    const got = readChargeAttempt("payment.failed", { payment: { id: "p", created_at: 1788955200 } }, NOW);
    expect(got!.occurredAt.toISOString()).toBe("2026-09-09T12:00:00.000Z");
    expect(got!.occurredAt).not.toEqual(NOW);
  });

  it("falls back to now when the gateway sent no timestamp", () => {
    const got = readChargeAttempt("subscription.halted", { subscription: { id: "sub_1" } }, NOW);
    expect(got!.occurredAt).toEqual(NOW);
  });

  it("ignores a nonsense timestamp rather than dating a row to 1970", () => {
    for (const created_at of [0, -5, NaN]) {
      const got = readChargeAttempt("payment.failed", { payment: { id: "p", created_at } }, NOW);
      expect(got!.occurredAt, String(created_at)).toEqual(NOW);
    }
  });

  it("finds the subscription id in either shape", () => {
    /* A subscription.* event has it as the entity id; a payment.failed for a
       subscription debit carries it in notes, and the casing varies. */
    expect(readChargeAttempt("subscription.halted", { subscription: { id: "sub_A" } }, NOW)!.gatewaySubscriptionId).toBe("sub_A");
    expect(readChargeAttempt("payment.failed", { payment: { id: "p", notes: { subscriptionId: "sub_B" } } }, NOW)!.gatewaySubscriptionId).toBe("sub_B");
  });

  it("reports absent fields as null rather than empty strings", () => {
    const got = readChargeAttempt("subscription.halted", { subscription: { id: "sub_1" } }, NOW)!;
    expect(got.gatewayPaymentId).toBeNull();
    expect(got.amount).toBeNull();
    expect(got.errorCode).toBeNull();
  });

  it("survives an event with no entities at all", () => {
    const got = readChargeAttempt("subscription.halted", {}, NOW)!;
    expect(got.outcome).toBe("halted");
    expect(got.gatewaySubscriptionId).toBeNull();
  });
});

describe("chargeHealth — 'declined once' vs 'failing for a month'", () => {
  const a = (outcome: "succeeded" | "failed" | "pending_retry" | "halted") => ({ outcome });

  it("counts the consecutive failures at the head", () => {
    expect(chargeHealth([a("failed"), a("failed"), a("failed")])).toEqual({
      consecutiveFailures: 3,
      halted: false,
    });
  });

  it("STOPS counting at a success — a sub that recovered is not in trouble", () => {
    expect(chargeHealth([a("failed"), a("succeeded"), a("failed"), a("failed")])).toEqual({
      consecutiveFailures: 1,
      halted: false,
    });
  });

  it("does not count a retry in flight as a failure, and does not let it break the run", () => {
    /* pending_retry is the same attempt still going, so it is neither. */
    expect(chargeHealth([a("pending_retry"), a("failed"), a("failed")])).toEqual({
      consecutiveFailures: 2,
      halted: false,
    });
  });

  it("reports a halt AND the declines that caused it", () => {
    /* The halt is the actionable fact; the count is what makes the email
       readable ("after 4 failed attempts"). */
    expect(chargeHealth([a("halted"), a("failed"), a("failed"), a("failed"), a("failed")])).toEqual({
      consecutiveFailures: 4,
      halted: true,
    });
  });

  it("says nothing is wrong for a healthy history, or no history", () => {
    expect(chargeHealth([a("succeeded"), a("succeeded")])).toEqual({ consecutiveFailures: 0, halted: false });
    expect(chargeHealth([])).toEqual({ consecutiveFailures: 0, halted: false });
  });
});
