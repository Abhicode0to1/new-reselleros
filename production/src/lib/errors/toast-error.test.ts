import { describe, it, expect } from "vitest";
import { describeError } from "./toast-error";

/**
 * The contract that matters: our RPC guards write careful, actionable business
 * copy (often WITH a technical errcode attached). Those must survive untouched.
 * Only raw database plumbing gets replaced. See docs/UX-AUDIT.md G1.
 */
describe("describeError — real guard messages pass through UNCHANGED", () => {
  // Verbatim from supabase/migrations/0213 + 0147.
  const GUARDS = [
    "A GST invoice is already generated for this quote — cancel / credit-note that invoice before deleting the payment.",
    "This payment is reconciled to a bank transaction — un-reconcile that bank line first, then delete.",
    "This is an add-seats payment — adjust it from the subscription (reduce seats), not by deleting here.",
    "A purchase order from this sale is already processed — handle it manually before deleting the payment.",
    "quote Q-ET-2026-27-0010 has no amount - cannot record a payment against a zero-value quote",
    "Payment not found",
  ];

  it.each(GUARDS)("keeps: %s", (msg) => {
    const d = describeError(new Error(msg));
    expect(d.message).toBe(msg);
    expect(d.translated).toBe(false);
  });

  it("a guard message is kept even though the same error carries a technical errcode", () => {
    // This is why we branch on TEXT, not on `code` — a code-based rule would
    // have replaced this good copy with something generic.
    const err = Object.assign(new Error("This payment is reconciled to a bank transaction — un-reconcile that bank line first, then delete."), {
      code: "check_violation",
    });
    expect(describeError(err).translated).toBe(false);
  });
});

describe("describeError — raw plumbing is NEVER shown", () => {
  const CASES: Array<[string, string]> = [
    ['duplicate key value violates unique constraint "payments_idempotency_uq"', "This is already saved."],
    ['insert or update on table "quotes" violates foreign key constraint "quotes_customer_id_fkey"', "Something this depends on is missing."],
    ['null value in column "amount" of relation "payments" violates not-null constraint', "A required field is empty."],
    ['new row violates row-level security policy for table "customers"', "You don't have access to this."],
    ["permission denied for function record_payment", "You don't have access to this."],
    ['relation "public.gst_payments" does not exist', "Something went wrong on our side."],
    ["TypeError: Failed to fetch", "Network problem."],
    ["JWT expired", "Your session expired."],
  ];

  it.each(CASES)("translates %s", (raw, expected) => {
    const d = describeError(new Error(raw));
    expect(d.message).toBe(expected);
    expect(d.translated).toBe(true);
    expect(d.description).toBeTruthy();      // §24: there is always a "why"
    expect(d.message).not.toContain("constraint");
    expect(d.message).not.toContain("relation");
  });

  it("keeps the original text available for support without rendering it", () => {
    const raw = 'duplicate key value violates unique constraint "x"';
    expect(describeError(new Error(raw)).raw).toBe(raw);
  });
});

describe("describeError — input shapes", () => {
  it("reads a plain string", () => {
    expect(describeError("Seats must be at least 1").message).toBe("Seats must be at least 1");
  });

  it("reads a Supabase PostgrestError-shaped object", () => {
    const pgErr = { message: "duplicate key value violates unique constraint", code: "23505", details: "", hint: "" };
    expect(describeError(pgErr).message).toBe("This is already saved.");
  });

  it("falls back safely when there is no usable text", () => {
    for (const empty of [null, undefined, {}, new Error(""), ""]) {
      const d = describeError(empty);
      expect(d.message).toBe("Something went wrong.");
      expect(d.description).toBeTruthy();
      expect(d.translated).toBe(true);
    }
  });

  it("honours a caller-supplied fallback for empty errors", () => {
    expect(describeError(null, "Could not create project").message).toBe("Could not create project");
  });

  it("ignores the fallback when the error has real text", () => {
    expect(describeError(new Error("Quote is already accepted"), "Could not update").message).toBe("Quote is already accepted");
  });
});
