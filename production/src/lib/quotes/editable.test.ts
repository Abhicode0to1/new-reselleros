import { describe, it, expect } from "vitest";
import { quoteEditBlockReason, isQuoteEditableInPlace } from "./editable";
import type { Quote } from "@/lib/supabase/database.types";

const q = (over: Partial<Pick<Quote, "status" | "payment_status">>) =>
  ({ status: "draft", payment_status: "none", ...over }) as Pick<Quote, "status" | "payment_status">;

describe("only a draft can be edited in place", () => {
  it("lets an untouched draft through", () => {
    expect(quoteEditBlockReason(q({}))).toBeNull();
    expect(isQuoteEditableInPlace(q({}))).toBe(true);
    // "awaiting" is a draft that has been costed but not paid — still nobody's money.
    expect(quoteEditBlockReason(q({ payment_status: "awaiting" }))).toBeNull();
  });

  it("refuses a quote the customer has already been shown", () => {
    for (const status of ["sent", "viewed", "accepted", "rejected", "expired"] as const) {
      const block = quoteEditBlockReason(q({ status }));
      expect(block, status).not.toBeNull();
      expect(block?.reason, status).toContain(status);
      expect(block?.nextStep, status).toMatch(/duplicate/i);
    }
  });

  it("refuses a quote with money against it, whatever its status says", () => {
    /* The case a `status === "draft"` check alone would wave straight through: the
       direct-invoice path and older imported rows both produce a draft carrying a
       payment. Editing the total there leaves the payment reconciling against nothing. */
    for (const payment_status of ["partial", "received", "invoiced"] as const) {
      const block = quoteEditBlockReason(q({ status: "draft", payment_status }));
      expect(block, payment_status).not.toBeNull();
      expect(isQuoteEditableInPlace(q({ status: "draft", payment_status })), payment_status).toBe(false);
    }
  });

  it("names the tax invoice specifically, because that one is not ours to change", () => {
    /* An invoice is the document of record under CGST §31 — a correction is a credit or
       debit note, not an edit. A generic "cannot edit" would leave the operator looking
       for the edit button they think they are missing. */
    const block = quoteEditBlockReason(q({ payment_status: "invoiced" }));
    expect(block?.reason).toMatch(/tax invoice/i);
    expect(block?.reason).toMatch(/CGST/);
  });

  it("always says what to do instead — a block with no exit is the bug §24 forbids", () => {
    const blocked = [
      q({ status: "sent" }),
      q({ status: "accepted" }),
      q({ payment_status: "received" }),
      q({ payment_status: "invoiced" }),
    ];
    for (const quote of blocked) {
      const block = quoteEditBlockReason(quote);
      expect(block?.nextStep, JSON.stringify(quote)).toBeTruthy();
      expect(block?.nextStep).toMatch(/duplicate/i);
    }
  });
});
