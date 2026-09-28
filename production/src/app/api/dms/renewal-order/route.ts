/**
 * POST /api/dms/renewal-order — pay a renewal from inside the DMS customer panel.
 *
 * Owner, 28 Sep 2026: a first purchase is made in ResellerOS; an existing customer renewing
 * hosting or a domain does it inside the DMS panel. The renewal quote is still ResellerOS's
 * (lib/domains/renewal.ts, lib/hosting/renewal.ts, the renewals cron) and so is the bill:
 * this only starts the payment, with the same guards and the same Razorpay order as the
 * quote's own public page (lib/checkout/quote-order.ts). The webhook then settles it as the
 * renewal it is — `renewal_quote_id` / `is_renewal` — and queues `domain-renewal` /
 * `hosting-renewal`. Nothing here decides a price.
 *
 * Who may pay: DMS's panel key (checkPanelKey), and the quote must belong to the customer
 * whose email DMS names, matched exactly (lib/api/v1-email-match.ts) — the same rule the
 * panel's Invoices page is read with. Only renewal quotes pass; a new purchase goes through
 * /api/dms/panel-order. No simulation: without Razorpay keys this refuses.
 *
 * Body: { quoteId, email, dmsUserId }.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { checkPanelKey } from "@/lib/dms-engine/panel-auth";
import { sameEmail } from "@/lib/api/v1-email-match";
import { BUY_PAGE_TENANT_ID } from "@/lib/checkout/cart-checkout";
import { QUOTE_ORDER_COLUMNS, startQuotePayment } from "@/lib/checkout/quote-order";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  quoteId: z.string().trim().min(3).max(64),
  email: z.string().trim().email().max(254),
  dmsUserId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
});

const NOT_YOURS =
  "We couldn't find a renewal with that number on your account. Nothing was charged. " +
  "Refresh the page to see your current renewals, or contact support if one is missing.";

export async function POST(request: NextRequest) {
  const auth = checkPanelKey(request.headers);
  if (!auth.ok) {
    if (auth.status === 503) console.warn("[dms/renewal-order]", auth.error);
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid renewal payment: the request was not JSON. Nothing was charged." }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid renewal payment: it needs the renewal's number, the customer's email and the DMS account. Nothing was charged." },
      { status: 400 },
    );
  }
  const { quoteId, email, dmsUserId } = parsed.data;
  const admin = createAdminClient();

  // The same tenant the panel's purchases are made in. A quote of any other tenant is "not found".
  const { data: quote, error: qErr } = await admin
    .from("quotes")
    .select(`${QUOTE_ORDER_COLUMNS}, customer_id, is_renewal`)
    .eq("id", quoteId)
    .eq("tenant_id", BUY_PAGE_TENANT_ID)
    .maybeSingle();
  if (qErr) {
    console.error("[dms/renewal-order] quote read failed:", qErr.message);
    return NextResponse.json({ error: "We couldn't load this renewal just now. Nothing was charged. Please try again in a minute." }, { status: 503 });
  }
  if (!quote || !quote.customer_id) return NextResponse.json({ error: NOT_YOURS }, { status: 404 });

  const [{ data: customer, error: cErr }, { data: renews, error: sErr }] = await Promise.all([
    admin.from("customers").select("contact_email").eq("id", quote.customer_id).eq("tenant_id", BUY_PAGE_TENANT_ID).maybeSingle(),
    admin.from("subscriptions").select("id, plan, vendor, domain, renewal_date").eq("tenant_id", BUY_PAGE_TENANT_ID).eq("renewal_quote_id", quote.id),
  ]);
  if (cErr || sErr) {
    console.error("[dms/renewal-order] lookup failed:", cErr?.message ?? sErr?.message);
    return NextResponse.json({ error: "We couldn't load this renewal just now. Nothing was charged. Please try again in a minute." }, { status: 503 });
  }
  // Fail closed: no email on the customer, or a different one, is not this customer's renewal.
  if (!customer || !sameEmail(customer.contact_email, email)) {
    return NextResponse.json({ error: NOT_YOURS }, { status: 404 });
  }
  const renewed = renews ?? [];
  if (!quote.is_renewal && renewed.length === 0) {
    return NextResponse.json(
      {
        error:
          "This bill is not a renewal, so it isn't paid from the panel. Nothing was charged. " +
          "Pay it from the link in the email we sent with it, or contact support.",
      },
      { status: 400 },
    );
  }

  const r = await startQuotePayment(admin, quote, {
    allowSimulation: false,
    extraNotes: { channel: "dms-panel-renewal", dmsUserId },
    logTag: "[dms/renewal-order]",
  });
  if (r.status !== 200) return NextResponse.json(r.body, { status: r.status });
  return NextResponse.json({
    ...r.body,
    // What is being renewed, so the panel can show it beside the Pay button.
    renews: renewed.map((s) => ({ plan: s.plan, vendor: s.vendor, domain: s.domain, renewalDate: s.renewal_date })),
  });
}
