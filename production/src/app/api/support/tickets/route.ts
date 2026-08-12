/**
 * GET & PATCH /api/support/tickets — Cross-Tenant Support Desk & Bug Tracker.
 *
 * Platform Admins see ALL tickets and bug reports across all reseller workspaces.
 * Regular tenant users see their tenant-scoped tickets.
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/platform";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const scope = searchParams.get("scope") || "tenant_feedback";
  const statusFilter = searchParams.get("status") || "open";

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const isAdmin = isPlatformAdmin(user.email);
  const client = isAdmin ? createAdminClient() : supabase;

  // 1. Fetch user's tenant ID if not platform admin
  let tenantId: string | null = null;
  if (!isAdmin) {
    const { data: me } = await supabase.from("users").select("tenant_id").eq("id", user.id).single();
    tenantId = me?.tenant_id ?? null;
  }

  // 2. Build ticket query
  let q = client.from("support_tickets").select("*").order("created_at", { ascending: false });

  if (!isAdmin && tenantId) {
    q = q.eq("tenant_id", tenantId);
  }

  if (scope === "team_testing") {
    q = q.or("subject.ilike.[BUG]%,subject.ilike.[FEATURE]%,subject.ilike.[UI_IMPROVEMENT]%");
  } else {
    q = q.not("subject", "ilike", "[BUG]%").not("subject", "ilike", "[FEATURE]%").not("subject", "ilike", "[UI_IMPROVEMENT]%");
  }

  if (statusFilter !== "all") {
    q = q.eq("status", statusFilter);
  }

  const { data: tickets, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // 3. Compute counts across scope
  let countQ = client.from("support_tickets").select("status, subject");
  if (!isAdmin && tenantId) {
    countQ = countQ.eq("tenant_id", tenantId);
  }

  const { data: allTicketMeta } = await countQ;
  const counts: Record<string, number> = { all: 0, open: 0, in_progress: 0, awaiting_customer: 0, resolved: 0, closed: 0 };
  const scopeCounts = { tenant_feedback: 0, team_testing: 0 };

  for (const r of allTicketMeta ?? []) {
    const isTeam = r.subject && (r.subject.includes("[BUG]") || r.subject.includes("[FEATURE]") || r.subject.includes("[UI_IMPROVEMENT]"));
    
    if (isTeam) scopeCounts.team_testing += 1;
    else scopeCounts.tenant_feedback += 1;

    if (scope === "team_testing" && isTeam) {
      counts.all += 1;
      counts[r.status as string] = (counts[r.status as string] ?? 0) + 1;
    } else if (scope === "tenant_feedback" && !isTeam) {
      counts.all += 1;
      counts[r.status as string] = (counts[r.status as string] ?? 0) + 1;
    }
  }

  return NextResponse.json({ tickets: tickets ?? [], counts, scopeCounts });
}

export async function PATCH(request: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const isAdmin = isPlatformAdmin(user.email);
  const client = isAdmin ? createAdminClient() : supabase;

  const body = await request.json().catch(() => ({}));
  const { id, status, resolution_note } = body;

  if (!id) return NextResponse.json({ error: "Missing ticket ID" }, { status: 400 });

  const updates: Record<string, any> = {};
  if (status) updates.status = status;
  if (resolution_note !== undefined) updates.resolution_note = resolution_note;
  if (status === "resolved" || status === "closed") {
    updates.resolved_at = new Date().toISOString();
  }

  const { data: updated, error } = await client
    .from("support_tickets")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, ticket: updated });
}
