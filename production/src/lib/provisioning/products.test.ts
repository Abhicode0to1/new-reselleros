/**
 * One provisioning request per product in a paid quote (24 Sep 2026).
 *
 * The failure this exists for: a cart buying a domain AND hosting queued only the
 * hosting, so the paid domain was registered by nobody.
 */
import { describe, it, expect } from "vitest";
import { domainsInLines, domainLineYears, isDomainPurchaseLine, provisioningProducts, productShare, productAmountPaid } from "./products";

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
      { vendor: "domain", domain: "acme.in", seats: 1, years: 1 },
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
      { vendor: "domain", domain: "a.in", seats: 1, years: 1 },
      { vendor: "domain", domain: "a.com", seats: 1, years: 1 },
    ]);
  });

  it("a quote raised in the app (no named domain lines) keeps its single request", () => {
    expect(provisioningProducts({ lineItems: [line("Business Starter")], vendor: "google", domain: "x.in", seats: 12 }))
      .toEqual([{ vendor: "google", domain: "x.in", seats: 12 }]);
    expect(provisioningProducts({ lineItems: [line(".in registration")], vendor: "domain", domain: "y.in", seats: 1 }))
      .toEqual([{ vendor: "domain", domain: "y.in", seats: 1, years: 1 }]);
  });

  it("the same domain twice is one request, not two", () => {
    expect(domainsInLines([line("Domain x.in", "x.in"), line("x.in", "x.in")])).toEqual(["x.in"]);
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
    expect(productAmountPaid({ vendor: "domain", domain: "extra.com", seats: 1, years: 1 }, lines, paid)).toBe(Math.round(paid * 900 / 2100));
  });
  it("a hosting account gets its own line's part", () => {
    expect(productAmountPaid({ vendor: "hosting", domain: "shop.in", seats: 1 }, lines, paid)).toBe(Math.round(paid * 1200 / 2100));
  });
  it("a ₹0 domain bundled with hosting is covered by its hosting line", () => {
    expect(productShare({ vendor: "domain", domain: "shop.in", seats: 1, years: 1 }, lines)).toBeCloseTo(1200 / 2100);
  });
  it("the separate rows never add up to more than the payment for priced products", () => {
    const priced = productAmountPaid({ vendor: "domain", domain: "extra.com", seats: 1, years: 1 }, lines, paid)
      + productAmountPaid({ vendor: "hosting", domain: "shop.in", seats: 1 }, lines, paid);
    expect(priced).toBeLessThanOrEqual(paid + 1);
  });
  it("a licence takes the lines that are not domains or hosting", () => {
    const mixed = [{ name: "Business Starter", rate: 1632, qty: 10, domain: "acme.in" }, { name: "Domain acme.in", rate: 900, qty: 1, domain: "acme.in" }];
    expect(productShare({ vendor: "google", domain: null, seats: 10 }, mixed)).toBeCloseTo(16320 / 17220);
  });
  it("line discounts count; no priced lines → the whole payment, as before", () => {
    expect(productShare({ vendor: "domain", domain: "a.in", seats: 1, years: 1 }, [{ name: "a.in", rate: 1000, qty: 1, domain: "a.in", discount_pct: 50 }, { name: "b.in", rate: 500, qty: 1, domain: "b.in" }])).toBeCloseTo(0.5);
    expect(productShare({ vendor: "domain", domain: "a.in", seats: 1, years: 1 }, [])).toBe(1);
    expect(productShare({ vendor: "domain", domain: "a.in", seats: 1, years: 1 }, [{ rate: 0, qty: 1, domain: "a.in" }])).toBe(1);
  });
});

/* 3 Oct 2026: a Workspace line names the domain its seats run on. Paying for it must not
   queue that domain for REGISTRATION, nor file a domain subscription that later bills a
   renewal for a domain the customer never bought from us. */
