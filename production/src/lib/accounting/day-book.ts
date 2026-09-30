/**
 * Day Book — `report_day_book` (migration 20260928120000) ki rows ka pure hisaab.
 *
 * Kaunse voucher, aur kaunse jaan-boojh kar nahi (salary_payments, bank lines, draft/void
 * invoice), migration ke header me likha hai — yahan sirf totals aur export.
 */

export type DayBookVoucher =
  | "Sales" | "Receipt" | "Refund" | "Credit Note" | "Debit Note" | "Purchase" | "Payment" | "Journal";

export interface DayBookRow {
  date: string;              // YYYY-MM-DD (IST)
  voucher: DayBookVoucher;
  reference: string;
  party: string | null;
  narration: string | null;
  amount: number;            // whole rupees
}

/** Tally ka kram: pehle bechna-lena (Sales, Receipt…), phir kharidna-dena, aakhir me Journal
 *  (salary ka kharcha — Salaries / Director's Remuneration, migration 20260929185929). */
export const DAY_BOOK_VOUCHERS: readonly DayBookVoucher[] = [
  "Sales", "Receipt", "Refund", "Credit Note", "Debit Note", "Purchase", "Payment", "Journal",
];

export interface DayBookSummary {
  byVoucher: { voucher: DayBookVoucher; count: number; amount: number }[];
  count: number;
  /** Paisa aaya (Receipt) − gaya (Payment + Refund). Sales/Purchase udhaar hai, cash nahi. */
  netCash: number;
}

export function summarizeDayBook(rows: readonly DayBookRow[]): DayBookSummary {
  const m = new Map<DayBookVoucher, { count: number; amount: number }>();
  for (const r of rows) {
    const g = m.get(r.voucher) ?? { count: 0, amount: 0 };
    g.count += 1; g.amount += r.amount;
    m.set(r.voucher, g);
  }
  const byVoucher = DAY_BOOK_VOUCHERS.filter((v) => m.has(v)).map((v) => ({ voucher: v, ...m.get(v)! }));
  const amt = (v: DayBookVoucher) => m.get(v)?.amount ?? 0;
  return { byVoucher, count: rows.length, netCash: amt("Receipt") - amt("Payment") - amt("Refund") };
}

export const DAY_BOOK_CSV_HEADERS = ["Date", "Voucher", "Reference", "Party", "Narration", "Amount (INR)"];

export function dayBookCsvRows(rows: readonly DayBookRow[]): (string | number)[][] {
  return rows.map((r) => [r.date, r.voucher, r.reference, r.party ?? "", r.narration ?? "", r.amount]);
}
