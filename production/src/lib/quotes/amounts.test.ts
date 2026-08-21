import { describe, it, expect } from "vitest";
import { grossAmount, quoteAmountGap, isQuoteAmountConsistent, QUOTE_AMOUNT_TOLERANCE } from "./amounts";

describe("quote amount integrity", () => {
  it("clears the 26 production quotes whose numbers agree", () => {
    // Representative shapes measured 21 Aug 2026: plain, discounted, and zero-rated.
    expect(isQuoteAmountConsistent(103680, 18, 122342)).toBe(true);
    expect(isQuoteAmountConsistent(362880, 18, 428198)).toBe(true);
    expect(isQuoteAmountConsistent(0, 18, 0)).toBe(true);
    expect(isQuoteAmountConsistent(45360, 0, 45360)).toBe(true);
  });

  it("catches Q-2026-9776, the one quote missing its GST", () => {
    // subtotal ₹45,360 at 18% must be ₹53,525; the row says ₹45,360.
    expect(quoteAmountGap(45360, 18, 45360)).toBe(8165);
    expect(isQuoteAmountConsistent(45360, 18, 45360)).toBe(false);
  });

  it("tolerates a rupee of legacy rounding, but not two", () => {
    expect(isQuoteAmountConsistent(103680, 18, 122342 + QUOTE_AMOUNT_TOLERANCE)).toBe(true);
    expect(isQuoteAmountConsistent(103680, 18, 122342 - QUOTE_AMOUNT_TOLERANCE)).toBe(true);
    expect(isQuoteAmountConsistent(103680, 18, 122342 + QUOTE_AMOUNT_TOLERANCE + 1)).toBe(false);
    expect(isQuoteAmountConsistent(103680, 18, 122342 - QUOTE_AMOUNT_TOLERANCE - 1)).toBe(false);
  });

  it("signs the gap so the direction is unambiguous", () => {
    // Positive = the quote is billing LESS than its own tax rate implies.
    expect(quoteAmountGap(100000, 18, 100000)).toBeGreaterThan(0);
    // Negative = it is billing more.
    expect(quoteAmountGap(100000, 18, 130000)).toBeLessThan(0);
  });
});

describe("grossAmount", () => {
  it("adds 18% GST to a Standard ×10 annual renewal subtotal", () => {
    // 10 seats × ₹864/mo × 12 = ₹1,03,680 ex-GST → ₹1,22,342 incl 18% GST
    expect(grossAmount(103680, 18)).toBe(122342);
  });

  it("defaults to 18%", () => {
    expect(grossAmount(103680)).toBe(122342);
  });

  it("rounds the tax (half-up) like the quote builder", () => {
    // 103680 * 0.18 = 18662.4 → 18662
    expect(grossAmount(103680, 18) - 103680).toBe(18662);
  });

  it("handles zero", () => {
    expect(grossAmount(0, 18)).toBe(0);
  });

  it("handles a 2-year extension subtotal (mrr×12×2)", () => {
    // 8640×12×2 = 207360 ex-GST → 207360 + 37325 = 244685
    expect(grossAmount(207360, 18)).toBe(244685);
  });

  it("supports other GST rates", () => {
    expect(grossAmount(1000, 5)).toBe(1050);
    expect(grossAmount(1000, 0)).toBe(1000);
  });
});
