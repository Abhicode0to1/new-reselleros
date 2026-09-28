import { describe, it, expect } from "vitest";
import { computeAnnualTax, estimateMonthlyTds, form16Working, fyPeriods, fyStartOfPeriod } from "./income-tax";

describe("new-regime tax, FY 2025-26 onward", () => {
  it("₹12.75L gross → standard deduction → ₹12L taxable → s.87A → nil", () => {
    const t = computeAnnualTax(1_275_000, 2026);
    expect(t.taxableIncome).toBe(1_200_000);
    expect(t.taxOnSlabs).toBe(60_000);
    expect(t.rebate87A).toBe(60_000);
    expect(t.totalTax).toBe(0);
  });
  it("marginal relief just above the rebate limit", () => {
    const t = computeAnnualTax(1_285_000, 2026);       // taxable 12,10,000
    expect(t.taxOnSlabs).toBe(61_500);
    expect(t.taxAfterRebate).toBe(10_000);              // never more than the income over 12L
    expect(t.totalTax).toBe(10_400);
  });
  it("₹20L gross: slabs + cess", () => {
    const t = computeAnnualTax(2_000_000, 2026);       // taxable 19,25,000
    // 0 + 20,000 + 40,000 + 60,000 + 65,000 (16–19.25L @20%) = 1,85,000
    expect(t.taxOnSlabs).toBe(185_000);
    expect(t.rebate87A).toBe(0);
    expect(t.totalTax).toBe(192_400);
  });
  it("nothing below the standard deduction", () => {
    expect(computeAnnualTax(50_000, 2026).totalTax).toBe(0);
  });
});

describe("FY helpers", () => {
  it("period → FY start; FY → 12 periods April first", () => {
    expect(fyStartOfPeriod("2026-03")).toBe(2025);
    expect(fyStartOfPeriod("2026-04")).toBe(2026);
    const p = fyPeriods(2026);
    expect(p[0]).toBe("2026-04"); expect(p[11]).toBe("2027-03"); expect(p).toHaveLength(12);
  });
});

describe("s.192 monthly TDS estimate", () => {
  it("spreads the projected year's tax over the months left, net of TDS so far", () => {
    // ₹2L/month, paying October: 6 earlier months at 2L, 5 ahead → 24L gross → taxable 23.25L
    // → 20k + 40k + 60k + 80k + 81,250 = 2,81,250 + 4% cess = 2,92,500
    const earlier = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"].map((period) => ({ period, earned: 200_000, tds: 26_000 }));
    const e = estimateMonthlyTds({ period: "2026-10", thisMonthEarned: 200_000, earlier, monthlyGrossAhead: 200_000 });
    expect(e.monthsAhead).toBe(5);
    expect(e.projectedAnnual).toBe(2_400_000);
    expect(e.tax.totalTax).toBe(292_500);
    expect(e.tdsSoFar).toBe(156_000);
    expect(e.thisMonth).toBe(22_750);             // (2,92,500 − 1,56,000) ÷ 6
  });
  it("under the rebate limit → zero, with the reason", () => {
    const e = estimateMonthlyTds({ period: "2026-04", thisMonthEarned: 80_000, earlier: [], monthlyGrossAhead: 80_000 });
    expect(e.thisMonth).toBe(0);
    expect(e.note).toMatch(/87A/);
  });
  it("excess already deducted never gives a negative month", () => {
    const e = estimateMonthlyTds({ period: "2027-03", thisMonthEarned: 100_000, earlier: [{ period: "2026-04", earned: 100_000, tds: 50_000 }], monthlyGrossAhead: 0 });
    expect(e.thisMonth).toBe(0);
    expect(e.balanceTax).toBeLessThan(0);
  });
  it("ignores last year's payslips", () => {
    const e = estimateMonthlyTds({ period: "2026-04", thisMonthEarned: 200_000, earlier: [{ period: "2026-03", earned: 200_000, tds: 20_000 }], monthlyGrossAhead: 200_000 });
    expect(e.tdsSoFar).toBe(0);
    expect(e.projectedAnnual).toBe(2_400_000);
  });
});

describe("Form 16 working", () => {
  it("sums the FY's payslips, computes the year's tax and the short/excess deduction", () => {
    const slips = [
      { period: "2026-03", gross: 150_000, tds: 5_000 },                                   // last FY — out
      { period: "2026-04", gross: 150_000, lop_amount: 10_000, incentive: 0, pf: 1_800, tds: 4_000 },
      { period: "2026-05", gross: 150_000, incentive: 20_000, pf: 1_800, tds: 4_000 },
    ];
    const w = form16Working(slips, 2026);
    expect(w.fyLabel).toBe("2026-27");
    expect(w.monthsPaid).toBe(2);
    expect(w.rows.map((r) => r.earned)).toEqual([140_000, 170_000]);
    expect(w.tax.grossSalary).toBe(310_000);
    expect(w.tax.totalTax).toBe(0);
    expect(w.tdsDeducted).toBe(8_000);
    expect(w.balance).toBe(-8_000);
    expect(w.employeePf).toBe(3_600);
  });
});
