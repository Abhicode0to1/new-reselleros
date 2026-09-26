/**
 * Domain renewals — from the sale to the renewed domain (owner, 25 Sep 2026:
 * "Handle the domain renewals too"; priced at the LIVE price at renewal time;
 * full price, the ₹0 bundle with yearly hosting is for the first year only).
 *
 * The pieces, in the order a domain lives through them:
 *
 *   1. SALE. `domainSubscriptionsToCreate` — after a cart payment, each paid
 *      domain gets its own yearly subscription (vendor `domain`). The payment
 *      webhook inserts them. Not via `record_payment`'s `commitment` rule, on
 *      purpose: that path dedupes one subscription per (quote, domain), so a
 *      domain bought with hosting on the same name would lose to the hosting.
 *   2. RENEWAL QUOTE. `createDomainRenewalQuote` — called by the renewals cron
 *      for vendor `domain` in place of the shared renewal-quote helper (which is
 *      in src/lib/renewals, a folder this app's owner has blocked). It prices the
 *      renewal from ResellerClub's CUSTOMER renewal price for the domain's
 *      extension, read at that moment, and refuses when it cannot be read.
 *   3. PAYMENT. The webhook recognises a paid renewal of a domain subscription and
 *      queues a domain RENEWAL (`plan = DOMAIN_RENEWAL_PLAN`), never a
 *      registration — which is what it would otherwise do with a paid domain.
 *   4. RENEW. The renew-domains worker sends the DMS engine's `domain.renew`,
 *      behind DOMAIN_RENEWAL_LIVE=1 here and the engine's own gate there.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, QuoteLineItem } from "@/lib/supabase/database.types";
import { grossAmount } from "@/lib/quotes/amounts";
import { isExportSupply } from "@/lib/gst/place-of-supply";
import { rcConfigured, rcTldPricing } from "@/lib/resellerclub";
import { splitDomain } from "@/lib/domains/live-lookup";

type SupabaseAdmin = SupabaseClient<Database>;

/**
 * The provisioning_requests `plan` that marks a row as a RENEWAL. Registration rows
 * carry the quote's plan; the register-domains worker skips rows with this value
 * and the renew-domains worker takes only them.
 */
export const DOMAIN_RENEWAL_PLAN = "domain-renewal";

/** The paying side's own switch. Only the exact string "1" opens it (AGENTS.md L41). */
export function domainRenewalEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.DOMAIN_RENEWAL_LIVE === "1";
}

/** One engine command id per request per IST day, so a re-run the same day replays. */
export function renewalCommandId(requestId: string, now: Date = new Date()): string {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000); // AGENTS.md §6 — IST, not UTC
  return `rsos-domrenew-${requestId}-${ist.toISOString().slice(0, 10)}`;
}

/** A domain's current expiry as DMS holds it, in epoch SECONDS (the unit `domain.renew`'s `expiryBefore` takes). */
export function expiryEpochSeconds(expiresAt: string | null | undefined): number | null {
  if (!expiresAt) return null;
  const ms = Date.parse(expiresAt);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
}

export interface DomainSubscriptionRow {
  domain: string;
  /** ₹ per month for MRR reporting: what was paid for the year ÷ 12. 0 for a bundled domain. */
  mrr: number;
}

/**
 * The domains a paid quote bought, each becoming one yearly subscription. Read from
 * the quote's lines, which name their domain since 24 Sep 2026 (`line.domain`).
 */
export function domainSubscriptionsToCreate(lineItems: unknown): DomainSubscriptionRow[] {
  if (!Array.isArray(lineItems)) return [];
  const out: DomainSubscriptionRow[] = [];
  const seen = new Set<string>();
  for (const l of lineItems) {
    if (!l || typeof l !== "object") continue;
    const line = l as { domain?: unknown; rate?: unknown; qty?: unknown };
    const domain = typeof line.domain === "string" ? line.domain.trim().toLowerCase() : "";
    if (!domain || seen.has(domain) || !splitDomain(domain)) continue;
    seen.add(domain);
    const yearly = Math.max(0, Number(line.rate) || 0) * Math.max(1, Number(line.qty) || 1);
    out.push({ domain, mrr: Math.round(yearly / 12) });
  }
  return out;
}

