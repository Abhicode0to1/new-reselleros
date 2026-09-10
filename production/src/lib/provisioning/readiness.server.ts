import "server-only";
import { provisioningReadiness, type PathReadiness } from "./readiness";
import { rcWriteConfigured } from "@/lib/resellerclub/call";
import { daWriteConfigured } from "@/lib/directadmin/provision";
import { createAdminClient } from "@/lib/supabase/server";
import { decryptTenantSecrets } from "@/lib/crypto/tenant-secrets";

/**
 * `provisioningReadiness()` with this deployment's facts filled in.
 *
 * Split from the pure function so every combination stays testable without
 * touching the environment — the combination that costs money is not one anybody
 * sets deliberately, so it has to be reachable in a test.
 *
 * ─── WHY canCollect IS RESOLVED PER TENANT ───────────────────────────────────
 * ResellerClub and DirectAdmin are server-wide (Cloud Run env vars), but Razorpay
 * is NOT: `tenant_secrets` holds per-tenant keys and `process.env` is only the
 * legacy single-tenant fallback. So "can this tenant charge somebody" has to be
 * asked of the tenant, and asking the environment alone would answer `false` for
 * a reseller who has their own live key — turning the urgent warning into a
 * reassuring one for exactly the tenant who is taking money.
 *
 * Errors resolve to canCollect = TRUE. That is deliberate and it is the safe
 * direction: an unreadable secret means we do not know whether money can be
 * taken, and the cost of over-warning is somebody reading a banner they did not
 * need, while the cost of under-warning is a customer charged for a domain
 * nobody will register.
 */
export async function deploymentProvisioningReadiness(tenantId: string): Promise<{
  domain: PathReadiness;
  hosting: PathReadiness;
}> {
  let canCollect = true;
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("tenant_secrets")
      .select("*")
      .eq("tenant_id", tenantId)
      .maybeSingle();

    const secrets = data ? decryptTenantSecrets(data as Record<string, unknown>) : null;
    const keyId =
      (secrets?.razorpay_key_id as string | undefined)?.trim() ||
      process.env.RAZORPAY_KEY_ID?.trim() ||
      process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID?.trim() ||
      "";
    const keySecret =
      (secrets?.razorpay_key_secret as string | undefined)?.trim() ||
      process.env.RAZORPAY_KEY_SECRET?.trim() ||
      "";

    canCollect = keyId.length > 0 && keySecret.length > 0;
  } catch (e) {
    console.error("[provisioning-readiness] could not resolve Razorpay keys:", (e as Error).message);
    /* See the header: unknown means assume money CAN be taken. */
    canCollect = true;
  }

  return provisioningReadiness({
    rcConfigured: rcWriteConfigured(),
    domainRegisterLive: process.env.DOMAIN_REGISTER_LIVE === "1",
    daConfigured: daWriteConfigured(),
    hostingTrialLive: process.env.HOSTING_TRIAL_LIVE === "1",
    canCollect,
  });
}
