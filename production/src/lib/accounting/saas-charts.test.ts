import { describe, it, expect } from "vitest";
import {
  MIN_COHORTS_FOR_VELOCITY,
  monthsBetween,
  mrrTrend,
  retentionCurve,
  retentionVelocity,
  trendCaveats,
  type CohortInput,
  type SubLifespan,
} from "./saas-charts";

const TODAY = new Date("2026-08-25T00:00:00Z");

const sub = (over: Partial<SubLifespan> = {}): SubLifespan => ({
  startDate: "2026-06-10",
  mrr: 1000,
  status: "active",
  updatedAt: "2026-08-01T00:00:00Z",
  ...over,
});

describe("mrrTrend", () => {
  it("returns exactly the window asked for, ending at this month", () => {
    /* Fixed length so the axis does not change width when a subscription is added — a chart
       whose x-axis moves under the reader is one they stop trusting. */
    const points = mrrTrend([], 6, TODAY);
    expect(points).toHaveLength(6);
    expect(points[5].monthKey).toBe("2026-08");
    expect(points[0].monthKey).toBe("2026-03");
  });

  it("counts a subscription from its start month onward, not before", () => {
    const points = mrrTrend([sub({ startDate: "2026-06-10", mrr: 1000 })], 4, TODAY);
    const byKey = Object.fromEntries(points.map((p) => [p.monthKey, p.mrr]));
    expect(byKey["2026-05"]).toBe(0);
    expect(byKey["2026-06"]).toBe(1000);
    expect(byKey["2026-07"]).toBe(1000);
    expect(byKey["2026-08"]).toBe(1000);
  });

  it("counts a subscription that started on the last day of a month IN that month", () => {
    /* Off-by-one at the month boundary is the classic way a trend quietly loses a customer. */
    const points = mrrTrend([sub({ startDate: "2026-07-31", mrr: 500 })], 3, TODAY);
    expect(points.find((p) => p.monthKey === "2026-07")?.mrr).toBe(500);
  });

  it("keeps a PAUSED subscription on the book", () => {
    /* A paused subscription still renews and is still revenue at risk. Dropping it would
       under-report MRR in exactly the months somebody is investigating. */
    const points = mrrTrend([sub({ status: "paused", mrr: 800 })], 3, TODAY);
    expect(points[points.length - 1].mrr).toBe(800);
  });

  it("drops a cancelled subscription after its last-updated month", () => {
    const points = mrrTrend(
      [sub({ startDate: "2026-06-01", status: "cancelled", updatedAt: "2026-07-05T00:00:00Z", mrr: 900 })],
      4,
      TODAY,
    );
    const byKey = Object.fromEntries(points.map((p) => [p.monthKey, p.mrr]));
    expect(byKey["2026-06"]).toBe(900);
    expect(byKey["2026-07"]).toBe(900);
    expect(byKey["2026-08"]).toBe(0);
  });

  it("UNDER-states rather than over-states when the end date is unusable", () => {
    /* The direction is the assertion. An MRR line that overstates is the one an owner makes a
       plan on, so an unparseable churn date drops the subscription rather than keeping it. */
    const points = mrrTrend(
      [sub({ startDate: "2026-06-01", status: "cancelled", updatedAt: "not-a-date", mrr: 900 })],
      3,
      TODAY,
    );
    expect(points.every((p) => p.mrr === 0)).toBe(true);
  });

  it("treats a null mrr as zero rupees, not as a missing subscription", () => {
    const points = mrrTrend([sub({ mrr: null })], 3, TODAY);
    const last = points[points.length - 1];
    expect(last.mrr).toBe(0);
    expect(last.active).toBe(1);
  });

  it("adds several subscriptions together", () => {
    const points = mrrTrend(
      [sub({ mrr: 1000 }), sub({ mrr: 2500 }), sub({ mrr: 439 })],
      2,
      TODAY,
    );
    const last = points[points.length - 1];
    expect(last.mrr).toBe(3939);
    expect(last.active).toBe(3);
  });

  it("survives a subscription with an unusable start date instead of throwing", () => {
    const points = mrrTrend([sub({ startDate: "" }), sub({ mrr: 100 })], 2, TODAY);
    expect(points[points.length - 1].mrr).toBe(100);
  });

  it("builds months in UTC, so a date does not slip into the previous month", () => {
    /* `2026-07-01` constructed locally is 30 June in any timezone west of UTC. These are DATE
       columns; the whole series would shift by a month. */
    const points = mrrTrend([sub({ startDate: "2026-07-01", mrr: 700 })], 3, TODAY);
    expect(points.find((p) => p.monthKey === "2026-06")?.mrr).toBe(0);
    expect(points.find((p) => p.monthKey === "2026-07")?.mrr).toBe(700);
  });
});

