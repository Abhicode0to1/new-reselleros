/**
 * R-012, half two — a renewal's cost comes from the catalogue or is admitted unknown.
 *
 * The case that matters is not the arithmetic. It is that NOTHING here produces a
 * plausible number when the catalogue is silent: the old code multiplied the selling
 * price by 0.83 and every renewal quote then reported a 17% margin, forever, because
 * the margin was defined to be 17%.
 */
import { describe, it, expect } from "vitest";
import { renewalCost } from "./renewal-cost";

describe("renewalCost — what the vendor charges us", () => {
  it("costs a MONTHLY renewal for one month, not twelve", () => {
    /* items.wholesale is per seat per MONTH. Multiplying by 12 regardless is the
       sibling of the bug this fixes, and it would turn a healthy margin into a loss. */
    expect(renewalCost({ wholesalePerSeatMonth: 110, termMonths: 1, seats: 10 }))
      .toMatchObject({ perSeat: 110, total: 1100, known: true });
  });

  it("costs an ANNUAL renewal for twelve", () => {
    expect(renewalCost({ wholesalePerSeatMonth: 110, termMonths: 12, seats: 10 }))
      .toMatchObject({ perSeat: 1320, total: 13200, known: true });
  });

  it("never returns the 0.83 guess the old code used", () => {
    /* Business Starter: real wholesale ₹110/seat/month, so ₹1,320/seat/year. The old
       code took 83% of the SELLING price — about ₹224/seat/month, ₹2,688/year. Double.
       Pinned as a number so a reintroduced guess fails here rather than on a quote. */
    const r = renewalCost({ wholesalePerSeatMonth: 110, termMonths: 12, seats: 1 });
    expect(r.perSeat).toBe(1320);
    expect(r.perSeat).not.toBe(2688);
  });
});

describe("renewalCost — when it cannot be known", () => {
  it("refuses when the catalogue has no wholesale", () => {
    // A bespoke plan has no catalogue row. That is ordinary, and it is not free.
    expect(renewalCost({ wholesalePerSeatMonth: null, termMonths: 12, seats: 10 }))
      .toMatchObject({ known: false, perSeat: 0, total: 0 });
  });

  it("treats a zero wholesale as a blank field, not a free product", () => {
    /* Same reading lib/vendor/cogs.ts takes of the same column. A ₹0 wholesale on a
       resold SKU is missing data; reporting it as 100% margin puts the healthiest
       number in the app on the row we know least about. */
    expect(renewalCost({ wholesalePerSeatMonth: 0, termMonths: 12, seats: 10 }).known).toBe(false);
  });

  it("refuses a negative or non-finite wholesale", () => {
    expect(renewalCost({ wholesalePerSeatMonth: -50, termMonths: 12, seats: 10 }).known).toBe(false);
    expect(renewalCost({ wholesalePerSeatMonth: Number.NaN, termMonths: 12, seats: 10 }).known).toBe(false);
  });

  it("refuses when the term or the seat count is missing", () => {
    expect(renewalCost({ wholesalePerSeatMonth: 110, termMonths: 0, seats: 10 }).known).toBe(false);
    expect(renewalCost({ wholesalePerSeatMonth: 110, termMonths: 12, seats: 0 }).known).toBe(false);
  });

  it("says WHY, so the cron log names the plan's missing price", () => {
    const r = renewalCost({ wholesalePerSeatMonth: null, termMonths: 12, seats: 10 });
    expect(r.reason).toMatch(/catalogue/i);
  });

  it("carries no reason when it IS known", () => {
    expect(renewalCost({ wholesalePerSeatMonth: 110, termMonths: 12, seats: 10 }).reason).toBeNull();
  });

  it("zero is the value the existing reader already treats as unknown", () => {
    /* approval-economics.ts: `if (l.cost <= 0 && l.rate > 0) costUnknown = true`.
       Returning 0 hands that reader the right answer instead of inventing a nullable
       field every other reader would have to learn. */
    const r = renewalCost({ wholesalePerSeatMonth: null, termMonths: 12, seats: 10 });
    expect(r.perSeat).toBeLessThanOrEqual(0);
  });
});
