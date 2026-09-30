/**
 * What can this customer actually pay with? — R-038 / S27 (Pardeep, 29 Sep 2026).
 *
 * The invoice PDF printed the fixed sentence "UPI / NEFT / Razorpay accepted" on every
 * document, whatever the tenant had set up. Two separate faults in one line:
 *
 *   1. **It offers NEFT and gives no account.** There is nowhere on the page to send a
 *      transfer to, so a B2B buyer who wants to pay by NEFT has to telephone and ask.
 *   2. **It names Razorpay whether or not Razorpay exists.** A tenant with no keys is
 *      telling its customers about a payment route that will not open — AGENTS.md §2,
 *      a failure presented as a plausible value.
 *
 * So the line is DERIVED, and when nothing is configured there is no line. Silence is
 * the honest output here: an invoice that says nothing about payment methods sends the
 * customer to the phone number in the header, which is a real answer. An invoice that
 * lists methods the seller has not set up sends them to a dead end and loses the money
 * for a week (§7 — never a dead end, and never a false one).
 *
 * The decision is here rather than in InvoicePDF for the reason `quote-document-kind`
 * gives: the renderer cannot see tenant secrets, and two copies of "is Razorpay on" is
 * how the footer and the QR block end up disagreeing.
 */

export interface RemittanceBank {
  bankName:      string | null;
  accountName:   string | null;
  accountNumber: string | null;
  ifsc:          string | null;
  branch:        string | null;
}

export interface PayMethodsInput {
  /** tenants.upi_vpa — set means a UPI QR is drawn and UPI is a real route. */
  upiVpa?:  string | null;
  /** The four remittance columns from the tenants row (migration 20260930170000). */
  bank?:    Partial<RemittanceBank> | null;
  /**
   * Resolved by the CALLER from tenant_secrets (razorpay_key_id + razorpay_key_secret)
   * or the deployment's own keys. Never guessed here — a renderer cannot read secrets,
   * and defaulting it true is exactly the bug this module exists to remove.
   */
  razorpayConfigured?: boolean;
}

export interface PayMethods {
  /** The methods sentence, or null when the tenant has configured none. */
  line: string | null;
  /** Rendered as its own block only when the account number is present. */
  bank: RemittanceBank | null;
  /** Individually useful for tests and for anything that wants just the flags. */
  hasUpi:      boolean;
  hasBank:     boolean;
  hasRazorpay: boolean;
}

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : null;
};

export function payMethods(input: PayMethodsInput): PayMethods {
  const hasUpi      = clean(input.upiVpa) !== null;
  const hasRazorpay = input.razorpayConfigured === true;

  /* An account NUMBER is what makes a transfer possible. A bank name and an IFSC with
     no account number is not a payment route, and printing it would look like one —
     so the bank block is all-or-nothing on that one field. */
  const accountNumber = clean(input.bank?.accountNumber);
  const ifsc          = clean(input.bank?.ifsc);
  const hasBank       = accountNumber !== null && ifsc !== null;

  const bank: RemittanceBank | null = hasBank
    ? {
        bankName:      clean(input.bank?.bankName),
        accountName:   clean(input.bank?.accountName),
        accountNumber,
        ifsc,
        branch:        clean(input.bank?.branch),
      }
    : null;

  const names: string[] = [];
  if (hasUpi) names.push("UPI");
  if (hasBank) names.push("NEFT / RTGS");
  if (hasRazorpay) names.push("Razorpay");

  return {
    line: names.length > 0 ? `${names.join(" / ")} accepted.` : null,
    bank,
    hasUpi,
    hasBank,
    hasRazorpay,
  };
}
