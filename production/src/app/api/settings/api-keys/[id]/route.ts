/**
 * DELETE /api/settings/api-keys/{id} → revoke a key (soft: sets revoked_at).
 * Owner-only, tenant-scoped (RLS). A revoked key is rejected by /api/v1 auth.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: me } = await supabase
    .from("users").select("role").eq("id", authData.user.id).single();
  if (me?.role !== "owner") {
    return NextResponse.json({ error: "Only the owner can revoke API keys" }, { status: 403 });
  }

  const { error } = await supabase
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ revoked: true });
}
