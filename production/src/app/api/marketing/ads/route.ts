/**
 * GET  /api/marketing/ads — what is configured / connected, per platform. No tokens.
 * PATCH /api/marketing/ads — { accountId, enabled } toggle (the only user-side write).
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { googleOAuthCreds } from "@/lib/google/oauth";
import { hasGoogleAdsScope } from "@/lib/google/scope-union";
import { googleAdsDeveloperToken } from "@/lib/google/google-ads-api";
import { metaAppCreds } from "@/lib/meta/meta-ads-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function whoami() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: me } = await supabase.from("users").select("tenant_id, role").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) return null;
  return { userId: user.id, tenantId: me.tenant_id as string, role: (me as { role?: string }).role ?? "" };
}

export async function GET() {
  const me = await whoami();
  if (!me) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const admin = createAdminClient();
  const { data: accounts } = await admin.from("ad_accounts")
    .select("id, platform, account_id, name, currency, enabled, connected_user_id, token_expires_at, last_synced_at, last_error")
    .eq("tenant_id", me.tenantId).order("platform").order("name");

  const googleUser = (accounts ?? []).find((a) => a.platform === "google-ads")?.connected_user_id ?? me.userId;
  const { data: tok } = await admin.from("user_google_tokens").select("google_email, refresh_token, scopes, last_error").eq("user_id", googleUser).maybeSingle();
  const googleConnected = Boolean(tok?.refresh_token) && hasGoogleAdsScope(tok?.scopes);
  const metaRows = (accounts ?? []).filter((a) => a.platform === "meta-ads");
  const metaExpiry = metaRows.map((a) => a.token_expires_at).filter(Boolean).sort()[0] ?? null;

  return NextResponse.json({
    google: {
      configured: !!googleOAuthCreds(), devToken: !!googleAdsDeveloperToken(), connected: googleConnected,
      email: googleConnected ? tok?.google_email ?? null : null,
      lastError: tok?.last_error ?? null,
    },
    meta: { configured: !!metaAppCreds(), connected: metaRows.length > 0, tokenExpiresAt: metaExpiry },
    accounts: (accounts ?? []).map((a) => ({ id: a.id, platform: a.platform, account_id: a.account_id, name: a.name, currency: a.currency, enabled: a.enabled, last_synced_at: a.last_synced_at, last_error: a.last_error })),
  });
}

export async function PATCH(request: NextRequest) {
  const me = await whoami();
  if (!me) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!["owner", "manager"].includes(me.role)) return NextResponse.json({ error: "Owner/manager only." }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { accountId?: string; enabled?: boolean };
  if (!body.accountId || typeof body.enabled !== "boolean") return NextResponse.json({ error: "accountId + enabled chahiye." }, { status: 400 });
  const { error } = await createAdminClient().from("ad_accounts").update({ enabled: body.enabled, updated_at: new Date().toISOString() }).eq("id", body.accountId).eq("tenant_id", me.tenantId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
