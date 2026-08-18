import { describe, it, expect } from "vitest";
import { layoutWaterfall, pnlWaterfall, hundredRupeeSplit, type WaterfallInput } from "./waterfall";

/** ANUTECH's own shape: ₹1,11,051 revenue, ₹70,340 licence cost, ₹30,000 running costs. */
const LIVE: WaterfallInput[] = [
  { key: "revenue", label: "Revenue", delta: 111_051 },
  { key: "cogs", label: "Licence cost", delta: -70_340 },
  { key: "gross", label: "Gross margin", delta: 0, isTotal: true },
  { key: "opex", label: "Running costs", delta: -30_000 },
  { key: "net", label: "Net profit", delta: 0, isTotal: true },
];

/**
 * ─── THE ARITHMETIC IS THE POINT ────────────────────────────────────────────
 * A waterfall's meaning is in where each bar STARTS. Get the running total wrong and it
 * still renders beautifully — bars at plausible heights, nothing to see. Only arithmetic
 * catches it, which is why the geometry is a pure function.
 */
describe("the running total", () => {
  const { bars } = layoutWaterfall(LIVE);
  const by = Object.fromEntries(bars.map((b) => [b.key, b]));

  it("starts revenue at zero", () => {
    expect(by.revenue.start).toBe(0);
    expect(by.revenue.end).toBe(111_051);
  });

  it("hangs the cost bar off the top of revenue, not off the axis", () => {
    /* This is the one that looks fine when it is wrong. */
    expect(by.cogs.start).toBe(111_051);
    expect(by.cogs.end).toBe(40_711);
  });

  it("draws a subtotal from ZERO, as a full column", () => {
    expect(by.gross.start).toBe(0);
    expect(by.gross.end).toBe(40_711);
    expect(by.gross.direction).toBe("total");
  });

  it("does not let a subtotal move the running balance", () => {
    /* It restates it. Letting Gross Margin add to the total would double-count the
       margin into Net Profit — the classic waterfall bug. */
    expect(by.opex.start).toBe(40_711);
    expect(by.net.end).toBe(10_711);
  });

  it("ends where the P&L ends", () => {
    expect(by.net.end).toBe(111_051 - 70_340 - 30_000);
  });

  it("marks direction so up and down can be coloured apart", () => {
    expect(by.revenue.direction).toBe("up");
    expect(by.cogs.direction).toBe("down");
    expect(by.opex.direction).toBe("down");
  });
});

describe("the geometry", () => {
  it("scales every bar to the same span", () => {
    const { bars, max, min } = layoutWaterfall(LIVE);
    expect(max).toBe(111_051);
    expect(min).toBe(0);
    for (const b of bars) {
      expect(b.heightFrac).toBeGreaterThanOrEqual(0);
      expect(b.heightFrac).toBeLessThanOrEqual(1);
      expect(b.baseFrac + b.heightFrac).toBeLessThanOrEqual(1.0001);
    }
  });

  it("makes the tallest bar fill the plot", () => {
    const rev = layoutWaterfall(LIVE).bars[0];
    expect(rev.baseFrac).toBe(0);
    expect(rev.heightFrac).toBeCloseTo(1, 5);
  });

  it("keeps bars proportional to their rupees", () => {
    const { bars } = layoutWaterfall(LIVE);
    const [rev, cogs] = bars;
    expect(cogs.heightFrac / rev.heightFrac).toBeCloseTo(70_340 / 111_051, 5);
  });
});

/**
 * ─── A LOSS MUST BE DRAWABLE ────────────────────────────────────────────────
 * A chart that cannot render a negative net profit is a chart that hides the only month
 * anybody needed to look at.
 */
