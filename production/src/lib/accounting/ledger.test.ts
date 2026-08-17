import { describe, it, expect } from "vitest";
import {
  buildLedger, side, balanceSide, signedEffect, assertWholeRupees,
  fyOf, fyLabel, fyPeriod, quarterPeriod, monthPeriod, customPeriod,
  type LedgerEntry,
} from "./ledger";

const FY26 = fyPeriod(2026);   // 2026-04-01 → 2027-03-31

const bill = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  date: "2026-05-10", reference: "INV-ADPL-2026-27-0001", voucher: "Sales",
  amount: 100_000, increasesLiability: true, ...over,
});
const receipt = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  date: "2026-05-20", reference: "RV-ADPL-2026-27-0001", voucher: "Receipt",
  amount: 100_000, increasesLiability: false, ...over,
});

/**
 * ─── THE MIRROR — the one thing that must not be got wrong ───────────────────
 * A customer is a DEBTOR (what they owe is a Debit balance); a vendor is a CREDITOR
 * (what we owe is a Credit balance). The two statements are reflections, and the classic
 * failure is a vendor ledger rendered with a customer's signs — which produces a
 * plausible-looking statement claiming the vendor owes US money.
 */
describe("customer and vendor are mirror images", () => {
  it("puts an invoice in Debit but a vendor bill in Credit", () => {
    expect(side("customer", true)).toBe("debit");
    expect(side("vendor", true)).toBe("credit");
  });

  it("puts a receipt in Credit but a vendor payment in Debit", () => {
    expect(side("customer", false)).toBe("credit");
    expect(side("vendor", false)).toBe("debit");
  });

  it("labels an unpaid customer Dr and an unpaid vendor Cr, for the SAME arithmetic", () => {
    expect(balanceSide("customer", 40_000)).toBe("Dr");
    expect(balanceSide("vendor", 40_000)).toBe("Cr");
  });

  it("labels an advance the opposite way round on each side", () => {
    /* A customer who overpaid: we owe them → Cr. A vendor we overpaid: they owe us → Dr. */
    expect(balanceSide("customer", -5_000)).toBe("Cr");
    expect(balanceSide("vendor", -5_000)).toBe("Dr");
  });

  it("shows NOTHING at exactly zero rather than '₹0 Dr'", () => {
    /* A settled account is not a debt of nothing. On a statement a customer receives,
       "0 Dr" reads as a claim. */
    expect(balanceSide("customer", 0)).toBeNull();
    expect(balanceSide("vendor", 0)).toBeNull();
  });

  it("produces opposite columns from the SAME entries", () => {
    const entries = [bill(), receipt({ amount: 40_000 })];
    const cust = buildLedger("customer", entries, FY26);
    const vend = buildLedger("vendor", entries, FY26);

    expect(cust.rows[0].debit).toBe(100_000);
    expect(vend.rows[0].credit).toBe(100_000);
    /* Same signed balance, opposite meaning. ₹60,000 the customer owes us is
       ₹60,000 we owe the vendor. */
    expect(cust.closingBalance).toBe(60_000);
    expect(vend.closingBalance).toBe(60_000);
    expect(cust.closingSide).toBe("Dr");
    expect(vend.closingSide).toBe("Cr");
  });
});

