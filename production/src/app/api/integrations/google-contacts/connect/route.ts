/**
 * GET /api/integrations/google-contacts/connect
 *
 * Kicks off the dedicated Google OAuth flow for Contacts sync: sets a CSRF state
 * cookie and redirects the signed-in user to Google's consent screen (offline
 * access → refresh token). The matching callback stores the tokens.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  googleOAuthCreds, originFromRequest, contactsRedirectUri, buildAuthUrl, GOOGLE_CONTACTS_SCOPES,
} from "@/lib/google/oauth";
import { unionScopes } from "@/lib/google/scope-union";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const origin = originFromRequest(request);
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${origin}/login`);

  const creds = googleOAuthCreds();
  if (!creds) {
    // Not configured yet (Pardeep hasn't added the OAuth client env vars).
    return NextResponse.redirect(`${origin}/settings?tab=integrations&google=notconfigured`);
  }

  /* Ulti disha ka wahi bachaav jo gmail/connect me hai: pehle se granted scope request me
     jod do, taaki Contacts dobara connect karna Gmail ka bhejna na tod de. 26 Aug 2026 ko
     ye nuksaan doosri disha me ho chuka hai — dekho lib/google/scope-union.ts. */
  const { data: prior } = await supabase
    .from("user_google_tokens")
    .select("scopes")
    .eq("user_id", user.id)
    .maybeSingle();
  const scopes = unionScopes(GOOGLE_CONTACTS_SCOPES, (prior as { scopes?: string | null } | null)?.scopes);

  const state = crypto.randomUUID();
  const url = buildAuthUrl(creds.clientId, contactsRedirectUri(origin), state, scopes);

  const res = NextResponse.redirect(url);
  // Short-lived, httpOnly CSRF cookie verified in the callback.
  res.cookies.set("g_contacts_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
