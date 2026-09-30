import { describe, it, expect } from "vitest";
import { SAAS_HSN, SAAS_GST_RATE, SAAS_HSN_LABEL, SAC_REVIEW, hsnSummary } from "./hsn";

describe("the SaaS SAC code", () => {
  it("is 998313 at 18%", () => {
    expect(SAAS_HSN).toBe("998313");
    expect(SAAS_GST_RATE).toBe(18);
  });
});

/**
 * The rate is the same 18% either way; the HEAD is what differs, and a wrong head is
 * invisible on the invoice — it surfaces at GSTR-1 filing as the customer's input credit
 * failing to match. So the summary always names it.
 */
describe("the head shown beside it", () => {
  it("splits the rate for an intra-state supply", () => {
    expect(hsnSummary(false)).toBe("HSN/SAC 998313 · CGST 9% + SGST 9%");
  });

  it("keeps it whole for an inter-state supply", () => {
    expect(hsnSummary(true)).toBe("HSN/SAC 998313 · IGST 18%");
  });

  it("says the head is UNKNOWN rather than guessing the common one", () => {
    /* Defaulting to CGST+SGST is exactly how the wrong head reached live invoices before
       lib/gst/gstin-state.ts started refusing to infer one. */
    const s = hsnSummary(null);
    expect(s).toContain("998313");
    expect(s).toMatch(/decided by the customer's state/i);
    expect(s).not.toMatch(/CGST|IGST/);
  });
});

/**
 * WC-gst (30 Sep 2026): 998313 is "IT consulting and support services" in the SAC scheme,
 * not "online information & database access". The label is what GSTR-1 Table 12 prints,
 * so it was fixed. The CODE was deliberately left alone (issued invoices carry it); the
 * question of 997331 / 998315 is recorded for a CA, not decided by a deploy.
 */
describe("SAC 998313 label and the open classification question", () => {
  it("labels 998313 with its real SAC description", () => {
    expect(SAAS_HSN_LABEL).toBe("Information technology (IT) consulting and support services");
    expect(SAAS_HSN_LABEL).not.toMatch(/online information|database access/i);
  });

  it("does NOT silently change the code on existing data", () => {
    expect(SAAS_HSN).toBe("998313");
    expect(SAC_REVIEW.current).toBe(SAAS_HSN);
  });

  it("records the alternatives for CA confirmation", () => {
    expect(Object.keys(SAC_REVIEW.alternatives).sort()).toEqual(["997331", "998315"]);
    expect(SAC_REVIEW.note).toMatch(/CA/);
  });
});
