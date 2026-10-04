/**
 * Supabase MIDDLEWARE client — runs on every request to refresh sessions.
 *
 * Called from the root middleware.ts. Returns a Response that includes
 * refreshed cookies AND a Supabase client for the protection check.
 *
 * Uses the MODERN getAll/setAll cookie API (recommended by @supabase/ssr).
 * The legacy get/set/remove API has issues with chunked auth tokens when
 * the app is fronted by a proxy like Firebase Hosting → Cloud Run, because
 * the proxy may not forward all chunks together.
 */
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "./database.types";

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({
    request,
  });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // Mirror cookies onto the request so any downstream reads in this
          // same middleware pass see the refreshed values…
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          // …and rebuild the response so the browser actually receives them.
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANT: getUser() validates the JWT against Supabase; getSession()
  // only decodes locally and is spoofable. Always use getUser() in middleware.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Look up the app-level role (owner / manager / sales) + per-user
  // extension flags (can_view_deals) for route gating. Single-row PK
  // lookup; cost ≈ 1 ms. Cached at the Supabase edge anyway.
  let role: string | null = null;
  let canViewDeals = false;
  /* R-048 part 2: this session signed in with a password but has not passed the account's
     authenticator code yet (verified TOTP factor → nextLevel aal2, session still aal1).
     Read from the session JWT + the user's factors; no extra network call. */
  let needsMfa = false;
  if (user) {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    needsMfa = aal?.nextLevel === "aal2" && aal?.currentLevel !== "aal2";
    const { data: me } = await supabase
      .from("users")
      .select("role, can_view_deals")
      .eq("id", user.id)
      .maybeSingle();
    role = (me?.role as string | null) ?? null;
    canViewDeals = Boolean(me?.can_view_deals);
    /* Apprentice Academy (R-149): an apprentice is not a staff (public.users) row — they are
       academy_apprentices.user_id. RLS lets them read only their own row. */
    if (!me) {
      const { data: appr } = await supabase
        .from("academy_apprentices")
        .select("id")
        .eq("user_id", user.id)
        .maybeSingle();
      if (appr) role = "apprentice";
    }
  }

  return { response, user, role, canViewDeals, needsMfa };
}
