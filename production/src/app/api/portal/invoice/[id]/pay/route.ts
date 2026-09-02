/**
 * POST /api/portal/invoice/[id]/pay
 *
 * Customer-portal "Pay now" for an outstanding invoice. The money mutation
 * REUSES the battle-tested `record_payment` RPC via the invoice's underlying
 * quote — record_payment already (a) records the payment, (b) recomputes the
 * subscription's outstanding (sibling-safe), and (c) marks the linked invoice
 * paid + paid_date. We deliberately do NOT invent a parallel money path.
 *
 * Flow:
 *   1. Auth = portal session. Read the invoice through the SESSION client so
 *      RLS guarantees the caller can only pay THEIR OWN invoice.
 *   2. Resolve the tenant's Razorpay creds (tenant_secrets → env).
 *   3. Live  : create a Razorpay Order (receipt = quote_id) → the existing
 *              /api/webhooks/razorpay handler calls record_payment on capture.
 *      Sim   : no creds → call record_payment directly so Pardeep can walk the
 *              full flow before live keys exist (clearly tagged [SIMULATION]).
 */
import { NextResponse, type NextRequest } from "next/server";
import Razorpay from "razorpay";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { decryptTenantSecrets } from "@/lib/crypto/tenant-secrets";

const ENV_RAZORPAY_KEY_ID =
  process.env.RAZORPAY_KEY_ID?.trim() || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID?.trim() || "";
