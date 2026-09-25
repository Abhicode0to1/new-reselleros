/**
 * Cash-flow drill-down: what each bank line in a month WAS, in the operator's words,
 * and where the month's money went, by that label.
 *
 * The label comes from how the line was reconciled. An unreconciled line says so —
 * it is not guessed from its narration, because "not reconciled yet" is exactly what
 * the operator needs to see to go and fix it.
 */

export type CashFlowTxn = {
  id: string;
  bank_account_id: string;
  txn_date: string;
  description: string | null;
  debit: number;
  credit: number;
  matched_to_type: string | null;
  category: string | null;
};

export const NOT_RECONCILED = "Not reconciled";

export function lineLabel(t: Pick<CashFlowTxn, "matched_to_type" | "category">): string {
  switch (t.matched_to_type) {
    case null:          return NOT_RECONCILED;
    case "salary":      return "Salary";
    case "split":       return "Salary / advance";
    case "statutory":   return "Tax & statutory";
    case "expense":     return t.category ? t.category : "Expense";
    case "vendor_bill": return "Vendor bill";
    case "payment":     return "Customer payment";
    case "project":     return "Project payment";
    case "transfer":    return "Transfer (own accounts)";
    case "manual":      return "Marked reconciled";
    default:            return "Other";
  }
}

export type LabelTotal = { label: string; amount: number; count: number };

/** Totals by label for one side (out = debits, in = credits), biggest first. */
export function totalsByLabel(lines: CashFlowTxn[], side: "out" | "in"): LabelTotal[] {
  const m = new Map<string, LabelTotal>();
  for (const t of lines) {
    const amount = side === "out" ? t.debit : t.credit;
    if (!(amount > 0)) continue;
    const label = lineLabel(t);
    const g = m.get(label) ?? { label, amount: 0, count: 0 };
    g.amount += amount;
    g.count += 1;
    m.set(label, g);
  }
  return [...m.values()].sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label));
}
