import { describe, it, expect } from "vitest";
import { provisioningReadiness, worstProvisioning, type ProvisioningEnv } from "./readiness";

/**
 * The combination that costs money is not the one anybody sets on purpose, which
 * is the whole reason this is a pure function over booleans rather than something
 * that reads the environment. Every square of the grid gets asserted.
 */

const env = (over: Partial<ProvisioningEnv> = {}): ProvisioningEnv => ({
  rcConfigured: true,
  domainRegisterLive: true,
  daConfigured: true,
  hostingTrialLive: true,
  canCollect: true,
  ...over,
});

describe("ready", () => {
  it("says nothing is wrong when credentials and gate are both present", () => {
    const r = provisioningReadiness(env());
    for (const p of [r.domain, r.hosting]) {
      expect(p.state).toBe("ready");
      expect(p.canProvision).toBe(true);
      expect(p.severity).toBe("none");
      expect(p.detail).toBeNull();
    }
  });
});

describe("the state that loses money: gate shut while Razorpay can charge", () => {
  it("is CRITICAL, and says you can sell what you cannot deliver", () => {
    const r = provisioningReadiness(env({ domainRegisterLive: false }));
    expect(r.domain.state).toBe("gate_shut");
    expect(r.domain.severity).toBe("critical");
    expect(r.domain.headline).toMatch(/sell domains and none of them will be delivered/);
  });

  it("says the order QUEUES rather than fails — the part nobody expects", () => {
    /* decideProvisioning returns `queue` with `engine_not_connected`. A reader who
       assumes a refusal will not go looking for a list of charged, undelivered
       orders. */
    const r = provisioningReadiness(env({ domainRegisterLive: false }));
    expect(r.domain.detail).toMatch(/queues/);
    expect(r.domain.detail).toMatch(/nothing is delivered/);
  });

  it("names the exact env var, so the fix does not need a code search", () => {
    const r = provisioningReadiness(env({ domainRegisterLive: false, hostingTrialLive: false }));
    expect(r.domain.detail).toContain("DOMAIN_REGISTER_LIVE=1");
    expect(r.hosting.detail).toContain("HOSTING_TRIAL_LIVE=1");
  });

  it("still reports reads as WORKING, which is why the state looks fine", () => {
    /* Availability and pricing use the same credentials and no gate. A screen that
       showed only "searches work" would be telling the truth and hiding the point. */
    const r = provisioningReadiness(env({ domainRegisterLive: false }));
    expect(r.domain.canRead).toBe(true);
    expect(r.domain.canProvision).toBe(false);
  });
});

describe("severity depends on whether money can be taken, not on config alone", () => {
  it("drops to INFO when nothing can be charged", () => {
    /* A deployment that cannot charge anyone is not in danger, however little of
       it is configured. Calling that critical would train somebody to ignore the
       word. */
    const r = provisioningReadiness(env({ domainRegisterLive: false, canCollect: false }));
    expect(r.domain.severity).toBe("info");
    expect(r.domain.detail).toMatch(/nobody is at risk today/);
  });

  it("says WHY it is urgent when it is", () => {
    const r = provisioningReadiness(env({ rcConfigured: false }));
    expect(r.domain.detail).toMatch(/Razorpay CAN currently charge/);
  });

  it("is never `none` unless the path can actually provision", () => {
    /* The invariant that matters: a green light must mean deliverable. */
    for (const over of [
      { rcConfigured: false },
      { domainRegisterLive: false },
      { rcConfigured: false, canCollect: false },
      { domainRegisterLive: false, canCollect: false },
    ]) {
      const r = provisioningReadiness(env(over));
      expect(r.domain.severity, JSON.stringify(over)).not.toBe("none");
      expect(r.domain.canProvision, JSON.stringify(over)).toBe(false);
    }
  });
});

describe("not_configured", () => {
  it("reports no reads either, unlike gate_shut", () => {
    const r = provisioningReadiness(env({ daConfigured: false }));
    expect(r.hosting.state).toBe("not_configured");
    expect(r.hosting.canRead).toBe(false);
  });

  it("names the right upstream per path", () => {
    const r = provisioningReadiness(env({ rcConfigured: false, daConfigured: false }));
    expect(r.domain.detail).toContain("ResellerClub");
    expect(r.hosting.detail).toContain("DirectAdmin");
    expect(r.domain.detail).not.toContain("DirectAdmin");
  });
});

describe("the two paths are judged independently", () => {
  it("domains can be ready while hosting is not", () => {
    const r = provisioningReadiness(env({ daConfigured: false }));
    expect(r.domain.state).toBe("ready");
    expect(r.hosting.state).toBe("not_configured");
  });
});

describe("worstProvisioning", () => {
  it("reports the worse of the two", () => {
    /* A deployment that delivers domains but not hosting is not half-ready to
       somebody who just bought hosting. */
    const r = provisioningReadiness(env({ hostingTrialLive: false }));
    expect(worstProvisioning(r).path).toBe("hosting");
  });

  it("reports a ready pair as ready", () => {
    expect(worstProvisioning(provisioningReadiness(env())).severity).toBe("none");
  });

  it("prefers critical over info", () => {
    const r = provisioningReadiness(env({ rcConfigured: false, hostingTrialLive: false }));
    expect(worstProvisioning(r).severity).toBe("critical");
  });
});
