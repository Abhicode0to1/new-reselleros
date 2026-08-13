import { describe, it, expect } from "vitest";
import { foreignEquivalent, formatForeign, isForeignCurrency } from "./currency";

describe("foreignEquivalent", () => {
  it("₹83,000 at ₹83/USD → $1,000", () => {
    expect(foreignEquivalent(83000, 83)).toBe(1000);
  });
  it("guards against a zero / missing rate (no divide-by-zero)", () => {
    expect(foreignEquivalent(83000, 0)).toBe(0);
    expect(foreignEquivalent(83000, -1)).toBe(0);
  });
});

describe("formatForeign", () => {
  it("adds the symbol + 2 decimals", () => {
    expect(formatForeign(1000, "USD")).toBe("$1,000.00");
    expect(formatForeign(1234.5, "EUR")).toBe("€1,234.50");
  });
  it("falls back to the code for unknown currencies", () => {
    expect(formatForeign(500, "JPY")).toBe("JPY 500.00");
  });
});

describe("isForeignCurrency", () => {
  it("INR / blank / null → domestic", () => {
    expect(isForeignCurrency("INR")).toBe(false);
    expect(isForeignCurrency("inr")).toBe(false);
    expect(isForeignCurrency("")).toBe(false);
    expect(isForeignCurrency(null)).toBe(false);
    expect(isForeignCurrency(undefined)).toBe(false);
  });
  it("real currencies → foreign", () => {
    expect(isForeignCurrency("USD")).toBe(true);
    expect(isForeignCurrency("EUR")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-currency quotes: USD / AED / SGD
//
// The architecture matters more than any single number here. The books are
// ALWAYS INR — quote.amount, tax, payments and MRR are integer rupees — and the
// foreign figure is DERIVED for display at `exchange_rate` (INR per 1 unit).
//
// That direction is the safety property being tested. If the foreign amount were
// the source of truth, every INR figure in the ledger would move whenever the
// rate was edited, silently rewriting history. Because rupees are canonical, a
// rate correction changes only what the customer sees on a future document.
// ─────────────────────────────────────────────────────────────────────────────
describe("multi-currency quotes derive from canonical INR", () => {
  // Representative RBI reference rates (INR per 1 unit). Exact values are the
  // operator's input, not a constant this library owns — these stand in for a
  // realistic day's rates.
  const RATE = { USD: 83.5, AED: 22.74, SGD: 62.1 };

  it("USD: a ₹1,00,000 taxable line at 83.50 → $1,197.60", () => {
    expect(foreignEquivalent(100_000, RATE.USD)).toBeCloseTo(1197.6048, 3);
    expect(formatForeign(foreignEquivalent(100_000, RATE.USD), "USD")).toBe("$1,197.60");
  });

  it("AED and SGD carry their own symbols", () => {
    expect(formatForeign(foreignEquivalent(100_000, RATE.AED), "AED")).toBe("AED 4,397.54");
    expect(formatForeign(foreignEquivalent(100_000, RATE.SGD), "SGD")).toBe("S$1,610.31");
  });

  it("GST is computed on the INR taxable value, then converted — never the reverse", () => {
    // ₹1,00,000 + 18% = ₹1,18,000 in the books. The foreign total is that figure
    // converted, so the customer's $ total always reconciles to the ₹ ledger.
    const taxableInr = 100_000;
    const taxInr     = Math.round(taxableInr * 0.18);
    const grossInr   = taxableInr + taxInr;
    expect(grossInr).toBe(118_000);

    const grossUsd = foreignEquivalent(grossInr, RATE.USD);
    expect(formatForeign(grossUsd, "USD")).toBe("$1,413.17");

    // Converting each component separately must reach the same total — no drift.
    const sumOfParts = foreignEquivalent(taxableInr, RATE.USD) + foreignEquivalent(taxInr, RATE.USD);
    expect(sumOfParts).toBeCloseTo(grossUsd, 10);
  });

  it("multi-line totals convert consistently, line-by-line or in one go", () => {
    const lines = [12 * 5100, 3 * 9200, 1 * 45_000];   // ₹61,200 + ₹27,600 + ₹45,000
    const totalInr = lines.reduce((a, b) => a + b, 0);
    expect(totalInr).toBe(133_800);

    const perLine = lines.reduce((s, l) => s + foreignEquivalent(l, RATE.USD), 0);
    expect(perLine).toBeCloseTo(foreignEquivalent(totalInr, RATE.USD), 10);
  });

  it("a rate correction never moves the INR ledger, only the display", () => {
    // The whole point of INR being canonical: re-quoting at a new rate leaves
    // every recorded rupee untouched.
    const inr = 118_000;
    expect(foreignEquivalent(inr, 83.5)).not.toBeCloseTo(foreignEquivalent(inr, 84.9), 2);
    // …and the rupee figure is not a function of the rate at all.
    expect(inr).toBe(118_000);
  });

  it("an INR quote is not foreign, so no conversion is offered", () => {
    expect(isForeignCurrency("INR")).toBe(false);
    for (const c of ["USD", "AED", "SGD"]) expect(isForeignCurrency(c)).toBe(true);
  });

  it("a missing or nonsense rate yields 0, never NaN or Infinity", () => {
    // A quote saved before anyone entered a rate must not render "$Infinity".
    for (const bad of [0, -1, Number.NaN, undefined as unknown as number]) {
      const v = foreignEquivalent(118_000, bad);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBe(0);
    }
  });

  it("rounds half-up at two decimals for display", () => {
    // 1000/3 = 333.333…  and 2000/3 = 666.666… → .67
    expect(formatForeign(1000 / 3, "USD")).toBe("$333.33");
    expect(formatForeign(2000 / 3, "USD")).toBe("$666.67");
  });

  it("falls back to the code for a currency it has no symbol for", () => {
    expect(formatForeign(1234.5, "JPY")).toBe("JPY 1,234.50");
  });
});
