import { describe, it, expect } from "vitest";
import { razorpayReadiness, razorpayMode } from "./razorpay-readiness";

const KEY = "rzp_live_ABCDEF123456";
const SEC = "supersecretvalue";
const WHS = "whsec_abcdef";

describe("razorpayReadiness", () => {
  it("no credentials → nothing at risk", () => {
    const r = razorpayReadiness({});
    expect(r.state).toBe("not_configured");
    expect(r.canCollect).toBe(false);
    expect(r.severity).toBe("info");
    expect(r.detail).toBeNull();
  });

  // The production state that motivated this file: tenant fbb976f1 has keys,
  // no webhook secret, and has never had a payment recorded by the webhook.
  it("keys but no webhook secret → CRITICAL, not 'accepting payments'", () => {
    const r = razorpayReadiness({ keyId: KEY, keySecret: SEC });
    expect(r.state).toBe("collect_only");
    expect(r.canCollect).toBe(true);
    expect(r.canReconcile).toBe(false);
    expect(r.severity).toBe("critical");
    expect(r.detail).toBeTruthy();
  });

  it("the half-configured headline never reads as healthy", () => {
    const r = razorpayReadiness({ keyId: KEY, keySecret: SEC });
    // The old copy was literally "Accepting payments" — reassuring and wrong.
    expect(r.headline).not.toMatch(/^Accepting payments$/);
    expect(r.headline.toLowerCase()).toContain("not recording");
  });

  it("both halves → ready", () => {
    const r = razorpayReadiness({ keyId: KEY, keySecret: SEC, webhookSecret: WHS });
    expect(r.state).toBe("ready");
    expect(r.canReconcile).toBe(true);
    expect(r.severity).toBe("none");
    expect(r.detail).toBeNull();
  });

  it("a webhook secret alone cannot make it look usable", () => {
    const r = razorpayReadiness({ webhookSecret: WHS });
    expect(r.state).toBe("not_configured");
    expect(r.canReconcile).toBe(false);
  });

  it("blank and whitespace-only secrets count as missing", () => {
    expect(razorpayReadiness({ keyId: KEY, keySecret: SEC, webhookSecret: "" }).state).toBe("collect_only");
    expect(razorpayReadiness({ keyId: KEY, keySecret: SEC, webhookSecret: "   " }).state).toBe("collect_only");
    expect(razorpayReadiness({ keyId: "  ", keySecret: SEC, webhookSecret: WHS }).state).toBe("not_configured");
  });

  it("canReconcile is never true without canCollect", () => {
    for (const s of [{}, { keyId: KEY }, { keySecret: SEC }, { webhookSecret: WHS }, { keyId: KEY, webhookSecret: WHS }]) {
      const r = razorpayReadiness(s);
      expect(r.canReconcile && !r.canCollect).toBe(false);
    }
  });
});

describe("razorpayMode", () => {
  it("reads live/test from the key prefix, the only source of truth", () => {
    expect(razorpayMode("rzp_live_abc")).toBe("live");
    expect(razorpayMode("rzp_test_abc")).toBe("test");
  });

  it("defaults to test when the key is missing or unrecognised", () => {
    // Wrong in this direction shows a TEST badge on a live gateway, which
    // prompts a check. The reverse would book sandbox money as revenue.
    expect(razorpayMode(null)).toBe("test");
    expect(razorpayMode(undefined)).toBe("test");
    expect(razorpayMode("something_else")).toBe("test");
  });
});
