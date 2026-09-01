/**
 * Signed tenant token for the public expense-claim link (/expense-claim).
 *
 * The link is opened with NO login, so it carries the tenant id + an HMAC
 * signature. The server recomputes the signature and constant-time compares —
 * a tampered/guessed tenant id won't verify. The employee's attendance PIN is
 * the real second factor, and every claim lands 'pending' (owner approves), so
 * this token just routes the form to the right reseller.
 *
 * Secret: reuse PDF_SIGNING_SECRET, else the service-role key (server-only).
 */
import { createHmac, timingSafeEqual } from "crypto";

let cachedSecret: string | null = null;
function SECRET(): string {
  if (cachedSecret) return cachedSecret;
  /* Kabhi "" nahi (audit C6): khaali key par HMAC = har token forgeable, aur wo
     bug chup-chaap "sab links chal rahe hain" jaisa dikhta. Dono var gayab hon to
     pehla sign/verify hi phat jaye — khaali chaabi se darwaza khula rakhne se
     accha hai bina chaabi ke band rehna. SERVICE_ROLE fallback jaan-boojh kar
     RAKHA hai: aaj tak ke saare tokens usi se sign hue hain; use hatana har
     baante hue link ko todta. Alag PDF_SIGNING_SECRET set karna abhi bhi behtar
     hai (key-reuse do alag suraksha-daayron me) — .env.example me darj.  */
  const s = process.env.PDF_SIGNING_SECRET?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!s) throw new Error("No signing secret: set PDF_SIGNING_SECRET (or SUPABASE_SERVICE_ROLE_KEY) — refusing to sign with an empty key");
  cachedSecret = s;
  return s;
}

export function signClaimToken(tenantId: string): string {
  return createHmac("sha256", SECRET()).update(`expense-claim:${tenantId}`).digest("hex");
}

export function verifyClaimToken(tenantId: string, sig: string): boolean {
  if (!tenantId || !sig) return false;
  const expected = signClaimToken(tenantId);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Full shareable claim link for a tenant. */
export function claimLinkUrl(appUrl: string, tenantId: string): string {
  const base = appUrl.replace(/\/$/, "");
  return `${base}/expense-claim?tid=${encodeURIComponent(tenantId)}&sig=${signClaimToken(tenantId)}`;
}
