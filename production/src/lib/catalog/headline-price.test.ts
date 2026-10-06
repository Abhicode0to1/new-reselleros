import { describe, it, expect } from "vitest";
import { headlinePrice, isOwnService } from "./headline-price";

describe("headlinePrice (2 Oct 2026)", () => {
  it("a monthly row shows its per-month msrp", () => {
    expect(headlinePrice({ msrp: 136, prices: {} })).toEqual({ amount: 136, unit: "mo" });
  });
  it("a yearly-total plan shows the year, not ₹0/mo", () => {
    expect(headlinePrice({ msrp: 0, prices: { annual_total: { msrp: 9996, wholesale: 0 } } })).toEqual({ amount: 9996, unit: "yr" });
  });
  it("a free plan stays ₹0/mo", () => {
    expect(headlinePrice({ msrp: 0, prices: null })).toEqual({ amount: 0, unit: "mo" });
  });
  it("support is own service", () => {
    expect(isOwnService({ vendor: "support" })).toBe(true);
    expect(isOwnService({ vendor: "google" })).toBe(false);
  });
});
