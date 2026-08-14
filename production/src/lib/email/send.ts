/**
 * Email send abstraction.
 *
 * Used by the renewal cron (and future flows like quote-send,
 * invoice-send). Has two modes:
 *
 *   1. Stub mode (when RESEND_API_KEY is absent / blank):
 *      - Does NOT hit any external API.
 *      - Returns { status: "stubbed", providerId: null }.
 *      - Callers should still record the attempt in their audit log
 *        (renewal_email_log) so we know cadence logic ran even without
 *        delivery.
 *
 *   2. Real mode (when RESEND_API_KEY is set):
 *      - POSTs to api.resend.com/emails.
 *      - Returns the Resend message ID as providerId on success.
 *
 * No code change is needed to flip from stub → real; just set the env
 * variable. This is the seam we'll integrate against once you sign up
 * at resend.com and add RESEND_API_KEY=re_... to .env.local.
 *
 * Server-only — never import from client code. Resend keys are secret.
 *
 * Since migration 0235 a message may carry `route: { tenantId }`, and the tenant
 * may have chosen to send through their own Gmail instead. Callers that omit
 * `route` are unaffected and still go through Resend.
 */
import type { NotificationClass } from "@/lib/mastery/quiet-hours";
import { resolveEmailProvider } from "./provider";
import { sendViaGmail } from "./gmail-transport";
import { createAdminClient } from "@/lib/supabase/server";

export interface EmailAttachment {
  /** Filename as it should appear in the recipient's inbox. */
  filename: string;
  /** Raw bytes — base64-encoded for transport to Resend. */
  content:  Buffer | Uint8Array | string;
  /** MIME — defaults to application/pdf when omitted. */
  contentType?: string;
}

import { recordEmail } from "./log";

export interface EmailMessage {
  /** Single recipient for now. Cc / Bcc come when needed. */
  to:          string;
  subject:     string;
  /** Plain-text fallback. Required. */
  text:        string;
  /** HTML version. Optional — falls back to text/plain only if absent. */
  html?:       string;
  /** Per-message "From" header. Defaults to a Resend-onboarding sandbox
   *  address when not provided, but real production sends should pass the
   *  reseller's verified domain (e.g. billing@anutech.in). */
  from?:       string;
  replyTo?:    string;
  attachments?: EmailAttachment[];
  /**
   * Routing context (migration 0235). OPTIONAL on purpose.
   *
   * Every existing caller keeps working unchanged and keeps going through
   * Resend — introducing a per-tenant transport must not quietly change where
   * twenty-odd existing call sites send from. Pass it and the tenant's choice
   * applies; omit it and this behaves exactly as it did before.
   */
  route?: EmailRoute;
  /** Label for email_log — "renewal_reminder", "quote", "invoice", …
   *  Optional: an unlabelled send is still logged, just less searchable.
   *  Never required, because a log that can be skipped by forgetting an
   *  argument is the exact failure this table exists to remove. */
  kind?: string;
}

export interface EmailRoute {
  tenantId: string;
  /** Drives only the bounce caution, never the routing decision itself. */
  messageClass?: NotificationClass;
}

export type EmailSendStatus = "sent" | "stubbed" | "failed";

export interface EmailSendResult {
  status:       EmailSendStatus;
  providerId:   string | null;
  errorMessage: string | null;
  /**
   * Which transport this result is about. Recorded per message because a tenant
   * can switch provider between two sends and the log must stay truthful about
   * which one each went through.
   *
   * REQUIRED, not optional — and that is the whole point. It used to be optional
   * with a `?? "resend"` default at the log call, which meant a return statement
   * that forgot it did not fail to compile, it quietly claimed Resend. That is
   * exactly what happened on the Gmail failure path: the log recorded
   * `provider=resend` for a message Resend never touched. Making it required
   * moves that from "somebody must remember" to "it does not compile" — the same
   * reasoning that put the log write inside sendEmail() in the first place.
   */
  provider:     "resend" | "gmail" | "stub";
}

/**
 * Send an email. Safe to call without RESEND_API_KEY — falls back to stub
 * mode so callers don't need to branch.
 */
