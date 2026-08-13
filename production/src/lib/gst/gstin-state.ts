/**
 * Derive the place of supply from a GSTIN.
 *
 * The first two characters of a GSTIN are the GST state code — 07 is Delhi, 27
 * Maharashtra, 29 Karnataka. So a customer who has given you their GSTIN has
 * already told you their state, whether or not anyone typed it into the state
 * field.
 *
 * WHY THIS MATTERS. `isInterStateSupply()` compares two state codes and, when
 * the customer's is missing, conservatively answers "intra-state" — CGST + SGST.
 * That default is right when nothing is known. It is wrong when the GSTIN on the
 * same record says the customer is in another state, because then the invoice
 * carries the wrong tax head: CGST+SGST where IGST was due. The total is the
 * same 18%, so nothing looks off on the invoice — it surfaces at GSTR-1 filing,
 * as a mismatch between what was charged and what the customer's return expects,
 * and it is the customer who cannot claim the credit.
 *
 * In production 36 of 41 customers carrying a GSTIN have no state code at all, so
 * this fallback is not hypothetical plumbing.
 *
 * THE SAFETY RULE: only a GSTIN that passes the full checksum is trusted. Reading
 * the first two characters of an unvalidated string is how a typo or seeded dummy
 * data ("8P…", "GU…") starts deciding tax heads.
 *
 * MEASURED BLAST RADIUS, which is why this was safe to wire in: of 49 production
 * customers exactly ONE holds a checksum-valid GSTIN, and enabling the fallback
 * changes ZERO tax heads. Nearly every GSTIN on file today is seeded junk and is
 * ignored. The behaviour starts mattering when real GSTINs arrive — which is the
 * right time for it to start mattering, and not before.
 *
 * Issued invoices are untouched regardless: `invoices.inter_state` freezes the
 * head at issue time (all 53 production invoices have it set) and a reprint must
 * say what the original said, whatever is learned about the customer later.
 */
import { isValidGstin, GST_STATE_BY_CODE } from "@/lib/utils";

/**
 * The GST state code encoded in a GSTIN, or null.
 *
 * Returns null unless the GSTIN is structurally valid AND its checksum passes
 * AND the prefix is a state code the GSTN actually issues. Anything less and the
 * caller keeps its existing conservative default, which is the correct outcome:
 * a guess about tax is worse than an admission of not knowing.
 */
export function stateCodeFromGstin(gstin: string | null | undefined): string | null {
  const g = gstin?.trim().toUpperCase();
  if (!g || !isValidGstin(g)) return null;
  const code = g.slice(0, 2);
  return code in GST_STATE_BY_CODE ? code : null;
}

/** The state name behind a GSTIN, for display. Null on the same rules as above. */
export function stateNameFromGstin(gstin: string | null | undefined): string | null {
  const code = stateCodeFromGstin(gstin);
  return code ? GST_STATE_BY_CODE[code] : null;
}

/**
 * Best available state code for a party: what was entered, else what their GSTIN
 * proves.
 *
 * An explicitly entered code ALWAYS wins, even when the GSTIN disagrees. Two
 * reasons, and the second is the important one:
 *
 *   1. Someone typed it deliberately, and a business can be registered in one
 *      state while the branch being billed sits in another.
 *   2. Silently overriding a human's entry with a derived value is how a system
 *      becomes impossible to correct. If the entered code is wrong, the operator
 *      needs to see it and fix it — not have the app quietly paper over it and
 *      leave the record saying one thing while the invoice says another.
 *
 * Use `gstinContradictsState()` to surface a disagreement instead of hiding it.
 */
export function resolveStateCode(party: {
  stateCode?: string | null;
  gstin?: string | null;
}): string | null {
  const explicit = party.stateCode?.trim();
  if (explicit) return explicit;
  return stateCodeFromGstin(party.gstin);
}

/**
 * True when a party's entered state code and their (valid) GSTIN point at
 * different states — a data-entry error worth showing someone, because whichever
 * is wrong, one of them is producing the wrong tax head on real invoices.
 * False whenever either side is unknown: silence, not a guess.
 */
export function gstinContradictsState(party: {
  stateCode?: string | null;
  gstin?: string | null;
}): boolean {
  const explicit = party.stateCode?.trim();
  const derived = stateCodeFromGstin(party.gstin);
  if (!explicit || !derived) return false;
  // Compare numerically so "7" and "07" are the same state, not a contradiction.
  return Number(explicit) !== Number(derived);
}
