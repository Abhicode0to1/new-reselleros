/**
 * GET /api/health/money — is the money machinery actually working?
 *
 * Answers the question that three separate silent failures in this product had
 * no way of answering: not "is it configured", but "will it do anything".
 *
 * SECURITY. The response carries NO secret values — not masked, not truncated.
 * Every credential is reduced to a boolean on the server and only the boolean
 * crosses the wire, so this endpoint cannot leak a key even if its output is
 * pasted into a bug report or a screenshot. Owner-only, matching the
 * integrations routes: knowing which parts of a business's payment plumbing are
 * switched off is itself worth protecting.
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isEmailConfigured } from "@/lib/email/send";
import { moneyHealth, worstSeverity, type MoneyConfigSnapshot } from "@/lib/health/money-readiness";

export const dynamic = "force-dynamic";
export const runtime  = "nodejs";

export async function GET() {
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
  if (!me) return NextResponse.json({ ok: false, error: "User not linked to a tenant" }, { status: 403 });
  if (me.role !== "owner") {
    // Not an error the UI needs to shout about — a non-owner simply sees nothing.
    return NextResponse.json({ ok: true, findings: [], severity: null });
  }

  const admin = createAdminClient();
  const [{ data: secrets }, { data: tenant }] = await Promise.all([
    admin.from("tenant_secrets")
      .select("razorpay_key_id, razorpay_key_secret, razorpay_webhook_secret")
      .eq("tenant_id", me.tenant_id).maybeSingle(),
    admin.from("tenants").select("upi_vpa").eq("id", me.tenant_id).maybeSingle(),
  ]);

  const has = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  const s = (secrets ?? {}) as Record<string, string | null>;

  const snapshot: MoneyConfigSnapshot = {
    razorpayKeys:          has(s.razorpay_key_id) && has(s.razorpay_key_secret),
    razorpayWebhookSecret: has(s.razorpay_webhook_secret),
    razorpayLive:          typeof s.razorpay_key_id === "string" && s.razorpay_key_id.startsWith("rzp_live_"),
    emailConfigured:       isEmailConfigured(),
    upiVpa:                has((tenant as { upi_vpa?: string | null } | null)?.upi_vpa),
    cronSecret:            has(process.env.CRON_SECRET),
  };

  const findings = moneyHealth(snapshot);
  return NextResponse.json({ ok: true, findings, severity: worstSeverity(findings) });
}
