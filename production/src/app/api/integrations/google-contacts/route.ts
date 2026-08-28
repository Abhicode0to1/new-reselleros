/**
 * Google Contacts integration status + disconnect.
 *
 *   GET    → { connected, can_sync, email, last_synced_at, last_error, configured }
 *            (never returns tokens, and never returns the raw scope string either —
 *             the browser needs the ANSWER, not the evidence)
 *   DELETE → disconnect (removes the stored tokens for this user)
 *
 * Reads/writes go through the service-role admin client (the token table is
 * RLS-locked); the caller is always identified by their own session.
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { googleOAuthCreds } from "@/lib/google/oauth";
import { canSyncWithScopes } from "@/lib/google/contacts-card-state";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const admin = createAdminClient();
  const { data } = await admin
    .from("user_google_tokens")
    .select("google_email, refresh_token, last_synced_at, last_error, scopes")
    .eq("user_id", user.id)
    .maybeSingle();

  /* `connected` aur `can_sync` ALAG hain, aur yahi is file ka asli kaam hai.
     28 Aug 2026 tak sirf `connected` tha — `!!refresh_token` — to ek aisa token jo
     bilkul theek authenticate hota hai par contacts padh hi nahi sakta, card par hara
     "Connected" ban jata tha. Row ka hona ek baat hai, us row se kaam hona doosri. */
  return NextResponse.json({
    configured: !!googleOAuthCreds(),
    connected: !!data?.refresh_token,
    can_sync: canSyncWithScopes(data?.refresh_token, data?.scopes as string | null),
    email: data?.google_email ?? null,
    last_synced_at: data?.last_synced_at ?? null,
    last_error: data?.last_error ?? null,
  });
}

export async function DELETE() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const admin = createAdminClient();
  const { error } = await admin.from("user_google_tokens").delete().eq("user_id", user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
