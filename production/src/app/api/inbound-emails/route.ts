/**
 * GET /api/inbound-emails — the Enquiries inbox.
 *
 * ─── THIS ROUTE HAD NO AUTH AT ALL, AND IT USES THE SERVICE ROLE ────────────
 * Found 30 Aug 2026 while reviewing the Enquiries screen. Two separate holes, and the
 * second one did not even need a signed-out attacker:
 *
 *   1. There was no `if (!user)` anywhere. `/api` is NOT in the middleware's
 *      PROTECTED_PREFIXES (that list gates `/enquiries`, the PAGE — not the endpoint
 *      behind it), so an anonymous GET reached this handler, fell through to
 *      DEFAULT_TENANT_ID, and was answered with ANUTECH's whole inbox: customer names,
 *      email addresses, phone numbers and every message body.
 *
 *   2. Worse, and live for a properly signed-in user: when the resolved tenant had zero
 *      rows, the handler ran a SECOND query with NO tenant filter —
 *      `select * from inbound_emails order by created_at limit 50` — and returned that.
 *      Delfos Technologies and Excel Technologies both hold 0 inbound emails today, so
 *      either of their users opening this screen would have been served ANUTECH's 32.
 *      A "local preview" convenience became a cross-tenant read in production.
 *
 * `createAdminClient` is the service role: it bypasses RLS, so RLS could not save this.
 * When the admin client is used, the tenant filter IS the security boundary, and a
 * fallback that drops the filter drops the boundary.
 *
 * ─── THE SIBLINGS WERE ALWAYS RIGHT ─────────────────────────────────────────
 * `[id]/state` and `[id]/reply` both require a user, resolve `me.tenant_id`, and scope
 * every query by it. That is the shape copied below — this route was the odd one out,
 * which is why this is an oversight and not a design.
 *
 * ─── DEMO MODE IS KEPT, BUT GATED THE SAME WAY MIDDLEWARE GATES IT ──────────
 * Local UI review runs signed-out (`NEXT_PUBLIC_DEMO_MODE=true`), and that is genuinely
 * useful. The guard below is character-for-character the one in middleware.ts, including
 * `NODE_ENV === "development"`, so a production build cannot take this branch no matter
 * what is set in the environment — and the two cannot drift into disagreeing.
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * Only ever used by the signed-out local demo below. Never a production fallback.
 *
 * ─── `BUY_PAGE_TENANT_ID` USED TO BE SECOND IN THIS CHAIN, AND IT IS WRONG ───
 * It holds `8ff50dbf-e17e-4210-a580-0df7b1a6f71b`, which matches NO tenant in the live
 * database — there are three, and that is none of them. So the "default tenant" this
 * route claimed to fall back to has been resolving to nothing the whole time, and the
 * ONLY reason the local demo ever showed mail was the cross-tenant fallback removed
 * below. Closing that hole is what made the emptiness visible; the emptiness was
 * already there.
 *
 * It is also the wrong CONCEPT: it names the tenant whose products the public buy page
 * sells, which has no reason to be the tenant whose inbox a developer wants to look at.
 * Two unrelated ideas sharing one variable is how one of them silently goes stale.
 */
const DEMO_TENANT_ID =
  process.env.INBOUND_EMAIL_TENANT_ID?.trim() ||
  "fbb976f1-9090-4f10-9726-0901bd144e42";   // ANUTECH — the local dev dataset

const isLocalDemo = () =>
  process.env.NEXT_PUBLIC_DEMO_MODE === "true" &&
  process.env.NODE_ENV === "development";

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  let tenantId: string;

  if (user) {
    const { data: me } = await supabase
      .from("users")
      .select("tenant_id")
      .eq("id", user.id)
      .maybeSingle();

    if (!me?.tenant_id) {
      /* Signed in, but no workspace yet — /welcome is the screen for this. An empty
         list would read as "you have no enquiries", which is a different sentence. */
      return NextResponse.json(
        { error: "Your account is not attached to a workspace yet." },
        { status: 403 },
      );
    }
    tenantId = me.tenant_id;
  } else if (isLocalDemo()) {
    tenantId = DEMO_TENANT_ID;
  } else {
    return NextResponse.json({ error: "Sign in to see your enquiries." }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("inbound_emails")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[api/inbound-emails] GET error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  /* No "if empty, show somebody else's" fallback. An empty inbox is an empty inbox, and
     the page already has an empty state that says so in the folder's own words. */
  return NextResponse.json(data ?? []);
}
