/**
 * Add-seats flow — mid-term seat expansion with pro-rata billing.
 *
 * Customer is mid-way through their term and wants to add N seats.
 * We can't bill the full annual rate for the new seats — only the
 * remaining portion until renewal_date. Pro-rata math:
 *
 *   pro_rata_factor = days_remaining / 365
 *   pro_rata_amount = annual_rate × additional_seats × pro_rata_factor
 *
 * Two writes happen atomically:
 *   1. subscription.seats += additional_seats
 *      subscription.mrr is recomputed (proportional bump)
 *   2. quotes row created — sent, awaiting payment, NOT a renewal/extension
 *
 * The quote is marked `is_add_seats=true` so record_payment SKIPS all
 * subscription handling for it (migration 0052). Without that flag record_payment
 * step 8a would treat the annual pro-rata quote as a new sale and create a
 * DUPLICATE subscription (audit bug #3/#4). The existing sub is already updated
 * above; the pro-rata payment just records into the ledger. This flow creates
 * its own draft PO below.
 *
 * Server-only (service-role client).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, QuoteLineItem } from "@/lib/supabase/database.types";
import { prorate, rupeesToPaise, paiseToRupees } from "./proration";

type SupabaseAdmin = SupabaseClient<Database>;

export interface AddSeatsInput {
  supabase:           SupabaseAdmin;
  subscriptionId:     string;
  tenantId:           string;
  customerId:         string | null;
  customerName:       string;
  plan:               string;
  vendor:             "google" | "microsoft" | "zoho" | "other";
  domain:             string | null;
  currentSeats:       number;
  currentMrr:         number;     // ₹/month per existing sub
  additionalSeats:    number;     // N
  renewalDate:        string;     // ISO / YYYY-MM-DD — drives pro-rata
  graceDays:          number;     // tenant.grace_period_days
  /**
   * GST percent for THIS customer. 18 domestic, 0 for a zero-rated export.
   *
   * REQUIRED, with no default, deliberately. This used to be a hardcoded `× 1.18`,
   * so an export customer was billed ₹2,135 of GST on a ₹11,836 seat expansion
   * that must not carry any — while isExportSupply() sat unused in lib/gst. A
   * default here would let the next caller reintroduce that silently.
   */
  taxRatePct:         number;
  /**
   * Length of the WHOLE current term in days — 365, 366 in a leap year, 730 for a
   * two-year deal. Also required, for the same reason: this was hardcoded to 365
   * and remaining days clamped to [0,365], so a two-year term with 400 days left
   * billed as a full year (₹21,600 instead of ₹11,836).
   */
  termDays:           number;
}

export interface AddSeatsResult {
  ok:           true;
  quoteId:      string;
  amount:       number;            // pro-rata GST-incl ₹
  proRataDays:  number;
  newSeats:     number;
  newMrr:       number;
  /** Newly created draft Purchase Order for the additional seats (null if catalog/vendor info missing) */
  poId:         string | null;
}

export interface AddSeatsError {
  ok:       false;
  code:     "invalid_seats" | "no_renewal_date" | "term_ended" | "no_doc_number" | "insert_failed" | "sub_update_failed";
  message:  string;
}

/**
 * Days between today and renewal_date. 0 or less means the term has ended → can't
 * pro-rata, the operator should renew instead.
 *
 * No longer clamped to 365 here. `prorate()` clamps to the ACTUAL term, which is
 * the whole point — clamping to a year is what made a two-year term bill as an
 * annual one.
 */
