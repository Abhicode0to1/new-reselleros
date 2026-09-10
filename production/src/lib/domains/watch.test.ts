import { describe, it, expect } from "vitest";
import {
  shouldCheck,
  shouldNotify,
  statusFromReading,
  applyCheck,
  watchableDomain,
  canAddWatch,
  MAX_WATCH_ERRORS,
  WATCH_INTERVAL_HOURS,
  MAX_WATCHES_PER_CUSTOMER,
  type WatchRow,
} from "./watch";

/**
 * The whole risk in this feature is ONE email. "acme.com is available!" about a
 * name that is not available is worse than silence: the customer tries to buy
 * it, fails, and stops trusting anything else we send — including the expiry
 * warnings, which are the ones that actually cost money to ignore.
 *
 * So most of these tests are about refusing to send it.
 */

const NOW = new Date("2026-09-10T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const row = (over: Partial<WatchRow> = {}): WatchRow => ({
  domain_name: "acme.com",
  last_checked_at: null,
  last_status: "unknown",
  notified_at: null,
  consecutive_errors: 0,
  ...over,
});

describe("statusFromReading — an unreadable check is UNKNOWN, never taken", () => {
  it("reads a positive as available and a negative as taken", () => {
    expect(statusFromReading({ available: true })).toBe("available");
    expect(statusFromReading({ available: false })).toBe("taken");
  });

  it("reads `null` as unknown — the case rcAvailability exists to report", () => {
    /* RC answered for the batch but not usefully for this name (the concatenated
       key case). Flattening that to `taken` would be wrong; flattening it to
       `available` would send the bad email. */
    expect(statusFromReading({ available: null })).toBe("unknown");
  });

  it("reads a missing reading as unknown", () => {
    expect(statusFromReading(null)).toBe("unknown");
    expect(statusFromReading(undefined)).toBe("unknown");
  });
});

describe("shouldNotify — the email needs POSITIVE evidence", () => {
  it("sends on an available reading", () => {
    expect(shouldNotify(row(), "available")).toEqual({ notify: true });
  });

  it("does NOT send on an unknown reading, and says why", () => {
    /* The branch that matters. A failed check must never be the thing that
       triggers this. */
    const d = shouldNotify(row(), "unknown");
    expect(d.notify).toBe(false);
    expect(!d.notify && d.reason).toMatch(/could not tell us/);
  });

  it("does not send while the name is still taken", () => {
    expect(shouldNotify(row(), "taken").notify).toBe(false);
  });

  it("never sends twice — a watch is a one-shot alert", () => {
    /* Otherwise every daily sweep re-sends it for as long as the name stays
       free, which is a mailing list nobody subscribed to. */
    const d = shouldNotify(row({ notified_at: hoursAgo(48) }), "available");
    expect(d.notify).toBe(false);
    expect(!d.notify && d.reason).toMatch(/one-shot/);
  });
});

describe("shouldCheck", () => {
  it("checks a watch that has never been checked", () => {
    expect(shouldCheck(row(), NOW)).toEqual({ kind: "check" });
  });

  it("checks once a day, not every sweep", () => {
    expect(WATCH_INTERVAL_HOURS).toBe(24);
    expect(shouldCheck(row({ last_checked_at: hoursAgo(23) }), NOW).kind).toBe("skip");
    expect(shouldCheck(row({ last_checked_at: hoursAgo(25) }), NOW).kind).toBe("check");
  });

  it("retires a notified watch", () => {
    expect(shouldCheck(row({ notified_at: hoursAgo(1), last_checked_at: hoursAgo(100) }), NOW).kind).toBe("skip");
  });

  it("gives up on a name that keeps failing", () => {
    /* Usually a TLD the registrar will not answer for. Asking forever is log
       noise and load on an API somebody pays for. */
    expect(MAX_WATCH_ERRORS).toBe(10);
    expect(shouldCheck(row({ consecutive_errors: 10, last_checked_at: hoursAgo(100) }), NOW).kind).toBe("skip");
    expect(shouldCheck(row({ consecutive_errors: 9, last_checked_at: hoursAgo(100) }), NOW).kind).toBe("check");
  });

  it("checks a row with an unparseable timestamp rather than stalling forever", () => {
    expect(shouldCheck(row({ last_checked_at: "not a date" }), NOW).kind).toBe("check");
  });
});

