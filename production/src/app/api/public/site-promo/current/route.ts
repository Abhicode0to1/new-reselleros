/**
 * GET /api/public/site-promo/current?tier=standard&seats=10
 *
 * Public, no-auth endpoint that returns the buy-page's currently-active
 * site promo (if any). Used by the /buy/workspace page on mount + on
 * every tier/seat change so the banner + auto-applied discount stay in
 * sync.
 *
 * Query params (all optional):
 *   tier  — tier slug ('starter'|'standard'|...). Narrows the eligibility
 *           check; when omitted, returns the promo only if it's tier-agnostic.
 *   seats — number of seats. Narrows the min_seats / max_seats check.
 *
 * Response:
 *   { ok: true, promo: SitePromoRow | null, expires_in_seconds?: number }
 *
 * Caching:
 *   `force-dynamic` so Pardeep enabling/disabling a promo reflects within
 *   one TanStack Query refetch cycle (no CDN cache to wait out).
 */

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import type { SitePromoRow } from "@/lib/supabase/database.types";
import { publicDbError } from "@/app/api/public/_lib/db-error";

export const dynamic = "force-dynamic";
export const runtime  = "nodejs";

const BUY_PAGE_TENANT_ID =
  process.env.BUY_PAGE_TENANT_ID?.trim() || "fbb976f1-9090-4f10-9726-0901bd144e42";

export async function GET(req: NextRequest) {
  const url   = new URL(req.url);
  const tier  = url.searchParams.get("tier")?.toLowerCase().trim() || null;
  const seats = (() => {
    const v = url.searchParams.get("seats");
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  })();

  const admin = createAdminClient();
  // Direct query — service_role bypasses RLS, so we can read the table
  // straight. Simpler than the RPC (which had a composite-null-fields
  // serialization quirk through supabase-js — function returns a row
  // type with every field NULL when no row matches, instead of NULL).
  const nowIso = new Date().toISOString();
  let query = admin
    .from("site_promos")
    .select("*")
    .eq("tenant_id", BUY_PAGE_TENANT_ID)
    .eq("is_active", true)
    .lte("valid_from", nowIso)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (tier)  query = query.or(`applies_to_tier.is.null,applies_to_tier.eq.${tier}`);
  if (seats) query = query.lte("min_seats", seats);

  const { data, error } = await query.maybeSingle();
  if (error) {
    const e = publicDbError("site-promo/current", error, "We could not load the current offer just now.");
    return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
  }

  let promo = (data ?? null) as SitePromoRow | null;
  // Hand-filter the remaining conditions that don't translate cleanly to
  // .or() filters on Supabase (valid_until + max_seats null-or-bound).
  if (promo) {
    if (promo.valid_until && new Date(promo.valid_until).getTime() <= Date.now()) promo = null;
    if (promo && promo.max_seats != null && seats && seats > promo.max_seats)     promo = null;
  }

  let expires_in_seconds: number | undefined;
  if (promo?.valid_until) {
    const diff = new Date(promo.valid_until).getTime() - Date.now();
    expires_in_seconds = Math.max(0, Math.floor(diff / 1000));
  }

  return NextResponse.json({ ok: true, promo, expires_in_seconds });
}
