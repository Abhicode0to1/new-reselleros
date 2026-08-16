import { describe, it, expect } from "vitest";
import { lineEconomics, quoteApprovalRecord } from "./approval-economics";
import { requiredApproval } from "./approval";
import type { QuoteLineItem, Quote } from "@/lib/supabase/database.types";

const line = (over: Partial<QuoteLineItem> = {}): QuoteLineItem => ({
  id: "l1", name: "Google Workspace Business Starter", qty: 10, rate: 3240, cost: 1320, ...over,
});

describe("lineEconomics", () => {
  it("reads an undiscounted quote as 0% off", () => {
    const e = lineEconomics([line({ list_rate: 3240 })]);
    expect(e).toMatchObject({ subtotal: 32_400, listTotal: 32_400, totalCost: 13_200 });
    expect(requiredApproval(e).tier).toBe("none");
  });

  it("catches a discount given by EDITING THE RATE, not just discount_pct", () => {
    /* This is how reps actually discount here — they type a lower rate. Deriving the
       discount from quotes.discount_pct alone would report 0% and wave it through. */
    const e = lineEconomics([line({ rate: 2600, list_rate: 3240 })]);
    expect(requiredApproval(e).discountBps).toBe(1975);
    expect(requiredApproval(e).tier).toBe("manager");
  });

  it("still honours a legacy per-line discount_pct", () => {
    const e = lineEconomics([line({ list_rate: 3240, discount_pct: 25 })]);
    expect(e.subtotal).toBe(24_300);
    expect(requiredApproval(e).tier).toBe("owner");   // 25% off, past the manager band
  });

  it("treats a missing list_rate as UNDISCOUNTED, not as 100% off", () => {
    /* An older line without a frozen list price was never discounted, so its list IS
       its rate. Falling back to 0 would report every legacy quote as a 100% discount
       and drop the entire back-catalogue into the owner's queue. */
    const e = lineEconomics([line()]);
    expect(e.listTotal).toBe(32_400);
    expect(requiredApproval(e).discountBps).toBe(0);
  });

  it("flags cost-unknown when a sold line has no cost", () => {
    const e = lineEconomics([line({ cost: 0 })]);
    expect(e.costUnknown).toBe(true);
    expect(requiredApproval(e).tier).toBe("owner");
  });

  it("does NOT flag a genuinely free line", () => {
    // Rate 0 and cost 0 is a giveaway, not a missing cost.
    expect(lineEconomics([line({ rate: 0, cost: 0, list_rate: 0 })]).costUnknown).toBe(false);
  });

  it("sums several lines", () => {
    const e = lineEconomics([
      line({ id: "a", qty: 10, rate: 3000, list_rate: 3240, cost: 1320 }),
      line({ id: "b", qty: 5,  rate: 1200, list_rate: 1200, cost: 600 }),
    ]);
    expect(e.subtotal).toBe(36_000);
    expect(e.listTotal).toBe(38_400);
    expect(e.totalCost).toBe(16_200);
  });

  it("handles an empty quote without dividing by zero", () => {
    const e = lineEconomics([]);
    expect(e).toMatchObject({ subtotal: 0, listTotal: 0, totalCost: 0 });
    expect(requiredApproval(e).tier).toBe("none");
  });
});

describe("quoteApprovalRecord", () => {
  it("maps the stored columns onto the record the matrix reads", () => {
    const q = {
      approval_status: "approved", approval_tier: "manager",
      approval_requested_by: "u1", approved_by: "u2",
      approved_discount_bps: 1500, approved_margin_bps: 3000,
      approval_rejection_reason: null,
    } as unknown as Quote;
    expect(quoteApprovalRecord(q)).toEqual({
      status: "approved", tier: "manager", requestedBy: "u1", approvedBy: "u2",
      approvedDiscountBps: 1500, approvedMarginBps: 3000, rejectionReason: null,
    });
  });

  it("defaults a row written before the migration to not_required", () => {
    expect(quoteApprovalRecord({} as unknown as Quote).status).toBe("not_required");
  });
});