describe("the running balance", () => {
  it("carries forward down the column", () => {
    const s = buildLedger("customer", [
      bill({ date: "2026-04-05", reference: "INV-1", amount: 50_000 }),
      bill({ date: "2026-04-20", reference: "INV-2", amount: 30_000 }),
      receipt({ date: "2026-05-01", reference: "RV-1", amount: 50_000 }),
    ], FY26);
    expect(s.rows.map((r) => r.balance)).toEqual([50_000, 80_000, 30_000]);
    expect(s.rows.map((r) => r.balanceSide)).toEqual(["Dr", "Dr", "Dr"]);
  });

  it("flips the side mid-statement when the party overpays", () => {
    /* A ₹1,20,000 receipt against a ₹1,00,000 invoice leaves us holding ₹20,000 of the
       customer's money. The statement must say Cr from that row on, not keep printing Dr. */
    const s = buildLedger("customer", [bill(), receipt({ amount: 120_000 })], FY26);
    expect(s.rows[1].balance).toBe(-20_000);
    expect(s.rows[1].balanceSide).toBe("Cr");
    expect(s.closingSide).toBe("Cr");
  });

  it("credit note reduces what a customer owes; debit note increases it", () => {
    const s = buildLedger("customer", [
      bill({ amount: 100_000 }),
      { date: "2026-06-01", reference: "CN-1", voucher: "Credit Note", amount: 18_000, increasesLiability: false },
      { date: "2026-06-02", reference: "DN-1", voucher: "Debit Note", amount: 5_000, increasesLiability: true },
    ], FY26);
    expect(s.rows[1].credit).toBe(18_000);
    expect(s.rows[2].debit).toBe(5_000);
    expect(s.closingBalance).toBe(87_000);
  });

  it("treats a refund as money going back — the customer owes again", () => {
    const s = buildLedger("customer", [
      bill(), receipt(),
      { date: "2026-07-01", reference: "RFV-1", voucher: "Refund", amount: 100_000, increasesLiability: true },
    ], FY26);
    expect(s.closingBalance).toBe(100_000);
    expect(s.closingSide).toBe("Dr");
  });

  it("totals the two columns separately, and they need not be equal", () => {
    const s = buildLedger("customer", [bill(), receipt({ amount: 40_000 })], FY26);
    expect(s.totalDebit).toBe(100_000);
    expect(s.totalCredit).toBe(40_000);
    expect(s.totalBilled).toBe(100_000);
    expect(s.totalSettled).toBe(40_000);
  });

  it("closes at opening + debits − credits, for a customer", () => {
    const entries = [
      bill({ date: "2026-02-01", reference: "INV-OLD", amount: 25_000 }),  // last FY
      bill({ amount: 100_000 }), receipt({ amount: 40_000 }),
    ];
    const s = buildLedger("customer", entries, FY26);
    expect(s.openingBalance + s.totalDebit - s.totalCredit).toBe(s.closingBalance);
  });
});

/**
 * ─── OPENING BALANCE ────────────────────────────────────────────────────────
 * A statement that starts at zero claims the party had no history before the window.
 * The error surfaces as a closing balance that disagrees with the customer's own books
 * by exactly what they carried forward — found by them, not by us.
 */
describe("opening balance", () => {
  const entries = [
    bill({ date: "2026-01-15", reference: "INV-LASTFY", amount: 25_000 }),
    bill({ date: "2026-05-10", reference: "INV-THISFY", amount: 100_000 }),
  ];

  it("carries what the party owed before the window opened", () => {
    const s = buildLedger("customer", entries, FY26);
    expect(s.openingBalance).toBe(25_000);
    expect(s.openingSide).toBe("Dr");
  });

  it("keeps the pre-window rows OUT of the table and out of the column totals", () => {
    const s = buildLedger("customer", entries, FY26);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].reference).toBe("INV-THISFY");
    expect(s.totalDebit).toBe(100_000);
  });

  it("starts the running balance FROM the opening, not from zero", () => {
    expect(buildLedger("customer", entries, FY26).rows[0].balance).toBe(125_000);
  });

  it("is zero for a party with no history, and shows no side", () => {
    const s = buildLedger("customer", [bill()], FY26);
    expect(s.openingBalance).toBe(0);
    expect(s.openingSide).toBeNull();
  });

  it("can open on the WRONG side — an advance carried into the new year", () => {
    const s = buildLedger("customer", [
      receipt({ date: "2026-03-20", reference: "RV-ADV", amount: 30_000 }),
    ], FY26);
    expect(s.openingBalance).toBe(-30_000);
    expect(s.openingSide).toBe("Cr");
  });

  it("excludes anything after the window closes", () => {
    const s = buildLedger("customer", [
      bill({ date: "2026-05-10", amount: 100_000 }),
      bill({ date: "2027-04-05", reference: "INV-NEXTFY", amount: 70_000 }),
    ], FY26);
    expect(s.rows).toHaveLength(1);
    expect(s.closingBalance).toBe(100_000);
  });

  it("includes both boundary days — 1 Apr and 31 Mar are inside the FY", () => {
    const s = buildLedger("customer", [
      bill({ date: "2026-04-01", reference: "INV-FIRSTDAY", amount: 1_000 }),
      bill({ date: "2027-03-31", reference: "INV-LASTDAY", amount: 2_000 }),
    ], FY26);
    expect(s.rows).toHaveLength(2);
  });
});

