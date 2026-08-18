import { describe, it, expect } from "vitest";
import {
  buildPnl, vendorLine, vendorLabel, cogsBasisNote, compareFigures, isPartialPeriod,
  RESOLD_VENDORS, monthsActiveInPeriod, vendorsFromSubscriptions,
  type VendorInput, type SubscriptionCost,
} from "./pnl";

const google = (over: Partial<VendorInput> = {}): VendorInput => ({
  vendor: "google", revenue: 108_552, billedCost: null, estimatedCost: 70_340,
  seats: 199, subscriptions: 9, ...over,
});
const support = (over: Partial<VendorInput> = {}): VendorInput => ({
  vendor: "support", revenue: 2_499, billedCost: null, estimatedCost: 0,
  seats: 4, subscriptions: 4, ...over,
});

/**
 * ─── THE BUG THIS MODULE EXISTS TO FIX ──────────────────────────────────────
 * /accounting/pnl read COGS from `vendor_bills`, which has ZERO rows on the live tenant,
 * and therefore reported a 100% gross margin. A reseller does not have a 100% margin —
 * they buy licences and sell them. The cost was never missing from the app, only from
 * that table: the subscriptions carry ₹70,340/month of wholesale against ₹1,08,552 of MRR.
 */
describe("a reseller does not have a 100% margin", () => {
  it("uses the wholesale rate when no vendor bill exists, and says so", () => {
    const p = buildPnl({ revenue: 111_051, expenses: 0, billedCogs: null, vendors: [google(), support()] });
    expect(p.cogs).toBe(70_340);
    expect(p.cogsBasis).toBe("estimated");
    expect(p.grossMarginPct).toBe(37);
    expect(cogsBasisNote(p)).toMatch(/wholesale-to-price ratio/);
  });

  it("never reports the old ₹0 COGS as a 100% margin", () => {
    /* The exact regression. Revenue against a resold vendor with no cost of any kind is
       not profit — it is a gap in the data. */
    const p = buildPnl({
      revenue: 108_552, expenses: 0, billedCogs: null,
      vendors: [google({ estimatedCost: 0 })],
    });
    expect(p.grossMarginPct).not.toBe(100);
    expect(p.grossMarginPct).toBeNull();
    expect(p.cogsBasis).toBe("unknown");
    expect(cogsBasisNote(p)).toMatch(/never 100% profit/);
  });

  it("prefers a real vendor bill over the rate card", () => {
    /* A CA can sign off on an invoice, not on a price list. */
    const p = buildPnl({ revenue: 111_051, expenses: 0, billedCogs: 68_000, vendors: [google(), support()] });
    expect(p.cogs).toBe(68_000);
    expect(p.cogsBasis).toBe("billed");
    expect(cogsBasisNote(p)).toMatch(/From vendor bills/);
  });

  it("subtracts operating expenses only AFTER gross margin", () => {
    /* Salaries are not cost of goods. Folding them into COGS would make the gross margin
       look like the net one and hide which half of the business is the problem. */
    const p = buildPnl({ revenue: 111_051, expenses: 30_000, billedCogs: null, vendors: [google(), support()] });
    expect(p.grossMargin).toBe(40_711);
    expect(p.netProfit).toBe(10_711);
  });

  it("leaves net profit null when the gross margin is unknowable", () => {
    /* A net profit computed from an unknown COGS is a number somebody will report. */
    const p = buildPnl({
      revenue: 50_000, expenses: 10_000, billedCogs: null,
      vendors: [google({ estimatedCost: 0 })],
    });
    expect(p.grossMargin).toBeNull();
    expect(p.netProfit).toBeNull();
  });
});

/**
 * ─── A ZERO COST MEANS TWO DIFFERENT THINGS ─────────────────────────────────
 * Borrowed from lib/subscriptions/margin.ts, which already reasoned this out.
 */
describe("zero cost — missing data, or genuinely free?", () => {
  it("calls a resold vendor at zero cost UNKNOWN, not free", () => {
    const v = vendorLine(google({ estimatedCost: 0 }));
    expect(v.marginPct).toBeNull();
    expect(v.marginNote).toMatch(/cannot have a 100% margin/);
  });

  it("calls the reseller's OWN support product 100%, because it is", () => {
    /* ANUTECH's 4 support subscriptions really do carry ₹0 wholesale — that is their own
       service, not an unfilled field. */
    const v = vendorLine(support());
    expect(v.marginPct).toBe(100);
    expect(v.marginNote).toBeNull();
  });

  it("knows which vendors are resold", () => {
    for (const v of ["google", "microsoft", "zoho"]) expect(RESOLD_VENDORS.has(v)).toBe(true);
    expect(RESOLD_VENDORS.has("support")).toBe(false);
  });

  it("names the vendor in the note, so the fix has an address", () => {
    expect(vendorLine(google({ estimatedCost: 0 })).marginNote).toContain("Google Workspace");
  });

  it("reports no margin on a vendor with no revenue, rather than −100%", () => {
    const v = vendorLine(google({ revenue: 0, estimatedCost: 5_000 }));
    expect(v.marginPct).toBeNull();
    expect(v.marginNote).toMatch(/No revenue in this period/);
  });
});

