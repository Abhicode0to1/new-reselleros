import { resolveStateCode } from "./gstin-state";

/**
 * Place-of-supply → GST head (CGST+SGST vs IGST)
 *
 * Single source of truth for deciding whether a supply is intra-state
 * (CGST + SGST split) or inter-state (IGST). Previously this was computed
 * inconsistently across the codebase — correctly in the quote detail page,
 * but hardcoded (`false`, or seller="27") in the quote builder, the quote-send
 * PDF route, and the tax-invoice dialog. That produced the WRONG GST head on
 * tax invoices for inter-state customers (a compliance defect: the total 18%
 * was right, but the head was wrong, which breaks the buyer's ITC). Fixes
 * audit bugs #18/#19/#20.
 *
 * GST rule (IGST Act §7, CGST Act §8): the head is determined by comparing the
 * **place of supply** (the buyer's state) with the **location of the supplier**
 * (the seller's state). Same state → intra-state → CGST + SGST. Different state
 * → inter-state → IGST. The first two digits of a GSTIN are the state code
 * (e.g. 07 = Delhi, 27 = Maharashtra), which is why we compare `state_code`.
 *
 * Conservative default: if EITHER state code is missing we return `false`
 * (intra-state, CGST + SGST). This is the safe default for a same-state sale,
 * but it can be wrong for an inter-state customer when the seller's own
 * `state_code` hasn't been set up yet. Callers should ensure the tenant's GST
 * profile (state_code) is configured — see /setup — so the comparison is real.
 *
 * GSTIN FALLBACK (third argument). A party who gave you their GSTIN already told
 * you their state — it is the first two characters. In production 36 of 41
 * customers holding a GSTIN have no state_code, and every one of them was being
 * taxed as intra-state on that basis alone. Pass the GSTINs and a missing state
 * code is filled in from them.
 *
 * Only a checksum-valid GSTIN is used (see stateCodeFromGstin), so a typo or a
 * seeded dummy cannot start deciding tax heads, and an explicitly entered state
 * code always wins over a derived one. When neither source knows, the
 * conservative default above stands unchanged.
 */
export function isInterStateSupply(
  customerStateCode: string | null | undefined,
  sellerStateCode: string | null | undefined,
  gstins?: { customerGstin?: string | null; sellerGstin?: string | null },
): boolean {
  const buyer  = resolveStateCode({ stateCode: customerStateCode, gstin: gstins?.customerGstin });
  const seller = resolveStateCode({ stateCode: sellerStateCode,   gstin: gstins?.sellerGstin });
  // Compare numerically so "7" and "07" are one state — an entered code is
  // hand-typed and often unpadded, while a GSTIN-derived one always is padded.
  return Boolean(buyer && seller && Number(buyer) !== Number(seller));
}

/**
 * GST treatment of a supply, incl. exports (international customers).
 *
 * A supply to a recipient OUTSIDE India is an EXPORT — zero-rated (no
 * CGST/SGST/IGST) when the supplier has filed an LUT. A domestic supply is
 * intra-state (CGST + SGST) or inter-state (IGST) per the state comparison.
 */
export type GstTreatment = "export" | "inter_state" | "intra_state";

// Values that mean "India" (domestic). Anything else is treated as export.
const DOMESTIC_COUNTRIES = new Set(["india", "in", "ind", "bharat"]);

/**
 * True when the recipient is outside India → the supply is an export
 * (zero-rated under LUT). Conservative: an UNKNOWN/empty country is treated as
 * domestic (returns false), so we never accidentally zero-rate — and thus
 * under-charge GST on — a customer whose country simply wasn't captured.
 */
export function isExportSupply(customerCountry: string | null | undefined): boolean {
  const c = (customerCountry ?? "").trim().toLowerCase();
  if (c === "") return false;
  return !DOMESTIC_COUNTRIES.has(c);
}

/** Resolve the GST treatment. Export (outside India) wins over the state comparison. */
export function gstTreatment(
  customerCountry: string | null | undefined,
  customerStateCode: string | null | undefined,
  sellerStateCode: string | null | undefined,
): GstTreatment {
  if (isExportSupply(customerCountry)) return "export";
  return isInterStateSupply(customerStateCode, sellerStateCode) ? "inter_state" : "intra_state";
}
