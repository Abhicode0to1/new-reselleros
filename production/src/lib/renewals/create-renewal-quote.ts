/**
 * createRenewalQuote — shared helper to issue a renewal quote for a subscription.
 *
 * Idempotent: if the subscription already has a `renewal_quote_id`, returns
 * that existing quote unchanged. Both the daily cron and the on-demand
 * "Generate renewal quote" API call this so behaviour stays identical
 * whether the system or the operator triggers it.
 *
 * Behaviour:
 *   1. If subscription.renewal_quote_id is set → load that quote, return it.
 *   2. Otherwise:
 *        - Issue a fresh quote number via the next_document_number RPC.
 *        - Build a single-line annual quote from the subscription's plan/seats/MRR.
 *        - Validity = renewal_date + tenant.grace_period_days.
 *        - Insert the quote.
 *        - Link it back to subscription.renewal_quote_id.
 *        - Return the new quote.
 *
 * Server-only — needs a service-role Supabase client because it writes
 * across customers/quotes/subscriptions inside one tenant's data.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, QuoteLineItem } from "@/lib/supabase/database.types";
import { grossAmount } from "@/lib/quotes/amounts";
import { isExportSupply } from "@/lib/gst/place-of-supply";
import { renewalTerm } from "@/lib/renewals/renewal-term";
import { renewalCost } from "@/lib/renewals/renewal-cost";
import { istToday, toIstDate } from "@/lib/dates/ist";

// The actual typed Supabase client. createAdminClient() returns this shape,
// so the strict rpc/from overloads stay intact when callers pass it in.
type SupabaseAdmin = SupabaseClient<Database>;

export interface CreateRenewalQuoteInput {
  supabase:        SupabaseAdmin;
  subscriptionId:  string;
  tenantId:        string;
  customerId:      string | null;
  customerName:    string;
  plan:            string;
  /**
   * `subscriptions.item_id` — the catalogue row this subscription was sold from.
   *
   * ─── WHY THE ID AND NOT JUST THE NAME (added 24 Aug 2026) ─────────────────
   * The catalogue lookup below used to match on `items.name = input.plan`, and `plan` is a
   * TEXT COPY taken when the subscription was created. The two drift the moment anybody
   * renames a product — and they were about to: the catalogue said "Google Workspace
   * Standard" while customers write Google's real name, "Google Workspace Business
   * Standard".
   *
   * A failed lookup here is not a cosmetic miss. `catalogPerSeatMonth` is what `renewalTerm`
   * checks the stored `mrr` against, and that check is the only thing that caught a 144x
   * renewal on a live subscription (see the comment at the call site). Renaming an item would
   * have blinded the guard for every subscription sold under the old name, silently, until the
   * renewal date.
   *
   * Optional so no caller breaks; when absent the name lookup still runs.
   */
  itemId?:         string | null;
  seats:           number;
  mrr:             number;          // monthly run rate (₹)
  /**
   * `subscriptions.term_months`. 1 = monthly, 12 = annual.
   *
   * OPTIONAL only so no caller breaks; absent falls back to 12, which is both the
   * historical behaviour and right for almost all of this data. It exists because this
   * file used to hardcode `mrr * 12` and quote a MONTHLY subscription for a year — the
   * term-aware reminder ladder shipped on 22 Aug and never reached the pricing.
   */
  termMonths?:     number | null;
  renewalDate:     string;          // ISO date or YYYY-MM-DD
  graceDays:       number;          // tenant.grace_period_days
  /** Existing renewal_quote_id, if any. When present, we just load and return it. */
  existingQuoteId?: string | null;
  /** Optional override — defaults to false (auto-created note). */
  notes?:          string;
}

export interface RenewalQuoteResult {
  quoteId:    string;
  amount:     number;
  subtotal:   number;
  discountPct: number;
  taxRate:    number;
  lineItems:  QuoteLineItem[];
  /** True if a brand-new quote was created in this call. */
  created:    boolean;
}

