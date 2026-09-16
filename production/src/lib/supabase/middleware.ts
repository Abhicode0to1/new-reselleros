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
  let isPortalCustomer = false;
  if (user) {
    const { data: me } = await supabase
      .from("users")
      .select("role, can_view_deals")
      .eq("id", user.id)
      .maybeSingle();
    role = (me?.role as string | null) ?? null;
    canViewDeals = Boolean(me?.can_view_deals);

    /* ─── IS THIS A PORTAL CUSTOMER? ──────────────────────────────────────
       Asked ONLY when there is no `users` row, so staff — every real user of
       the staff app — pay nothing for it. A customer has a perfectly valid
       Supabase session, so without this the middleware waves them into the
       staff console and they land on the "This part is for staff" screen.

       `auth_user_id` is UNIQUE and the RLS policy `customer_users_select_self`
       already scopes the read to the caller; the .eq() is stated anyway so the
       query does not depend on a policy staying that way.

       NOT every strandee is a customer: a brand-new staff signup has no `users`
       row either, for the seconds before their tenant is provisioned. Sending
       THEM to a portal they have no account on would be a worse dead end than
       the one this fixes, which is why the question is "are you in
       customer_users" and not "are you missing from users". */
    if (!me) {
      const { data: pc } = await supabase
        .from("customer_users")
        .select("id")
        .eq("auth_user_id", user.id)
        .maybeSingle();
      isPortalCustomer = Boolean(pc);
    }
  }

  return { response, user, role, canViewDeals, isPortalCustomer };
}
