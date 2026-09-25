import { describe, it, expect } from "vitest";
import { groupExpenses, NO_VENDOR_LABEL } from "./expense-groups";

const e = (id: string, vendor: string | null, category: string, amount: number, gst = 0) =>
  ({ id, vendor_name: vendor, category, amount, gst_paid: gst });

const rows = [
  e("1", "Pratik", "Salaries", 14517),
  e("2", "Amazon", "Utilities", 399, 61),
  e("3", "AMAZON ", "Office Supplies", 4635, 707),
  e("4", null, "Bank Charges", 1),
  e("5", "Pratik", "Salaries", 14887),
];

describe("groupExpenses", () => {
  it("by vendor: case/space-insensitive, subtotals, biggest first, list order kept inside", () => {
    const g = groupExpenses(rows, "vendor");
    expect(g.map((x) => [x.label, x.count, x.total, x.gst])).toEqual([
      ["Pratik", 2, 29404, 0],
      ["Amazon", 2, 5034, 768],
      [NO_VENDOR_LABEL, 1, 1, 0],
    ]);
    expect(g[0].rows.map((r) => r.id)).toEqual(["1", "5"]);
  });

  it("by category", () => {
    expect(groupExpenses(rows, "category").map((x) => [x.label, x.total])).toEqual([
      ["Salaries", 29404], ["Office Supplies", 4635], ["Utilities", 399], ["Bank Charges", 1],
    ]);
  });

  it("group totals add back to the list total", () => {
    const listTotal = rows.reduce((s, r) => s + r.amount, 0);
    for (const by of ["vendor", "category"] as const) {
      expect(groupExpenses(rows, by).reduce((s, g) => s + g.total, 0)).toBe(listTotal);
    }
  });
});
