/**
 * Gemini (AI) integration — read + save the per-tenant API credentials so the
 * workspace owner can turn on real AI from Settings → Integrations instead of a
 * global Cloud Run env var.
 *
 *   GET    → configured? + model + masked key preview + updated_at
 *   POST   → upsert { api_key, model? }
 *   DELETE → clear the key
 *
 * The raw key NEVER leaves the server after save — only a masked preview.
 * Owner-only, mirroring the Razorpay/WhatsApp integration routes.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { sealTenantSecrets } from "@/lib/crypto/tenant-secrets";
import { maskSecret } from "@/lib/crypto/vault";

export const dynamic = "force-dynamic";
export const runtime  = "nodejs";

const DEFAULT_MODEL = "gemini-2.5-flash";

const saveSchema = z
  .object({
    api_key: z.string().trim().min(20, "That doesn't look like a valid Gemini API key").max(200).optional(),
    model:   z.string().trim().max(60).optional(),
  })
  .refine((d) => d.api_key || d.model, { message: "Nothing to save" });

async function resolveTenantAndOwnership() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return { error: "Not authenticated" as const };
  const { data: me, error } = await supabase
    .from("users")
    .select("tenant_id, role")
    .eq("id", authData.user.id)
    .single();
  if (error || !me) return { error: "User not linked to a tenant" as const };
  if (me.role !== "owner") return { error: "Only the workspace owner can manage integration credentials" as const };
  return { tenantId: me.tenant_id };
}

export async function GET() {
  const r = await resolveTenantAndOwnership();
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: 403 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("tenant_secrets")
    .select("gemini_api_key, gemini_model, updated_at")
    .eq("tenant_id", r.tenantId)
    .maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // A global env key (Cloud Run) means AI works even without a tenant key.
  const envFallback = Boolean(process.env.GEMINI_API_KEY?.trim() && process.env.GEMINI_API_KEY!.trim().length >= 10);

  return NextResponse.json({
    ok:           true,
    configured:   Boolean(data?.gemini_api_key),
    env_fallback: envFallback,
    key_mask:     maskSecret(data?.gemini_api_key),
    model:        data?.gemini_model ?? DEFAULT_MODEL,
    updated_at:   data?.updated_at ?? null,
  });
}

export async function POST(req: NextRequest) {
  const r = await resolveTenantAndOwnership();
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: 403 });

  let body: unknown;
  try { body = await req.json(); } catch { body = {}; }
  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 },
    );
  }

  // Patch only the provided fields — so changing the model alone preserves the
  // existing key (the UI never has the saved key to re-send).
  const patch: { tenant_id: string; gemini_api_key?: string; gemini_model?: string } = { tenant_id: r.tenantId };
  if (parsed.data.api_key) patch.gemini_api_key = parsed.data.api_key;
  if (parsed.data.model)   patch.gemini_model   = parsed.data.model.trim();

  // Seal the API key before it is stored. gemini_model is configuration, not a
  // credential, and is left readable.
  const sealed = sealTenantSecrets(patch);

  const admin = createAdminClient();
  const { error } = await admin
    .from("tenant_secrets")
    .upsert(sealed.row, { onConflict: "tenant_id" });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (sealed.storedInClear.length > 0) {
    // Never silent: an operator must not believe a key is encrypted when it is not.
    console.warn(
      `[integrations/gemini] stored in PLAINTEXT (${sealed.storedInClear.join(", ")}) — SECRETS_MASTER_KEY is not configured`,
    );
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const r = await resolveTenantAndOwnership();
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: 403 });

  const admin = createAdminClient();
  const { error } = await admin
    .from("tenant_secrets")
    .update({ gemini_api_key: null, gemini_model: null })
    .eq("tenant_id", r.tenantId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
