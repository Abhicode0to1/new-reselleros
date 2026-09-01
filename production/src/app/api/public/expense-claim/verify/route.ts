/**
 * POST /api/public/expense-claim/verify  { tid, sig, employeeId, pin }
 *
 * Step 1 of the claim flow: check the employee's PIN once and return how much
 * of their advance is still claimable. The form then lets them log several
 * expenses in a row without re-entering the PIN (it's kept in memory for the
 * session and sent with each submit — never stored).
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { verifyClaimToken } from "@/lib/claim-token";
import { rateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  const tid        = String(body.tid ?? "");
  const sig        = String(body.sig ?? "");
  const employeeId = String(body.employeeId ?? "");
  const pin        = String(body.pin ?? "");

  if (!verifyClaimToken(tid, sig)) {
    return NextResponse.json({ error: "This link is invalid or expired. Ask the office for a fresh link." }, { status: 403 });
  }
  if (!employeeId || !pin) return NextResponse.json({ error: "Pick your name and enter your PIN" }, { status: 400 });

  /* PIN 4–6 ank ka hai aur DB me iska koi attempt-counter nahi (audit A3) —
     IP-wali seema middleware me hai, par PIN par PER-EMPLOYEE tala bhi
     chahiye warna dheere-dheere (ya kai IP se) 10,000 me se sahi mil hi
     jata. 10 galat/ghanta kaafi udaar hai asli ungli-phisalne ke liye. */
  const pinGate = rateLimit(`claim-pin:${tid}:${employeeId}`, { limit: 10, windowMs: 60 * 60_000 });
  if (!pinGate.ok) {
    return NextResponse.json(
      { error: "Bahut galat koshishen — ek ghante baad dobara, ya office se PIN reset karwaiye." },
      { status: 429, headers: { "Retry-After": String(pinGate.retryAfterSec) } },
    );
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("verify_claim_access", {
    p_tenant_id:   tid,
    p_employee_id: employeeId,
    p_pin:         pin,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true, remaining: Number(data ?? 0) });
}
