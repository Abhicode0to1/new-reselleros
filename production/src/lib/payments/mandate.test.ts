import { describe, it, expect } from "vitest";
import {
  canCollect, planMandate, mandateHeadroom, applyGatewayEvent, mandateBadge,
  GATEWAY_TRANSITIONS, MAX_MANDATE_AMOUNT, MANDATE_HEADROOM_MULTIPLIER,
  type MandateStatus,
} from "./mandate";

describe("active is reachable ONLY from a gateway event", () => {
  it("every transition into 'active' comes from a Razorpay event", () => {
    /* If the app could mark a mandate active, a reseller would stop chasing a
       renewal that is never going to collect. */
    const intoActive = Object.entries(GATEWAY_TRANSITIONS).filter(([, s]) => s === "active");
    expect(intoActive.length).toBeGreaterThan(0);
    for (const [event] of intoActive) expect(event).toMatch(/^subscription\./);
  });

  it("planMandate never returns a state — it only asks for an amount", () => {
    /* The app's job is to request; the gateway's job is to confirm. */
    const g = planMandate({ current: "none", cycleAmount: 2_360 });
    expect(g.allowed).toBe(true);
    expect(Object.keys(g)).not.toContain("status");
  });
});

describe("canCollect", () => {
  it("only an active mandate can collect", () => {
    for (const status of ["none", "pending_authorisation", "paused", "cancelled", "expired"] as MandateStatus[]) {
      expect(canCollect({ status, maxAmount: 5_000, today: "2026-08-17" }), status).toBe(false);
    }
    expect(canCollect({ status: "active", maxAmount: 5_000, today: "2026-08-17" })).toBe(true);
  });

  it("an active mandate past its end date cannot collect", () => {
    expect(canCollect({ status: "active", maxAmount: 5_000, endDate: "2026-08-16", today: "2026-08-17" })).toBe(false);
    expect(canCollect({ status: "active", maxAmount: 5_000, endDate: "2026-08-17", today: "2026-08-17" })).toBe(true);
  });

  it("an open-ended mandate has no expiry to fail", () => {
    expect(canCollect({ status: "active", maxAmount: 5_000, endDate: null, today: "2026-08-17" })).toBe(true);
  });
});

describe("planMandate — the amount requested has headroom", () => {
  it("asks for more than today's bill so ordinary growth does not break it", () => {
    /* A mandate's cap cannot be raised. Requesting exactly today's amount means the
       first seat addition silently stops collection. */
    const g = planMandate({ current: "none", cycleAmount: 2_360 });
    expect(g).toEqual({ allowed: true, requestAmount: 2_360 * MANDATE_HEADROOM_MULTIPLIER });
  });

  it("never requests above the per-debit ceiling, even with headroom", () => {
    const g = planMandate({ current: "none", cycleAmount: 12_000 });
    expect(g.allowed).toBe(true);
    if (g.allowed) expect(g.requestAmount).toBe(MAX_MANDATE_AMOUNT);
  });

  it("REFUSES before sending the customer to approve something the gateway will reject", () => {
    /* Being turned away at a bank's approval screen is a far worse experience than
       being told here. */
    const g = planMandate({ current: "none", cycleAmount: 20_000 });
    expect(g.allowed).toBe(false);
    if (!g.allowed) {
      expect(g.reason).toMatch(/above the ₹15,000 per-debit limit/);
      expect(g.nextStep).toMatch(/UPI or bank transfer/);
    }
  });

  it("tells the CUSTOMER to pay, not to collect", () => {
    /* Both callers are customer-facing — /api/portal/mandate and the portal's autopay
       card. "Collect this one by UPI" is the reseller's side of the transaction, and
       reads as nonsense to the person who owes the money. */
    const g = planMandate({ current: "none", cycleAmount: 28_320 });
    expect(g.allowed).toBe(false);
    if (!g.allowed) expect(g.nextStep.toLowerCase()).not.toContain("collect");
  });

  it("refuses when autopay is already on, or already waiting", () => {
    expect(planMandate({ current: "active", cycleAmount: 2_360 }).allowed).toBe(false);
    expect(planMandate({ current: "pending_authorisation", cycleAmount: 2_360 }).allowed).toBe(false);
  });

  it("refuses a zero or nonsense amount rather than requesting a ₹0 mandate", () => {
    for (const cycleAmount of [0, -100, NaN]) {
      const g = planMandate({ current: "none", cycleAmount });
      expect(g.allowed).toBe(false);
    }
  });

  it("allows a retry after a cancelled or paused mandate", () => {
    expect(planMandate({ current: "cancelled", cycleAmount: 2_360 }).allowed).toBe(true);
    expect(planMandate({ current: "paused", cycleAmount: 2_360 }).allowed).toBe(true);
  });

  it("every refusal names what to do instead", () => {
    for (const current of ["active", "pending_authorisation"] as MandateStatus[]) {
      const g = planMandate({ current, cycleAmount: 2_360 });
      if (!g.allowed) expect(g.nextStep.length).toBeGreaterThan(15);
    }
  });
});

