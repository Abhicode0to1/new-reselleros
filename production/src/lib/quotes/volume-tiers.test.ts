import { describe, it, expect } from "vitest";
import {
  validateSlabs, resolveSlab, slabLabel, slabPricing, slabLineTotals,
  pricesAllSeatsAtOneRate, nextSlabUpsell, type SeatSlab,
} from "./volume-tiers";
import type { Item } from "@/lib/supabase/database.types";

/** The example from the brief: 1-10 @ ₹270, 11-50 @ ₹250, 51+ @ ₹230 (₹/seat/month). */
const SLABS: SeatSlab[] = [
  { minSeats: 1,  maxSeats: 10,   msrp: 270, wholesale: 110 },
  { minSeats: 11, maxSeats: 50,   msrp: 250, wholesale: 105 },
  { minSeats: 51, maxSeats: null, msrp: 230, wholesale: 100 },
];

const item = (over: Partial<Item> = {}): Pick<Item, "msrp" | "wholesale" | "prices"> => ({
  msrp: 270,
  wholesale: 110,
  prices: { annual: { msrp: 270, wholesale: 110 }, slabs: SLABS },
  ...over,
});

describe("VOLUME pricing, not graduated — the money decision", () => {
  it("60 seats bill ALL sixty at the 51+ rate", () => {
    /* Volume:    60 × ₹230×12 = ₹1,65,600
       Graduated: 10×₹270×12 + 40×₹250×12 + 10×₹230×12 = ₹1,79,400
       ₹13,800 apart, and neither looks wrong alone. This asserts which one we do. */
    const t = slabLineTotals(slabPricing(item(), 60), 60);
    expect(t.ratePerSeatYear).toBe(230 * 12);
    expect(t.lineRevenue).toBe(60 * 230 * 12);
    expect(t.lineRevenue).not.toBe(10 * 270 * 12 + 40 * 250 * 12 + 10 * 230 * 12);
  });

  it("every seat bills at one rate — the guard that fails if graduated sneaks in", () => {
    for (const seats of [1, 10, 11, 50, 51, 500]) {
      expect(pricesAllSeatsAtOneRate(slabPricing(item(), seats), seats), `${seats} seats`).toBe(true);
    }
  });
});

describe("resolveSlab — band boundaries", () => {
  it.each([
    [1,   270],
    [10,  270],
    [11,  250],   // the boundary that a `>` instead of `>=` would get wrong
    [50,  250],
    [51,  230],
    [999, 230],
  ])("%s seats → ₹%s/seat/month", (seats, msrp) => {
    expect(resolveSlab(SLABS, seats)!.msrp).toBe(msrp);
  });

  it("returns null for seat counts that are not real orders", () => {
    for (const s of [0, -5, NaN, Infinity]) expect(resolveSlab(SLABS, s)).toBeNull();
  });
});

describe("validateSlabs", () => {
  it("accepts a well-formed table", () => {
    expect(validateSlabs(SLABS)).toEqual([]);
  });

  it("accepts an empty table — no slabs is not an error", () => {
    expect(validateSlabs([])).toEqual([]);
  });

  it("catches a GAP, because an order landing in it is quoted MORE than the price list", () => {
    const gappy: SeatSlab[] = [
      { minSeats: 1,  maxSeats: 10,   msrp: 270, wholesale: 110 },
      { minSeats: 21, maxSeats: null, msrp: 230, wholesale: 100 },
    ];
    expect(validateSlabs(gappy)).toContain("Nothing covers 11–20 seats.");
  });

  it("catches an OVERLAP, where the answer depends on row order", () => {
    const overlapping: SeatSlab[] = [
      { minSeats: 1,  maxSeats: 20,   msrp: 270, wholesale: 110 },
      { minSeats: 11, maxSeats: null, msrp: 230, wholesale: 100 },
    ];
    expect(validateSlabs(overlapping).some((e) => /overlap/.test(e))).toBe(true);
  });

  it("catches a table that does not start at 1 seat", () => {
    const late: SeatSlab[] = [{ minSeats: 5, maxSeats: null, msrp: 250, wholesale: 100 }];
    expect(validateSlabs(late).some((e) => /must start at 1/.test(e))).toBe(true);
  });

  it("catches an open-ended band that is not last", () => {
    const bad: SeatSlab[] = [
      { minSeats: 1,  maxSeats: null, msrp: 270, wholesale: 110 },
      { minSeats: 11, maxSeats: 50,   msrp: 250, wholesale: 105 },
    ];
    expect(validateSlabs(bad).some((e) => /open-ended but is not the last/.test(e))).toBe(true);
  });

  it("catches a band that ends before it begins", () => {
    const bad: SeatSlab[] = [{ minSeats: 1, maxSeats: 0, msrp: 270, wholesale: 110 }];
    expect(validateSlabs(bad).some((e) => /ends before it begins/.test(e))).toBe(true);
  });

  it("does NOT block a below-cost band — loss-leading a big deal is a business call", () => {
    const lossLeader: SeatSlab[] = [
      { minSeats: 1,  maxSeats: 50,   msrp: 270, wholesale: 110 },
      { minSeats: 51, maxSeats: null, msrp: 100, wholesale: 110 },
    ];
    expect(validateSlabs(lossLeader)).toEqual([]);
  });
});

