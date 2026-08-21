/**
 * POST /api/push/unsubscribe — forget this device.
 *
 * Deletes by endpoint AND user_id together. The endpoint alone would let anyone signed in
 * delete somebody else's device if they ever learned the string — a small thing that turns
 * "turn off my notifications" into "turn off theirs".
 *
 * Deleting rather than flagging: a person who turned notifications off should not remain
 * in a table of people to notify, one bug away from being notified.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";

const bodySchema = z.object({ endpoint: z.string().url().max(2000) });

export async function POST(request: Request) {
  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "No endpoint given" }, { status: 400 });

  const admin = createAdminClient();
  const { error } = await admin
    .from("push_subscriptions")
    .delete()
    .eq("endpoint", parsed.data.endpoint)
    .eq("user_id", auth.user.id);

  if (error) {
    console.error("[push] unsubscribe failed:", error.message);
    return NextResponse.json({ error: "Could not remove this device." }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
