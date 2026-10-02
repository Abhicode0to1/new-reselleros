/**
 * One line for a public route to refuse a bot: `const no = await turnstileRefusal(req.headers, body); if (no) return no;`
 *
 * R-020 (2 Oct 2026). The server helper (verifyTurnstile, S20) existed but no route called
 * it, so enquiry and signup could be scripted. With TURNSTILE_SECRET_KEY unset it is a
 * no-op (verifyTurnstile answers ok/skipped), so this ships safely before the keys exist —
 * the order in docs/SECURITY-RUNBOOK.md §2 (widget live first, THEN the secret) still holds.
 */
import { NextResponse } from "next/server";
import { verifyTurnstile, readTurnstileToken } from "@/lib/security/turnstile";
import { clientIp } from "@/lib/security/rate-limit";

export async function turnstileRefusal(headers: Headers, body: unknown): Promise<NextResponse | null> {
  const ts = await verifyTurnstile(readTurnstileToken(headers, body), clientIp(headers));
  if (ts.ok) return null;
  return NextResponse.json(
    { error: "We could not verify this request. Reload the page and try again." },
    { status: 403 },
  );
}
