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
  /* Shaped exactly like the live account's .ai on 17 Sep 2026: the registry sells
     a 2-YEAR MINIMUM, so there is no "1" key anywhere in the product. */
  dotai: { addnewdomain: { "2": 8806.8 }, renewdomain: { "2": 9346.8 }, transferdomain: { "2": 9346.8 } },
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

  /* .co.in is one of the FIVE TLDs every search on this site asks for
     (DEFAULT_TLDS, in both the public route and site/lib/domain-search), and
     until 16 Sep 2026 it resolved to nothing: ResellerClub files it under the
     third-level .in product, which no rung of the ladder spelled. Measured
     against the live account that day — .in ₹863, .com ₹1199, .org ₹1350,
     .net ₹1559, and .co.in "Price on request", every single time. */
  it("finds a multi-level TLD under its third-level product (co.in → thirdleveldotin)", () => {
    expect(productKeyFor("co.in", PRICING)).toBe("thirdleveldotin");
    expect(productKeyFor(".CO.IN", PRICING)).toBe("thirdleveldotin");
  });
  it("does not invent a third-level key for an ordinary TLD", () => {
    /* "net" must never become "thirdleveldotnet" — the rung only fires on a
       dotted TLD, so a single-label miss stays an honest null. */
    expect(productKeyFor("net", PRICING)).toBeNull();
  });
});

describe("extractTldPrice — the numbers that reach the public site", () => {
  it("register/renew/transfer are the shortest-term amounts, rounded to whole rupees", () => {
    const p = extractTldPrice("in", PRICING);
    expect(p).toEqual({ tld: ".in", register: 799, renew: 899, transfer: 799, years: 1, currency: "INR" });
  });

  /* .ai is the one product on the live account with no 1-year price — the
     registry sells it in 2-year minimum terms. Reading only block["1"] reported
     it as UNPRICED, so the search said "Price on request" for a TLD the site
     advertises at 6,999, and nothing anywhere said why. */
  it("a TLD sold in a 2-year minimum term reports its real price AND its term", () => {
    const p = extractTldPrice("ai", PRICING);
    expect(p.register).toBe(8807);
    expect(p.renew).toBe(9347);
    expect(p.years).toBe(2);
  });
  it("an ordinary TLD still reports a 1-year term", () => {
    expect(extractTldPrice("in", PRICING).years).toBe(1);
    expect(extractTldPrice("co.in", PRICING).years).toBe(1);
  });
  it("a TLD with no price at all reports years 1 rather than 0 or NaN", () => {
    /* Nothing should divide by it or render "for 0 years" — the term is only
       meaningful next to an amount, and there is no amount here. */
    expect(extractTldPrice("xyz", PRICING).years).toBe(1);
  });
  it("a product with no price blocks yields nulls, not zeros or inventions", () => {
    const p = extractTldPrice("xyz", PRICING);
    expect(p.register).toBeNull();
    expect(p.renew).toBeNull();
    expect(p.transfer).toBeNull();
  });
  it("a .co.in card now carries a real number instead of \"Price on request\"", () => {
    const p = extractTldPrice("co.in", PRICING);
    expect(p).toEqual({ tld: ".co.in", register: 649, renew: 649, transfer: 649, years: 1, currency: "INR" });
  });
  it("a longer term never wins when a shorter one exists", () => {
    /* addnewdomain["2"] = 1500 exists for .in; the card must still say 799. */
    expect(extractTldPrice(".in", PRICING).register).toBe(799);
    expect(extractTldPrice(".in", PRICING).years).toBe(1);
  });
});
