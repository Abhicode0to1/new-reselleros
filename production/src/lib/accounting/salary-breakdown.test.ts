import { describe, it, expect } from "vitest";
import { salaryBreakdown } from "./salary-breakdown";

describe("salaryBreakdown", () => {
  it("Abhishek, Sep 2026: ₹35,000 salary + ₹5,00,000 incentive = ₹5,35,000", () => {
    const b = salaryBreakdown({ gross: 35_000, incentive: 5_00_000, net: 5_35_000 });
    expect(b.lines.map((l) => [l.sign, l.label, l.amount])).toEqual([
      ["+", "Monthly salary (gross)", 35_000],
      ["+", "Incentive / commission", 5_00_000],
      ["=", "Earned", 5_35_000],
      ["=", "Net pay", 5_35_000],
    ]);
    expect(b.addsUp).toBe(true);
  });

  it("LOP and deductions appear only when present, and still add up", () => {
    const b = salaryBreakdown({ gross: 30_000, lop_days: 2, lop_amount: 2_000, tds: 1_000, pf: 1_800, esi: 225, net: 24_975, pf_employer: 1_800, esi_employer: 975 });
    expect(b.lines.map((l) => l.label)).toEqual(["Monthly salary (gross)", "Loss of pay", "Earned", "TDS (192)", "PF (employee)", "ESI (employee)", "Net pay"]);
    expect(b.addsUp).toBe(true);
    expect(b.employerCost).toBe(2_775);
  });

  it("a net that does not match the fields is flagged, not hidden", () => {
    expect(salaryBreakdown({ gross: 35_000, net: 70_000 }).addsUp).toBe(false);
  });
});
