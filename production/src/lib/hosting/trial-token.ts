import "server-only";
import { createHmac } from "crypto";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";

/**
 * Stateless, signed email-verification token for the hosting trial (2 Sep 2026).
 *
 * The trial only provisions a real account AFTER the customer clicks a link sent
 * to their email — that click is the bot guard. The link carries this token: an
 * HMAC over `{leadId, exp}`, so no verification row is needed in the database
 * and a forged or expired link cannot provision anything. Idempotency (a link
 * clicked twice) is handled downstream by DirectAdmin's "account already exists"
 * check, not here.
 *
 * Secret: HOSTING_TRIAL_SECRET, falling back to CRON_SECRET (already set for the
 * cron jobs). If neither is set, tokens cannot be signed OR verified — the flow
 * fails closed rather than trusting an unsigned link.
 */
const TTL_MS = 48 * 60 * 60 * 1000; // link valid for 48 hours

function secret(): string | null {
  return process.env.HOSTING_TRIAL_SECRET?.trim() || process.env.CRON_SECRET?.trim() || null;
}

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function sign(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/** Returns a token, or null when no secret is configured (caller must handle). */
export function makeTrialToken(leadId: string, now = Date.now()): string | null {
  const key = secret();
  if (!key) return null;
  const payload = b64url(JSON.stringify({ leadId, exp: now + TTL_MS }));
  return `${payload}.${sign(payload, key)}`;
}

export type TrialTokenResult =
  | { ok: true; leadId: string }
  | { ok: false; reason: "no_secret" | "malformed" | "bad_signature" | "expired" };

export function verifyTrialToken(token: string, now = Date.now()): TrialTokenResult {
  const key = secret();
  if (!key) return { ok: false, reason: "no_secret" };
  const [payload, sig] = (token || "").split(".");
  if (!payload || !sig) return { ok: false, reason: "malformed" };
  if (!timingSafeEqualStr(sig, sign(payload, key))) return { ok: false, reason: "bad_signature" };
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { leadId?: string; exp?: number };
    if (!data.leadId || typeof data.exp !== "number") return { ok: false, reason: "malformed" };
    if (now > data.exp) return { ok: false, reason: "expired" };
    return { ok: true, leadId: data.leadId };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}