describe("a losing period", () => {
  const LOSS: WaterfallInput[] = [
    { key: "revenue", label: "Revenue", delta: 50_000 },
    { key: "cogs", label: "Licence cost", delta: -40_000 },
    { key: "gross", label: "Gross margin", delta: 0, isTotal: true },
    { key: "opex", label: "Running costs", delta: -30_000 },
    { key: "net", label: "Net profit", delta: 0, isTotal: true },
  ];

  it("carries the running total below zero", () => {
    const by = Object.fromEntries(layoutWaterfall(LOSS).bars.map((b) => [b.key, b]));
    expect(by.net.end).toBe(-20_000);
  });

  it("extends the scale downwards instead of clipping", () => {
    const { min, max, zeroFrac } = layoutWaterfall(LOSS);
    expect(min).toBe(-20_000);
    expect(max).toBe(50_000);
    /* Zero sits 20k up a 70k span. */
    expect(zeroFrac).toBeCloseTo(20_000 / 70_000, 5);
  });

  it("puts zero at the bottom when nothing went negative", () => {
    expect(layoutWaterfall(LIVE).zeroFrac).toBe(0);
  });

  it("survives an all-zero period without dividing by zero", () => {
    const flat = layoutWaterfall([{ key: "a", label: "A", delta: 0 }]);
    expect(Number.isFinite(flat.bars[0].heightFrac)).toBe(true);
    expect(flat.bars[0].heightFrac).toBe(0);
  });
});

/**
 * ─── AND IT REFUSES TO DRAW WHAT IT DOES NOT KNOW ───────────────────────────
 * A waterfall's shape asserts that every step is known. Drawing one over a missing COGS
 * would be the same confident lie the numbers told, only prettier.
 */
describe("pnlWaterfall", () => {
  it("builds the five steps in the reseller's own order", () => {
    const steps = pnlWaterfall({
      revenue: 111_051, cogs: 70_340, cogsBasis: "estimated",
      grossMargin: 40_711, expenses: 30_000, netProfit: 10_711,
    })!;
    expect(steps.map((s) => s.key)).toEqual(["revenue", "cogs", "gross", "opex", "net"]);
  });

  it("returns NULL when the gross margin is unknown", () => {
    expect(pnlWaterfall({
      revenue: 108_552, cogs: 0, cogsBasis: "unknown",
      grossMargin: null, expenses: 0, netProfit: null,
    })).toBeNull();
  });

  it("flags an estimated cost bar so it can be drawn hatched", () => {
    const steps = pnlWaterfall({
      revenue: 111_051, cogs: 70_340, cogsBasis: "estimated",
      grossMargin: 40_711, expenses: 0, netProfit: 40_711,
    })!;
    const cogs = steps.find((s) => s.key === "cogs")!;
    expect(cogs.estimated).toBe(true);
    expect(cogs.hint).toMatch(/Estimated from wholesale/);
  });

  it("does not flag a billed cost, and says where it came from", () => {
    const steps = pnlWaterfall({
      revenue: 111_051, cogs: 68_000, cogsBasis: "billed",
      grossMargin: 43_051, expenses: 0, netProfit: 43_051,
    })!;
    const cogs = steps.find((s) => s.key === "cogs")!;
    expect(cogs.estimated).toBeFalsy();
    expect(cogs.hint).toMatch(/Paid to vendors/);
  });

  it("labels the steps in plain words, not accounting jargon", () => {
    /* "Licence cost" and "Running costs", not "COGS" and "Opex" — the owner reads this. */
    const steps = pnlWaterfall({
      revenue: 1, cogs: 0, cogsBasis: "billed", grossMargin: 1, expenses: 0, netProfit: 1,
    })!;
    const labels = steps.map((s) => s.label).join(" ");
    expect(labels).toContain("Licence cost");
    expect(labels).toContain("Running costs");
    expect(labels).not.toMatch(/COGS|EBITDA/);
  });

  it("lays out end-to-end with the P&L numbers it was given", () => {
    const steps = pnlWaterfall({
      revenue: 111_051, cogs: 70_340, cogsBasis: "estimated",
      grossMargin: 40_711, expenses: 30_000, netProfit: 10_711,
    })!;
    const by = Object.fromEntries(layoutWaterfall(steps).bars.map((b) => [b.key, b]));
    expect(by.gross.end).toBe(40_711);
    expect(by.net.end).toBe(10_711);
  });
});

/**
 * ─── THE SCALE PROBLEM A WATERFALL CANNOT FIX ───────────────────────────────
 * ANUTECH's ₹67,000 net profit against ₹9,14,376 of revenue is 7% — a bar four pixels
 * tall beside one that fills the plot. The chart is accurate and the most important number
 * on it is the one you cannot see. Normalising to ₹100 removes the scale entirely.
 */
