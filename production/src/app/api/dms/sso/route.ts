import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildSsoUrl, isSsoConfigured } from "@/lib/dms-engine/sso";
import { dmsPanelUrl } from "@/lib/dms-engine/client";

/**
 * GET /api/dms/sso?next=/admin — sign the current user into DMS and send them
 * there, instead of dropping them on its login form.
 *
 * ─── THE EMAIL COMES FROM THE SESSION, NEVER FROM THE REQUEST ────────────────
 * This is the whole security model of the route, so it is worth stating
 * plainly: the address in the minted token is read from the caller's own
 * Supabase session. There is no `email` parameter, and adding one would turn
 * this endpoint into "any signed-in user may become anyone in DMS" — a
 * privilege escalation across an application boundary, reachable from a
 * browser address bar.
 *
 * If an admin ever needs to open DMS *as* a customer, that is an impersonation
 * feature: it needs its own route, its own authorisation check, and its own
 * audit trail. It must not be a query parameter on this one.
 *
 * ─── WHAT THE TOKEN CANNOT DO ────────────────────────────────────────────────
 * It asserts identity only. DMS reads the role from its own user record,
 * refuses an email that has no account there, and burns the token's jti so it
 * works exactly once. So the worst case for a leaked link, within its 60
 * seconds, is a session as someone who already exists there at the privilege
 * they already have there.
 *
 * ─── DEGRADES TO A PLAIN LINK ────────────────────────────────────────────────
 * With no SSO secret configured this still redirects — just to DMS's normal
 * login page. The person gets where they were going and signs in by hand;
 * they do not get an error.
 */
export async function GET(request: NextRequest) {
  const supabase = createClient();

  const { data: authData } = await supabase.auth.getUser();
  const user = authData?.user;
  const email = user?.email;
  if (!user || !email) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  // Only a path, and only one we recognise. DMS hands `next` to NextAuth as a
  // callbackUrl, which already refuses off-origin values — but accepting an
  // arbitrary caller-supplied path here would still let this endpoint be used
  // to bounce someone anywhere inside DMS, so it is an allowlist instead.
  const requested = request.nextUrl.searchParams.get("next") ?? "admin";
  const DESTINATIONS: Record<string, { path: string; panel: "admin" | "customer" }> = {
    admin: { path: "/admin", panel: "admin" },
    dashboard: { path: "/dashboard", panel: "customer" },
  };
  const destination = DESTINATIONS[requested] ?? DESTINATIONS.admin;

  if (!isSsoConfigured()) {
    const fallback = dmsPanelUrl(destination.panel);
    if (!fallback) {
      return NextResponse.json(
        { error: "The hosting engine is not configured on this server." },
        { status: 503 }
      );
    }
    return NextResponse.redirect(fallback);
  }

  const ssoUrl = buildSsoUrl(email, {
    next: destination.path,
    sourceUserId: user.id,
  });
  if (!ssoUrl) {
    return NextResponse.json(
      { error: "Could not build a sign-in link." },
      { status: 503 }
    );
  }

  // no-store: the URL carries a single-use credential. A cached redirect would
  // hand a second person a token that is already spent, and they would see a
  // replay refusal rather than a login.
  return NextResponse.redirect(ssoUrl, {
    headers: { "cache-control": "no-store, max-age=0" },
  });
}
