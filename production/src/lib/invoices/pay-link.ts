/**
 * A way for an overdue customer to actually pay — R-018 (Pardeep, 27 Sep 2026).
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * Every overdue reminder this app sends says one of:
 *
 *     "so here's the link again"
 *     "please pay using the link below"
 *
 * and `api/cron/invoice-dunning/route.ts` passed `payLink: null` on every single run,
 * so there was never a link. The customer reads a half-finished email from a company
 * chasing them for money, and the collection slows down — which is the opposite of what
 * the ladder exists to do. Nothing errored; the email sent perfectly.
 *
 * ─── UPI, AND WHY NOT A RAZORPAY LINK YET ───────────────────────────────────
 * `tenants.upi_vpa` has been on file since migration 0227 and already draws the QR on
 * the invoice PDF. The same VPA makes a `upi://pay` deep link, which opens GPay, PhonePe
 * or Paytm on a phone with the amount filled in — no gateway call, no state to keep, and
 * no fee.
 *
 * A Razorpay payment link would be nicer on a desktop, and `createAndSendPaymentLink`
 * exists. It is deliberately NOT used here, for a reason that is about this caller and
 * not about Razorpay: the dunning cron runs EVERY DAY against the same invoice. Minting
 * a link per run would leave one invoice with a fistful of live payment links and no
 * record of which is which, and the helper also sends its own email — so the customer
 * would get two. Doing it properly needs somewhere to store the link per invoice so the
 * second reminder reuses the first one's. That is a schema change and it is written up
 * on the board rather than smuggled in here.
 *
 * ─── AND THE COPY HAS TO STOP LYING EITHER WAY ──────────────────────────────
 * A tenant with no VPA still gets no link, and that is fine — what is not fine is the
 * sentence. `dunningMessage` now picks its wording from whether a link exists, so the
 * promise and the link cannot disagree again. That half is the one that is true for
 * every tenant on day one.
 */

export interface PayLinkInput {
  /** `tenants.upi_vpa` — e.g. "anutech@hdfcbank". Null when never configured. */
  upiVpa: string | null | undefined;
  /** `tenants.upi_payee_name`, falling back to the tenant name at the call site. */
  payeeName: string | null | undefined;
  /** ₹ outstanding, whole rupees (AGENTS.md §1). */
  amountDue: number;
  /** Shown in the payer's app so they can see what they are paying for. */
  invoiceId: string;
}

/**
 * A `upi://pay` link, or null when the tenant cannot be paid this way.
 *
 * Null is a real answer and the caller must render differently for it — never a
 * placeholder, and never a link to somewhere that cannot take money.
 */
export function upiPayLink(input: PayLinkInput): string | null {
  const vpa = (input.upiVpa ?? "").trim();
  /* A VPA is `handle@bank`. Anything without the @ is a half-filled settings field, and
     a malformed deep link opens an app that then says "invalid UPI ID" — worse than no
     link, because the customer believes they tried. */
  if (!vpa || !/^[\w.\-]{2,}@[\w.\-]{2,}$/.test(vpa)) return null;

  const amount = Math.round(input.amountDue ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const params = new URLSearchParams({
    pa: vpa,
    pn: (input.payeeName ?? "").trim() || "Payee",
    am: String(amount),
    cu: "INR",
    /* The note the payer sees, and what lands on the reseller's bank statement — which
       is what makes the receipt reconcilable later. */
    tn: `Invoice ${input.invoiceId}`,
  });
  return `upi://pay?${params.toString()}`;
}

/**
 * The sentence that offers the link — or the one that does not.
 *
 * Kept next to the builder on purpose: R-018 happened because the copy and the link
 * lived in two files and only one of them knew the truth.
 */
export function payInstruction(payLink: string | null | undefined): string {
  if (!payLink) {
    /* No link, so no "link below". It asks for the thing we actually want — a reply —
       rather than pointing at something that is not on the page. */
    return "\n\nReply to this email and we will send you payment details.";
  }
  if (payLink.startsWith("upi://")) {
    /* Say it is UPI and say it needs a phone. A upi:// link does nothing in a desktop
       browser, and a customer who clicks it there concludes the link is broken. */
    return `\n\nPay by UPI (open on your phone): ${payLink}`;
  }
  return `\n\nPay here: ${payLink}`;
}
