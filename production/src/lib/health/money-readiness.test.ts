import { describe, it, expect } from "vitest";
import { moneyHealth, worstSeverity } from "./money-readiness";

/** Everything configured and working. */
const HEALTHY = {
  razorpayKeys: true, razorpayWebhookSecret: true, razorpayLive: true,
  emailConfigured: true, upiVpa: true, cronSecret: true,
};

describe("moneyHealth", () => {
  it("says nothing when everything is healthy", () => {
    // A checklist that always shows something is a checklist nobody reads.
    expect(moneyHealth(HEALTHY)).toEqual([]);
    expect(worstSeverity(moneyHealth(HEALTHY))).toBeNull();
  });

  it("stays silent about anything the caller could not determine", () => {
    // An empty snapshot means "we don't know", not "everything is broken" —
    // a failed query must never produce a screen full of false alarms.
    expect(moneyHealth({})).toEqual([]);
  });

  // ── The production state that motivated this module ──────────────────────
  it("flags Razorpay keys-without-webhook-secret as critical", () => {
    const f = moneyHealth({ ...HEALTHY, razorpayWebhookSecret: false });
    expect(f).toHaveLength(1);
    expect(f[0].id).toBe("razorpay-no-webhook-secret");
    expect(f[0].severity).toBe("critical");
  });

  it("says LIVE explicitly when real money is involved", () => {
    const live = moneyHealth({ ...HEALTHY, razorpayWebhookSecret: false, razorpayLive: true });
    const test = moneyHealth({ ...HEALTHY, razorpayWebhookSecret: false, razorpayLive: false });
    expect(live[0].title).toContain("LIVE");
    expect(test[0].title).not.toContain("LIVE");
  });

  it("does not flag a missing webhook secret when there are no keys at all", () => {
    // No keys means no money can move — nothing is at risk, so nothing to say.
    const f = moneyHealth({ razorpayKeys: false, razorpayWebhookSecret: false });
    expect(f.map((x) => x.id)).not.toContain("razorpay-no-webhook-secret");
  });

  it("flags stubbed email as critical, not cosmetic", () => {
    const f = moneyHealth({ ...HEALTHY, emailConfigured: false });
    expect(f[0].id).toBe("email-not-configured");
    expect(f[0].severity).toBe("critical");
    // The danger is that the app's own log agrees the customer was contacted.
    expect(f[0].consequence).toMatch(/recorded as sent/i);
  });

  it("flags a missing cron secret as automation being off", () => {
    const f = moneyHealth({ ...HEALTHY, cronSecret: false });
    expect(f[0].id).toBe("cron-secret-missing");
    expect(f[0].severity).toBe("critical");
  });

  it("keeps a missing UPI ID at warning — nothing breaks, it is just slower", () => {
    const f = moneyHealth({ ...HEALTHY, upiVpa: false });
    expect(f[0].id).toBe("upi-vpa-missing");
    expect(f[0].severity).toBe("warning");
  });

  it("reports every independent problem rather than only the first", () => {
    const f = moneyHealth({
      razorpayKeys: true, razorpayWebhookSecret: false,
      emailConfigured: false, cronSecret: false, upiVpa: false,
    });
    expect(f.map((x) => x.id).sort()).toEqual([
      "cron-secret-missing", "email-not-configured",
      "razorpay-no-webhook-secret", "upi-vpa-missing",
    ]);
  });

  it("every finding says what breaks and what to do about it", () => {
    const f = moneyHealth({
      razorpayKeys: true, razorpayWebhookSecret: false,
      emailConfigured: false, cronSecret: false, upiVpa: false,
    });
    for (const x of f) {
      expect(x.consequence.length).toBeGreaterThan(40);
      expect(x.fix.length).toBeGreaterThan(10);
      // Config-key names are facts nobody can act on; the title must be plain.
      expect(x.title).not.toMatch(/null|undefined|_secret\b/);
    }
  });

  it("gives every finding a distinct id", () => {
    const ids = moneyHealth({
      razorpayKeys: true, razorpayWebhookSecret: false,
      emailConfigured: false, cronSecret: false, upiVpa: false,
    }).map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("worstSeverity", () => {
  it("critical outranks warning", () => {
    expect(worstSeverity(moneyHealth({ ...HEALTHY, emailConfigured: false, upiVpa: false })))
      .toBe("critical");
  });

  it("reports warning when only warnings exist", () => {
    expect(worstSeverity(moneyHealth({ ...HEALTHY, upiVpa: false }))).toBe("warning");
  });
});

describe("Razorpay on TEST credentials", () => {
  it("is reported, because every other check passing made the panel silent", () => {
    // The real state of this workspace on 14 Aug 2026: keys present, webhook
    // secret present, mode 'test'. Nothing was reported, so the panel implied
    // payments were ready while a real customer could not have paid.
    const f = moneyHealth({ ...HEALTHY, razorpayLive: false });
    expect(f.map((x) => x.id)).toContain("razorpay-test-mode");
  });

  it("says plainly that real customers cannot pay", () => {
    const f = moneyHealth({ ...HEALTHY, razorpayLive: false })
      .find((x) => x.id === "razorpay-test-mode")!;
    expect(f.title).toMatch(/real customers cannot pay/i);
    // The insidious part is not the failure, it is the false success.
    expect(f.consequence).toMatch(/look successful and settle nothing/i);
  });

  it("mentions that the live webhook secret is a DIFFERENT secret", () => {
    // The trap when going live: people swap the key pair and keep the test
    // webhook secret, which lands straight in the collect-without-reconcile state.
    const f = moneyHealth({ ...HEALTHY, razorpayLive: false })
      .find((x) => x.id === "razorpay-test-mode")!;
    expect(f.fix).toMatch(/webhook secrets are different/i);
  });

  it("stays a warning, so it cannot crowd out a finding that loses money", () => {
    // Test mode is the CORRECT state during a build. A permanent critical alert
    // for a correct state is how a panel trains people to ignore it.
    const f = moneyHealth({ ...HEALTHY, razorpayLive: false })
      .find((x) => x.id === "razorpay-test-mode")!;
    expect(f.severity).toBe("warning");
  });

  it("is silent on live keys", () => {
    expect(moneyHealth({ ...HEALTHY, razorpayLive: true }).map((x) => x.id))
      .not.toContain("razorpay-test-mode");
  });

  it("does not fire when Razorpay is not configured at all", () => {
    // Nothing set up is a different problem from the wrong thing set up, and
    // telling someone their absent integration is "on test keys" is noise.
    expect(moneyHealth({ razorpayKeys: false, razorpayLive: false }).map((x) => x.id))
      .not.toContain("razorpay-test-mode");
  });

  it("does not guess when the mode is unknown", () => {
    expect(moneyHealth({ razorpayKeys: true, razorpayWebhookSecret: true }).map((x) => x.id))
      .not.toContain("razorpay-test-mode");
  });
});
