/**
 * Link a freshly-authenticated auth user to the `customers` row that owns them.
 *
 * ─── WHY THIS IS SHARED ─────────────────────────────────────────────────────
 * Two routes need it: `/portal/auth/callback`, which every real customer comes
 * through, and the dev-only one-click sign-in added 11 Sep 2026. It decides
 * WHICH CUSTOMER'S DATA a session can read, so a second copy that drifted from
 * the first would be a cross-tenant leak waiting to happen. One implementation.
 *
 * ─── WHY IT USES THE SERVICE ROLE ───────────────────────────────────────────
 * A brand-new auth user has no `customer_users` row yet, and RLS keys a
 * customer's read of `customers` off exactly that row — so under the user's own
 * credentials this lookup returns nothing and every first login would fail.
 *
 * It does NOT sign the user out on failure. The caller does that, because "half
 * authenticated with no portal access" has to be cleaned up in the same place
 * that owns the redirect.
 */
import "server-only";
import { createAdminClient } from "@/lib/supabase/server";

export type LinkResult =
  | { ok: true; customerId: string; tenantId: string; alreadyLinked: boolean }
  | { ok: false; reason: "no_customer" | "link_failed"; detail?: string };

export async function linkAuthUserToCustomer(input: {
  authUserId: string;
  email: string;
}): Promise<LinkResult> {
  const admin = createAdminClient();

  /* Already linked? Checked first so a repeat sign-in is not an error and does
     not attempt a duplicate insert. */
  const { data: existing } = await admin
    .from("customer_users")
    .select("id, customer_id, tenant_id")
    .eq("auth_user_id", input.authUserId)
    .maybeSingle();

  if (existing) {
    return {
      ok: true,
      customerId: existing.customer_id,
      tenantId: existing.tenant_id,
      alreadyLinked: true,
    };
  }

  /* Case-insensitive: the address a customer types is not the casing we stored.
     `contact_email` is the same column `portal_customer_exists` gates the login
     form on, so the two cannot disagree about who is a customer. */
  const { data: customer } = await admin
    .from("customers")
    .select("id, tenant_id")
    .ilike("contact_email", input.email)
    .limit(1)
    .maybeSingle();

  if (!customer) return { ok: false, reason: "no_customer" };

  const { error } = await admin.from("customer_users").insert({
    tenant_id: customer.tenant_id,
    customer_id: customer.id,
    auth_user_id: input.authUserId,
    email: input.email,
    role: "admin",
    last_login_at: new Date().toISOString(),
  });

  if (error) return { ok: false, reason: "link_failed", detail: error.message };

  return { ok: true, customerId: customer.id, tenantId: customer.tenant_id, alreadyLinked: false };
}
