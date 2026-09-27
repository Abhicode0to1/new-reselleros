import { describe, it, expect } from "vitest";
import { buildBrs, brsRows, type BrsLine } from "./brs";

const L = (over: Partial<BrsLine> & { id: string }): BrsLine => ({
  txn_date: "2026-09-10", description: "x", debit: 0, credit: 0, source: "csv_upload", matched_to_type: "expense", ...over,
});

const lines: BrsLine[] = [
  L({ id: "i1", credit: 100_000, description: "NEFT CUSTOMER", matched_to_type: "payment" }),
  L({ id: "i2", debit: 20_000, description: "NEFT GOOGLE", matched_to_type: "vendor_bill" }),
  L({ id: "i3", debit: 590, description: "BANK CHARGES", matched_to_type: null }),          // in the bank, not in the books
  L({ id: "m1", debit: 15_000, description: "Bill payment: Zoho", source: "manual" }),       // booked, cheque not presented
  L({ id: "m2", credit: 5_000, description: "Cash deposit", source: "manual" }),             // deposit in transit
  L({ id: "late", credit: 9_999, txn_date: "2026-10-02" }),                                  // after as-of
  L({ id: "old", debit: 9_999, txn_date: "2026-03-01" }),                                    // before opening
];

describe("bank reconciliation statement", () => {
  const b = buildBrs({ openingBalance: 10_000, openingDate: "2026-04-01", asOf: "2026-09-30", lines });

  it("statement balance = opening + imported lines; book balance = opening + all lines", () => {
    expect(b.statementBalance).toBe(10_000 + 100_000 - 20_000 - 590);
    expect(b.bookBalance).toBe(b.statementBalance - 15_000 + 5_000);
  });
  it("classic BRS ties: statement + deposits in transit − unpresented = books", () => {
    expect(b.statementBalance + b.totals.depositsInTransit - b.totals.paymentsNotPresented).toBe(b.bookBalance);
    expect(b.depositsInTransit.map((l) => l.id)).toEqual(["m2"]);
    expect(b.paymentsNotPresented.map((l) => l.id)).toEqual(["m1"]);
  });
  it("unbooked imported lines are the action list; the statement is not clean while they exist", () => {
    expect(b.unbookedImports.map((l) => l.id)).toEqual(["i3"]);
    expect(b.totals.unbookedImports).toBe(-590);
    expect(b.clean).toBe(false);
  });
  it("ignores lines after the date and before the opening balance", () => {
    expect(b.ignoredBeforeOpening).toBe(1);
    expect(b.bookBalance).not.toBe(b.bookBalance + 9_999);
  });
  it("a typed closing balance exposes missing imports", () => {
    const withGap = buildBrs({ openingBalance: 10_000, openingDate: "2026-04-01", asOf: "2026-09-30", lines, statementClosing: 89_410 - 1_000 });
    expect(withGap.importGap).toBe(-1_000);
    expect(withGap.clean).toBe(false);
    const exact = buildBrs({ openingBalance: 10_000, openingDate: "2026-04-01", asOf: "2026-09-30", lines: lines.filter((l) => l.id !== "i3"), statementClosing: 90_000 });
    expect(exact.importGap).toBe(0);
    expect(exact.clean).toBe(true);
  });
  it("rows read like a CA's statement", () => {
    const rows = brsRows(b, "HDFC");
    expect(rows[3]).toEqual(["Balance as per bank statement (imported lines)", 89_410]);
    expect(rows.find((r) => r[0] === "Balance as per books")?.[1]).toBe(79_410);
  });
});
