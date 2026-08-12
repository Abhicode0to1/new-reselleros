/**
 * GET /api/platform/signups — FOUNDER-ONLY cross-tenant signup list.
 *
 * Every other read in the app is RLS-scoped to one tenant. This route is the
 * one deliberate exception: it uses the service-role admin client to list ALL
 * tenants who signed up for ResellerOS. It is gated HARD — the caller must be
 * authenticated AND their email must be in the platform-admin allowlist, or it
 * 403s before the admin client is ever created. No tenant can reach this.
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/platform";

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!isPlatformAdmin(user.email)) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }

  const admin = createAdminClient();
  
  // Fetch tenants, public users, customers, and auth users in parallel
  const [{ data: tenants, error: tErr }, { data: users }, { data: customers }, authUsersRes] = await Promise.all([
    admin.from("tenants").select("id, name, email, phone, created_at, tier, gstin, state, setup_completed_at").order("created_at", { ascending: false }),
    admin.from("users").select("id, tenant_id, role, full_name, email"),
    admin.from("customers").select("tenant_id"),
    admin.auth.admin.listUsers().catch(() => ({ data: { users: [] } })),
  ]);

  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 });

  // Map auth users by ID
  const authMap = new Map<string, { email?: string | null; phone?: string | null; name?: string | null }>();
  const authUsers = authUsersRes && "data" in authUsersRes && authUsersRes.data?.users ? authUsersRes.data.users : [];
  
  for (const au of authUsers) {
    const meta = au.user_metadata || {};
    const name = meta.full_name || meta.name || meta.display_name || au.email?.split("@")[0] || null;
    const phone = au.phone || meta.phone || meta.mobile || meta.contact_phone || null;
    authMap.set(au.id, { email: au.email, phone, name });
  }

  // Map users per tenant: prioritize owner role, fallback to any user
  const ownerByTenant = new Map<string, { name: string; email: string | null; phone: string | null }>();
  const firstUserByTenant = new Map<string, { name: string; email: string | null; phone: string | null }>();
  const userCount = new Map<string, number>();

  for (const u of users ?? []) {
    userCount.set(u.tenant_id, (userCount.get(u.tenant_id) ?? 0) + 1);
    
    // Resolve email & phone from authMap if public.users is missing it
    const au = authMap.get(u.id);
    const resolvedName = u.full_name || au?.name || u.email?.split("@")[0] || "—";
    const resolvedEmail = u.email || au?.email || null;
    const resolvedPhone = au?.phone || null;

    const userInfo = { name: resolvedName, email: resolvedEmail, phone: resolvedPhone };

    if (!firstUserByTenant.has(u.tenant_id)) {
      firstUserByTenant.set(u.tenant_id, userInfo);
    }

    if (u.role === "owner" && !ownerByTenant.has(u.tenant_id)) {
      ownerByTenant.set(u.tenant_id, userInfo);
    }
  }

  const custCount = new Map<string, number>();
  for (const c of customers ?? []) custCount.set(c.tenant_id, (custCount.get(c.tenant_id) ?? 0) + 1);

  const rows = (tenants ?? []).map((t) => {
    const ownerData = ownerByTenant.get(t.id) || firstUserByTenant.get(t.id);
    const email = ownerData?.email || t.email || null;
    const phone = t.phone || ownerData?.phone || null;

    return {
      id: t.id,
      name: t.name,
      owner: ownerData?.name ?? "—",
      email,
      phone,
      signedUp: t.created_at,
      tier: t.tier,
      gstin: t.gstin,
      state: t.state,
      activated: Boolean(t.setup_completed_at),
      users: userCount.get(t.id) ?? 0,
      customers: custCount.get(t.id) ?? 0,
    };
  });

  return NextResponse.json({ count: rows.length, tenants: rows });
}
