/**
 * What wiring add-seats.ts to the catalog changes, in rupees.
 *
 * Same purpose as add-seats-before-after.test.ts: this change alters a number that
 * goes on a PURCHASE ORDER to a distributor, so every case states the old figure, the
 * new one, and why, and stays afterwards as the regression guard.
 *
 * OLD: cost = round(annualPerSeat × 0.83 / 12), a flat 17% margin — except the draft
 *      PO also tried `.ilike("name", plan).limit(1)` with NO vendor filter, so the
 *      quote line and the PO could carry two different costs for the same seats.
 * NEW: one catalog lookup via planKey, one number, both records; the 17% survives
 *      only as a labelled last resort.
 */
import { describe, it, expect } from "vitest";
import { resolveSeatCost } from "./add-seats";
import { buildPlanIndex, type CatalogRow } from "./plan-match";

/** The tenant's real google rows, read from the DB on 14 Aug 2026 (₹/seat/month). */
const GOOGLE: CatalogRow[] = [
  { vendor: "google", name: "Google Workspace Business Starter", costPerSeatMonth: 110 },
  { vendor: "google", name: "Google Workspace Standard",         costPerSeatMonth: 620 },
  { vendor: "google", name: "Google Workspace Plus",             costPerSeatMonth: 1150 },
  { vendor: "google", name: "Google Workspace Enterprise",       costPerSeatMonth: 2050 },
];
const HOSTING: CatalogRow[] = [
  { vendor: "hosting", name: "Standard", costPerSeatMonth: 0 },
];

const googleIndex = buildPlanIndex(GOOGLE);

/** The old rule, reproduced so the comparison is measured, not remembered. */
const oldCost = (annualPerSeat: number) => Math.round((annualPerSeat * 0.83) / 12);

describe("resolveSeatCost — before / after, in rupees", () => {
  it.each([
    // plan                                  msrp/mo  old   new
    ["Google Workspace Business Starter",        270,  224,  110],
    ["Google Workspace Business Standard",       864,  717,  620],
    ["Google Workspace Business Plus",          1380, 1145, 1150],
  ] as const)("%s", (plan, msrpMonth, before, after) => {
    const annualPerSeat = msrpMonth * 12;
    expect(oldCost(annualPerSeat)).toBe(before);

    const got = resolveSeatCost({ index: googleIndex, vendor: "google", plan, annualPerSeat });
    expect(got.costPerSeatMonth).toBe(after);
    expect(got.source).toBe("catalog");
  });

  it("the worst case: Starter's cost was more than DOUBLE the truth", () => {
    /* ₹224 guessed against ₹110 real. On +5 seats with 6 months left the draft PO
       said ₹6,720 when the distributor will charge ₹3,300. The guess is closest on
       the products whose real margin happens to be near 17% (Plus is within ₹5) and
       wildest on the cheapest, highest-volume one. */
    const got = resolveSeatCost({
      index: googleIndex, vendor: "google",
      plan: "Google Workspace Business Starter", annualPerSeat: 270 * 12,
    });
    expect(oldCost(270 * 12) / got.costPerSeatMonth).toBeGreaterThan(2);
    expect(oldCost(270 * 12) * 5 * 6).toBe(6_720);
    expect(got.costPerSeatMonth * 5 * 6).toBe(3_300);
  });

  it("finds the two plans an exact-name lookup missed — the whole point", () => {
    // "Business Standard"/"Business Plus" are written by the dialog; the catalog says
    // "Standard"/"Plus". The old `.ilike("name", plan)` found neither.
    for (const [plan, cost] of [
      ["Google Workspace Business Standard", 620],
      ["Google Workspace Business Plus",    1150],
    ] as const) {
      expect(resolveSeatCost({ index: googleIndex, vendor: "google", plan, annualPerSeat: 99_999 }))
        .toEqual({ costPerSeatMonth: cost, source: "catalog" });
    }
  });
});

describe("resolveSeatCost — the heuristic, now labelled", () => {
  it("falls back to 17% when the catalog has no such plan, and SAYS so", () => {
    const got = resolveSeatCost({
      index: googleIndex, vendor: "google",
      plan: "Google Cloud Platform (GCP) Credits", annualPerSeat: 12_000,
    });
    expect(got).toEqual({ costPerSeatMonth: 830, source: "heuristic" });
  });

  it("refuses to guess the three Enterprise tiers onto the one Enterprise price", () => {
    // Catalog has ONE "Google Workspace Enterprise" at ₹2,050. A tier we cannot price
    // is estimated and flagged — not silently charged at ₹2,050.
    const got = resolveSeatCost({
      index: googleIndex, vendor: "google",
      plan: "Google Workspace Enterprise Plus", annualPerSeat: 32_400,
    });
    expect(got.source).toBe("heuristic");
    expect(got.costPerSeatMonth).not.toBe(2_050);
  });
});

