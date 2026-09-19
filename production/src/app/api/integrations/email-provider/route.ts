/**
 * /api/integrations/email-provider — which transport this tenant sends with.
 *
 *   GET   → current settings + whether the chosen one can actually send
 *   PATCH → change provider / from-address / Resend key
 *
 * ─── THE SWITCH REFUSES TO POINT AT SOMETHING THAT CANNOT SEND ───────────────
 * Setting `email_provider = 'gmail'` while no Google account holds the
 * gmail.send scope would produce a settings page that says Gmail, a cron that
 * 403s at 6am, and an app that records "sent". So PATCH validates the target
 * before storing it, and says which step is missing.
 *
 * That check is the entire reason this is a route and not a form writing
 * straight to the table. SMTP got the same treatment on 11 Sep 2026: selecting
 * it runs `smtpVerify()` first, which connects and authenticates and sends
 * nothing, so `email_provider = 'smtp'` can only ever be stored against a relay
 * that has actually let us in. Credentials that are present and wrong are
 * indistinguishable from credentials that work until a send fails — which is
 * the trap the invalid `RESEND_API_KEY` on this very deployment sets — and the
 * only cheap way out of it is to try them at the moment somebody chooses them.
 *
 * The relay is deployment-wide, not per tenant: it comes from `SMTP_*` in the
 * environment, so every workspace that selects it sends as the same identity.
 * Stated on the card, because the alternative is a reseller discovering it from
 * a customer.
 *
 * ─── THE RESEND KEY IS SEALED HERE ───────────────────────────────────────────
 * It goes through the same envelope as every other credential, and a blank field
 * means KEEP, never delete — the rule learned when a plain Save on the Razorpay
 * dialog NULLed a live webhook secret.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { canSendWithScopes, describeSendCapability, type EmailProvider } from "@/lib/email/provider";
import { smtpConfigured, smtpDescription, smtpVerify } from "@/lib/email/smtp-transport";
import { listSenderCandidates, type SenderCandidateInput } from "@/lib/email/sender-candidates";
import { resolveSecretField } from "@/lib/integrations/secret-field";
import { encryptSecret, isVaultConfigured } from "@/lib/crypto/vault";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface TenantEmailRow {
  email_provider: EmailProvider | null;
  gmail_sender_user_id: string | null;
  email_from_address: string | null;
  email_from_name: string | null;
}

/** Narrow view of the columns 0235/0237 added; the generated types predate them. */
function emailDb(admin: ReturnType<typeof createAdminClient>) {
  return admin as unknown as {
    from(t: "tenants"): {
      select(c: string): { eq(c: string, v: string): { maybeSingle(): Promise<{ data: TenantEmailRow | null; error: { message: string } | null }> } };
      update(p: Record<string, unknown>): { eq(c: string, v: string): Promise<{ error: { message: string } | null }> };
    };
    from(t: "tenant_secrets"): {
      select(c: string): { eq(c: string, v: string): { maybeSingle(): Promise<{ data: { resend_api_key: string | null } | null; error: unknown }> } };
      upsert(p: Record<string, unknown>, o: { onConflict: string }): Promise<{ error: { message: string } | null }>;
    };
  };
}

/**
 * Every teammate in the workspace paired with their Google token, so the card can offer a
 * choice the server will not reject. Tenant-scoped by the caller's own tenant_id, never by
 * anything from the request.
 */
async function loadSenderCandidates(tenantId: string): Promise<ReturnType<typeof listSenderCandidates>> {
  const admin = createAdminClient();
  const { data: team } = await admin
    .from("users").select("id, email, role").eq("tenant_id", tenantId).eq("is_active", true);
  if (!team || team.length === 0) return [];

  const { data: tokens } = await admin
    .from("user_google_tokens")
    .select("user_id, google_email, refresh_token, scopes")
    .in("user_id", team.map((t) => t.id));
  const byUser = new Map((tokens ?? []).map((t) => [t.user_id, t]));

  const inputs: SenderCandidateInput[] = team.map((t) => {
    const tok = byUser.get(t.id);
    return {
      userId: t.id,
      email: t.email ?? null,
      role: t.role ?? null,
      token: tok
        ? { google_email: tok.google_email ?? null, refresh_token: tok.refresh_token ?? null, scopes: tok.scopes ?? null }
        : null,
    };
  });
  return listSenderCandidates(inputs);
}