describe("a line that only NAMES a domain is not a domain sale", () => {
  const ws = { name: "Google Workspace Business Starter", rate: 1632, qty: 10, domain: "acme.in", item_id: "ITEM-WS" };
  const dom = { name: ".in Domain", rate: 900, qty: 1, domain: "new.in", item_id: "ITEM-DOM" };
  const domainIds = new Set(["ITEM-DOM"]);

  it("a Workspace line with a domain queues only the licence", () => {
    expect(provisioningProducts({ lineItems: [ws], vendor: "google", domain: "acme.in", seats: 10, domainItemIds: new Set() }))
      .toEqual([{ vendor: "google", domain: "acme.in", seats: 10 }]);
    // and without the catalogue answer, the name decides — still not a domain
    expect(domainsInLines([ws])).toEqual([]);
  });
  it("a domain catalogue item alongside it is still registered", () => {
    expect(domainsInLines([ws, dom], domainIds)).toEqual(["new.in"]);
  });
  it("a catalogue item decides over the wording of its name", () => {
    expect(isDomainPurchaseLine({ ...ws, name: "Workspace for the domain acme.in" }, domainIds)).toBe(false);
    expect(isDomainPurchaseLine({ ...dom, name: ".in" }, domainIds)).toBe(true);
  });
  it("a cart domain line (it carries a registrant) always counts", () => {
    expect(isDomainPurchaseLine({ name: "anything", domain: "x.in", registrant: { name: "A" } })).toBe(true);
  });
  it("the Workspace line keeps its share of the payment as the licence", () => {
    expect(productShare({ vendor: "google", domain: "acme.in", seats: 10 }, [ws, dom], domainIds)).toBeCloseTo(16320 / 17220);
    expect(productShare({ vendor: "domain", domain: "new.in", seats: 1, years: 1 }, [ws, dom], domainIds)).toBeCloseTo(900 / 17220);
  });
});

/* R-031 (5 Oct 2026): the paid term travels from the domain line to the queued row, where
   the register-domains cron reads it (R-035). Before, every domain was registered for one
   year whatever was paid. */
describe("domain years (R-031)", () => {
  const reg = { name: "A", email: "a@x.in" };
  const dom = (domain: string, years?: unknown) => ({ id: "d", name: `Domain ${domain} — registration`, qty: 1, rate: 900, cost: 0, domain, registrant: reg, ...(years === undefined ? {} : { years }) });

  it("a 3-year domain line queues a row with years = 3", () => {
    expect(provisioningProducts({ lineItems: [dom("acme.in", 3)], vendor: "domain", domain: null, seats: 1 }))
      .toEqual([{ vendor: "domain", domain: "acme.in", seats: 1, years: 3 }]);
  });

  it("an old line with no years reads as 1", () => {
    expect(provisioningProducts({ lineItems: [dom("acme.in")], vendor: "domain", domain: null, seats: 1 }))
      .toEqual([{ vendor: "domain", domain: "acme.in", seats: 1, years: 1 }]);
  });

  it("each domain keeps its own term in a mixed cart with hosting", () => {
    const out = provisioningProducts({
      lineItems: [dom("a.in", 2), dom("b.com", 5), { id: "h", name: "Starter hosting", qty: 1, rate: 1200, cost: 0, hostingPlan: "starter", hostingDomain: "a.in" }],
      vendor: "hosting", domain: "a.in", seats: 3,
    });
    expect(out.filter((p) => p.vendor === "domain")).toEqual([
      { vendor: "domain", domain: "a.in", seats: 1, years: 2 },
      { vendor: "domain", domain: "b.com", seats: 1, years: 5 },
    ]);
    expect(out.find((p) => p.vendor === "hosting")?.years).toBeUndefined();
  });

  it("never guesses upward: junk, 0, 11, fractions and strings of words all read as 1", () => {
    for (const y of [0, 11, 2.5, -3, "three", null, NaN, {}]) expect(domainLineYears({ years: y })).toBe(1);
    expect(domainLineYears({ years: "4" })).toBe(4); // a stored JSON string number is still the number
    expect(domainLineYears({ years: 10 })).toBe(10);
  });

  it("the same name on two lines keeps the first line's term", () => {
    expect(provisioningProducts({ lineItems: [dom("a.in", 2), dom("A.IN", 7)], vendor: "domain", domain: null, seats: 2 }))
      .toEqual([{ vendor: "domain", domain: "a.in", seats: 1, years: 2 }]);
  });
});
