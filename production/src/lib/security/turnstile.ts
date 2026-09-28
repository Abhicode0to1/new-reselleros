/**
 * Cloudflare Turnstile — server-side verify (S20, 28 Sep 2026).
 *
 * ─── KYUN ───────────────────────────────────────────────────────────────────
 * Rate limiter ek IP ko rokta hai; bot-farm hazaar IP se aata hai. /api/public/agent/chat
 * har message par PAID Gemini jalata hai, enquiry email + auto-quote bhejta hai, signup
 * naya tenant banata hai — teeno ke liye "insaan hai ya script" ek alag sawal hai.
 *
 * ─── BINA KEY KE NO-OP ──────────────────────────────────────────────────────
 * `TURNSTILE_SECRET_KEY` set nahi → `verifyTurnstile` hamesha `{ ok: true, skipped: true }`.
 * Isliye ye helper aaj route me lag sakta hai aur kuch nahi todta. Key TABHI set karo jab
 * form (UI) widget laga kar token bhejne lage — warna har asli submit 403 khayega.
 * Kram: docs/SECURITY-RUNBOOK.md.
 *
 * ─── CLOUDFLARE BAND HO TO? ─────────────────────────────────────────────────
 * Network error / 5xx par KHULA (fail-open) — warna Cloudflare ka ek outage hamari saari
 * enquiries kha jata, aur attacker Cloudflare ko band nahi kar sakta. Kharche ka dhakkan
 * tab bhi rate limiter hai. Par Cloudflare ne saaf `success:false` kaha → BAND.
 */

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Form field / header jahan widget token daalta hai. */
export const TURNSTILE_FIELD = "cf-turnstile-response";
export const TURNSTILE_HEADER = "x-turnstile-token";

export interface TurnstileResult {
  ok: boolean;
  /** true = key set nahi, ya Cloudflare tak pahunch nahi — jaanch hui hi nahi. */
  skipped?: boolean;
  /** Mana karne ki wajah (log ke liye; user ko generic sandesh dikhao). */
  reason?: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function turnstileEnabled(): boolean {
  return !!process.env.TURNSTILE_SECRET_KEY?.trim();
}

/**
 * Request se token nikaalo — header `x-turnstile-token`, ya JSON body ka
 * `cf-turnstile-response` / `turnstileToken`. Body pehle hi parse ho chuki ho to wahi do.
 */
export function readTurnstileToken(headers: Headers, body?: unknown): string | null {
  const h = headers.get(TURNSTILE_HEADER)?.trim();
  if (h) return h;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const v = b[TURNSTILE_FIELD] ?? b.turnstileToken;
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export async function verifyTurnstile(
  token: string | null | undefined,
  remoteIp?: string | null,
  fetchImpl: FetchLike = fetch,
): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) return { ok: true, skipped: true };

  /* Cloudflare ki apni seema 2048 hai; lamba token jaanch se pehle hi jhootha. */
  if (!token || token.length > 2048) return { ok: false, reason: "missing-token" };

  const form = new URLSearchParams({ secret, response: token });
  if (remoteIp && remoteIp !== "unknown") form.set("remoteip", remoteIp);

  try {
    const r = await fetchImpl(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) {
      console.warn(`[turnstile] siteverify ${r.status} — fail-open`);
      return { ok: true, skipped: true, reason: `siteverify-${r.status}` };
    }
    const j = (await r.json()) as { success?: boolean; "error-codes"?: string[] };
    if (j.success === true) return { ok: true };
    return { ok: false, reason: (j["error-codes"] ?? []).join(",") || "rejected" };
  } catch {
    console.warn("[turnstile] siteverify unreachable — fail-open");
    return { ok: true, skipped: true, reason: "unreachable" };
  }
}
