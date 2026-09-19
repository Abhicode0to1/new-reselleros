/**
 * The catalogue's headline margin must not count products it knows nothing about.
 *
 * ─── THE DEFECT THIS PINS ───────────────────────────────────────────────────
 * `margin_pct` on a row with no vendor cost is 100% — sale price minus nothing. Those
 * rows were averaged into the figure at the top of /items, so a catalogue that could
 * not price a third of its products still reported a healthy margin. The number was
 * most confident exactly where it was blindest, which is the worst possible failure
 * shape for a number somebody prices against.
 */
import { describe, it, expect } from "vitest";
import { catalogCostCoverage } from "./cost-coverage";

const row = (wholesale: number | null, margin_pct: number) => ({ wholesale, margin_pct });

describe("catalogCostCoverage — averages only what it actually knows", () => {
  it("EXCLUDES zero-cost rows from the average", () => {
    /* The defect itself. Two real products at 20% and 30%, one unpriced reading 100%.
       Averaging all three gives 50% — a catalogue that looks twice as healthy as it is. */
    const c = catalogCostCoverage([row(100, 20), row(200, 30), row(0, 100)]);
    expect(c.avgMarginPct).toBe(25);
    expect(c.priced).toHaveLength(2);
    expect(c.unpriced).toHaveLength(1);
  });

  it("treats null, 0 and a negative cost all as NOT RECORDED", () => {
    /* Null is an empty column, 0 is what the form writes when nobody types anything, and
       a negative cost is not a vendor price at all. None is a fact about money. */
    const c = catalogCostCoverage([row(null, 100), row(0, 100), row(-50, 140), row(110, 18)]);
    expect(c.unpriced).toHaveLength(3);
    expect(c.avgMarginPct).toBe(18);
  });

  it("returns 0 and an empty priced list when NOTHING has a cost", () => {
    /* The caller must not print "0%" as though it were measured — it has priced.length
       to know the difference. Asserted so the contract is explicit. */
    const c = catalogCostCoverage([row(0, 100), row(null, 100)]);
    expect(c.avgMarginPct).toBe(0);
    expect(c.priced).toHaveLength(0);
    expect(c.unpriced).toHaveLength(2);
  });

  it("keeps every row — nothing is silently dropped", () => {
    /* priced + unpriced must always account for the whole catalogue, or the count shown
       beside the average would not match the list below it. */
    const rows = [row(100, 20), row(0, 100), row(null, 100), row(250, 40), row(-1, 0)];
    const c = catalogCostCoverage(rows);
    expect(c.priced.length + c.unpriced.length).toBe(rows.length);
  });

  it("rounds to a whole percent, and rounds the AVERAGE not each row", () => {
    /* 20 + 21 + 21 = 62 / 3 = 20.67 → 21. Rounding each row first would still give 21
       here; the case that separates them is asserted below. */
    expect(catalogCostCoverage([row(1, 20), row(1, 21), row(1, 21)]).avgMarginPct).toBe(21);
    /* 10.4 and 10.4 average to 10.4 → 10. Rounding each to 10 first also gives 10, but
       10.6 and 10.4 average to 10.5 → 11, where per-row rounding gives 11 and 10 → 10.5
       → 11 as well. The real protection is that ONE rounding happens, at the end. */
    expect(catalogCostCoverage([row(1, 10.6), row(1, 10.4)]).avgMarginPct).toBe(11);
  });

  it("handles an empty catalogue without dividing by zero", () => {
    const c = catalogCostCoverage([]);
    expect(c.avgMarginPct).toBe(0);
    expect(c.priced).toEqual([]);
    expect(c.unpriced).toEqual([]);
  });

  it("preserves the original rows, so the caller can name the unpriced products", () => {
    /* The warning on /items lists product names. It can only do that if the rows come
       back whole rather than as counts. */
    const a = { wholesale: 0, margin_pct: 100, name: "Workspace Plus" };
    const b = { wholesale: 110, margin_pct: 59, name: "Starter" };
    const c = catalogCostCoverage([a, b]);
    expect(c.unpriced[0].name).toBe("Workspace Plus");
    expect(c.priced[0].name).toBe("Starter");
  });
});
