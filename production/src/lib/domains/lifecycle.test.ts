import { describe, it, expect } from "vitest";
import {
  daysUntil,
  deriveDomainStatus,
  nextDomainCheckAt,
  deriveHostingStatus,
  expiryDisagreementDays,
  disagreementIsWorthFlagging,
  GRACE_DAYS,
  REDEMPTION_DAYS,
  EXPIRING_SOON_DAYS,
} from "./lifecycle";

/**
 * The sweep decides what a customer is told they own. Two failure directions
 * matter and they are not symmetrical:
 *
 *   · saying a live domain is lost — panic, a support call, possibly a needless
 *     redemption fee paid to "rescue" something that was never at risk;
 *   · saying a lost domain is fine — the customer finds out when the site dies.
 *
 * The first is easier to cause, because it only takes a bad read. So most of
 * what follows pins the cases where the sweep must do NOTHING.
 */

const NOW = new Date("2026-09-09T12:00:00Z");
const inDays = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

describe("daysUntil", () => {
  it("counts forward and backward from now", () => {
    expect(daysUntil(inDays(10), NOW)).toBe(10);
    expect(daysUntil(inDays(-3), NOW)).toBe(-3);
    expect(daysUntil(inDays(0.5), NOW)).toBe(0);
  });
});

describe("deriveDomainStatus — the expiry ladder", () => {
  const at = (days: number, current = "active" as const) =>
    deriveDomainStatus({ current, expiresAt: inDays(days), now: NOW });

  it("far from expiry is active", () => {
    expect(deriveDomainStatus({ current: "pending", expiresAt: inDays(300), now: NOW })).toBe("active");
    expect(at(300)).toBeNull(); // already active — nothing to change
  });

  it("inside the warning window is expiring_soon", () => {
    expect(at(EXPIRING_SOON_DAYS)).toBe("expiring_soon");
    expect(at(1)).toBe("expiring_soon");
    expect(at(0)).toBe("expiring_soon");
  });

  it("one day past the window is still active", () => {
    expect(at(EXPIRING_SOON_DAYS + 1)).toBeNull();
  });

  it("just past expiry is grace, not expired", () => {
    expect(at(-1)).toBe("grace");
    expect(at(-GRACE_DAYS)).toBe("grace");
  });

  it("past grace is redemption — the name can still be saved", () => {
    expect(at(-(GRACE_DAYS + 1))).toBe("redemption");
    expect(at(-REDEMPTION_DAYS)).toBe("redemption");
  });

  it("past redemption stays redemption rather than claiming the name is gone", () => {
    /* "Released" is a claim about the registry we have not verified. */
    expect(at(-400)).toBe("redemption");
  });
});

describe("deriveDomainStatus — the registrar's word", () => {
  it("suspended upstream beats any amount of runway", () => {
    expect(deriveDomainStatus({
      current: "active", registrarStatus: "Suspended", expiresAt: inDays(300), now: NOW,
    })).toBe("suspended");
  });

  it("maps RC's pending-delete wording to redemption", () => {
    for (const word of ["PendingDelete", "pending delete", "pendingDeleteRestorable"]) {
      expect(deriveDomainStatus({ current: "active", registrarStatus: word, expiresAt: inDays(5), now: NOW }))
        .toBe("redemption");
    }
  });

  it("'active' from RC does NOT overrule the countdown", () => {
    /* RC calls a domain active right up to the expiry date, so if its word won
       here nothing would ever reach expiring_soon. */
    expect(deriveDomainStatus({
      current: "active", registrarStatus: "Active", expiresAt: inDays(9), now: NOW,
    })).toBe("expiring_soon");
  });

  it("an unknown registrar word falls through to the dates instead of guessing", () => {
    expect(deriveDomainStatus({
      current: "active", registrarStatus: "SomeNewRcState", expiresAt: inDays(-2), now: NOW,
    })).toBe("grace");
  });

  it("promotes a pending row when RC says active but gives no expiry", () => {
    expect(deriveDomainStatus({ current: "pending", registrarStatus: "Active", expiresAt: null, now: NOW }))
      .toBe("active");
  });
});

describe("deriveDomainStatus — when it must do NOTHING", () => {
  it("learns nothing, changes nothing", () => {
    expect(deriveDomainStatus({ current: "active", now: NOW })).toBeNull();
    expect(deriveDomainStatus({ current: "active", registrarStatus: null, expiresAt: null, now: NOW })).toBeNull();
    expect(deriveDomainStatus({ current: "active", expiresAt: "", now: NOW })).toBeNull();
  });

  it("never reopens our own verdicts, whatever the dates say", () => {
    for (const current of ["failed", "cancelled"] as const) {
      expect(deriveDomainStatus({ current, expiresAt: inDays(300), now: NOW })).toBeNull();
      expect(deriveDomainStatus({ current, registrarStatus: "Active", expiresAt: inDays(300), now: NOW })).toBeNull();
    }
  });

  it("transferred_out is terminal — a date cannot undo it", () => {
    expect(deriveDomainStatus({ current: "transferred_out", expiresAt: inDays(300), now: NOW })).toBeNull();
  });

  it("returns null rather than the same status again, so a no-op writes nothing", () => {
    expect(deriveDomainStatus({ current: "grace", expiresAt: inDays(-5), now: NOW })).toBeNull();
    expect(deriveDomainStatus({ current: "suspended", registrarStatus: "Suspended", now: NOW })).toBeNull();
  });
});

