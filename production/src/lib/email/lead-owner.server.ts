/**
 * The employee who owns a lead — the person a paid order's next-step email goes to (R-120).
 * leads.owner_id is set by the R-111 trigger (or a person). Same tenant, active user with an
 * email, or null — never a guess, and the caller then falls back to the tenant owner alert.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface LeadOwner { id: string; email: string; name: string }

export async function loadLeadOwner(
  admin: SupabaseClient, tenantId: string, leadId: string | null | undefined,
): Promise<LeadOwner | null> {
  if (!leadId) return null;
  const { data: lead } = await admin.from("leads").select("owner_id").eq("id", leadId).eq("tenant_id", tenantId).maybeSingle();
  const ownerId = (lead as { owner_id?: string | null } | null)?.owner_id;
  if (!ownerId) return null;
  const { data: u } = await admin.from("users").select("id, email, full_name, is_active").eq("id", ownerId).eq("tenant_id", tenantId).maybeSingle();
  const row = u as { id: string; email: string | null; full_name: string | null; is_active: boolean | null } | null;
  if (!row || row.is_active === false || !row.email) return null;
  return { id: row.id, email: row.email, name: row.full_name?.trim() || row.email };
}