async function loadContext(userId: string) {
  const supabase = createClient();
  const { data: me } = await supabase
    .from("users").select("tenant_id, role").eq("id", userId).maybeSingle();
  if (!me?.tenant_id) return null;

  const admin = createAdminClient();
  const db = emailDb(admin);

  const { data: tenant } = await db.from("tenants")
    .select("email_provider, gmail_sender_user_id, email_from_address, email_from_name")
    .eq("id", me.tenant_id).maybeSingle();

  // Whose Google account would send, and can it? Read from the token row rather
  // than trusted from the settings, because the grant can be revoked at Google
  // without anything in this app changing.
  // Falls back to the CALLER when no sender is designated, because PATCH does
  // exactly the same (`|| user.id`). Reading only the stored column made GET and
  // PATCH disagree: the card said "Not connected" for an account that was in
  // fact connected and able to send, and pressing Gmail would have worked. A
  // status screen that contradicts the button beside it is worse than no status.
  const senderId = tenant?.gmail_sender_user_id ?? userId;
  const isDesignated = Boolean(tenant?.gmail_sender_user_id);
  let gmail = {
    senderId, isDesignated,
    email: null as string | null,
    canSend: false,
    /* Kept apart from `canSend` because the capability sentence has to name
       WHICH step is missing, and "not connected" and "connected but not allowed
       to send" send the operator to different places. Neither is returned to
       the browser — the card gets the derived sentence, not the scope string. */
    hasRefreshToken: false,
    scopes: null as string | null,
  };
  if (senderId) {
    const { data: tok } = await admin
      .from("user_google_tokens")
      .select("google_email, refresh_token, scopes")
      .eq("user_id", senderId).maybeSingle();
    gmail = {
      ...gmail,
      email: tok?.google_email ?? null,
      hasRefreshToken: Boolean(tok?.refresh_token),
      scopes: tok?.scopes ?? null,
      canSend: Boolean(tok?.refresh_token) && canSendWithScopes(tok?.scopes ?? null),
    };
  }

  const { data: secrets } = await db.from("tenant_secrets")
    .select("resend_api_key").eq("tenant_id", me.tenant_id).maybeSingle();

  return { me, db, admin, tenant, gmail, hasResendKey: Boolean(secrets?.resend_api_key) };
}

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const ctx = await loadContext(user.id);
  if (!ctx) return NextResponse.json({ error: "No tenant." }, { status: 403 });

  const provider = ctx.tenant?.email_provider ?? "resend";
  const hasSmtp = smtpConfigured();

  /* Who COULD be the sending account. PATCH has always accepted a gmailSenderUserId and the
     card never sent one, so the sender stayed whoever configured email first — which is why
     mail was leaving as pardeep@anutech.in with no screen able to change it. Offering the
     list is the missing half. Ineligible teammates are included on purpose: "not in the
     list" and "has not connected Google" are different problems. */
  const candidates = await loadSenderCandidates(ctx.me.tenant_id);

  const capability = describeSendCapability({
    provider,
    /* The stored sender only. `loadContext` falls back to the CALLER for the
       connection panel, which is right there and wrong here: "no sending
       account has been chosen" is a real, separate blocker and the router says
       so in its own words. */
    gmailSenderUserId: ctx.tenant?.gmail_sender_user_id ?? null,
    gmailHasRefreshToken: ctx.gmail.hasRefreshToken,
    gmailScopes: ctx.gmail.scopes,
    /* The tenant's own key or the deployment's — either one sends. */
    resendConfigured: ctx.hasResendKey || Boolean(process.env.RESEND_API_KEY?.trim()),
    smtpConfigured: hasSmtp,
  });

  return NextResponse.json({
    provider,
    fromAddress: ctx.tenant?.email_from_address ?? null,
    fromName: ctx.tenant?.email_from_name ?? null,
    // Presence only. The key itself never comes back to a browser.
    hasResendKey: ctx.hasResendKey,
    /** True when the deployment-wide fallback is available. */
    hasEnvResendKey: Boolean(process.env.RESEND_API_KEY?.trim()),
    /* Projected, not spread: `ctx.gmail` also carries the refresh-token flag
       and the raw scope string, which the card has no use for. The derived
       sentence is what it needs. */
    gmail: {
      senderId: ctx.gmail.senderId,
      isDesignated: ctx.gmail.isDesignated,
      email: ctx.gmail.email,
      canSend: ctx.gmail.canSend,
    },
    senderCandidates: candidates,
    /** Only the owner may switch it — PATCH enforces the same. */
    canChooseSender: ctx.me.role === "owner",
    /* Deployment-wide, from `SMTP_*`. `description` is host, port and login —
       never the password; that is the whole reason `smtpDescription()` exists
       rather than the card assembling the string from fields of its own. */
    smtp: {
      configured: hasSmtp,
      description: smtpDescription(),
    },
    /* ─── "CAN WE SEND" IS ASKED OF THE ROUTER ──────────────────────────────
       This used to be a ternary here, and it went stale the moment the fallback
       chain grew a third link: with the relay configured and no Resend key,
       `sendEmail` sent the mail and this line said it could not. Now the same
       function that routes a message answers the question, so the card and the
       cron cannot disagree. See `describeSendCapability`. */
    capability,
    /** Kept as the flat boolean the badge reads. Derived, never computed twice. */
    canSendNow: capability.canSend,
  });
}

