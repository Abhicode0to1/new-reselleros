import { describe, it, expect } from "vitest";
import { summarizeDayBook, dayBookCsvRows, type DayBookRow } from "./day-book";

const rows: DayBookRow[] = [
  { date: "2026-07-01", voucher: "Purchase", reference: "E2", party: "Medium Corp", narration: "Supplies", amount: 9000 },
  { date: "2026-07-01", voucher: "Receipt", reference: "RV1", party: "S33 Customer", narration: "upi", amount: 4000 },
  { date: "2026-07-05", voucher: "Sales", reference: "INV1", party: "S33 Customer", narration: null, amount: 11800 },
  { date: "2026-07-15", voucher: "Refund", reference: "RV2 · refunded", party: "S33 Customer", narration: null, amount: 1500 },
  { date: "2026-07-18", voucher: "Payment", reference: "SW-7 · paid", party: null, narration: "card", amount: 1200 },
  { date: "2026-07-20", voucher: "Sales", reference: "INV2", party: "S33 Customer", narration: null, amount: 5900 },
];

describe("summarizeDayBook", () => {
  const s = summarizeDayBook(rows);
  it("totals per voucher type, in Tally order, only the types present", () => {
    expect(s.byVoucher).toEqual([
      { voucher: "Sales", count: 2, amount: 17700 },
      { voucher: "Receipt", count: 1, amount: 4000 },
      { voucher: "Refund", count: 1, amount: 1500 },
      { voucher: "Purchase", count: 1, amount: 9000 },
      { voucher: "Payment", count: 1, amount: 1200 },
    ]);
    expect(s.count).toBe(6);
  });
  it("net cash counts only money that moved — not credit sales or credit purchases", () => {
    expect(s.netCash).toBe(4000 - 1200 - 1500);
  });
  it("CSV keeps blanks blank, not the word null", () => {
    expect(dayBookCsvRows(rows)[4]).toEqual(["2026-07-18", "Payment", "SW-7 · paid", "", "card", 1200]);
  });
});
