/**
 * POST /api/domains/:id/renewal-quote — ask a customer to pay for another term.
 *
 * ─── WHERE THIS SITS IN THE FLOW ────────────────────────────────────────────
 *   /api/cron/domain-expiry  warns the customer, carries NO price, says "reply
 *                            and we will send you the cost"
 *   → THIS ROUTE             the reseller raises the priced quote
 *   → the customer pays      (the ordinary quote/payment flow, unchanged)
 *   → /api/cron/domain-renew files the renewal at ResellerClub
 *
 * Staff-initiated, deliberately, and it is the one place this differs from the
 * hosting upgrade the customer raises themselves. The warning email tells the
 * customer to reply to us; a "renew now" button that quoted its own price would
 * contradict the email they are holding, and a domain's price comes from a rate
 * card that a tenant may never have synced.
 *
 * ─── IT REFUSES RATHER THAN GUESSING A PRICE ────────────────────────────────
 * `priceRenewal` returns a discriminated result, so "we have no rate for this
 * extension" is a case the caller has to handle and cannot reach a number by
 * accident. Measured on this database: ZERO `DOMAIN-%` catalogue items, because
 * the rate card needs ResellerClub credentials to sync. So refusing is the state
 * this feature starts in, and it has to refuse well.
 *
 * A guessed figure would be quoted, accepted, paid, and then filed at the
 * registrar at whatever it really costs — the reseller absorbing the difference,
 * once per renewal, quietly.
 *
 * ─── THE QUOTE IS `is_one_off` ──────────────────────────────────────────────
 * `record_payment` creates a subscription for any first payment on a quote that
 * is not a renewal, not add-seats and not one-off. A domain renewal is a single
 * sale for a fixed term — Pardeep chose (11 Sep 2026) that domains do not become
 * subscriptions — so without this flag paying it would hand the customer a
 * recurring subscription the renewal cron then bills forever. That is the bug
 * `record_payment`'s own comment calls "the costliest of the three".
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { priceRenewal, type TldRate } from "@/lib/domains/renewal-pricing";
import { resolveTaxRatePct } from "@/lib/subscriptions/apply-seat-increase";
import { localDateISO } from "@/lib/leads/outcomes";
import type { QuoteLineItem } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  /* Whole years only. The upper bound matches `rcRenewDomain`, which refuses
     anything else — quoting 12 years would take money for a term the registrar
     will not accept. */
  years: z.coerce.number().int().min(1).max(10).default(1),
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const userClient = createClient();
  const { data: authData } = await userClient.auth.getUser();
  if (!authData?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: me } = await userClient
    .from("users")
    .select("tenant_id")
    .eq("id", authData.user.id)
    .single();
  if (!me?.tenant_id) {
    return NextResponse.json({ error: "user not linked to a tenant" }, { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "A renewal is a whole number of years, 1 to 10." },
      { status: 400 },
    );
  }
  const years = parsed.data.years;

  const admin = createAdminClient();
  const { data: domain } = await admin
    .from("domains")
    .select("id, tenant_id, customer_id, domain_name, status, expires_at, registrar_order_id")
    .eq("id", params.id)
    .is("deleted_at", null)
    .maybeSingle();

  if (!domain) return NextResponse.json({ error: "domain not found" }, { status: 404 });
  /* Tenant scope enforced here: this route uses the admin client so it can write
     the quote number, and the admin client bypasses RLS. */
  if (domain.tenant_id !== me.tenant_id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  /* §24 on each state — the operator's next move differs for every one. */
  if (domain.status === "pending" || domain.status === "failed") {
    return NextResponse.json(
      {
        error: `This domain is ${domain.status}, so it has never been registered.`,
        nextStep:
          "There is nothing to renew. Finish or fix the original registration first — see the paid-but-undelivered list on the domains page.",
      },
      { status: 409 },
    );
  }
  if (domain.status === "transferred_out") {
    return NextResponse.json(
      {
        error: "This domain has been transferred away, so it is not ours to renew.",
        nextStep: "If the customer has come back, register or transfer it in rather than renewing.",
      },
      { status: 409 },
    );
  }
  if (!domain.expires_at) {
    return NextResponse.json(
      {
        error: "We do not have an expiry date for this domain, so we cannot say what a renewal extends.",
        nextStep:
          "Run the asset sweep (or wait for tonight's) to read the real date from the registrar, then raise this again.",
      },
      { status: 409 },
    );
  }

  /* ─── THE RATE CARD ───────────────────────────────────────────────────────
     `sync_domain_catalog` writes one item per priced TLD, with the renewal price
     in `prices.renew` and the TLD itself in `synced_from_partner_id`. */
  const { data: items } = await admin
    .from("items")
    .select("id, synced_from_partner_id, prices, wholesale")
    .eq("tenant_id", domain.tenant_id)
    .eq("vendor", "domain")
    .eq("is_active", true);

  const rates: TldRate[] = (items ?? [])
    .filter((i) => !!i.synced_from_partner_id)
    .map((i) => {
      const prices = (i.prices ?? {}) as Record<string, unknown>;
      const renew = Number(prices.renew);
      return {
        tld: String(i.synced_from_partner_id),
        itemId: i.id,
        renew: Number.isFinite(renew) ? renew : null,
        wholesale: i.wholesale ?? null,
      };
    });

  const price = priceRenewal({ domain: domain.domain_name, years, rates });
  if (!price.ok) {
    /* 409 and not 400: nothing about the request is malformed — we simply cannot
       price it. Both halves go back so the UI shows them verbatim. */
    return NextResponse.json({ error: price.reason, nextStep: price.nextStep }, { status: 409 });
  }

  const term = domain.expires_at.slice(0, 10);
  const taxRatePct = await resolveTaxRatePct(admin, domain.customer_id);
  const tax = Math.round((price.subtotal * taxRatePct) / 100);
  const total = price.subtotal + tax;

  const { data: customer } = domain.customer_id
    ? await admin.from("customers").select("name").eq("id", domain.customer_id).maybeSingle()
    : { data: null };

  const { data: nextNumber, error: numErr } = await admin.rpc("next_document_number", {
    p_doc_type: "quote",
    p_tenant_id: domain.tenant_id,
  });
  if (numErr || !nextNumber) {
    return NextResponse.json(
      { error: `Could not allocate a quote number (${numErr?.message ?? "none returned"}).` },
      { status: 500 },
    );
  }
  const quoteId = nextNumber as unknown as string;

  const lineItems: QuoteLineItem[] = [
    {
      id: "domain-renewal-1",
      name: `${domain.domain_name} — renewal, ${years} year${years > 1 ? "s" : ""} from ${term}`,
      qty: years,
      rate: price.perYear,
      /* Our cost per year, or 0 when the rate card never carried one. Zero is
         the honest placeholder — `priceRenewal` returns null for unknown and
         this column cannot hold null, so the margin report shows no margin
         rather than a fabricated one. */
      cost: price.cost != null ? Math.round(price.cost / years) : 0,
      commitment: "annual_yearly",
    },
  ];

  const today = localDateISO(new Date());
  /* Valid until the expiry itself. A renewal quote that outlives the domain is a
     quote for something that has already lapsed. */
  const expiresDate = term > today ? term : today;

  const { error: quoteErr } = await admin.from("quotes").insert({
    id: quoteId,
    tenant_id: domain.tenant_id,
    customer_id: domain.customer_id,
    customer_name: customer?.name ?? domain.domain_name,
    plan: `Domain renewal — ${price.tld}`,
    seats: years,
    amount: total,
    status: "sent",
    payment_status: "awaiting",
    owner_id: null,
    created_date: today,
    expires_date: expiresDate,
    line_items: lineItems,
    subtotal: price.subtotal,
    total_cost: price.cost ?? 0,
    discount_pct: 0,
    tax_rate: taxRatePct,
    is_renewal: false,
    is_add_seats: false,
    /* See the header — without this, paying it creates a subscription the
       renewal cron bills forever. */
    is_one_off: true,
    extension_months: 0,
    notes:
      `Domain renewal for ${domain.domain_name}: ${years} year${years > 1 ? "s" : ""} from ${term}. ` +
      `Rate card ${price.itemId} at ₹${price.perYear}/year. GST ${taxRatePct}%. ` +
      `Filed at the registrar by /api/cron/domain-renew once this is paid.`,
  });
  if (quoteErr) {
    return NextResponse.json({ error: `Could not raise the quote: ${quoteErr.message}` }, { status: 500 });
  }

  /* ─── THE LINK FROM MONEY TO THE REGISTRAR ─────────────────────────────────
     Without this row a paid renewal quote is indistinguishable from any other
     paid quote and nothing would ever file anything. */
  const { data: renewal, error: renewalErr } = await admin
    .from("domain_renewals")
    .insert({
      tenant_id: domain.tenant_id,
      domain_id: domain.id,
      domain_name: domain.domain_name,
      customer_id: domain.customer_id,
      years,
      from_expires_at: term,
      quote_id: quoteId,
      status: "quoted",
      /* Copied so the record is self-contained. The cron re-reads it live before
         filing — see the migration on why. */
      registrar_order_id: domain.registrar_order_id,
    })
    .select("id")
    .single();

  if (renewalErr) {
    /* 23505 is `uq_domain_renewals_one_open`: a renewal for this term is already
       quoted. The quote number is already spent, which is unavoidable — a
       document series has no rollback — so the honest thing is to say what
       happened rather than leave an orphan nobody can explain. */
    if (renewalErr.code === "23505") {
      return NextResponse.json(
        {
          error: `${domain.domain_name} already has a renewal quote waiting for the term ending ${term}.`,
          nextStep: `Find it on the domain, or cancel it, before raising another. Quote ${quoteId} was allocated and is unused — cancel it too.`,
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      {
        error: `The quote ${quoteId} was raised but the renewal could not be recorded (${renewalErr.message}).`,
        nextStep:
          "Nothing will be filed at the registrar for it. Cancel that quote and raise the renewal again.",
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    id: renewal.id,
    quoteId,
    years,
    perYear: price.perYear,
    subtotal: price.subtotal,
    tax,
    total,
    fromExpiresAt: term,
    /* Stated plainly: the renewal is NOT filed yet, and will not be until the
       money is in. */
    message: `Quote ${quoteId} raised for ₹${total} — ${years} year${years > 1 ? "s" : ""} on ${domain.domain_name}. The renewal is filed at the registrar once it is paid.`,
  });
}
