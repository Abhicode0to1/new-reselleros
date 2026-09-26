import { describe, it, expect } from "vitest";
import { monthRows, monthSpan, runway, type FlowLine } from "./cash-flow-summary";

/* The live HDFC account, Apr–Sep 2026: opening ₹3,00,301, bank now ₹1,44,930. */
const live: FlowLine[] = [
  { txn_date: "2026-04-10", credit: 0, debit: 19_056 },
  { txn_date: "2026-05-10", credit: 0, debit: 156_353 },
  { txn_date: "2026-06-10", credit: 0, debit: 75_637 },
  { txn_date: "2026-07-08", credit: 540_000, debit: 382_813 },
  { txn_date: "2026-08-07", credit: 540_000, debit: 424_681 },
  { txn_date: "2026-09-10", credit: 0, debit: 176_831 },
];

describe("monthRows — each month ends on the statement balance", () => {
  it("starts from the opening balance and ends on the bank balance, not on a running total from 0", () => {
    const rows = monthRows(live, 300_301);
    expect(rows.map((r) => r.balanceEnd)).toEqual([281_245, 124_892, 49_255, 206_442, 321_761, 144_930]);
  });

  it("a quiet month is a row of zeros carrying the balance, not a gap", () => {
    const rows = monthRows([{ txn_date: "2026-04-01", credit: 100, debit: 0 }, { txn_date: "2026-06-01", credit: 0, debit: 50 }], 0);
    expect(rows.map((r) => [r.ym, r.net, r.balanceEnd])).toEqual([["2026-04", 100, 100], ["2026-05", 0, 100], ["2026-06", -50, 50]]);
  });

  it("monthSpan crosses a year", () => {
    expect(monthSpan("2025-11", "2026-02")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });
});

describe("runway — both numbers, over every month", () => {
  it("the live case: ~0.7 months if nothing comes in, ~5.6 at the six-month trend", () => {
    const r = runway(monthRows(live, 300_301), 144_930)!;
    expect(r.months).toBe(6);
    expect(r.spendPerMonth).toBe(205_895);
    expect(r.netPerMonth).toBe(-25_895);
    expect(r.ifNoIncome).toBe(0.7);
    expect(r.atTrend).toBe(5.6);
  });

  it("income months count — the old loss-months-only average gave 1.4", () => {
    const r = runway(monthRows(live, 300_301), 144_930)!;
    expect(r.atTrend).not.toBe(1.4);
    expect(r.ifNoIncome).not.toBe(1.4);
  });

  it("cash growing → no trend runway (it is not running out)", () => {
    const r = runway(monthRows([{ txn_date: "2026-07-01", credit: 500, debit: 100 }], 0), 400)!;
    expect(r.atTrend).toBeNull();
    expect(r.ifNoIncome).toBe(4);
  });
});
