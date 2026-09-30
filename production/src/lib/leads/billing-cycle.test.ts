import { describe, it, expect } from "vitest";
import { BILLING_CYCLE_OPTIONS, billingCycleLabel, monthlyBill, toBillingCycle } from "./billing-cycle";

describe("R-071 — billing cycle", () => {
  it("offers exactly the two values the column's CHECK allows", () => {
    expect(BILLING_CYCLE_OPTIONS.map((o) => o.value).sort()).toEqual(["monthly", "yearly"]);
  });

  it("form → column: blank or unknown is null, never a guessed cycle", () => {
    expect(toBillingCycle("monthly")).toBe("monthly");
    expect(toBillingCycle("yearly")).toBe("yearly");
    expect(toBillingCycle("")).toBeNull();
    expect(toBillingCycle("weekly")).toBeNull();
    expect(toBillingCycle(undefined)).toBeNull();
  });

  it("value stays annual — a monthly deal shows one month's bill, rounded to the rupee", () => {
    // 10 seats × ₹1,472/seat/month × 12 = ₹1,76,640 a year → ₹14,720 a month
    expect(monthlyBill(176_640)).toBe(14_720);
    expect(monthlyBill(100)).toBe(8);
    expect(monthlyBill(0)).toBeNull();
    expect(monthlyBill(null)).toBeNull();
  });

  it("labels", () => {
    expect(billingCycleLabel("monthly")).toBe("Monthly");
    expect(billingCycleLabel("yearly")).toBe("Yearly");
    expect(billingCycleLabel(null)).toBe("");
  });
});
