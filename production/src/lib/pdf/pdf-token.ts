/**
 * Capability tokens for public PDF links (/api/v1/documents/{type}/{id}/pdf).
 *
 * DSP embeds these URLs in its UI, so the browser opens them WITHOUT a Bearer
 * header. Instead of a login, each URL carries an unguessable HMAC token bound
 * to (type, id, tenant). The route fetches the doc by id → reads its tenant →
 * recomputes the token → constant-time compares. No token / wrong token → 403.
 *
 * Secret: dedicated PDF_SIGNING_SECRET if set, else the service-role key (always
 * present server-side, never exposed — the HMAC output doesn't reveal it).
 */
import { createHmac, timingSafeEqual } from "crypto";

export type PdfDocType = "invoice" | "quote";

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

export function signPdfToken(type: PdfDocType, id: string, tenantId: string): string {
  return createHmac("sha256", SECRET()).update(`${type}:${id}:${tenantId}`).digest("hex");
}

export function verifyPdfToken(type: PdfDocType, id: string, tenantId: string, token: string): boolean {
  if (!token) return false;
  const expected = signPdfToken(type, id, tenantId);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(token, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Full downloadable URL for a document PDF (what we put in `pdf_url`). */
export function pdfDownloadUrl(appUrl: string, type: PdfDocType, id: string, tenantId: string): string {
  const base = appUrl.replace(/\/$/, "");
  return `${base}/api/v1/documents/${type}/${encodeURIComponent(id)}/pdf?token=${signPdfToken(type, id, tenantId)}`;
}
