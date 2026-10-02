import { describe, it, expect } from "vitest";
import { computeMrrAnalytics, type SubscriptionRow } from "./mrr-analytics";

const row = (o: Partial<SubscriptionRow>): SubscriptionRow => ({
  id: "s", status: "active", vendor: "google", seats: 10, mrr: 2700, vendor_cost_per_seat_month: 110, ...o,
});

describe("MRR analytics (from stored subscriptions.mrr)", () => {
  it("revenue is the stored mrr, not seats × catalogue price", () => {
    const a = computeMrrAnalytics([row({ mrr: 2500 })]);   // agreed price below list
    expect(a.total_mrr_rupees).toBe(2500);
    expect(a.total_arr_rupees).toBe(30000);
  });

  it("a yearly or quarterly subscription is not multiplied — mrr is already monthly", () => {
    const a = computeMrrAnalytics([row({ id: "y", mrr: 125 }), row({ id: "q", mrr: 300 })]);
    expect(a.total_mrr_rupees).toBe(425);
  });

  it("cost = vendor cost per seat-month × seats; margin over costed subscriptions", () => {
    const a = computeMrrAnalytics([row({})]);
    expect(a.total_monthly_cost_rupees).toBe(1100);
    expect(a.overall_margin_percentage).toBe(59.26);
    expect(a.by_line.google.margin_percentage).toBe(59.26);
  });

  it("no vendor cost → counted as unknown, never guessed, and left out of the margin", () => {
    const a = computeMrrAnalytics([row({}), row({ id: "h", vendor: "hosting", mrr: 1000, vendor_cost_per_seat_month: null })]);
    expect(a.cost_unknown).toBe(1);
    expect(a.total_mrr_rupees).toBe(3700);
    expect(a.overall_margin_percentage).toBe(59.26);       // the hosting ₹1,000 is not "100% margin"
    expect(a.by_line.hosting.margin_percentage).toBeNull();
  });

  it("only active subscriptions; unknown vendor goes to Other", () => {
    const a = computeMrrAnalytics([row({ status: "cancelled" }), row({ status: "paused" }), row({ vendor: "weird" })]);
    expect(a.total_active_subscriptions).toBe(1);
    expect(a.by_line.other.active_subscriptions).toBe(1);
  });
});