/** The subscription row for a newly bought domain: one year from today, renewing yearly. */
export function domainSubscriptionInsert(input: {
  tenantId: string;
  customerId: string;
  customerName: string;
  row: DomainSubscriptionRow;
  today: string; // YYYY-MM-DD, IST
}): Database["public"]["Tables"]["subscriptions"]["Insert"] {
  const start = new Date(`${input.today}T00:00:00Z`);
  const renewal = new Date(start);
  renewal.setUTCFullYear(renewal.getUTCFullYear() + 1);
  return {
    tenant_id: input.tenantId,
    customer_id: input.customerId,
    customer_name: input.customerName,
    plan: `Domain ${input.row.domain}`,
    vendor: "domain",
    seats: 1,
    mrr: input.row.mrr,
    start_date: input.today,
    renewal_date: renewal.toISOString().slice(0, 10),
    status: "active",
    outstanding_amount: 0,
    domain: input.row.domain,
    // Not linked to the sale's quote: a (quote, domain) pair can hold only one
    // subscription, and a hosting account on the same name already has it.
    quote_id: null,
    term_months: 12,
  };
}

export type RenewalPrice =
  | { ok: true; rupees: number }
  | { ok: false; reason: string };

/**
 * ResellerClub's CUSTOMER renewal price for one year of this domain's extension,
 * read now. Never a fallback figure: unknown means refuse (AGENTS.md §2).
 */
export async function liveRenewalPrice(domain: string): Promise<RenewalPrice> {
  const parts = splitDomain(domain);
  if (!parts) return { ok: false, reason: `"${domain}" is not a domain name this app can price.` };
  if (!rcConfigured()) {
    return { ok: false, reason: "ResellerClub is not reachable from this server (it answers only the whitelisted IP), so the live renewal price cannot be read." };
  }
  const prices = await rcTldPricing([parts.tld]);
  const renew = prices?.[0]?.renew ?? null;
  if (!prices) return { ok: false, reason: "ResellerClub's price list could not be read just now." };
  if (!renew || renew <= 0) return { ok: false, reason: `ResellerClub has no renewal price for .${parts.tld}.` };
  return { ok: true, rupees: renew };
}

export interface DomainRenewalQuoteInput {
  supabase: SupabaseAdmin;
  subscriptionId: string;
  tenantId: string;
  customerId: string | null;
  customerName: string;
  domain: string;
  renewalDate: string;
  graceDays: number;
  existingQuoteId?: string | null;
  /** Injected in tests; the live read otherwise. */
  price?: (domain: string) => Promise<RenewalPrice>;
}

/** Same shape as the shared helper's result, so the renewals cron treats both alike. */
export interface DomainRenewalQuoteResult {
  quoteId: string;
  amount: number;
  subtotal: number;
  discountPct: number;
  taxRate: number;
  lineItems: QuoteLineItem[];
  created: boolean;
}

/**
 * Issue (or return the existing) renewal quote for a domain subscription, at the live
 * price. Returns null — and logs why — when the price cannot be read or the quote cannot
 * be saved; the cron then carries on, as it does for the shared helper.
 */
