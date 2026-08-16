/**
 * Add seats to a subscription: the one place that decides the tax treatment and the
 * term length before calling `addSeats()`.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Two routes now add seats — the operator's Add Seats dialog and a customer request
 * approved from the queue. Both need the same two derivations, and both are wrong in
 * expensive ways if they drift:
 *
 *   taxRatePct  add-seats used to multiply by a hardcoded 1.18, so an export customer
 *               was billed ₹2,135 of GST on a zero-rated ₹11,836 expansion.
 *   termDays    it was hardcoded to 365, so a two-year term with 400 days left billed
 *               as a full year — ₹21,600 instead of ₹11,836.
 *
 * Both are recorded in add-seats.ts as bugs that were found and fixed. Copying the
 * fixed versions into a second route is how they come back: one copy gets a
 * correction, the other does not, and the two paths quietly bill different amounts
 * for the same change.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { addSeats, type AddSeatsResult, type AddSeatsError } from "./add-seats";
import { daysBetweenDates } from "./proration";
import { isExportSupply } from "@/lib/gst/place-of-supply";

type Admin = SupabaseClient<Database>;

export interface SeatIncreaseSubject {
  id: string;
  tenant_id: string;
  customer_id: string | null;
  customer_name: string;
  plan: string;
  vendor: "google" | "microsoft" | "zoho" | "other" | "domain" | "hosting" | "support";
  domain: string | null;
  seats: number;
  mrr: number;
  item_id: string | null;
  start_date: string | null;
  renewal_date: string | null;
  status: string;
}

/**
 * Derive the customer's GST rate.
 *
 * `isExportSupply` is conservative: an unknown country counts as domestic, so a
 * missing country over-charges rather than under-charges and is never silently
 * zero-rated.
 */
export async function resolveTaxRatePct(supabase: Admin, customerId: string | null): Promise<number> {
  if (!customerId) return 18;
  const { data } = await supabase.from("customers").select("country").eq("id", customerId).maybeSingle();
  return isExportSupply(data?.country) ? 0 : 18;
}

/**
 * The length of THIS term, not an assumed year.
 *
 * Falls back to 365 when start_date is missing — guessing 730 would over-charge, and
 * over-charging silently is the worse failure of the two.
 */
export function resolveTermDays(startDate: string | null, renewalDate: string): number {
  return startDate ? Math.max(1, daysBetweenDates(startDate, renewalDate)) : 365;
}

/** Add `additionalSeats` to `sub`, with tax and term derived once, here. */
export async function applySeatIncrease(args: {
  supabase: Admin;
  sub: SeatIncreaseSubject;
  additionalSeats: number;
  graceDays: number;
}): Promise<AddSeatsResult | AddSeatsError> {
  const { supabase, sub, additionalSeats, graceDays } = args;

  if (!sub.renewal_date) {
    return { ok: false, code: "no_renewal_date", message: "subscription has no renewal_date" };
  }

  const taxRatePct = await resolveTaxRatePct(supabase, sub.customer_id);
  const termDays = resolveTermDays(sub.start_date, sub.renewal_date);

  return addSeats({
    supabase,
    subscriptionId: sub.id,
    tenantId:       sub.tenant_id,
    customerId:     sub.customer_id,
    customerName:   sub.customer_name,
    plan:           sub.plan,
    vendor:         sub.vendor,
    itemId:         sub.item_id,
    domain:         sub.domain,
    currentSeats:   sub.seats,
    currentMrr:     sub.mrr,
    additionalSeats,
    renewalDate:    sub.renewal_date,
    graceDays,
    taxRatePct,
    termDays,
  });
}

/** The columns applySeatIncrease needs — shared so both callers select the same set. */
export const SEAT_INCREASE_SELECT =
  "id, tenant_id, customer_id, customer_name, plan, vendor, domain, seats, mrr, item_id, start_date, renewal_date, status" as const;
