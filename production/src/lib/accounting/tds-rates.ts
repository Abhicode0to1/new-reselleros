/**
 * TDS on a payment we make (26Q) — the default rate per section, so the amount fills itself
 * the moment a section is picked instead of sitting at ₹0.
 *
 * Rates for a resident payee with PAN, as they stand for FY 2026-27. Where a section has two
 * rates, the default is the common case for this business and the other is said beside it —
 * the operator can overwrite the amount, and the CA has the last word:
 *   194C contractor 2% (individual / HUF 1%) · 194J professional 10% (technical services 2%)
 *   194I rent of land / building 10% (plant & machinery 2%) · 194H commission 2% (since
 *   1 Oct 2024) · 194A interest 10% · 194Q purchase of goods 0.1% (on the part above ₹50L).
 *
 * TDS is on the value BEFORE GST when GST is shown separately on the bill (CBDT Circular
 * 23/2017) — so the base is the amount less the GST entered.
 */

export interface TdsSectionRate { section: string; ratePct: number; note: string | null }

export const TDS_SECTION_RATES: Readonly<Record<string, TdsSectionRate>> = {
  "194C": { section: "194C", ratePct: 2,   note: "Individual / HUF contractor ho to 1%." },
  "194J": { section: "194J", ratePct: 10,  note: "Technical services (professional nahi) ho to 2%." },
  "194I": { section: "194I", ratePct: 10,  note: "Plant / machinery ka kiraya ho to 2%." },
  "194H": { section: "194H", ratePct: 2,   note: null },
  "194A": { section: "194A", ratePct: 10,  note: null },
  "194Q": { section: "194Q", ratePct: 0.1, note: "Sirf ₹50 lakh se upar ki saal ki kharid par lagta hai." },
};

/** TDS base: the amount less the GST shown on the bill (never below 0). */
export function tdsBase(amount: number, gst: number): number {
  return Math.max(0, Math.round((amount || 0) - (gst || 0)));
}

/** The default TDS for a section on a base, whole rupees; null for an unknown section. */
export function defaultTds(section: string, base: number): number | null {
  const r = TDS_SECTION_RATES[section];
  if (!r) return null;
  return Math.round((Math.max(0, base) * r.ratePct) / 100);
}
