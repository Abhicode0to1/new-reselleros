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
import { createClient, createAdminClient } from "@/lib/supabase/server";
import {
  googleOAuthCreds, originFromRequest, gmailRedirectUri, buildAuthUrl, GMAIL_SEND_SCOPES,
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
    return NextResponse.redirect(`${origin}/settings?tab=integrations&gmail=notconfigured`);
  }

  /* ── Jo pehle se granted hai, use REQUEST me hi maang lo ──────────────────
     Contacts aur Gmail ek hi `user_google_tokens` row likhte hain. `buildAuthUrl` me
     `include_granted_scopes: "true"` pehle se hai, par wo ek UMEED hai — is route ke apne
     callback ka comment kehta hai ki "the consent screen lets a user untick individual
     permissions". 26 Aug 2026 ko theek wahi hua: is flow ne Pardeep ka contacts grant
     dhak diya aur sync 11 din chup-chaap 403 deta raha.

     Union maang kar consent screen dono cheezein dikhata hai, aur Google ko union karna
     hi nahi padta. Poori naap lib/google/scope-union.ts me. */
  /* ⚠️ ADMIN client se, `supabase` (user client) se NAHI — aur ye load-bearing hai.
     `user_google_tokens` par RLS ON hai aur uspar ZERO policy hai (naapa gaya 26 Aug 2026,
     `pg_policies` se). Yaani user client us table se kuch bhi nahi padh sakta, aur wo
     KHAALI lautata hai — error nahi.

     Pehle maine yahi query user client se likhi thi. Nateeja: `prior.scopes` hamesha
     khaali, union hamesha no-op, aur feature "chalta hua" dikhta rahega jabki kuch nahi
     karta — phir consent grant ko sankuchit kar dega, theek wo bug jise ye rokne aaya tha.
     Browser me pakda gaya: scope me `contacts` tha aur `gmail.send` nahi.

     Yahi wo shreni hai jo is repo ko pehle bhi kaat chuki hai — tooti/khaali query chup-chaap
     "data nahi hai" ban jaati hai. Gmail ka callback bhi isi table ko admin se padhta hai. */
  const { data: prior } = await createAdminClient()
    .from("user_google_tokens")
    .select("scopes")
    .eq("user_id", user.id)
    .maybeSingle();
  const scopes = unionScopes(GMAIL_SEND_SCOPES, (prior as { scopes?: string | null } | null)?.scopes);

  const state = crypto.randomUUID();
  const url = buildAuthUrl(creds.clientId, gmailRedirectUri(origin), state, scopes);

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
