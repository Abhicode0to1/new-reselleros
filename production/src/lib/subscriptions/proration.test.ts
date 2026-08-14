import { describe, it, expect } from "vitest";
import {
  prorate,
  rupeesToPaise,
  paiseToRupees,
  formatPaise,
  daysBetweenDates,
} from "./proration";

describe("paise conversion", () => {
  it("holds ₹1.22 exactly", () => {
    expect(rupeesToPaise(1.22)).toBe(122);
    expect(formatPaise(122)).toBe("₹1.22");
  });

  it("survives the amounts a float would lose", () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point. In paise it is 10 + 20 === 30.
    expect(rupeesToPaise(0.1) + rupeesToPaise(0.2)).toBe(rupeesToPaise(0.3));
  });

  it("formats lakh amounts in the Indian grouping", () => {
    expect(formatPaise(2_12_40_000)).toBe("₹2,12,400.00");
    expect(formatPaise(5)).toBe("₹0.05");
    expect(formatPaise(-122)).toBe("-₹1.22");
  });

  it("paiseToRupees rounds once, and says so by losing the paise", () => {
    expect(paiseToRupees(122)).toBe(1);
    expect(paiseToRupees(150)).toBe(2);   // half away from zero
    expect(paiseToRupees(-150)).toBe(-2); // symmetric — a credit rounds the same size
  });

  it("refuses non-integers instead of quietly truncating", () => {
    expect(() => paiseToRupees(1.5)).toThrow();
    expect(() => rupeesToPaise(Number.NaN)).toThrow();
  });
});

describe("prorate — the rounding bug this module exists to fix", () => {
  /** ₹2,160/seat/year, 200 of 365 days left — the case from add-seats.ts. */
  const base = { annualPerSeatPaise: rupeesToPaise(2160), remainingDays: 200, termDays: 365, taxRatePct: 0 };

  it("rounds ONCE at the end, not per seat", () => {
    // Correct: round(216000 × 10 × 200 / 365) = round(1183561.64) = 1183562 paise
    const r = prorate({ ...base, seats: 10 });
    expect(r.subtotalPaise).toBe(1_183_562);

    // The old shape — round per seat, then multiply — gives a different answer:
    const perSeatFirst = Math.round(216000 * (200 / 365)) * 10;   // 1183560
    expect(perSeatFirst).not.toBe(r.subtotalPaise);
  });

  it("the old RUPEE-based shape drifts ₹132 at 300 seats", () => {
    /* This is the defect in add-seats.ts, and it only bites in rupees. Rounding a
       per-seat figure to the nearest RUPEE loses up to ₹0.50 each time, and that
       loss is then multiplied by the seat count.
         old: round(2160 × 200/365) × 300 = 1184 × 300      = 355,200
         new: round(2160 × 300 × 200/365) = round(355,068.49) = 355,068
       A first version of this test compared the two in PAISE and measured a 49-paise
       gap — the wrong comparison, because in paise the same mistake costs half a
       paise a seat. The unit is where the money goes missing. */
    const oldRupees = Math.round(2160 * (200 / 365)) * 300;
    const newRupees = paiseToRupees(prorate({ ...base, seats: 300 }).subtotalPaise);
    expect(oldRupees - newRupees).toBe(132);
  });

  it("working in paise makes that class of drift negligible even if shaped wrongly", () => {
    const r = prorate({ ...base, seats: 300 });
    const perSeatFirstPaise = Math.round(216000 * (200 / 365)) * 300;
    // Half a paise a seat, so at most ₹1.50 across 300 seats — versus ₹132 above.
    expect(Math.abs(r.subtotalPaise - perSeatFirstPaise)).toBeLessThanOrEqual(150);
  });

  it("perSeatPaise is derived from the subtotal, so it cannot disagree with it", () => {
    const r = prorate({ ...base, seats: 7 });
    expect(r.perSeatPaise).toBe(Math.round(r.subtotalPaise / 7));
  });
});

describe("prorate — tax is a parameter, never assumed", () => {
  const base = { annualPerSeatPaise: rupeesToPaise(1000), seats: 10, remainingDays: 365, termDays: 365 };

  it("charges 18% GST on a domestic sale", () => {
    const r = prorate({ ...base, taxRatePct: 18 });
    expect(r.subtotalPaise).toBe(10_00_000);
    expect(r.taxPaise).toBe(1_80_000);
    expect(r.totalPaise).toBe(11_80_000);
  });

  it("charges NOTHING on a zero-rated export", () => {
    // add-seats.ts multiplied by a hardcoded 1.18, so an export customer was
    // billed GST on a sale that must not carry any.
    const r = prorate({ ...base, taxRatePct: 0 });
    expect(r.taxPaise).toBe(0);
    expect(r.totalPaise).toBe(r.subtotalPaise);
  });

  it("handles a non-integer rate without a float creeping into the total", () => {
    const r = prorate({ ...base, taxRatePct: 2.5 });
    expect(Number.isInteger(r.taxPaise)).toBe(true);
    expect(r.taxPaise).toBe(25_000);
  });
});

