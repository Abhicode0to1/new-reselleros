/**
 * Public quote-accept page — what the customer sees when they click the
 * link in the quote email/WhatsApp message.
 *
 * Server Component: fetches via admin client (bypasses RLS since the customer
 * isn't logged in). Quote ID is the secret — short, B2B context, low enumeration risk.
 *
 * Customer can accept, request changes, or print the quote here.
 */
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/server";
import type { Quote, QuoteLineItem, LineCommitment } from "@/lib/supabase/database.types";
import { quoteTokenMatches } from "@/lib/quotes/accept-token";
import { QuoteAcceptView, type PublicQuote, type PublicLine } from "./quote-accept-view";

export const dynamic = "force-dynamic"; // never cache — quotes change state

interface Props {
  params: { id: string };
  searchParams: { t?: string };
}

export async function generateMetadata({ params, searchParams }: Props) {
  // Resolve the supplier name — but ONLY when the link carries the right token,
  // so the tab/share preview can't be used to confirm a quote exists (SEC-1).
  const supabase = createAdminClient();
  const { data: quote } = await supabase
    .from("quotes").select("tenant_id, public_token").eq("id", params.id).maybeSingle();
  let supplier = "your reseller";
  if (quote && quoteTokenMatches(searchParams.t, quote.public_token)) {
    const { data: tenant } = await supabase
      .from("tenants").select("name").eq("id", quote.tenant_id).maybeSingle();
    supplier = tenant?.name ?? supplier;
  }
  return {
    title: "Review & Accept your quote",
    description: `Review and accept your quote from ${supplier}.`,
    robots: "noindex",  // not search-engine indexable
  };
}

export default async function QuoteAcceptPage({ params, searchParams }: Props) {
  const supabase = createAdminClient();

  // Fetch quote (admin client bypasses RLS). We DON'T select cost columns —
  // total_cost / per-line cost must never reach the customer's browser. Every
  // prop passed to the client view is serialized into the HTML payload.
  const { data: quote, error } = await supabase
    .from("quotes")
    .select("id, status, tenant_id, public_token, customer_name, subtotal, discount_pct, tax_rate, amount, expires_date, notes, line_items, billing_cycle, currency, exchange_rate")
    .eq("id", params.id)
    .maybeSingle();

  if (error || !quote) {
    notFound();
  }

  // Authorization: unguessable ?t=<token> must match. No token → "not found"
  // (identical to a missing quote, so ids can't be enumerated). (SEC-1)
  if (!quoteTokenMatches(searchParams.t, quote.public_token)) {
    notFound();
  }

  // Don't expose draft quotes via public link — they're not meant for customer eyes
  if (quote.status === "draft") {
    notFound();
  }

  // Fetch tenant info for the brand header. Phone + address help the customer
  // contact the reseller before accepting (especially for India where WhatsApp
  // calls happen on the visible phone number).
  const { data: tenant } = await supabase
    .from("tenants")
    .select("name, gstin, email, phone, address")
    .eq("id", quote.tenant_id)
    .maybeSingle();

  // Mark quote as "viewed" if currently "sent" — fire and forget
  if (quote.status === "sent") {
    void supabase.from("quotes").update({ status: "viewed" }).eq("id", quote.id);
  }

  // Build a customer-SAFE projection — never the raw row. Line items keep only
  // the display fields; cost/margin are dropped.
  const publicQuote: PublicQuote = {
    id: quote.id,
    status: quote.status,
    customer_name: quote.customer_name,
    subtotal: quote.subtotal,
    discount_pct: quote.discount_pct,
    tax_rate: quote.tax_rate,
    amount: quote.amount,
    expires_date: quote.expires_date,
    notes: quote.notes,
    billing_cycle: quote.billing_cycle,
    currency: quote.currency,
    exchange_rate: quote.exchange_rate,
  };
  const lineItems: PublicLine[] = ((quote.line_items ?? []) as QuoteLineItem[]).map((l) => ({
    id: l.id, name: l.name, qty: l.qty, rate: l.rate, commitment: l.commitment,
    // What the reseller marked adjustable. Cost and margin are still dropped.
    optional: l.optional, included_by_default: l.included_by_default,
    seats_adjustable: l.seats_adjustable, min_seats: l.min_seats, max_seats: l.max_seats,
  }));

  // Offer "Pay online" only when the reseller has Razorpay wired AND the quote
  // is in ₹ (Razorpay charges INR; a foreign-currency total would mismatch).
  // The pay route re-checks everything authoritatively — this only gates the UI.
  const { data: rzSecret } = await supabase
    .from("tenant_secrets")
    .select("razorpay_key_id, razorpay_key_secret")
    .eq("tenant_id", quote.tenant_id)
    .maybeSingle();
  const rzConfigured =
    Boolean(rzSecret?.razorpay_key_id && rzSecret?.razorpay_key_secret) ||
    Boolean(
      (process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID) &&
      process.env.RAZORPAY_KEY_SECRET,
    );
  const quoteIsForeign = !!quote.currency && quote.currency.toUpperCase() !== "INR";
  const payOnline = rzConfigured && !quoteIsForeign;

  return (
    <QuoteAcceptView
      quote={publicQuote}
      lineItems={lineItems}
      token={searchParams.t ?? ""}
      payOnline={payOnline}
      tenantName={tenant?.name ?? "Reseller"}
      tenantGstin={tenant?.gstin ?? null}
      tenantEmail={tenant?.email ?? null}
      tenantPhone={tenant?.phone ?? null}
      tenantAddress={tenant?.address ?? null}
    />
  );
}

// Helper re-exports so the view can use them (could move to shared lib later)
export type { Quote, QuoteLineItem, LineCommitment };
