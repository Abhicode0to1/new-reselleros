import { describe, it, expect } from "vitest";
import { customerDeleteBlockReason } from "./deletable";

/**
 * Zoho-Books parity: a customer may only be deleted when it is truly empty —
 * NO subscriptions (cascade would wipe them), payments, invoices, quotes, or
 * projects. Anything else → archive instead.
 */
const EMPTY = { subscriptions: 0, payments: 0, invoices: 0, quotes: 0, projects: 0 };

describe("customerDeleteBlockReason", () => {
  it("allows deletion when the customer has no documents at all", () => {
    expect(customerDeleteBlockReason(EMPTY)).toBeNull();
  });

  it("blocks when there are subscriptions (cascade would delete them)", () => {
    const r = customerDeleteBlockReason({ ...EMPTY, subscriptions: 2 });
    expect(r).toMatch(/2 subscriptions/);
  });

  it("blocks when there are payments or invoices", () => {
    expect(customerDeleteBlockReason({ ...EMPTY, payments: 1 })).toMatch(/1 payment/);
    expect(customerDeleteBlockReason({ ...EMPTY, invoices: 3 })).toMatch(/3 invoices/);
  });

  it("blocks when there are quotes or projects (Zoho treats them as documents)", () => {
    expect(customerDeleteBlockReason({ ...EMPTY, quotes: 1 })).toMatch(/1 quote/);
    expect(customerDeleteBlockReason({ ...EMPTY, projects: 2 })).toMatch(/2 projects/);
  });

  it("lists every document type that blocks the delete", () => {
    const r = customerDeleteBlockReason({ subscriptions: 1, payments: 2, invoices: 3, quotes: 4, projects: 5 });
    expect(r).toMatch(/1 subscription/);
    expect(r).toMatch(/2 payments/);
    expect(r).toMatch(/3 invoices/);
    expect(r).toMatch(/4 quotes/);
    expect(r).toMatch(/5 projects/);
  });
});

describe("customerDeleteBlockReason — the three R-007 record types", () => {
  /* `delete_customer` counts these since migration 20260926130000. They are optional
     here because the customer profile does not load them; when a caller does have
     them, the dialog should name them rather than leaving the RPC to do it. */
  it("names a credit note", () => {
    expect(customerDeleteBlockReason({ ...EMPTY, creditNotes: 1 })).toMatch(/1 credit note/);
  });

  it("names a debit note", () => {
    expect(customerDeleteBlockReason({ ...EMPTY, debitNotes: 2 })).toMatch(/2 debit notes/);
  });

  it("pluralises TDS correctly — entry / entries, not 'entrys'", () => {
    expect(customerDeleteBlockReason({ ...EMPTY, tdsEntries: 1 })).toMatch(/1 TDS entry/);
    expect(customerDeleteBlockReason({ ...EMPTY, tdsEntries: 3 })).toMatch(/3 TDS entries/);
  });

  it("stays silent when they are absent — an omitted count is not a block", () => {
    /* They are optional, so `undefined` must read as zero. Treating it as truthy would
       make every customer undeletable the moment a caller forgot a field. */
    expect(customerDeleteBlockReason(EMPTY)).toBeNull();
  });

  it("lists them alongside the older five", () => {
    const r = customerDeleteBlockReason({ ...EMPTY, invoices: 1, creditNotes: 1, tdsEntries: 2 });
    expect(r).toMatch(/1 invoice/);
    expect(r).toMatch(/1 credit note/);
    expect(r).toMatch(/2 TDS entries/);
  });
});
