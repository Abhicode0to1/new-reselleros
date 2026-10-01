import { describe, it, expect } from "vitest";
import { INVOICE_CHIPS, invoiceBalance, invoiceChipCounts, invoiceKpis, type KpiInvoice } from "./kpis";

/* The rows as they sit in the local DB on 1 Oct 2026 (R-062). */
const FBB9: KpiInvoice[] = [
  { id: "INV-FBB9-2026-27-0001", status: "paid", amount: 590000, net_payable: 0, paid_amount: 0,      paid_date: "2026-08-07", due_date: null },
  { id: "INV-FBB9-2026-27-0002", status: "void", amount: 2360000, net_payable: 0, paid_amount: 0,     paid_date: null,         due_date: null },
  { id: "INV-FBB9-2026-27-0003", status: "paid", amount: 590000, net_payable: 0, paid_amount: 590000, paid_date: "2026-09-26", due_date: null },
];
const T1111_VOID: KpiInvoice = { id: "INV-1111-2026-27-0001", status: "void", amount: 540000, net_payable: 540000, paid_amount: 0, paid_date: null, due_date: "2026-08-20" };

const sept = new Date("2026-09-30T12:00:00+05:30");
const oct1 = new Date("2026-10-01T09:00:00+05:30");

describe("invoice KPIs (R-062)", () => {
  it("September: one invoice paid, ₹5.9L — -0001 was paid in August, -0002 is void", () => {
    const k = invoiceKpis(FBB9, sept);
    expect(k.paidThisMonth).toBe(590000);
    expect(k.paidThisMonthCount).toBe(1);
    expect(k.outstanding).toBe(0);
    expect(invoiceKpis(FBB9, oct1).paidThisMonth).toBe(0);   // new month, nothing paid yet
  });

  it("a void invoice is not money owed (was ₹5.4L of Outstanding + Overdue)", () => {
    const k = invoiceKpis([T1111_VOID], oct1);
    expect(k.outstanding).toBe(0);
    expect(k.overdueTotal).toBe(0);
    expect(invoiceBalance({ status: "draft", amount: 1000, due_date: null })).toBe(0);
  });

  it("outstanding is net of advances and of receipts against the invoice", () => {
    expect(invoiceBalance({ status: "pending", amount: 590000, net_payable: 590000, paid_amount: 200000, due_date: null })).toBe(390000);
    expect(invoiceBalance({ status: "pending", amount: 118000, net_payable: 18000, due_date: null })).toBe(18000);
    expect(invoiceBalance({ status: "pending", amount: 1000, paid_amount: 5000, due_date: null })).toBe(0);
    const k = invoiceKpis([{ status: "pending", amount: 100000, paid_amount: 40000, due_date: "2026-09-01" }], oct1);
    expect(k.outstanding).toBe(60000);
    expect(k.overdueTotal).toBe(60000);
  });

  it("the month is the IST month, by string — a paid_date of the 1st is this month in any browser", () => {
    const k = invoiceKpis([{ status: "paid", amount: 100, paid_date: "2026-10-01", due_date: null }], new Date("2026-09-30T19:00:00Z")); // 1 Oct 00:30 IST
    expect(k.paidThisMonth).toBe(100);
  });
});

describe("invoice status chips (R-063)", () => {
  it("every invoice is in exactly one chip, so the chips add up to All — Void included", () => {
    const rows = [
      ...FBB9, T1111_VOID,
      { status: "draft", amount: 1, due_date: null },
      { status: "pending", amount: 1, due_date: null },
      { status: "pending", amount: 1, due_date: null, adjusted_advances: [{ amount: 1 }] },
      { status: "pending", amount: 1, due_date: "2026-09-01" },
    ];
    const c = invoiceChipCounts(rows, "2026-10-01");
    expect(c.void).toBe(2);
    expect(INVOICE_CHIPS.reduce((s, k) => s + c[k], 0)).toBe(c.all);
    expect(c).toEqual({ all: 8, paid: 2, partial: 1, pending: 1, overdue: 1, draft: 1, void: 2 });
  });
});