describe("row order is stable, so two printouts of one statement agree", () => {
  it("bills before settlements on the same date — you are billed, then you pay", () => {
    const s = buildLedger("customer", [
      receipt({ date: "2026-05-10", reference: "RV-1", amount: 100_000 }),
      bill({ date: "2026-05-10", reference: "INV-1", amount: 100_000 }),
    ], FY26);
    expect(s.rows.map((r) => r.reference)).toEqual(["INV-1", "RV-1"]);
    /* And so the balance never dips negative on a day that actually settled to zero. */
    expect(s.rows.map((r) => r.balance)).toEqual([100_000, 0]);
  });

  it("breaks a remaining tie by reference rather than by input order", () => {
    const a = buildLedger("customer", [
      bill({ date: "2026-05-10", reference: "INV-B", amount: 10 }),
      bill({ date: "2026-05-10", reference: "INV-A", amount: 20 }),
    ], FY26);
    const b = buildLedger("customer", [
      bill({ date: "2026-05-10", reference: "INV-A", amount: 20 }),
      bill({ date: "2026-05-10", reference: "INV-B", amount: 10 }),
    ], FY26);
    expect(a.rows.map((r) => r.reference)).toEqual(["INV-A", "INV-B"]);
    expect(a.rows.map((r) => r.balance)).toEqual(b.rows.map((r) => r.balance));
  });

  it("does not mutate the array it was given", () => {
    const entries = [bill({ reference: "INV-Z" }), bill({ date: "2026-04-01", reference: "INV-A" })];
    buildLedger("customer", entries, FY26);
    expect(entries[0].reference).toBe("INV-Z");
  });
});

describe("whole rupees, enforced loudly", () => {
  it("refuses a fractional amount — it means somebody passed paise", () => {
    /* A statement 100× too large is not obviously wrong on screen, is wrong in the Tally
       import, and gets found by the customer. */
    expect(() => assertWholeRupees([bill({ amount: 1180.5 })]))
      .toThrow(/whole rupees/);
  });

  it("refuses a negative amount — direction belongs in increasesLiability", () => {
    expect(() => assertWholeRupees([bill({ amount: -100 })]))
      .toThrow(/negative debit is a credit nobody can audit/);
  });

  it("names the offending document, so it can be found", () => {
    expect(() => assertWholeRupees([bill({ reference: "INV-BROKEN", amount: 0.5 })]))
      .toThrow(/INV-BROKEN/);
  });

  it("accepts zero — a nil-rated document is legitimate", () => {
    expect(() => assertWholeRupees([bill({ amount: 0 })])).not.toThrow();
  });

  it("is enforced by buildLedger itself, not just available to callers", () => {
    expect(() => buildLedger("customer", [bill({ amount: 99.99 })], FY26)).toThrow();
  });
});

describe("signedEffect", () => {
  it("is positive when the party owes more, negative when it settles", () => {
    expect(signedEffect(bill())).toBe(100_000);
    expect(signedEffect(receipt())).toBe(-100_000);
  });
});

/**
 * ─── INDIAN FISCAL PERIODS ──────────────────────────────────────────────────
 * Q1 is Apr–Jun, not Jan–Mar. A statement headed "Q1" showing calendar Q1 disagrees with
 * every other Indian financial document its reader holds, and nothing on screen says so.
 */