function daysToRenewal(renewalDate: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(renewalDate);
  target.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

export async function addSeats(input: AddSeatsInput): Promise<AddSeatsResult | AddSeatsError> {
  if (!Number.isFinite(input.additionalSeats) || input.additionalSeats < 1 || input.additionalSeats > 5000) {
    return { ok: false, code: "invalid_seats", message: "Additional seats must be between 1 and 5000" };
  }
  if (!input.renewalDate) {
    return { ok: false, code: "no_renewal_date", message: "Subscription has no renewal_date — extend or renew first" };
  }

  const days = daysToRenewal(input.renewalDate);
  if (days <= 0) {
    return { ok: false, code: "term_ended", message: "Term has ended — issue a renewal quote instead" };
  }

  // annual rate per seat (₹) from current MRR
  // currentMrr = ₹/month for the whole subscription (all currentSeats together)
  // annual per seat = (currentMrr × 12) / currentSeats
  const annualPerSeat = input.currentSeats > 0
    ? Math.round((input.currentMrr * 12) / input.currentSeats)
    : 0;

  /* Pro-rata now comes from proration.ts: one expression in integer paise, rounded
     ONCE, with the tax rate and the term length passed in. What changed in rupees
     is pinned case by case in add-seats-before-after.test.ts. */
  const charge = prorate({
    annualPerSeatPaise: rupeesToPaise(annualPerSeat),
    seats:              input.additionalSeats,
    remainingDays:      days,
    termDays:           input.termDays,
    taxRatePct:         input.taxRatePct,
  });

  const subtotalExGst = paiseToRupees(charge.subtotalPaise);
  const totalInclGst  = paiseToRupees(charge.totalPaise);
  // Per-seat rate for the quote LINE only — the subtotal above is never derived
  // from it. That multiplication is exactly the bug this replaced.
  const proRataPerSeat = paiseToRupees(charge.perSeatPaise);

  /* ⚠️ STILL AN ASSUMPTION, and not one this change fixes: 0.83 is a hardcoded
     17% margin, not the real vendor cost. It feeds the draft PO and therefore
     every margin figure downstream. Left as-is deliberately — replacing it needs
     the vendor price list, which is its own piece of work — but it is a guess
     wearing the clothes of a measurement. */
  const wholesalePerSeat = paiseToRupees(
    prorate({
      annualPerSeatPaise: rupeesToPaise(Math.round(annualPerSeat * 0.83)),
      seats:              1,
      remainingDays:      days,
      termDays:           input.termDays,
      taxRatePct:         0,
    }).subtotalPaise,
  );

  // Allocate quote number
  const { data: nextNumber, error: numErr } = await input.supabase.rpc("next_document_number", {
    p_doc_type:  "quote",
    p_tenant_id: input.tenantId,
  });
  if (numErr || !nextNumber) {
    return { ok: false, code: "no_doc_number", message: numErr?.message ?? "Could not allocate quote number" };
  }
  const newQuoteId = nextNumber as unknown as string;

  const lineItems: QuoteLineItem[] = [{
    id:         "add-seats-1",
    name:       `${input.plan} · +${input.additionalSeats} seats (pro-rata to ${input.renewalDate})`,
    qty:        input.additionalSeats,
    rate:       proRataPerSeat,
    cost:       wholesalePerSeat,
    commitment: "annual_yearly",
  }];

  const renewalAt   = new Date(input.renewalDate);
  const validUntil  = new Date(renewalAt.getTime() + (input.graceDays ?? 7) * 86400000);

  const { error: insertErr } = await input.supabase.from("quotes").insert({
    id:               newQuoteId,
    tenant_id:        input.tenantId,
    customer_id:      input.customerId,
    customer_name:    input.customerName,
    plan:             input.plan,
    seats:            input.additionalSeats,
    amount:           totalInclGst,
    status:           "sent",
    payment_status:   "awaiting",
    owner_id:         null,
    created_date:     new Date().toISOString().slice(0, 10),
    expires_date:     validUntil.toISOString().slice(0, 10),
    line_items:       lineItems,
    subtotal:         subtotalExGst,
    total_cost:       wholesalePerSeat * input.additionalSeats,
    discount_pct:     0,
    // The customer's actual rate, not a hardcoded 18 — a zero-rated export quote
    // must SAY zero, or the PDF and the GST return disagree with the amount.
    tax_rate:         input.taxRatePct,
    is_renewal:       false,
    is_add_seats:     true,   // 0052: record_payment skips sub handling → no duplicate sub
    extension_months: 0,
    // factorPpm is an integer (547945 = 54.7945%), so the note records the exact
    // fraction charged instead of a rounded float that cannot be reconciled.
    notes:            `Add-seats pro-rata for subscription ${input.subscriptionId}. ${charge.chargedDays} of ${input.termDays} days remaining (factor ${(charge.factorPpm / 10_000).toFixed(4)}%). GST ${input.taxRatePct}%.`,
  });
  if (insertErr) {
    return { ok: false, code: "insert_failed", message: insertErr.message };
  }

  // Update subscription seats + MRR immediately — operator has decided
  // to provision the additional seats now. Customer pays via normal quote flow.
  const newSeats = input.currentSeats + input.additionalSeats;
  const newMrr   = Math.round((annualPerSeat * newSeats) / 12);

  const { error: subErr } = await input.supabase
    .from("subscriptions")
    .update({ seats: newSeats, mrr: newMrr })
    .eq("id", input.subscriptionId);
  if (subErr) {
    return { ok: false, code: "sub_update_failed", message: subErr.message };
  }

  // ── Auto-create draft Purchase Order for the additional seats ─────
  // Same wholesale resolution as record_payment (catalog match → heuristic).
  // term_months ≈ days remaining / 30 — gives pro-rata months for Google.
  let poId: string | null = null;
  try {
    // Catalog match for wholesale ₹/seat/month
    const { data: item } = await input.supabase
      .from("items")
      .select("prices, wholesale")
      .eq("tenant_id", input.tenantId)
      .ilike("name", input.plan)
      .limit(1)
      .maybeSingle();

    const annualWholesale =
      (item?.prices as { annual?: { wholesale?: number } } | null)?.annual?.wholesale ?? 0;
    const fallbackWholesale = item?.wholesale ?? 0;
    const heuristicMonthly  = Math.round(annualPerSeat * 0.83 / 12);

    const unitCostPm =
      annualWholesale > 0   ? annualWholesale :
      fallbackWholesale > 0 ? fallbackWholesale :
                              heuristicMonthly;

    const termMonths     = Math.max(1, Math.round(days / 30));
    const totalCost      = unitCostPm * input.additionalSeats * termMonths;

    const { data: poNumber } = await input.supabase.rpc("next_document_number", {
      p_doc_type:  "purchase_order",
      p_tenant_id: input.tenantId,
    });
    if (poNumber) {
      const newPoId = poNumber as unknown as string;
      const { error: poErr } = await input.supabase.from("purchase_orders").insert({
        id:               newPoId,
        tenant_id:        input.tenantId,
        subscription_id:  input.subscriptionId,
        customer_id:      input.customerId,
        customer_name:    input.customerName,
        domain:           input.domain,
        vendor:           input.vendor,
        plan:             input.plan,
        seats:            input.additionalSeats,
        term_months:      termMonths,
        unit_cost_pm:     unitCostPm,
        total_cost:       totalCost,
        status:           "draft",
        notes:            `Auto-created for +${input.additionalSeats} seats added mid-term (pro-rata ${days} days). Quote ${newQuoteId}.`,
      });
      if (!poErr) poId = newPoId;
    }
  } catch {
    // PO is best-effort — don't fail the add-seats flow if procurement
    // side has an issue. Operator can manually create a PO from /purchase-orders.
  }

  return {
    ok:          true,
    quoteId:     newQuoteId,
    amount:      totalInclGst,
    proRataDays: days,
    newSeats,
    newMrr,
    poId,
  };
}
