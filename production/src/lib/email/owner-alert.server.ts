/**
 * The database half of the owner-alert lookup. Server-only.
 *
 * Split from `owner-alert.ts` for two reasons, both learned here:
 *
 *   1. The same split as `resolveEmailProvider` / `routeForTenant` in `send.ts` —
 *      the DECISION is unit-tested, the QUERY is not, and a module that mixes them
 *      lets neither be tested properly.
 *
 *   2. `owner-alert.ts` must stay import-clean. The first cut of this function
 *      lived there and typed its `admin` parameter with a hand-rolled structural
 *      shape to avoid importing the server client. That produced
 *      `TS2589: Type instantiation is excessively deep` at one call site: matching
 *      Supabase's generics against a look-alike interface is not free. Naming the
 *      real type is both simpler and correct — and it belongs in a file that is
 *      already server-only, so the pure rules stay safe to import from a client
 *      component (the `/vault/personal` 500, AGENTS.md, and the same reason
 *      `password-rules.ts` avoids `node:crypto`).
 */
import type { createAdminClient } from "@/lib/supabase/server";
import { resolveOwnerAlert, type TenantContact, type OwnerAlertResult } from "./owner-alert";

/** The tenant fields the alert bodies use, beyond what addressing needs. */
export interface OwnerAlertTenant extends TenantContact {
  phone?: string | null;
}

/**
 * Read one tenant and resolve its alert recipient.
 *
 * A failed READ resolves to `ok: false` with the error named, never to a guessed
 * address: a settings hiccup must not turn into mail addressed to somebody else.
 * The tenant row comes back too (when there was one) so callers can sign the body
 * without a second query.
 */
export async function loadOwnerAlert(
  admin: ReturnType<typeof createAdminClient>,
  tenantId: string,
): Promise<{ alert: OwnerAlertResult; tenant: OwnerAlertTenant | null }> {
  try {
    const { data, error } = await admin
      .from("tenants")
      .select("id, name, email, phone, contact_name")
      .eq("id", tenantId)
      .maybeSingle();
    if (error) {
      return {
        alert: { ok: false, reason: `could not read tenant ${tenantId} (${error.message}) — owner alert not sent.` },
        tenant: null,
      };
    }
    const tenant = (data as OwnerAlertTenant | null) ?? null;
    return { alert: resolveOwnerAlert(tenant, tenantId), tenant };
  } catch (e) {
    return {
      alert: { ok: false, reason: `could not read tenant ${tenantId} (${(e as Error).message}) — owner alert not sent.` },
      tenant: null,
    };
  }
}
