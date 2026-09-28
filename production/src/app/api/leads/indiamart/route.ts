/**
 * IndiaMART Lead Manager key (S34) — read status + save / clear the per-company CRM key.
 *
 *   GET    → { configured, key_mask, last_run_at, last_ok, last_error, last_imported }
 *   POST   → { crm_key }  (sealed before it is stored, like every integration credential)
 *   DELETE → clear the key — the pull cron then skips this company.
 *
 * Owner-only, same as /api/integrations/gemini. The raw key never goes back to the browser.
 * Key milti hai IndiaMART seller panel → Lead Manager → "CRM API / Import leads" se.
 *
 * `indiamart_crm_key` and `indiamart_sync_state` are newer than the generated Database type,
 * so they go through an untyped handle with the tenant filter written out.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { sealTenantSecrets } from "@/lib/crypto/tenant-secrets";
import { maskSecret } from "@/lib/crypto/vault";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* Schema-less client (see header) — same pattern as lib/contacts/primary.ts. */
type Untyped = Pick<SupabaseClient, "from">;

const saveSchema = z.object({
  crm_key: z.string().trim().min(16, "Ye IndiaMART CRM key jaisi nahi lagti — Lead Manager se poori key copy karo").max(200),
});

async function ownerTenant(): Promise<{ tenantId: string } | { error: string; status: number }> {
  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return { error: "Not authenticated", status: 401 };
  const { data: me } = await supabase.from("users").select("tenant_id, role").eq("id", auth.user.id).single();
  if (!me) return { error: "User not linked to a tenant", status: 403 };
  if (me.role !== "owner") return { error: "Sirf workspace owner IndiaMART key save kar sakta hai — owner se kahiye.", status: 403 };
  return { tenantId: me.tenant_id };
}

export async function GET() {
  const r = await ownerTenant();
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  const db = createAdminClient() as unknown as Untyped;
  const [sec, st] = await Promise.all([
    db.from("tenant_secrets").select("indiamart_crm_key").eq("tenant_id", r.tenantId).maybeSingle(),
    db.from("indiamart_sync_state").select("last_run_at, last_ok, last_error, last_imported").eq("tenant_id", r.tenantId).maybeSingle(),
  ]);
  if (sec.error) return NextResponse.json({ ok: false, error: sec.error.message }, { status: 500 });
  const key = (sec.data as { indiamart_crm_key?: string | null } | null)?.indiamart_crm_key ?? null;
  return NextResponse.json({
    ok: true,
    configured: Boolean(key),
    key_mask: maskSecret(key),
    ...((st.data as Record<string, unknown> | null) ?? {}),
  });
}

export async function POST(req: NextRequest) {
  const r = await ownerTenant();
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  let body: unknown;
  try { body = await req.json(); } catch { body = {}; }
  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues.map((i) => i.message).join(", ") }, { status: 400 });
  }
  const sealed = sealTenantSecrets({ tenant_id: r.tenantId, indiamart_crm_key: parsed.data.crm_key });
  const db = createAdminClient() as unknown as Untyped;
  const { error } = await db.from("tenant_secrets").upsert(sealed.row, { onConflict: "tenant_id" });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (sealed.storedInClear.length > 0) {
    console.warn("[leads/indiamart] key stored in PLAINTEXT — SECRETS_MASTER_KEY is not configured");
  }
  return NextResponse.json({ ok: true, encrypted: sealed.storedInClear.length === 0 });
}

export async function DELETE() {
  const r = await ownerTenant();
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  const db = createAdminClient() as unknown as Untyped;
  const { error } = await db.from("tenant_secrets").update({ indiamart_crm_key: null }).eq("tenant_id", r.tenantId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