describe("trendCaveats", () => {
  it("always states that past months use today's rate", () => {
    /* The caveat that matters most: the rupees in past months are not what was billed. */
    expect(trendCaveats([sub()])[0]).toContain("today's rate");
  });

  it("mentions the churn-date proxy ONLY when something has actually ended", () => {
    /* Noise is how a reader learns to skip the caveats that matter. */
    expect(trendCaveats([sub()])).toHaveLength(1);
    const withChurn = trendCaveats([sub(), sub({ status: "cancelled" })]);
    expect(withChurn).toHaveLength(2);
    expect(withChurn[1]).toContain("last-updated");
  });
});

describe("monthsBetween", () => {
  it("counts calendar months, not 30-day blocks", () => {
    expect(monthsBetween(new Date("2026-01-31T00:00:00Z"), new Date("2026-02-01T00:00:00Z"))).toBe(1);
    expect(monthsBetween(new Date("2025-11-05T00:00:00Z"), new Date("2026-02-05T00:00:00Z"))).toBe(3);
  });
});

const cohort = (over: Partial<CohortInput> = {}): CohortInput => ({
  monthKey: "2026-08",
  monthLabel: "Aug 2026",
  startedCount: 10,
  retainedCount: 10,
  retentionPct: 100,
  ...over,
});

describe("retentionCurve", () => {
  it("arranges cohorts by age, oldest first", () => {
    const curve = retentionCurve(
      [
        cohort({ monthKey: "2026-08", monthLabel: "Aug 2026" }),
        cohort({ monthKey: "2026-05", monthLabel: "May 2026" }),
        cohort({ monthKey: "2026-07", monthLabel: "Jul 2026" }),
      ],
      TODAY,
    );
    expect(curve.map((p) => p.monthKey)).toEqual(["2026-05", "2026-07", "2026-08"]);
    expect(curve.map((p) => p.ageMonths)).toEqual([3, 1, 0]);
  });
});

describe("retentionVelocity", () => {
  it("REFUSES to fit a line to one cohort, and says so in words", () => {
    /* THE GUARD THIS FILE EXISTS FOR. Measured on production 25 Aug 2026: all seven
       subscriptions started in the same month and all were still active. Without this the
       chart draws a confident flat line at 100% and the owner reads "retention is perfect",
       when the truth is "there is one month of data". */
    const v = retentionVelocity(retentionCurve([cohort()], TODAY));
    expect(v.pointsPerMonth).toBeNull();
    expect(v.cohorts).toBe(1);
    expect(v.explanation).toContain("not 0% churn");
    expect(v.explanation).toContain("Aug 2026");
  });

  it("distinguishes 'nothing to measure' from 'no decay'", () => {
    /* null and 0 are different claims and must never render the same. */
    const none = retentionVelocity(retentionCurve([cohort()], TODAY));
    const flat = retentionVelocity(
      retentionCurve(
        [
          cohort({ monthKey: "2026-08", monthLabel: "Aug 2026", retentionPct: 90 }),
          cohort({ monthKey: "2026-06", monthLabel: "Jun 2026", retentionPct: 90 }),
        ],
        TODAY,
      ),
    );
    expect(none.pointsPerMonth).toBeNull();
    expect(flat.pointsPerMonth).toBe(0);
  });

  it("refuses when every cohort is the same age", () => {
    const v = retentionVelocity([
      { monthKey: "2026-08", label: "Aug 2026", ageMonths: 0, retentionPct: 100, startedCount: 3 },
      { monthKey: "2026-08", label: "Aug 2026", ageMonths: 0, retentionPct: 80, startedCount: 4 },
    ]);
    expect(v.pointsPerMonth).toBeNull();
  });

  it("measures decay as negative points per month", () => {
    /* Ages 0, 1, 2 with retention 100, 90, 80 — ten points lost per month of age. */
    const v = retentionVelocity([
      { monthKey: "2026-06", label: "Jun 2026", ageMonths: 2, retentionPct: 80, startedCount: 5 },
      { monthKey: "2026-07", label: "Jul 2026", ageMonths: 1, retentionPct: 90, startedCount: 5 },
      { monthKey: "2026-08", label: "Aug 2026", ageMonths: 0, retentionPct: 100, startedCount: 5 },
    ]);
    expect(v.pointsPerMonth).toBe(-10);
    expect(v.explanation).toContain("10 percentage points");
  });

  it("names the awkward case rather than reporting it as good news", () => {
    /* Older cohorts retaining BETTER usually means recent months have not settled, not that
       age improves retention. Saying "+5 points per month" without that sentence reads as a
       win. */
    const v = retentionVelocity([
      { monthKey: "2026-06", label: "Jun 2026", ageMonths: 2, retentionPct: 100, startedCount: 5 },
      { monthKey: "2026-08", label: "Aug 2026", ageMonths: 0, retentionPct: 90, startedCount: 5 },
    ]);
    expect(v.pointsPerMonth).toBeGreaterThan(0);
    expect(v.explanation).toContain("still settling");
  });

  it(`needs ${MIN_COHORTS_FOR_VELOCITY} cohorts, and the constant is the one the guard uses`, () => {
    expect(MIN_COHORTS_FOR_VELOCITY).toBe(2);
    expect(retentionVelocity([]).pointsPerMonth).toBeNull();
  });
});
