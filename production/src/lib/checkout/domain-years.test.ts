import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { cleanDomainYears, DOMAIN_YEAR_OPTIONS, MULTI_YEAR_DOMAINS_READY, multiYearDomainsOn, priceDomainYears, yearsLabel } from "./domain-years";
import { lineTotal } from "@/site/lib/money";

describe("the switch", () => {
  it("is OFF until the price, the queued years and the renewal date land", () => {
    expect(MULTI_YEAR_DOMAINS_READY).toBe(false);
    expect(multiYearDomainsOn({ NODE_ENV: "production" })).toBe(false);
  });
  it("a laptop can try it with NEXT_PUBLIC_MULTI_YEAR_DOMAINS_LOCAL=1; a production build ignores that", () => {
    expect(multiYearDomainsOn({ NODE_ENV: "development", NEXT_PUBLIC_MULTI_YEAR_DOMAINS_LOCAL: "1" })).toBe(true);
    expect(multiYearDomainsOn({ NODE_ENV: "development" })).toBe(false);
    expect(multiYearDomainsOn({ NODE_ENV: "production", NEXT_PUBLIC_MULTI_YEAR_DOMAINS_LOCAL: "1" })).toBe(false);
    expect(multiYearDomainsOn({ NODE_ENV: "production" }, true)).toBe(true);
  });
});

describe("cleanDomainYears / yearsLabel", () => {
  it("only the offered choices survive; anything else is 1", () => {
    for (const y of DOMAIN_YEAR_OPTIONS) expect(cleanDomainYears(y)).toBe(y);
    for (const bad of [0, 4, 11, -1, "3x", null, undefined, 2.5]) expect(cleanDomainYears(bad)).toBe(1);
    expect(cleanDomainYears("3")).toBe(3);
  });
  it("names the term", () => {
    expect(yearsLabel(1)).toBe("1 year");
    expect(yearsLabel(5)).toBe("5 years");
  });
});

describe("priceDomainYears — the tenure's own price, never the 1-year price multiplied", () => {
  const hit = { domain: "acme.in", price: 749, pricePerYearByTenure: { 3: 699 } };
  it("1 year is the 1-year price, switch or no switch", () => {
    expect(priceDomainYears(hit, 1, false)).toEqual({ ok: true, years: 1, perYear: 749, total: 749 });
  });
  it("3 years = the 3-year per-year price × 3", () => {
    expect(priceDomainYears(hit, 3, true)).toEqual({ ok: true, years: 3, perYear: 699, total: 2097 });
  });
  it("a tenure with no price is refused", () => {
    const r = priceDomainYears(hit, 5, true);
    expect(r.ok).toBe(false);
    expect(priceDomainYears({ domain: "acme.in", price: 749 }, 3, true).ok).toBe(false);
  });
  it("switched off, more than 1 year is refused with the way out", () => {
    const r = priceDomainYears(hit, 3, false);
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/set it to 1 year in the cart/) });
  });
  it("a years value off the list is refused", () => {
    expect(priceDomainYears(hit, 4, true).ok).toBe(false);
  });
});

describe("the cart shows years in its totals", () => {
  it("a row costs unit × qty × years", () => {
    expect(lineTotal({ unitPrice: 749, qty: 1 })).toBe(749);
    expect(lineTotal({ unitPrice: 749, qty: 1, years: 3 })).toBe(2247);
  });
  it("the cart page, drawer and checkout use lineTotal and send the years", () => {
    for (const f of ["src/app/(marketing)/cart/page.tsx", "src/site/components/cart/CartDrawer.tsx", "src/app/(marketing)/checkout/page.tsx"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toContain("lineTotal(l)");
      expect(src, f).not.toContain("l.unitPrice * l.qty");
    }
    expect(readFileSync("src/app/(marketing)/checkout/page.tsx", "utf8")).toMatch(/years: l\.years/);
    expect(readFileSync("src/app/(marketing)/cart/page.tsx", "utf8")).toContain("<DomainYearsPicker line={l} />");
    expect(readFileSync("src/site/components/cart/CartDrawer.tsx", "utf8")).toContain("<DomainYearsPicker line={l} />");
  });
});
