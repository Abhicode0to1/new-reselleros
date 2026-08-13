/**
 * Send one message through the Gmail API.
 *
 * Chosen over SMTP for one reason above all: `gmail.send` is a SEND-ONLY scope.
 * An SMTP App Password grants full mailbox access — read, send, delete — and
 * storing one of those per tenant would be materially more dangerous than storing
 * a send-only API key. It also needs no new dependency: this is a fetch, the same
 * way the Contacts sync already talks to Google.
 *
 * ─── WHAT THIS DOES NOT GIVE YOU, STATED PLAINLY ─────────────────────────────
 * No bounce or complaint webhooks, and no suppression list. A dead recipient
 * address fails silently and this call still returns success, because the failure
 * arrives later as a bounce email to the sender's inbox. For renewal reminders
 * that is the exact failure this project has been chasing all along — "the app
 * says it sent, the customer heard nothing" — so transactional mail should stay on
 * a provider that reports bounces. This is the right transport for mail that
 * should come FROM a person and be replied to in their inbox.
 *
 * ─── FAILURES ARE CLASSIFIED, NOT JUST THROWN ────────────────────────────────
 * The interesting ones are not network errors. A token can be revoked from the
 * user's Google account page at any time, and consent for a newly added scope is
 * simply never granted — both surface as ordinary HTTP errors that would otherwise
 * read as "sending is broken" when the fix is "reconnect the account".
 */
import { refreshAccessToken, googleOAuthCreds } from "@/lib/google/oauth";
import { buildGmailRaw, type MimeInput } from "./gmail-message";

const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
/** Google is usually fast; a hung send must not hold a cron open. */
const TIMEOUT_MS = 15_000;

export type GmailSendFailure =
  /** The stored token no longer works and cannot be refreshed. Reconnect. */
  | "reauth_required"
  /** Authenticated, but this token was never granted gmail.send. */
  | "scope_missing"
  /** Google's per-user sending quota. Retry later; do not reconnect. */
  | "rate_limited"
  /** Google said no for another reason. */
  | "rejected"
  /** Never reached Google. */
  | "network";

export type GmailSendResult =
  | { ok: true; messageId: string; threadId?: string }
  | { ok: false; failure: GmailSendFailure; detail: string; retryable: boolean };

export interface GmailSendInput extends MimeInput {
  /** A currently valid access token, or null to refresh from the refresh token. */
  accessToken: string | null;
  refreshToken: string | null;
}

/**
 * Send, refreshing the access token once if it has expired.
 *
 * Returns a result rather than throwing: every caller here is a cron or a webhook
 * where one failed message must not abort the batch.
 */
export async function sendViaGmail(input: GmailSendInput): Promise<GmailSendResult> {
  const creds = googleOAuthCreds();
  if (!creds) {
    return {
      ok: false, failure: "reauth_required", retryable: false,
      detail: "GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET are not configured on this server.",
    };
  }

  let token = input.accessToken?.trim() || null;

  const attempt = async (bearer: string): Promise<Response> =>
    fetch(SEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: buildGmailRaw(input) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

  try {
    if (!token) {
      if (!input.refreshToken) {
        return {
          ok: false, failure: "reauth_required", retryable: false,
          detail: "No access token and no refresh token — the account has never been connected, or the connection was removed.",
        };
      }
      const refreshed = await refreshAccessToken(input.refreshToken, creds);
      token = refreshed.access_token;
    }

    let res = await attempt(token);

    // 401 means the access token is stale. Refresh ONCE and retry; refreshing in a
    // loop turns a revoked grant into a hammering of Google's token endpoint.
    if (res.status === 401 && input.refreshToken) {
      try {
        const refreshed = await refreshAccessToken(input.refreshToken, creds);
        token = refreshed.access_token;
        res = await attempt(token);
      } catch {
        return {
          ok: false, failure: "reauth_required", retryable: false,
          detail: "The stored Google token could not be refreshed. It was most likely revoked from the account's security settings. Reconnect the account.",
        };
      }
    }

    if (res.ok) {
      const json = await res.json().catch(() => ({} as Record<string, unknown>));
      return {
        ok: true,
        messageId: typeof json.id === "string" ? json.id : "",
        threadId: typeof json.threadId === "string" ? json.threadId : undefined,
      };
    }

    const body = await res.text().catch(() => "");

    if (res.status === 401) {
      return {
        ok: false, failure: "reauth_required", retryable: false,
        detail: "Google rejected the token. Reconnect the sending account.",
      };
    }
    // 403 with an insufficient-scope hint is the case that WILL happen: a token
    // granted before gmail.send was added authenticates fine and cannot send.
    // Reported separately so the fix reads "re-consent", not "sending is broken".
    if (res.status === 403 && /insufficient|scope|ACCESS_TOKEN_SCOPE/i.test(body)) {
      return {
        ok: false, failure: "scope_missing", retryable: false,
        detail: "This Google account is connected but has not granted permission to send mail. Reconnect it and approve the sending permission.",
      };
    }
    if (res.status === 403 || res.status === 429) {
      return {
        ok: false, failure: "rate_limited", retryable: true,
        detail: `Google is rate limiting this account (HTTP ${res.status}). Sending quota is per user, per day.`,
      };
    }

    return {
      ok: false, failure: "rejected", retryable: res.status >= 500,
      detail: `Gmail refused the message (HTTP ${res.status}). ${body.slice(0, 200)}`,
    };
  } catch (e) {
    const err = e as Error;
    return {
      ok: false, failure: "network", retryable: true,
      detail: err.name === "TimeoutError"
        ? `No response from Gmail within ${TIMEOUT_MS / 1000}s.`
        : err.message,
    };
  }
}