describe("periods follow the Indian financial year", () => {
  it("runs 1 April to 31 March", () => {
    expect(fyPeriod(2026).from).toBe("2026-04-01");
    expect(fyPeriod(2026).to).toBe("2027-03-31");
    expect(fyLabel(2026)).toBe("FY 2026-27");
  });

  it("puts March in the PREVIOUS financial year and April in the new one", () => {
    expect(fyOf("2026-03-31")).toBe(2025);
    expect(fyOf("2026-04-01")).toBe(2026);
    expect(fyOf("2026-12-31")).toBe(2026);
    expect(fyOf("2027-01-01")).toBe(2026);
  });

  it("makes Q1 Apr–Jun and Q4 Jan–Mar of the next calendar year", () => {
    expect(quarterPeriod(2026, 1)).toMatchObject({ from: "2026-04-01", to: "2026-06-30" });
    expect(quarterPeriod(2026, 2)).toMatchObject({ from: "2026-07-01", to: "2026-09-30" });
    expect(quarterPeriod(2026, 3)).toMatchObject({ from: "2026-10-01", to: "2026-12-31" });
    expect(quarterPeriod(2026, 4)).toMatchObject({ from: "2027-01-01", to: "2027-03-31" });
  });

  it("labels a quarter with its financial year, not its calendar year", () => {
    /* Q4 FY 2026-27 falls in calendar 2027. "Q4 2027" would be a different quarter. */
    expect(quarterPeriod(2026, 4).label).toBe("Q4 FY 2026-27");
  });

  it("covers the four quarters with no gap and no overlap", () => {
    const qs = ([1, 2, 3, 4] as const).map((q) => quarterPeriod(2026, q));
    expect(qs[0].from).toBe(fyPeriod(2026).from);
    expect(qs[3].to).toBe(fyPeriod(2026).to);
    for (let i = 1; i < 4; i++) {
      const prevEnd = new Date(`${qs[i - 1].to}T00:00:00Z`).getTime();
      const thisStart = new Date(`${qs[i].from}T00:00:00Z`).getTime();
      expect(thisStart - prevEnd).toBe(86_400_000);
    }
  });

  it("ends a month on its real last day, leap years included", () => {
    expect(monthPeriod(2026, 2).to).toBe("2026-02-28");
    expect(monthPeriod(2028, 2).to).toBe("2028-02-29");
    expect(monthPeriod(2026, 4).to).toBe("2026-04-30");
    expect(monthPeriod(2026, 12).to).toBe("2026-12-31");
  });

  it("labels a month in words, because a CA reads this", () => {
    expect(monthPeriod(2026, 8).label).toBe("August 2026");
  });

  it("passes a custom range through unchanged", () => {
    expect(customPeriod("2026-05-01", "2026-05-15"))
      .toMatchObject({ from: "2026-05-01", to: "2026-05-15" });
  });
});

/**
 * ─── ANUTECH'S REAL SHAPE ───────────────────────────────────────────────────
 * 8 invoices totalling ₹10,78,963 and 9 receipts totalling ₹15,18,957 on the live books.
 * Receipts EXCEED invoices, so the tenant is holding ₹4,39,994 of customer money — and a
 * ledger that could only print Dr would report that backwards.
 */
describe("the live totals, as a whole-book sanity check", () => {
  const s = buildLedger("customer", [
    bill({ date: "2026-08-01", reference: "INV-ALL", amount: 1_078_963 }),
    receipt({ date: "2026-08-02", reference: "RV-ALL", amount: 1_518_957 }),
  ], FY26);

  it("reports the ₹4,39,994 excess as a CREDIT, not a debt", () => {
    expect(s.closingBalance).toBe(-439_994);
    expect(s.closingSide).toBe("Cr");
  });

  it("keeps both column totals visible rather than netting them off", () => {
    /* A CA reconciles the columns, not the net. Showing only "-₹4,39,994" hides the
       ₹10.79L billed and the ₹15.19L received that produced it. */
    expect(s.totalDebit).toBe(1_078_963);
    expect(s.totalCredit).toBe(1_518_957);
  });
});
