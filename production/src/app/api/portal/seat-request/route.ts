/**
 * POST /api/portal/seat-request
 *
 * A customer asking for a seat change from /portal/subscription.
 *
 * ─── IT WRITES THROUGH THE SERVER, NOT FROM THE BROWSER ─────────────────────
 * The portal session is keyed on customer_id and has no `users` row (lib/auth/roles.ts,
 * EXTERNAL_ACTORS), so `seat_requests` has no anon insert policy — a table anyone can
 * insert into is a table anyone can fill with requests against someone else's
 * customer. The tenant_id, customer_id and current seat count all come from the
 * SUBSCRIPTION row read here, never from the request body.
 *
 * ─── THE BODY CARRIES A SEAT COUNT AND NOTHING ELSE ─────────────────────────
 * No price, no tenant, no customer. A seat change is priced pro-rata at approval
 * time — see lib/subscriptions/seat-request.ts.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { requirePortalSession } from "@/lib/portal/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  subscription_id: z.string().uuid(),
  requested_seats: z.coerce.number().int().min(0).max(5000),
  effective_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().trim().max(1000).optional(),
});

export async function POST(req: Request) {
  const session = await requirePortalSession();

  let raw: unknown;
  try { raw = await req.json(); } catch { raw = {}; }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Check the seat count and try again." }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: sub } = await supabase
    .from("subscriptions")
    .select("id, tenant_id, customer_id, customer_name, seats, status")
    .eq("id", parsed.data.subscription_id)
    .maybeSingle();

  /* The subscription must belong to THIS portal session's customer. Without this
     check the endpoint would accept any subscription id. */
  if (!sub || !sub.customer_id || sub.customer_id !== session.customerId) {
    return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
  }
  if (sub.status !== "active") {
    return NextResponse.json(
      { error: `This subscription is ${sub.status}, so seats cannot be changed on it. Please contact us.` },
      { status: 400 },
    );
  }
  if (parsed.data.requested_seats === sub.seats) {
    return NextResponse.json({ error: `You already have ${sub.seats} seats.` }, { status: 400 });
  }

  /* One open request at a time. Two pending rows for the same subscription would let
     a rep approve both and take the seats somewhere neither asked for. */
  const { data: existing } = await supabase
    .from("seat_requests")
    .select("id")
    .eq("subscription_id", sub.id)
    .eq("status", "pending")
    .maybeSingle();
  if (existing) {
    return NextResponse.json(
      { error: "You already have a seat change waiting to be reviewed. We will come back to you on that one." },
      { status: 409 },
    );
  }

  const { data: created, error } = await supabase
    .from("seat_requests")
    .insert({
      tenant_id: sub.tenant_id,
      subscription_id: sub.id,
      customer_id: sub.customer_id,
      customer_name: sub.customer_name,
      /* From the SUBSCRIPTION, not the body — this is what makes a stale request
         detectable at approval time. */
      current_seats: sub.seats,
      requested_seats: parsed.data.requested_seats,
      effective_on: parsed.data.effective_on ?? null,
      note: parsed.data.note ?? null,
      requested_by_email: session.userEmail ?? null,
      status: "pending",
    })
    .select("id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, id: created.id });
}
