import { describe, it, expect } from "vitest";
import { endOfDayIST, isQuoteExpired, foreignAmount, rupee, num } from "./utils";

// The most-used function in the app (900+ call sites) and it had no test.
// These lock the Indian lakh/crore grouping, which is the whole reason we route
// money through the helper instead of toLocaleString() — an un-pinned
// toLocaleString() follows the BROWSER locale, so an en-US machine rendered
// ₹1,560,000 where an Indian reader expects ₹15,60,000. See docs/UX-AUDIT.md G3.
describe("rupee — Indian grouping", () => {
  it("groups in lakhs/crores, not thousands", () => {
    expect(rupee(1560000)).toBe("₹15,60,000");   // NOT ₹1,560,000
    expect(rupee(490644)).toBe("₹4,90,644");
    expect(rupee(10000000)).toBe("₹1,00,00,000");
  });

  it("formats small amounts without stray separators", () => {
    expect(rupee(0)).toBe("₹0");
    expect(rupee(999)).toBe("₹999");
    expect(rupee(1000)).toBe("₹1,000");
    expect(rupee(1452)).toBe("₹1,452");          // vendor-portal: ₹121/mo × 12
  });

  it("handles NEGATIVE amounts — a net GST credit is real money", () => {
    // Regression: −100…−999 used to render "₹-,500" (the sign landed inside the
    // grouped integer part, leaving `rest` as just "-").
    expect(rupee(-500)).toBe("₹-500");
    expect(rupee(-100)).toBe("₹-100");
    expect(rupee(-999)).toBe("₹-999");
    expect(rupee(-1)).toBe("₹-1");
    expect(rupee(-1000)).toBe("₹-1,000");
    expect(rupee(-1560000)).toBe("₹-15,60,000");
  });

  it("never renders a negative zero", () => {
    expect(rupee(-0.4)).toBe("₹0");
  });

  it("supports decimals on both signs", () => {
    expect(rupee(1234.5, { decimals: 2 })).toBe("₹1,234.50");
    expect(rupee(-1234.5, { decimals: 2 })).toBe("₹-1,234.50");
  });

  it("compact mode uses L / Cr, not K-thousands past a lakh", () => {
    expect(rupee(1560000, { compact: true })).toBe("₹15.6L");
    expect(rupee(12345678, { compact: true })).toBe("₹1.2Cr");
    expect(rupee(5000, { compact: true })).toBe("₹5.0K");
  });

  it("renders an em-dash for null/undefined rather than ₹NaN", () => {
    expect(rupee(null)).toBe("—");
    expect(rupee(undefined)).toBe("—");
  });
});

describe("num — Indian grouping, no currency symbol", () => {
  it("groups in lakhs and omits ₹", () => {
    expect(num(1234567)).toBe("12,34,567");
    expect(num(999)).toBe("999");
  });
  it("returns an em-dash for null/undefined", () => {
    expect(num(null)).toBe("—");
    expect(num(undefined)).toBe("—");
  });
});

describe("foreignAmount", () => {
  it("returns null for domestic INR bills or missing rate", () => {
    expect(foreignAmount("INR", 1000, 1)).toBeNull();
    expect(foreignAmount(null, 1000, 83)).toBeNull();
    expect(foreignAmount("USD", 1000, 0)).toBeNull();
    expect(foreignAmount("USD", 1000, null)).toBeNull();
  });
  it("derives the supplier-currency amount from ₹ ÷ rate with the right symbol", () => {
    expect(foreignAmount("USD", 24293, 91.5)).toBe("$265.50");
    expect(foreignAmount("USD", 5304, 91.5)).toBe("$57.97");
    expect(foreignAmount("GBP", 10000, 100)).toBe("£100.00");
    expect(foreignAmount("AED", 8300, 22.6)).toBe("AED 367.26");
  });
});

describe("endOfDayIST", () => {
  it("maps a YYYY-MM-DD to 23:59:59.999 IST == 18:29:59.999 UTC same date", () => {
    expect(endOfDayIST("2026-06-30").toISOString()).toBe("2026-06-30T18:29:59.999Z");
  });
  it("tolerates a full ISO timestamp (uses the date part only)", () => {
    expect(endOfDayIST("2026-06-30T00:00:00.000Z").toISOString()).toBe("2026-06-30T18:29:59.999Z");
  });
});

describe("isQuoteExpired (end-of-day IST)", () => {
  const EXP = "2026-06-30"; // quote valid until 30 Jun 2026

  it("NOT expired at dawn IST on the last valid day (the old-bug case)", () => {
    // 2026-06-30 05:30 IST == 2026-06-30 00:00 UTC. Old code wrongly expired here.
    expect(isQuoteExpired(EXP, new Date("2026-06-30T00:00:00.000Z"))).toBe(false);
  });

  it("NOT expired late evening IST on the last valid day", () => {
    // 2026-06-30 23:00 IST == 2026-06-30 17:30 UTC
    expect(isQuoteExpired(EXP, new Date("2026-06-30T17:30:00.000Z"))).toBe(false);
  });

  it("expired just after midnight IST the next day", () => {
    // 2026-07-01 00:30 IST == 2026-06-30 19:00 UTC
    expect(isQuoteExpired(EXP, new Date("2026-06-30T19:00:00.000Z"))).toBe(true);
  });

  it("expired well into the next day", () => {
    expect(isQuoteExpired(EXP, new Date("2026-07-05T10:00:00.000Z"))).toBe(true);
  });

  it("no expiry date → never expired", () => {
    expect(isQuoteExpired(null, new Date("2030-01-01T00:00:00.000Z"))).toBe(false);
    expect(isQuoteExpired(undefined)).toBe(false);
  });
});
