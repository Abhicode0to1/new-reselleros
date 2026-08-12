/**
 * GET /api/inbound-emails
 *
 * Tenant-scoped server endpoint for fetching inbound emails.
 * Uses admin client scoped strictly to caller's tenant_id to prevent RLS
 * function execution permission errors on public.current_tenant_id().
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const { data: me } = await supabase
    .from("users")
    .select("tenant_id")
    .eq("id", user.id)
    .maybeSingle();

  if (!me?.tenant_id) {
    return NextResponse.json([]);
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("inbound_emails")
    .select("*")
    .eq("tenant_id", me.tenant_id)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[api/inbound-emails] GET error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data ?? []);
}
