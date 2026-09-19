import "server-only";
import type { createAdminClient } from "@/lib/supabase/server";
import { platformAdminEmails, isPlatformAdmin } from "@/lib/platform";

/* Typed as the RETURN of createAdminClient, like the AI dispatchers next door —
   hand-rolling the shape is what produced the drift those files warn about. */
type Admin = ReturnType<typeof createAdminClient>;

/**
 * Who ops mail goes to.
 *
 * ─── THE BUG THIS REPLACES ──────────────────────────────────────────────────
 * Two crons — health-digest and ai-reflection — picked their recipient like
 * this, and both carried a comment saying it was "the platform owner":
 *
 *     .from("users").select("email").eq("role", "owner")
 *     .order("created_at", { ascending: true }).limit(1)
 *
 * There is no tenant filter in that query. It is the oldest `owner` row in the
 * WHOLE table, and every self-signup inserts its first user with role "owner"
 * (api/auth/signup/route.ts). So the query means "whoever registered first",
 * which is only the platform by luck of ordering, and the scripts that delete
 * tenants are one run away from changing the answer.
 *
 * What rides on it got worse on 16 Sep 2026: with ResellerClub credentials
 * installed, the health digest now carries the reseller WALLET BALANCE
 * (lib/ops/health-digest.ts), and it already carried production log lines from
 * every tenant. ai-reflection carries cross-tenant AI reports. None of that may
 * land in a customer's inbox because a row was deleted somewhere.
 *
 * ─── THE RULE ───────────────────────────────────────────────────────────────
 * The platform is already defined in one place — `platformAdminEmails()`, the
 * founder allowlist that grants cross-tenant sight and is overridable in prod
 * with PLATFORM_ADMIN_EMAILS. Ops mail goes to a person on that list, and the
 * database chooses WHICH one rather than whether.
 *
 * Matching is done in JS through `isPlatformAdmin`, not with a Postgres `.in()`,
 * because the allowlist is lowercased and stored addresses need not be — an
 * `.in()` would silently miss on case and quietly fall through to the fallback.
 *
 * The fallback is the allowlist's own first entry: if no owner row matches, mail
 * the platform anyway. A digest that reaches nobody is a digest nobody reads,
 * and the alternative — reverting to "oldest owner" — is the defect.
 */
export async function platformOpsRecipient(admin: Admin): Promise<string | null> {
  const allowed = platformAdminEmails();
  if (allowed.length === 0) return null;

  /* Bounded: the platform's own accounts are among the earliest rows, and this
     is a lookup, not a scan. */
  const { data } = await admin
    .from("users")
    .select("email")
    .eq("role", "owner")
    .order("created_at", { ascending: true })
    .limit(50);

  const rows = (data ?? []) as { email?: string | null }[];
  const match = rows.map((r) => r.email ?? "").find((email) => isPlatformAdmin(email));

  return match || allowed[0];
}
