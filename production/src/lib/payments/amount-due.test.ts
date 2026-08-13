import { describe, it, expect } from "vitest";
import { invoiceAmountDue } from "./amount-due";
import { invoiceUpiIntent } from "./upi";

const VPA = "pardeep@okhdfcbank";
const PAYEE = "Anutech Digital";

describe("invoiceAmountDue", () => {
  it("subtracts receipts as well as advances", () => {
    // net_payable already has advances removed; paid_amount is money banked
    // afterwards. Both must come off, or the balance is overstated.
    expect(invoiceAmountDue({ amount: 100000, net_payable: 80000, paid_amount: 30000, status: "pending" }))
      .toBe(50000);
  });

  it("falls back to amount when net_payable is absent", () => {
    expect(invoiceAmountDue({ amount: 50000, net_payable: null, paid_amount: 0, status: "pending" })).toBe(50000);
  });

  it("treats a missing paid_amount as zero paid, not as unknown", () => {
    expect(invoiceAmountDue({ amount: 50000, net_payable: 50000, status: "pending" })).toBe(50000);
  });

  // ── The two production rows that motivated this file ────────────────────────
  it("INV-ET-2026-27-0013: ₹6.85L invoiced, ₹5.4L received → ₹1.45L due", () => {
    expect(invoiceAmountDue({ amount: 685000, net_payable: 685000, paid_amount: 540000, status: "pending" }))
      .toBe(145000);
  });

  it("INV-ET-2026-27-0001: settled, but net_payable still reads the full amount", () => {
    // status wins over the stale arithmetic — otherwise a paid invoice bills again.
    expect(invoiceAmountDue({ amount: 540000, net_payable: 540000, paid_amount: 540000, status: "paid" }))
      .toBe(0);
  });

  it("a void invoice owes nothing whatever the numbers say", () => {
    expect(invoiceAmountDue({ amount: 99000, net_payable: 99000, paid_amount: 0, status: "void" })).toBe(0);
  });

  it("never returns a negative balance when overpaid", () => {
    expect(invoiceAmountDue({ amount: 10000, net_payable: 10000, paid_amount: 15000, status: "pending" })).toBe(0);
  });

  it("returns 0 rather than NaN when the total is unusable", () => {
    expect(invoiceAmountDue({ amount: null, net_payable: null, status: "pending" })).toBe(0);
    expect(invoiceAmountDue({ amount: Number.NaN, status: "pending" })).toBe(0);
  });

  it("is case-insensitive about status", () => {
    expect(invoiceAmountDue({ amount: 5000, net_payable: 5000, status: "PAID" })).toBe(0);
  });

  it("overdue is still owed", () => {
    expect(invoiceAmountDue({ amount: 5000, net_payable: 5000, paid_amount: 0, status: "overdue" })).toBe(5000);
  });
});

describe("invoiceUpiIntent refuses to print a QR when nothing is owed", () => {
  it("prints no QR for a zero balance", () => {
    expect(invoiceUpiIntent({ vpa: VPA, payeeName: PAYEE, invoiceId: "INV-1", amountDue: 0 })).toBeNull();
  });

  it("prints no QR when the balance is unknown", () => {
    // Previously this produced an OPEN-AMOUNT QR — "scan and type whatever" —
    // on a tax invoice, which is how a settled invoice gets paid a second time.
    expect(invoiceUpiIntent({ vpa: VPA, payeeName: PAYEE, invoiceId: "INV-1", amountDue: null })).toBeNull();
    expect(invoiceUpiIntent({ vpa: VPA, payeeName: PAYEE, invoiceId: "INV-1", amountDue: undefined })).toBeNull();
    expect(invoiceUpiIntent({ vpa: VPA, payeeName: PAYEE, invoiceId: "INV-1", amountDue: Number.NaN })).toBeNull();
  });

  it("prints no QR for a negative balance", () => {
    expect(invoiceUpiIntent({ vpa: VPA, payeeName: PAYEE, invoiceId: "INV-1", amountDue: -100 })).toBeNull();
  });

  it("carries the exact outstanding amount when money IS owed", () => {
    const uri = invoiceUpiIntent({
      vpa: VPA, payeeName: PAYEE, invoiceId: "INV-ET-2026-27-0013",
      amountDue: invoiceAmountDue({ amount: 685000, net_payable: 685000, paid_amount: 540000, status: "pending" }),
    });
    expect(uri).toContain("am=145000.00");
    expect(uri).not.toContain("am=685000");
  });

  it("end-to-end: a settled invoice yields no QR at all", () => {
    const settled = { amount: 540000, net_payable: 540000, paid_amount: 540000, status: "paid" };
    expect(invoiceUpiIntent({
      vpa: VPA, payeeName: PAYEE, invoiceId: "INV-ET-2026-27-0001",
      amountDue: invoiceAmountDue(settled),
    })).toBeNull();
  });
});