export async function PATCH(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const ctx = await loadContext(user.id);
  if (!ctx) return NextResponse.json({ error: "No tenant." }, { status: 403 });
  if (ctx.me.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can change email settings." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try { body = await req.json() as Record<string, unknown>; }
  catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }

  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const patch: Record<string, unknown> = {};

  // ── provider ──────────────────────────────────────────────────────────────
  if (body.provider !== undefined) {
    const p = str(body.provider);
    if (p !== "resend" && p !== "gmail" && p !== "smtp") {
      return NextResponse.json({ error: "Provider must be resend, gmail or smtp." }, { status: 400 });
    }
    if (p === "smtp") {
      /* ─── THE RELAY IS TRIED BEFORE IT IS STORED ────────────────────────
         The same rule as the Gmail scope check above, and for a stronger
         reason: there is no scope to inspect, so presence is all a cheap check
         could report — and presence is what made the invalid RESEND_API_KEY on
         this deployment look configured while every send 401'd. `smtpVerify()`
         connects and authenticates and sends NOTHING, so this costs one
         handshake and puts no test message in anybody's inbox. */
      if (!smtpConfigured()) {
        return NextResponse.json({
          error: "No SMTP relay is configured on this server, so mail sent through it would go nowhere. "
               + "Set SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS in the environment, then switch.",
        }, { status: 409 });
      }
      const check = await smtpVerify();
      if (!check.ok) {
        /* The relay's own words. "Invalid login" and "connection refused" send
           an operator to different places, and a generic failure sends them
           nowhere — the same reasoning as passing Gmail's message through. */
        return NextResponse.json({
          error: `The SMTP relay refused these credentials, so nothing was changed. ${check.detail}`,
        }, { status: 409 });
      }
    }
    if (p === "gmail") {
      const senderId = str(body.gmailSenderUserId) || ctx.gmail.senderId || user.id;
      const { data: tok } = await ctx.admin
        .from("user_google_tokens")
        .select("refresh_token, scopes")
        .eq("user_id", senderId).maybeSingle();

      if (!tok?.refresh_token) {
        return NextResponse.json({
          error: "That account has not connected Google yet. Connect it first, then switch.",
          next: "/api/integrations/google-gmail/connect",
        }, { status: 409 });
      }
      if (!canSendWithScopes(tok.scopes ?? null)) {
        return NextResponse.json({
          error: "That Google account is connected but was not granted permission to send. "
               + "Reconnect and leave “Send email on your behalf” ticked.",
          next: "/api/integrations/google-gmail/connect",
        }, { status: 409 });
      }
      patch.gmail_sender_user_id = senderId;
    }
    patch.email_provider = p;
  }

  if (body.fromAddress !== undefined) patch.email_from_address = str(body.fromAddress) || null;
  if (body.fromName !== undefined)    patch.email_from_name    = str(body.fromName) || null;

  if (Object.keys(patch).length > 0) {
    const { error } = await ctx.db.from("tenants").update(patch).eq("id", ctx.me.tenant_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // ── Resend key ────────────────────────────────────────────────────────────
  if (body.resendApiKey !== undefined) {
    const decision = resolveSecretField({
      incoming: typeof body.resendApiKey === "string" ? body.resendApiKey : undefined,
      hasExisting: ctx.hasResendKey,
      clear: body.clearResendKey === true,
      required: false,
      // A truncated paste of a Resend key would be stored happily and fail only
      // at send time, so short values are refused rather than accepted.
      minLength: 10,
      label: "Resend API key",
    });

    if (decision.action === "error") {
      return NextResponse.json({ error: decision.reason }, { status: 400 });
    }
    if (decision.action === "write") {
      if (!isVaultConfigured()) {
        return NextResponse.json({
          error: "SECRETS_MASTER_KEY is not set, so the key cannot be encrypted. Nothing was saved.",
        }, { status: 503 });
      }
      const { error } = await ctx.db.from("tenant_secrets").upsert(
        { tenant_id: ctx.me.tenant_id, resend_api_key: encryptSecret(decision.value) },
        { onConflict: "tenant_id" },
      );
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (decision.action === "clear") {
      const { error } = await ctx.db.from("tenant_secrets").upsert(
        { tenant_id: ctx.me.tenant_id, resend_api_key: null },
        { onConflict: "tenant_id" },
      );
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
    // action === "keep" → blank field, existing key untouched. This is the
    // branch that matters: a blank box must never mean "delete the key".
  }

  return NextResponse.json({ ok: true });
}
