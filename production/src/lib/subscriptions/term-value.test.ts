import { describe, it, expect } from "vitest";
import { termValue, termValueLabel } from "./renewal-display";
import { rupee } from "@/lib/utils";

/**
 * ─── THE LIVE BUG ───────────────────────────────────────────────────────────
 * A support plan quoted at ₹2,000/yr showed as "Annual · ₹2,004". `subscriptions` stores
 * only a monthly figure, so ₹2,000 became mrr = round(2000/12) = 167, and the page rebuilt
 * the annual as 167 × 12 = 2,004. The ₹4 was invented by the round trip.
 */
describe("the ₹4 nobody agreed to", () => {
  it("reproduces the round-trip drift when only the monthly is known", () => {
    const v = termValue(167, 12);
    expect(v).toEqual({ amount: 2004, exact: false });
  });

  it("returns the CONTRACTED ₹2,000 when the quote line is supplied", () => {
    expect(termValue(167, 12, 2000)).toEqual({ amount: 2000, exact: true });
  });

  /**
   * What made this nasty: on the same screen the Google line was right and the support
   * line was wrong, because ₹45,360 happens to divide evenly by 12.
   */
  it("is silent on a price that divides evenly — which is why it hid for so long", () => {
    expect(termValue(3780, 12).amount).toBe(45360);
    expect(termValue(3780, 12, 45360).amount).toBe(45360);
  });

  it("never claims precision it does not have", () => {
    expect(termValueLabel(termValue(167, 12), rupee)).toBe("about ₹2,004");
    expect(termValueLabel(termValue(167, 12, 2000), rupee)).toBe("₹2,000");
  });
});

describe("terms shorter than a year", () => {
  it("scales from the ANNUAL and rounds once", () => {
    /* Going via a monthly would reintroduce the drift this function removes:
       round(2000/12) × 3 = 501, where a quarter of ₹2,000 is ₹500. */
    expect(termValue(167, 3, 2000)).toEqual({ amount: 500, exact: true });
    expect(termValue(167, 6, 2000)).toEqual({ amount: 1000, exact: true });
  });

  it("a monthly term is the monthly figure", () => {
    expect(termValue(167, 1, 2000).amount).toBe(167);
  });
});

describe("missing data", () => {
  it("treats a null or zero contracted amount as unknown, not as zero", () => {
    /* A zero would otherwise print "₹0 invoiced at renewal" and look authoritative. */
    expect(termValue(167, 12, null)).toEqual({ amount: 2004, exact: false });
    expect(termValue(167, 12, 0)).toEqual({ amount: 2004, exact: false });
  });

  it("survives a null mrr", () => {
    expect(termValue(null, 12)).toEqual({ amount: 0, exact: false });
  });
});
