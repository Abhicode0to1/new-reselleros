import { describe, it, expect } from "vitest";
import {
  buildBillingSchedule, addMonthsClamped, addDaysISO, upcomingBillings, scheduleTotal, CYCLE_MONTHS,
  termEndInclusive, nextTermStart, periodLastDay,
} from "./schedule";

describe("addMonthsClamped — month-end must not roll over", () => {
  it.each([
    ["2026-01-31", 1,  "2026-02-28"],   // not 3 March
    ["2028-01-31", 1,  "2028-02-29"],   // leap year
    ["2026-01-31", 3,  "2026-04-30"],
    ["2026-03-31", 1,  "2026-04-30"],
    ["2026-08-16", 12, "2027-08-16"],
    ["2026-08-16", 36, "2029-08-16"],
  ])("%s + %s months = %s", (from, months, expected) => {
    expect(addMonthsClamped(from, months)).toBe(expected);
  });

  it("goes backwards too", () => {
    expect(addMonthsClamped("2027-04-01", -12)).toBe("2026-04-01");
    expect(addMonthsClamped("2026-01-15", -1)).toBe("2025-12-15");
  });

  it("a monthly plan starting on the 31st does NOT drift later each month", () => {
    /* The bug this prevents: rolling over would push 31 Jan to 3 Mar, then 3 Apr,
       and a January subscription would end up billing in March. */
    let d = "2026-01-31";
    const seen: string[] = [];
    for (let i = 1; i <= 4; i++) seen.push(addMonthsClamped("2026-01-31", i));
    expect(seen).toEqual(["2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
    void d;
  });
});

describe("buildBillingSchedule", () => {
  it("annual term, yearly cycle → one invoice for the whole amount", () => {
    const s = buildBillingSchedule({ startDate: "2026-04-01", termMonths: 12, cycle: "yearly", termAmount: 100_000 });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ billOn: "2026-04-01", periodStart: "2026-04-01", periodEnd: "2027-04-01", amount: 100_000 });
  });

  it("annual term, quarterly cycle → four invoices on the right dates", () => {
    const s = buildBillingSchedule({ startDate: "2026-04-01", termMonths: 12, cycle: "quarterly", termAmount: 100_000 });
    expect(s.map((p) => p.billOn)).toEqual(["2026-04-01", "2026-07-01", "2026-10-01", "2027-01-01"]);
    expect(s[3].periodEnd).toBe("2027-04-01");
  });

  it("annual term, monthly cycle → twelve invoices", () => {
    const s = buildBillingSchedule({ startDate: "2026-04-01", termMonths: 12, cycle: "monthly", termAmount: 120_000 });
    expect(s).toHaveLength(12);
    expect(s.every((p) => p.amount === 10_000)).toBe(true);
  });

  it("MULTI-YEAR: a 3-year term billed annually is three invoices", () => {
    const s = buildBillingSchedule({ startDate: "2026-04-01", termMonths: 36, cycle: "yearly", termAmount: 300_000 });
    expect(s).toHaveLength(3);
    expect(s.map((p) => p.billOn)).toEqual(["2026-04-01", "2027-04-01", "2028-04-01"]);
    expect(s[2].periodEnd).toBe("2029-04-01");
  });

  it("MULTI-YEAR paid upfront: 3-year term, yearly-or-longer cycle still splits per cycle", () => {
    const s = buildBillingSchedule({ startDate: "2026-04-01", termMonths: 24, cycle: "half_yearly", termAmount: 240_000 });
    expect(s).toHaveLength(4);
    expect(s.map((p) => p.amount)).toEqual([60_000, 60_000, 60_000, 60_000]);
  });
});