export async function createOrGetRenewalQuote(
  input: CreateRenewalQuoteInput,
): Promise<RenewalQuoteResult | null> {
  const { supabase, existingQuoteId } = input;

  // ── Path 1: subscription already has a renewal quote — load + return ──
  if (existingQuoteId) {
    const { data: q } = await supabase
      .from("quotes")
      .select("id, amount, line_items, subtotal, discount_pct, tax_rate")
      .eq("id", existingQuoteId)
      .single();
    if (q) {
      return {
        quoteId:     q.id as string,
        amount:      (q.amount as number) ?? 0,
        subtotal:    (q.subtotal as number) ?? 0,
        discountPct: (q.discount_pct as number) ?? 0,
        taxRate:     (q.tax_rate as number) ?? 18,
        lineItems:   ((q.line_items ?? []) as QuoteLineItem[]),
        created:     false,
      };
    }
    // If the linked quote was deleted somehow, fall through and create fresh
  }

  // ── Path 2: create a new quote ────────────────────────────────────
  const { data: nextNumber } = await supabase.rpc("next_document_number", {
    p_doc_type:  "quote",
    p_tenant_id: input.tenantId,
  });
  const newQuoteId = nextNumber as unknown as string;
  if (!newQuoteId) return null;

  // Export (international) customer → zero-rated under LUT: the renewal quote
  // must NOT add GST (the old hardcoded 18% wrongly taxed foreign auto-renewals).
  let renewalTaxRate = 18;
  if (input.customerId) {
    const { data: cust } = await supabase
      .from("customers").select("country").eq("id", input.customerId).maybeSingle();
    if (isExportSupply(cust?.country)) renewalTaxRate = 0;
  }

  /* ── Price the renewal for its OWN term ──────────────────────────────────
     This was `Math.round(input.mrr * 12)` with `term_months` appearing nowhere in the
     file, so a monthly subscription was quoted for a year. And on the row that renews
     first (c398e832, 27 Aug, auto_renew on) `mrr` also held an ANNUAL figure —
     ₹3,240/seat against a ₹270 catalogue price — so the two compounded to roughly 144x
     the correct monthly charge. renewalTerm refuses that rather than dividing by 12 to
     "repair" it: a plausible wrong price on a customer-facing quote is worse than a
     stop. See lib/renewals/renewal-term.ts. */
  /* By ID first — it survives a rename, the name does not. See CreateRenewalQuoteInput.itemId.
     The name lookup is kept as the fallback for rows written before item_id existed. */
  const catalogItem = await (async () => {
    if (input.itemId) {
      const { data } = await supabase
        .from("items")
        .select("msrp, wholesale")
        .eq("tenant_id", input.tenantId)
        .eq("id", input.itemId)
        .maybeSingle();
      if (data) return data;
      /* Loud: an item_id that resolves to nothing means the catalogue row was deleted under a
         live subscription, which is a bigger problem than this renewal. */
      console.error(
        `[renewals] subscription ${input.subscriptionId} points at item ${input.itemId}, ` +
          "which no longer exists — falling back to matching on the plan NAME",
      );
    }
    const { data } = await supabase
      .from("items")
      .select("msrp, wholesale")
      .eq("tenant_id", input.tenantId)
      .eq("name", input.plan)
      .maybeSingle();
    return data;
  })();

  const term = renewalTerm({
    mrr: input.mrr,
    termMonths: input.termMonths ?? null,
    seats: input.seats,
    catalogPerSeatMonth: (catalogItem as { msrp?: number | null } | null)?.msrp ?? null,
  });

  if (!term.ok) {
    /* Loud, and it returns null — the same shape every other failure here uses, so the
       cron logs it and moves on to the next subscription instead of dying. A renewal
       nobody quoted is recoverable; a renewal quoted at 144x is not. */
    console.error(`[renewals] subscription ${input.subscriptionId}: ${term.reason}`);
    return null;
  }

  const annualAmount = term.subtotal;                                  // ex-GST subtotal for the term
  const grossAnnual  = grossAmount(annualAmount, renewalTaxRate);      // GST-inclusive payable (or ex-GST for export)
  const perSeatRate  = term.perSeatRate;

  /* R-012 (Pawan, 26 Sep 2026). This was `annualAmount * 0.83` — a hardcoded 17% margin
     standing in for the vendor's real price, so every renewal quote reported a 17%
     margin because it was DEFINED to be 17%. On Business Starter the real wholesale is
     ₹110/seat/month and the guess said about ₹224. Now it is read from the catalogue,
     for the term the renewal actually covers, or admitted as unknown. */
  const cost = renewalCost({
    wholesalePerSeatMonth: (catalogItem as { wholesale?: number | null } | null)?.wholesale ?? null,
    termMonths:            term.termMonths,
    seats:                 input.seats,
  });
  if (!cost.known) {
    /* Not fatal — a bespoke plan legitimately has no catalogue row, and the customer
       still needs their renewal. It travels as 0, which `approval-economics` already
       reads as `costUnknown` rather than as free, and it is said out loud here so the
       cron log names the plan whose price is missing. */
    console.warn(
      `[renewals] subscription ${input.subscriptionId} (${input.plan}): cost not priced — ${cost.reason}. ` +
        "The quote goes out with cost unknown; margin on it is not a number anybody should read.",
    );
  }
  const perSeatCost = cost.perSeat;

  const lineItems: QuoteLineItem[] = [{
    id:         "renewal-1",
    name:       input.plan,
    qty:        input.seats,
    rate:       perSeatRate,
    cost:       perSeatCost,
    /* From the term, not hardcoded: record_payment reads this to decide what
       subscription to build on the way back in, so calling a one-month renewal an
       annual commitment produces the wrong one. */
    commitment: term.commitment,
  }];

  const renewalAt   = new Date(input.renewalDate);
  const validUntil  = new Date(renewalAt.getTime() + (input.graceDays ?? 0) * 86400000);

  const { error: insertErr } = await supabase.from("quotes").insert({
    id:             newQuoteId,
    tenant_id:      input.tenantId,
    customer_id:    input.customerId,
    customer_name:  input.customerName,
    plan:           input.plan,
    seats:          input.seats,
    amount:         grossAnnual,
    status:         "sent",
    payment_status: "awaiting",
    owner_id:       null,
    /* R-012, third item. These were `new Date().toISOString().slice(0, 10)`, which is
       UTC — so between midnight and 05:30 IST every renewal quote was stamped with
       YESTERDAY's date, and its validity window with it (AGENTS.md §6). The renewals
       cron runs at 09:00 IST so it never saw this, but "Generate renewal quote" from
       the subscription page is pressed by a person, and reps here work early. */
    created_date:   istToday(),
    expires_date:   toIstDate(validUntil),
    line_items:     lineItems,
    subtotal:       annualAmount,
    total_cost:     cost.total,
    discount_pct:   0,
    tax_rate:       renewalTaxRate,   // 0 for an export (zero-rated) customer
    is_renewal:       true,  // ← Drives the "Renewal" badge in /quotes list + detail + PDF
    /* R-012, and this is the one that took money. It was a hardcoded 12 while the price
       and the commitment beside it already came from the subscription's own term — so a
       MONTHLY renewal was priced for one month and then extended the subscription by a
       YEAR, because `record_payment` reads this field to roll the dates forward.
       Measured by Pawan on a ₹250/month hosting subscription: paid ₹295, renewal date
       went to 25 Oct 2027 instead of 25 Nov 2026 and the MRR fell 250 → 21.
       `createExtensionQuote` keeps its own 24/36 and is deliberately untouched. */
    extension_months: term.termMonths,
    notes:            input.notes
      ?? `Renewal quote for subscription ${input.subscriptionId}`,
  });
  if (insertErr) return null;

  // Link back to subscription
  await supabase
    .from("subscriptions")
    .update({ renewal_quote_id: newQuoteId })
    .eq("id", input.subscriptionId);

  return {
    quoteId:     newQuoteId,
    amount:      grossAnnual,
    subtotal:    annualAmount,
    discountPct: 0,
    taxRate:     renewalTaxRate,
    lineItems,
    created:     true,
  };
}
