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
 * S21: `indiamart_crm_key` / `indiamart_sync_state` ab generated types me hain — typed
 * admin client, tenant filter phir bhi har query par likha hai (admin RLS bypass karta hai).
 */
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { sealTenantSecrets } from "@/lib/crypto/tenant-secrets";
import { maskSecret } from "@/lib/crypto/vault";
import { withRoute, dbFail } from "@/lib/api/with-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "api/leads/indiamart";
const OWNER_ONLY = { roles: ["owner"] as const, roleHint: "Sirf workspace owner IndiaMART key save kar sakta hai — owner se kahiye." };

const saveSchema = z.object({
  crm_key: z.string().trim().min(16, "Ye IndiaMART CRM key jaisi nahi lagti — Lead Manager se poori key copy karo").max(200),
});

export const GET = withRoute({ route: ROUTE, ...OWNER_ONLY }, async ({ tenantId }) => {
  const db = createAdminClient();
  const [sec, st] = await Promise.all([
    db.from("tenant_secrets").select("indiamart_crm_key").eq("tenant_id", tenantId).maybeSingle(),
    db.from("indiamart_sync_state").select("last_run_at, last_ok, last_error, last_imported").eq("tenant_id", tenantId).maybeSingle(),
  ]);
  dbFail(sec.error, "IndiaMART setting padhi nahi gayi — page refresh karke dobara try kariye.");
  const key = sec.data?.indiamart_crm_key ?? null;
  return { configured: Boolean(key), key_mask: maskSecret(key), ...(st.data ?? {}) };
});

export const POST = withRoute({ route: ROUTE, input: saveSchema, ...OWNER_ONLY }, async ({ input, tenantId }) => {
  const sealed = sealTenantSecrets({ tenant_id: tenantId, indiamart_crm_key: input.crm_key });
  const { error } = await createAdminClient().from("tenant_secrets").upsert(sealed.row, { onConflict: "tenant_id" });
  dbFail(error, "IndiaMART key save nahi hui — dobara try kariye.");
  if (sealed.storedInClear.length > 0) {
    console.warn(`[${ROUTE}] key stored in PLAINTEXT — SECRETS_MASTER_KEY is not configured`);
  }
  return { encrypted: sealed.storedInClear.length === 0 };
});

export const DELETE = withRoute({ route: ROUTE, ...OWNER_ONLY }, async ({ tenantId }) => {
  const { error } = await createAdminClient().from("tenant_secrets").update({ indiamart_crm_key: null }).eq("tenant_id", tenantId);
  dbFail(error, "IndiaMART key hati nahi — dobara try kariye.");
  return {};
});
