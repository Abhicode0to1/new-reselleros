/**
 * POST /api/marketing/gbp/sync — pull listings, reviews and performance from Google now.
 * Uses the token of whoever connected the listing for this tenant (any owner/manager may
 * press the button). The nightly cron does the same for every tenant.
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { syncTenantGbp } from "@/lib/google/gbp-api";

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

  const admin = createAdminClient();
  const { data: loc } = await admin.from("gbp_locations").select("connected_user_id").eq("tenant_id", me.tenant_id).limit(1).maybeSingle();
  const syncUser = loc?.connected_user_id ?? user.id;
  try {
    const result = await syncTenantGbp(admin, syncUser, me.tenant_id, "manual");
    return NextResponse.json({ ok: result.errors.length === 0, ...result });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || "Sync failed" }, { status: 502 });
  }
}
