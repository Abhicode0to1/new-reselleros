/**
 * Which company is this browser writing for? Answer it, or refuse.
 *
 * ─── WHY THIS EXISTS (R-001, raised by Pardeep 2026-09-25) ──────────────────
 * `useCreateCustomer` and `useCreateLead` both opened with:
 *
 *     let tenantId = "11111111-1111-1111-1111-111111111111";   // demo tenant
 *
 * and only replaced it if the auth lookup AND the `users` read both succeeded. So every
 * way of failing to identify the operator — signed out, session expired mid-form, an
 * auth row with no `users` row, a network blip on that one query — resolved to the
 * SEED tenant and inserted a real customer into it.
 *
 * Nothing about that looks wrong on screen. The customer saves, the toast says "Customer
 * added", and the row is simply in another company. It then fails RLS for everybody who
 * should see it, so the operator's next move is to create it again.
 *
 * Accounting cares because Banking → Reconcile now opens this same form and invoices the
 * customer it returns against a real bank receipt (R-001's own words). A customer in the
 * wrong tenant is a receipt that can never be matched.
 *
 * AGENTS.md §4 has said "never hardcode a tenant_id" since before this was written. The
 * fallback survived because a default is easier to read than a refusal.
 *
 * ─── WHY IT THROWS RATHER THAN RETURNING NULL ───────────────────────────────
 * A null tenant is the same trap one level down: every caller must remember to check it,
 * and the one that forgets inserts with `undefined` and lets the database decide. There
 * is no useful "no tenant" behaviour for a write, so this refuses on the spot and the
 * caller's existing error handling shows the reason.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/* Minimal shape, so this works with the browser client, the server client and the admin
   client without importing any of them. Same trick as contacts/attach.ts. */
type Db = Pick<SupabaseClient, "from" | "auth">;

/** Thrown when the writer cannot be placed in a company. */
export class NoTenantError extends Error {
  readonly reason: "signed_out" | "no_company";
  constructor(reason: "signed_out" | "no_company", message: string) {
    super(message);
    this.name = "NoTenantError";
    this.reason = reason;
  }
}

/* §24: what happened, why, and what to do next — these are shown to the operator
   verbatim, standing where a silently-wrong company used to be. */
const SIGNED_OUT =
  "You are not signed in, so this could not be saved to your company. Your session may have expired — open the app in a new tab, sign in again, and re-enter this form.";
const NO_COMPANY =
  "Your account is not linked to a company yet, so there is nowhere to save this. Ask the workspace owner to add you to the team, then try again.";

/**
 * The tenant this browser writes for.
 *
 * @throws NoTenantError when nobody is signed in, or the signed-in user has no
 *         `public.users` row. Never guesses, never returns a default.
 */
export async function requireTenantId(supabase: Db): Promise<string> {
  const { data: authData } = await supabase.auth.getUser();
  const authUserId = authData?.user?.id;
  if (!authUserId) throw new NoTenantError("signed_out", SIGNED_OUT);

  const { data, error } = await supabase
    .from("users")
    .select("tenant_id")
    .eq("id", authUserId)
    .single();

  /* A read that errored and a read that found nothing are the same answer here: we
     cannot say which company this is. Reporting the database's own words would leak
     schema into a toast, and the operator's next step is identical either way. */
  const tenantId = (data as { tenant_id?: string | null } | null)?.tenant_id;
  if (error || !tenantId) throw new NoTenantError("no_company", NO_COMPANY);

  return tenantId;
}
