import { describe, it, expect } from "vitest";
import { invoiceAmountDue, quoteAmountDue } from "./amount-due";
import { invoiceUpiIntent, quoteUpiIntent } from "./upi";

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

describe("quoteAmountDue — a quote is not an invoice", () => {
  const OPEN = { amount: 19258, payment_amount: 0, payment_status: "awaiting", currency: "INR" };

  it("collects the full amount on an open INR quote", () => {
    expect(quoteAmountDue(OPEN)).toBe(19258);
  });

  it("treats a missing currency as INR (pre-0153 rows)", () => {
    expect(quoteAmountDue({ amount: 5000, payment_status: "awaiting" })).toBe(5000);
  });

  it("subtracts a part payment", () => {
    expect(quoteAmountDue({ ...OPEN, payment_amount: 9000, payment_status: "partial" })).toBe(10258);
  });

  // ── Currency: the bug this rule exists to prevent ────────────────────────
  it("refuses a non-INR quote entirely", () => {
    // UPI settles only in rupees. `am=500.00` on a $500 quote is not a $500
    // request — every UPI app reads it as Rs.500. Better no QR than 98% wrong.
    expect(quoteAmountDue({ ...OPEN, currency: "USD" })).toBe(0);
    expect(quoteAmountDue({ ...OPEN, currency: "AED" })).toBe(0);
    expect(quoteAmountDue({ ...OPEN, currency: "usd" })).toBe(0);
    expect(quoteAmountDue({ ...OPEN, currency: " inr " })).toBe(19258);  // trimmed + upper
  });

  // ── Who owns the ask ─────────────────────────────────────────────────────
  it("refuses an invoiced quote — the invoice carries that ask", () => {
    // All three unpaid production quotes are status 'invoiced'. A QR here plus a
    // QR on the invoice is two documents asking for the same money.
    expect(quoteAmountDue({ ...OPEN, payment_status: "invoiced" })).toBe(0);
  });

  it("refuses a settled quote", () => {
    expect(quoteAmountDue({ ...OPEN, payment_status: "received" })).toBe(0);
  });

  it("refuses an unrecognised status rather than assuming it is collectable", () => {
    expect(quoteAmountDue({ ...OPEN, payment_status: "something_new" })).toBe(0);
  });

  it("never goes negative, never NaN", () => {
    expect(quoteAmountDue({ ...OPEN, payment_amount: 99999 })).toBe(0);
    expect(quoteAmountDue({ ...OPEN, amount: null })).toBe(0);
    expect(quoteAmountDue({ ...OPEN, amount: Number.NaN })).toBe(0);
  });
});

describe("quoteUpiIntent", () => {
  const VPA2 = "pardeep@okhdfcbank";

  it("says ADVANCE, not Invoice — that is what the money legally is", () => {
    const uri = quoteUpiIntent({ vpa: VPA2, payeeName: "Anutech Digital", quoteId: "Q-ET-2026-27-0071", amountDue: 19258 });
    expect(uri).toContain("tn=Advance%20Q-ET-2026-27-0071");
    expect(uri).not.toContain("Invoice");
    expect(uri).toContain("am=19258.00");
  });

  it("prints no QR when nothing is collectable", () => {
    for (const a of [0, null, undefined, -5, Number.NaN]) {
      expect(quoteUpiIntent({ vpa: VPA2, payeeName: "X", quoteId: "Q-1", amountDue: a })).toBeNull();
    }
  });

  it("end-to-end: a USD quote yields no QR at all", () => {
    const usd = { amount: 500, payment_amount: 0, payment_status: "awaiting", currency: "USD" };
    expect(quoteUpiIntent({
      vpa: VPA2, payeeName: "Anutech Digital", quoteId: "Q-USD-1", amountDue: quoteAmountDue(usd),
    })).toBeNull();
  });
});
