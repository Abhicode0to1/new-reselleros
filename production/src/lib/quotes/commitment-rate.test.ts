import { describe, it, expect } from "vitest";
import { convertRateForCommitment, isAnnualTier } from "./commitment-rate";

describe("isAnnualTier", () => {
  it("treats only flex-monthly as per-month", () => {
    expect(isAnnualTier("monthly")).toBe(false);
    for (const c of ["annual_yearly", "annual_monthly", "annual_quarterly", "annual_half_yearly"] as const) {
      expect(isAnnualTier(c), c).toBe(true);
    }
  });

  it("defaults an absent commitment to annual, matching the schema default", () => {
    /* database.types.ts: `commitment?: LineCommitment; // default "annual_yearly"`. */
    expect(isAnnualTier(null)).toBe(true);
    expect(isAnnualTier(undefined)).toBe(true);
  });
});

describe("convertRateForCommitment", () => {
  it("divides by twelve going annual → monthly", () => {
    /* THE BUG. Q-TEST-2026-27-0009 holds rate 3240 / cost 1320 on a line labelled
       "monthly" — 270x12 and 110x12 against a ₹270/₹110 catalogue — because the builder
       kept the annual rate when the item had no price tier to read. */
    const r = convertRateForCommitment({ rate: 3240, cost: 1320, from: "annual_yearly", to: "monthly" });
    expect(r).toEqual({ rate: 270, cost: 110, converted: true });
  });

  it("multiplies by twelve going monthly → annual", () => {
    const r = convertRateForCommitment({ rate: 270, cost: 110, from: "monthly", to: "annual_yearly" });
    expect(r).toEqual({ rate: 3240, cost: 1320, converted: true });
  });

  it("leaves a rate alone within the annual family", () => {
    /* annual_yearly → annual_quarterly changes only how often invoices are raised
       (quote.billing_cycle, migration 0161). The PRICE TIER, and so the unit, is the
       same — converting here would be the mirror of the bug. */
    for (const to of ["annual_monthly", "annual_quarterly", "annual_half_yearly"] as const) {
      const r = convertRateForCommitment({ rate: 3240, cost: 1320, from: "annual_yearly", to });
      expect(r, to).toEqual({ rate: 3240, cost: 1320, converted: false });
    }
  });

  it("leaves a rate alone monthly → monthly", () => {
    const r = convertRateForCommitment({ rate: 270, cost: 110, from: "monthly", to: "monthly" });
    expect(r.converted).toBe(false);
    expect(r.rate).toBe(270);
  });

  it("round-trips back to the original", () => {
    /* An operator who flips annual → monthly → annual must not lose money to rounding. */
    const down = convertRateForCommitment({ rate: 3240, cost: 1320, from: "annual_yearly", to: "monthly" });
    const up = convertRateForCommitment({ rate: down.rate, cost: down.cost, from: "monthly", to: "annual_yearly" });
    expect(up.rate).toBe(3240);
    expect(up.cost).toBe(1320);
  });

  it("rounds rather than truncating", () => {
    /* 3245/12 = 270.41. A floor would quietly shave the rate on every conversion. */
    expect(convertRateForCommitment({ rate: 3245, cost: 0, from: "annual_yearly", to: "monthly" }).rate).toBe(270);
    expect(convertRateForCommitment({ rate: 3250, cost: 0, from: "annual_yearly", to: "monthly" }).rate).toBe(271);
  });

  it("keeps a zero cost at zero", () => {
    /* `cost = 0` is deliberate in the builder — with no catalogue row the vendor cost is
       genuinely unknown, and 0 makes the margin visibly wrong (100%) instead of
       plausibly wrong. Manufacturing a number here would undo that. */
    const r = convertRateForCommitment({ rate: 3240, cost: 0, from: "annual_yearly", to: "monthly" });
    expect(r.cost).toBe(0);
    expect(r.rate).toBe(270);
  });

  it("treats a missing commitment as annual, so the conversion still happens", () => {
    /* A line saved before `commitment` existed reads as undefined. Switching it to
       monthly must still divide — that line's rate is per-year. */
    const r = convertRateForCommitment({ rate: 3240, cost: 1320, from: undefined, to: "monthly" });
    expect(r.converted).toBe(true);
    expect(r.rate).toBe(270);
  });

  it("survives null, undefined and negative inputs without producing a negative rate", () => {
    for (const v of [null, undefined, -500]) {
      const r = convertRateForCommitment({ rate: v, cost: v, from: "annual_yearly", to: "monthly" });
      expect(r.rate, String(v)).toBe(0);
      expect(r.cost, String(v)).toBe(0);
    }
  });
});
