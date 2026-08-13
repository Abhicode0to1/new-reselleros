/**
 * GET /api/integrations/google-gmail/callback
 *
 * Completes the Gmail send consent and stores the token.
 *
 * ─── THE SCOPE CHECK IS THE POINT ────────────────────────────────────────────
 * Google can return a token for FEWER scopes than were asked for: the consent
 * screen lets a user untick individual permissions. So "the user finished the
 * flow" does not mean "we can send". If gmail.send is missing we say so here,
 * now, instead of storing a token that authenticates perfectly and fails with a
 * 403 the first time a renewal reminder tries to go out — at which point the
 * failure looks like a Gmail outage rather than a permission nobody granted.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import {
  googleOAuthCreds, originFromRequest, gmailRedirectUri, exchangeCode, fetchGoogleEmail,
} from "@/lib/google/oauth";
import { canSendWithScopes } from "@/lib/email/provider";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const origin = originFromRequest(request);
  const settings = `${origin}/settings?tab=integrations`;
  const url = new URL(request.url);

  const err  = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (err)   return NextResponse.redirect(`${settings}&gmail=denied`);
  if (!code) return NextResponse.redirect(`${settings}&gmail=error`);

  const cookieState = request.cookies.get("g_gmail_oauth_state")?.value;
  if (!cookieState || cookieState !== url.searchParams.get("state")) {
    return NextResponse.redirect(`${settings}&gmail=badstate`);
  }

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${origin}/login`);

  const creds = googleOAuthCreds();
  if (!creds) return NextResponse.redirect(`${settings}&gmail=notconfigured`);

  try {
    const tokens = await exchangeCode(code, gmailRedirectUri(origin), creds);

    // Refuse before storing anything. A half-granted connection that LOOKS
    // connected is worse than no connection: the tenant would switch their
    // provider to Gmail believing mail now works.
    if (!canSendWithScopes(tokens.scope)) {
      const res = NextResponse.redirect(`${settings}&gmail=noscope`);
      res.cookies.delete("g_gmail_oauth_state");
      return res;
    }

    const email = await fetchGoogleEmail(tokens.access_token);

    const { data: me } = await supabase
      .from("users").select("tenant_id").eq("id", user.id).maybeSingle();
    if (!me?.tenant_id) return NextResponse.redirect(`${settings}&gmail=error`);

    const admin = createAdminClient();
    const expiry = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString();

    // Same row as the contacts flow (one per user_id). refresh_token only comes
    // back on first consent, so an absent one must not overwrite the stored one
    // — doing that is how an integration works until the next token refresh and
    // then dies with no obvious cause.
    const patch = {
      user_id: user.id,
      tenant_id: me.tenant_id,
      google_email: email,
      access_token: tokens.access_token,
      token_expiry: expiry,
      scopes: tokens.scope ?? null,
      last_error: null,
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
    };

    const { error } = await admin
      .from("user_google_tokens")
      .upsert(patch, { onConflict: "user_id" });
    if (error) throw error;

    const res = NextResponse.redirect(`${settings}&gmail=connected`);
    res.cookies.delete("g_gmail_oauth_state");
    return res;
  } catch (e) {
    console.error("[google-gmail/callback] failed:", e);
    return NextResponse.redirect(`${settings}&gmail=error`);
  }
}
