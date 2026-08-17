/**
 * POST /api/portal/mandate   — a customer setting up UPI Autopay
 * DELETE /api/portal/mandate — a customer withdrawing it
 *
 * ─── WHAT THIS ROUTE DOES AND DOES NOT DECIDE ───────────────────────────────
 * It asks Razorpay to create a plan + subscription and returns the AUTHORISATION
 * LINK the customer opens in their UPI app. It writes a row at
 * `pending_authorisation` and stops there.
 *
 * It never writes `active`. That word means a bank will move money without anyone
 * touching it, and the only thing entitled to say it happened is a
 * signature-verified webhook from the gateway. See lib/payments/mandate.ts.
 *
 * ─── THE AMOUNT ASKED FOR IS BIGGER THAN TODAY'S BILL, ON PURPOSE ───────────
 * A UPI mandate's cap is fixed at approval and cannot be raised. Requesting exactly
 * today's figure means the first seat addition silently stops collection, and fixing
 * it means asking the customer to approve a whole new mandate. planMandate() adds
 * headroom and refuses outright when the bill is already over the per-debit ceiling —
 * being turned away here is far better than at the bank's approval screen.
 *
 * ─── TEST MODE IS RECORDED ON THE ROW ───────────────────────────────────────
 * Razorpay keys carry their mode in the key id, but a mandate outlives the key
 * configuration it was created under. Storing it means a test mandate can never
 * later be read as a live authorisation.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import Razorpay from "razorpay";
import { createAdminClient } from "@/lib/supabase/server";
import { requirePortalSession } from "@/lib/portal/session";
import { decryptTenantSecrets } from "@/lib/crypto/tenant-secrets";
import { planMandate } from "@/lib/payments/mandate";
import { grossAmount } from "@/lib/quotes/amounts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({ subscription_id: z.string().uuid() });

/** Resolve this tenant's Razorpay credentials, mirroring the public pay route. */
async function resolveKeys(admin: ReturnType<typeof createAdminClient>, tenantId: string) {
  const { data: raw } = await admin
    .from("tenant_secrets")
    .select("razorpay_key_id, razorpay_key_secret, razorpay_mode")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const secrets = decryptTenantSecrets(raw);
  if (secrets?.razorpay_key_id && secrets.razorpay_key_secret) {
    return {
      keyId: secrets.razorpay_key_id,
      keySecret: secrets.razorpay_key_secret,
      testMode: secrets.razorpay_mode !== "live",
    };
  }
  const envId = process.env.RAZORPAY_KEY_ID?.trim();
  const envSecret = process.env.RAZORPAY_KEY_SECRET?.trim();
  if (envId && envSecret) {
    return { keyId: envId, keySecret: envSecret, testMode: !envId.startsWith("rzp_live_") };
  }
  return null;
}

