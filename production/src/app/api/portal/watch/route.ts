/**
 * POST|DELETE /api/portal/watch — a customer asking to be told when a name frees up.
 *
 * ─── WHY THIS ROUTE EXISTS AT ALL ────────────────────────────────────────────
 * `domain_watches`, its RLS policies, the decision logic in lib/domains/watch.ts
 * and the daily sweep in api/cron/domain-watch were all built on 10 Sep 2026 —
 * and no customer could create a watch, because nothing exposed one. A finished
 * feature nobody can reach is indistinguishable from a feature that was never
 * built, except that it also carries maintenance. This is the missing half.
 *
 * ─── IT WRITES THROUGH THE SERVER, LIKE THE REST OF THE PORTAL ──────────────
 * The table DOES carry customer-writable RLS policies (a watch spends nothing and
 * provisions nothing, so it is the one safe exception in the domain area). This
 * route still goes through the server for the reason seat-request does: the
 * portal session is keyed on customer_id, and `tenant_id` must come from the
 * SESSION rather than the request body. A body that could name its own tenant is
 * a body that can file a watch against somebody else's account.
 *
 * ─── THE CAP IS ENFORCED HERE, NOT IN THE DATABASE ──────────────────────────
 * `MAX_WATCHES_PER_CUSTOMER` is a product decision about how much daily registrar
 * traffic one customer may queue, not an integrity rule — so it lives with the
 * rest of the policy in lib/domains/watch.ts and is checked before the insert.
 * The UNIQUE index on (customer_id, domain_name) is the integrity half, and it
 * catches the double-click this check cannot.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { requirePortalSession } from "@/lib/portal/session";
import { watchableDomain, canAddWatch, MAX_WATCHES_PER_CUSTOMER } from "@/lib/domains/watch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const addSchema = z.object({ domain: z.string().trim().min(1).max(300) });
const removeSchema = z.object({ id: z.string().uuid() });

export async function POST(req: Request) {
  const session = await requirePortalSession();

  let raw: unknown;
  try { raw = await req.json(); } catch { raw = {}; }
  const parsed = addSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a domain name to watch." }, { status: 400 });
  }

  /* Shape and normalisation in one place, shared with the sweep — so a name that
     is accepted here is a name the sweep can actually check. The refusal text is
     written for the customer and comes back verbatim (§24). */
  const check = watchableDomain(parsed.data.domain);
  if (!check.ok) {
    return NextResponse.json({ error: check.reason }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { count, error: countErr } = await supabase
    .from("domain_watches")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", session.customerId)
    .is("notified_at", null);

  if (countErr) {
    console.error("[portal/watch] could not count watches:", countErr.message);
    return NextResponse.json({ error: "Could not add that watch right now. Please try again." }, { status: 500 });
  }

  /* Counted against OPEN watches only. A notified one has done its job and is
     retired — holding a slot for it would mean a customer who has been told about
     twenty names can never watch another. */
  const room = canAddWatch(count ?? 0);
  if (!room.ok) {
    return NextResponse.json({ error: room.reason }, { status: 409 });
  }

  const { data, error } = await supabase
    .from("domain_watches")
    .insert({
      tenant_id: session.tenantId,
      customer_id: session.customerId,
      domain_name: check.domain,
    })
    .select("id, domain_name")
    .maybeSingle();

  if (error) {
    /* 23505 is the UNIQUE on (customer_id, domain_name) — they already watch it.
       Reported as success, because the customer's intent is satisfied: they will
       be told when it frees up. Saying "duplicate" would be technically accurate
       and useless to them. */
    if (error.code === "23505") {
      return NextResponse.json({ ok: true, already: true, domain: check.domain });
    }
    console.error("[portal/watch] insert failed:", error.message);
    return NextResponse.json({ error: "Could not add that watch right now. Please try again." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id: data?.id, domain: check.domain, limit: MAX_WATCHES_PER_CUSTOMER });
}

export async function DELETE(req: Request) {
  const session = await requirePortalSession();

  let raw: unknown;
  try { raw = await req.json(); } catch { raw = {}; }
  const parsed = removeSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Nothing to remove." }, { status: 400 });
  }

  const supabase = createAdminClient();

  /* `.eq("customer_id", …)` is the authorisation, not a filter: without it this
     endpoint would delete any watch by id. The same reasoning as the subscription
     ownership check in seat-request. */
  const { data, error } = await supabase
    .from("domain_watches")
    .delete()
    .eq("id", parsed.data.id)
    .eq("customer_id", session.customerId)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[portal/watch] delete failed:", error.message);
    return NextResponse.json({ error: "Could not remove that watch right now." }, { status: 500 });
  }
  if (!data) {
    /* Either it never existed or it is not theirs — the same answer either way,
       so the response cannot be used to discover another customer's watches. */
    return NextResponse.json({ error: "That watch is no longer on your account." }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