describe("the vendor split", () => {
  const p = buildPnl({ revenue: 111_051, expenses: 0, billedCogs: null, vendors: [support(), google()] });

  it("computes each vendor's own margin", () => {
    const g = p.byVendor.find((v) => v.vendor === "google")!;
    expect(g.cost).toBe(70_340);
    expect(g.gross).toBe(38_212);
    expect(g.marginPct).toBe(35);   // the healthy reseller number the owner needed
  });

  it("orders by revenue, so the book that matters is first", () => {
    expect(p.byVendor.map((v) => v.vendor)).toEqual(["google", "support"]);
  });

  it("labels vendors in the customer's words, not the column's", () => {
    expect(vendorLabel("google")).toBe("Google Workspace");
    expect(vendorLabel("microsoft")).toBe("Microsoft 365");
    expect(vendorLabel("support")).toBe("In-House Support");
  });

  it("passes an unmapped vendor through rather than showing a blank", () => {
    expect(vendorLabel("aws")).toBe("aws");
  });

  it("does not invent a tab for a vendor with no rows", () => {
    /* Live data has google and support only. A Microsoft tab reading ₹0 would look like a
       business that is failing at Microsoft rather than one not selling it. */
    expect(p.byVendor.map((v) => v.vendor)).not.toContain("microsoft");
  });
});

/**
 * ─── COMPARISON: TWO TRAPS THAT PRODUCE CONFIDENT NONSENSE ──────────────────
 */
describe("period comparison", () => {
  it("reports ordinary growth as a percentage", () => {
    const d = compareFigures(120_000, 100_000);
    expect(d.kind).toBe("up");
    expect(d.pct).toBe(20);
    expect(d.label).toBe("+20%");
  });

  it("reports a fall with its sign intact", () => {
    const d = compareFigures(80_000, 100_000);
    expect(d.kind).toBe("down");
    expect(d.label).toBe("-20%");
  });

  it("calls growth from ZERO 'new', not +100% and not infinity", () => {
    /* ₹0 → ₹50,000 is not a percentage. It is new business, and a percentage there is
       arithmetic nobody can act on. */
    const d = compareFigures(50_000, 0);
    expect(d.kind).toBe("new");
    expect(d.pct).toBeNull();
    expect(d.label).toBe("new this period");
    expect(Number.isFinite(d.absolute)).toBe(true);
  });

  it("calls a drop to zero 'nothing this period', not −100%", () => {
    expect(compareFigures(0, 50_000).label).toBe("nothing this period");
  });

  it("says nothing happened when both periods are empty", () => {
    const d = compareFigures(0, 0);
    expect(d.kind).toBe("flat");
    expect(d.absolute).toBe(0);
  });

  it("refuses to compare a period that is still running", () => {
    /* 18 days of this month against all 31 of last month shows a fall that has not
       happened. A red badge there is simply wrong. */
    const d = compareFigures(40_000, 100_000, { partialCurrent: true });
    expect(d.kind).toBe("incomparable");
    expect(d.pct).toBeNull();
    expect(d.label).toBe("period still running");
  });

  it("detects a part-period from the dates", () => {
    expect(isPartialPeriod("2026-08-31", "2026-08-18")).toBe(true);
    expect(isPartialPeriod("2026-07-31", "2026-08-18")).toBe(false);
    expect(isPartialPeriod("2026-08-18", "2026-08-18")).toBe(false);
  });

  it("keeps the rupee difference even when the percentage is meaningless", () => {
    /* "new this period" plus "+₹50,000" is actionable; "new this period" alone is not. */
    expect(compareFigures(50_000, 0).absolute).toBe(50_000);
    expect(compareFigures(40_000, 100_000, { partialCurrent: true }).absolute).toBe(-60_000);
  });
});

describe("whole rupees throughout", () => {
  it("keeps every money figure an integer", () => {
    const p = buildPnl({ revenue: 111_051, expenses: 30_000, billedCogs: null, vendors: [google(), support()] });
    for (const n of [p.revenue, p.cogs, p.expenses, p.grossMargin!, p.netProfit!]) {
      expect(Number.isInteger(n)).toBe(true);
    }
    for (const v of p.byVendor) {
      for (const n of [v.revenue, v.cost, v.gross]) expect(Number.isInteger(n)).toBe(true);
    }
  });

  it("keeps percentages integers too — a P&L does not need decimals", () => {
    const p = buildPnl({ revenue: 111_051, expenses: 0, billedCogs: null, vendors: [google(), support()] });
    expect(Number.isInteger(p.grossMarginPct!)).toBe(true);
  });
});