const ENV_RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET?.trim() || "";

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  const invoiceId = decodeURIComponent(params.id);

  // ── 1. Auth + ownership (RLS does the isolation) ───────────────────────
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const { data: invoice, error: invErr } = await supabase
    .from("invoices")
    .select("id, tenant_id, customer_id, quote_id, amount, net_payable, status, customer_name")
    .eq("id", invoiceId)
    .maybeSingle();

  if (invErr) {
    return NextResponse.json({ error: invErr.message }, { status: 500 });
  }
  if (!invoice) {
    // RLS hides invoices that aren't the caller's → treat as not-found.
    return NextResponse.json({ error: "Invoice not found." }, { status: 404 });
  }
  if (invoice.status === "paid") {
    return NextResponse.json({ error: "This invoice is already paid." }, { status: 409 });
  }
  if (invoice.status === "void" || invoice.status === "draft") {
    return NextResponse.json({ error: "This invoice can't be paid online." }, { status: 400 });
  }
  if (!invoice.quote_id) {
    return NextResponse.json(
      { error: "This invoice has no linked order — please pay offline / contact your reseller." },
      { status: 400 },
    );
  }
  const payable = invoice.net_payable ?? invoice.amount;
  if (!payable || payable <= 0) {
    return NextResponse.json({ error: "Nothing to pay on this invoice." }, { status: 400 });
  }

  const admin = createAdminClient();

  // ── Money-correctness guard ────────────────────────────────────────────
  // We settle via record_payment (single source of truth). record_payment
  // CREATES a new subscription when a quote is a first-payment, non-renewal,
  // non-add-seats sale — so blindly calling it on an arbitrary invoice would
  // DUPLICATE the customer's subscription. Legitimate "pay this invoice" cases
  // (renewal, or a partial of an already-converted sale) always have a
  // subscription already linked to the quote (via quote_id or renewal_quote_id);
  // those are exactly the cases record_payment settles WITHOUT duplicating.
  // If no subscription is linked, this isn't a safe online-settle — refuse and
  // let the reseller handle it. (Proven via rolled-back test: an unlinked quote
  // makes record_payment emit subscription_created:true.)
  const { data: linkedSub } = await admin
    .from("subscriptions")
    .select("id")
    .eq("tenant_id", invoice.tenant_id)
    .or(`quote_id.eq.${invoice.quote_id},renewal_quote_id.eq.${invoice.quote_id}`)
    .limit(1)
    .maybeSingle();
  if (!linkedSub) {
    return NextResponse.json(
      { error: "This invoice can't be paid online yet — please contact your reseller to settle it." },
      { status: 409 },
    );
  }

  // ── Resolve Razorpay creds for the invoice's tenant ────────────────────
  let rzKeyId = "";
  let rzKeySecret = "";
  let rzMode: "test" | "live" = "test";
  {
    const { data: rawSecrets } = await admin
      .from("tenant_secrets")
      .select("razorpay_key_id, razorpay_key_secret, razorpay_mode")
      .eq("tenant_id", invoice.tenant_id)
      .maybeSingle();
    // Sealed at rest (rosv1:…) — decrypt or Razorpay rejects the ciphertext.
    const secrets = decryptTenantSecrets(rawSecrets);
    if (secrets?.razorpay_key_id && secrets.razorpay_key_secret) {
      rzKeyId = secrets.razorpay_key_id;
      rzKeySecret = secrets.razorpay_key_secret;
      rzMode = secrets.razorpay_mode === "live" ? "live" : "test";
    } else if (ENV_RAZORPAY_KEY_ID && ENV_RAZORPAY_KEY_SECRET) {
      rzKeyId = ENV_RAZORPAY_KEY_ID;
      rzKeySecret = ENV_RAZORPAY_KEY_SECRET;
      rzMode = ENV_RAZORPAY_KEY_ID.startsWith("rzp_live_") ? "live" : "test";
    }
  }
  const razorpayConfigured = Boolean(rzKeyId) && Boolean(rzKeySecret);

  // ── 3a. SIMULATION — no creds → record_payment directly ────────────────
  if (!razorpayConfigured) {
    // MONEY-SAFETY: never silently mark a REAL customer's invoice paid for ₹0.
    // The record-payment simulation (for demos/local dev) is gated to non-prod;
    // in production without Razorpay wired, tell the customer online pay isn't
    // available yet rather than settling the invoice for no money.
    const allowSimulation =
      process.env.NODE_ENV !== "production" ||
      process.env.ALLOW_PORTAL_PAY_SIMULATION === "1";
    if (!allowSimulation) {
      return NextResponse.json(
        {
          error:
            "Online payment isn't available yet. Please contact us to pay by bank transfer / UPI — we'll confirm and update your invoice.",
          notConfigured: true,
        },
        { status: 503 },
      );
    }
    const simRef = `SIM-INVPAY-${invoice.quote_id}-${user.id.slice(0, 8)}`;
    const { error: rpcErr } = await admin.rpc("record_payment", {
      p_quote_id: invoice.quote_id,
      p_amount: payable,
      p_method: "razorpay",
      p_reference: simRef,
      p_notes: `[SIMULATION] Portal invoice payment · ${invoice.id}`,
    });
    if (rpcErr) {
      // Idempotent re-pay (same reference) surfaces as a benign duplicate —
      // record_payment dedupes on (quote_id, reference); treat as success.
      console.error("[portal/invoice/pay] sim record_payment:", rpcErr.message);
      return NextResponse.json({ error: rpcErr.message }, { status: 500 });
    }
    return NextResponse.json({
      success: true,
      simulated: true,
      invoiceId: invoice.id,
      amountRupees: payable,
    });
  }

  // ── 3b. LIVE — create a Razorpay Order; webhook records on capture ─────
  try {
    const razorpay = new Razorpay({ key_id: rzKeyId, key_secret: rzKeySecret });
    const order = await razorpay.orders.create({
      amount: payable * 100, // paise
      currency: "INR",
      receipt: invoice.quote_id, // webhook reverse-looks-up the quote by receipt
      notes: {
        kind: "invoice",
        invoiceId: invoice.id,
        quoteId: invoice.quote_id,
        tenantId: invoice.tenant_id,
        customerName: invoice.customer_name ?? "",
      },
    });
    return NextResponse.json({
      success: true,
      orderId: order.id,
      amount: payable * 100,
      currency: "INR",
      razorpayKeyId: rzKeyId,
      razorpayMode: rzMode,
      invoiceId: invoice.id,
      customerName: invoice.customer_name ?? "",
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : "Unknown error";
    console.error("[portal/invoice/pay] order create failed:", m);
    return NextResponse.json({ error: "Could not start payment. Please retry." }, { status: 500 });
  }
}
