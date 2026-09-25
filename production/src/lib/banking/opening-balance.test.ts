import { describe, it, expect } from "vitest";
import { openingBalanceFromStatement, fyStartFor, type StatementLine } from "./opening-balance";

const L = (txn_date: string, debit: number, credit: number, balance_after: number | null): StatementLine =>
  ({ txn_date, debit, credit, balance_after });

describe("openingBalanceFromStatement", () => {
  it("reads the balance just before the first line on the date", () => {
    const r = openingBalanceFromStatement(
      [L("2026-04-01", 0, 5000, 105000), L("2026-04-03", 2000, 0, 103000)],
      "2026-04-01",
    );
    expect(r).toEqual({ ok: true, amount: 100000, firstLineDate: "2026-04-01", linesBefore: 0, chainBreaks: 0 });
  });

  it("counts lines before the date — they are inside the opening balance", () => {
    const r = openingBalanceFromStatement(
      [L("2026-03-30", 1000, 0, 99000), L("2026-03-31", 0, 1000, 100000), L("2026-04-02", 500, 0, 99500)],
      "2026-04-01",
    );
    expect(r).toMatchObject({ ok: true, amount: 100000, firstLineDate: "2026-04-02", linesBefore: 2 });
  });

  it("handles newest-first statements", () => {
    const r = openingBalanceFromStatement(
      [L("2026-04-05", 500, 0, 104500), L("2026-04-01", 0, 5000, 105000)],
      "2026-04-01",
    );
    expect(r).toMatchObject({ ok: true, amount: 100000, firstLineDate: "2026-04-01" });
  });

  it("reports a statement starting after the date through firstLineDate", () => {
    const r = openingBalanceFromStatement([L("2026-05-30", 31000, 0, 124892)], "2026-04-01");
    expect(r).toMatchObject({ ok: true, amount: 155892, firstLineDate: "2026-05-30" });
  });

  it("counts running-balance breaks, tolerating ±1 of rounding", () => {
    const r = openingBalanceFromStatement(
      [L("2026-04-01", 0, 100, 1100), L("2026-04-02", 537, 0, 564), L("2026-04-03", 10, 0, 999)],
      "2026-04-01",
    );
    expect(r).toMatchObject({ ok: true, chainBreaks: 1 });
  });

  it("refuses without a balance column", () => {
    const r = openingBalanceFromStatement([L("2026-04-01", 0, 100, null)], "2026-04-01");
    expect(r.ok).toBe(false);
  });

  it("refuses when nothing is on or after the date", () => {
    const r = openingBalanceFromStatement([L("2026-03-01", 0, 100, 100)], "2026-04-01");
    expect(r.ok).toBe(false);
  });
});

describe("fyStartFor", () => {
  it("April onwards is the same year", () => expect(fyStartFor("2026-04-01")).toBe("2026-04-01"));
  it("Jan–Mar belongs to the previous FY", () => expect(fyStartFor("2027-03-31")).toBe("2026-04-01"));
});
