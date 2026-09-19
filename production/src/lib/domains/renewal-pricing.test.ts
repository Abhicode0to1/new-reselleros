import { describe, it, expect } from "vitest";
import { priceRenewal, rateForDomain, isRenewalTerm, type TldRate } from "./renewal-pricing";

/** A rate card shaped like `sync_domain_catalog` writes it. */
const RATES: TldRate[] = [
  { tld: ".in", itemId: "DOMAIN-IN-fbb976", renew: 750, wholesale: 520 },
  { tld: ".co.in", itemId: "DOMAIN-COIN-fbb976", renew: 640, wholesale: 430 },
  { tld: ".com", itemId: "DOMAIN-COM-fbb976", renew: 1150, wholesale: 890 },
  { tld: ".net", itemId: "DOMAIN-NET-fbb976", renew: null, wholesale: null },
  { tld: ".shop", itemId: "DOMAIN-SHOP-fbb976", renew: 0, wholesale: null },
];

describe("isRenewalTerm — the same bound rcRenewDomain enforces", () => {
  it.each([1, 2, 5, 10])("%i years is a term", (y) => expect(isRenewalTerm(y)).toBe(true));
  it.each([0, -1, 11, 100, 1.5, NaN, Infinity])("%p is not", (y) =>
    expect(isRenewalTerm(y as number)).toBe(false),
  );
});

describe("rateForDomain — longest suffix wins", () => {
  /* The one that costs money if wrong. `acme.co.in` ends with BOTH `.co.in` and
     `.in`; matching the shorter prices a .co.in renewal at the .in rate. */
  it("matches .co.in and not .in", () => {
    expect(rateForDomain("acme.co.in", RATES)?.tld).toBe(".co.in");
  });

  it("still matches .in for a plain .in", () => {
    expect(rateForDomain("acmecorp.in", RATES)?.tld).toBe(".in");
  });

  it("is not fooled by the order of the rate card", () => {
    /* Reversed input must give the same answer — otherwise the price depends on
       whatever order the catalogue query happened to return. */
    expect(rateForDomain("acme.co.in", [...RATES].reverse())?.tld).toBe(".co.in");
  });

  it("is case- and space-insensitive about the name", () => {
    expect(rateForDomain("  ACME.CO.IN  ", RATES)?.tld).toBe(".co.in");
  });

  it("matches a rate card entry stored without its leading dot", () => {
    expect(rateForDomain("acme.xyz", [{ tld: "xyz", itemId: "X", renew: 300, wholesale: null }])?.tld)
      .toBe("xyz");
  });

  it("returns null for an extension we do not sell", () => {
    expect(rateForDomain("acme.example", RATES)).toBeNull();
  });

  it("returns null for an empty rate card — the un-synced tenant", () => {
    expect(rateForDomain("acmecorp.in", [])).toBeNull();
  });

  it.each(["", "   "])("returns null for %p", (d) => {
    expect(rateForDomain(d, RATES)).toBeNull();
  });

  /* A bare name with no dot must not match a rate whose tld is a substring. */
  it("does not match a name with no extension", () => {
    expect(rateForDomain("acmecorp", RATES)).toBeNull();
  });
});

describe("priceRenewal — the happy path", () => {
  it("uses the RENEW price, not the register price", () => {
    const p = priceRenewal({ domain: "acmecorp.com", years: 1, rates: RATES });
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.perYear).toBe(1150);
      expect(p.subtotal).toBe(1150);
      expect(p.itemId).toBe("DOMAIN-COM-fbb976");
    }
  });

  it("multiplies for a multi-year term", () => {
    const p = priceRenewal({ domain: "acmecorp.in", years: 3, rates: RATES });
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.perYear).toBe(750);
      expect(p.subtotal).toBe(2250);
      /* Our cost for the whole term, so the margin on the quote is real. */
      expect(p.cost).toBe(1560);
    }
  });

  it("prices a .co.in at the .co.in rate", () => {
    const p = priceRenewal({ domain: "acme.co.in", years: 1, rates: RATES });
    expect(p.ok && p.subtotal).toBe(640);
  });

  it("reports no cost rather than zero when wholesale was never set", () => {
    /* Zero cost would show as 100% margin in every report. Null says unknown. */
    const p = priceRenewal({
      domain: "acme.xyz",
      years: 2,
      rates: [{ tld: ".xyz", itemId: "X", renew: 300, wholesale: null }],
    });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.cost).toBeNull();
  });
});

describe("priceRenewal — every refusal, and why it is a refusal", () => {
  /* The un-synced tenant. This database has ZERO DOMAIN-% items, so this is the
     state the feature actually starts in. */
  it("refuses when the rate card is empty", () => {
    const p = priceRenewal({ domain: "acmecorp.in", years: 1, rates: [] });
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.reason).toContain("acmecorp.in");
      expect(p.nextStep).toMatch(/Sync domains/i);
      /* And it says not to invent one, because inventing one costs real money. */
      expect(p.nextStep).toMatch(/by hand/i);
    }
  });

  it("refuses an extension that is not on the rate card", () => {
    const p = priceRenewal({ domain: "acme.example", years: 1, rates: RATES });
    expect(p.ok).toBe(false);
  });

  /* A null renew price means the feed did not carry the number. */
  it("refuses when the matched TLD has no renewal price", () => {
    const p = priceRenewal({ domain: "acme.net", years: 1, rates: RATES });
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.reason).toContain(".net");
      /* Names the catalogue row to fix, not just the problem. */
      expect(p.nextStep).toContain("DOMAIN-NET-fbb976");
    }
  });

  /* ─── ZERO IS REFUSED AS HARD AS NULL ────────────────────────────────────
     A rate card row with `renew: 0` is a feed that did not carry the number, not
     a free renewal. A ₹0 quote would be accepted, paid, and then filed at the
     registrar at real cost to the reseller's wallet. */
  it("refuses a zero renewal price rather than quoting ₹0", () => {
    const p = priceRenewal({ domain: "acme-new.shop", years: 1, rates: RATES });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toContain(".shop");
  });

  it.each([0, 11, -1, 2.5])("refuses %p years", (years) => {
    const p = priceRenewal({ domain: "acmecorp.in", years, rates: RATES });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.nextStep).toMatch(/1 to 10|between 1 and 10/i);
  });

  it("never returns a subtotal of zero or less on the ok path", () => {
    for (const d of ["acmecorp.in", "acme.co.in", "acmecorp.com"]) {
      for (const years of [1, 2, 10]) {
        const p = priceRenewal({ domain: d, years, rates: RATES });
        expect(p.ok, `${d} × ${years}`).toBe(true);
        if (p.ok) expect(p.subtotal).toBeGreaterThan(0);
      }
    }
  });

  it("every refusal carries both a reason and a next step", () => {
    const bad = [
      { domain: "acmecorp.in", years: 0 },
      { domain: "acme.example", years: 1 },
      { domain: "acme.net", years: 1 },
      { domain: "acme-new.shop", years: 1 },
    ];
    for (const args of bad) {
      const p = priceRenewal({ ...args, rates: RATES });
      expect(p.ok).toBe(false);
      if (!p.ok) {
        expect(p.reason.length).toBeGreaterThan(10);
        expect(p.nextStep.length).toBeGreaterThan(10);
        expect(p.nextStep).not.toBe(p.reason);
      }
    }
  });
});
