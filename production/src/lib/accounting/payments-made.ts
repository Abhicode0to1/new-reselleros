/**
 * Payments Made — every rupee that left the bank, in the owner's words.
 *
 * The mirror of Payments Received. The source is the bank line (debit > 0), because
 * that is the one place all money-out meets: vendor bills, expenses, salaries,
 * statutory and tax challans, advances, commissions, capital drawings. What each line
 * WAS comes from how it was reconciled (matched_to_type) — a line nobody has booked is
 * shown as "not reconciled", not guessed from its narration. Transfers between own
 * accounts are not payments and are left out.
 */

export type PaidGroup = "vendors" | "salaries" | "statutory" | "advances" | "other" | "unreconciled";

export const GROUP_LABEL: Record<PaidGroup, string> = {
  vendors: "Vendors & expenses", salaries: "Salaries", statutory: "Statutory & tax", advances: "Advances & commissions",
  other: "Capital, loans & other", unreconciled: "Not reconciled",
};

export function groupOf(matchedToType: string | null): PaidGroup | null {
  switch (matchedToType) {
    case null:                  return "unreconciled";
    case "expense":
    case "vendor_bill":         return "vendors";
    case "salary":
    case "split":               return "salaries";
    case "statutory":           return "statutory";
    case "prepaid":
    case "referral_commission": return "advances";
    case "transfer":            return null;              // own money moving — not a payment
    default:                    return "other";           // manual (capital / loan / EMI bookings), project, payment (refund)
  }
}

export interface PaidOutLine {
  id: string;
  txn_date: string;
  amount: number;
  payee: string;
  what: string;               // "Salary Aug 2026", "Office Rent", "TDS challan", …
  reference: string | null;   // bill no. / challan / bank reference
  account: string;
  group: PaidGroup;
  matched_to_type: string | null;
  matched_to_id: string | null;
  description: string | null;
}

export interface PaidOutSummary {
  mtd: number;
  fy: number;
  allTime: number;
  count: number;
  unreconciled: { count: number; amount: number };
  topPayee: { name: string; amount: number } | null;
  byGroup: { group: PaidGroup; label: string; amount: number; count: number }[];
}

const fyStart = (iso: string) => { const [y, m] = iso.slice(0, 7).split("-").map(Number); return `${m >= 4 ? y : y - 1}-04-01`; };

export function summarisePaidOut(lines: readonly PaidOutLine[], today: string): PaidOutSummary {
  const month = today.slice(0, 7), fy = fyStart(today);
  const sum = (rows: readonly PaidOutLine[]) => rows.reduce((s, l) => s + l.amount, 0);
  const booked = lines.filter((l) => l.group !== "unreconciled");
  const byPayee = new Map<string, number>();
  for (const l of booked) byPayee.set(l.payee, (byPayee.get(l.payee) ?? 0) + l.amount);
  const top = [...byPayee.entries()].sort((a, b) => b[1] - a[1])[0];
  const groups: PaidGroup[] = ["vendors", "salaries", "statutory", "advances", "other", "unreconciled"];
  return {
    mtd: sum(lines.filter((l) => l.txn_date.startsWith(month))),
    fy: sum(lines.filter((l) => l.txn_date >= fy)),
    allTime: sum(lines),
    count: lines.length,
    unreconciled: { count: lines.length - booked.length, amount: sum(lines.filter((l) => l.group === "unreconciled")) },
    topPayee: top ? { name: top[0], amount: top[1] } : null,
    byGroup: groups.map((g) => { const rows = lines.filter((l) => l.group === g); return { group: g, label: GROUP_LABEL[g], amount: sum(rows), count: rows.length }; }).filter((g) => g.count > 0),
  };
}

export function paidOutCsvRows(lines: readonly PaidOutLine[]): (string | number)[][] {
  return lines.map((l) => [l.txn_date, l.payee, l.what, GROUP_LABEL[l.group], l.reference ?? "", l.account, l.amount, l.description ?? ""]);
}
export const PAID_OUT_CSV_HEADERS = ["Date", "Paid to", "What", "Group", "Reference", "Paid from", "Amount", "Bank narration"];
