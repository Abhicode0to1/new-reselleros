import { describe, it, expect } from "vitest";
import { productKeyFor, extractTldPrice, type CustomerPricingMap } from "./index";

/**
 * The mapping and extraction are the two places a wrong answer becomes a wrong
 * PRICE on the public site, so they are pinned against a fixture shaped exactly
 * like customer-price.json (period-keyed string amounts, product-key names) —
 * the shapes measured from the engine's own wrapper, not invented.
 */
const PRICING: CustomerPricingMap = {
  dotin:  { addnewdomain: { "1": "799.0", "2": "1500.0" }, renewdomain: { "1": "899.0" }, transferdomain: { "1": "799.0" } },
  domcno: { addnewdomain: { "1": "949.0" }, renewdomain: { "1": "1099.0" }, transferdomain: { "1": "949.0" } },
  centralnicuscoin: {},
  thirdleveldotin: { addnewdomain: { "1": "649.0" }, renewdomain: { "1": "649.0" }, transferdomain: { "1": "649.0" } },
};

describe("productKeyFor — the TLD → ResellerClub product-key ladder", () => {
  it("uses the direct mapping first (in → dotin, com → domcno)", () => {
    expect(productKeyFor("in", PRICING)).toBe("dotin");
    expect(productKeyFor("com", PRICING)).toBe("domcno");
  });
  it("accepts a leading dot and mixed case", () => {
    expect(productKeyFor(".in", PRICING)).toBe("dotin");
    expect(productKeyFor("IN", PRICING)).toBe("dotin");
  });
  it("returns null for a TLD the price map doesn't carry — never a guess", () => {
    expect(productKeyFor("xyz", PRICING)).toBeNull();
  });
});

describe("extractTldPrice — the numbers that reach the public site", () => {
  it("register/renew/transfer are the 1-year amounts, rounded to whole rupees", () => {
    const p = extractTldPrice("in", PRICING);
    expect(p).toEqual({ tld: ".in", register: 799, renew: 899, transfer: 799, currency: "INR" });
  });
  it("a product with no price blocks yields nulls, not zeros or inventions", () => {
    const p = extractTldPrice("xyz", PRICING);
    expect(p.register).toBeNull();
    expect(p.renew).toBeNull();
    expect(p.transfer).toBeNull();
  });
  it("multi-year keys are ignored — only the 1-year price is quoted", () => {
    /* addnewdomain["2"] = 1500 exists for .in; the card must still say 799. */
    expect(extractTldPrice(".in", PRICING).register).toBe(799);
  });
});
