import { describe, it, expect } from "vitest";
import {
  SPLIT_CYCLES, isSplitBilled, plannedInstalments, instalmentSkip, instalmentsDue,
} from "./instalments";
import { scheduleTotal } from "./schedule";
import type { BillingCycle } from "@/lib/supabase/database.types";

/** A ₹28,320-incl-GST yearly deal: ₹24,000 ex-GST over 12 months = ₹2,000 mrr. */
const sub = (over: Partial<{
  mrr: number; billing_cycle: BillingCycle; term_months: number;
  start_date: string | null; renewal_date: string | null;
}> = {}) => ({
  mrr:          2_000,
  billing_cycle: "monthly" as BillingCycle,
  term_months:  12,
  start_date:   "2026-08-14",
  renewal_date: "2027-08-14",
  ...over,
});

describe("which subscriptions split", () => {
  it("excludes yearly — it is one period, and the quote path already invoices it", () => {
    /* If this ever includes yearly, every yearly subscription gets invoiced twice:
       once from its quote and once from an instalment. The database trigger in
       20260817110200 draws the same line and the two must agree. */
    expect(isSplitBilled("yearly")).toBe(false);
    expect(SPLIT_CYCLES).not.toContain("yearly");
  });

  it("includes every cycle that produces more than one invoice a year", () => {
    for (const c of ["monthly", "quarterly", "half_yearly"] as BillingCycle[]) {
      expect(isSplitBilled(c)).toBe(true);
    }
  });

  it("treats a missing cycle as not split, rather than guessing", () => {
    expect(isSplitBilled(null)).toBe(false);
    expect(isSplitBilled(undefined)).toBe(false);
  });
});

describe("plannedInstalments", () => {
  it("lays 12 instalments across a monthly year", () => {
    const rows = plannedInstalments(sub());
    expect(rows).toHaveLength(12);
    expect(rows[0].periodIndex).toBe(1);
    expect(rows[11].periodIndex).toBe(12);
  });

  it("the instalments add up to the term — no rupee invented or lost", () => {
    /* The whole point of splitting. A schedule whose parts do not sum to the term
       means the customer is billed a different total depending on their cycle. */
    for (const cycle of SPLIT_CYCLES) {
      const rows = plannedInstalments(sub({ billing_cycle: cycle }));
      const total = rows.reduce((s, r) => s + r.taxableAmount, 0);
      expect(total).toBe(24_000);
    }
  });

  it("matches the schedule the portal already shows the customer", () => {
    /* Same engine, so a customer cannot be shown one forecast and invoiced another. */
    const rows = plannedInstalments(sub({ billing_cycle: "quarterly" }));
    expect(rows).toHaveLength(4);
    expect(scheduleTotal(rows.map((r) => ({
      index: r.periodIndex, billOn: r.billOn,
      periodStart: r.periodStart, periodEnd: r.periodEnd, amount: r.taxableAmount,
    })))).toBe(24_000);
  });

  it("anchors term_start on the first period so a renewal cannot collide", () => {
    /* period_index restarts at 1 each term. Without term_start in the key, the
       renewal's instalment 1 collides with the original's and never bills. */
    const first  = plannedInstalments(sub());
    const second = plannedInstalments(sub({ start_date: "2027-08-14", renewal_date: "2028-08-14" }));
    expect(first[0].periodIndex).toBe(second[0].periodIndex);
    expect(first[0].termStart).not.toBe(second[0].termStart);
  });

  it("returns nothing for a yearly subscription", () => {
    expect(plannedInstalments(sub({ billing_cycle: "yearly" }))).toEqual([]);
  });

  it("returns nothing rather than guessing when there are no dates", () => {
    expect(plannedInstalments(sub({ start_date: null, renewal_date: null }))).toEqual([]);
  });
});

describe("instalmentSkip — when billing must NOT run", () => {
  it("refuses to bill a term that was already collected up front", () => {
    /* Today's sell path charges the whole term on quote acceptance. Raising
       instalments on top of that bills the customer a second time. */
    const skip = instalmentSkip({
      cycle: "monthly", quotePaid: 28_320, quoteAmount: 28_320, scheduleSize: 12,
    });
    expect(skip?.code).toBe("term_already_collected");
    expect(skip?.reason).toMatch(/twice/);
  });

  it("treats an overpayment as collected too", () => {
    const skip = instalmentSkip({
      cycle: "monthly", quotePaid: 28_321, quoteAmount: 28_320, scheduleSize: 12,
    });
    expect(skip?.code).toBe("term_already_collected");
  });

  it("allows billing when nothing has been collected", () => {
    expect(instalmentSkip({
      cycle: "monthly", quotePaid: 0, quoteAmount: 28_320, scheduleSize: 12,
    })).toBeNull();
  });

  it("allows billing when only part has been collected", () => {
    /* One instalment paid is exactly the pay-as-you-go case this exists for. */
    expect(instalmentSkip({
      cycle: "monthly", quotePaid: 2_360, quoteAmount: 28_320, scheduleSize: 12,
    })).toBeNull();
  });

  it("names a reason for every skip — never a silent drop", () => {
    const cases = [
      { cycle: "yearly" as BillingCycle, quotePaid: 0, quoteAmount: 100, scheduleSize: 1 },
      { cycle: "monthly" as BillingCycle, quotePaid: 0, quoteAmount: 100, scheduleSize: 0 },
      { cycle: "monthly" as BillingCycle, quotePaid: 100, quoteAmount: 100, scheduleSize: 12 },
    ];
    for (const c of cases) {
      const skip = instalmentSkip(c);
      expect(skip).not.toBeNull();
      expect(skip!.reason.length).toBeGreaterThan(15);
    }
  });

  it("does not treat a zero-amount quote as collected", () => {
    /* paid 0 >= amount 0 is true, and would skip everything on a quote with no
       amount recorded. That is a missing figure, not a settled term. */
    expect(instalmentSkip({
      cycle: "monthly", quotePaid: 0, quoteAmount: 0, scheduleSize: 12,
    })).toBeNull();
  });
});

describe("instalmentsDue", () => {
  const rows = [
    { billOn: "2026-08-14", invoiceId: "INV-1" },
    { billOn: "2026-09-14", invoiceId: null },
    { billOn: "2026-10-14", invoiceId: null },
  ];

  it("catches up on a missed period instead of skipping it forever", () => {
    /* `<=` not `===`. Safe because raise_subscription_billing is idempotent. */
    const due = instalmentsDue(rows, "2026-10-20");
    expect(due.map((r) => r.billOn)).toEqual(["2026-09-14", "2026-10-14"]);
  });

  it("never re-raises a period that already has an invoice", () => {
    expect(instalmentsDue(rows, "2027-01-01").some((r) => r.invoiceId != null)).toBe(false);
  });

  it("does not bill a period before its date", () => {
    expect(instalmentsDue(rows, "2026-08-20")).toEqual([]);
  });
});
