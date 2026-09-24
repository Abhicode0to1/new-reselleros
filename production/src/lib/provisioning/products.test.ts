/**
 * One provisioning request per product in a paid quote (24 Sep 2026).
 *
 * The failure this exists for: a cart buying a domain AND hosting queued only the
 * hosting, so the paid domain was registered by nobody.
 */
import { describe, it, expect } from "vitest";
import { domainsInLines, provisioningProducts } from "./products";

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
