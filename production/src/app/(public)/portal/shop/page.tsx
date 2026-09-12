/**
 * /portal/shop — cross-sell catalog for the logged-in customer.
 *
 * Two catalogues, because two things are sold two different ways:
 *
 *   · SEAT LICENCES — portal_list_products(). Priced per user per month, and
 *     "Request a quote" raises a lead in the reseller's pipeline via
 *     portal_request_quote(). No payment is taken for these.
 *   · WEB HOSTING — portal_list_hosting_plans(). One account on one domain,
 *     priced per month, and PAID FOR HERE (Pardeep, 12 Sep 2026: "Put hosting in
 *     the portal shop, so a logged-in customer can buy without going back to the
 *     marketing site"). See hosting-buy.tsx and /api/portal/checkout/hosting.
 *
 * Both are SECURITY DEFINER RPCs returning customer-safe fields only — the
 * reseller's wholesale and margin never leave the DB.
 */
import { requirePortalSession } from "@/lib/portal/session";
import { createClient } from "@/lib/supabase/server";
import { ShopClient } from "./shop-client";

export const dynamic = "force-dynamic";

export default async function PortalShopPage() {
  const session  = await requirePortalSession();
  const supabase = createClient();

  /* In parallel: they are independent reads and the page cannot render until
     both are in. */
  const [{ data: products }, { data: hostingPlans }] = await Promise.all([
    supabase.rpc("portal_list_products"),
    supabase.rpc("portal_list_hosting_plans"),
  ]);

  // Flag plans the customer already runs, so we can mark them "Current plan".
  const { data: subs } = await supabase
    .from("subscriptions")
    .select("plan, status")
    .eq("status", "active");
  const ownedPlans = (subs ?? []).map((s) => s.plan);

  return (
    <ShopClient
      products={products ?? []}
      hostingPlans={(hostingPlans ?? []).map((p) => ({
        ...p,
        /* `features` arrives as jsonb. Normalised here rather than in the card,
           so a malformed row cannot crash the render — it just shows no bullets. */
        features: Array.isArray(p.features) ? (p.features as unknown[]).filter((f): f is string => typeof f === "string") : [],
      }))}
      ownedPlans={ownedPlans}
      customerEmail={session.userEmail}
      resellerName={session.tenantName}
      resellerPhone={session.tenantPhone}
    />
  );
}
