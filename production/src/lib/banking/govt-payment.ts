/**
 * Is this money-out bank line a payment to the government — and which one?
 *
 * Challan payments carry fixed markers in the narration: HDFC writes an ESIC challan
 * as "01026130346651/ESIC" and a GST payment as "GST/BANK REFERENCE NO: …/CIN NO: …".
 * These are not expenses, so the reconcile screen must lead with the statutory / tax
 * booking, not "Book as a new expense".
 *
 * Only markers that do not occur in ordinary narrations: "ESIC", "EPFO", "ITNS 281".
 * Never a bare "PF" (it is inside words) or a bare "TAX" (it is in "TAXI").
 */

export type GovtPaymentKind = "esi" | "pf" | "tds" | "gst" | "income_tax";

export type GovtPayment = { kind: GovtPaymentKind; label: string };

const RULES: Array<[RegExp, GovtPayment]> = [
  [/\bESIC\b|\bESI ?CHALLAN\b|EMPLOYEES? STATE INSURANCE/i, { kind: "esi", label: "ESI challan (ESIC)" }],
  [/\bEPFO?\b|\bPROVIDENT ?FUND\b|\bPF ?CHALLAN\b|\bECR\b/i, { kind: "pf", label: "PF challan (EPFO)" }],
  // ITNS 281 is the TDS/TCS challan; 280 is income tax (advance / self-assessment).
  [/\bITNS ?281\b|\bTDS\b|\bTCS ?PAYMENT\b/i, { kind: "tds", label: "TDS challan" }],
  [/\bITNS ?280\b|\bADVANCE ?TAX\b|\bSELF ?ASSESSMENT ?TAX\b|\bINCOME ?TAX\b/i, { kind: "income_tax", label: "Income tax payment" }],
  [/^GST\/|\bGSTN\b|\bGST ?(?:PMT|PAYMENT|CHALLAN)\b|\bGST\b.*\bCIN\b/i, { kind: "gst", label: "GST payment" }],
];

export function detectGovtPayment(description: string | null | undefined): GovtPayment | null {
  const text = (description ?? "").trim();
  if (!text) return null;
  for (const [re, hit] of RULES) if (re.test(text)) return hit;
  return null;
}
