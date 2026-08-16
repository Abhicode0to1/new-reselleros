import { describe, it, expect } from "vitest";
import { coTerm, nextAnniversaryOnOrAfter, MIN_STUB_DAYS, type CoTermInput } from "./co-term";

const base: CoTermInput = {
  anniversary: "2027-04-01",
  addOnStart:  "2026-09-20",
  annualPerSeat: 3240,   // ₹270/mo × 12
  seats: 10,
  taxRatePct: 18,
};

describe("nextAnniversaryOnOrAfter", () => {
  it("finds the upcoming one when the anniversary is in the future", () => {
    expect(nextAnniversaryOnOrAfter("2027-04-01", "2026-09-20")).toBe("2027-04-01");
  });

  it("rolls a past anniversary forward", () => {
    expect(nextAnniversaryOnOrAfter("2024-04-01", "2026-09-20")).toBe("2027-04-01");
  });

  it("returns the date itself when they land on the same day", () => {
    expect(nextAnniversaryOnOrAfter("2026-04-01", "2026-04-01")).toBe("2026-04-01");
  });

  it("clamps 29 February to 28 in a common year", () => {
    expect(nextAnniversaryOnOrAfter("2028-02-29", "2029-01-01")).toBe("2029-02-28");
  });
});

describe("the normal case — a real stub is charged", () => {
  const r = coTerm(base);

  it("aligns to the main plan's anniversary", () => {
    expect(r.alignedTo).toBe("2027-04-01");
    expect(r.firstPeriodStart).toBe("2026-09-20");
    expect(r.firstPeriodEnd).toBe("2027-04-01");
  });

  it("charges exactly the days from purchase to the anniversary", () => {
    // 20 Sep 2026 → 1 Apr 2027 = 193 days.
    expect(r.chargedDays).toBe(193);
    expect(r.termDays).toBe(365);
    expect(r.stubAbsorbed).toBe(false);
    expect(r.freeDays).toBe(0);
  });

  it("prices it pro-rata, not as a full year", () => {
    // ₹3,240/seat/yr × 10 seats × 193/365 = ₹17,132.05 → ₹17,132 ex-GST
    expect(r.firstChargeExGst).toBe(17_132);
    // 18% of 17,13,205 paise = 3,08,377 paise → ₹3,084
    expect(r.firstChargeTax).toBe(3_084);
    expect(r.firstChargeTotal).toBe(20_216);
  });

  it("total is subtotal + tax, with no third rounding", () => {
    expect(r.firstChargeTotal).toBe(r.firstChargeExGst + r.firstChargeTax);
  });

  it("explains itself in a sentence a rep can read to a customer", () => {
    expect(r.explanation).toMatch(/Charged 193 days to 1 Apr 2027/);
  });
});

describe("the short-stub rule", () => {
  it("gives away a stub shorter than the threshold and bills from the anniversary", () => {
    /* Billing ₹43 for four days, raising a GST invoice and chasing it costs more
       than the money. */
    const r = coTerm({ ...base, addOnStart: "2027-03-28" });   // 4 days out
    expect(r.stubAbsorbed).toBe(true);
    expect(r.freeDays).toBe(4);
    expect(r.firstPeriodStart).toBe("2027-04-01");
    expect(r.alignedTo).toBe("2028-04-01");
  });

  it("charges a FULL year when the stub is absorbed — not a year plus the free days", () => {
    const r = coTerm({ ...base, addOnStart: "2027-03-28" });
    expect(r.firstChargeExGst).toBe(32_400);   // 3240 × 10, exactly one year
  });

  it("is inclusive at the boundary — exactly MIN_STUB_DAYS is billed, not given away", () => {
    const at = coTerm({ ...base, addOnStart: "2027-03-02" });   // 30 days to 1 Apr
    expect(at.chargedDays).toBe(MIN_STUB_DAYS);
    expect(at.stubAbsorbed).toBe(false);

    const under = coTerm({ ...base, addOnStart: "2027-03-03" }); // 29 days
    expect(under.stubAbsorbed).toBe(true);
  });

  it("bounds the giveaway — never more than MIN_STUB_DAYS", () => {
    for (const start of ["2027-03-03", "2027-03-15", "2027-03-31"]) {
      const r = coTerm({ ...base, addOnStart: start });
      expect(r.freeDays).toBeLessThan(MIN_STUB_DAYS);
    }
  });

  it("says plainly that the days are free", () => {
    const r = coTerm({ ...base, addOnStart: "2027-03-28" });
    expect(r.explanation).toMatch(/too short to invoice, so those days are free/);
  });
});

describe("edge dates", () => {
  it("buying ON the anniversary is a FULL term, not a zero-day stub", () => {
    const r = coTerm({ ...base, addOnStart: "2027-04-01" });
    expect(r.stubAbsorbed).toBe(false);
    expect(r.alignedTo).toBe("2028-04-01");
    expect(r.chargedDays).toBe(366);            // 2027-04-01 → 2028-04-01, leap
    expect(r.firstChargeExGst).toBe(32_400);    // a full year, not 366/365 of one
  });

  it("buying the day AFTER the anniversary bills almost a full year", () => {
    const r = coTerm({ ...base, addOnStart: "2026-04-02" });
    expect(r.alignedTo).toBe("2027-04-01");
    expect(r.chargedDays).toBe(364);
    expect(r.firstChargeExGst).toBeLessThan(32_400);
  });

  it("handles a leap year in the term length", () => {
    const r = coTerm({ ...base, anniversary: "2028-03-01", addOnStart: "2027-09-01" });
    expect(r.termDays).toBe(366);   // 2027-03-01 → 2028-03-01 includes 29 Feb
  });

  it("works when the anniversary is years in the past", () => {
    const r = coTerm({ ...base, anniversary: "2020-04-01" });
    expect(r.alignedTo).toBe("2027-04-01");
  });
});

describe("money rules", () => {
  it("zero seats charges nothing rather than erroring", () => {
    const r = coTerm({ ...base, seats: 0 });
    expect(r.firstChargeTotal).toBe(0);
  });

  it("respects a zero-rated export", () => {
    const r = coTerm({ ...base, taxRatePct: 0 });
    expect(r.firstChargeTax).toBe(0);
    expect(r.firstChargeTotal).toBe(r.firstChargeExGst);
  });

  it("scales linearly with seats — no per-seat rounding drift", () => {
    /* The bug prorate() exists to prevent: rounding a per-seat share and then
       multiplying. Twenty seats must be exactly twice ten. */
    const ten    = coTerm({ ...base, seats: 10 }).firstChargeExGst;
    const twenty = coTerm({ ...base, seats: 20 }).firstChargeExGst;
    expect(twenty).toBe(ten * 2);
  });

  it("returns whole rupees", () => {
    for (const seats of [1, 7, 13, 250]) {
      const r = coTerm({ ...base, seats });
      expect(Number.isInteger(r.firstChargeExGst)).toBe(true);
      expect(Number.isInteger(r.firstChargeTax)).toBe(true);
      expect(Number.isInteger(r.firstChargeTotal)).toBe(true);
    }
  });

  it("never charges MORE than a full year for a stub", () => {
    for (const start of ["2026-04-02", "2026-09-20", "2027-01-01", "2027-03-02"]) {
      const r = coTerm({ ...base, addOnStart: start });
      expect(r.firstChargeExGst).toBeLessThanOrEqual(32_400);
    }
  });
});