describe("mandateHeadroom — the check that stops autopay failing silently", () => {
  it("warns BEFORE a debit that would be declined", () => {
    const h = mandateHeadroom({ maxAmount: 5_000, nextDebit: 6_200 });
    expect(h.willFail).toBe(true);
    expect(h.remaining).toBe(-1_200);
    expect(h.message).toMatch(/cannot be raised/);
    expect(h.message).toMatch(/approve a new one/);
  });

  it("flags a tight mandate before one more seat breaks it", () => {
    /* Chosen so a subscription does not go from "fine" to "declined" with no
       warning in between. */
    const h = mandateHeadroom({ maxAmount: 5_000, nextDebit: 4_200 });
    expect(h.willFail).toBe(false);
    expect(h.tight).toBe(true);
    expect(h.message).toMatch(/likely to break it/);
  });

  it("is quiet when there is real room", () => {
    const h = mandateHeadroom({ maxAmount: 5_000, nextDebit: 2_360 });
    expect(h).toMatchObject({ willFail: false, tight: false, remaining: 2_640 });
  });

  it("says nothing to check when no mandate amount is recorded", () => {
    const h = mandateHeadroom({ maxAmount: null, nextDebit: 2_360 });
    expect(h.willFail).toBe(false);
    expect(h.message).toMatch(/nothing to check against/);
  });

  it("treats an exact fit as fitting", () => {
    expect(mandateHeadroom({ maxAmount: 5_000, nextDebit: 5_000 }).willFail).toBe(false);
  });
});

describe("applyGatewayEvent", () => {
  it.each([
    ["subscription.authenticated", "active"],
    ["subscription.activated",     "active"],
    ["subscription.halted",        "paused"],
    ["subscription.cancelled",     "cancelled"],
    ["subscription.completed",     "expired"],
  ] as const)("%s moves a pending mandate to %s", (event, expected) => {
    expect(applyGatewayEvent("pending_authorisation", event)).toBe(expected);
  });

  it("ignores an event it does not know", () => {
    expect(applyGatewayEvent("active", "payment.captured")).toBeNull();
    expect(applyGatewayEvent("active", "something.new")).toBeNull();
  });

  it("does NOT resurrect a cancelled mandate from a late event", () => {
    /* Webhooks arrive out of order. A `subscription.charged` landing after a
       cancellation must not turn permission back on. */
    expect(applyGatewayEvent("cancelled", "subscription.charged")).toBeNull();
    expect(applyGatewayEvent("cancelled", "subscription.authenticated")).toBeNull();
    expect(applyGatewayEvent("expired", "subscription.activated")).toBeNull();
  });

  it("returns null for a no-op so a duplicate webhook writes nothing", () => {
    expect(applyGatewayEvent("active", "subscription.charged")).toBeNull();
  });

  it("can move an active mandate to paused — that is the gateway stopping it", () => {
    expect(applyGatewayEvent("active", "subscription.halted")).toBe("paused");
  });
});

describe("mandateBadge", () => {
  it("puts TEST MODE on the badge, not in a tooltip", () => {
    /* A reseller looking at "Autopay active" has to be able to tell at a glance
       whether real money will move. */
    expect(mandateBadge("active", true).label).toBe("Autopay on (test)");
    expect(mandateBadge("active", false).label).toBe("Autopay on");
  });

  it("does not label non-active states as test — nothing is collecting either way", () => {
    expect(mandateBadge("pending_authorisation", true).label).not.toMatch(/test/);
  });

  it("colours a stopped mandate as a problem, not as neutral", () => {
    expect(mandateBadge("paused", false).kind).toBe("danger");
    expect(mandateBadge("cancelled", false).kind).toBe("muted");
  });

  it("covers every status", () => {
    for (const s of ["none", "pending_authorisation", "active", "paused", "cancelled", "expired"] as MandateStatus[]) {
      expect(mandateBadge(s, false).label.length).toBeGreaterThan(0);
    }
  });
});
