/**
 * What wiring add-seats.ts to proration.ts changes, in rupees.
 *
 * This file exists because the change alters what a CUSTOMER IS CHARGED. Every
 * case below states the old figure, the new figure, and why they differ, so the
 * difference is a decision on the record rather than something noticed later on
 * an invoice. It is kept after the wiring as the regression guard for each case.
 *
 * OLD algorithm, as written in add-seats.ts before this change:
 *     annualPerSeat  = round(mrr × 12 / seats)          // whole rupees
 *     factor         = clamp(days, 0, 365) / 365        // term always a year
 *     proRataPerSeat = round(annualPerSeat × factor)    // rounds PER SEAT
 *     subtotal       = proRataPerSeat × addSeats        // then multiplies
 *     total          = round(subtotal × 1.18)           // GST always 18%
 *
 * NEW: one expression in integer paise, rounded once, with the tax rate and the
 * term length passed in.
 */
import { describe, it, expect } from "vitest";
import { prorate, rupeesToPaise, paiseToRupees } from "./proration";

/** The old algorithm, reproduced exactly so the comparison is not from memory. */
function oldAddSeats(args: {
  currentMrr: number; currentSeats: number; additionalSeats: number; days: number;
}) {
  const annualPerSeat  = args.currentSeats > 0 ? Math.round((args.currentMrr * 12) / args.currentSeats) : 0;
  const factor         = Math.max(0, Math.min(365, args.days)) / 365;
  const proRataPerSeat = Math.round(annualPerSeat * factor);
  const subtotal       = proRataPerSeat * args.additionalSeats;
  return { subtotal, total: Math.round(subtotal * 1.18), annualPerSeat };
}

/** The new path, as add-seats.ts will call it. */
function newAddSeats(args: {
  currentMrr: number; currentSeats: number; additionalSeats: number;
  days: number; termDays: number; taxRatePct: number;
}) {
  const annualPerSeat = args.currentSeats > 0 ? Math.round((args.currentMrr * 12) / args.currentSeats) : 0;
  const r = prorate({
    annualPerSeatPaise: rupeesToPaise(annualPerSeat),
    seats:              args.additionalSeats,
    remainingDays:      args.days,
    termDays:           args.termDays,
    taxRatePct:         args.taxRatePct,
  });
  return { subtotal: paiseToRupees(r.subtotalPaise), total: paiseToRupees(r.totalPaise), annualPerSeat };
}

describe("before/after — domestic, the ordinary case", () => {
  /** ₹1,800/mo for 10 seats = ₹2,160/seat/year. 200 of 365 days left. */
  const scenario = { currentMrr: 1800, currentSeats: 10, days: 200 };

  /* The figures below are MEASURED, not derived by hand. A first version of this
     file asserted numbers I had worked out on paper and three of them were a rupee
     out — which is its own argument for pinning billing arithmetic in a test
     rather than in a comment. */
  it("10 seats added: ₹13,971 -> ₹13,966 (₹5 less)", () => {
    const before = oldAddSeats({ ...scenario, additionalSeats: 10 });
    const after  = newAddSeats({ ...scenario, additionalSeats: 10, termDays: 365, taxRatePct: 18 });
    expect(before.subtotal).toBe(11_840);
    expect(after.subtotal).toBe(11_836);
    expect(before.total).toBe(13_971);
    expect(after.total).toBe(13_966);
  });

  it("300 seats added: ₹132 less ex-GST, ₹155 less on the invoice", () => {
    // The per-seat rounding error, multiplied by 300 and then carried through GST.
    const before = oldAddSeats({ ...scenario, additionalSeats: 300 });
    const after  = newAddSeats({ ...scenario, additionalSeats: 300, termDays: 365, taxRatePct: 18 });
    expect(before.subtotal - after.subtotal).toBe(132);
    expect(before.total - after.total).toBe(155);
  });

  it("1 seat added: unchanged — the bug needs a seat count to grow", () => {
    const before = oldAddSeats({ ...scenario, additionalSeats: 1 });
    const after  = newAddSeats({ ...scenario, additionalSeats: 1, termDays: 365, taxRatePct: 18 });
    expect(after.total).toBe(before.total);
  });
});

describe("before/after — the export customer, where the old code was simply wrong", () => {
  const scenario = { currentMrr: 1800, currentSeats: 10, additionalSeats: 10, days: 200 };

  it("zero-rated export: ₹13,971 -> ₹11,836, because GST must not be charged at all", () => {
    // isExportSupply() has existed in lib/gst/place-of-supply.ts the whole time;
    // add-seats never consulted it and multiplied by 1.18 regardless.
    const before = oldAddSeats(scenario);
    const after  = newAddSeats({ ...scenario, termDays: 365, taxRatePct: 0 });
    expect(before.total).toBe(13_971);
    expect(after.total).toBe(11_836);
    // ₹2,131 of tax that was never owed on this sale.
    expect(before.total - after.total).toBe(2_135);
  });
});

describe("before/after — terms that are not 365 days", () => {
  it("two-year term, 400 days left: the old clamp billed it as a full year", () => {
    // OLD: days clamped to 365 → factor 1.0 → charged the FULL two-year seat price.
    // NEW: 400/730 → charged 54.79%.
    const scenario = { currentMrr: 3600, currentSeats: 10, additionalSeats: 5, days: 400 };
    const before = oldAddSeats(scenario);
    const after  = newAddSeats({ ...scenario, termDays: 730, taxRatePct: 18 });
    expect(before.subtotal).toBe(21_600);   // 4320 × 5, full price
    expect(after.subtotal).toBe(11_836);    // 4320 × 5 × 400/730
    expect(before.subtotal).toBeGreaterThan(after.subtotal);
  });

  it("leap-year term of 366 days is billed over 366, not 365", () => {
    const scenario = { currentMrr: 1800, currentSeats: 10, additionalSeats: 10, days: 200 };
    const y365 = newAddSeats({ ...scenario, termDays: 365, taxRatePct: 0 });
    const y366 = newAddSeats({ ...scenario, termDays: 366, taxRatePct: 0 });
    expect(y366.subtotal).toBeLessThan(y365.subtotal);
    expect(y365.subtotal - y366.subtotal).toBe(33);
  });
});

describe("before/after — nothing changes for these", () => {
  it("a full remaining term charges the full price either way", () => {
    const scenario = { currentMrr: 1800, currentSeats: 10, additionalSeats: 4, days: 365 };
    const before = oldAddSeats(scenario);
    const after  = newAddSeats({ ...scenario, termDays: 365, taxRatePct: 18 });
    expect(after.subtotal).toBe(before.subtotal);
    expect(after.total).toBe(before.total);
  });

  it("both refuse to bill an ended term", () => {
    const scenario = { currentMrr: 1800, currentSeats: 10, additionalSeats: 5, days: 0 };
    expect(oldAddSeats(scenario).total).toBe(0);
    expect(newAddSeats({ ...scenario, termDays: 365, taxRatePct: 18 }).total).toBe(0);
  });
});
