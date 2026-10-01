import { describe, it, expect } from "vitest";
import { labourMonthsElapsed, labourToDate, labourCost, bookedToDate, DAYS_PER_MONTH } from "./pnl";

// The real case from the AITEST data: Complete Billing System, labour 20 Apr – 26 Dec 2026, 8 months.
const pawan = { monthlyGross: 22355, percent: 100, months: 8, start_date: "2026-04-20", end_date: "2026-12-26" };
const pardeep = { monthlyGross: 150000, percent: 20, months: 8, start_date: "2026-04-20", end_date: "2026-12-26" };

describe("labourMonthsElapsed", () => {
  it("counts only the months that have passed by today", () => {
    const m = labourMonthsElapsed(pawan, "2026-10-01", null);
    expect(m).toBeCloseTo(164 / DAYS_PER_MONTH, 5); // 20 Apr → 1 Oct = 164 days
    expect(m).toBeLessThan(8);
  });

  it("never goes past the allocation's months or its end date", () => {
    expect(labourMonthsElapsed(pawan, "2027-06-01", null)).toBe(8);
    expect(labourMonthsElapsed({ ...pawan, months: 20 }, "2027-06-01", null)).toBeCloseTo(250 / DAYS_PER_MONTH, 5);
  });

  it("zero before the start, and on the start day", () => {
    expect(labourMonthsElapsed(pawan, "2026-04-01", null)).toBe(0);
    expect(labourMonthsElapsed(pawan, "2026-04-20", null)).toBe(0);
  });

  it("falls back to the project start, then to the full allocation", () => {
    const noDates = { ...pawan, start_date: null, end_date: null };
    expect(labourMonthsElapsed(noDates, "2026-10-01", "2026-04-20")).toBeCloseTo(164 / DAYS_PER_MONTH, 5);
    expect(labourMonthsElapsed(noDates, "2026-10-01", null)).toBe(8);
  });
});

describe("labourToDate", () => {
  it("is salary × percent × elapsed months, rounded to the rupee", () => {
    expect(labourToDate(pardeep, "2026-10-01", null)).toBe(Math.round(150000 * 0.2 * (164 / DAYS_PER_MONTH)));
    expect(labourCost(pardeep, 8)).toBe(240000);
  });
});

describe("bookedToDate", () => {
  it("subtracts labour and costs up to today only", () => {
    const r = bookedToDate({
      bookedRevenue: 1000000,
      costs: [
        { amount: 50000, expense_date: "2026-05-01" },
        { amount: 20000, expense_date: "2026-11-01" }, // future-dated — not yet a cost
        { amount: 3000, expense_date: null },
      ],
      labour: [pawan, pardeep],
      today: "2026-10-01",
      projectStart: "2026-04-20",
    });
    expect(r.costsToDate).toBe(53000);
    const lab = labourToDate(pawan, "2026-10-01", null) + labourToDate(pardeep, "2026-10-01", null);
    expect(r.labourToDate).toBe(lab);
    expect(r.profit).toBe(1000000 - 53000 - lab);
    expect(r.marginPct).toBe(Math.round(((1000000 - 53000 - lab) / 1000000) * 100));
  });

  it("margin is 0 when nothing is invoiced yet", () => {
    const r = bookedToDate({ bookedRevenue: 0, costs: [], labour: [pawan], today: "2026-10-01", projectStart: null });
    expect(r.marginPct).toBe(0);
    expect(r.profit).toBeLessThan(0);
  });
});