describe("where every ₹100 goes", () => {
  it("turns the live figures into a sentence a reseller can repeat", () => {
    const s = hundredRupeeSplit({ revenue: 914_376, cogs: 571_827, expenses: 275_551 })!;
    expect(s.licence).toBe(63);
    expect(s.running).toBe(30);
    expect(s.profit).toBe(7);
    expect(s.isLoss).toBe(false);
  });

  it("ALWAYS totals exactly 100", () => {
    /* Rounding three shares independently gives 99 or 101, and a bar captioned "of every
       ₹100" that adds to 101 makes a reader distrust the whole page. */
    for (const t of [
      { revenue: 914_376, cogs: 571_827, expenses: 275_551 },
      { revenue: 100_000, cogs: 33_333, expenses: 33_333 },
      { revenue: 3, cogs: 1, expenses: 1 },
      { revenue: 7_777, cogs: 2_591, expenses: 2_593 },
    ]) {
      const s = hundredRupeeSplit(t)!;
      expect(s.licence + s.running + s.profit).toBe(100);
    }
  });

  it("shows a NEGATIVE profit share rather than clamping to zero", () => {
    /* A business spending ₹120 to earn ₹100 must read as −20, not 0. Clamping would draw
       a break-even business that is actually bleeding. */
    const s = hundredRupeeSplit({ revenue: 100_000, cogs: 70_000, expenses: 50_000 })!;
    expect(s.profit).toBe(-20);
    expect(s.isLoss).toBe(true);
  });

  it("returns null on no revenue — there is no 'every ₹100' to split", () => {
    expect(hundredRupeeSplit({ revenue: 0, cogs: 0, expenses: 50_000 })).toBeNull();
  });

  it("gives the whole ₹100 to profit when nothing was spent", () => {
    const s = hundredRupeeSplit({ revenue: 50_000, cogs: 0, expenses: 0 })!;
    expect(s.profit).toBe(100);
  });

  it("keeps every share a whole rupee — no decimals in a ₹100 story", () => {
    const s = hundredRupeeSplit({ revenue: 914_376, cogs: 571_827, expenses: 275_551 })!;
    for (const n of [s.licence, s.running, s.profit]) expect(Number.isInteger(n)).toBe(true);
  });
});

/**
 * ─── THE CONNECTOR IS WHAT MAKES IT A WATERFALL ─────────────────────────────
 * Without the line joining one bar's end to the next bar's start, five columns read as
 * five separate quantities of different sizes. The subtlety: it sits at the RUNNING
 * BALANCE, not at the bar's own top edge — and those differ on every cost bar, because a
 * cost bar hangs downwards.
 */
describe("connectors", () => {
  const { bars } = layoutWaterfall(LIVE);
  const by = Object.fromEntries(bars.map((b) => [b.key, b]));

  it("leaves the last bar unconnected — it joins nothing", () => {
    expect(by.net.connectorFrac).toBeNull();
    for (const k of ["revenue", "cogs", "gross", "opex"]) {
      expect(by[k].connectorFrac).not.toBeNull();
    }
  });

  it("sits where the NEXT bar starts, which is this bar's running balance", () => {
    /* Revenue ends at ₹1,11,051 and the cost bar starts there. */
    expect(by.revenue.connectorFrac).toBeCloseTo(by.revenue.baseFrac + by.revenue.heightFrac, 6);
  });

  it("is NOT the top of a downward bar — that is the trap", () => {
    /* The cost bar's top is ₹1,11,051 (where it starts); its connector must be at
       ₹40,711 (where it ends), because that is where gross margin begins. */
    const topOfCogs = by.cogs.baseFrac + by.cogs.heightFrac;
    expect(by.cogs.connectorFrac).toBeLessThan(topOfCogs);
    expect(by.cogs.connectorFrac).toBeCloseTo(by.cogs.baseFrac, 6);
  });

  it("stays inside the plot even when the balance goes negative", () => {
    const loss = layoutWaterfall([
      { key: "revenue", label: "R", delta: 50_000 },
      { key: "opex", label: "O", delta: -80_000 },
      { key: "net", label: "N", delta: 0, isTotal: true },
    ]);
    for (const b of loss.bars) {
      if (b.connectorFrac === null) continue;
      expect(b.connectorFrac).toBeGreaterThanOrEqual(0);
      expect(b.connectorFrac).toBeLessThanOrEqual(1);
    }
  });
});
