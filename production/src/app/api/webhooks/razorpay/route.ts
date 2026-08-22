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
import { loadOwnerAlert } from "@/lib/email/owner-alert.server";
import { decryptTenantSecrets } from "@/lib/crypto/tenant-secrets";
import { applyGatewayEvent, type MandateStatus } from "@/lib/payments/mandate";
import type { PaymentMandateInsertT as PaymentMandateInsert } from "@/lib/supabase/database.types";

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET?.trim() || "";
const FROM_EMAIL     = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";
const APP_URL        = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://resellersos.web.app";

/*
 * There is deliberately NO fallback recipient here any more.
 *
 * A `FALLBACK_OWNER_EMAIL = "Pardeep@exceltechnologies.in"` used to sit at this
 * line, reached via `seller.email?.trim() || FALLBACK_OWNER_EMAIL`. Its comment
 * argued it was better than "silently dropping" the alert. That reasoning does not
 * survive being written down: the alert was not dropped, it was DELIVERED — to a
 * third party, on a domain the company no longer uses (CLAUDE.md §1), carrying
 * another tenant's customer name, email, domain and amount. A misdirected alert is
 * worse than a missing one, because the missing one gets noticed.
 *
 * It also hid from the guard test. `lib/email/no-hardcoded-recipient.test.ts`
 * scans for a literal at `to:`; this one reached `to:` through a variable, so the
 * route looked clean while the other four looked guilty. Removing the constant is
 * what makes the guard true here, not just green.
 *
 * The payment itself is already committed by `record_payment` before this point,
 * so an unaddressable alert loses a notification and never the money. It is
 * logged loudly and counted in the response instead.
 */

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
    // Decrypt before use — an envelope string would never match the HMAC and the
    // failure would look like Razorpay sending bad signatures.
    const tsPlain = decryptTenantSecrets(ts);
    if (tsPlain?.razorpay_webhook_secret) signingSecret = tsPlain.razorpay_webhook_secret;
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

  /* ── Mandate lifecycle ────────────────────────────────────────────────────
     Handled BEFORE the payment filter below, because this is the only place in the
     whole system entitled to write `active` on a payment mandate. The signature has
     already been verified against THIS tenant's secret above; nothing downstream of
     that check can be forged. See lib/payments/mandate.ts. */
  if (event.startsWith("subscription.")) {
    return handleMandateEvent(admin, event, rawBody, tenantParam);
  }

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
  const { alert: owner, tenant: sellerTenant } = await loadOwnerAlert(admin, quote.tenant_id);
  const seller = sellerTenant ?? {};
  if (!owner.ok) {
    /* The payment IS recorded — record_payment committed above. Only the alert has
       nowhere to go, and that is said out loud rather than redirected. */
    console.error(`[webhooks/razorpay] payment ${paymentRef} recorded for tenant ${quote.tenant_id}, but no owner alert: ${owner.reason}`);
  }
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
    customerEmail && owner.ok && sendEmail({
      to:      customerEmail,
      from:    FROM_EMAIL,
      replyTo: owner.to,
      kind:    "razorpay_payment_customer",
      route:   { tenantId: quote.tenant_id },
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
    owner.ok && sendEmail({
      to:      owner.to,
      from:    FROM_EMAIL,
      kind:    "razorpay_payment_owner",
      route:   { tenantId: quote.tenant_id },
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

/**
 * A subscription.* event from Razorpay — the mandate lifecycle.
 *
 * ─── THIS FUNCTION IS THE ONLY WRITER OF `active` ───────────────────────────
 * "Autopay is on" means a bank will move money without anyone touching it. The app
 * has no path to that word; a signature-verified gateway event does. The signature
 * was checked against this tenant's own secret before we got here.
 *
 * ─── OUT-OF-ORDER DELIVERY IS ASSUMED, NOT HOPED AGAINST ────────────────────
 * Webhooks arrive late, twice, and in the wrong order. `applyGatewayEvent` refuses to
 * resurrect a cancelled mandate from a stale `subscription.charged`, and returns null
 * for a no-op so a duplicate delivery writes nothing at all.
 *
 * ─── AND IT RECORDS WHAT THE CUSTOMER APPROVED, NOT WHAT WE ASKED FOR ───────
 * `max_amount` is filled from the gateway's figure. Those are two different facts and
 * conflating them would hide a mandate approved for less than requested — which then
 * fails on the first debit that exceeds it.
 */
async function handleMandateEvent(
  admin: ReturnType<typeof createAdminClient>,
  event: string,
  rawBody: string,
  tenantParam: string | null,
): Promise<NextResponse> {
  let entity: { id?: string; status?: string; end_at?: number; plan_id?: string } | undefined;
  let planAmountPaise: number | undefined;
  try {
    const parsed = JSON.parse(rawBody) as {
      payload?: {
        subscription?: { entity?: typeof entity };
        plan?: { entity?: { item?: { amount?: number } } };
      };
    };
    entity = parsed.payload?.subscription?.entity;
    planAmountPaise = parsed.payload?.plan?.entity?.item?.amount;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const gatewaySubId = entity?.id;
  if (!gatewaySubId) {
    return NextResponse.json({ received: true, ignored: `${event} (no subscription id)` });
  }

  const { data: mandate } = await admin
    .from("payment_mandates")
    .select("id, tenant_id, status, requested_amount, max_amount")
    .eq("gateway_subscription_id", gatewaySubId)
    .maybeSingle();

  if (!mandate) {
    /* Not ours, or created before this table existed. Acknowledged so Razorpay stops
       retrying — a 4xx here would have it redeliver forever. */
    return NextResponse.json({ received: true, ignored: `${event} (unknown mandate)` });
  }

  /* Same defence the payment path uses: a signature valid for tenant A must not act
     on tenant B's mandate. */
  if (tenantParam && mandate.tenant_id !== tenantParam) {
    console.error("[webhooks/razorpay] mandate tenant mismatch", { tenantParam, mandateTenant: mandate.tenant_id });
    return NextResponse.json({ error: "Tenant mismatch" }, { status: 403 });
  }

  const next = applyGatewayEvent(mandate.status as MandateStatus, event);
  if (!next) {
    return NextResponse.json({ received: true, noChange: true, status: mandate.status });
  }

  /* Typed against the table rather than Record<string, unknown> — a loose bag would
     let a typo'd column name through the compiler and fail silently at runtime, on
     the one write that decides whether a bank may take money. */
  const patch: Partial<PaymentMandateInsert> = {
    status: next,
    status_note: `Razorpay ${event}`,
    updated_at: new Date().toISOString(),
  };
  if (next === "active") {
    patch.authorised_at = new Date().toISOString();
    /* What the customer actually approved. Falls back to what we requested only when
       the gateway did not send an amount — recorded either way so the headroom check
       has something real to work with. */
    patch.max_amount = planAmountPaise ? Math.round(planAmountPaise / 100) : mandate.max_amount ?? mandate.requested_amount;
  }
  if (next === "cancelled") patch.cancelled_at = new Date().toISOString();
  if (entity?.end_at) patch.end_date = new Date(entity.end_at * 1000).toISOString().slice(0, 10);

  const { error } = await admin.from("payment_mandates").update(patch).eq("id", mandate.id);
  if (error) {
    console.error("[webhooks/razorpay] mandate update failed:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  console.info(`[webhooks/razorpay] mandate ${mandate.id}: ${mandate.status} → ${next} (${event})`);
  return NextResponse.json({ received: true, mandate: mandate.id, status: next });
}