export async function createDomainRenewalQuote(input: DomainRenewalQuoteInput): Promise<DomainRenewalQuoteResult | null> {
  const { supabase } = input;

  if (input.existingQuoteId) {
    const { data: q } = await supabase
      .from("quotes")
      .select("id, amount, line_items, subtotal, discount_pct, tax_rate")
      .eq("id", input.existingQuoteId)
      .eq("tenant_id", input.tenantId)
      .maybeSingle();
    if (q) {
      return {
        quoteId: q.id as string,
        amount: (q.amount as number) ?? 0,
        subtotal: (q.subtotal as number) ?? 0,
        discountPct: (q.discount_pct as number) ?? 0,
        taxRate: (q.tax_rate as number) ?? 18,
        lineItems: (q.line_items ?? []) as QuoteLineItem[],
        created: false,
      };
    }
  }

  const price = await (input.price ?? liveRenewalPrice)(input.domain);
  if (!price.ok) {
    console.error(`[domain-renewals] subscription ${input.subscriptionId} (${input.domain}): no renewal quote — ${price.reason}`);
    return null;
  }

  let taxRate = 18;
  if (input.customerId) {
    const { data: cust } = await supabase.from("customers").select("country").eq("id", input.customerId).maybeSingle();
    if (isExportSupply(cust?.country)) taxRate = 0;
  }

  const { data: nextNumber } = await supabase.rpc("next_document_number", { p_doc_type: "quote", p_tenant_id: input.tenantId });
  const quoteId = nextNumber as unknown as string;
  if (!quoteId) {
    console.error(`[domain-renewals] subscription ${input.subscriptionId}: no quote number was issued`);
    return null;
  }

  const subtotal = price.rupees;
  const amount = grossAmount(subtotal, taxRate);
  const lineItems: QuoteLineItem[] = [{
    id: "renewal-1",
    // The same name the subscription was created with: record_payment copies a paid
    // renewal line's name onto the subscription, so a different one would rename it.
    name: `Domain ${input.domain}`,
    description: "Renewal, 1 year",
    qty: 1,
    rate: subtotal,
    // Our cost is not known here (the registrar's is read by the engine at renewal).
    cost: 0,
    commitment: "annual_yearly",
    // No `domain` on this line: provisioning reads a line's domain as one to REGISTER.
  }];

  const validUntil = new Date(new Date(input.renewalDate).getTime() + (input.graceDays ?? 0) * 86400000);
  const { error: insertErr } = await supabase.from("quotes").insert({
    id: quoteId,
    tenant_id: input.tenantId,
    customer_id: input.customerId,
    customer_name: input.customerName,
    plan: DOMAIN_RENEWAL_PLAN,
    seats: 1,
    amount,
    status: "sent",
    payment_status: "awaiting",
    owner_id: null,
    domain: input.domain,
    created_date: new Date().toISOString().slice(0, 10),
    expires_date: validUntil.toISOString().slice(0, 10),
    line_items: lineItems,
    subtotal,
    // 0, as the cart's own quotes store it: our cost is not known here. NOT null, because
    // the quote screens (a blocked folder) read total_cost as always a number.
    total_cost: 0,
    discount_pct: 0,
    tax_rate: taxRate,
    is_renewal: true,
    extension_months: 12,
    notes: `Domain renewal for ${input.domain} (subscription ${input.subscriptionId}), at ResellerClub's live renewal price of ₹${subtotal} + GST.`,
  });
  if (insertErr) {
    console.error(`[domain-renewals] subscription ${input.subscriptionId}: renewal quote not saved — ${insertErr.message}`);
    return null;
  }

  const { data: linked, error: linkErr } = await supabase
    .from("subscriptions")
    .update({ renewal_quote_id: quoteId })
    .eq("id", input.subscriptionId)
    .eq("tenant_id", input.tenantId)
    .select("id");
  if (linkErr || !linked?.length) {
    // The quote exists but the subscription does not point at it, so paying it would not
    // be recognised as this renewal. Loud, because that is a real inconsistency (L84).
    console.error(`[domain-renewals] renewal quote ${quoteId} created but NOT linked to subscription ${input.subscriptionId}: ${linkErr?.message ?? "no row matched"}`);
  }

  return { quoteId, amount, subtotal, discountPct: 0, taxRate, lineItems, created: true };
}
