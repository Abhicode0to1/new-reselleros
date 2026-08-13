/**
 * Google OAuth helpers for the Contacts integration.
 *
 * This is a DEDICATED OAuth client (env GOOGLE_OAUTH_CLIENT_ID/SECRET), separate
 * from Supabase's login OAuth — because two-way sync needs a durable refresh
 * token (offline access) that a background cron can use, which the login session
 * token can't provide.
 *
 * Scope note: `contacts` (read+write) is a Google "sensitive" scope. In testing
 * mode it works for allow-listed test users immediately; production multi-tenant
 * use requires Google's OAuth app verification.
 */
import { type NextRequest } from "next/server";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

/** openid+email to identify the account; contacts for read+write sync. */
export const GOOGLE_CONTACTS_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/contacts",
].join(" ");

/**
 * Sending scope, kept SEPARATE from the contacts scopes on purpose.
 *
 * gmail.send is send-only: it cannot read, list or delete a single message. That
 * is the whole reason to prefer it over an SMTP App Password, which grants full
 * mailbox access — storing one of those per tenant would be materially worse than
 * storing a send-only API key.
 *
 * Separate because the consent screen lists what it is asking for, and bundling
 * "send email as you" into a button labelled "Connect Google Contacts" is the
 * kind of thing that makes people click Deny — rightly.
 */
export const GMAIL_SEND_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.send",
].join(" ");

export function googleOAuthCreds(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * Absolute origin for building redirect URIs. Mirrors the login callback's
 * forwarded-host logic (Cloud Run binds 0.0.0.0, so request.url origin is wrong)
 * and falls back to NEXT_PUBLIC_APP_URL, then the request origin.
 */
export function originFromRequest(request: NextRequest): string {
  const h = request.headers;
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  if (host) return `${proto}://${host}`;
  const env = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (env) return env;
  return new URL(request.url).origin;
}

/** The redirect URI must match EXACTLY what's registered in Google Cloud. */
export function contactsRedirectUri(origin: string): string {
  return `${origin}/api/integrations/google-contacts/callback`;
}

/**
 * Separate callback from contacts, and therefore a SECOND authorised redirect
 * URI to register in Google Cloud Console.
 *
 * Sharing one callback would be less setup but the handler could no longer tell
 * which consent it was completing, so it could not decide what to store or where
 * to send the user back to. Two URIs, two unambiguous handlers.
 */
export function gmailRedirectUri(origin: string): string {
  return `${origin}/api/integrations/google-gmail/callback`;
}

/**
 * @param scope Space-separated scopes. Defaults to contacts so the existing
 *        caller keeps its behaviour — a default that silently changed what a
 *        consent screen asks for would be a nasty way to break trust.
 */
export function buildAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  scope: string = GOOGLE_CONTACTS_SCOPES,
): string {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    access_type: "offline",     // → refresh token
    prompt: "consent",          // force refresh-token issuance on reconnect
    /**
     * Load-bearing for BOTH flows, and easy to talk yourself out of.
     *
     * Contacts and Gmail write the same `user_google_tokens` row (one per
     * user_id), so the second consent replaces the first one's access token and
     * `scopes`. Without this flag, connecting Gmail after Contacts would store a
     * send-only token and contacts sync would start returning 403 — an
     * integration broken by connecting a different one.
     *
     * With it, Google returns a token carrying everything the account has
     * granted this client, so `scopes` describes the token accurately and
     * neither flow can knock the other over.
     */
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_URL}?${p.toString()}`;
}

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

export async function exchangeCode(
  code: string,
  redirectUri: string,
  creds: { clientId: string; clientSecret: string },
): Promise<GoogleTokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as GoogleTokenResponse;
}

export async function refreshAccessToken(
  refreshToken: string,
  creds: { clientId: string; clientSecret: string },
): Promise<GoogleTokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Google token refresh failed: ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as GoogleTokenResponse;
}

export async function fetchGoogleEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return null;
    const data = (await res.json()) as { email?: string };
    return data.email ?? null;
  } catch {
    return null;
  }
}
