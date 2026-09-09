/**
 * Who may CHANGE a domain's registrar-side state.
 *
 * ─── WHY THIS IS NOT LEFT TO RLS ─────────────────────────────────────────────
 * RLS is the right authority for the database and the wrong one for this, and
 * the difference is the order things happen in.
 *
 * A DNS write goes to ResellerClub FIRST and is mirrored into `dns_records`
 * only once RC has accepted it — because the reverse order displays a zone the
 * internet does not have. That ordering means the row-level policy fires AFTER
 * the upstream change is already real. `dns_records_select_own_customer` makes a
 * portal customer read-only in the TABLE, but a customer POSTing to the DNS API
 * would still have reached RC and created the record before the insert was
 * refused: a live change to a zone, by somebody with no right to make it, and no
 * local trace of who did it.
 *
 * So writes get an explicit check, before any side effect. RLS still guards the
 * table underneath — this is a second gate in front of a different door, not a
 * replacement for the first.
 *
 * Found 9 Sep 2026 while writing the end-to-end test for the DNS routes: the
 * test was going to prove "a customer cannot add a record", and the honest
 * answer was that they could not SAVE one, which is not the same sentence.
 */
import type { createClient } from "@/lib/supabase/server";

export type DomainWriteAuthz =
  | { ok: true; tenantId: string; userId: string }
  | { ok: false; status: 401 | 403; error: string };

/**
 * True only for a signed-in STAFF user of the tenant that owns the domain.
 *
 * Staff are the rows in `users`; portal customers live in `customer_users` and
 * have no row here at all, so the absence of one is the check. Comparing the
 * tenant explicitly matters as well — a staff user of tenant A must not edit
 * tenant B's zone, and the upstream call would not know the difference.
 */
export async function authorizeDomainWrite(
  supabase: ReturnType<typeof createClient>,
  domainTenantId: string,
): Promise<DomainWriteAuthz> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 401, error: "Not signed in." };

  const { data: staff } = await supabase
    .from("users")
    .select("id, tenant_id, is_active")
    .eq("id", user.id)
    .maybeSingle();

  if (!staff) {
    /* A portal customer, or somebody with an auth account and no staff record. */
    return {
      ok: false,
      status: 403,
      error: "DNS records are managed by the team that sold you the domain. Raise a request and they will make the change.",
    };
  }
  if (staff.is_active === false) {
    return { ok: false, status: 403, error: "This account is no longer active." };
  }
  if (staff.tenant_id !== domainTenantId) {
    return { ok: false, status: 403, error: "This domain belongs to another organisation." };
  }

  return { ok: true, tenantId: staff.tenant_id, userId: user.id };
}
