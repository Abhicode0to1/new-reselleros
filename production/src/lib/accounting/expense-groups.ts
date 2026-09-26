/**
 * Group the Expenses list by vendor or by category, with a subtotal per group.
 *
 * Vendors match ignoring case and spacing ("Amazon" / "AMAZON ") — the same rule the
 * P&L expense report uses — and entries with no vendor are grouped as "(no vendor)"
 * rather than dropped, so the group totals always add back to the list total.
 * Groups are biggest-first; inside a group the list keeps its own order.
 */

export type GroupBy = "none" | "vendor" | "category";

export type ExpenseGroup<T> = {
  key: string;
  label: string;
  count: number;
  total: number;
  gst: number;
  rows: T[];
};

export const NO_VENDOR_LABEL = "(no vendor)";
export const NO_CATEGORY_LABEL = "Uncategorised";

type Groupable = { vendor_name?: string | null; category?: string | null; amount: number | null; gst_paid?: number | null };

export function groupExpenses<T extends Groupable>(rows: T[], by: Exclude<GroupBy, "none">): Array<ExpenseGroup<T>> {
  const groups = new Map<string, ExpenseGroup<T>>();
  for (const r of rows) {
    const raw = (by === "vendor" ? r.vendor_name : r.category)?.trim().replace(/\s+/g, " ") ?? "";
    const label = raw || (by === "vendor" ? NO_VENDOR_LABEL : NO_CATEGORY_LABEL);
    const key = label.toUpperCase();
    const g = groups.get(key) ?? { key, label, count: 0, total: 0, gst: 0, rows: [] };
    g.count += 1;
    g.total += r.amount ?? 0;
    g.gst += r.gst_paid ?? 0;
    g.rows.push(r);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}
