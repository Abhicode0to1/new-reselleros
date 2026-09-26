import { describe, it, expect } from "vitest";
import {
  fyLabel, fyStartYearOf, gstPaidForPeriods, gstPaidForFy, incomeTaxPaidForFy, type TaxPaymentLike,
} from "./tax-payments";

const gst = (period: string, amount: number): TaxPaymentLike => ({ kind: "gst", amount, period, fy: null });
const it_ = (kind: "advance_tax" | "self_assessment_tax", fy: string, amount: number): TaxPaymentLike =>
  ({ kind, amount, period: null, fy });

describe("tax payment sums", () => {
  const payments = [
    gst("2026-03", 5000),   // March 2026 → FY 2025-26, even if paid in April
    gst("2026-04", 10000),
    gst("2027-03", 7000),   // last month of FY 2026-27
    it_("advance_tax", "2026-27", 50000),
    it_("self_assessment_tax", "2026-27", 3000),
    it_("advance_tax", "2025-26", 40000),
  ];

  it("GST belongs to the return month's FY, not the payment date's", () => {
    expect(gstPaidForFy(payments, 2026)).toBe(17000);
    expect(gstPaidForFy(payments, 2025)).toBe(5000);
  });

  it("GST for a range of return months", () => {
    expect(gstPaidForPeriods(payments, "2026-04", "2026-06")).toBe(10000);
    expect(gstPaidForPeriods(payments, "2026-05", "2026-05")).toBe(0);
  });

  it("income tax for a FY adds advance and self-assessment, and never GST", () => {
    expect(incomeTaxPaidForFy(payments, 2026)).toBe(53000);
    expect(incomeTaxPaidForFy(payments, 2025)).toBe(40000);
  });

  it("GST sums never include income tax", () => {
    expect(gstPaidForPeriods(payments, "2000-01", "2099-12")).toBe(22000);
  });
});

describe("FY helpers", () => {
  it("fyLabel", () => {
    expect(fyLabel(2026)).toBe("2026-27");
    expect(fyLabel(2099)).toBe("2099-00");
  });
  it("fyStartYearOf", () => {
    expect(fyStartYearOf("2026-04-01")).toBe(2026);
    expect(fyStartYearOf("2027-03-31")).toBe(2026);
    expect(fyStartYearOf("2026-03")).toBe(2025);
  });
});
