import "server-only";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { authorizeDomainWrite } from "@/lib/domains/authz";
import { RESOLUTIONS } from "@/lib/domains/retry";

/**
 * Closing a paid-but-undelivered asset — domain or hosting, one implementation.
 *
 * ─── WHY THIS IS SHARED AND NOT COPIED ───────────────────────────────────────
 * The two routes differ in one word: which table. Everything that matters — the
 * staff check, the "already resolved" refusal, the atomic claim, the audit line —
 * is identical, and a second copy is how the two come to disagree about who may
 * resolve what. Same reasoning as `resellerclub/call.ts` and
 * `directadmin/user-auth.ts`: one file per set of rules, or the next caller
 * re-learns them wrongly.
 *
 * ─── IT RECORDS A DECISION, IT DOES NOT MAKE ONE ────────────────────────────
 * Nothing here refunds money, cancels an order, registers a domain or creates a
 * hosting account. A refund goes through the payment path with its own guards; a
 * re-provision goes through the cron. This writes down WHO decided WHAT and takes
 * the row out of the operator queue.
 *
 * An endpoint that both moved money and closed the ticket would make "mark it
 * sorted" and "give the customer ₹1,200 back" the same click, and only one of
 * those is undoable.
 */

export const resolveBodySchema = z.object({
  resolution: z.enum(RESOLUTIONS),
  /* Required, and not merely present — mirrors the CHECK constraint. A resolution
     with no explanation is the thing these columns exist to prevent. */
  note: z.string().trim().min(3).max(2000),
});

/** Which asset is being resolved. The only thing the two routes disagree about. */
export type ResolvableAsset = "domain" | "hosting";

const TABLE: Record<ResolvableAsset, "domains" | "hosting_accounts"> = {
  domain: "domains",
  hosting: "hosting_accounts",
};

const NOUN: Record<ResolvableAsset, string> = {
  domain: "domain",
  hosting: "hosting account",
};

const AUDIT_ACTION: Record<ResolvableAsset, string> = {
  domain: "domain.paid_not_delivered_resolved",
  hosting: "hosting.paid_not_delivered_resolved",
};

export type ResolveOutcome =
  | { ok: true; resolution: string; audited: boolean }
  | { ok: false; status: 400 | 401 | 403 | 404 | 409 | 500; error: string };

export async function resolvePaidNotDelivered(
  asset: ResolvableAsset,
  id: string,
  rawBody: unknown,
): Promise<ResolveOutcome> {
  const supabase = createClient();

  /* The session is established HERE, in the request path, before the admin
     client appears below — `lib/inbound/api-auth.wiring.test.ts` requires a
     visible `auth.getUser()` of anything that bypasses RLS, and its own comment
     explains why it was not loosened to recognise helpers. */
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 401, error: "Not signed in." };

  const table = TABLE[asset];
  const { data: row } = await supabase
    .from(table)
    .select("id, tenant_id, domain_name, status, amount_paid, resolved_at, attempt_count")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();

  if (!row) return { ok: false, status: 404, error: `No such ${NOUN[asset]}.` };

  /* "registration" rather than the default "dns": somebody refused here has not
     touched a DNS record, and telling them about one is a sentence about
     something they did not do. */
  const authz = await authorizeDomainWrite(supabase, row.tenant_id, "registration");
  if (!authz.ok) return { ok: false, status: authz.status, error: authz.error };

  const parsed = resolveBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      error: "Choose what was done and write a short note saying why — it is the only record of this decision.",
    };
  }

  if (row.status !== "failed") {
    /* Only a failed attempt is in this queue. Resolving anything else would stamp
       a decision on a live asset and take it out of a list it was never in. */
    return {
      ok: false,
      status: 409,
      error: `${row.domain_name} is ${row.status}, not a failed one, so there is nothing to resolve.`,
    };
  }
  if (row.resolved_at) {
    return {
      ok: false,
      status: 409,
      error: "Somebody has already resolved this one. Reopening is deliberately not a button — say so in the customer's timeline instead.",
    };
  }

  const admin = createAdminClient();
  const { data: updated, error } = await admin
    .from(table)
    .update({
      resolved_at: new Date().toISOString(),
      resolved_by: authz.userId,
      resolution: parsed.data.resolution,
      resolution_note: parsed.data.note,
    })
    .eq("id", row.id)
    /* The guard against two operators resolving the same row at once. Whoever
       loses is told, rather than silently overwriting the other's reasoning. */
    .is("resolved_at", null)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error(`[${asset}/resolve] update failed:`, error.message);
    return { ok: false, status: 500, error: "Could not record that just now. Please try again." };
  }
  if (!updated) {
    return { ok: false, status: 409, error: "Somebody resolved this a moment before you did." };
  }

  /* Durable audit on top of the columns, because the money question gets asked
     months later and the asset row carries only its latest state. The amount is
     in the label on purpose: "written off" means nothing without the figure. */
  const { error: auditErr } = await admin.from("activity_log").insert({
    tenant_id: row.tenant_id,
    user_id: authz.userId,
    action: AUDIT_ACTION[asset],
    entity: asset === "domain" ? "domain" : "hosting_account",
    entity_id: row.id,
    label:
      `${row.domain_name} — paid ₹${row.amount_paid ?? 0}, ${row.attempt_count ?? 0} failed attempt(s), ` +
      `resolved as ${parsed.data.resolution}: ${parsed.data.note}`,
  });
  if (auditErr) {
    /* The resolution is on the row either way. Reported rather than hidden, so a
       gap in the log is visible instead of assumed absent. */
    console.error(`[${asset}/resolve] audit row failed:`, auditErr.message);
  }

  return { ok: true, resolution: parsed.data.resolution, audited: !auditErr };
}
