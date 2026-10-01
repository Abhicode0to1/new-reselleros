/**
 * POST /api/public/expense-claim
 *
 * Public (no session) endpoint the shareable expense-claim link posts to. The
 * link carries the tenant id + HMAC signature; the employee proves themselves
 * with their attendance PIN. We verify the token, optionally stash a receipt
 * photo in the private expense-receipts bucket, then call submit_expense_claim
 * (SECURITY DEFINER — verifies PIN + advance server-side). The claim lands
 * 'pending'; the owner approves it in-app before anything hits the books.
 *
 * Body: { tid, sig, employeeId, pin, amount, category, purpose?, spentOn, photo? }
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { verifyClaimToken } from "@/lib/claim-token";
import { publicDbError } from "@/app/api/public/_lib/db-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  const tid       = String(body.tid ?? "");
  const sig       = String(body.sig ?? "");
  const employeeId = String(body.employeeId ?? "");
  const pin       = String(body.pin ?? "");
  const amount    = Math.round(Number(body.amount));
  const category  = String(body.category ?? "").trim();
  const purpose   = body.purpose ? String(body.purpose).trim() : null;
  const spentOn   = String(body.spentOn ?? "").slice(0, 10);
  const photo     = typeof body.photo === "string" ? body.photo : null;

  if (!verifyClaimToken(tid, sig)) {
    return NextResponse.json({ error: "This link is invalid or expired. Ask the office for a fresh link." }, { status: 403 });
  }
  if (!employeeId || !pin) return NextResponse.json({ error: "Pick your name and enter your PIN" }, { status: 400 });
  if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "Enter a valid amount" }, { status: 400 });
  if (!category) return NextResponse.json({ error: "Choose a category" }, { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spentOn)) return NextResponse.json({ error: "Pick the date you spent on" }, { status: 400 });

  const admin = createAdminClient();

  // Optional receipt photo → private bucket. Best-effort: never block the claim.
  let receiptPath: string | null = null;
  if (photo) {
    try {
      const base64 = photo.includes(",") ? photo.split(",")[1] : photo;
      const buf = Buffer.from(base64, "base64");
      if (buf.length > 0 && buf.length < 4_000_000) {
        const stamp = spentOn.replace(/-/g, "");
        const rand = Math.abs(hashStr(`${employeeId}:${stamp}:${amount}:${buf.length}`)).toString(36);
        const path = `${tid}/${employeeId}/${stamp}_${rand}.jpg`;
        const up = await admin.storage.from("expense-receipts").upload(path, buf, { contentType: "image/jpeg", upsert: true });
        if (!up.error) receiptPath = path;
      }
    } catch { /* receipt is optional */ }
  }

  const { data, error } = await admin.rpc("submit_expense_claim", {
    p_tenant_id:    tid,
    p_employee_id:  employeeId,
    p_pin:          pin,
    p_amount:       amount,
    p_category:     category,
    p_purpose:      purpose,
    p_spent_on:     spentOn,
    p_receipt_path: receiptPath,
  });

  if (error) {
    // The RPC raises friendly messages (Wrong PIN, no open advance, over-limit) as P0001;
    // anything else is a fault, and its raw text stays in the server log (R-026).
    const e = publicDbError("expense-claim", error, "We could not submit the claim just now. Please try again in a minute.", { passCodes: { P0001: 400 } });
    return NextResponse.json({ error: e.message }, { status: e.status });
  }

  // Fresh claimable balance so the form can update without a reload.
  const { data: remaining } = await admin.rpc("verify_claim_access", {
    p_tenant_id:   tid,
    p_employee_id: employeeId,
    p_pin:         pin,
  });

  return NextResponse.json({ ok: true, claimId: data as string, remaining: Number(remaining ?? 0) });
}

/** Deterministic small hash for a stable-ish receipt filename (no Math.random). */
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; }
  return h;
}
