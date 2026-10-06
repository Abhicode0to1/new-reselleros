/**
 * R-156 (5 Oct 2026): a domain can be bought for 1, 2, 3 or 5 years. Every rule here is a
 * money rule — what the registry's price list means, what the checkout charges, what the
 * yearly-hosting bundle still covers — so each is pinned on its own.
 */
import { describe, it, expect } from "vitest";
import { periodTotals } from "@/lib/resellerclub";
import { cleanTermPrices, DOMAIN_TERMS } from "@/lib/domains/live-lookup";
import { termTotal, bundledDomainRate } from "@/lib/checkout/cart-checkout";
import { domainTermPrice } from "@/site/lib/money";

describe("periodTotals — ResellerClub's period block is a PER-YEAR rate", () => {
  it("total = rate × years, whole rupees", () => {
    expect(periodTotals({ "1": "799.0", "2": "749.5", "3": 720 })).toEqual({ "1": 799, "2": 1499, "3": 2160 });
  });
  it("skips junk: 0, negative, non-numbers, terms outside 1–10", () => {
    expect(periodTotals({ "1": "0", "2": "-5", "3": "abc", "11": "500", x: "1" } as never)).toEqual({});
    expect(periodTotals(undefined)).toEqual({});
  });
});

describe("cleanTermPrices — only offered terms, '1' always the sold 1-year price", () => {
  it("keeps 2/3/5 when priced, drops 4 and 10 (not offered)", () => {
    expect(DOMAIN_TERMS).toEqual([1, 2, 3, 5]);
    expect(cleanTermPrices({ "1": 1, "2": 1500, "3": 2200, "4": 2900, "5": 3600, "10": 7000 }, 799))
      .toEqual({ "1": 799, "2": 1500, "3": 2200, "5": 3600 });
  });
  it("a registry with no multi-year prices → one year only", () => {
    expect(cleanTermPrices(undefined, 799)).toEqual({ "1": 799 });
    expect(cleanTermPrices({ "2": 0, "3": "x" }, 799)).toEqual({ "1": 799 });
  });
});

describe("termTotal — what the checkout charges for a term", () => {
  const hit = { price: 799, prices: { "1": 799, "2": 1500, "3": 2200 } };
  it("the registry's own total for the term", () => {
    expect(termTotal(hit, 1)).toBe(799);
    expect(termTotal(hit, 3)).toBe(2200);
  });
  it("a term the registry did not price is refused (null) — never 799 × 5", () => {
    expect(termTotal(hit, 5)).toBeNull();
    expect(termTotal({ price: 799 }, 2)).toBeNull();
  });
});

describe("bundle: yearly hosting makes the FIRST year free, not the whole term", () => {
  it("3 years at ₹2,200 with a ₹799 first year → ₹1,401 to pay", () => {
    expect(bundledDomainRate(2200, 799)).toBe(1401);
  });
  it("a 1-year bundled domain is still ₹0", () => {
    expect(bundledDomainRate(799, 799)).toBe(0);
  });
  it("never negative", () => {
    expect(bundledDomainRate(500, 799)).toBe(0);
  });
  it("the cart shows the same figures the checkout charges", () => {
    const prices = { "1": 799, "3": 2200 };
    expect(domainTermPrice(prices, 3)).toBe(2200);
    expect(domainTermPrice(prices, 3, true)).toBe(bundledDomainRate(2200, 799));
    expect(domainTermPrice(prices, 1, true)).toBe(0);
    expect(domainTermPrice(prices, 5)).toBeNull();
  });
});
