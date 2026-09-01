/**
 * POST /api/auth/signup
 *
 * Server-side signup using the service role key so we can:
 * 1. Create the auth user with email_confirm = true (no email verification needed)
 * 2. Decide where that person BELONGS
 * 3. Create only what that decision calls for
 *
 * ─── WHY STEP 2 IS NEW, AND WHY IT IS NOT OPTIONAL ───────────────────────────
 * This route used to go straight from "auth user created" to "create a tenant",
 * unconditionally. It never looked at `team_invites` at all — so it was a second
 * door into the product with none of the guard the OAuth callback had, and an
 * invited teammate who happened to use the email form instead of the Google button
 * got a private company of their own with the same name as the real one.
 *
 * A company is now created only when nothing recognises the person. Three
 * outcomes, in strict order of how much a human already decided:
 *
 *   invite (someone chose them)     → join that tenant, no tenant created
 *   verified domain (evidence only) → park in join_requests, NOTHING granted
 *   nothing                         → create the tenant they asked for
 *
 * ─── THE DOMAIN CHECK OVERRIDES THE FORM ON PURPOSE ──────────────────────────
 * This form asks for a company name, so filling it in looks like an explicit "I am
 * a new business". It is not reliable evidence: the person who typed "Excel
 * Technologies" into it while his colleagues already had an Excel Technologies
 * workspace was not lying, he simply did not know. The domain knows. So a verified
 * domain match wins over the typed name, and the response says exactly why —
 * `pending_approval` is not a failure and must not be shown as one.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { initials } from "@/lib/utils";
import { normalizeEmail, type InviteMatch } from "@/lib/auth/membership";
import { decideOnboarding } from "@/lib/auth/domain";
import {
  findVerifiedDomainTenant,
  openJoinRequest,
  notifyOwnerOfJoinRequest,
} from "@/lib/auth/tenant-match";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      email: string;
      password: string;
      fullName: string;
      companyName: string;
      gstin?: string;
      /** Invite-email ke link se aaya raaz — iske bina invite se join NAHI hota. */
      inviteToken?: string;
    };

    const { password, fullName, companyName, gstin } = body;
    const email = normalizeEmail(body.email);

    if (!email || !password || !fullName || !companyName) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const admin = createAdminClient();

    // ── 1. Where does this person belong? Decided BEFORE anything is created,
    //       so a decision of "join" or "wait" never leaves a stray tenant behind.
    //
    // ⚠️ Password-raaste par invite EMAIL SE NAHI pehchana jata — token se.
    // 1 Sep 2026 ke audit ka #1 khatra yahi tha: is route ne kabhi mailbox
    // saabit nahi kiya (email_confirm: true), to sirf email-match par join
    // dena har invited address ko ek khula darwaza banata tha — koi bhi
    // billing@company.com ka andaza laga kar, apna password rakh kar, us
    // tenant me (owner tak ke role me) ghus sakta tha. Token sirf invite-
    // email me jata hai, isliye uska hona hi mailbox ka saboot hai. Google
    // wala raasta (callback) pehle jaisa — wahan saboot Google deta hai.
    const inviteToken = typeof body.inviteToken === "string" ? body.inviteToken.trim() : "";
    const { data: inviteRow } = inviteToken
      ? await admin
          .from("team_invites")
          .select("tenant_id, role")
          .eq("token", inviteToken)
          .eq("email", email)
          .is("accepted_at", null)
          .maybeSingle()
      : { data: null };

    // Invite pending hai par token nahi/galat? Account banate hi NAHI —
    // warna wahi takeover, ya (ignore karne par) invited insaan ki apni
    // alag company ban jati (13 stranded-users wala purana bug). §24:
    // kya hua + kyun + aage kya, teeno.
    if (!inviteRow) {
      const { data: pendingByEmail } = await admin
        .from("team_invites")
        .select("id")
        .eq("email", email)
        .is("accepted_at", null)
        .maybeSingle();
      if (pendingByEmail) {
        return NextResponse.json(
          {
            error:
              "Is email par ek workspace ka invite hai. Join karne ke do raaste: " +
              "(1) invite email me aaya link kholiye, ya (2) isi email se Google ke saath sign in kariye. " +
              "Password se naya account is invite ko bypass nahi kar sakta.",
          },
          { status: 409 },
        );
      }
    }

    const domainMatch = await findVerifiedDomainTenant(email);
    const decision = decideOnboarding({
      invite: (inviteRow as InviteMatch | null) ?? null,
      domainMatch,
    });

    // ── 2. Create auth user (auto-confirmed, no email needed) ──────────────
    const { data: authData, error: authError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,           // skip email verification
      user_metadata: {
        full_name: fullName,
        company_name: companyName,
        gstin: gstin ?? null,
      },
    });

    if (authError) {
      return NextResponse.json({ error: authError.message }, { status: 400 });
    }

    const userId = authData.user.id;

    // ── 3a. Invited → join the inviting tenant. No tenant is created. ──────
    if (decision.mode === "join") {
      const { error: joinErr } = await admin.from("users").insert({
        id:        userId,
        tenant_id: decision.tenantId,
        email,
        full_name: fullName,
        initials:  initials(fullName),
        role:      decision.role,
        color:     "indigo",
      });
      if (joinErr) {
        await admin.auth.admin.deleteUser(userId);
        return NextResponse.json({ error: "Could not add you to the workspace: " + joinErr.message }, { status: 500 });
      }
      await admin.from("team_invites")
        .update({ accepted_at: new Date().toISOString() })
        .eq("token", inviteToken).eq("email", email).is("accepted_at", null);

      return NextResponse.json({ success: true, status: "joined", userId, tenantId: decision.tenantId });
    }

    // ── 3b. Domain match → park, alert, grant nothing. ─────────────────────
    if (decision.mode === "request_approval") {
      const parked = await openJoinRequest({
        tenantId:   decision.tenantId,
        email,
        fullName,
        authUserId: userId,
        matchedBy:  "domain",
        note:       `Signed up with the company name "${companyName}".`,
      });

      if (!parked.ok) {
        // We could not record the request, so nobody would ever see it. Undo the
        // auth account rather than stranding them — a stranded auth user is the
        // exact state that produced thirteen of them in this database.
        await admin.auth.admin.deleteUser(userId);
        return NextResponse.json(
          { error: "Could not create your join request. Please try again, or ask your workspace owner to invite you." },
          { status: 500 },
        );
      }

      const origin = originOf(request);
      await notifyOwnerOfJoinRequest({
        tenantId:   decision.tenantId,
        tenantName: decision.tenantName,
        email,
        fullName,
        appUrl:     origin,
      });

      return NextResponse.json({
        success: true,
        status: "pending_approval",
        tenantName: decision.tenantName,
        alreadyPending: parked.alreadyPending,
      });
    }

    // ── 3c. Nobody recognised them → this really is a new company. ─────────
    const tenantId = crypto.randomUUID();

    const { error: tenantError } = await admin.from("tenants").insert({
      id: tenantId,
      name: companyName,
      gstin: gstin || null,
      email,
    });

    if (tenantError) {
      // Rollback: delete the auth user we just created
      await admin.auth.admin.deleteUser(userId);
      return NextResponse.json({ error: "Tenant creation failed: " + tenantError.message }, { status: 500 });
    }

    const { error: userError } = await admin.from("users").insert({
      id: userId,
      tenant_id: tenantId,
      email,
      full_name: fullName,
      initials: initials(fullName),
      role: "owner",
      color: "amber",
    });

    if (userError) {
      // Rollback: delete tenant + auth user
      await admin.from("tenants").delete().eq("id", tenantId);
      await admin.auth.admin.deleteUser(userId);
      return NextResponse.json({ error: "User record creation failed: " + userError.message }, { status: 500 });
    }

    // Claim the company's own domain for this new tenant, unverified. It costs
    // nothing, it is what a future owner would have to type by hand anyway, and
    // an unverified claim routes nobody (0242) — so it cannot misfire.
    await claimDomainQuietly(admin, tenantId, email);

    return NextResponse.json({ success: true, status: "created", userId, tenantId });
  } catch (e) {
    const err = e as Error;
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/** Public host for links in outbound alerts — never `new URL(request.url).origin`,
 *  which is the container's internal address on Cloud Run. */
function originOf(request: NextRequest): string {
  const fwdHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto   = request.headers.get("x-forwarded-proto") ?? "https";
  return fwdHost ? `${proto}://${fwdHost}` : (process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") ?? "");
}

type AdminClient = ReturnType<typeof createAdminClient>;

/** Best-effort domain claim. A failure here must never fail a signup that has
 *  already succeeded — the tenant exists and the user can work. */
async function claimDomainQuietly(admin: AdminClient, tenantId: string, email: string) {
  const { emailDomain, isPublicEmailDomain } = await import("@/lib/auth/domain");
  const domain = emailDomain(email);
  if (!domain || isPublicEmailDomain(domain)) return;
  const { error } = await admin.from("tenant_domains").insert({ tenant_id: tenantId, domain });
  if (error && error.code !== "23505") {
    console.warn("[signup] domain claim skipped:", error.message);
  }
}