/**
 * Send an email and record the attempt.
 *
 * The wrapper exists so the log write cannot be skipped. Logging inside
 * sendEmailInner would mean repeating it at every return point, and the next
 * return point somebody adds would silently not log — precisely how the three
 * existing per-feature logs ended up with gaps.
 */
export async function sendEmail(msg: EmailMessage): Promise<EmailSendResult> {
  const result = await sendEmailInner(msg);
  await recordEmail({
    tenantId: msg.route?.tenantId ?? null,
    recipient: msg.to,
    subject: msg.subject,
    kind: msg.kind ?? null,
    provider: result.provider,
  }, result);
  return result;
}

async function sendEmailInner(msg: EmailMessage): Promise<EmailSendResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const fromDefault = process.env.RESEND_FROM_DEFAULT?.trim() || "onboarding@resend.dev";
  // INTERIM (until the tenant's sending domain is verified on Resend): when set,
  // RESEND_FROM_OVERRIDE forces the From on EVERY email, ignoring the caller's
  // `from` (which is the tenant's own @-domain and 403s on Resend until verified).
  // Set it to e.g. "Excel Technologies <onboarding@resend.dev>" to unblock sends
  // today; UNSET it the moment the real domain is verified to revert to per-tenant
  // From. Reply-To stays the tenant's address, so customer replies still route right.
  const fromOverride = process.env.RESEND_FROM_OVERRIDE?.trim();

  // ── Per-tenant routing (migration 0235) ───────────────────────────
  // Only when the caller supplied `route`. Without it nothing below runs and the
  // behaviour is byte-for-byte what it was, which is what keeps twenty-odd
  // existing call sites safe.
  if (msg.route?.tenantId) {
    const decision = await routeForTenant(msg.route, Boolean(apiKey));

    if (decision.blocked) {
      // `decision.requested`, NOT `decision.provider`. Blocked means no transport
      // ran at all, so "which one carried it" has no answer and "which one the
      // resolver last considered" is a lie about a send that never happened. The
      // tenant's own choice is the only true thing left, and it is also the one
      // an operator searches by when a tenant reports mail not going out.
      return {
        status: "failed",
        providerId: null,
        errorMessage: decision.blocked,
        provider: decision.requested,
      };
    }
    // A fallback is never silent: the tenant asked for Gmail and did not get it,
    // and the only way anyone finds out otherwise is by noticing the From address.
    if (decision.fellBack) {
      console.warn(`[email/send] tenant ${msg.route.tenantId}: ${decision.reason} — sent via Resend instead.`);
    }
    if (decision.caution) {
      console.warn(`[email/send] tenant ${msg.route.tenantId}: ${decision.caution}`);
    }

    if (decision.provider === "gmail" && decision.gmail) {
      const r = await sendViaGmail({
        to: msg.to,
        from: msg.from || decision.gmail.senderEmail || fromDefault,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        replyTo: msg.replyTo,
        attachments: msg.attachments,
        accessToken: decision.gmail.accessToken,
        refreshToken: decision.gmail.refreshToken,
      });
      if (r.ok) return { status: "sent", providerId: r.messageId || null, errorMessage: null, provider: "gmail" };
      // THE BUG THIS FILE WAS OPENED FOR. Gmail was chosen, Gmail was attempted,
      // Gmail failed — and this return omitted `provider`, so the log defaulted to
      // "resend" for a message Resend never saw. Note the send stops here: there is
      // no fallback after a failed Gmail attempt, so the row is the only trace.
      return {
        status: "failed",
        providerId: null,
        errorMessage: `Gmail ${r.failure}: ${r.detail}`,
        provider: "gmail",
      };
    }
    // Anything else falls through to the Resend path below.
  }

  // ── Stub mode ─────────────────────────────────────────────────────
  if (!apiKey) {
    // Log to server console for debugging visibility. In prod with no key,
    // the renewal cron still runs all logic — just doesn't push the message
    // out the door. Status='stubbed' is recorded by the caller in
    // renewal_email_log so the audit chain stays intact.
    if (typeof console !== "undefined") {
      // eslint-disable-next-line no-console
      console.warn(
        `[email/send] STUB MODE — RESEND_API_KEY not set. Would have sent:\n` +
        `  to:      ${msg.to}\n` +
        `  subject: ${msg.subject}\n` +
        `  attachments: ${msg.attachments?.map((a) => a.filename).join(", ") ?? "(none)"}`
      );
    }
    return { status: "stubbed", providerId: null, errorMessage: null, provider: "stub" };
  }

  // ── Real mode (Resend) ────────────────────────────────────────────
  try {
    // Normalize attachments — Resend wants base64.
    const attachments = msg.attachments?.map((a) => ({
      filename: a.filename,
      content:
        typeof a.content === "string"
          ? a.content
          : Buffer.from(a.content).toString("base64"),
      // Resend infers content-type from filename, but we can hint:
      content_type: a.contentType,
    }));

    const body = {
      from:     fromOverride || msg.from || fromDefault,
      to:       [msg.to],
      subject:  msg.subject,
      text:     msg.text,
      html:     msg.html,
      reply_to: msg.replyTo,
      attachments,
    };

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "<no body>");
      return {
        status:       "failed",
        providerId:   null,
        errorMessage: `Resend ${res.status}: ${errText.slice(0, 200)}`,
        provider:     "resend",
      };
    }

    const json = await res.json() as { id?: string };
    return {
      status:       "sent",
      providerId:   json.id ?? null,
      errorMessage: null,
      provider:     "resend",
    };
  } catch (err) {
    return {
      status:       "failed",
      providerId:   null,
      errorMessage: (err as Error).message,
      provider:     "resend",
    };
  }
}

