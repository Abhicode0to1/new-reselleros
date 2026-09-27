import { describe, it, expect } from "vitest";
import { groupOf, summarisePaidOut, type PaidOutLine } from "./payments-made";

const L = (over: Partial<PaidOutLine> & { id: string; amount: number; txn_date: string }): PaidOutLine => ({
  payee: "x", what: "y", reference: null, account: "HDFC", group: "vendors", matched_to_type: "expense", matched_to_id: null, description: null, ...over,
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
