/**
 * POST /api/public/checkout/cart
 *
 * Real Razorpay checkout for the site cart (Pardeep, 2 Sep: "cart/checkout ko
 * asli banao"). The /checkout page's "Pay" calls this; on success the client
 * opens Razorpay.Checkout({order_id}) and the visitor pays. Razorpay then POSTs
 * to /api/webhooks/razorpay, which marks the quote paid via record_payment and
 * queues provisioning — the same downstream the Workspace direct-buy uses.
 *
 * ─── MONEY SAFETY: the client price is NEVER trusted ────────────────────────
 * Cart lines come from the browser, so `unitPrice` is attacker-controlled. Every
 * line is RE-PRICED here from its `sku` against the server's own source of truth
 * (HOSTING_TIERS for hosting). A line with no recognised sku cannot be charged
 * online — the response tells the visitor to request a quote for it. This is the
 * whole reason a generic cart checkout is riskier than a per-product buy, and
 * it's handled by refusing to charge anything we can't price ourselves.
 *
 * v1 supports hosting SKUs (`hosting:starter|standard|plus`). Domains / email /
 * other SKUs get added here as their server-side price sources are wired.
 */
import { NextResponse, type NextRequest } from "next/server";
import { captureFromRequest } from "@/lib/marketing/utm";
import { z } from "zod";
import Razorpay from "razorpay";
import { createAdminClient } from "@/lib/supabase/server";
import { decryptTenantSecrets } from "@/lib/crypto/tenant-secrets";
import { HOSTING_TIERS } from "@/site/lib/data/hosting-landing-v2";

const BUY_PAGE_TENANT_ID =
  process.env.BUY_PAGE_TENANT_ID?.trim() || "fbb976f1-9090-4f10-9726-0901bd144e42";
const ENV_RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID?.trim() || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID?.trim() || "";
const ENV_RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET?.trim() || "";

const lineSchema = z.object({
  sku: z.string().min(1).max(60).optional(),
  label: z.string().max(200).optional(),
  qty: z.coerce.number().int().min(1).max(1000).default(1),
  cycle: z.enum(["monthly", "yearly", "once"]).optional(),
});
const cartSchema = z.object({
  fullName: z.string().min(2).max(120),
  companyName: z.string().min(2).max(200),
  email: z.string().email().max(200),
  phone: z.string().min(10).max(20),
  gstin: z.string().max(20).optional(),
  /** Required when a hosting line is present — the account is provisioned on it. */
  domain: z.string().max(120).optional(),
  lines: z.array(lineSchema).min(1).max(50),
  simulate: z.boolean().optional(),
});

interface QuoteLine { id: string; name: string; qty: number; rate: number; cost: number; }

