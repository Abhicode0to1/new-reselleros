import { describe, it, expect } from "vitest";
import { recordPaymentConsequences, type PaymentToRecord } from "./record-consequences";
import type { SeriesState } from "@/lib/actions/consequence";

/* ANUTECH's real receipt-voucher counter, measured 23 Aug 2026: 39 numbers used, zero
   payments on the books. */
const RV: SeriesState = {
  prefix: "RV", docCode: "ADPL", fiscalYear: "FY2627",
  lastNumber: 39, documentCount: 0,
};

const P: PaymentToRecord = {
  quoteId: "Q-1", customerName: "Kailash Corporation",
  amount: 118_000, quoteAmount: 118_000, priorReceived: 0,
  createsCustomer: true, createsSubscription: true,
  planLabel: "Google Workspace Business Standard",
};
const text = (l: { text: string }[]) => l.map((c) => c.text).join(" | ");
const warns = (l: { tone: string; text: string }[]) => l.filter((c) => c.tone === "warning");

describe("recordPaymentConsequences", () => {
  it("names the receipt voucher it will issue — the part no screen ever mentioned", () => {
    /* A receipt voucher is a GST document under Section 31(3)(d) and takes a number from
       the same gapless series as an invoice. This dialog was a bare title. */
    const t = text(recordPaymentConsequences({ payment: P, receiptSeries: RV }));
    expect(t).toContain("RV-ADPL-2026-27-0040");
    expect(t).toMatch(/31\(3\)\(d\)/);
    expect(t).toMatch(/used up whether or not/i);
  });

  it("handles the first receipt of a financial year without inventing a number", () => {
    const t = text(recordPaymentConsequences({ payment: P, receiptSeries: null }));
    expect(t).toMatch(/first of this financial year/i);
    expect(t).not.toMatch(/RV-/);
  });

  it("states the amount and who it is from", () => {
    const t = text(recordPaymentConsequences({ payment: P, receiptSeries: RV }));
    expect(t).toContain("₹1,18,000");
    expect(t).toContain("Kailash Corporation");
  });

  it("shows the running total when money has come in before", () => {
    const t = text(recordPaymentConsequences({
      payment: { ...P, amount: 18_000, priorReceived: 100_000 },
      receiptSeries: RV,
    }));
    expect(t).toContain("₹1,00,000 already received");
    expect(t).toContain("₹1,18,000");
  });

  it("warns on an overpayment WITHOUT blocking it", () => {
    /* A customer really can pay more than the quote. It needs a decision now rather than
       a surprise at reconciliation — but refusing it would reject real money. */
    const l = recordPaymentConsequences({ payment: { ...P, amount: 130_000 }, receiptSeries: RV });
    expect(text(warns(l))).toMatch(/₹12,000 MORE/);
    expect(text(warns(l))).toMatch(/advance/i);
  });

  it("says what stays outstanding on a part payment", () => {
    const t = text(recordPaymentConsequences({ payment: { ...P, amount: 50_000 }, receiptSeries: RV }));
    expect(t).toContain("₹68,000");
    expect(t).toMatch(/partly paid/i);
  });

  it("says the lead becomes a customer and leaves the pipeline", () => {
    const t = text(recordPaymentConsequences({ payment: P, receiptSeries: RV }));
    expect(t).toMatch(/Turns the lead into a customer/i);
    expect(t).toMatch(/stops appearing in the pipeline/i);
  });

  it("says a subscription is created, and that the cron will bill it", () => {
    const t = text(recordPaymentConsequences({ payment: P, receiptSeries: RV }));
    expect(t).toMatch(/recurring subscription/i);
    expect(t).toContain("Google Workspace Business Standard");
    expect(t).toMatch(/renewal cron/i);
  });

  it("says POSITIVELY when NO subscription will be created", () => {
    /* An operator expecting a renewal should learn it here, not from one that never
       arrives. Phrased by outcome: a one-off sale (guard 0157) and lines with no billing
       commitment both land here, and the consequence is identical. */
    const t = text(recordPaymentConsequences({
      payment: { ...P, createsSubscription: false }, receiptSeries: RV,
    }));
    expect(t).toMatch(/No subscription and no renewal/);
    expect(t).toMatch(/billed again automatically/);
    expect(t).not.toMatch(/recurring subscription/i);
  });

  it("names the way back, and what does not come back", () => {
    /* Not a softening — an operator who knows the recovery acts on a mistake instead of
       leaving it. The serial is the part that is gone. */
    const t = text(recordPaymentConsequences({ payment: P, receiptSeries: RV }));
    expect(t).toMatch(/delete the payment in Payments/i);
    expect(t).toMatch(/does not come back/i);
  });

  it("surfaces the series gap", () => {
    expect(text(recordPaymentConsequences({ payment: P, receiptSeries: RV }))).toMatch(/39 numbers/);
  });

  it("blocks a zero or negative payment and says nothing else", () => {
    /* record_payment refuses it outright ("amount must be > 0"), so listing consequences
       for something that cannot happen would be noise. */
    for (const amount of [0, -500]) {
      const l = recordPaymentConsequences({ payment: { ...P, amount }, receiptSeries: RV });
      expect(l).toHaveLength(1);
      expect(l[0].tone).toBe("warning");
      expect(l[0].text).toMatch(/more than zero/i);
    }
  });
});
