/**
 * OAuth callback handler — runs after Google sign-in redirects back.
 *
 *  1. Exchanges the auth code for a session (sets the cookie).
 *  2. Looks up a public.users row for the new auth.uid.
 *  3. If MISSING (first-time Google sign-in), provisions:
 *       - tenant (name derived from email domain — "john@acme.in" → "Acme")
 *       - public.users row (role='owner', initials from full_name)
 *     and redirects to /setup so the user can polish company name / GSTIN.
 *  4. If EXISTING user, redirects to ?next= (defaults to /dashboard).
 *
 * Before this fix, Google OAuth would create the auth user but skip the
 * public.users + tenant rows that email/password signup creates via
 * /api/auth/signup — leaving the user logged-in but stranded in a broken
 * state with no tenant_id (every RLS-scoped query failed).
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { initials } from "@/lib/utils";
import { decideMembership, normalizeEmail, type InviteMatch } from "@/lib/auth/membership";

/** Derive a sensible default tenant name from the user's email domain. */
function tenantNameFromEmail(email: string | undefined): string {
  if (!email || !email.includes("@")) return "My Company";
  const domain = email.split("@")[1] ?? "";
  // Strip common TLDs, hyphens → spaces, capitalise the leading word.
  const base = domain
    .replace(/\.(in|com|co|org|net|io|app|dev|tech|biz|info|ai)$/i, "")
    .replace(/\.(in|com|co|org|net|io)\.[a-z]+$/i, "") // .co.in, .com.au etc.
    .split(".")[0]
    .replace(/-/g, " ")
    .trim();
  if (!base) return "My Company";
  return base
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  // Public host for redirects — NEVER new URL(request.url).origin. On Cloud Run
  // the container binds 0.0.0.0:3000, so that origin is the internal address and
  // sends users to dead https://0.0.0.0:3000 links after Google sign-in.
  const fwdHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto   = request.headers.get("x-forwarded-proto") ?? "https";
  const origin  = fwdHost
    ? `${proto}://${fwdHost}`
    : (process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") ?? new URL(request.url).origin);

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=no_code`);
  }

  const supabase = createClient();
  const { data: exchData, error: exchError } =
    await supabase.auth.exchangeCodeForSession(code);

  if (exchError || !exchData?.user) {
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  const authUser = exchData.user;

  // ─── Check if public.users row already exists ────────────────────────────
  // Use the admin client for this read — the new OAuth user has no
  // public.users row yet so they can't read their own row via RLS until
  // we create it. Admin bypasses RLS.
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("users")
    .select("id")
    .eq("id", authUser.id)
    .maybeSingle();

  if (existing) {
    // Returning user — straight to the requested destination.
    return NextResponse.redirect(`${origin}${next}`);
  }

  // ─── First-time sign-in with Google OAuth ──────────────────────────────────────────────────
  const email = authUser.email ?? "";
  const fullName =
    (authUser.user_metadata?.full_name as string | undefined) ||
    (authUser.user_metadata?.name as string | undefined) ||
    authUser.email?.split("@")[0] ||
    "New user";

  // Check if a pre-existing user record exists with this email address in public.users
  const { data: preExistingUser } = await admin
    .from("users")
    .select("id, tenant_id, role")
    .ilike("email", normalizeEmail(email))
    .maybeSingle();

  if (preExistingUser) {
    // Re-link pre-existing user profile to this new Auth UID
    await admin
      .from("users")
      .update({
        id: authUser.id,
        full_name: fullName,
        initials: initials(fullName),
      })
      .eq("id", preExistingUser.id);

    return NextResponse.redirect(`${origin}${next}`);
  }

  // Was this email invited to an existing tenant by its owner? If so, JOIN that
  // tenant instead of creating a new one. Matched case-insensitively; the unique
  // index on lower(email) guarantees at most one match (no ambiguity).
  const { data: inviteRow } = await admin
    .from("team_invites")
    .select("tenant_id, role")
    .ilike("email", normalizeEmail(email))
    .is("accepted_at", null)
    .maybeSingle();

  const decision = decideMembership((inviteRow as InviteMatch | null) ?? null);
  if (decision.mode === "join") {
    const { error: joinErr } = await admin.from("users").insert({
      id:        authUser.id,
      tenant_id: decision.tenantId,
      email,
      full_name: fullName,
      initials:  initials(fullName),
      role:      decision.role,
      color:     "indigo",
    });
    if (joinErr) {
      console.error("[oauth/callback] invite-join failed:", joinErr);
      return NextResponse.redirect(`${origin}/login?error=provision_failed`);
    }
    // One-time: mark the invite accepted so it can't be reused.
    await admin.from("team_invites").update({ accepted_at: new Date().toISOString() })
      .ilike("email", normalizeEmail(email)).is("accepted_at", null);
    // Joined an existing, set-up tenant — go straight to the app.
    return NextResponse.redirect(`${origin}${next}`);
  }

  // ─── No invite → provision a brand-new tenant + owner users row ──────────
  const companyName = tenantNameFromEmail(authUser.email);
  const tenantId = crypto.randomUUID();

  const { error: tenantErr } = await admin.from("tenants").insert({
    id:    tenantId,
    name:  companyName,
    email: authUser.email ?? "",
    tier:  "reseller",
  });

  if (tenantErr) {
    console.error("[oauth/callback] tenant creation failed:", tenantErr);
    return NextResponse.redirect(`${origin}/login?error=provision_failed`);
  }

  const { error: userErr } = await admin.from("users").insert({
    id:        authUser.id,
    tenant_id: tenantId,
    email:     authUser.email ?? "",
    full_name: fullName,
    initials:  initials(fullName),
    role:      "owner",
    color:     "amber",
  });

  if (userErr) {
    // Roll back the tenant so we don't leave orphans.
    await admin.from("tenants").delete().eq("id", tenantId);
    console.error("[oauth/callback] user row creation failed:", userErr);
    return NextResponse.redirect(`${origin}/login?error=provision_failed`);
  }

  // New user — send to setup wizard to fill GSTIN / state / address.
  // They can refine the auto-generated company name there too.
  return NextResponse.redirect(`${origin}/setup?welcome=1`);
}
