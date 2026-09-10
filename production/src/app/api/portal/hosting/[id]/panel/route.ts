/**
 * POST /api/portal/hosting/:id/panel — a customer opening their OWN control panel.
 *
 * ─── WHY THIS WAS MISSING, AND WHY IT MATTERS ────────────────────────────────
 * The DirectAdmin one-time login was ported on 9 Sep as a STAFF tool: "open this
 * customer's panel to help them". It was the only caller, so a customer who had
 * bought hosting could not reach their own file manager, email accounts or
 * databases except by raising a support ticket. That is not a hosting product —
 * DMS's own user dashboard gave its customers this, and losing it in the port was
 * a regression nobody had noticed because the staff button worked.
 *
 * ─── POST, NOT GET, FOR THE SAME REASON AS THE STAFF ROUTE ──────────────────
 * Calling this MINTS A CREDENTIAL. A GET would be prefetchable by the browser,
 * followable from a stray link and cacheable in between, so a hover could hand
 * out a live session. POST is the difference between "the customer asked" and
 * "something loaded".
 *
 * ─── THE OWNERSHIP CHECK IS THE WHOLE SECURITY OF THIS ROUTE ────────────────
 * `hosting_accounts.id` comes from the URL, so without an explicit check that the
 * row belongs to THIS portal session's customer, the endpoint would mint a
 * one-time login into any hosting account by id. RLS is not the guard here for
 * the same reason as `lib/domains/authz.ts`: the credential is created at
 * DirectAdmin, so a row policy would fire after the session already existed.
 *
 * ─── FULL RIGHTS, UNLIKE THE STAFF SESSION ──────────────────────────────────
 * The staff route denies password changes, login-key minting and 2FA, so a
 * support session cannot become permanent access. Those denials are wrong for the
 * account's OWNER: hosting whose owner cannot change their own password is not
 * hosting they control. `audience: "customer"` is what says so — see
 * `lib/directadmin/sso.ts`.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requirePortalSession } from "@/lib/portal/session";
import { daOneTimeLoginUrl, daSsoConfigured } from "@/lib/directadmin/sso";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requirePortalSession();

  const admin = createAdminClient();
  const { data: account } = await admin
    .from("hosting_accounts")
    .select("id, customer_id, tenant_id, domain_name, da_username, status")
    .eq("id", params.id)
    .is("deleted_at", null)
    .maybeSingle();

  /* Not theirs, or not there — the same answer either way, so the response cannot
     be used to discover which hosting-account ids exist. */
  if (!account || account.customer_id !== session.customerId) {
    return NextResponse.json({ error: "No such hosting account on your login." }, { status: 404 });
  }

  if (!account.da_username) {
    return NextResponse.json(
      {
        error:
          "This account is still being set up, so there is no control panel to open yet. It appears here as soon as the server confirms it.",
      },
      { status: 409 },
    );
  }
  if (account.status === "suspended" || account.status === "terminated") {
    /* Said plainly rather than letting DirectAdmin refuse in its own words.
       A customer whose account is suspended needs to know WHY the button did
       nothing, and the reason is on our side, not the server's (§24). */
    return NextResponse.json(
      {
        error:
          account.status === "suspended"
            ? "This hosting is suspended, so the control panel is closed. Raise a request and we will sort it out."
            : "This hosting has been closed, so there is no control panel to open.",
      },
      { status: 409 },
    );
  }

  /* ─── THIS COMES LAST, AND THE ORDER IS THE POINT ─────────────────────
     It used to be checked first, and that made the environment MASK the account.
     A customer whose hosting is suspended was told "the control panel is not
     reachable from here yet" — a sentence about our configuration, when the true
     answer was about their account and would have been the same on any
     deployment. Measured locally, where DirectAdmin is unconfigured: suspended,
     pending and active all returned the same misleading 409.

     So everything true about THEM is answered first, and this speaks only when
     there is nothing else to say. */
  if (!daSsoConfigured()) {
    return NextResponse.json(
      { error: "The control panel is not reachable from here yet. Raise a request and we will get you in." },
      { status: 409 },
    );
  }

  const out = await daOneTimeLoginUrl(account.da_username, "CMD_USER_STATS", "customer");

  if (out.kind === "refused") return NextResponse.json({ error: out.reason }, { status: 400 });
  if (out.kind === "hard_failure") {
    /* The reason is DirectAdmin's and is written for an operator ("IP not
       allowed", "no such user"). A customer gets a sentence they can act on, and
       the real one goes to the log. */
    console.error(`[portal/panel] ${account.domain_name}: ${out.reason}`);
    return NextResponse.json(
      { error: "Could not open the control panel just now. Please try again, or raise a request." },
      { status: 502 },
    );
  }

  /* Durable audit. A one-time login into a live hosting account is worth a record
     six months later, and this one names the CUSTOMER as the actor — the staff
     route's equivalent names a staff user. The URL itself is never logged or
     stored: see lib/directadmin/sso.ts, it IS the credential. */
  const { error: auditErr } = await admin.from("activity_log").insert({
    tenant_id: account.tenant_id,
    /* NULL: `activity_log.user_id` references `users`, which holds STAFF. A
       portal customer has no row there, and pointing this at a staff id would
       credit the action to somebody who did not take it. The label carries who. */
    user_id: null,
    action: "hosting.control_panel_opened_by_customer",
    entity: "hosting_account",
    entity_id: account.id,
    label: `${session.userEmail || "A customer"} opened their own control panel for ${account.domain_name} (${account.da_username})`,
  });
  if (auditErr) {
    console.error("[portal/panel] audit row failed:", auditErr.message);
  }

  return NextResponse.json(
    { ok: true, url: out.url, expires_in_seconds: out.expiresInSeconds, audited: !auditErr },
    /* A credential must not sit in a shared cache or the browser's back-forward
       store. Belt and braces on top of the module's own no-store. */
    { headers: { "Cache-Control": "no-store, no-cache, must-revalidate, private" } },
  );
}
