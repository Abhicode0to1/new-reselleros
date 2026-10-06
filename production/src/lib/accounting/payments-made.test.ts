import { describe, it, expect } from "vitest";
import { groupOf, summarisePaidOut, paymentEditHref, type PaidOutLine } from "./payments-made";

const L = (over: Partial<PaidOutLine> & { id: string; amount: number; txn_date: string }): PaidOutLine => ({
  payee: "x", what: "y", reference: null, account: "HDFC", group: "vendors", matched_to_type: "expense", matched_to_id: null, description: null,
  bank_account_id: "acc1", ...over,
});

describe("clicking a payment opens its record (2 Oct 2026)", () => {
  it("expense and customer refund open their own edit forms", () => {
    expect(paymentEditHref({ id: "t1", matched_to_type: "expense", matched_to_id: "EXP-9", bank_account_id: "acc1" })).toBe("/accounting/expenses?edit=EXP-9");
    expect(paymentEditHref({ id: "t2", matched_to_type: "payment", matched_to_id: "P-1", bank_account_id: "acc1" })).toBe("/payments?edit=P-1");
  });
  it("everything else — and an unreconciled line — opens the bank line on the banking screen", () => {
    for (const t of ["salary", "vendor_bill", "statutory", "prepaid", "manual", null]) {
      expect(paymentEditHref({ id: "t3", matched_to_type: t, matched_to_id: t ? "X" : null, bank_account_id: "acc1" })).toBe("/accounting/banking/acc1?focus=t3");
    }
  });
});

describe("payments made", () => {
  it("groups by how the line was reconciled; transfers are not payments", () => {
    expect(groupOf("expense")).toBe("vendors");
    expect(groupOf("vendor_bill")).toBe("vendors");
    expect(groupOf("salary")).toBe("salaries");
    expect(groupOf("split")).toBe("salaries");
    expect(groupOf("statutory")).toBe("statutory");
    expect(groupOf("prepaid")).toBe("advances");
    expect(groupOf("referral_commission")).toBe("advances");
    expect(groupOf("manual")).toBe("other");
    expect(groupOf(null)).toBe("unreconciled");
    expect(groupOf("transfer")).toBeNull();
  });

  it("MTD / FY / all-time, top payee from booked lines only, unreconciled apart", () => {
    const s = summarisePaidOut([
      L({ id: "1", amount: 50_000, txn_date: "2026-09-03", payee: "Hitesh", group: "salaries" }),
      L({ id: "2", amount: 20_000, txn_date: "2026-08-10", payee: "Google", group: "vendors" }),
      L({ id: "3", amount: 35_000, txn_date: "2026-03-10", payee: "Google", group: "vendors" }),      // last FY
      L({ id: "4", amount: 99_000, txn_date: "2026-09-20", payee: "UNKNOWN NEFT", group: "unreconciled", matched_to_type: null }),
    ], "2026-09-27");
    expect(s.mtd).toBe(149_000);
    expect(s.fy).toBe(169_000);
    expect(s.allTime).toBe(204_000);
    expect(s.unreconciled).toEqual({ count: 1, amount: 99_000 });
    expect(s.topPayee).toEqual({ name: "Google", amount: 55_000 });
    expect(s.byGroup.map((g) => [g.group, g.amount])).toEqual([["vendors", 55_000], ["salaries", 50_000], ["unreconciled", 99_000]]);
  });
});