/** True if Resend is configured and real sends will happen. */
export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

/**
 * Load the tenant's routing choice and the sending account's tokens.
 *
 * Separate from `sendEmail` because it is the only part that touches the
 * database, and because a failure to READ the setting must never become a failure
 * to send: any error here resolves to Resend with a stated reason rather than
 * throwing. A transport that stops working because a settings lookup hiccupped
 * would be a worse bug than the one this feature fixes.
 */
/** The fields the Gmail transport needs from the sending account. */
interface SenderToken {
  access_token:  string | null;
  refresh_token: string | null;
  scopes:        string | null;
  google_email:  string | null;
}

async function routeForTenant(
  route: EmailRoute,
  resendConfigured: boolean,
): Promise<ReturnType<typeof resolveEmailProvider> & {
  gmail?: { accessToken: string | null; refreshToken: string | null; senderEmail: string | null };
}> {
  try {
    const admin = createAdminClient();

    const { data: tenant } = await admin
      .from("tenants")
      .select("email_provider, gmail_sender_user_id")
      .eq("id", route.tenantId)
      .maybeSingle();

    const senderId = tenant?.gmail_sender_user_id ?? null;

    let tok: SenderToken | null = null;
    if (senderId) {
      const { data } = await admin
        .from("user_google_tokens")
        .select("access_token, refresh_token, scopes, google_email")
        .eq("user_id", senderId)
        .maybeSingle();
      // Cast through unknown: the typed client narrows a partial select on this
      // table to `never`, and fighting that generic here buys nothing — the shape
      // is pinned by the local annotation above.
      // Cast through unknown: the typed client narrows a partial select on this
      // table to `never`. `typeof tok` cannot be used here — after `= null` it
      // narrows to `null`, which silently turns every later field access into an
      // error on `never`. A named type is the fix.
      tok = (data as unknown as SenderToken) ?? null;
    }

    const decision = resolveEmailProvider({
      requested: tenant?.email_provider,
      senderUserId: senderId,
      senderRefreshToken: tok?.refresh_token,
      senderScopes: tok?.scopes,
      resendConfigured,
      messageClass: route.messageClass,
    });

    if (decision.provider !== "gmail") return decision;
    return {
      ...decision,
      gmail: {
        accessToken: tok?.access_token ?? null,
        refreshToken: tok?.refresh_token ?? null,
        senderEmail: tok?.google_email ?? null,
      },
    };
  } catch (e) {
    return {
      provider: "resend",
      // The settings read is what failed, so the tenant's choice is genuinely
      // unknown here. "resend" is what we are about to do, not a claim about what
      // they picked — and `reason` says so.
      requested: "resend",
      fellBack: true,
      reason: `Could not read the tenant's email settings (${(e as Error).message})`,
      caution: null,
      blocked: null,
    };
  }
}
