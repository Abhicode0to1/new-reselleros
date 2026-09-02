/**
 * POST /api/integrations/razorpay/test
 *
 * Verifies Razorpay credentials by hitting GET /v1/payments?count=1 with
 * HTTP basic-auth (key_id:key_secret). A 200 here proves both halves of
 * the credential pair are correct AND active — no payment is created.
 */

import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { decryptTenantSecrets } from "@/lib/crypto/tenant-secrets";

export const dynamic = "force-dynamic";
export const runtime  = "nodejs";

export async function POST() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401 });
  }
  const { data: me } = await supabase
    .from("users")
    .select("tenant_id, role")
    .eq("id", authData.user.id)
    .single();
  if (!me) return NextResponse.json({ ok: false, error: "No tenant" }, { status: 403 });
  if (me.role !== "owner") return NextResponse.json({ ok: false, error: "Owner only" }, { status: 403 });

  const admin = createAdminClient();
  const { data: rawSecrets } = await admin
    .from("tenant_secrets")
    .select("razorpay_mode, razorpay_key_id, razorpay_key_secret")
    .eq("tenant_id", me.tenant_id)
    .maybeSingle();
  // The secret is stored sealed (rosv1:…) — decrypt before use, or Basic auth
  // sends the ciphertext and Razorpay always answers "Authentication failed".
  const secrets = decryptTenantSecrets(rawSecrets);
  if (!secrets?.razorpay_key_id || !secrets.razorpay_key_secret) {
    return NextResponse.json({ ok: false, error: "Save credentials first" }, { status: 400 });
  }

  const basic = Buffer.from(`${secrets.razorpay_key_id}:${secrets.razorpay_key_secret}`).toString("base64");
  let res: Response;
  try {
    res = await fetch("https://api.razorpay.com/v1/payments?count=1", {
      method: "GET",
      headers: {
        "Authorization": `Basic ${basic}`,
        "Accept":        "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Network error reaching Razorpay" },
      { status: 502 },
    );
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const friendly = (json && typeof json === "object" && (json as { error?: { description?: string } }).error?.description)
      ?? `Razorpay responded ${res.status}`;
    return NextResponse.json({ ok: false, error: friendly }, { status: 400 });
  }

  return NextResponse.json({
    ok:           true,
    mode:         secrets.razorpay_mode ?? "test",
    payments_seen: (json as { count?: number }).count ?? 0,
  });
}