describe("nextDomainCheckAt — tighter as the deadline nears", () => {
  const gap = (iso: string) => Math.round((new Date(iso).getTime() - NOW.getTime()) / 3_600_000);

  it("checks a landing registration hourly", () => {
    expect(gap(nextDomainCheckAt({ status: "pending", expiresAt: null, now: NOW }))).toBe(1);
  });

  it("daily inside the last week, and while past expiry", () => {
    expect(gap(nextDomainCheckAt({ status: "expiring_soon", expiresAt: inDays(5), now: NOW }))).toBe(24);
    expect(gap(nextDomainCheckAt({ status: "grace", expiresAt: inDays(-5), now: NOW }))).toBe(24);
  });

  it("backs off when there is nothing imminent", () => {
    expect(gap(nextDomainCheckAt({ status: "active", expiresAt: inDays(20), now: NOW }))).toBe(48);
    expect(gap(nextDomainCheckAt({ status: "active", expiresAt: inDays(60), now: NOW }))).toBe(24 * 7);
    expect(gap(nextDomainCheckAt({ status: "active", expiresAt: inDays(300), now: NOW }))).toBe(24 * 14);
  });

  it("stops hammering RC about domains that are finished", () => {
    for (const status of ["cancelled", "transferred_out", "failed"] as const) {
      expect(gap(nextDomainCheckAt({ status, expiresAt: inDays(300), now: NOW }))).toBe(24 * 30);
    }
  });

  it("retries tomorrow when the expiry is unknown", () => {
    expect(gap(nextDomainCheckAt({ status: "active", expiresAt: null, now: NOW }))).toBe(24);
  });
});

describe("deriveHostingStatus — a trial counts down to a different field", () => {
  it("an ended trial stops showing as active", () => {
    expect(deriveHostingStatus({
      current: "active", isTrial: true, trialEndsAt: inDays(-1), expiresAt: inDays(300), now: NOW,
    })).toBe("expired");
  });

  it("a live trial is left alone, even with no expires_at", () => {
    expect(deriveHostingStatus({
      current: "active", isTrial: true, trialEndsAt: inDays(3), expiresAt: null, now: NOW,
    })).toBeNull();
  });

  it("a paid account counts down to expires_at, not trial_ends_at", () => {
    expect(deriveHostingStatus({
      current: "active", isTrial: false, trialEndsAt: inDays(-100), expiresAt: inDays(30), now: NOW,
    })).toBeNull();
    expect(deriveHostingStatus({
      current: "active", isTrial: false, trialEndsAt: null, expiresAt: inDays(-1), now: NOW,
    })).toBe("expired");
  });

  it("does not lift a suspension or reopen a termination by date", () => {
    for (const current of ["suspended", "terminated", "failed", "pending"] as const) {
      expect(deriveHostingStatus({ current, isTrial: false, expiresAt: inDays(-10), now: NOW })).toBeNull();
    }
  });

  it("does nothing when there is no deadline to judge by", () => {
    expect(deriveHostingStatus({ current: "active", isTrial: false, expiresAt: null, now: NOW })).toBeNull();
    expect(deriveHostingStatus({ current: "active", isTrial: true, trialEndsAt: null, now: NOW })).toBeNull();
  });

  it("already expired stays put rather than being rewritten", () => {
    expect(deriveHostingStatus({ current: "expired", isTrial: false, expiresAt: inDays(-10), now: NOW })).toBeNull();
  });
});

describe("expiryDisagreementDays — the signal the schema was built to show", () => {
  it("counts the gap in days, signed", () => {
    expect(expiryDisagreementDays(inDays(400), inDays(35))).toBe(365);
    expect(expiryDisagreementDays(inDays(30), inDays(40))).toBe(-10);
  });

  it("is null when either side is missing or unreadable", () => {
    expect(expiryDisagreementDays(null, inDays(30))).toBeNull();
    expect(expiryDisagreementDays(inDays(30), null)).toBeNull();
    expect(expiryDisagreementDays("not-a-date", inDays(30))).toBeNull();
  });

  it("ignores billing-cycle noise and flags a real drift", () => {
    expect(disagreementIsWorthFlagging(expiryDisagreementDays(inDays(32), inDays(30)))).toBe(false);
    expect(disagreementIsWorthFlagging(expiryDisagreementDays(inDays(400), inDays(30)))).toBe(true);
    expect(disagreementIsWorthFlagging(null)).toBe(false);
  });
});
