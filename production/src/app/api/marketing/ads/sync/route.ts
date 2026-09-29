/** POST /api/marketing/ads/sync — pull spend from every enabled ad account now. */
import { createAdminClient } from "@/lib/supabase/server";
import { syncTenantAds } from "@/lib/marketing/ad-sync";
import { withRoute, RouteError } from "@/lib/api/with-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export const POST = withRoute(
  { route: "api/marketing/ads/sync", roles: ["owner", "manager"] },
  async ({ tenantId }) => {
    try {
      const r = await syncTenantAds(createAdminClient(), tenantId, "manual");
      return { ...r, ok: r.errors.length === 0 };
    } catch (e) {
      throw new RouteError(502, (e as Error).message || "Sync failed");
    }
  },
);
