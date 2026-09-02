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
 */
import { NextResponse, type NextRequest } from "next/server";
import Razorpay from "razorpay";
import { createAdminClient } from "@/lib/supabase/server";
import { decryptTenantSecrets } from "@/lib/crypto/tenant-secrets";
import { isQuoteExpired } from "@/lib/utils";
import { quoteTokenMatches } from "@/lib/quotes/accept-token";
import { quoteInstalments } from "@/lib/billing/instalments";
import { isQuoteAmountConsistent } from "@/lib/quotes/amounts";

const ENV_RAZORPAY_KEY_ID =
  process.env.RAZORPAY_KEY_ID?.trim() || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID?.trim() || "";
const ENV_RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET?.trim() || "";

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const admin = createAdminClient();

  // ── 1. Load + token-authorize (identical secrecy model to the accept route) ──
  const { data: quote, error: qErr } = await admin
    .from("quotes")
    .select("id, status, payment_status, expires_date, amount, currency, customer_name, tenant_id, public_token, invoice_id, billing_cycle, subtotal, discount_pct, tax_rate, created_date, line_items")
    .eq("id", params.id)
    .maybeSingle();

  if (qErr || !quote) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }
  const token = request.nextUrl.searchParams.get("t");
  if (!quoteTokenMatches(token, quote.public_token)) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }

  // ── 2. State guards ─────────────────────────────────────────────────────
  if (quote.status === "draft") {
    return NextResponse.json({ error: "This quote hasn't been sent yet." }, { status: 400 });
  }
  if (quote.status === "rejected") {
    return NextResponse.json({ error: "This quote was rejected — please contact the reseller." }, { status: 400 });
  }
  // Already settled — never let the customer pay twice.
  if (quote.invoice_id || quote.payment_status === "received" || quote.payment_status === "invoiced") {
    return NextResponse.json({ error: "This quote is already paid." }, { status: 409 });
  }
  if (isQuoteExpired(quote.expires_date)) {
    return NextResponse.json({ error: "This quote has expired — ask the reseller for a fresh one." }, { status: 400 });
  }
  // ── 2a. Split billing — charge the FIRST INSTALMENT, not the term ────────
  // A quarterly quote's own PDF prints "Per invoice (4/yr) ₹7,080/qtr" as its grand
  // total. Charging ₹28,320 here would take the whole year from a customer who was
  // shown a quarter, which is the difference between a billing cycle and a label.
  //
  // Derived from the same schedule engine the billing cron uses, so what is charged
  // and what is later invoiced come out of one place. Returns null for yearly, and
  // then everything below behaves exactly as it always has.
  const taxRate  = quote.tax_rate ?? 18;
  const subtotal = quote.subtotal ?? 0;

  /* ── 2aa. Refuse a quote whose own total disagrees with its own GST ──────────
     Everything below charges `quote.amount` and then invoices it. One production
     quote stores ₹45,360 where its 18% rate says ₹53,525 (Q-2026-9776 — migration
     20260817100000 never ran). Left open, this path would take ₹8,165 too LITTLE from
     the customer and then issue a tax invoice for the short amount, which is the worst
     of the three possible outcomes: the company loses the GST, the customer holds an
     invoice that understates their input credit, and neither number can be edited
     afterwards. Failing the payment is recoverable; a wrong tax invoice is not.
     Measured 21 Aug 2026: 26 of 27 production quotes pass this, so nothing legitimate
     is blocked. Wording stays customer-facing — the arithmetic is the reseller's
     problem, not the buyer's. */
  if (!isQuoteAmountConsistent(subtotal, taxRate, quote.amount ?? 0)) {
    return NextResponse.json(
      {
        error: "This quote's total needs to be corrected before it can be paid.",
        nextStep: "Please ask the reseller to re-send it — the GST on it does not add up, and paying now would leave you with an invoice that understates the tax.",
      },
      { status: 409 },
    );
  }

  const instalments = quoteInstalments({
    cycle:       quote.billing_cycle,
    // Same taxable value generate_invoice computes — subtotal net of discount.
    termTaxable: subtotal - Math.round(subtotal * (quote.discount_pct ?? 0) / 100),
    termGross:   quote.amount ?? 0,
    taxRate,
    // Flex (pehli line commitment=monthly): stored aankde per-month hain — engine null dega
    // aur neeche amountInr seedha quote.amount (mahine ki poori vasooli) banega. Iske bina
    // flex par 12× under-charge thi (audit B9-deep, 1 Sep 2026).
    lineCommitment: (Array.isArray(quote.line_items) ? (quote.line_items[0] as { commitment?: string } | undefined)?.commitment : null) ?? null,
  });

  /* A split-billed quote is paid ONCE here — the first instalment. Everything after
     it is collected against the instalment INVOICES the billing cron raises. Without
     this the customer could come back to the same link and pay another instalment
     against the quote, money that no invoice would ever be matched to. The guard
     above only catches 'received'/'invoiced'; a split-billed quote sits at 'partial'
     for the rest of its term. */
  if (instalments && quote.payment_status === "partial") {
    return NextResponse.json(
      {
        error: `The first ${instalments.cycle === "monthly" ? "month" : "instalment"} on this quote is already paid.`,
        nextStep: "The rest is invoiced one period at a time — pay those from the invoice you receive on each billing date.",
      },
      { status: 409 },
    );
  }

  const amountInr = instalments ? instalments.firstGross : (quote.amount ?? 0);
  if (amountInr <= 0) {
    return NextResponse.json({ error: "Nothing to pay on this quote." }, { status: 400 });
  }
  // Razorpay (Indian account) charges INR. A foreign-currency quote shows a
  // non-₹ total to the customer, so charging ₹ here would mismatch what they
  // see — route those to offline settlement instead.
  const isForeign = !!quote.currency && quote.currency.toUpperCase() !== "INR";
  if (isForeign) {
    return NextResponse.json(
      { error: "Online payment is available for ₹ invoices only — please contact the reseller to pay.", notConfigured: true },
      { status: 400 },
    );
  }

  // ── 3. Resolve the tenant's Razorpay creds (tenant_secrets → env) ────────
  let rzKeyId = "";
  let rzKeySecret = "";
  let rzMode: "test" | "live" = "test";
  {
    const { data: rawSecrets } = await admin
      .from("tenant_secrets")
      .select("razorpay_key_id, razorpay_key_secret, razorpay_mode")
      .eq("tenant_id", quote.tenant_id)
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

  // ── 3a. SIMULATION (no creds) — record_payment directly, gated to non-prod ─
  // record_payment on a first-payment quote converts the lead → customer +
  // subscription (the intended accept-and-pay outcome). Never settle a REAL
  // quote for ₹0 in production without keys.
  if (!razorpayConfigured) {
    const allowSimulation =
      process.env.NODE_ENV !== "production" || process.env.ALLOW_QUOTE_PAY_SIMULATION === "1";
    if (!allowSimulation) {
      return NextResponse.json(
        {
          error: "Online payment isn't available yet — please contact the reseller to pay by bank transfer / UPI.",
          notConfigured: true,
        },
        { status: 503 },
      );
    }
    const simRef = `SIM-QUOTEPAY-${quote.id}`;
    const { error: rpcErr } = await admin.rpc("record_payment", {
      p_quote_id: quote.id,
      p_amount: amountInr,
      p_method: "razorpay",
      p_reference: simRef,
      p_notes: instalments
        ? `[SIMULATION] Quote online payment · ${quote.id} · instalment 1 of ${instalments.count}`
        : `[SIMULATION] Quote online payment · ${quote.id}`,
    });
    if (rpcErr) {
      console.error("[public/quote/pay] sim record_payment:", rpcErr.message);
      return NextResponse.json({ error: rpcErr.message }, { status: 500 });
    }
    return NextResponse.json({
      success: true, simulated: true, quoteId: quote.id, amountRupees: amountInr,
      instalmentOf: instalments?.count ?? null,
    });
  }

  // ── 3b. LIVE — create a Razorpay Order; the webhook records on capture ────
  try {
    const razorpay = new Razorpay({ key_id: rzKeyId, key_secret: rzKeySecret });
    const order = await razorpay.orders.create({
      amount: amountInr * 100, // paise
      currency: "INR",
      receipt: quote.id, // webhook reverse-looks-up the quote by receipt
      notes: {
        kind: "quote",
        quoteId: quote.id,
        tenantId: quote.tenant_id,
        customerName: quote.customer_name ?? "",
        /* So a ₹2,360 capture against a ₹28,320 quote is self-explaining in the
           gateway dashboard rather than looking like an underpayment. */
        ...(instalments ? { instalment: `1 of ${instalments.count}`, cycle: instalments.cycle } : {}),
      },
    });
    return NextResponse.json({
      success: true,
      orderId: order.id,
      amount: amountInr * 100,
      currency: "INR",
      razorpayKeyId: rzKeyId,
      razorpayMode: rzMode,
      quoteId: quote.id,
      customerName: quote.customer_name ?? "",
      instalmentOf: instalments?.count ?? null,
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : "Unknown error";
    console.error("[public/quote/pay] order create failed:", m);
    return NextResponse.json({ error: "Could not start payment. Please retry." }, { status: 500 });
  }
}
