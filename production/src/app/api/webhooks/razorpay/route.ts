/**
 * POST /api/webhooks/razorpay
 *
 * Razorpay webhook handler. Razorpay POSTs payment lifecycle events here
 * (configured in Razorpay dashboard → Settings → Webhooks).
 *
 * Events we care about:
 *   - `payment.captured`  — money actually moved into our settlement balance
 *   - `order.paid`        — Razorpay considers the order complete
 *   - `payment.failed`    — log so Pardeep can follow up
 *
 * For each successful capture, we:
 *   1. Verify the HMAC signature using RAZORPAY_WEBHOOK_SECRET (must be set!)
 *   2. Look up the quote via the order's `receipt` (we stored quote ID there)
 *   3. Call record_payment RPC — flips quote/lead/customer atomically
 *   4. Send order-confirmation email to the customer
 *
 * Security: this route is PUBLIC (no auth). Signature verification is the
 * ONLY thing that protects against forged payment events. If the secret
 * isn't set in env, we reject every request — fail closed.
 */
import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { createAdminClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email/send";

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET?.trim() || "";
const FROM_EMAIL     = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";
const APP_URL        = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://resellersos.web.app";

/**
 * Last-resort recipient for the "money received" alert. This used to be the
 * ONLY recipient, hard-coded — so in a multi-tenant product every tenant's
 * payment alert, carrying their customer's name, email and amount, was mailed
 * to one fixed address. The owner of the tenant that made the sale never got it,
 * and someone else did. The tenant's own email is used now; this remains only so
 * that a tenant with no email on file still produces an alert somewhere rather
 * than silently dropping it.
 */
const FALLBACK_OWNER_EMAIL = "Pardeep@exceltechnologies.in";

interface RazorpayPayment {
  id:         string;
  order_id:   string;
  amount:     number;            // paise
  currency:   string;
  status:     string;
  method:     string;
  email?:     string;
  contact?:   string;
  notes?:     Record<string, string>;
}

interface RazorpayOrder {
  id:         string;
  receipt:    string;             // We set this to the quote ID
  amount:     number;
  notes?:     Record<string, string>;
}

interface RazorpayWebhookBody {
  event:    string;
  payload:  {
    payment?: { entity: RazorpayPayment };
    order?:   { entity: RazorpayOrder };
  };
  created_at: number;
}

/** Verify Razorpay's HMAC SHA256 signature header against a given secret. */
function verifySignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!secret || !signature) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  // timingSafeEqual avoids leaking timing info to attackers
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  // Always read the raw body for signature verification BEFORE parsing JSON.
  const rawBody   = await request.text();
  const signature = request.headers.get("x-razorpay-signature");

  const admin = createAdminClient();

  // Resolve the signing secret. Razorpay is configured PER TENANT (the webhook
  // URL we hand out carries ?tenant=<id>), so verify against THAT tenant's
  // stored webhook secret. Fall back to a global env secret for legacy setups.
  const tenantParam = request.nextUrl.searchParams.get("tenant");
  let signingSecret = WEBHOOK_SECRET;
  if (tenantParam) {
    const { data: ts } = await admin
      .from("tenant_secrets")
      .select("razorpay_webhook_secret")
      .eq("tenant_id", tenantParam)
      .maybeSingle();
    if (ts?.razorpay_webhook_secret) signingSecret = ts.razorpay_webhook_secret;
  }

  if (!verifySignature(rawBody, signature, signingSecret)) {
    console.error("[webhooks/razorpay] signature verification FAILED", { tenant: tenantParam ?? "(none)", hadSecret: Boolean(signingSecret) });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: RazorpayWebhookBody;
  try {
    body = JSON.parse(rawBody) as RazorpayWebhookBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const event = body.event;
  console.log("[webhooks/razorpay] event:", event);

  // Only act on payment-success events — ignore failure / authorized / etc.
  // (We could log failed payments to a separate table for follow-up later.)
  if (event !== "payment.captured" && event !== "order.paid") {
    return NextResponse.json({ received: true, ignored: event });
  }

  const payment = body.payload.payment?.entity;
  const order   = body.payload.order?.entity;

  if (!payment && !order) {
    console.error("[webhooks/razorpay] no payment or order in payload");
    return NextResponse.json({ error: "No payment or order in payload" }, { status: 400 });
  }

  const orderId = payment?.order_id ?? order?.id;
  const receipt = order?.receipt ?? payment?.notes?.quoteId;
  const notes   = payment?.notes ?? order?.notes ?? {};

  if (!orderId || !receipt) {
    console.error("[webhooks/razorpay] missing orderId or receipt", { orderId, receipt });
    return NextResponse.json({ error: "Missing orderId or receipt" }, { status: 400 });
  }

  // ── Look up the quote we created at checkout time ─────────────────────
  const { data: quote, error: qErr } = await admin
    .from("quotes")
    .select("id, tenant_id, customer_name, amount, payment_status, lead_id, seats, plan, line_items")
    .eq("id", receipt)
    .single();

  if (qErr || !quote) {
    console.error("[webhooks/razorpay] quote not found:", receipt, qErr);
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }

  // Defense: the quote must belong to the tenant whose secret verified this
  // event (prevents a valid-for-tenant-A signature acting on tenant-B's quote).
  if (tenantParam && quote.tenant_id !== tenantParam) {
    console.error("[webhooks/razorpay] tenant mismatch", { tenantParam, quoteTenant: quote.tenant_id });
    return NextResponse.json({ error: "Tenant mismatch" }, { status: 403 });
  }

  // Idempotency — Razorpay can deliver the same event twice.
  if (quote.payment_status === "received") {
    console.log("[webhooks/razorpay] quote already marked paid:", receipt);
    return NextResponse.json({ received: true, alreadyProcessed: true });
  }

  // ── Call record_payment RPC — atomically:
  //   • mark quote as paid
  //   • flip lead stage to 'won'
  //   • upsert customer + subscription
  //   • roll forward renewal_date
  const paymentAmount = payment?.amount
    ? Math.round(payment.amount / 100)
    : (quote.amount ?? 0);
  // Razorpay's `method` values (card/upi/netbanking/wallet/emi) don't map 1:1
  // to our enum (upi/razorpay/bank_transfer/cheque/cash/other). UPI passes
  // through, everything else collapses to 'razorpay' so the RPC accepts it.
  const paymentMethod: "upi" | "razorpay" =
    payment?.method === "upi" ? "upi" : "razorpay";
  const paymentRef    = payment?.id ?? orderId;

  if (paymentAmount <= 0) {
    console.error("[webhooks/razorpay] zero/negative payment amount — refusing to record");
    return NextResponse.json({ error: "Invalid payment amount" }, { status: 400 });
  }

  const { error: rpcErr } = await admin.rpc("record_payment", {
    p_quote_id:  quote.id,
    p_amount:    paymentAmount,
    p_method:    paymentMethod,
    p_reference: paymentRef,
    p_notes:     `Razorpay ${event} · order ${orderId}`,
  });

  if (rpcErr) {
    console.error("[webhooks/razorpay] record_payment RPC failed:", rpcErr);
    return NextResponse.json({ error: "Payment processing failed", detail: rpcErr.message }, { status: 500 });
  }

  // ── Send confirmation emails (best-effort) ────────────────────────────
  // The alert goes to the tenant that made the sale — resolved from the quote's
  // own tenant_id, so it can never be another tenant's inbox.
  const { data: sellerTenant } = await admin
    .from("tenants")
    .select("name, email, phone, contact_name")
    .eq("id", quote.tenant_id)
    .maybeSingle();
  const seller = (sellerTenant ?? {}) as {
    name?: string | null; email?: string | null; phone?: string | null; contact_name?: string | null;
  };
  const ownerEmail   = seller.email?.trim() || FALLBACK_OWNER_EMAIL;
  const sellerName   = seller.name?.trim() || "your reseller";
  const sellerPerson = seller.contact_name?.trim() || sellerName;
  const sellerPhone  = seller.phone?.trim() || "";

  const customerEmail = payment?.email ?? notes.email ?? "";
  const customerName  = notes.contact ?? notes.customerName ?? "";
  const tierName      = notes.tierName ?? "Google Workspace";
  const seats         = notes.seats   ?? String(quote.seats ?? "");
  const domain        = notes.domain  ?? "";
  const amountFmt     = `₹${paymentAmount.toLocaleString("en-IN")}`;

  await Promise.allSettled([
    // Customer order confirmation
    customerEmail && sendEmail({
      to:      customerEmail,
      from:    FROM_EMAIL,
      replyTo: ownerEmail,
      subject: `Payment received · ${quote.id} · ${amountFmt}`,
      text:
`Hi ${customerName.split(" ")[0] || "there"},

Thanks for your purchase! Your payment of ${amountFmt} for ${seats} users of
${tierName} has been received.

ORDER SUMMARY
  Order ID    ${quote.id}
  Plan        ${tierName}
  Seats       ${seats}
  Domain      ${domain || "—"}
  Total paid  ${amountFmt} (incl 18% GST)

WHAT HAPPENS NEXT
  Within 4 hours  — ${sellerPerson} will contact you to verify the domain
  Within 24 hours — Your team is live on Google Workspace
  Day 7           — Health-check call to make sure everything's working

You'll receive a separate email with your GST tax invoice.${
  sellerPhone ? ` If you need anything before then, WhatsApp ${sellerPerson} on ${sellerPhone}.` : ""
}

— ${sellerPerson}
   ${sellerName}`,
    }),

    // Seller alert — money in the bank
    sendEmail({
      to:      ownerEmail,
      from:    FROM_EMAIL,
      subject: `💰 PAYMENT RECEIVED · ${quote.customer_name} · ${amountFmt}`,
      text:
`A direct-buy payment was just captured by Razorpay.

COMPANY     ${quote.customer_name}
CONTACT     ${customerName} <${customerEmail}>
PLAN        ${tierName}
SEATS       ${seats}
DOMAIN      ${domain || "—"}
TOTAL       ${amountFmt}
ORDER ID    ${quote.id}
RAZORPAY    ${paymentRef}
METHOD      ${paymentMethod}

ACTION REQUIRED
  1. Verify domain ownership (DNS TXT record)
  2. Create customer in Google Reseller Console
  3. Provision ${seats} licenses on ${domain || "the customer's domain"}
  4. Send admin credentials to ${customerEmail}

Open in app: ${APP_URL}/customers
Open quote:  ${APP_URL}/quotes/${quote.id}`,
    }),
  ]).then((results) => {
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error(`[webhooks/razorpay] email ${i === 0 ? "customer" : "Pardeep"} failed:`, r.reason);
      }
    });
  });

  return NextResponse.json({ received: true, quoteId: quote.id, paid: paymentAmount });
}