/**
 * ─── THE ESTIMATE IS PRORATED, NOT MULTIPLIED ───────────────────────────────
 * A subscription sold in January did not cost anything in April. Multiplying every
 * subscription's monthly wholesale by twelve for an FY report bills the reseller for
 * months before they had the customer — and the error is LARGEST on the annual report
 * somebody actually files against.
 */
describe("months active in a period", () => {
  const sub = (over: Partial<SubscriptionCost> = {}): SubscriptionCost => ({
    vendor: "google", seats: 25, mrr: 6_750, wholesalePerSeatMonth: 110,
    startDate: "2026-04-01", renewalDate: "2027-03-31", ...over,
  });

  it("counts a full year as roughly twelve months", () => {
    expect(monthsActiveInPeriod(sub(), "2026-04-01", "2027-03-31")).toBeCloseTo(12, 0);
  });

  it("counts only the overlap when the subscription started mid-period", () => {
    /* Sold 1 January, FY report from 1 April — three months of the FY, not twelve. */
    const m = monthsActiveInPeriod(sub({ startDate: "2027-01-01" }), "2026-04-01", "2027-03-31");
    expect(m).toBeGreaterThan(2.8);
    expect(m).toBeLessThan(3.1);
  });

  it("counts nothing for a subscription that ended before the window opened", () => {
    expect(monthsActiveInPeriod(
      sub({ startDate: "2024-01-01", renewalDate: "2025-01-01" }), "2026-04-01", "2027-03-31")).toBe(0);
  });

  it("counts nothing for one that starts after the window closes", () => {
    expect(monthsActiveInPeriod(sub({ startDate: "2028-01-01" }), "2026-04-01", "2027-03-31")).toBe(0);
  });

  it("returns ZERO when the start date is unknown, rather than assuming the window", () => {
    /* Assuming the window's start would bill a whole period to a subscription that may
       have begun yesterday. */
    expect(monthsActiveInPeriod(sub({ startDate: null }), "2026-04-01", "2027-03-31")).toBe(0);
  });

  it("runs an open-ended subscription to the end of the window, not beyond", () => {
    expect(monthsActiveInPeriod(
      sub({ renewalDate: null }), "2026-04-01", "2026-06-30")).toBeCloseTo(3, 0);
  });

  it("counts a single day as a fraction, not as zero and not as a month", () => {
    const m = monthsActiveInPeriod(sub({ startDate: "2026-04-01", renewalDate: "2026-04-01" }), "2026-04-01", "2027-03-31");
    expect(m).toBeGreaterThan(0);
    expect(m).toBeLessThan(0.05);
  });
});

describe("rolling the subscription book into vendor lines", () => {
  const book: SubscriptionCost[] = [
    { vendor: "google",  seats: 25, mrr: 6_750, wholesalePerSeatMonth: 110, startDate: "2026-04-01", renewalDate: "2027-03-31" },
    { vendor: "google",  seats: 10, mrr: 2_700, wholesalePerSeatMonth: 110, startDate: "2026-04-01", renewalDate: "2027-03-31" },
    { vendor: "support", seats: 1,  mrr: 999,   wholesalePerSeatMonth: 0,   startDate: "2026-04-01", renewalDate: "2027-03-31" },
  ];

  it("groups by vendor and counts the subscriptions", () => {
    const v = vendorsFromSubscriptions(book, "2026-04-01", "2027-03-31");
    const g = v.find((x) => x.vendor === "google")!;
    expect(g.subscriptions).toBe(2);
    expect(g.seats).toBe(35);
  });

  it("takes revenue and cost from the SAME rows, so the margin reconciles", () => {
    /* Mixing invoiced revenue with rate-card cost gives per-vendor margins that agree
       with nothing. */
    const [g] = vendorsFromSubscriptions(book.slice(0, 2), "2026-04-01", "2027-03-31");
    const line = vendorLine(g);
    expect(line.marginPct).toBe(Math.round(((g.revenue - g.estimatedCost) / g.revenue) * 100));
  });

  it("keeps the reseller's own support product at zero cost", () => {
    const s = vendorsFromSubscriptions(book, "2026-04-01", "2027-03-31").find((x) => x.vendor === "support")!;
    expect(s.estimatedCost).toBe(0);
    expect(vendorLine(s).marginPct).toBe(100);
  });

  it("drops a vendor whose subscriptions were not active at all", () => {
    const v = vendorsFromSubscriptions(book, "2020-01-01", "2020-12-31");
    expect(v).toEqual([]);
  });

  it("returns whole rupees", () => {
    for (const v of vendorsFromSubscriptions(book, "2026-04-01", "2026-06-30")) {
      expect(Number.isInteger(v.revenue)).toBe(true);
      expect(Number.isInteger(v.estimatedCost)).toBe(true);
    }
  });

  it("scales a quarter to about a quarter of the year's money", () => {
    const year = vendorsFromSubscriptions(book, "2026-04-01", "2027-03-31").find((v) => v.vendor === "google")!;
    const q1   = vendorsFromSubscriptions(book, "2026-04-01", "2026-06-30").find((v) => v.vendor === "google")!;
    expect(q1.revenue / year.revenue).toBeGreaterThan(0.2);
    expect(q1.revenue / year.revenue).toBeLessThan(0.3);
  });
});

