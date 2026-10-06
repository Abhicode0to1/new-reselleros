import { describe, it, expect } from "vitest";
import {
  buildWorkspaceLines,
  resolveMonthlyMsrp,
  TIER_FALLBACK_MONTHLY,
  type CatalogPriceRow,
} from "./workspace";

// Catalog row shaped like the real `items` rows for the buy-page tenant.
// Standard's India list price is ₹1,080/user/mo annual (R-157: the old ₹864 was an expired 20%-off promo).
const standardRow: CatalogPriceRow = {
  id: "gw-std", name: "Google Workspace Standard",
  msrp: 1080, wholesale: 620,
  prices: { annual: { msrp: 1080, wholesale: 620 } },
};

describe("buildWorkspaceLines — catalog is the single source of truth", () => {
  it("prices Standard from the catalog (₹1080/user/mo)", () => {
    const r = buildWorkspaceLines(standardRow, "standard", 10);
    expect(r.monthlyMsrp).toBe(1080);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].rate).toBe(1080 * 12);            // ₹12,960/seat/year
    expect(r.subtotal).toBe(1080 * 12 * 10);            // ₹1,29,600 ex-GST
    expect(r.amount).toBe(Math.round(129600 * 1.18));  // ₹1,52,928 incl 18% GST
  });

  it("PARITY: catalog-miss fallback equals the catalog price (no buy-vs-quote divergence)", () => {
    // The bug (#10): enquiry hardcoded a different rate than checkout's catalog.
    // Now the fallback tracks the catalog, so a missing row prices identically.
    const fromCatalog  = buildWorkspaceLines(standardRow, "standard", 25);
    const fromFallback = buildWorkspaceLines(null, "standard", 25);
    expect(fromFallback.monthlyMsrp).toBe(TIER_FALLBACK_MONTHLY.standard); // 1080
    expect(fromFallback.amount).toBe(fromCatalog.amount);
  });

  it("applies NO hardcoded first-20-seats promo split — flat per-seat", () => {
    // Promotions (e.g. Google's 20% off) are reflected in the catalog price
    // and/or the coupon/site-promo system, not a hardcoded per-seat split.
    const r = buildWorkspaceLines(standardRow, "standard", 30);
    expect(r.subtotal).toBe(1080 * 12 * 30);
    expect(r.items).toHaveLength(1);
  });

  it("falls back per tier when no catalog row (starter ₹270, enterprise ₹2400)", () => {
    expect(resolveMonthlyMsrp(null, "starter")).toBe(270);
    expect(resolveMonthlyMsrp(null, "enterprise")).toBe(2400);
    const starter = buildWorkspaceLines(null, "starter", 5);
    expect(starter.subtotal).toBe(270 * 12 * 5);
  });

  it("produces no line items when nothing can price the tier", () => {
    const r = buildWorkspaceLines({ ...standardRow, msrp: 0, prices: null }, "unknown-tier", 10);
    expect(r.items).toHaveLength(0);
    expect(r.amount).toBe(0);
  });

  it("prefers prices.annual.msrp over the legacy msrp column", () => {
    const row: CatalogPriceRow = {
      id: "x", name: "Google Workspace Standard", msrp: 999,
      wholesale: 620, prices: { annual: { msrp: 864, wholesale: 620 } },
    };
    expect(resolveMonthlyMsrp(row, "standard")).toBe(864);
  });
});
