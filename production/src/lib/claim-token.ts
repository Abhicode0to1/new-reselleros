/**
 * Signed tenant token for the public expense-claim link (/expense-claim).
 *
 * The link is opened with NO login, so it carries the tenant id + an HMAC
 * signature. The server recomputes the signature and constant-time compares —
 * a tampered/guessed tenant id won't verify. The employee's attendance PIN is
 * the real second factor, and every claim lands 'pending' (owner approves), so
 * this token just routes the form to the right reseller.
 *
 * Secret: PDF_SIGNING_SECRET, else the service-role key — lib/security/signing-secrets.ts.
 * S20 (28 Sep 2026): verify ab purani service-role chaabi bhi grace window tak maanta hai,
 * warna PDF_SIGNING_SECRET set karte hi employees ke paas pade saare claim link toot jaate.
 * Exp nahi lagaya: ye tenant ka ek sthayi link hai (PIN asli pehra hai), aur owner use ek
 * baar share karta hai.
 */
import { createHmac, timingSafeEqual } from "crypto";
import { signingSecrets } from "@/lib/security/signing-secrets";

const sign = (secret: string, tenantId: string) =>
  createHmac("sha256", secret).update(`expense-claim:${tenantId}`).digest("hex");

export function signClaimToken(tenantId: string): string {
  return sign(signingSecrets().primary, tenantId);
}

export function verifyClaimToken(tenantId: string, sig: string): boolean {
  if (!tenantId || !sig) return false;
  const { primary, legacy } = signingSecrets();
  const b = Buffer.from(sig, "utf8");
  return [primary, ...legacy].some((s) => {
    const a = Buffer.from(sign(s, tenantId), "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

/** Full shareable claim link for a tenant. */
export function claimLinkUrl(appUrl: string, tenantId: string): string {
  const base = appUrl.replace(/\/$/, "");
  return `${base}/expense-claim?tid=${encodeURIComponent(tenantId)}&sig=${signClaimToken(tenantId)}`;
}