/**
 * ─── THE ESTIMATE IS A RATIO, AND THE LIVE DATA IS WHY ──────────────────────
 * First pass summed the subscription book's rupees and used that as the period's COGS.
 * The browser showed the problem within a minute: ANUTECH invoiced ₹9,14,376 on 17 August
 * — annual terms, billed in one day — while the book accrued about ₹35,283 of licence
 * cost over that half-month. The waterfall read a 96% margin: a whole year of revenue
 * against a fortnight of cost.
 *
 * Invoiced revenue and subscription cost run on different clocks, so the book supplies the
 * RATIO and it is applied to the revenue actually recognised.
 */
describe("estimated COGS scales with the revenue it is being matched against", () => {
  const book = [
    { vendor: "google",  revenue: 55_194, billedCost: null, estimatedCost: 35_283, seats: 199, subscriptions: 9 },
    { vendor: "support", revenue: 1_225,  billedCost: null, estimatedCost: 0,      seats: 4,   subscriptions: 4 },
  ];

  it("does NOT report the fortnight's cost against a year of invoices", () => {
    /* The exact regression. ₹35,283 against ₹9,14,376 is a 96% margin, which is the old
       100% bug wearing a smaller number. */
    const p = buildPnl({ revenue: 914_376, expenses: 0, billedCogs: null, vendors: book });
    expect(p.cogs).toBeGreaterThan(500_000);
    expect(p.grossMarginPct).toBeLessThan(45);
    expect(p.grossMarginPct).toBeGreaterThan(30);
  });

  it("lands on the same margin the per-vendor cards show", () => {
    /* The book is 62.5% cost, so the P&L must be ~37% margin — matching the 36% on the
       Google card and the 100% on support, blended. A headline that disagrees with the
       breakdown under it is the failure this whole session has been about. */
    const p = buildPnl({ revenue: 914_376, expenses: 0, billedCogs: null, vendors: book });
    const bookRatio = 35_283 / (55_194 + 1_225);
    expect(p.cogs).toBe(Math.round(914_376 * bookRatio));
    expect(p.grossMarginPct).toBe(37);
  });

  it("leaves the figures untouched when revenue already IS the book", () => {
    /* Ratio × its own revenue is the original cost — no drift for a caller whose period
       revenue happens to be the subscription revenue. */
    const p = buildPnl({ revenue: 56_419, expenses: 0, billedCogs: null, vendors: book });
    expect(p.cogs).toBe(35_283);
  });

  it("scales down as well as up", () => {
    const p = buildPnl({ revenue: 10_000, expenses: 0, billedCogs: null, vendors: book });
    expect(p.cogs).toBeLessThan(10_000);
    expect(p.grossMarginPct).toBe(37);
  });

  it("falls back to the raw book cost when the book has no revenue", () => {
    /* No ratio can be formed. The rupees are the only figure available. */
    const p = buildPnl({
      revenue: 100_000, expenses: 0, billedCogs: null,
      vendors: [{ vendor: "google", revenue: 0, billedCost: null, estimatedCost: 4_000, seats: 1, subscriptions: 1 }],
    });
    expect(p.cogs).toBe(4_000);
  });

  it("states the assumption rather than hiding it", () => {
    /* It holds while what you invoice resembles what you sell. A large one-off consulting
       job would be costed like a licence — which is why the fix is a vendor bill, not a
       cleverer guess. */
    const p = buildPnl({ revenue: 914_376, expenses: 0, billedCogs: null, vendors: book });
    expect(cogsBasisNote(p)).toMatch(/what you bill looks like what you sell/);
  });

  it("still prefers a real bill, which needs no ratio at all", () => {
    const p = buildPnl({ revenue: 914_376, expenses: 0, billedCogs: 600_000, vendors: book });
    expect(p.cogs).toBe(600_000);
    expect(p.cogsBasis).toBe("billed");
  });
});
