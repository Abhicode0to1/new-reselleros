/**
 * R-079 (Pardeep, 1 Oct 2026) — "Website se payment hote hi GST invoice apne aap bane."
 *
 * A website order that was PAID used to stop at `record_payment`: the quote said
 * "received", the customer said "won", and no tax invoice existed until somebody opened the
 * quote and clicked Issue. The order-confirmation email then promised "Your GST tax invoice
 * will reach you by email shortly" — a promise nothing kept.
 *
 * ─── NO NEW INVOICE PATH ─────────────────────────────────────────────────────
 * This calls `generate_invoice`, the same RPC the desk uses when a payment is recorded on
 * the Subscriptions screen and when Issue is clicked on a quote. Number, taxable value, tax,
 * rate, place of supply (CGST+SGST vs IGST) and the frozen advance snapshot all come from
 * that one function. Nothing here does GST arithmetic.
 *
 * Place of supply is what `generate_invoice` reads off the CUSTOMER `record_payment` just
 * created from the lead — so the checkout stores the buyer's state/GSTIN on the lead
 * (`cart-checkout.ts`), and an order with neither is REFUSED by the RPC (R-041: an unknown
 * place of supply is never guessed). That refusal is not an error here: the money is
 * already recorded, so it is written on the lead as a note that names the fix, and the
 * desk issues the invoice by hand once the state is added.
 *
 * ─── IDEMPOTENT ─────────────────────────────────────────────────────────────
 * Razorpay delivers `payment.captured` and `order.paid` for one payment, and retries either.
 * A quote that already has an invoice returns that invoice; two deliveries racing each other
 * are settled by the RPC itself (it locks the quote and raises unique_violation on the loser),
 * which is read back as "already issued", never as a second invoice.
 */
import type { createAdminClient } from "@/lib/supabase/server";

type Admin = ReturnType<typeof createAdminClient>;

export type OnlineInvoiceResult =
  | { status: "issued"; invoiceId: string }
  | { status: "exists"; invoiceId: string }
  | { status: "not_fully_paid" }
  | { status: "failed"; reason: string };

/**
 * Never throws: the payment is already recorded when this runs, so a failure here must cost
 * the invoice (logged, noted on the lead) and never the caller's response.
 */
export async function issueInvoiceForOnlinePayment(
  admin: Admin,
  args: { quoteId: string; tenantId: string; logTag: string },
): Promise<OnlineInvoiceResult> {
  try {
    return await issue(admin, args);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`${args.logTag} invoice for ${args.quoteId} threw: ${reason}`);
    return { status: "failed", reason };
  }
}

async function issue(
  admin: Admin,
  args: { quoteId: string; tenantId: string; logTag: string },
): Promise<OnlineInvoiceResult> {
  const { quoteId, tenantId, logTag } = args;

  const { data: q, error: qErr } = await admin
    .from("quotes")
    .select("id, invoice_id, payment_status, lead_id")
    .eq("id", quoteId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (qErr || !q) {
    const reason = qErr?.message ?? "quote not found";
    console.error(`${logTag} invoice: could not read ${quoteId} — ${reason}`);
    return { status: "failed", reason };
  }
  if (q.invoice_id) return { status: "exists", invoiceId: String(q.invoice_id) };

  /* Only a FULLY paid quote is invoiced here — the same rule the Subscriptions screen
     applies after record_payment ("the GST invoice is raised once the quote is fully
     paid"). A part payment stays a receipt voucher (advance), as it does at the desk. */
  if (q.payment_status !== "received") return { status: "not_fully_paid" };

  const { data, error } = await admin.rpc("generate_invoice", { p_quote_id: quoteId });
  if (error) {
    // The loser of a race between two deliveries: the winner's invoice is the answer.
    if (error.code === "23505") {
      const { data: again } = await admin
        .from("quotes").select("invoice_id").eq("id", quoteId).eq("tenant_id", tenantId).maybeSingle();
      if (again?.invoice_id) return { status: "exists", invoiceId: String(again.invoice_id) };
    }
    console.error(`${logTag} invoice NOT issued for ${quoteId}: ${error.message}`);
    if (q.lead_id) {
      await admin.from("lead_activities").insert({
        tenant_id: tenantId,
        lead_id: q.lead_id,
        kind: "note",
        detail:
          `Paid online, but the GST invoice could not be issued automatically — ${error.message} ` +
          `The payment is recorded. Fix the above, then open quote ${quoteId} and click Issue invoice.`,
      });
    }
    return { status: "failed", reason: error.message };
  }

  const row = Array.isArray(data) ? data[0] : data;
  const invoiceId = row && typeof row === "object" ? (row as { invoice_id?: string }).invoice_id : null;
  if (!invoiceId) {
    console.error(`${logTag} generate_invoice returned no invoice for ${quoteId}`);
    return { status: "failed", reason: "generate_invoice returned no result" };
  }
  console.info(`${logTag} GST invoice ${invoiceId} issued for paid ${quoteId}`);
  return { status: "issued", invoiceId };
}
