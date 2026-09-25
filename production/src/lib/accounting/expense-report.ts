/**
 * Expense report for a period — where the operating money went, by category, by vendor
 * and by month. Pure, so the P&L card and its CSV export add up the same way.
 *
 * Amounts are the expense `amount` exactly as the P&L's "Operating expenses" line sums
 * them, so the report's total and that line are always the same number.
 */

export type ExpenseLike = {
  amount: number | null;
  category: string | null;
  vendor_name: string | null;
  expense_date: string;       // YYYY-MM-DD
};

export type ExpenseReport = {
  total: number;
  count: number;
  byCategory: Array<{ category: string; total: number; count: number; pct: number }>;
  /** Biggest first; blank vendors grouped as "(no vendor)". */
  byVendor: Array<{ vendor: string; total: number; count: number }>;
  /** Oldest first, one row per month that has spend (YYYY-MM). */
  byMonth: Array<{ month: string; total: number; count: number }>;
};

export const UNCATEGORISED = "Uncategorised";
export const NO_VENDOR = "(no vendor)";

function group<K>(rows: ExpenseLike[], key: (r: ExpenseLike) => K) {
  const m = new Map<K, { total: number; count: number }>();
  for (const r of rows) {
    const k = key(r);
    const g = m.get(k) ?? { total: 0, count: 0 };
    g.total += r.amount ?? 0;
    g.count += 1;
    m.set(k, g);
  }
  return m;
}

export function buildExpenseReport(rows: ExpenseLike[]): ExpenseReport {
  const total = rows.reduce((s, r) => s + (r.amount ?? 0), 0);
  /* Percentages round independently, so they may sum to 99 or 101 — each one is honest
     about its own share, which is what the bar shows. */
  const pct = (v: number) => (total > 0 ? Math.round((v / total) * 1000) / 10 : 0);

  const byCategory = [...group(rows, (r) => r.category?.trim() || UNCATEGORISED)]
    .map(([category, g]) => ({ category, ...g, pct: pct(g.total) }))
    .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category));

  /* Vendors match ignoring case and spacing — "Amazon" and "AMAZON " are one vendor. */
  const vendorName = new Map<string, string>();
  const byVendor = [...group(rows, (r) => {
    const raw = r.vendor_name?.trim().replace(/\s+/g, " ") || NO_VENDOR;
    const key = raw.toUpperCase();
    if (!vendorName.has(key)) vendorName.set(key, raw);
    return key;
  })]
    .map(([key, g]) => ({ vendor: vendorName.get(key)!, ...g }))
    .sort((a, b) => b.total - a.total || a.vendor.localeCompare(b.vendor));

  const byMonth = [...group(rows, (r) => r.expense_date.slice(0, 7))]
    .map(([month, g]) => ({ month, ...g }))
    .sort((a, b) => a.month.localeCompare(b.month));

  return { total, count: rows.length, byCategory, byVendor, byMonth };
}