describe("slabPricing — fallback behaviour", () => {
  it("uses flat pricing when the item has no slabs", () => {
    const p = slabPricing({ msrp: 270, wholesale: 110, prices: { annual: { msrp: 300, wholesale: 120 } } }, 60);
    expect(p).toMatchObject({ source: "flat", msrpPerSeatMonth: 300, wholesalePerSeatMonth: 120, slab: null });
  });

  it("falls back to FLAT — never to a cheaper band — when the table is broken", () => {
    /* Flat is the item's normal price, so a data error can never cause an
       under-charge. It can only ever quote the standard rate. */
    const broken = item({ prices: { annual: { msrp: 270, wholesale: 110 }, slabs: [
      { minSeats: 1,  maxSeats: 10,   msrp: 270, wholesale: 110 },
      { minSeats: 21, maxSeats: null, msrp: 230, wholesale: 100 },  // gap at 11–20
    ] } });
    const p = slabPricing(broken, 60);
    expect(p.source).toBe("flat");
    expect(p.msrpPerSeatMonth).toBe(270);
  });

  it("falls back to the legacy msrp/wholesale columns when prices is empty", () => {
    const p = slabPricing({ msrp: 190, wholesale: 90, prices: {} }, 5);
    expect(p).toMatchObject({ source: "flat", msrpPerSeatMonth: 190, wholesalePerSeatMonth: 90 });
  });

  it("labels the applied band for the UI", () => {
    expect(slabPricing(item(), 30).label).toBe("11–50 seats");
    expect(slabPricing(item(), 80).label).toBe("51+ seats");
  });
});

describe("slabLineTotals — the numbers on the line", () => {
  it("30 seats in the middle band", () => {
    const t = slabLineTotals(slabPricing(item(), 30), 30);
    expect(t.ratePerSeatYear).toBe(3000);   // 250 × 12
    expect(t.costPerSeatYear).toBe(1260);   // 105 × 12
    expect(t.lineRevenue).toBe(90_000);
    expect(t.lineCost).toBe(37_800);
    expect(t.grossMargin).toBe(52_200);
    expect(t.grossMarginBps).toBe(5800);    // 58.00%
  });

  it("the line total is always rate × qty exactly — what the screen shows adds up", () => {
    for (const seats of [1, 7, 11, 49, 51, 137]) {
      const t = slabLineTotals(slabPricing(item(), seats), seats);
      expect(t.lineRevenue, `${seats} seats`).toBe(t.ratePerSeatYear * seats);
    }
  });

  it("margin is NULL, not 0%, on a zero-revenue line", () => {
    /* 0% margin on a ₹0 line is a statement about nothing, and it renders
       identically to a genuine 0% deal. */
    const t = slabLineTotals({ msrpPerSeatMonth: 0, wholesalePerSeatMonth: 0, slab: null, source: "flat", label: null }, 10);
    expect(t.grossMarginBps).toBeNull();
  });

  it("reports a NEGATIVE margin rather than clamping it", () => {
    const t = slabLineTotals({ msrpPerSeatMonth: 100, wholesalePerSeatMonth: 110, slab: null, source: "flat", label: null }, 10);
    expect(t.grossMargin).toBeLessThan(0);
    expect(t.grossMarginBps).toBeLessThan(0);
  });

  it("ignores fractional seats rather than billing a fraction of a person", () => {
    const t = slabLineTotals(slabPricing(item(), 10), 10.7);
    expect(t.lineRevenue).toBe(10 * 270 * 12);
  });
});

describe("nextSlabUpsell", () => {
  it("tells the rep the exact ask and the exact saving", () => {
    // 8 seats today. Reaching 11 drops every seat from ₹270 to ₹250.
    const up = nextSlabUpsell(SLABS, 8)!;
    expect(up.seatsToAdd).toBe(3);
    expect(up.newRatePerSeatMonth).toBe(250);
    expect(up.label).toBe("11–50 seats");
    // At 11 seats: ₹270×12×11 = 35,640 vs ₹250×12×11 = 33,000
    expect(up.annualSaving).toBe(2640);
  });

  it("returns null in the top band — no nudge beats an empty nudge", () => {
    expect(nextSlabUpsell(SLABS, 80)).toBeNull();
  });

  it("ignores a bigger band that is not actually cheaper", () => {
    /* A price list where volume costs more is a data error, not an upsell to pitch. */
    const wrong: SeatSlab[] = [
      { minSeats: 1,  maxSeats: 10,   msrp: 230, wholesale: 100 },
      { minSeats: 11, maxSeats: null, msrp: 270, wholesale: 110 },
    ];
    expect(nextSlabUpsell(wrong, 8)).toBeNull();
  });

  it("returns null when no band covers the current seat count", () => {
    expect(nextSlabUpsell(SLABS, 0)).toBeNull();
  });
});

describe("slabLabel", () => {
  it("renders closed and open bands differently", () => {
    expect(slabLabel(SLABS[1])).toBe("11–50 seats");
    expect(slabLabel(SLABS[2])).toBe("51+ seats");
  });
});