describe("prorate — the term is a parameter, not 365", () => {
  const seat = rupeesToPaise(3650);   // ₹10/day on a 365-day term

  it("bills a monthly term against 30 days, not a year", () => {
    const r = prorate({ annualPerSeatPaise: rupeesToPaise(300), seats: 1, remainingDays: 15, termDays: 30, taxRatePct: 0 });
    expect(r.subtotalPaise).toBe(rupeesToPaise(150));
    expect(r.factorPpm).toBe(500_000);   // exactly half
  });

  it("bills a two-year term over 730 days", () => {
    const r = prorate({ annualPerSeatPaise: seat * 2, seats: 1, remainingDays: 365, termDays: 730, taxRatePct: 0 });
    expect(r.subtotalPaise).toBe(seat);   // half of a two-year price
  });

  it("clamps to the ACTUAL term — 400 days left on a 730-day term is not a year", () => {
    // add-seats clamped days to [0,365], so this silently billed 365/365.
    const r = prorate({ annualPerSeatPaise: seat, seats: 1, remainingDays: 400, termDays: 730, taxRatePct: 0 });
    expect(r.chargedDays).toBe(400);
    expect(r.factorPpm).toBe(547_945);
  });

  it("never charges more than the full term", () => {
    const r = prorate({ annualPerSeatPaise: seat, seats: 1, remainingDays: 9999, termDays: 365, taxRatePct: 0 });
    expect(r.chargedDays).toBe(365);
    expect(r.subtotalPaise).toBe(seat);
  });

  it("charges nothing when the term has already ended", () => {
    for (const d of [0, -5]) {
      const r = prorate({ annualPerSeatPaise: seat, seats: 1, remainingDays: d, termDays: 365, taxRatePct: 18 });
      expect(r.subtotalPaise).toBe(0);
      expect(r.totalPaise).toBe(0);
    }
  });
});

describe("prorate — credits are symmetric", () => {
  it("a negative seat count prices a giveback of the same magnitude", () => {
    const charge = prorate({ annualPerSeatPaise: rupeesToPaise(2160), seats: 5,  remainingDays: 200, termDays: 365, taxRatePct: 18 });
    const credit = prorate({ annualPerSeatPaise: rupeesToPaise(2160), seats: -5, remainingDays: 200, termDays: 365, taxRatePct: 18 });
    // A downgrade must not refund a different amount than the upgrade charged —
    // which is what Math.round alone would do at a .5 boundary.
    expect(credit.subtotalPaise).toBe(-charge.subtotalPaise);
    expect(credit.taxPaise).toBe(-charge.taxPaise);
    expect(credit.totalPaise).toBe(-charge.totalPaise);
  });
});

describe("prorate — refuses nonsense rather than inventing a bill", () => {
  const ok = { annualPerSeatPaise: 100, seats: 1, remainingDays: 10, termDays: 365, taxRatePct: 0 };

  it("throws on a zero or negative term", () => {
    expect(() => prorate({ ...ok, termDays: 0 })).toThrow();
    expect(() => prorate({ ...ok, termDays: -365 })).toThrow();
  });

  it("throws on a fractional paise price — the unit is an integer", () => {
    expect(() => prorate({ ...ok, annualPerSeatPaise: 100.5 })).toThrow();
  });

  it("throws on a negative tax rate", () => {
    expect(() => prorate({ ...ok, taxRatePct: -18 })).toThrow();
  });

  it("returns integers for every money field", () => {
    const r = prorate({ annualPerSeatPaise: 216_037, seats: 13, remainingDays: 173, termDays: 366, taxRatePct: 18 });
    for (const v of [r.subtotalPaise, r.taxPaise, r.totalPaise, r.perSeatPaise, r.factorPpm, r.chargedDays]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});

describe("daysBetweenDates", () => {
  it("counts calendar days, so the time of day cannot change the bill", () => {
    expect(daysBetweenDates("2026-08-14", "2027-08-14")).toBe(365);
    expect(daysBetweenDates("2026-08-14T23:59:00Z", "2026-08-15T00:01:00Z")).toBe(1);
  });

  it("counts the leap day", () => {
    expect(daysBetweenDates("2028-02-01", "2028-03-01")).toBe(29);
  });

  it("is negative once the date has passed", () => {
    expect(daysBetweenDates("2026-08-14", "2026-08-01")).toBe(-13);
  });

  it("throws on an unparseable date instead of returning NaN days", () => {
    expect(() => daysBetweenDates("not-a-date", "2026-08-14")).toThrow();
  });
});
