/**
 * One provisioning request per product in a paid quote (24 Sep 2026).
 *
 * The failure this exists for: a cart buying a domain AND hosting queued only the
 * hosting, so the paid domain was registered by nobody.
 */
import { describe, it, expect } from "vitest";
import { domainsInLines, provisioningProducts, productShare, productAmountPaid } from "./products";

const line = (name: string, domain?: string) => ({ id: "x", name, qty: 1, rate: 1, cost: 0, ...(domain ? { domain } : {}) });

describe("provisioningProducts", () => {
  it("domain + hosting in one cart → BOTH are queued", () => {
    const out = provisioningProducts({
      lineItems: [line("Domain acme.in — registration, 1 year", "acme.in"), line("Starter hosting (billed yearly)")],
      vendor: "hosting",
      domain: "acme.in",
      seats: 2,
    });
    expect(out).toEqual([
      { vendor: "domain", domain: "acme.in", seats: 1 },
      { vendor: "hosting", domain: "acme.in", seats: 1 },
    ]);
  });

  it("a domain-only cart queues each named domain, nothing else", () => {
    const out = provisioningProducts({
      lineItems: [line("Domain a.in", "a.in"), line("Domain a.com", "A.COM")],
      vendor: "domain",
      domain: null,
      seats: 2,
    });
    expect(out).toEqual([
      { vendor: "domain", domain: "a.in", seats: 1 },
      { vendor: "domain", domain: "a.com", seats: 1 },
    ]);
  });

  it("a quote raised in the app (no named domain lines) keeps its single request", () => {
    expect(provisioningProducts({ lineItems: [line("Business Starter")], vendor: "google", domain: "x.in", seats: 12 }))
      .toEqual([{ vendor: "google", domain: "x.in", seats: 12 }]);
    expect(provisioningProducts({ lineItems: [line(".in registration")], vendor: "domain", domain: "y.in", seats: 1 }))
      .toEqual([{ vendor: "domain", domain: "y.in", seats: 1 }]);
  });

  it("the same domain twice is one request, not two", () => {
    expect(domainsInLines([line("a", "x.in"), line("b", "x.in")])).toEqual(["x.in"]);
  });

  it("ignores junk line items", () => {
    expect(domainsInLines(null)).toEqual([]);
    expect(domainsInLines([null, 3, { domain: "" }, { domain: 5 }])).toEqual([]);
  });
});

describe("R-033 — each row carries only its own share of the payment", () => {
  const lines = [
    { name: "Hosting Starter", rate: 1200, qty: 1, hostingPlan: "Starter", hostingDomain: "shop.in" },
    { name: "Domain shop.in", rate: 0, qty: 1, domain: "shop.in" },          // bundled free with yearly hosting
    { name: "Domain extra.com", rate: 900, qty: 1, domain: "extra.com" },
  ];
  const paid = Math.round((1200 + 900) * 1.18); // ₹2,478 incl. GST

  it("a paid domain gets its own line's part, not the whole order", () => {
    expect(productAmountPaid({ vendor: "domain", domain: "extra.com", seats: 1 }, lines, paid)).toBe(Math.round(paid * 900 / 2100));
  });
  it("a hosting account gets its own line's part", () => {
    expect(productAmountPaid({ vendor: "hosting", domain: "shop.in", seats: 1 }, lines, paid)).toBe(Math.round(paid * 1200 / 2100));
  });
  it("a ₹0 domain bundled with hosting is covered by its hosting line", () => {
    expect(productShare({ vendor: "domain", domain: "shop.in", seats: 1 }, lines)).toBeCloseTo(1200 / 2100);
  });
  it("the separate rows never add up to more than the payment for priced products", () => {
    const priced = productAmountPaid({ vendor: "domain", domain: "extra.com", seats: 1 }, lines, paid)
      + productAmountPaid({ vendor: "hosting", domain: "shop.in", seats: 1 }, lines, paid);
    expect(priced).toBeLessThanOrEqual(paid + 1);
  });
  it("a licence takes the lines that are not domains or hosting", () => {
    const mixed = [{ rate: 1632, qty: 10 }, { rate: 900, qty: 1, domain: "acme.in" }];
    expect(productShare({ vendor: "google", domain: null, seats: 10 }, mixed)).toBeCloseTo(16320 / 17220);
  });
  it("line discounts count; no priced lines → the whole payment, as before", () => {
    expect(productShare({ vendor: "domain", domain: "a.in", seats: 1 }, [{ rate: 1000, qty: 1, domain: "a.in", discount_pct: 50 }, { rate: 500, qty: 1, domain: "b.in" }])).toBeCloseTo(0.5);
    expect(productShare({ vendor: "domain", domain: "a.in", seats: 1 }, [])).toBe(1);
    expect(productShare({ vendor: "domain", domain: "a.in", seats: 1 }, [{ rate: 0, qty: 1, domain: "a.in" }])).toBe(1);
  });
});
