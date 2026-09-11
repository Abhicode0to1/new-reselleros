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

export type EmailProvider = "resend" | "gmail" | "smtp";

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
  /**
   * Is a plain SMTP relay configured (`SMTP_HOST`/`PORT`/`USER`/`PASS`)?
   *
   * Added 11 Sep 2026 so the DMS deployment's own credentials work unchanged.
   * Optional, so every existing caller and test keeps its meaning: absent is
   * "no relay", which is what was true before.
   */
  smtpConfigured?: boolean;
  /** What kind of message this is. Drives the caution, never the routing. */
  messageClass?: NotificationClass;
}

export interface ProviderDecision {
  provider: EmailProvider;
  /**
   * What the tenant CHOSE, before any fallback.
   *
   * Exists because `provider` alone cannot describe a blocked send: when nothing
   * can send, no transport was attempted, so the only truthful thing to name is
   * the one the tenant configured. Recording the fallback there instead reports a
   * Gmail problem as a Resend problem, and `where provider='gmail'` — the query
   * anyone runs to ask "is this tenant's Gmail working" — silently misses it.
   */
  requested: EmailProvider;
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
  const asked = (input.requested ?? "resend").toLowerCase();
  const wantsGmail = asked === "gmail";
  const wantsSmtp = asked === "smtp";
  const requested: EmailProvider = wantsGmail ? "gmail" : wantsSmtp ? "smtp" : "resend";

  /* The bounce caution, shared by every transport that does not report one.
     Resend keeps a suppression list and tells us about bounces; Gmail and a
     plain relay both answer "accepted" and let the bounce arrive later as mail
     in somebody's inbox. Stating it per-transport rather than once because the
     sentence has to name which transport, or an operator cannot act on it. */
  const bounceCaution = (via: string): string | null => {
    const cls = input.messageClass;
    return cls && BOUNCE_SENSITIVE.has(cls)
      ? `Sending a ${cls} message through ${via}: bounces are not reported, so a dead address will look like a successful send.`
      : null;
  };

  const smtpDecision = (reason: string, fellBack: boolean): ProviderDecision => ({
    provider: "smtp",
    requested,
    fellBack,
    reason,
    caution: bounceCaution("an SMTP relay"),
    blocked: null,
  });

  /* ─── THE FALLBACK CHAIN ───────────────────────────────────────────────────
     Resend, then SMTP, then blocked. SMTP sits BELOW Resend because Resend
     reports bounces and a relay does not — but it sits ABOVE `blocked`, and
     that is the whole point of this change: a deployment with working relay
     credentials and no Resend key used to be told "no email provider is
     configured" and send nothing. Measured on the DMS environment, which is
     exactly that deployment. A configured transport beats no transport. */
  const resendOr = (reason: string, fellBack: boolean): ProviderDecision => {
    if (input.resendConfigured) {
      return { provider: "resend", requested, fellBack, reason, caution: null, blocked: null };
    }
    if (input.smtpConfigured) {
      return smtpDecision(
        fellBack ? `${reason}, and there is no Resend key — sent through the SMTP relay instead` : reason,
        fellBack,
      );
    }
    return {
      provider: "resend", requested, fellBack, reason,
      caution: null,
      blocked: fellBack
        ? `${reason} and no Resend key or SMTP relay is configured either, so this message cannot be sent at all.`
        : "No email provider is configured, so this message cannot be sent.",
    };
  };

  /* Asked for explicitly. Honoured when it can work, and when it cannot the
     tenant is told why rather than silently rerouted. */
  if (wantsSmtp) {
    if (input.smtpConfigured) {
      return smtpDecision("Tenant sends through their own SMTP relay.", false);
    }
    return resendOr("SMTP is selected but the relay is not configured on this server", true);
  }

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

  return {
    provider: "gmail",
    requested,
    fellBack: false,
    reason: "Tenant sends through their own Gmail account.",
    caution: bounceCaution("Gmail"),
    blocked: null,
  };
}
