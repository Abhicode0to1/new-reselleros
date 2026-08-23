import { describe, it, expect } from "vitest";
import { quoteAcceptPath, quoteAcceptUrl } from "./accept-link";
import { quoteTokenMatches } from "./accept-token";

describe("quoteAcceptPath / quoteAcceptUrl", () => {
  it("builds a path with the token query", () => {
    expect(quoteAcceptPath("Q-ET-2026-27-0001", "tok-123"))
      .toBe("/quote/Q-ET-2026-27-0001/accept?t=tok-123");
  });
  it("strips a trailing slash from the base and joins", () => {
    expect(quoteAcceptUrl("https://app.example.com/", "Q-1", "tok-9"))
      .toBe("https://app.example.com/quote/Q-1/accept?t=tok-9");
  });
  it("url-encodes id and token", () => {
    expect(quoteAcceptPath("Q A/1", "a b")).toBe("/quote/Q%20A%2F1/accept?t=a%20b");
  });
});

describe("quoteTokenMatches", () => {
  it("true for an exact match", () => {
    expect(quoteTokenMatches("abc-123", "abc-123")).toBe(true);
  });
  it("false for a mismatch", () => {
    expect(quoteTokenMatches("abc-123", "abc-124")).toBe(false);
  });
  it("false for different lengths", () => {
    expect(quoteTokenMatches("abc", "abc-123")).toBe(false);
  });
  it("false for null/empty/undefined on either side", () => {
    expect(quoteTokenMatches(null, "abc")).toBe(false);
    expect(quoteTokenMatches("abc", null)).toBe(false);
    expect(quoteTokenMatches("", "")).toBe(false);
    expect(quoteTokenMatches(undefined, undefined)).toBe(false);
  });
});

describe("a missing or malformed host yields null, never a relative path", () => {
  /* THE BUG, found on live data 23 Aug 2026. NEXT_PUBLIC_APP_URL was unset on Cloud Run and
     the renewals cron called quoteAcceptUrl(process.env.NEXT_PUBLIC_APP_URL ?? "", …). With
     an empty base this returned "/quote/Q-…/accept?t=…" — and in an EMAIL a relative path is
     not a degraded link, it is a dead one: no mail client can resolve it.

     So renewal reminders reached customers with an accept link that could not be clicked.
     The renewal is the money and the link is how it converts. Nothing errored, nothing
     logged, and the cron reported success. */

  it.each(["", "   ", null, undefined])("refuses base %j", (base) => {
    expect(quoteAcceptUrl(base, "Q-1", "tok")).toBeNull();
  });

  it("refuses a host with no scheme, because that is equally unclickable in mail", () => {
    /* "looks like a URL" is not the test — "a mail client can resolve it" is. */
    expect(quoteAcceptUrl("resellersos.example.app", "Q-1", "tok")).toBeNull();
    expect(quoteAcceptUrl("//resellersos.example.app", "Q-1", "tok")).toBeNull();
  });

  it("builds an absolute link when the base is real", () => {
    expect(quoteAcceptUrl("https://app.example.com", "Q-1", "tok"))
      .toBe("https://app.example.com/quote/Q-1/accept?t=tok");
  });

  it("tolerates trailing slashes rather than doubling them", () => {
    expect(quoteAcceptUrl("https://app.example.com///", "Q-1", "tok"))
      .toBe("https://app.example.com/quote/Q-1/accept?t=tok");
  });

  it("accepts http for a local or staging host", () => {
    expect(quoteAcceptUrl("http://localhost:3000", "Q-1", "tok"))
      .toBe("http://localhost:3000/quote/Q-1/accept?t=tok");
  });
});
