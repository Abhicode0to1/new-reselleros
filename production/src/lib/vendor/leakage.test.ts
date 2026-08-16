import { describe, it, expect } from "vitest";
import { assessLeakage, leakageTotals, leakageSortKey, type LeakageInput } from "./leakage";

const base: LeakageInput = {
  vendorSeats: 10,
  billedSeats: 10,
  assignedSeats: 8,
  costPerSeatMonth: 110,
  pricePerSeatMonth: 270,
};

describe("the three seat counts are kept apart", () => {
  it("matched seats are aligned, and idle seats do NOT make it leakage", () => {
    /* 10 provisioned, 10 billed, 8 assigned. Nothing is leaking; the customer is
       simply over-bought. Adding idle seats to the money would invent a loss. */
    const r = assessLeakage(base);
    expect(r.kind).toBe("aligned");
    expect(r.monthlyImpact).toBe(0);
    expect(r.idleSeats).toBe(2);
  });

  it("reports idle seats even when leakage is unknown", () => {
    expect(assessLeakage({ ...base, vendorSeats: null }).idleSeats).toBe(2);
  });

  it("idle seats are null when assignment is not tracked", () => {
    expect(assessLeakage({ ...base, assignedSeats: null }).idleSeats).toBeNull();
  });
});

describe("under-billed — margin bleeding out", () => {
  const r = assessLeakage({ ...base, vendorSeats: 14, billedSeats: 10 });

  it("finds the gap", () => {
    expect(r.kind).toBe("under_billed");
    expect(r.seatGap).toBe(4);
  });

  it("costs it at what we PAY the vendor, not at what we charge", () => {
    /* The money going out is the vendor's rate. Pricing it at the customer's rate
       would overstate the loss by the whole margin. */
    expect(r.monthlyImpact).toBe(440);      // 4 × ₹110
    expect(r.annualImpact).toBe(5_280);
  });

  it("says it in a sentence an owner can act on", () => {
    expect(r.message).toMatch(/Paying the vendor for 4 more seats/);
    expect(r.message).toMatch(/₹440\/month/);
  });

  it("uses the singular for one seat", () => {
    const one = assessLeakage({ ...base, vendorSeats: 11, billedSeats: 10 });
    expect(one.message).toMatch(/1 more seat than/);
  });
});

describe("over-billed — a refund waiting to happen", () => {
  const r = assessLeakage({ ...base, vendorSeats: 6, billedSeats: 10 });

  it("finds the gap and does not treat it as profit", () => {
    expect(r.kind).toBe("over_billed");
    expect(r.seatGap).toBe(-4);
  });

  it("costs it at what the CUSTOMER pays — that is what would be refunded", () => {
    expect(r.monthlyImpact).toBe(1_080);    // 4 × ₹270
  });

  it("warns rather than congratulates", () => {
    expect(r.message).toMatch(/they may ask back/);
    expect(r.message).not.toMatch(/gain|profit|extra revenue/i);
  });
});

describe("unknown is a first-class outcome, never zero", () => {
  it("a subscription never reconciled reports unknown", () => {
    /* Reporting 0 leakage would put a clean tick on exactly the rows nobody has
       checked. */
    const r = assessLeakage({ ...base, vendorSeats: null });
    expect(r.kind).toBe("unknown");
    expect(r.seatGap).toBeNull();
    expect(r.monthlyImpact).toBeNull();
    expect(r.message).toMatch(/Never reconciled/);
  });

  it("a real gap with no catalogue cost reports the SEATS but not the money", () => {
    const r = assessLeakage({ ...base, vendorSeats: 14, costPerSeatMonth: null });
    expect(r.kind).toBe("under_billed");
    expect(r.seatGap).toBe(4);
    expect(r.monthlyImpact).toBeNull();
    expect(r.message).toMatch(/no catalogue cost, so the amount is unknown/);
  });
});

describe("input hygiene", () => {
  it("truncates fractional seats rather than pricing a fraction of a person", () => {
    const r = assessLeakage({ ...base, vendorSeats: 14.9, billedSeats: 10.2 });
    expect(r.seatGap).toBe(4);
  });

  it("clamps negatives instead of inverting the verdict", () => {
    const r = assessLeakage({ ...base, vendorSeats: -5, billedSeats: 10 });
    expect(r.kind).toBe("over_billed");
    expect(r.seatGap).toBe(-10);
  });

  it("handles a zero-seat subscription", () => {
    const r = assessLeakage({ ...base, vendorSeats: 0, billedSeats: 0, assignedSeats: 0 });
    expect(r.kind).toBe("aligned");
    expect(r.idleSeats).toBe(0);
  });
});

describe("leakageTotals — under and over are NOT netted", () => {
  const results = [
    assessLeakage({ ...base, vendorSeats: 14, billedSeats: 10 }),   // under, ₹440
    assessLeakage({ ...base, vendorSeats: 6,  billedSeats: 10 }),   // over,  ₹1,080
    assessLeakage({ ...base, vendorSeats: 10, billedSeats: 10 }),   // aligned
    assessLeakage({ ...base, vendorSeats: null }),                  // unknown
    assessLeakage({ ...base, vendorSeats: 12, costPerSeatMonth: null }), // gap, unpriced
  ];

  it("keeps the two problems separate", () => {
    /* ₹5,000 lost on one customer and ₹5,000 over-charged on another is not "no
       problem" — it is two problems, one of which is a refund. */
    const t = leakageTotals(results);
    expect(t.underBilledMonthly).toBe(440);
    expect(t.overBilledMonthly).toBe(1_080);
  });

  it("counts each bucket", () => {
    const t = leakageTotals(results);
    expect(t.underBilledCount).toBe(2);   // the ₹440 one and the unpriced one
    expect(t.overBilledCount).toBe(1);
    expect(t.unknownCount).toBe(1);
    expect(t.unpricedCount).toBe(1);
  });

  it("does not silently add unpriced gaps as ₹0 without saying so", () => {
    const t = leakageTotals(results);
    expect(t.unpricedCount).toBeGreaterThan(0);
  });

  it("is all zeroes on an empty list", () => {
    expect(leakageTotals([])).toEqual({
      underBilledMonthly: 0, overBilledMonthly: 0,
      underBilledCount: 0, overBilledCount: 0, unknownCount: 0, unpricedCount: 0,
    });
  });
});

describe("leakageSortKey — worst money first", () => {
  it("puts under-billed above over-billed, above unknown, above matched", () => {
    const rows = [
      assessLeakage({ ...base, vendorSeats: 10 }),                   // aligned
      assessLeakage({ ...base, vendorSeats: null }),                 // unknown
      assessLeakage({ ...base, vendorSeats: 6,  billedSeats: 10 }),  // over
      assessLeakage({ ...base, vendorSeats: 14, billedSeats: 10 }),  // under
    ];
    const order = [...rows].sort((a, b) => leakageSortKey(a) - leakageSortKey(b)).map((r) => r.kind);
    expect(order).toEqual(["under_billed", "over_billed", "unknown", "aligned"]);
  });

  it("orders two under-billed rows by money", () => {
    const small = assessLeakage({ ...base, vendorSeats: 11, billedSeats: 10 });
    const big   = assessLeakage({ ...base, vendorSeats: 30, billedSeats: 10 });
    expect(leakageSortKey(big)).toBeLessThan(leakageSortKey(small));
  });
});
