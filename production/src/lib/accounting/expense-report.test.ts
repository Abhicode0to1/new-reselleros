import { describe, it, expect } from "vitest";
import { buildExpenseReport, UNCATEGORISED, NO_VENDOR, type ExpenseLike } from "./expense-report";

const e = (amount: number, category: string | null, vendor: string | null, date: string): ExpenseLike =>
  ({ amount, category, vendor_name: vendor, expense_date: date });

const rows = [
  e(5000, "Advertising", "Facebook", "2026-08-05"),
  e(3000, "Advertising", "facebook ", "2026-09-02"),
  e(1500, "Software", "Google Cloud", "2026-09-10"),
  e(400, null, null, "2026-09-12"),
  e(100, "Bank Charges", "", "2026-08-20"),
];

describe("buildExpenseReport", () => {
  const r = buildExpenseReport(rows);

  it("total and count match the rows (the P&L line)", () => {
    expect(r.total).toBe(10000);
    expect(r.count).toBe(5);
  });

  it("by category, biggest first, with share of the total", () => {
    expect(r.byCategory.map((c) => [c.category, c.total, c.count, c.pct])).toEqual([
      ["Advertising", 8000, 2, 80],
      ["Software", 1500, 1, 15],
      [UNCATEGORISED, 400, 1, 4],
      ["Bank Charges", 100, 1, 1],
    ]);
  });

  it("by vendor, ignoring case and spacing; blanks grouped", () => {
    expect(r.byVendor.map((v) => [v.vendor, v.total, v.count])).toEqual([
      ["Facebook", 8000, 2],
      ["Google Cloud", 1500, 1],
      [NO_VENDOR, 500, 2],
    ]);
  });

  it("by month, oldest first", () => {
    expect(r.byMonth).toEqual([
      { month: "2026-08", total: 5100, count: 2 },
      { month: "2026-09", total: 4900, count: 3 },
    ]);
  });

  it("the category and vendor splits each add back to the total", () => {
    expect(r.byCategory.reduce((s, c) => s + c.total, 0)).toBe(r.total);
    expect(r.byVendor.reduce((s, v) => s + v.total, 0)).toBe(r.total);
    expect(r.byMonth.reduce((s, m) => s + m.total, 0)).toBe(r.total);
  });

  it("empty period", () => {
    expect(buildExpenseReport([])).toEqual({ total: 0, count: 0, byCategory: [], byVendor: [], byMonth: [] });
  });
});
