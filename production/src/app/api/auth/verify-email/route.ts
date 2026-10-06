/**
 * POST /api/auth/verify-email  { token }  (R-048, 4 Oct 2026)
 * Confirms the email of the signup that owns this one-time token. Public by design: the token
 * IS the credential (it only exists in the email). Rate-limited per IP against guessing.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { confirmEmailToken } from "@/lib/auth/email-verification";
import { rateLimit, clientIp } from "@/lib/security/rate-limit";

export async function POST(request: NextRequest) {
  const rl = rateLimit(`verify-email:${clientIp(request.headers)}`, { limit: 20, windowMs: 10 * 60_000 });
  if (!rl.ok) return NextResponse.json({ ok: false, reason: "rate_limited" }, { status: 429 });
  const body = (await request.json().catch(() => ({}))) as { token?: unknown };
  const token = typeof body.token === "string" ? body.token : "";
  const result = await confirmEmailToken(createAdminClient(), token);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
