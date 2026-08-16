import { describe, it, expect } from "vitest";
import { computeRetention, reconciles, retentionVerdict, fmtBps, type MrrPoint } from "./retention";

const pts = (o: Record<string, number>): MrrPoint[] =>
  Object.entries(o).map(([customerId, mrr]) => ({ customerId, mrr }));

describe("new customers are EXCLUDED from NRR", () => {
  it("a big new logo does not inflate retention", () => {
    /* The classic mistake. Existing customers all shrank, but a new customer
       arrived at 10× — including them would show 180% NRR while retention was at
       its worst. */
    const r = computeRetention(
      pts({ a: 10_000, b: 10_000 }),
      pts({ a: 8_000, b: 8_000, brandNew: 100_000 }),
    );
    expect(r.nrrBps).toBe(8000);        // 80%, not 580%
    expect(r.newMrr).toBe(100_000);
    expect(r.counts.new).toBe(1);
  });

  it("reports new MRR separately — it is the other half of the story", () => {
    const r = computeRetention(pts({ a: 10_000 }), pts({ a: 10_000, b: 5_000 }));
    expect(r.nrrBps).toBe(10_000);
    expect(r.newMrr).toBe(5_000);
  });
});

describe("every movement lands in exactly one bucket", () => {
  it("expansion", () => {
    const r = computeRetention(pts({ a: 10_000 }), pts({ a: 13_000 }));
    expect(r).toMatchObject({ expansion: 3_000, contraction: 0, churned: 0 });
    expect(r.nrrBps).toBe(13_000);
    expect(r.counts.expanded).toBe(1);
  });

  it("contraction — a customer who SHRANK has not churned", () => {
    const r = computeRetention(pts({ a: 10_000 }), pts({ a: 6_000 }));
    expect(r).toMatchObject({ contraction: 4_000, churned: 0 });
    expect(r.counts.contracted).toBe(1);
    expect(r.counts.churned).toBe(0);
  });

  it("churn — a customer who LEFT is not 100% contraction", () => {
    const r = computeRetention(pts({ a: 10_000 }), pts({}));
    expect(r).toMatchObject({ churned: 10_000, contraction: 0 });
    expect(r.counts.churned).toBe(1);
    expect(r.counts.contracted).toBe(0);
  });

  it("a customer dropping to zero MRR counts as churned, not retained at ₹0", () => {
    const r = computeRetention(pts({ a: 10_000 }), pts({ a: 0 }));
    expect(r.churned).toBe(10_000);
    expect(r.counts.retained).toBe(0);
  });

  it("flat customers are retained but move nothing", () => {
    const r = computeRetention(pts({ a: 10_000 }), pts({ a: 10_000 }));
    expect(r).toMatchObject({ expansion: 0, contraction: 0, churned: 0 });
    expect(r.counts.retained).toBe(1);
  });

  it("sums several subscriptions per customer — a plan swap is not churn", () => {
    /* Identity is the CUSTOMER. Someone who moved from one subscription to another
       has not churned, and per-subscription identity would report both a churn and
       a new customer for the same person. */
    const start = [{ customerId: "a", mrr: 6_000 }, { customerId: "a", mrr: 4_000 }];
    const end   = [{ customerId: "a", mrr: 10_000 }];
    const r = computeRetention(start, end);
    expect(r.startingMrr).toBe(10_000);
    expect(r.nrrBps).toBe(10_000);
    expect(r.counts.churned).toBe(0);
  });
});

describe("the identity always reconciles", () => {
  it("ending = start + expansion − contraction − churn", () => {
    const r = computeRetention(
      pts({ a: 10_000, b: 20_000, c: 5_000, d: 8_000 }),
      pts({ a: 14_000, b: 15_000, d: 8_000, newbie: 30_000 }),
    );
    expect(reconciles(r)).toBe(true);
    expect(r).toMatchObject({ startingMrr: 43_000, expansion: 4_000, contraction: 5_000, churned: 5_000 });
    expect(r.endingCohortMrr).toBe(37_000);
  });

  it("reconciles across many random-ish shapes", () => {
    const shapes: Array<[Record<string, number>, Record<string, number>]> = [
      [{ a: 1 }, { a: 1 }],
      [{ a: 100, b: 200 }, { b: 50, c: 900 }],
      [{ a: 7_777 }, {}],
      [{}, { z: 1_000 }],
      [{ a: 3, b: 3, c: 3 }, { a: 4, b: 2, c: 3 }],
    ];
    for (const [s, e] of shapes) {
      expect(reconciles(computeRetention(pts(s), pts(e))), JSON.stringify([s, e])).toBe(true);
    }
  });
});

describe("GRR never exceeds 100%", () => {
  it("ignores expansion entirely", () => {
    const r = computeRetention(pts({ a: 10_000 }), pts({ a: 20_000 }));
    expect(r.nrrBps).toBe(20_000);
    expect(r.grrBps).toBe(10_000);
  });

  it("counts contraction and churn", () => {
    const r = computeRetention(pts({ a: 10_000, b: 10_000 }), pts({ a: 8_000 }));
    // (20,000 − 2,000 − 10,000) / 20,000 = 40%
    expect(r.grrBps).toBe(4000);
  });
});

describe("one snapshot is not a comparison", () => {
  it("returns NULL, not 100%, when there was nothing to retain", () => {
    /* An empty comparison arithmetically yields 1.0, which reads as perfect
       retention on screen. */
    const r = computeRetention([], pts({ a: 10_000 }));
    expect(r.nrrBps).toBeNull();
    expect(r.grrBps).toBeNull();
    expect(r.newMrr).toBe(10_000);
  });

  it("says so in words", () => {
    const v = retentionVerdict(computeRetention([], []));
    expect(v.verdict).toBe("unknown");
    expect(v.message).toMatch(/nothing to have retained/);
  });

  it("handles both sides empty", () => {
    const r = computeRetention([], []);
    expect(r).toMatchObject({ startingMrr: 0, endingCohortMrr: 0, newMrr: 0 });
  });
});

describe("input hygiene", () => {
  it("ignores zero and negative MRR rows on both sides", () => {
    const r = computeRetention(
      [{ customerId: "a", mrr: 0 }, { customerId: "b", mrr: 10_000 }],
      [{ customerId: "b", mrr: 10_000 }, { customerId: "c", mrr: -500 }],
    );
    expect(r.startingMrr).toBe(10_000);
    expect(r.counts.new).toBe(0);
  });
});

describe("retentionVerdict", () => {
  const at = (startMrr: number, endMrr: number) =>
    retentionVerdict(computeRetention(pts({ a: startMrr }), pts({ a: endMrr })));

  it.each([
    [10_000, 12_000, "excellent"],
    [10_000, 10_500, "healthy"],
    [10_000, 10_000, "healthy"],
    [10_000, 9_500,  "leaking"],
    [10_000, 7_000,  "bleeding"],
  ])("%s → %s = %s", (s, e, verdict) => {
    expect(at(s, e).verdict).toBe(verdict);
  });

  it("names what a leak actually costs rather than just labelling it", () => {
    expect(at(10_000, 9_500).message).toMatch(/New business is covering it/);
    expect(at(10_000, 7_000).message).toMatch(/halves before new business/);
  });
});

describe("fmtBps", () => {
  it.each([
    [11_050, "110.5%"],
    [10_000, "100%"],
    [8_000,  "80%"],
    [null,   "—"],
  ])("%s → %s", (bps, expected) => {
    expect(fmtBps(bps as number | null)).toBe(expected);
  });
});
