import { describe, it, expect } from "vitest";
import { resolveSecretField, buildSecretPatch } from "./secret-field";

/**
 * Every branch here either preserves or destroys a live credential, so each one
 * has a test naming the consequence rather than just the input.
 */

describe("the bug: an untouched field must never wipe a stored secret", () => {
  it("keeps the stored value when the form sent nothing", () => {
    // Opening the dialog to check the mode and pressing Save must not write NULL
    // over the webhook secret. That produced the critical collect-without-reconcile
    // state: Razorpay keeps taking payments and the app never learns.
    for (const incoming of [undefined, null, "", "   "]) {
      expect(resolveSecretField({ incoming, hasExisting: true }), String(incoming))
        .toEqual({ action: "keep" });
    }
  });

  it("keeps it whether or not the field is required", () => {
    expect(resolveSecretField({ incoming: "", hasExisting: true, required: true }))
      .toEqual({ action: "keep" });
  });

  it("omits an unchanged field from the patch entirely, rather than setting null", () => {
    // Present-as-null is the shape that caused the bug. Absent is the fix.
    const { patch, unchanged } = buildSecretPatch({
      razorpay_webhook_secret: { incoming: "", hasExisting: true },
    });
    expect(patch).toEqual({});
    expect("razorpay_webhook_secret" in patch).toBe(false);
    expect(unchanged).toContain("razorpay_webhook_secret");
  });
});

describe("first-time setup still demands a value", () => {
  it("errors when a required field is blank and nothing is stored", () => {
    const r = resolveSecretField({ incoming: "", hasExisting: false, required: true, label: "Key secret" });
    expect(r).toEqual({ action: "error", reason: "Key secret is required." });
  });

  it("is silent when an optional field is blank and nothing is stored", () => {
    expect(resolveSecretField({ incoming: "", hasExisting: false })).toEqual({ action: "keep" });
  });

  it("writes a value that was actually typed", () => {
    expect(resolveSecretField({ incoming: "  s3cr3t-value-here  ", hasExisting: false }))
      .toEqual({ action: "write", value: "s3cr3t-value-here" });
  });

  it("overwrites an existing value when a new one is typed", () => {
    expect(resolveSecretField({ incoming: "brand-new-secret", hasExisting: true }))
      .toEqual({ action: "write", value: "brand-new-secret" });
  });
});

describe("removing a secret has to be asked for", () => {
  it("clears only on the explicit flag, never on a blank box", () => {
    expect(resolveSecretField({ incoming: "", hasExisting: true, clear: true }))
      .toEqual({ action: "clear" });
    expect(resolveSecretField({ incoming: "", hasExisting: true }))
      .toEqual({ action: "keep" });
  });

  it("refuses to clear a field the integration cannot work without", () => {
    // Otherwise the UI could ask the server to break the integration and it would
    // comply.
    const r = resolveSecretField({ incoming: "", hasExisting: true, clear: true, required: true, label: "Key secret" });
    expect(r.action).toBe("error");
    expect((r as { reason: string }).reason).toMatch(/cannot be removed/i);
  });

  it("writes null for a cleared optional field", () => {
    const { patch } = buildSecretPatch({
      razorpay_webhook_secret: { incoming: "", hasExisting: true, clear: true },
    });
    expect(patch).toEqual({ razorpay_webhook_secret: null });
  });
});

describe("a truncated paste is refused rather than saved", () => {
  it("errors on a value shorter than the minimum", () => {
    // Writing a half-pasted secret breaks the integration while the save reports
    // success -- which is the worst of both.
    const r = resolveSecretField({ incoming: "abc", hasExisting: true, minLength: 10, label: "Key secret" });
    expect(r.action).toBe("error");
    expect((r as { reason: string }).reason).toMatch(/too short \(3 characters/);
  });

  it("accepts exactly the minimum", () => {
    expect(resolveSecretField({ incoming: "0123456789", hasExisting: false, minLength: 10 }))
      .toEqual({ action: "write", value: "0123456789" });
  });

  it("does not apply the minimum to an untouched field", () => {
    // The stored value is already whatever it is; not typing must not re-validate it.
    expect(resolveSecretField({ incoming: "", hasExisting: true, minLength: 50 }))
      .toEqual({ action: "keep" });
  });
});

describe("buildSecretPatch", () => {
  it("handles the real Razorpay save: key retyped, webhook left alone", () => {
    const { patch, errors, unchanged } = buildSecretPatch({
      razorpay_key_secret:     { incoming: "new-key-secret-value", hasExisting: true, required: true, minLength: 10 },
      razorpay_webhook_secret: { incoming: "",                     hasExisting: true },
    });
    expect(errors).toEqual([]);
    expect(patch).toEqual({ razorpay_key_secret: "new-key-secret-value" });
    expect(unchanged).toEqual(["razorpay_webhook_secret"]);
  });

  it("handles the seal-only save: nothing retyped at all", () => {
    // After migration to envelope encryption, pressing Save with both boxes empty
    // must be a no-op on the secret columns, not a wipe of both.
    const { patch, errors } = buildSecretPatch({
      razorpay_key_secret:     { incoming: "", hasExisting: true, required: true },
      razorpay_webhook_secret: { incoming: "", hasExisting: true },
    });
    expect(errors).toEqual([]);
    expect(patch).toEqual({});
  });

  it("collects every error rather than stopping at the first", () => {
    const { errors } = buildSecretPatch({
      a: { incoming: "", hasExisting: false, required: true, label: "A" },
      b: { incoming: "xx", hasExisting: false, minLength: 10, label: "B" },
    });
    expect(errors).toHaveLength(2);
  });

  it("reports errors and writes nothing that the caller could apply by mistake", () => {
    const { patch, errors } = buildSecretPatch({
      good: { incoming: "a-good-long-value", hasExisting: false },
      bad:  { incoming: "", hasExisting: false, required: true, label: "Bad" },
    });
    expect(errors).toHaveLength(1);
    // The caller MUST check errors before applying; the patch is only meaningful
    // when errors is empty.
    expect(patch).toEqual({ good: "a-good-long-value" });
  });

  it("handles an empty field set", () => {
    expect(buildSecretPatch({})).toEqual({ patch: {}, errors: [], unchanged: [] });
  });
});
