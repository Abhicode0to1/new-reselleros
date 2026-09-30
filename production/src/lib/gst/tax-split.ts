/**
 * Intra-state tax → CGST + SGST. ONE rule for every screen, PDF and return.
 *
 * ─── WHY THIS FILE (WC-gst, 30 Sep 2026) ────────────────────────────────────
 * The same invoice was being split three different ways:
 *
 *   InvoicePDF / tax-invoice dialog   CGST = Math.round(tax / 2)
 *   GSTR-1 builder (gstr1.ts:55)      CGST = Math.trunc(tax / 2)
 *   prepaid page                      CGST = Math.floor(tax / 2)
 *
 * On an odd tax (₹181) the invoice said CGST ₹91 + SGST ₹90 and the return said CGST ₹90 +
 * SGST ₹91. The total matched, the heads did not — and the buyer's 2B is built from what
 * we FILE, so their CGST credit no longer matched the invoice in their hands.
 *
 * ─── THE RULE ───────────────────────────────────────────────────────────────
 *   CGST = round-half-up(|tax| / 2) at the precision the tax is in
 *   SGST = tax − CGST
 *
 * so CGST + SGST === tax, always, and the odd unit goes to CGST (the rule the invoice PDF
 * already printed — the documents customers hold are the reference, the return follows).
 *
 *   · Whole-rupee tax (every invoice — they are stored in whole ₹): exactly
 *     `Math.round(tax / 2)`. ₹181 → 91 + 90.
 *   · Tax with paise (an expense bill read from a PDF: ₹274.43): split at the paise, not
 *     the rupee — 137.22 + 137.21, not 137 + 137.43.
 *   · Negative tax (credit note, carried signed): the split is the mirror image of the
 *     positive one, so a note that reverses an invoice reverses the SAME heads.
 *     −181 → −91 + −90 (Math.round(−90.5) would give −90 and flip the odd rupee).
 */
export interface IntraStateSplit { cgst: number; sgst: number }

export function splitIntraStateTax(tax: number): IntraStateSplit {
  if (!Number.isFinite(tax) || tax === 0) return { cgst: 0, sgst: 0 };
  const sign = tax < 0 ? -1 : 1;
  const paise = Math.round(Math.abs(tax) * 100);
  let cgstPaise: number;
  if (paise % 100 === 0) {
    cgstPaise = Math.round(paise / 100 / 2) * 100;   // whole rupees → whole-rupee heads
  } else {
    cgstPaise = Math.round(paise / 2);
  }
  const sgstPaise = paise - cgstPaise;
  // `|| 0` turns −0 into 0 so a zero head never prints as "-0".
  return { cgst: (sign * cgstPaise) / 100 || 0, sgst: (sign * sgstPaise) / 100 || 0 };
}

/** Full three-head split: inter-state → all IGST; intra-state → {@link splitIntraStateTax}. */
export function splitTaxHeads(tax: number, interState: boolean): { igst: number; cgst: number; sgst: number } {
  if (interState) return { igst: tax, cgst: 0, sgst: 0 };
  return { igst: 0, ...splitIntraStateTax(tax) };
}
