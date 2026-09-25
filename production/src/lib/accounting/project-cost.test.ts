import { describe, it, expect } from "vitest";
import { projectCostForPeriod, allocationEnd, type LabourAllocation, type CostExpense } from "./project-cost";
import { buildPnl } from "./pnl";
import { netProfitView } from "./pnl-bound";

const Q = { from: "2026-07-01", to: "2026-09-30" };
const project = { id: "p1", title: "School ERP", customer_name: "Acme", start_date: "2026-07-01" };
const gross = new Map([["ranjeet", 35_000], ["hitesh", 52_000]]);
const salaries = (amount: number): CostExpense => ({ amount, category: "Salaries", project_id: null });
const alloc = (over: Partial<LabourAllocation> = {}): LabourAllocation => ({
  project_id: "p1", employee_id: "ranjeet", percent: 100, months: 3,
  start_date: "2026-07-01", end_date: "2026-09-30", ...over,
});

describe("allocationEnd", () => {
  it("start + months − 1 day", () => {
    expect(allocationEnd("2026-07-01", 3)).toBe("2026-09-30");
    expect(allocationEnd("2026-07-15", 1)).toBe("2026-08-14");
  });
});

describe("project delivery cost", () => {
  it("salary × time% × months inside the period", () => {
    const r = projectCostForPeriod({
      ...Q, allocations: [alloc({ percent: 50 })], monthlyGross: gross,
      projects: [project], expenses: [salaries(300_000)],
    });
    // 35,000 × 50% × ~3 months (92 days / 30.44 = 3.02)
    expect(r.labour).toBe(Math.round(35_000 * 0.5 * 3.02));
    expect(r.capped).toBe(false);
    expect(r.total).toBe(r.labour);
  });

  it("only the months that fall in the period count", () => {
    const r = projectCostForPeriod({
      ...Q, allocations: [alloc({ start_date: "2026-05-01", end_date: "2026-07-31" })],
      monthlyGross: gross, projects: [project], expenses: [salaries(300_000)],
    });
    expect(r.labour).toBe(Math.round(35_000 * 1.02));   // July only (31 days)
  });

  it("falls back to the project's start date, then to start + months", () => {
    const r = projectCostForPeriod({
      ...Q, allocations: [alloc({ start_date: null, end_date: null, months: 1 })],
      monthlyGross: gross, projects: [project], expenses: [salaries(300_000)],
    });
    expect(r.labour).toBe(Math.round(35_000 * 1.02));
  });

  it("an allocation with no date anywhere is counted as undated, never guessed", () => {
    const r = projectCostForPeriod({
      ...Q, allocations: [alloc({ start_date: null, end_date: null })],
      monthlyGross: gross, projects: [{ ...project, start_date: null }], expenses: [salaries(300_000)],
    });
    expect(r.labour).toBe(0);
    expect(r.undated).toBe(1);
  });

  it("never moves more than the salary actually booked — capped, and says so", () => {
    const r = projectCostForPeriod({
      ...Q,
      allocations: [alloc(), alloc({ employee_id: "hitesh", project_id: "p2" })],
      monthlyGross: gross,
      projects: [project, { ...project, id: "p2", title: "CRM" }],
      expenses: [salaries(50_001)],
    });
    expect(r.capped).toBe(true);
    expect(r.labour).toBe(50_001);
    expect(r.byProject.reduce((s, p) => s + p.labour, 0)).toBe(50_001);   // lines add up exactly
  });

  it("project-tagged expenses are direct cost and are not in the salary pool", () => {
    const r = projectCostForPeriod({
      ...Q, allocations: [], monthlyGross: gross, projects: [project],
      expenses: [
        salaries(100_000),
        { amount: 20_000, category: "Salaries", project_id: "p1" },
        { amount: 5_000, category: "Software", project_id: "p1" },
      ],
    });
    expect(r.salaryPool).toBe(100_000);
    expect(r.direct).toBe(25_000);
    expect(r.total).toBe(25_000);
  });

  it("per-project margin = revenue − labour − direct", () => {
    const r = projectCostForPeriod({
      ...Q, allocations: [alloc({ percent: 100, start_date: "2026-07-01", end_date: "2026-07-31" })],
      monthlyGross: gross, projects: [project],
      expenses: [salaries(300_000), { amount: 4_300, category: "Hosting", project_id: "p1" }],
      revenueByProject: [{ project_id: "p1", revenue: 100_000 }],
    });
    const line = r.byProject[0];
    expect(line.labour).toBe(Math.round(35_000 * 1.02));
    expect(line.margin).toBe(100_000 - line.labour - 4_300);
    expect(line.marginPct).toBe(Math.round((line.margin / 100_000) * 100));
  });
});

describe("buildPnl with project cost", () => {
  const google = { vendor: "google", revenue: 100_000, billedCost: null, estimatedCost: 60_000, seats: 10, subscriptions: 1 };

  it("moves project cost from operating expenses to cost of goods — net profit unchanged", () => {
    const without = buildPnl({ revenue: 200_000, expenses: 150_000, billedCogs: null, vendors: [google] });
    const withP = buildPnl({ revenue: 200_000, expenses: 150_000, billedCogs: null, vendors: [google], projectCost: 40_000 });
    expect(withP.expenses).toBe(110_000);
    expect(withP.cogs).toBe(without.cogs + 40_000);
    expect(withP.netProfit).toBe(without.netProfit);
  });

  it("project revenue is not costed at the licence ratio", () => {
    const p = buildPnl({ revenue: 200_000, expenses: 0, billedCogs: null, vendors: [google], projectRevenue: 100_000, projectCost: 30_000 });
    expect(p.licenceCogs).toBe(60_000);          // 100,000 licence revenue × 60%
    expect(p.cogs).toBe(90_000);
    expect(p.grossMargin).toBe(110_000);
  });

  it("only project revenue in the period: the margin is known even with no licence cost", () => {
    const noCost = { ...google, estimatedCost: 0 };
    const p = buildPnl({ revenue: 100_000, expenses: 50_000, billedCogs: null, vendors: [noCost], projectRevenue: 100_000, projectCost: 40_000 });
    expect(p.cogsBasis).not.toBe("unknown");
    expect(p.expenses).toBe(10_000);                 // 50,000 booked, 40,000 of it was project cost
    expect(p.netProfit).toBe(50_000);
  });

  it("licence cost unknown: the loss bound still counts the known project cost once", () => {
    const noCost = { ...google, estimatedCost: 0 };
    const p = buildPnl({ revenue: 100_000, expenses: 150_000, billedCogs: null, vendors: [noCost], projectCost: 40_000 });
    expect(p.cogsBasis).toBe("unknown");
    expect(p.cogs).toBe(40_000);
    expect(netProfitView(p)).toEqual({ kind: "loss-at-least", value: 50_000 });   // same as before the move
  });
});