describe("applyCheck — the error counter", () => {
  it("records a conclusive reading and clears the error state", () => {
    /* A name that answered today has clearly not run out of retries, whatever
       happened last week. */
    const got = applyCheck(row({ consecutive_errors: 7 }), "taken", { now: NOW });
    expect(got).toEqual({
      last_checked_at: NOW.toISOString(),
      last_status: "taken",
      consecutive_errors: 0,
      last_error: null,
    });
  });

  it("counts up on an unknown reading and keeps the reason", () => {
    const got = applyCheck(row({ consecutive_errors: 2 }), "unknown", { error: "RC unreachable", now: NOW });
    expect(got.consecutive_errors).toBe(3);
    expect(got.last_error).toBe("RC unreachable");
  });

  it("always leaves a reason on an unknown, even when none was given", () => {
    expect(applyCheck(row(), "unknown", { now: NOW }).last_error).toBeTruthy();
  });

  it("stamps notified_at only when told to", () => {
    expect(applyCheck(row(), "available", { now: NOW }).notified_at).toBeUndefined();
    expect(applyCheck(row(), "available", { notified: true, now: NOW }).notified_at).toBe(NOW.toISOString());
  });

  it("clears the counter on an available reading too", () => {
    expect(applyCheck(row({ consecutive_errors: 5 }), "available", { now: NOW }).consecutive_errors).toBe(0);
  });
});

describe("watchableDomain — refuse at the point of asking", () => {
  it("accepts and normalises a real name", () => {
    expect(watchableDomain("  ACME.com  ")).toEqual({ ok: true, domain: "acme.com" });
    expect(watchableDomain("https://acme.co.in/pricing")).toEqual({ ok: true, domain: "acme.co.in" });
    expect(watchableDomain("acme.com.")).toEqual({ ok: true, domain: "acme.com" });
  });

  it("refuses a bare label, and says what is missing", () => {
    /* A watch on something we cannot check is a promise that will never be
       kept, so the refusal belongs here rather than in a sweep nobody reads. */
    const v = watchableDomain("acme");
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toMatch(/acme\.com/);
  });

  it("refuses empty and malformed input", () => {
    for (const bad of ["", "   ", "acme .com", "-acme.com", "acme..com", "acme_shop.com", "just.a.hyphen-"]) {
      expect(watchableDomain(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("strips a path before judging, so a pasted URL is not rejected for its query", () => {
    /* Customers paste whole URLs. Everything after the first `/` is discarded,
       which is why "acme.com/x y" is ACCEPTED as acme.com — the space is in a
       path nobody asked us to watch. */
    expect(watchableDomain("acme.com/x y")).toEqual({ ok: true, domain: "acme.com" });
    expect(watchableDomain("acme.com/?utm=1")).toEqual({ ok: true, domain: "acme.com" });
  });

  it("refuses something too long to be a domain", () => {
    expect(watchableDomain("a".repeat(60) + "." + "b".repeat(200)).ok).toBe(false);
  });

  it("does NOT try to validate the TLD", () => {
    /* A TLD list in code goes stale, and the first check establishes it anyway.
       Better to accept a watch on a new TLD than to refuse a real one. */
    expect(watchableDomain("acme.zuerich").ok).toBe(true);
    expect(watchableDomain("acme.qqqq").ok).toBe(true);
  });
});

describe("canAddWatch", () => {
  it("caps a customer, so one person cannot queue a thousand daily checks", () => {
    expect(MAX_WATCHES_PER_CUSTOMER).toBe(20);
    expect(canAddWatch(19).ok).toBe(true);
    expect(canAddWatch(20).ok).toBe(false);
  });

  it("says how to make room rather than only refusing", () => {
    const v = canAddWatch(20);
    expect(!v.ok && v.reason).toMatch(/Remove one/);
  });
});
