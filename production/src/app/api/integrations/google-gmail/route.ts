/**
 * GET /api/integrations/google-gmail — can this workspace actually send?
 *
 * ─── WHY "CONNECTED" IS NOT THE QUESTION ─────────────────────────────────────
 * The contacts status route answers "is there a refresh token", and for contacts
 * that is enough. For sending it is not, and the difference is the whole reason
 * this route exists.
 *
 * A user can finish the consent flow having unticked "Send email on your
 * behalf". Google stores the grant, the refresh token works, every status screen
 * says Connected — and the first renewal reminder fails with a 403. At that
 * point it looks like a Gmail outage rather than a permission nobody granted.
 *
 * So `canSend` is computed from the scopes actually recorded on the token, by
 * the same function the send path uses. One source of truth, checked where
 * somebody can see it rather than at 6am inside a cron.
 *
 * Returns no token and no scope values a caller could act on beyond the boolean
 * — the granted scope list is returned for display because it is not a secret
 * (it is visible in the OAuth callback URL), but the tokens never are.
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { googleOAuthCreds } from "@/lib/google/oauth";
import { canSendWithScopes, GMAIL_SEND_SCOPE } from "@/lib/email/provider";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const admin = createAdminClient();
  const { data } = await admin
    .from("user_google_tokens")
    .select("google_email, refresh_token, scopes, last_error")
    .eq("user_id", user.id)
    .maybeSingle();

  const scopes = (data?.scopes ?? null) as string | null;
  const connected = Boolean(data?.refresh_token);

  return NextResponse.json({
    configured: !!googleOAuthCreds(),
    connected,
    email: data?.google_email ?? null,
    /** NULL scopes means the token predates the column — unknown, not empty. */
    scopesKnown: scopes !== null,
    grantedScopes: scopes,
    canSend: connected && canSendWithScopes(scopes),
    requiredScope: GMAIL_SEND_SCOPE,
    lastError: data?.last_error ?? null,
    /**
     * Said in words so the UI does not have to invent the explanation, and so
     * the two failure modes stay distinguishable: "never connected" and
     * "connected but cannot send" need completely different next steps.
     */
    reason: !connected
      ? "No Google account is connected for this user."
      : scopes === null
        ? "This account was connected before send permission was tracked. Reconnect to record it."
        : canSendWithScopes(scopes)
          ? "Ready to send."
          : "Connected, but send permission was not granted. Reconnect and leave “Send email on your behalf” ticked.",
  });
}
