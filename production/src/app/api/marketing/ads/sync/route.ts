/** POST /api/marketing/ads/sync — pull spend from every enabled ad account now. */
import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { syncTenantAds } from "@/lib/marketing/ad-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { data: me } = await supabase.from("users").select("tenant_id, role").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) return NextResponse.json({ error: "No tenant." }, { status: 400 });
  if (!["owner", "manager"].includes((me as { role?: string }).role ?? "")) return NextResponse.json({ error: "Owner/manager only." }, { status: 403 });
  try {
    const r = await syncTenantAds(createAdminClient(), me.tenant_id, "manual");
    return NextResponse.json({ ok: r.errors.length === 0, ...r });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || "Sync failed" }, { status: 502 });
  }
}
