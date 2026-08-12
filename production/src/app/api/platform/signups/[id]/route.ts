/**
 * /api/platform/signups/[id] — FOUNDER-ONLY Tenant Management API (DELETE & PATCH).
 *
 * Gated HARD: Caller must be authenticated AND email must be in `isPlatformAdmin` allowlist.
 * - DELETE: Permanently cascade deletes tenant data (gated against self-deletion).
 * - PATCH: Updates tenant metadata (Name, Tier, GSTIN, State, Phone, Activation status).
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/platform";

// DELETE handler: Delete reseller workspace
export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const tenantId = params.id;
  if (!tenantId) return NextResponse.json({ error: "Missing tenant ID." }, { status: 400 });

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!isPlatformAdmin(user.email)) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }

  const admin = createAdminClient();

  // Fetch target tenant details
  const { data: targetTenant, error: fetchErr } = await admin
    .from("tenants")
    .select("id, name")
    .eq("id", tenantId)
    .single();

  if (fetchErr || !targetTenant) {
    return NextResponse.json({ error: "Tenant not found." }, { status: 404 });
  }

  // Prevent self-deletion of main platform workspace (Anutech Digital)
  if (targetTenant.name.toLowerCase().includes("anutech digital")) {
    return NextResponse.json(
      { error: "Cannot delete the primary Anutech Digital platform workspace." },
      { status: 400 }
    );
  }

  // Cascade delete tenant records
  try {
    await admin.from("users").delete().eq("tenant_id", tenantId);
    await admin.from("customers").delete().eq("tenant_id", tenantId);
    await admin.from("quotes").delete().eq("tenant_id", tenantId);
    await admin.from("invoices").delete().eq("tenant_id", tenantId);
    await admin.from("inbound_emails").delete().eq("tenant_id", tenantId);
    
    // Finally delete tenant row
    const { error: deleteErr } = await admin.from("tenants").delete().eq("id", tenantId);
    if (deleteErr) throw deleteErr;

    return NextResponse.json({ success: true, message: `Workspace '${targetTenant.name}' permanently deleted.` });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to delete tenant." }, { status: 500 });
  }
}

// PATCH handler: Update reseller workspace details
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const tenantId = params.id;
  if (!tenantId) return NextResponse.json({ error: "Missing tenant ID." }, { status: 400 });

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!isPlatformAdmin(user.email)) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const { name, tier, gstin, state, phone, activated } = body;

  const admin = createAdminClient();

  const updates: Record<string, any> = {};
  if (name !== undefined) updates.name = name.trim();
  if (tier !== undefined) updates.tier = tier;
  if (gstin !== undefined) updates.gstin = gstin ? gstin.trim().toUpperCase() : null;
  if (state !== undefined) updates.state = state ? state.trim() : null;
  if (phone !== undefined) updates.phone = phone ? phone.trim() : null;
  if (activated !== undefined) {
    updates.setup_completed_at = activated ? new Date().toISOString() : null;
  }

  const { data: updatedTenant, error: updateErr } = await admin
    .from("tenants")
    .update(updates as any)
    .eq("id", tenantId)
    .select()
    .single();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message || "Failed to update tenant." }, { status: 500 });
  }

  return NextResponse.json({ success: true, tenant: updatedTenant, message: "Workspace updated successfully." });
}
