/**
 * POST /api/public/quote/[id]/pay?t=<token>
 *
 * Customer-side "Pay online" from the public quote-accept page. Mirrors the
 * proven customer-portal invoice pay (`api/portal/invoice/[id]/pay`) and the
 * buy-page checkout: create a Razorpay Order with receipt = quote id, then the
 * existing `/api/webhooks/razorpay` handler settles it via `record_payment` on
 * capture (which converts the lead → customer + subscription for a first
 * payment — exactly what accepting-and-paying a quote should do).
 *
 * Auth = the unguessable ?t=<token> (same as the accept route). No login.
 * Never invents a parallel money path — settlement is record_payment via webhook.
 *
 * The guards, the amount and the order live in `lib/checkout/quote-order.ts`
 * (28 Sep 2026), shared with the DMS panel's renewal payment.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { quoteTokenMatches } from "@/lib/quotes/accept-token";
import { QUOTE_ORDER_COLUMNS, startQuotePayment } from "@/lib/checkout/quote-order";
import { simulatedPaymentAllowed } from "@/lib/checkout/live-guards";

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const admin = createAdminClient();

  // ── 1. Load + token-authorize (identical secrecy model to the accept route) ──
  const { data: quote, error: qErr } = await admin
    .from("quotes")
    .select(QUOTE_ORDER_COLUMNS)
    .eq("id", params.id)
    .maybeSingle();

  if (qErr || !quote) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }
  const token = request.nextUrl.searchParams.get("t");
  if (!quoteTokenMatches(token, quote.public_token)) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }

  const r = await startQuotePayment(admin, quote, {
    /* R-079: never on a production deployment — ALLOW_QUOTE_PAY_SIMULATION no longer
       overrides that. This page is also where a failed website payment's retry link lands. */
    allowSimulation: simulatedPaymentAllowed(),
    logTag: "[public/quote/pay]",
  });
  return NextResponse.json(r.body, { status: r.status });
}