export async function POST(req: Request) {
  const session = await requirePortalSession();

  let raw: unknown;
  try { raw = await req.json(); } catch { raw = {}; }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Which subscription is this for?" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, tenant_id, customer_id, customer_name, plan, mrr, status, billing_cycle")
    .eq("id", parsed.data.subscription_id)
    .maybeSingle();

  /* The subscription must belong to THIS portal session's customer — without this
     the endpoint would accept any subscription id. */
  if (!sub || sub.customer_id !== session.customerId) {
    return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
  }
  if (sub.status !== "active") {
    return NextResponse.json(
      { error: `This subscription is ${sub.status}, so autopay cannot be set up on it.` },
      { status: 400 },
    );
  }

  // ── What is actually debited each cycle: the GST-inclusive amount. ─────────
  const perCycleMonths = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 }[sub.billing_cycle ?? "yearly"] ?? 12;
  const cycleAmount = grossAmount(Math.round((sub.mrr ?? 0) * perCycleMonths), 18);

  const { data: existing } = await admin
    .from("payment_mandates")
    .select("id, status")
    .eq("subscription_id", sub.id)
    .in("status", ["pending_authorisation", "active"])
    .maybeSingle();

  const gate = planMandate({
    current: existing ? (existing.status as "pending_authorisation" | "active") : "none",
    cycleAmount,
  });
  if (!gate.allowed) {
    /* 409 with the next step: nothing is malformed, the state or the amount simply
       does not permit it. */
    return NextResponse.json({ error: gate.reason, nextStep: gate.nextStep }, { status: 409 });
  }

  const keys = await resolveKeys(admin, sub.tenant_id);
  if (!keys) {
    return NextResponse.json(
      {
        error: "Autopay is not available on this account yet.",
        nextStep: "Please pay by UPI or bank transfer for now — we will let you know when autopay is ready.",
      },
      { status: 503 },
    );
  }

  try {
    const razorpay = new Razorpay({ key_id: keys.keyId, key_secret: keys.keySecret });

    /* A plan describes the recurring shape; a subscription binds this customer to it
       and carries the authorisation link. Both are created per mandate rather than
       reused: the amount differs per customer, and a shared plan would make one
       customer's seat change alter another's mandate. */
    const plan = await razorpay.plans.create({
      period: (sub.billing_cycle === "monthly" ? "monthly"
        : sub.billing_cycle === "quarterly" ? "monthly"
        : "yearly") as "monthly" | "yearly",
      interval: sub.billing_cycle === "quarterly" ? 3 : 1,
      item: {
        name: `${sub.plan} — ${sub.customer_name}`,
        amount: gate.requestAmount * 100,   // paise, gateway convention
        currency: "INR",
      },
      notes: { tenantId: sub.tenant_id, subscriptionId: sub.id },
    });

    const subscription = await razorpay.subscriptions.create({
      plan_id: plan.id,
      /* The mandate stands until cancelled. 120 cycles is Razorpay's practical
         maximum and reads as "ongoing" rather than committing the customer to a
         fixed number of payments. */
      total_count: 120,
      customer_notify: 1,
      notes: {
        tenantId: sub.tenant_id,
        subscriptionId: sub.id,
        customerId: sub.customer_id,
      },
    });

    const { data: created, error } = await admin
      .from("payment_mandates")
      .insert({
        tenant_id: sub.tenant_id,
        customer_id: sub.customer_id,
        subscription_id: sub.id,
        method: "upi",
        status: "pending_authorisation",
        /* max_amount stays NULL. We asked for gate.requestAmount; what the customer
           approves is what the webhook will tell us, and those are not the same fact. */
        requested_amount: gate.requestAmount,
        gateway: "razorpay",
        gateway_plan_id: plan.id,
        gateway_subscription_id: subscription.id,
        auth_link: subscription.short_url ?? null,
        test_mode: keys.testMode,
      })
      .select("id, auth_link")
      .single();

    if (error) throw error;

    return NextResponse.json({
      ok: true,
      id: created.id,
      authLink: created.auth_link,
      requestedAmount: gate.requestAmount,
      testMode: keys.testMode,
      message: keys.testMode
        ? "Test mode — approving this will not move any real money."
        : "Approve the mandate in your UPI app to switch autopay on.",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("[portal/mandate] create failed:", message);
    return NextResponse.json(
      {
        error: "Could not set up autopay just now.",
        nextStep: "Please try again, or pay by UPI for this cycle and tell us if it keeps failing.",
      },
      { status: 502 },
    );
  }
}

/**
 * Cancel.
 *
 * Cancelled locally EVEN IF the gateway call fails. Withdrawing permission must never
 * depend on a third party being reachable — if a customer says stop, we stop, and a
 * mandate the gateway still holds is reconciled by the next webhook rather than left
 * on because an API call timed out.
 */
export async function DELETE(req: Request) {
  const session = await requirePortalSession();

  let raw: unknown;
  try { raw = await req.json(); } catch { raw = {}; }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "Which subscription is this for?" }, { status: 400 });

  const admin = createAdminClient();
  const { data: mandate } = await admin
    .from("payment_mandates")
    .select("id, tenant_id, customer_id, gateway_subscription_id, status")
    .eq("subscription_id", parsed.data.subscription_id)
    .in("status", ["pending_authorisation", "active"])
    .maybeSingle();

  if (!mandate || mandate.customer_id !== session.customerId) {
    return NextResponse.json({ error: "No autopay is set up on this subscription." }, { status: 404 });
  }

  let gatewayCancelled = false;
  const keys = await resolveKeys(admin, mandate.tenant_id);
  if (keys && mandate.gateway_subscription_id) {
    try {
      const razorpay = new Razorpay({ key_id: keys.keyId, key_secret: keys.keySecret });
      await razorpay.subscriptions.cancel(mandate.gateway_subscription_id);
      gatewayCancelled = true;
    } catch (e) {
      console.error("[portal/mandate] gateway cancel failed:", e instanceof Error ? e.message : e);
    }
  }

  const { error } = await admin
    .from("payment_mandates")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      status_note: gatewayCancelled ? "Cancelled by the customer." : "Cancelled by the customer; the gateway did not confirm and will be reconciled by webhook.",
      updated_at: new Date().toISOString(),
    })
    .eq("id", mandate.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    gatewayCancelled,
    message: gatewayCancelled
      ? "Autopay is off. Nothing further will be debited."
      : "Autopay is off on our side. If a debit is attempted we will refund it — tell us straight away.",
  });
}
