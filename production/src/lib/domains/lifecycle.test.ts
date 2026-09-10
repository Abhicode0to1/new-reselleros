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
  expiryPhrase,
  summariseExpiries,
} from "./lifecycle";
import { formatDate } from "@/lib/utils";

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

/* ── The two /portal/domains findings ─────────────────────────────────────────
 *
 * Both were reported by a layout audit and both were still open. They are tested
 * here rather than in the page because they are arithmetic about a deadline.
 */

describe("expiryPhrase — never the same string as the column next to it", () => {
  const NOW = new Date("2026-09-09T12:00:00Z");

  it("stays RELATIVE past 60 days, where it used to print the date", () => {
    /* The bug: past 60 days the page fell back to `formatDate(expires_at)`, so
       the `Renews` column and the `Expiry date` column showed the identical
       string — and the phone card printed the same date twice, side by side. */
    const far = expiryPhrase("2027-05-15T00:00:00Z", NOW);
    expect(far.text).toBe("in about 8 months");
    expect(far.urgency).toBe("calm");
    /* The thing that actually went wrong: it must not be a formatted date. */
    expect(far.text).not.toMatch(/\d{4}/);
    expect(far.text).not.toBe(formatDate("2027-05-15T00:00:00Z"));
  });

  it("coarsens to years rather than counting to 800 days", () => {
    expect(expiryPhrase("2029-09-09T12:00:00Z", NOW).text).toBe("in about 3 years");
    expect(expiryPhrase("2027-09-09T12:00:00Z", NOW).text).toBe("in about a year");
  });

  it("counts days while the number still means something", () => {
    expect(expiryPhrase("2026-09-09T12:00:00Z", NOW)).toMatchObject({ text: "Expires today", urgency: "critical" });
    expect(expiryPhrase("2026-09-10T12:00:00Z", NOW)).toMatchObject({ text: "Expires tomorrow", urgency: "critical" });
    expect(expiryPhrase("2026-09-24T12:00:00Z", NOW)).toMatchObject({ text: "15 days left", urgency: "critical" });
    expect(expiryPhrase("2026-10-24T12:00:00Z", NOW)).toMatchObject({ text: "45 days left", urgency: "soon" });
  });

  it("counts CALENDAR days, not a floored fraction — the real-data case", () => {
    /* This test exists because the first version of the fix passed the whole
       suite while showing the wrong numbers on the actual page: every other case
       here uses a midnight-to-midday pair where the two arithmetics agree.

       `expires_at` is midnight UTC (that is how the registrar sends it) and a
       person reads the page in the middle of the day. Flooring the fraction then
       understates the future and OVERSTATES the past: a name that lapsed eight
       days ago gets announced as nine, which is both wrong and alarming. */
    const afternoon = new Date("2026-09-09T11:37:00Z");   // 17:07 IST
    expect(expiryPhrase("2026-09-21T00:00:00Z", afternoon).days).toBe(12);
    expect(expiryPhrase("2026-09-21T00:00:00Z", afternoon).text).toBe("12 days left");
    expect(expiryPhrase("2026-09-01T00:00:00Z", afternoon).text).toBe("Expired 8 days ago");
    /* And the boundaries still hold when `now` is not midnight. */
    expect(expiryPhrase("2026-09-09T00:00:00Z", afternoon).text).toBe("Expires today");
    expect(expiryPhrase("2026-09-10T00:00:00Z", afternoon).text).toBe("Expires tomorrow");
  });

  it("uses the past tense for a name that has already lapsed", () => {
    expect(expiryPhrase("2026-08-28T12:00:00Z", NOW)).toMatchObject({ text: "Expired 12 days ago", urgency: "lapsed" });
    expect(expiryPhrase("2026-09-08T12:00:00Z", NOW).text).toBe("Expired yesterday");
  });

  it("says a missing date is unconfirmed, not expired", () => {
    /* Normal for a few minutes after a purchase. Calling it expired would be a
       false alarm about the most alarming thing on the page. */
    for (const input of [null, undefined, "", "not a date"]) {
      const p = expiryPhrase(input as string | null, NOW);
      expect(p.urgency).toBe("unknown");
      expect(p.days).toBeNull();
      expect(p.text).toBe("date not confirmed");
    }
  });
});

describe("summariseExpiries — the banner's claim", () => {
  const NOW = new Date("2026-09-09T12:00:00Z");

  it("does NOT count a lapsed domain as expiring soon", () => {
    /* The bug: the filter was `days <= 30`, and a lapsed domain has NEGATIVE
       days — so the banner said "2 domains expire within 30 days" about one that
       had already lapsed twelve days earlier. Wrong tense, wrong fact, and wrong
       advice, since recovering a lapsed name is a different conversation with a
       deadline of its own. */
    const got = summariseExpiries(
      [
        { expires_at: "2026-08-28T00:00:00Z", status: "grace" },   // lapsed 12d ago
        { expires_at: "2026-09-20T00:00:00Z", status: "active" },  // 10d left
      ],
      NOW,
    );
    expect(got).toEqual({ lapsed: 1, expiringSoon: 1 });
  });

  it("counts the boundary day as soon, and the day after the window as neither", () => {
    expect(summariseExpiries([{ expires_at: "2026-10-09T12:00:00Z", status: "active" }], NOW)).toEqual({
      lapsed: 0,
      expiringSoon: 1,
    });
    expect(summariseExpiries([{ expires_at: "2026-10-11T12:00:00Z", status: "active" }], NOW)).toEqual({
      lapsed: 0,
      expiringSoon: 0,
    });
  });

  it("ignores names that are no longer this customer's problem", () => {
    /* A domain transferred away, expiring at its new registrar, is not something
       to interrupt anybody about. */
    const got = summariseExpiries(
      [
        { expires_at: "2026-09-12T00:00:00Z", status: "transferred_out" },
        { expires_at: "2026-08-01T00:00:00Z", status: "cancelled" },
        { expires_at: "2026-09-12T00:00:00Z", status: "active" },
      ],
      NOW,
    );
    expect(got).toEqual({ lapsed: 0, expiringSoon: 1 });
  });

  it("ignores a domain with no expiry date rather than counting it as lapsed", () => {
    expect(summariseExpiries([{ expires_at: null, status: "pending" }], NOW)).toEqual({
      lapsed: 0,
      expiringSoon: 0,
    });
  });

  it("says nothing for an empty account", () => {
    expect(summariseExpiries([], NOW)).toEqual({ lapsed: 0, expiringSoon: 0 });
  });
});
