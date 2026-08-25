import { describe, it, expect } from "vitest";
import {
  UNDERPAYMENT_TOLERANCE,
  decideProvisioning,
  queuedLine,
  type ProvisioningInput,
} from "./provisioning";

/** Everything real and wired — the only shape that can reach `activate`. */
const READY: ProvisioningInput = {
  paymentMode: "live",
  paymentVerified: true,
  amountPaid: 146_811,
  amountExpected: 146_811,
  vendor: "google",
  seats: 12,
  vendorApiConfigured: true,
  dialMode: "auto",
};

describe("the hard gate: a test-mode payment can never activate", () => {
  it("QUEUES a test-mode payment even with the dial on auto and the API connected", () => {
    /* THE TEST THIS MODULE EXISTS FOR. Production's razorpay_key_id starts rzp_test_, and a
       test-mode payment is indistinguishable from a real one everywhere except that prefix: the
       customer completes checkout, payment.captured fires, the signature verifies, the amount
       matches — and zero rupees settle.

       "Auto-provision on payment received" therefore means, today, that anybody reaching a test
       checkout gets seats for free in seconds with nobody watching. */
    const out = decideProvisioning({ ...READY, paymentMode: "test" });
    expect(out.action).toBe("queue");
    if (out.action === "queue") {
      expect(out.blocker).toBe("test_mode_payment");
      expect(out.reason).toContain("no money settled");
      expect(out.reason).toContain("at any dial setting");
    }
  });

  it("is checked BEFORE the dial, so no setting can override it", () => {
    /* The dial answers "may we act unattended". This answers "is there anything real to act
       on". Ordering them the other way round would make a config change enough to give the
       product away. */
    for (const dialMode of ["off", "hold", "auto"] as const) {
      const out = decideProvisioning({ ...READY, paymentMode: "test", dialMode });
      expect(out.action).toBe("queue");
      if (out.action === "queue") expect(out.blocker).toBe("test_mode_payment");
    }
  });

  it("names the fix rather than just refusing", () => {
    const out = decideProvisioning({ ...READY, paymentMode: "test" });
    if (out.action === "queue") expect(out.reason).toContain("Settings → Integrations");
  });
});

describe("what it refuses outright", () => {
  it("refuses an unverified payment event", () => {
    const out = decideProvisioning({ ...READY, paymentVerified: false });
    expect(out.action).toBe("refuse");
  });

  it("REFUSES a part payment rather than queueing it", () => {
    /* A queued request means "activate this once you can", and a part-paid quote should not be
       activated later either. Seats handed over against half the money are seats somebody has
       to claw back, and the customer has done nothing wrong. */
    const out = decideProvisioning({ ...READY, amountPaid: 100_000 });
    expect(out.action).toBe("refuse");
    if (out.action === "refuse") expect(out.reason).toContain("part payment is a conversation");
  });

  it(`tolerates exactly ${UNDERPAYMENT_TOLERANCE} rupees of shortfall`, () => {
    expect(decideProvisioning({ ...READY, amountPaid: 146_810 }).action).toBe("refuse");
    expect(decideProvisioning({ ...READY, amountPaid: 146_811 }).action).toBe("activate");
  });

  it("accepts an OVERpayment, because that is not a reason to withhold seats", () => {
    /* Rounding at the gateway, or a customer paying a round figure. The shortfall check is
       one-directional on purpose. */
    expect(decideProvisioning({ ...READY, amountPaid: 146_900 }).action).toBe("activate");
  });

  it.each([0, -5, 2.5])("refuses %s as a seat count", (seats) => {
    expect(decideProvisioning({ ...READY, seats }).action).toBe("refuse");
  });
});

describe("what it queues, and why", () => {
  it("queues when the Google reseller API is not connected", () => {
    /* src/lib/google-csp/ does not exist, and the setup wizard's step 4 calls it a "preview of
       the 5–7 day application" — the application has not been made. */
    const out = decideProvisioning({ ...READY, vendorApiConfigured: false });
    expect(out.action).toBe("queue");
    if (out.action === "queue") {
      expect(out.blocker).toBe("vendor_api_not_configured");
      expect(out.reason).toContain("5–7 day application");
    }
  });

  it("queues Microsoft and Zoho by name rather than failing generically", () => {
    for (const vendor of ["microsoft", "zoho"] as const) {
      const out = decideProvisioning({ ...READY, vendor });
      expect(out.action).toBe("queue");
      if (out.action === "queue") {
        expect(out.blocker).toBe("vendor_unsupported");
        expect(out.reason).toContain(vendor);
      }
    }
  });

  it("queues when the dial is not on auto", () => {
    for (const dialMode of ["off", "hold"] as const) {
      const out = decideProvisioning({ ...READY, dialMode });
      expect(out.action).toBe("queue");
      if (out.action === "queue") expect(out.blocker).toBe("dial_not_auto");
    }
  });

  it("reports the test-mode blocker ahead of a missing API", () => {
    /* Both are true today. The one that matters is the one about the money — an operator who
       fixes the API first still cannot safely activate. */
    const out = decideProvisioning({ ...READY, paymentMode: "test", vendorApiConfigured: false });
    if (out.action === "queue") expect(out.blocker).toBe("test_mode_payment");
  });
});

describe("activate is reachable, but only with everything true", () => {
  it("activates when the payment is live and verified, the amount matches, and the API is wired", () => {
    const out = decideProvisioning(READY);
    expect(out.action).toBe("activate");
  });

  it("cannot be reached from this deployment's actual state", () => {
    /* Production today: test keys, no CSP adapter. Written as a test so that the day either
       changes, somebody sees this line and thinks about the other one. */
    const asDeployedToday: ProvisioningInput = {
      ...READY,
      paymentMode: "test",
      vendorApiConfigured: false,
      dialMode: "off",
    };
    expect(decideProvisioning(asDeployedToday).action).toBe("queue");
  });
});

describe("queuedLine", () => {
  it("says what was paid, what is waiting, and what is blocking it", () => {
    const out = decideProvisioning({ ...READY, paymentMode: "test" });
    if (out.action !== "queue") throw new Error("expected a queue outcome");
    const line = queuedLine({
      customerName: "Rahul Solutions",
      seats: 12,
      amountPaid: 146_811,
      outcome: out,
    });
    expect(line).toContain("Rahul Solutions");
    expect(line).toContain("Rs 1,46,811");
    expect(line).toContain("12 seats");
    expect(line).toContain("TEST-mode");
  });

  it("copes with a customer we have no name for", () => {
    const out = decideProvisioning({ ...READY, dialMode: "hold" });
    if (out.action !== "queue") throw new Error("expected a queue outcome");
    expect(queuedLine({ customerName: "", seats: 1, amountPaid: 100, outcome: out })).toContain("A customer");
  });
});
