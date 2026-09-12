/**
 * POST /api/portal/checkout/hosting
 *
 * "Buy hosting" for a customer who is already signed into the portal.
 * Pardeep, 12 Sep 2026: "Put hosting in the portal shop, so a logged-in customer
 * can buy without going back to the marketing site."
 *
 * ─── WHY NOT JUST CALL /api/public/checkout/cart ────────────────────────────
 * That route exists and already sells hosting, so reusing it was the obvious
 * move. It cannot be reused, for three reasons that are all about WHO is buying:
 *
 *   1. It posts every order to `BUY_PAGE_TENANT_ID` — the marketing site's own
 *      tenant. A portal customer belongs to THEIR reseller, and filing their
 *      order under Anutech's tenant would put the sale, the invoice and the
 *      money on the wrong books.
 *   2. It prices from `HOSTING_TIERS`, a constant holding Anutech Digital's
 *      retail card. Honest on a site that only ever sells for one tenant; wrong
 *      here, where the portal serves every reseller's customers.
 *   3. It creates a LEAD and sets `customer_id: null`, because a website visitor
 *      is a prospect. This buyer is an existing customer with an id, and an
 *      order that does not carry it is an order their own portal cannot show.
 *
 * ─── MONEY SAFETY ───────────────────────────────────────────────────────────
 * The body carries an item id and a domain. It carries NO price — the plan is
 * re-read from `items` server-side, scoped to the tenant on the session cookie,
 * so a customer cannot buy their reseller's ₹999 plan for ₹1 by editing a
 * request, and cannot reach another tenant's catalogue by guessing an id.
 * Whole rupees throughout (CLAUDE.md §13).
 *
 * ─── WHAT HAPPENS AFTER THE PAYMENT ─────────────────────────────────────────
 * Nothing here activates anything. The quote is written `payment_status:
 * 'awaiting'` and Razorpay's webhook does the rest — `record_payment` flips the
 * quote, creates the subscription and invoice, then `decideProvisioning` queues
 * a `provisioning_requests` row that /api/cron/provision-hosting turns into a
 * real cPanel account. That contract is what the two fields below are for:
 *
 *   · `receipt` MUST be the quote id — the webhook reverse-looks-up by it.
 *   · order `notes.domain` MUST carry the domain — the webhook reads the domain
 *     to provision from the NOTES, not from the quote.
 *
 * The line item also carries `item_id`, which is how `vendorForQuote` resolves
 * this as hosting. Without it the webhook falls back to sniffing the word
 * "hosting" out of the plan label — which works, but only by luck of naming.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import Razorpay from "razorpay";
import { createAdminClient } from "@/lib/supabase/server";
import { getPortalSession } from "@/lib/portal/session";
import { decryptTenantSecrets } from "@/lib/crypto/tenant-secrets";
import { cleanDomain } from "@/lib/customers/card-fields";
import { hostingOrderTotals, hostingPlanLabel, hostingLineItem } from "@/lib/portal/hosting-order";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ENV_RAZORPAY_KEY_ID =
  process.env.RAZORPAY_KEY_ID?.trim() || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID?.trim() || "";
const ENV_RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET?.trim() || "";

const bodySchema = z.object({
  itemId: z.string().min(1).max(120),
  domain: z.string().min(3).max(120),
  simulate: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  // ── 1. Who is buying — from the cookie, never from the body ─────────────
  const session = await getPortalSession();
  if (!session) {
    return NextResponse.json({ error: "Please sign in again to buy." }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request: " + parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 },
    );
  }
  const { itemId, simulate } = parsed.data;

  /* Bare, lower-cased, no scheme or path. Returns null on anything that is not
     shaped like a domain — which is a refusal, because this string becomes the
     cPanel account's name and cannot be fixed after provisioning. */
  const domain = cleanDomain(parsed.data.domain);
  if (!domain) {
    return NextResponse.json(
      { error: "That doesn't look like a domain. Enter it like example.com — no http:// and no trailing path." },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  // ── 2. The price, re-read from the reseller's own catalogue ─────────────
  const { data: plan, error: planErr } = await admin
    .from("items")
    .select("id, name, msrp, hsn, vendor, is_active, synced_from_partner_id")
    .eq("id", itemId)
    .eq("tenant_id", session.tenantId)   // the tenant on the session, not the body
    .eq("vendor", "hosting")
    .eq("is_active", true)
    .maybeSingle();

  if (planErr) {
    console.error("[portal/checkout/hosting] plan lookup:", planErr.message);
    return NextResponse.json({ error: "Couldn't read the plan. Please retry." }, { status: 500 });
  }
  if (!plan) {
    /* Also the answer when the id belongs to another tenant — same response for
       "no such plan" and "not yours", so this cannot be used to probe another
       reseller's catalogue. */
    return NextResponse.json({ error: "That plan isn't available." }, { status: 404 });
  }

  const rate = Math.max(0, Math.round(Number(plan.msrp ?? 0)));
  if (rate <= 0) {
    return NextResponse.json(
      { error: "This plan has no price set. Please contact us and we'll sort it out." },
      { status: 409 },
    );
  }

  /* Money and the webhook hand-off both live in lib/portal/hosting-order.ts,
     where they are tested without a database. */
  const { subtotal, amount, taxRate } = hostingOrderTotals(rate);

  // ── 3. Is this domain already hosted here? ─────────────────────────────
  /* Provisioning derives the cPanel username from the domain deterministically
     (`genUsername`), so a second account on the same domain collides with the
     first. Better to say so before taking money than to take it and fail in the
     worker an hour later. */
  const { data: existing } = await admin
    .from("hosting_accounts")
    .select("id, status")
    .eq("tenant_id", session.tenantId)
    .eq("domain_name", domain)
    .maybeSingle();
  if (existing) {
    return NextResponse.json(
      {
        error: `${domain} already has a hosting account with us. Open it from your Hosting page to change its plan.`,
        alreadyHosted: true,
      },
      { status: 409 },
    );
  }

  // ── 4. Razorpay credentials for THIS reseller ──────────────────────────
  let rzKeyId = "";
  let rzKeySecret = "";
  let rzMode: "test" | "live" = "test";
  {
    const { data: rawSecrets } = await admin
      .from("tenant_secrets")
      .select("razorpay_key_id, razorpay_key_secret, razorpay_mode")
      .eq("tenant_id", session.tenantId)
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

  const isSimulation = simulate === true;
  /* Same gate as the portal's invoice "Pay now": a simulation settles a real
     customer's order for ₹0, so it may only ever run off production. */
  const simulationAllowed =
    process.env.NODE_ENV !== "production" || process.env.ALLOW_PORTAL_PAY_SIMULATION === "1";

  if (!razorpayConfigured && !isSimulation) {
    return NextResponse.json(
      {
        error: `Online payment isn't set up yet. Please contact ${session.tenantName} to pay by UPI or bank transfer.`,
        notConfigured: true,
      },
      { status: 503 },
    );
  }
  if (razorpayConfigured && isSimulation) {
    return NextResponse.json({ error: "Simulation is disabled once payment is live." }, { status: 400 });
  }
  if (isSimulation && !simulationAllowed) {
    return NextResponse.json({ error: "Online payment isn't available yet." }, { status: 503 });
  }

  // ── 5. The quote this order is answered by ─────────────────────────────
  const { data: qid, error: numErr } = await admin.rpc("next_document_number", {
    p_doc_type: "quote",
    p_tenant_id: session.tenantId,
  });
  if (numErr || !qid) {
    console.error("[portal/checkout/hosting] next_document_number:", numErr?.message);
    return NextResponse.json({ error: "Couldn't start checkout. Please retry." }, { status: 500 });
  }
  const quoteId = qid as string;

  const lineItems = [
    hostingLineItem({ quoteId, itemId: plan.id, planName: plan.name, domain, rate: subtotal }),
  ];
  const planLabel = hostingPlanLabel(plan.synced_from_partner_id || plan.id);

  const today = new Date();
  const expires = new Date(today);
  expires.setDate(expires.getDate() + 7);

  const { error: qErr } = await admin.from("quotes").insert({
    id: quoteId,
    tenant_id: session.tenantId,
    customer_id: session.customerId,          // a real customer, unlike the public cart
    customer_name: session.customerName,
    lead_id: null,
    plan: planLabel,
    seats: 1,
    line_items: lineItems,
    subtotal,
    total_cost: 0,
    discount_pct: 0,
    tax_rate: taxRate,
    amount,
    status: "sent",
    payment_status: "awaiting",
    owner_id: null,
    domain,
    created_date: today.toISOString().slice(0, 10),
    expires_date: expires.toISOString().slice(0, 10),
    notes: `Portal self-serve hosting order · ${plan.name} on ${domain}`,
  });
  if (qErr) {
    console.error("[portal/checkout/hosting] quote insert:", qErr.message);
    return NextResponse.json({ error: "Couldn't save your order. Please retry." }, { status: 500 });
  }

  // ── 6a. SIMULATION — record the payment directly (never in production) ──
  if (isSimulation) {
    const { error: recErr } = await admin.rpc("record_payment", {
      p_quote_id: quoteId,
      p_amount: amount,
      p_method: "razorpay",
      p_reference: "SIM-HOST-" + quoteId,
      p_notes: `[SIMULATION] Portal hosting order · ${plan.name} on ${domain}`,
    });
    if (recErr) {
      console.error("[portal/checkout/hosting] sim record_payment:", recErr.message);
      return NextResponse.json({ error: recErr.message }, { status: 500 });
    }
    return NextResponse.json({
      success: true,
      simulated: true,
      quoteId,
      domain,
      planName: plan.name,
      totalRupees: amount,
    });
  }

  // ── 6b. LIVE — the order; the webhook does everything after this ────────
  try {
    const razorpay = new Razorpay({ key_id: rzKeyId, key_secret: rzKeySecret });
    const order = await razorpay.orders.create({
      amount: amount * 100, // paise
      currency: "INR",
      receipt: quoteId,     // the webhook reverse-looks-up the quote by this
      notes: {
        kind: "portal-hosting",
        quoteId,
        tenantId: session.tenantId,
        customerId: session.customerId,
        customerName: session.customerName,
        email: session.userEmail,
        plan: planLabel,
        domain,             // the webhook provisions against THIS, not the quote
      },
    });
    await admin.from("quotes").update({ payment_reference: order.id }).eq("id", quoteId);

    return NextResponse.json({
      success: true,
      orderId: order.id,
      amount: amount * 100,
      currency: "INR",
      razorpayKeyId: rzKeyId,
      razorpayMode: rzMode,
      quoteId,
      domain,
      planName: plan.name,
      customerName: session.customerName,
      totalRupees: amount,
    });
  } catch (err) {
    /* Razorpay's SDK rejects with a plain object, not an Error — surface its
       `description` so a failed checkout says WHY (§24) instead of dead-ending
       on "something went wrong". */
    const rzpDesc = (err as { error?: { description?: string } })?.error?.description;
    const m = rzpDesc || (err instanceof Error ? err.message : "");
    console.error("[portal/checkout/hosting] order create failed:", m || err);

    /* ─── TAKE THE QUOTE BACK OUT ─────────────────────────────────────────
       The quote is written before the order because it supplies the receipt
       the order is keyed on. When the order then fails there is no way to pay
       this quote — it has no Razorpay order behind it and never will — so
       leaving it would put a permanent "awaiting payment" row in the
       reseller's pipeline for a checkout that never started. Observed for real
       on 12 Sep 2026: placeholder Razorpay keys in .env.local made every
       attempt fail here, and each one left a phantom quote.

       Safe to delete precisely because the order failed: nothing references it,
       no payment can have arrived, and record_payment was never called. A quote
       that HAS an order is never touched here. */
    await admin.from("quotes").delete().eq("id", quoteId).eq("payment_status", "awaiting");

    return NextResponse.json(
      { error: m ? `Payment couldn't start — ${m}` : "Payment couldn't start. Please retry." },
      { status: 500 },
    );
  }
}
