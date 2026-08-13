/**
 * Which transport sends this message — and whether that is a good idea.
 *
 * Kept as a pure decision, separate from `sendEmail`, because it is the point
 * where a message can silently take the wrong path. Every branch below either
 * routes mail correctly or loses it quietly.
 *
 * ─── THE ASYMMETRY THAT DRIVES EVERY RULE HERE ───────────────────────────────
 * Resend reports bounces and complaints and keeps a suppression list. Gmail
 * reports nothing: send to a dead address and the API returns success while the
 * bounce arrives later as an email in the sender's mailbox. For a renewal reminder
 * that is the exact failure this project keeps hitting — the app records "sent",
 * the customer heard nothing, and the subscription lapses.
 *
 * So Gmail is never chosen by accident. It is chosen when the tenant asked for it,
 * and when it IS chosen for a bounce-sensitive message the decision carries a
 * caution rather than being silently overridden. Overriding would be the easy
 * call and the wrong one: it is their business, and a setting that quietly does
 * something other than what it says is worse than a stated trade-off.
 */
import type { NotificationClass } from "@/lib/mastery/quiet-hours";

export type EmailProvider = "resend" | "gmail";

/** Gmail's send-only scope. Anything less cannot send, however valid the token. */
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

/**
 * Classes where a silent bounce costs money or a relationship.
 *
 * `reminder` is the one that matters most: a renewal notice that vanishes takes a
 * subscription with it. `transactional` covers receipts and invoices, where the
 * recipient is waiting and will chase if nothing arrives — noticed sooner, but
 * still not something to lose.
 */
const BOUNCE_SENSITIVE: ReadonlySet<NotificationClass> = new Set<NotificationClass>([
  "reminder", "transactional", "security",
]);

export interface ProviderInput {
  /** `tenants.email_provider`. */
  requested: string | null | undefined;
  /** `tenants.gmail_sender_user_id`. */
  senderUserId: string | null | undefined;
  /** The sender's stored refresh token, if the account is connected. */
  senderRefreshToken?: string | null;
  /** `user_google_tokens.scopes` for that user — NULL means unknown. */
  senderScopes?: string | null;
  /** Is the platform Resend key present? */
  resendConfigured: boolean;
  /** What kind of message this is. Drives the caution, never the routing. */
  messageClass?: NotificationClass;
}

export interface ProviderDecision {
  provider: EmailProvider;
  /** True when the tenant asked for gmail and it could not be used. */
  fellBack: boolean;
  /** Why this provider, in one sentence. */
  reason: string;
  /**
   * A real cost of this route that the operator should know about. Not an error —
   * the message still sends.
   */
  caution: string | null;
  /** Set when NOTHING can send. The caller must not pretend it did. */
  blocked: string | null;
}

/** Does this token's granted scope set allow sending? */
export function canSendWithScopes(scopes: string | null | undefined): boolean {
  if (typeof scopes !== "string" || scopes.trim() === "") return false;
  return scopes.split(/\s+/).includes(GMAIL_SEND_SCOPE);
}

export function resolveEmailProvider(input: ProviderInput): ProviderDecision {
  const wantsGmail = (input.requested ?? "resend").toLowerCase() === "gmail";

  const resendOr = (reason: string, fellBack: boolean): ProviderDecision => {
    if (input.resendConfigured) {
      return { provider: "resend", fellBack, reason, caution: null, blocked: null };
    }
    return {
      provider: "resend", fellBack, reason,
      caution: null,
      blocked: fellBack
        ? `${reason} and no Resend key is configured either, so this message cannot be sent at all.`
        : "No email provider is configured, so this message cannot be sent.",
    };
  };

  if (!wantsGmail) {
    return resendOr("Tenant sends through Resend.", false);
  }

  // ── Gmail was asked for. Every reason it might not work, named. ─────────
  if (!input.senderUserId) {
    return resendOr("Gmail is selected but no sending account is chosen", true);
  }
  if (!input.senderRefreshToken) {
    return resendOr("The chosen Gmail account is not connected (no refresh token)", true);
  }
  // Unknown scopes are treated as "cannot send". A token granted before
  // gmail.send existed authenticates perfectly and fails only at send time, in a
  // cron, at night — assuming it works is how that becomes a lost renewal.
  if (!canSendWithScopes(input.senderScopes)) {
    return resendOr("The chosen Gmail account has not granted permission to send mail", true);
  }

  const cls = input.messageClass;
  const caution = cls && BOUNCE_SENSITIVE.has(cls)
    ? `Sending a ${cls} message through Gmail: bounces are not reported, so a dead address will look like a successful send.`
    : null;

  return {
    provider: "gmail",
    fellBack: false,
    reason: "Tenant sends through their own Gmail account.",
    caution,
    blocked: null,
  };
}
