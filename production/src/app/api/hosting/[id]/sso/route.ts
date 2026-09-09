/**
 * POST /api/hosting/:id/sso — a one-time link into this account's control panel.
 *
 * ─── WHY POST, ON A ROUTE THAT ONLY READS ────────────────────────────────────
 * Because calling it MINTS A CREDENTIAL. A GET would be prefetchable by the
 * browser, followable from a stray link, and cacheable by anything in between —
 * so a hover could hand out a live session into a customer's hosting panel. POST
 * is the difference between "the operator asked for this" and "something loaded".
 *
 * ─── WHAT IT DELIBERATELY DOES NOT RETURN OR STORE ───────────────────────────
 * The URL goes to the caller and nowhere else. It is not logged, not written to
 * the audit row, and not persisted — see lib/directadmin/sso.ts. The audit row
 * records WHO asked about WHICH account, which is the part a person needs
 * afterwards; the link itself would only be a credential at rest.
 *
 * ─── STAFF ONLY, CHECKED BEFORE ANYTHING IS MINTED ───────────────────────────
 * Same reasoning as the DNS routes (lib/domains/authz.ts): RLS guards tables, and
 * this touches DirectAdmin rather than a table, so the row-level policy would
 * fire too late — the session would already exist. A portal customer reaching
 * this must be refused before the request leaves the server, not after.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { daOneTimeLoginUrl, daSsoConfigured } from "@/lib/directadmin/sso";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });

  /* Staff of the owning tenant, and nobody else. `users` holds staff; a portal
     customer lives in `customer_users` and has no row here at all. */
  const { data: staff } = await supabase
    .from("users").select("id, tenant_id, is_active, full_name").eq("id", user.id).maybeSingle();
  if (!staff || staff.is_active === false) {
    return NextResponse.json({
      ok: false,
      error: "Control-panel access is for the team that manages this hosting. Raise a request and they can help.",
    }, { status: 403 });
  }

  const { data: account } = await supabase
    .from("hosting_accounts")
    .select("id, tenant_id, domain_name, da_username, status")
    .eq("id", params.id)
    .is("deleted_at", null)
    .maybeSingle();

  if (!account) return NextResponse.json({ ok: false, error: "No such hosting account." }, { status: 404 });
  if (account.tenant_id !== staff.tenant_id) {
    return NextResponse.json({ ok: false, error: "That account belongs to another organisation." }, { status: 403 });
  }

  if (!daSsoConfigured()) {
    return NextResponse.json({
      ok: false,
      error: "DirectAdmin is not configured in this environment, so a control-panel link cannot be created.",
    }, { status: 409 });
  }
  if (!account.da_username) {
    return NextResponse.json({
      ok: false,
      error: "This account has no cPanel username yet — it is set when provisioning completes, so there is no panel to open.",
    }, { status: 409 });
  }

  const out = await daOneTimeLoginUrl(account.da_username);

  if (out.kind === "refused") return NextResponse.json({ ok: false, error: out.reason }, { status: 400 });
  if (out.kind === "hard_failure") return NextResponse.json({ ok: false, error: out.reason }, { status: 502 });

  /* Durable audit, which DMS did not have — it logged to a process logger a
     short-lived container throws away. Somebody opening a customer's panel is
     exactly the thing you want a record of six months later, and the record has
     to name a person, not a service account: the admin client is used only
     because the row belongs to the tenant rather than to the caller's session. */
  const admin = createAdminClient();
  const { error: auditErr } = await admin.from("activity_log").insert({
    tenant_id: account.tenant_id,
    user_id: staff.id,
    action: "hosting.control_panel_opened",
    entity: "hosting_account",
    entity_id: account.id,
    label: `${staff.full_name ?? "A team member"} opened the control panel for ${account.domain_name} (${account.da_username})`,
  });
  if (auditErr) {
    /* The link exists upstream whether or not we recorded it. Failing the request
       now would hide an access that already happened, so this reports rather than
       pretends — the operator still gets their link and the gap is visible. */
    console.error("[hosting:sso] audit row failed:", auditErr.message);
  }

  return NextResponse.json(
    {
      ok: true,
      url: out.url,
      expires_in_seconds: out.expiresInSeconds,
      audited: !auditErr,
    },
    /* Belt and braces on top of the module's own no-store: a credential must not
       sit in a shared cache or a browser's back-forward store. */
    { headers: { "Cache-Control": "no-store, no-cache, must-revalidate, private" } },
  );
}
