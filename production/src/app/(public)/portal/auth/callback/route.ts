/**
 * /portal/auth/callback — magic-link landing for customer portal.
 *
 *  1. Exchanges the auth code for a session (sets cookies)
 *  2. Looks up a `customers` row matching the user's email
 *  3. INSERTs/UPDATEs a `customer_users` row linking auth user → customer
 *  4. Redirects to /portal/dashboard
 *
 * Error redirects:
 *  - no code              → /portal/login?error=auth_failed
 *  - code exchange fails  → /portal/login?error=auth_failed
 *  - no matching customer → /portal/login?error=no_customer
 *
 * Uses the admin (service-role) client for the customer lookup + link
 * insert because the new auth user has no `customer_users` row yet,
 * so RLS would block them from reading `customers`.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { linkAuthUserToCustomer } from "@/lib/portal/link-customer";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");

  // Build redirects from the PUBLIC host — NEVER new URL(request.url).origin.
  // On Cloud Run the container binds 0.0.0.0:3000, so request.url's origin is the
  // internal address and yields dead https://0.0.0.0:3000 links (broke every
  // portal magic-link login). Prefer the forwarded host the customer actually
  // used, then NEXT_PUBLIC_APP_URL, then (last resort) the raw origin.
  const fwdHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto   = request.headers.get("x-forwarded-proto") ?? "https";
  const origin  = fwdHost
    ? `${proto}://${fwdHost}`
    : (process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") ?? new URL(request.url).origin);

  if (!code) {
    return NextResponse.redirect(`${origin}/portal/login?error=auth_failed`);
  }

  const supabase = createClient();
  const { error: exchErr } = await supabase.auth.exchangeCodeForSession(code);
  if (exchErr) {
    return NextResponse.redirect(`${origin}/portal/login?error=auth_failed`);
  }

  // Pull the freshly-authed user
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) {
    return NextResponse.redirect(`${origin}/portal/login?error=auth_failed`);
  }

  /* Already-linked, find-the-customer and insert-the-link moved to
     lib/portal/link-customer.ts on 11 Sep 2026, because the dev one-click
     sign-in needs the identical step. This decides WHICH CUSTOMER'S DATA the
     session can read, so two copies of it would be a cross-tenant leak waiting
     for one of them to drift. Behaviour and redirects here are unchanged. */
  const linked = await linkAuthUserToCustomer({ authUserId: user.id, email: user.email });

  if (!linked.ok) {
    if (linked.reason === "link_failed") {
      console.error("[portal/auth/callback] link insert failed:", linked.detail);
    }
    // Sign them out so they don't end up half-authed with no portal access
    await supabase.auth.signOut();
    const why = linked.reason === "no_customer" ? "no_customer" : "auth_failed";
    return NextResponse.redirect(`${origin}/portal/login?error=${why}`);
  }

  return NextResponse.redirect(`${origin}/portal/dashboard`);
}
