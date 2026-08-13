import { describe, it, expect } from "vitest";
import { parseRupeeInput, parsePriority, parseFollowUpDate, isUnchanged } from "./inline-edit";

const ok = <T,>(r: ReturnType<typeof parseRupeeInput> | { ok: boolean }, v: T) =>
  expect(r).toEqual({ ok: true, value: v });

describe("parseRupeeInput — this feeds the Open Pipeline KPI", () => {
  it("takes plain digits", () => {
    ok(parseRupeeInput("50000"), 50_000);
    ok(parseRupeeInput("0"), 0);
  });

  it("takes what people actually paste — Indian commas and ₹", () => {
    ok(parseRupeeInput("50,000"), 50_000);
    ok(parseRupeeInput("₹1,50,000"), 150_000);
    ok(parseRupeeInput(" ₹ 1,50,000 "), 150_000);
  });

  it("takes lakh / crore shorthand, the way a reseller says it out loud", () => {
    ok(parseRupeeInput("1.5L"), 150_000);
    ok(parseRupeeInput("2l"), 200_000);
    ok(parseRupeeInput("1 lakh"), 100_000);
    ok(parseRupeeInput("2Cr"), 20_000_000);
    ok(parseRupeeInput("1.25 crore"), 12_500_000);
  });

  it("rounds fractional rupees — money is stored as whole ₹", () => {
    ok(parseRupeeInput("1.005L"), 100_500);
    ok(parseRupeeInput("999.6"), 1_000);
  });

  it("treats empty as CLEARED (null), not as ₹0", () => {
    // An unpriced deal is not a zero-value deal; the pipeline total must not
    // count it as one.
    ok(parseRupeeInput(""), null);
    ok(parseRupeeInput("   "), null);
  });

  it("REJECTS rather than guessing", () => {
    for (const bad of ["abc", "50k", "1,2,3x", "--5", "1.2.3", "5 lakhs each"]) {
      const r = parseRupeeInput(bad);
      expect(r.ok, `expected "${bad}" to be rejected`).toBe(false);
    }
  });

  it("a lone currency symbol counts as cleared, not as an error", () => {
    // Typing "₹" and tabbing out reads as "empty this". Clearing is visible and
    // reversible, so accepting it beats an error the operator has to dismiss.
    ok(parseRupeeInput("₹"), null);
  });

  it("rejects negatives", () => {
    const r = parseRupeeInput("-5000");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/negative/i);
  });

  it("rejects an absurd figure — an extra zero shouldn't wreck the pipeline KPI", () => {
    const r = parseRupeeInput("500Cr");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too large/i);
    // …but a large, plausible deal still goes through.
    ok(parseRupeeInput("50Cr"), 500_000_000);
  });

  it("never returns NaN", () => {
    for (const s of ["", "abc", "1.5L", "50,000", "-1"]) {
      const r = parseRupeeInput(s);
      if (r.ok && r.value !== null) expect(Number.isNaN(r.value)).toBe(false);
    }
  });
});

describe("parsePriority", () => {
  it("accepts the three allowed values, case-insensitively", () => {
    ok(parsePriority("high"), "high");
    ok(parsePriority("HIGH"), "high");
    ok(parsePriority(" medium "), "medium");
  });
  it("rejects anything else", () => {
    expect(parsePriority("urgent").ok).toBe(false);
    expect(parsePriority("").ok).toBe(false);
  });
});

describe("parseFollowUpDate", () => {
  it("accepts an ISO date and stores it verbatim — no timezone shift", () => {
    // Converting to UTC is how "tomorrow" becomes "today" for an IST user.
    ok(parseFollowUpDate("2026-08-20"), "2026-08-20");
  });
  it("treats empty as cleared", () => {
    ok(parseFollowUpDate(""), null);
  });
  it("rejects a malformed date", () => {
    expect(parseFollowUpDate("20-08-2026").ok).toBe(false);
    expect(parseFollowUpDate("2026/08/20").ok).toBe(false);
    expect(parseFollowUpDate("tomorrow").ok).toBe(false);
  });
  it("rejects a date that doesn't exist instead of rolling it forward", () => {
    // new Date("2026-02-31") silently becomes March 3.
    expect(parseFollowUpDate("2026-02-31").ok).toBe(false);
    expect(parseFollowUpDate("2026-13-01").ok).toBe(false);
  });
});

describe("isUnchanged — skips pointless writes", () => {
  it("spots identical values", () => {
    expect(isUnchanged(50_000, 50_000)).toBe(true);
    expect(isUnchanged("high", "high")).toBe(true);
  });
  it("treats empty string and null as the same emptiness", () => {
    expect(isUnchanged(null, "")).toBe(true);
    expect(isUnchanged("", null)).toBe(true);
    expect(isUnchanged(undefined, null)).toBe(true);
  });
  it("spots a real change", () => {
    expect(isUnchanged(50_000, 60_000)).toBe(false);
    expect(isUnchanged(null, 0)).toBe(false);   // cleared ≠ zero
  });
});