/** Re-price one line from its sku. Returns null for anything we can't price server-side. */
function repriceLine(sku: string | undefined, cycle: string | undefined, qty: number): { line: QuoteLine; tier?: string } | null {
  if (!sku) return null;
  const m = /^hosting:(starter|standard|plus)$/.exec(sku.toLowerCase());
  if (m) {
    const tier = m[1];
    const t = HOSTING_TIERS.find((x) => x.name.toLowerCase() === tier);
    if (!t) return null;
    const yearly = cycle !== "monthly";
    // Whole rupees — the money spine stores integers (CLAUDE.md §13); a fractional
    // tier total like ₹599.88 would break the integer lead/quote columns.
    const rate = Math.round(yearly ? t.yearlyTotal : t.monthly); // server truth, not client
    return {
      tier,
      line: {
        id: globalThis.crypto?.randomUUID() ?? Math.random().toString(36).slice(2),
        name: `${t.name} hosting (${yearly ? "billed yearly" : "billed monthly"})`,
        qty,
        rate,
        cost: 0,
      },
    };
  }
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = cartSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid checkout: " + parsed.error.issues.map((i) => i.message).join(", ") },
        { status: 400 },
      );
    }
    const { fullName, companyName, email, phone, gstin, domain, lines, simulate } = parsed.data;

    // ── Re-price every line server-side; collect anything we can't charge ──
    const items: QuoteLine[] = [];
    const unpriced: string[] = [];
    let hasHosting = false;
    let hostingTier: string | null = null;
    for (const l of lines) {
      const r = repriceLine(l.sku, l.cycle, l.qty);
      if (!r) { unpriced.push(l.label || l.sku || "an item"); continue; }
      items.push(r.line);
      if (r.tier) { hasHosting = true; hostingTier = hostingTier ?? r.tier; }
    }
    if (unpriced.length) {
      return NextResponse.json(
        { error: `We can't take online payment for: ${unpriced.join(", ")}. Please request a quote for these — the rest can be paid online.`, unpriced },
        { status: 400 },
      );
    }
    if (items.length === 0) {
      return NextResponse.json({ error: "Nothing to pay for." }, { status: 400 });
    }

    const cleanDomain = (domain || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "").trim();
    if (hasHosting && cleanDomain.length < 3) {
      return NextResponse.json(
        { error: "Please enter the domain your hosting should be set up on.", needDomain: true },
        { status: 400 },
      );
    }

    const subtotal = items.reduce((s, i) => s + i.qty * i.rate, 0);
    const amount = Math.round(subtotal * 1.18);
    if (amount <= 0) return NextResponse.json({ error: "Nothing to pay for." }, { status: 400 });

    // ── Razorpay credentials (tenant_secrets → env) ────────────────────────
    let rzKeyId = "", rzKeySecret = "", rzMode: "test" | "live" = "test";
    const admin = createAdminClient();
    {
      const { data: rawSecrets } = await admin
        .from("tenant_secrets")
        .select("razorpay_key_id, razorpay_key_secret, razorpay_mode")
        .eq("tenant_id", BUY_PAGE_TENANT_ID)
        .maybeSingle();
      // Sealed at rest (rosv1:…) — decrypt or Razorpay rejects the ciphertext.
      const secrets = decryptTenantSecrets(rawSecrets);
      if (secrets?.razorpay_key_id && secrets.razorpay_key_secret) {
        rzKeyId = secrets.razorpay_key_id; rzKeySecret = secrets.razorpay_key_secret;
        rzMode = secrets.razorpay_mode === "live" ? "live" : "test";
      } else if (ENV_RAZORPAY_KEY_ID && ENV_RAZORPAY_KEY_SECRET) {
        rzKeyId = ENV_RAZORPAY_KEY_ID; rzKeySecret = ENV_RAZORPAY_KEY_SECRET;
        rzMode = ENV_RAZORPAY_KEY_ID.startsWith("rzp_live_") ? "live" : "test";
      }
    }
    const razorpayConfigured = Boolean(rzKeyId) && Boolean(rzKeySecret);
    const isSimulation = simulate === true;
    const simulationAllowed = process.env.ALLOW_SIMULATED_CHECKOUT === "1" || process.env.NODE_ENV !== "production";
    if (!razorpayConfigured && !isSimulation) {
      return NextResponse.json({ error: "Online payment isn't set up yet. Please use 'Get a quote'." }, { status: 503 });
    }
    if (razorpayConfigured && isSimulation) {
      return NextResponse.json({ error: "Simulation is disabled in live mode." }, { status: 400 });
    }
    if (isSimulation && !simulationAllowed) {
      return NextResponse.json({ error: "Online payment isn't available yet. Please use 'Get a quote'." }, { status: 503 });
    }

    // ── Lead (stage='quote' = intent to buy) ───────────────────────────────
    const leadId = "L-" + Date.now().toString(36).toUpperCase();
    const planLabel = hostingTier ? `hosting-${hostingTier}` : "cart-order";
    const notes = [
      `DIRECT BUY (cart) · ${items.length} line(s) · ₹${amount.toLocaleString("en-IN")} incl 18% GST`,
      hasHosting ? `Hosting domain: ${cleanDomain}` : null,
      gstin ? `GSTIN: ${gstin}` : null,
      ...items.map((i) => `  • ${i.name} × ${i.qty} @ ₹${i.rate}`),
    ].filter(Boolean).join("\n");

    const { error: leadErr } = await admin.from("leads").insert({
      id: leadId,
      tenant_id: BUY_PAGE_TENANT_ID,
      company: companyName,
      contact_name: fullName,
      contact_email: email,
      contact_phone: phone,
      plan: planLabel,
      seats: items.reduce((s, i) => s + i.qty, 0),
      value: subtotal,
      stage: "quote",
      source: isSimulation ? "buy-cart-direct-sim" : "buy-cart-direct",
      ...captureFromRequest(request, body as Record<string, unknown>),
      domain: cleanDomain || null,
      notes,
    });
    if (leadErr) {
      console.error("[checkout/cart] lead insert failed:", leadErr);
      return NextResponse.json({ error: "Could not start checkout. Please retry." }, { status: 500 });
    }

    // ── Quote number + draft quote (payment_status='awaiting') ─────────────
    const { data: qid, error: numErr } = await admin
      .rpc("next_document_number", { p_doc_type: "quote", p_tenant_id: BUY_PAGE_TENANT_ID });
    if (numErr || !qid) {
      console.error("[checkout/cart] next_document_number failed:", numErr);
      return NextResponse.json({ error: "Could not allocate a quote number. Please retry." }, { status: 500 });
    }
    const quoteId = qid as string;
    const today = new Date();
    const expires = new Date(today); expires.setDate(expires.getDate() + 7);

    const { error: qErr } = await admin.from("quotes").insert({
      id: quoteId,
      tenant_id: BUY_PAGE_TENANT_ID,
      customer_id: null,
      customer_name: companyName,
      lead_id: leadId,
      plan: planLabel,
      seats: items.reduce((s, i) => s + i.qty, 0),
      line_items: items,
      subtotal,
      total_cost: 0,
      discount_pct: 0,
      tax_rate: 18,
      amount,
      status: "sent",
      payment_status: "awaiting",
      owner_id: null,
      domain: cleanDomain || null,
      created_date: today.toISOString().slice(0, 10),
      expires_date: expires.toISOString().slice(0, 10),
      notes: `Direct buy from cart. Razorpay order pending.`,
    });
    if (qErr) {
      console.error("[checkout/cart] quote insert failed:", qErr);
      return NextResponse.json({ error: "Could not save quote. Please retry." }, { status: 500 });
    }

    // ── SIMULATION (pre-live-keys preview) — record payment directly ───────
    if (isSimulation) {
      const { error: recErr } = await admin.rpc("record_payment", {
        p_quote_id: quoteId,
        p_amount: amount,
        p_method: "razorpay",
        p_reference: "SIM-" + quoteId,
        p_notes: "[SIMULATION] Test cart payment",
      });
      if (recErr) {
        console.error("[checkout/cart] simulated record_payment failed:", recErr);
        return NextResponse.json({ error: "Simulation failed: " + recErr.message }, { status: 500 });
      }
      return NextResponse.json({ success: true, simulated: true, quoteId, leadId, totalRupees: amount });
    }

    // ── LIVE — create Razorpay order ───────────────────────────────────────
    const razorpay = new Razorpay({ key_id: rzKeyId, key_secret: rzKeySecret });
    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: "INR",
      receipt: quoteId,
      notes: { leadId, quoteId, company: companyName, contact: fullName, email, phone, domain: cleanDomain, plan: planLabel },
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
      leadId,
      customerName: fullName,
      totalRupees: amount,
    });
  } catch (err) {
    // Razorpay's SDK rejects with a plain object ({statusCode, error:{code,description}}),
    // not an Error — surface its `description`, then any message, then the raw shape.
    const rzpDesc = (err as { error?: { description?: string } })?.error?.description;
    let m = rzpDesc || (err instanceof Error ? err.message : "");
    if (!m) { try { m = JSON.stringify(err); } catch { m = String(err); } }
    console.error("[/api/public/checkout/cart] crashed:", m);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
