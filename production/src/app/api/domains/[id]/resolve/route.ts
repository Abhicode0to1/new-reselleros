/**
 * POST /api/domains/:id/resolve — closing a paid-but-undelivered registration.
 *
 * ─── WHAT THIS IS ABOUT ──────────────────────────────────────────────────────
 * A `domains` row with `status='failed'` and an `amount_paid` is a customer who
 * HAS PAID AND HAS NO DOMAIN — almost always because the ResellerClub wallet was
 * empty when the order went up. Migration 20260910100000 gave those rows a
 * bounded retry budget and a resolution trail; `lib/domains/retry.ts` spends the
 * budget and then stops, deliberately, so a person decides. This route is where
 * that decision is recorded.
 *
 * ─── IT RECORDS A DECISION, IT DOES NOT MAKE ONE ────────────────────────────
 * Nothing here refunds money, cancels an order or talks to a registrar. A refund
 * goes through the payment path with its own guards (`refund_payment`); a
 * re-registration goes through the provisioning cron. This writes down WHO
 * decided WHAT, and takes the row out of the operator queue.
 *
 * That split is deliberate. An endpoint that both moved money and closed the
 * ticket would make "mark it sorted" and "give the customer ₹1,200 back" the
 * same click, and the second is not undoable.
 *
 * ─── STAFF ONLY, CHECKED EXPLICITLY ──────────────────────────────────────────
 * Via `authorizeDomainWrite`, for the reason that file gives: RLS guards the
 * table, and a resolution names a person, so the identity has to be established
 * here rather than inferred afterwards. `resolved_by` is taken from the SESSION,
 * never from the body — a body that could name its own author is a signature
 * anyone can forge.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { authorizeDomainWrite } from "@/lib/domains/authz";
import { RESOLUTIONS } from "@/lib/domains/retry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  resolution: z.enum(RESOLUTIONS),
  /* Required, and not merely present — see the CHECK constraint. A resolution
     with no explanation is the thing the column exists to prevent. */
  note: z.string().trim().min(3).max(2000),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();

  /* ─── THE SESSION IS ESTABLISHED HERE, IN THE ROUTE, ON PURPOSE ────────────
     `authorizeDomainWrite` below calls this too, so this line is redundant to a
     reader who follows the helper — and it is required by
     `lib/inbound/api-auth.wiring.test.ts`, which scans routes that use
     `createAdminClient()` for a visible `auth.getUser()`.

     The guard is right and the redundancy is the price. Its own comment explains
     why it was not loosened to recognise helpers: "a loose regex would silently
     exempt somebody else next time — and that next one might be a real hole."
     A route that bypasses RLS should say who it thinks you are without the
     reader having to open another file. The sso route does the same. */
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { data: domain } = await supabase
    .from("domains")
    .select("id, tenant_id, domain_name, status, amount_paid, resolved_at, attempt_count")
    .eq("id", params.id)
    .is("deleted_at", null)
    .maybeSingle();

  if (!domain) return NextResponse.json({ error: "No such domain." }, { status: 404 });

  /* "registration", not the default "dns" — a customer refused here has not
     touched a DNS record, and telling them about one is a sentence about
     something they did not do. */
  const authz = await authorizeDomainWrite(supabase, domain.tenant_id, "registration");
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status });

  let raw: unknown;
  try { raw = await req.json(); } catch { raw = {}; }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Choose what was done and write a short note saying why — it is the only record of this decision." },
      { status: 400 },
    );
  }

  if (domain.status !== "failed") {
    /* Only a failed registration is in this queue. Resolving anything else would
       stamp a decision on a live domain and take it out of a list it was never in. */
    return NextResponse.json(
      { error: `${domain.domain_name} is ${domain.status}, not a failed registration, so there is nothing to resolve.` },
      { status: 409 },
    );
  }
  if (domain.resolved_at) {
    /* Already dealt with. Refused rather than overwritten: the first decision is
       the one that happened, and a second row of reasoning replacing it would
       lose the only account of what was actually done. */
    return NextResponse.json(
      { error: "Somebody has already resolved this one. Reopening is deliberately not a button — say so in the customer's timeline instead." },
      { status: 409 },
    );
  }

  const admin = createAdminClient();
  const { data: updated, error } = await admin
    .from("domains")
    .update({
      resolved_at: new Date().toISOString(),
      resolved_by: authz.userId,
      resolution: parsed.data.resolution,
      resolution_note: parsed.data.note,
    })
    .eq("id", domain.id)
    /* The guard against two operators resolving the same row at once. Whoever
       loses is told, rather than silently overwriting the other's reasoning. */
    .is("resolved_at", null)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[domains/resolve] update failed:", error.message);
    return NextResponse.json({ error: "Could not record that just now. Please try again." }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json({ error: "Somebody resolved this a moment before you did." }, { status: 409 });
  }

  /* Durable audit on top of the columns, because the money question gets asked
     months later and `domains` carries only the latest state. The amount is in
     the label on purpose: "written off" means nothing without the figure. */
  const { error: auditErr } = await admin.from("activity_log").insert({
    tenant_id: domain.tenant_id,
    user_id: authz.userId,
    action: "domain.paid_not_delivered_resolved",
    entity: "domain",
    entity_id: domain.id,
    label:
      `${domain.domain_name} — paid ₹${domain.amount_paid ?? 0}, ${domain.attempt_count ?? 0} failed attempt(s), ` +
      `resolved as ${parsed.data.resolution}: ${parsed.data.note}`,
  });
  if (auditErr) {
    /* The resolution is recorded on the row either way. Reported rather than
       hidden, so a gap in the log is visible instead of assumed absent. */
    console.error("[domains/resolve] audit row failed:", auditErr.message);
  }

  return NextResponse.json({ ok: true, resolution: parsed.data.resolution, audited: !auditErr });
}