describe("the instalments ALWAYS sum to the term total", () => {
  it("carries an indivisible remainder into the LAST instalment", () => {
    /* ₹1,00,000 over 3 is not 3 × ₹33,333.33 — that sums to ₹99,999.99 and leaves a
       rupee nobody can explain. */
    const s = buildBillingSchedule({ startDate: "2026-04-01", termMonths: 12, cycle: "quarterly", termAmount: 100_001 });
    expect(scheduleTotal(s)).toBe(100_001);
    expect(new Set(s.map((p) => p.amount)).size).toBeLessThanOrEqual(2);
  });

  it.each([
    [100_000, "quarterly", 12],
    [100_001, "monthly",   12],
    [99_999,  "monthly",   12],
    [16_320,  "quarterly", 12],
    [1,       "monthly",   12],
    [300_007, "yearly",    36],
  ] as const)("₹%s on a %s cycle over %s months sums exactly", (amount, cycle, months) => {
    const s = buildBillingSchedule({ startDate: "2026-04-01", termMonths: months, cycle, termAmount: amount });
    expect(scheduleTotal(s)).toBe(amount);
  });

  it("never produces a negative or fractional instalment", () => {
    const s = buildBillingSchedule({ startDate: "2026-04-01", termMonths: 12, cycle: "monthly", termAmount: 7 });
    for (const p of s) {
      expect(Number.isInteger(p.amount)).toBe(true);
      expect(p.amount).toBeGreaterThanOrEqual(0);
    }
    expect(scheduleTotal(s)).toBe(7);
  });
});

describe("terms that do not divide evenly", () => {
  it("bills the tail rather than dropping it", () => {
    /* A 13-month deal on a quarterly cycle is five invoices — four quarters and one
       month — not four that quietly lose the last month. */
    const s = buildBillingSchedule({ startDate: "2026-04-01", termMonths: 13, cycle: "quarterly", termAmount: 130_000 });
    expect(s).toHaveLength(5);
    expect(s[4].periodEnd).toBe("2027-05-01");
  });

  it("collapses a cycle LONGER than the term to a single invoice", () => {
    /* A 6-month deal billed "yearly" is one invoice for six months — what a reseller
       means when they pick it, rather than an error. */
    const s = buildBillingSchedule({ startDate: "2026-04-01", termMonths: 6, cycle: "yearly", termAmount: 50_000 });
    expect(s).toHaveLength(1);
    expect(s[0].periodEnd).toBe("2026-10-01");
    expect(s[0].amount).toBe(50_000);
  });

  it("treats a zero or negative term as one month rather than crashing", () => {
    for (const termMonths of [0, -5]) {
      const s = buildBillingSchedule({ startDate: "2026-04-01", termMonths, cycle: "monthly", termAmount: 1000 });
      expect(s).toHaveLength(1);
      expect(scheduleTotal(s)).toBe(1000);
    }
  });
});

describe("upcomingBillings — what the cron shows ahead", () => {
  const schedule = buildBillingSchedule({ startDate: "2026-04-01", termMonths: 12, cycle: "quarterly", termAmount: 100_000 });

  it("finds instalments inside the horizon", () => {
    expect(upcomingBillings(schedule, "2026-06-15", 30).map((p) => p.billOn)).toEqual(["2026-07-01"]);
  });

  it("is empty when nothing falls in the window", () => {
    expect(upcomingBillings(schedule, "2026-04-15", 30)).toEqual([]);
  });

  it("includes one due exactly today and exactly on the horizon", () => {
    expect(upcomingBillings(schedule, "2026-07-01", 0).map((p) => p.billOn)).toEqual(["2026-07-01"]);
    expect(upcomingBillings(schedule, "2026-06-01", 30).map((p) => p.billOn)).toEqual(["2026-07-01"]);
  });

  it("never returns a date in the past", () => {
    expect(upcomingBillings(schedule, "2026-08-01", 365).every((p) => p.billOn >= "2026-08-01")).toBe(true);
  });
});

