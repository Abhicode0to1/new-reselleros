/**
 * GET /api/integrations/google-gmail/connect
 *
 * Starts the Gmail SEND consent flow. Deliberately a separate route, cookie and
 * callback from google-contacts.
 *
 * ─── WHY NOT JUST ADD gmail.send TO THE CONTACTS CONSENT ─────────────────────
 * It would be one flow instead of two, and it would be wrong. Google's consent
 * screen lists what is being asked for, and "Send email on your behalf" appearing
 * under a button labelled "Connect Google Contacts" is how a reasonable person
 * learns not to trust the app's buttons. Anyone who wants contacts sync but not
 * outbound sending would have no way to say so.
 *
 * Two flows also means revoking one does not silently take the other down.
 *
 * ─── THE STATE COOKIE IS NOT SHARED EITHER ───────────────────────────────────
 * A single `g_oauth_state` for both flows would let a callback complete using a
 * state minted by the other one, which is exactly the confusion CSRF state
 * exists to prevent.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  googleOAuthCreds, originFromRequest, gmailRedirectUri, buildAuthUrl, GMAIL_SEND_SCOPES,
} from "@/lib/google/oauth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const origin = originFromRequest(request);
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${origin}/login`);

  const creds = googleOAuthCreds();
  if (!creds) {
    return NextResponse.redirect(`${origin}/settings?tab=integrations&gmail=notconfigured`);
  }

  const state = crypto.randomUUID();
  const url = buildAuthUrl(creds.clientId, gmailRedirectUri(origin), state, GMAIL_SEND_SCOPES);

  const res = NextResponse.redirect(url);
  res.cookies.set("g_gmail_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
