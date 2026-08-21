/**
 * POST /api/push/subscribe — remember this device, and what it agreed to receive.
 *
 * ─── THE BODY SUPPLIES THE DEVICE, NEVER THE PERSON ─────────────────────────
 * `tenant_id` and `user_id` come from the SESSION, never from the request. The same rule
 * the reply route follows for its `to` address, for the same reason: a body-supplied
 * user_id turns this endpoint into "subscribe my device on someone else's behalf", and
 * then push their phone.
 *
 * ─── UPSERT ON ENDPOINT ─────────────────────────────────────────────────────
 * The endpoint IS the device. Re-subscribing (new login, permission re-granted, site data
 * cleared) hands back the same endpoint, so this must update the existing row. Inserting
 * instead would give one phone several rows and every notification would arrive two or
 * three times — which reads as a sending bug and gets notifications turned off.
 *
 * ─── CATEGORIES ARE TAKEN AS GIVEN, MINUS ANYTHING UNKNOWN ──────────────────
 * The client sends what the person ticked. Unknown values are dropped rather than
 * rejected, so a newer client cannot 400 an older server; `operational` is added back if
 * the list ends up empty, because an empty subscription is a row that looks enabled and
 * receives nothing.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";

const bodySchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(500),
    auth:   z.string().min(1).max(500),
  }),
  categories: z.array(z.string().max(40)).max(10).optional(),
  userAgent: z.string().max(400).optional(),
});

const KNOWN_CATEGORIES = ["operational", "offers"] as const;

export async function POST(request: Request) {
  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "That does not look like a push subscription." }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: me, error: meErr } = await admin
    .from("users")
    .select("tenant_id")
    .eq("id", auth.user.id)
    .single();
  if (meErr || !me) return NextResponse.json({ error: "User is not linked to a tenant" }, { status: 403 });

  const requested = parsed.data.categories ?? ["operational"];
  const categories = requested.filter((c): c is (typeof KNOWN_CATEGORIES)[number] =>
    (KNOWN_CATEGORIES as readonly string[]).includes(c),
  );
  if (categories.length === 0) categories.push("operational");

  const { error } = await admin
    .from("push_subscriptions")
    .upsert(
      {
        tenant_id:  me.tenant_id,
        user_id:    auth.user.id,
        endpoint:   parsed.data.endpoint,
        p256dh:     parsed.data.keys.p256dh,
        auth:       parsed.data.keys.auth,
        user_agent: parsed.data.userAgent ?? null,
        categories,
        /* A device saying hello again is not a failed device. */
        failed_at: null,
        failure_reason: null,
      },
      { onConflict: "endpoint" },
    );

  if (error) {
    console.error("[push] subscribe failed:", error.message);
    return NextResponse.json({ error: "Could not save this device." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, categories });
}