describe("addDaysISO", () => {
  it("crosses a month and a year boundary", () => {
    expect(addDaysISO("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDaysISO("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("handles a leap day", () => {
    expect(addDaysISO("2028-02-28", 1)).toBe("2028-02-29");
  });
});

describe("CYCLE_MONTHS", () => {
  it("matches the cycles the app offers", () => {
    expect(CYCLE_MONTHS).toEqual({ monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 });
  });
});

/**
 * The inclusive-end convention — `subscriptions.renewal_date` is the LAST COVERED DAY.
 *
 * ─── WHY THIS PAIR EXISTS ───────────────────────────────────────────────────
 * Changed 11 Sep 2026 on Abhishek's instruction. The column used to hold the
 * anniversary — a term starting 11 Sep 2026 stored 11 Sep 2027, the first day of term
 * two — and he reads it as an expiry date, as does the Google Admin console he
 * reconciles the app against.
 *
 * Moving a stored date by one day is cheap. What is NOT cheap is every place that turns
 * that column back into a term boundary: miss one and the next term opens on the last
 * day of the previous one, so a day is sold twice on every renewal of every
 * subscription, compounding for as long as nobody notices. These two functions are the
 * only sanctioned conversion in either direction, which is what makes that auditable.
 */
describe("termEndInclusive / nextTermStart — the ±1 that must never be open-coded", () => {
  it("a year from 11 Sep 2026 ends 10 Sep 2027", () => {
    /* The case Abhishek reported, from the Doodh Sang row. */
    expect(termEndInclusive("2026-09-11", 12)).toBe("2027-09-10");
  });

  it("gives a term its full count of days — 365 for a non-leap year", () => {
    /* The arithmetic that justifies the whole change: inclusive of both ends, a year
       is 365 days. Storing the anniversary made it look like 366. */
    const start = "2026-09-11";
    const end = termEndInclusive(start, 12);
    const days = Math.round(
      (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
    expect(days).toBe(365);
  });

  it("a one-month flex term ends the day before the next month's anniversary", () => {
    expect(termEndInclusive("2026-09-11", 1)).toBe("2026-10-10");
  });

  it("nextTermStart is the exact inverse — no day is lost or repeated between terms", () => {
    /* Term two must begin the morning after term one ends. If these two ever disagree
       the boundary either double-bills a day or leaves an unbilled gap. */
    for (const start of ["2026-09-11", "2026-01-31", "2026-02-28", "2026-12-01", "2027-03-01"]) {
      for (const months of [1, 3, 6, 12, 36]) {
        expect(nextTermStart(termEndInclusive(start, months)))
          .toBe(addMonthsClamped(start, months));
      }
    }
  });

  it("ends a term that started on the 1st on the last day of the previous month", () => {
    /* 1 Apr 2026 → 31 Mar 2027. This is the shape that breaks any month-only arithmetic
       reading the stored column, which is why the term length is measured through
       nextTermStart rather than off the stored date. */
    expect(termEndInclusive("2026-04-01", 12)).toBe("2027-03-31");
    expect(termEndInclusive("2026-12-01", 1)).toBe("2026-12-31");
  });

  it("clamps a month-end start rather than rolling into the next month", () => {
    /* 31 Jan + 1 month is 28 Feb in a non-leap year, so the last covered day is the
       27th. Naive Date math would say 2 March and walk the anniversary later every
       period. */
    expect(termEndInclusive("2026-01-31", 1)).toBe("2026-02-27");
    /* 2028 IS a leap year, so the same start reaches a day further. */
    expect(termEndInclusive("2028-01-31", 1)).toBe("2028-02-28");
  });

  it("crosses a year boundary without drifting", () => {
    expect(termEndInclusive("2026-12-31", 12)).toBe("2027-12-30");
    expect(nextTermStart("2027-12-31")).toBe("2028-01-01");
  });

  it("tolerates a timestamp, because Postgres dates arrive both ways", () => {
    expect(nextTermStart("2027-09-10T00:00:00+05:30")).toBe("2027-09-11");
  });
});

describe("periodLastDay — periodEnd is exclusive, the screen must not print it raw", () => {
  it("turns a period boundary into the last day it covers", () => {
    /* Reported 11 Sep 2026: the billing panel read "covers 11 Sept 2026 – 11 Sept 2027"
       beside a row that said the term ends on the 10th. Same screen, two answers. */
    const [p] = buildBillingSchedule({
      startDate: "2026-09-11", termMonths: 12, cycle: "yearly", termAmount: 6_336,
    });
    expect(p.periodEnd).toBe("2027-09-11");          // the boundary, unchanged
    expect(periodLastDay(p.periodEnd)).toBe("2027-09-10");  // what the operator reads
  });

  it("never leaves a gap between one period's last day and the next period's first", () => {
    const periods = buildBillingSchedule({
      startDate: "2026-01-31", termMonths: 12, cycle: "monthly", termAmount: 12_000,
    });
    for (let i = 0; i < periods.length - 1; i++) {
      expect(addDaysISO(periodLastDay(periods[i].periodEnd), 1)).toBe(periods[i + 1].periodStart);
    }
  });
});