describe("resolveSeatCost — a real zero cost is not a missing one", () => {
  it("keeps ₹0 for the reseller's own services instead of inventing 17%", () => {
    /* hosting / support have wholesale 0 because there IS no vendor cost. The old
       rule treated 0 as "not found" (`annualWholesale > 0 ? … : heuristic`) and
       substituted a guess, inflating the PO and understating margin on exactly the
       most profitable lines. */
    const idx = buildPlanIndex(HOSTING);
    expect(resolveSeatCost({ index: idx, vendor: "hosting", plan: "Standard", annualPerSeat: 12_000 }))
      .toEqual({ costPerSeatMonth: 0, source: "catalog" });
  });
});

describe("resolveSeatCost — the stored item_id (migration 0248)", () => {
  const costsById = new Map([["GW-STD-fbb", 620], ["GW-STR-fbb", 110]]);

  it("uses the stored link and ignores the plan text entirely", () => {
    /* The point of storing the id: renaming a catalog row, or a plan text that never
       matched anything, cannot break the cost. */
    expect(resolveSeatCost({
      index: googleIndex, costsById, itemId: "GW-STD-fbb",
      vendor: "google", plan: "whatever the operator typed", annualPerSeat: 10_368,
    })).toEqual({ costPerSeatMonth: 620, source: "catalog" });
  });

  it("beats the name match when the two would disagree", () => {
    // Name says Starter (₹110), stored id says Standard (₹620). The id wins.
    expect(resolveSeatCost({
      index: googleIndex, costsById, itemId: "GW-STD-fbb",
      vendor: "google", plan: "Google Workspace Business Starter", annualPerSeat: 3_240,
    }).costPerSeatMonth).toBe(620);
  });

  it("keeps a stored cost of ₹0 instead of falling through to a guess", () => {
    // hosting/support rows are genuinely ₹0. Treating 0 as "not found" is defect #4.
    expect(resolveSeatCost({
      index: googleIndex, costsById: new Map([["HOST-1", 0]]), itemId: "HOST-1",
      vendor: "hosting", plan: "Standard", annualPerSeat: 12_000,
    })).toEqual({ costPerSeatMonth: 0, source: "catalog" });
  });

  it("falls back to the name match when there is no stored link", () => {
    expect(resolveSeatCost({
      index: googleIndex, costsById, itemId: null,
      vendor: "google", plan: "Google Workspace Business Standard", annualPerSeat: 10_368,
    })).toEqual({ costPerSeatMonth: 620, source: "catalog" });
  });

  it("falls back rather than trusting an id that is not in the catalog", () => {
    // A dangling id (direct DB edit — the FK's ON DELETE SET NULL prevents the rest).
    // Better to match by name than to price the seat at nothing.
    const got = resolveSeatCost({
      index: googleIndex, costsById, itemId: "GONE-1",
      vendor: "google", plan: "Google Workspace Business Standard", annualPerSeat: 10_368,
    });
    expect(got).toEqual({ costPerSeatMonth: 620, source: "catalog" });
  });
});

describe("resolveSeatCost — vendor isolation", () => {
  it("never prices a Google seat from the hosting catalog", () => {
    /* The bug the vendor filter closes. `.ilike("name", "Standard")` with no vendor
       condition could return hosting's ₹0 row and write a ₹0 PO for a Google seat —
       a purchase order to a distributor for nothing. */
    const mixed = buildPlanIndex([...GOOGLE, ...HOSTING]);
    const got = resolveSeatCost({
      index: mixed, vendor: "google", plan: "Standard", annualPerSeat: 10_368,
    });
    expect(got.costPerSeatMonth).not.toBe(0);
    expect(got.source).toBe("heuristic");
  });

  it("an empty catalog degrades to the heuristic rather than to zero", () => {
    // A tenant who has entered no catalog at all must not get ₹0 costs — that would
    // read as 100% margin on everything they sell.
    const got = resolveSeatCost({
      index: buildPlanIndex([]), vendor: "google",
      plan: "Google Workspace Standard", annualPerSeat: 10_368,
    });
    expect(got).toEqual({ costPerSeatMonth: 717, source: "heuristic" });
  });
});
