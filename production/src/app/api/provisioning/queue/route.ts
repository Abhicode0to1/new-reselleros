/**
 * The activation queue, for the operator's screen.
 *
 * `provisioning_requests` holds seats a customer has PAID for and nobody has
 * turned on yet. Nothing drains it automatically — there is no Google reseller
 * API adapter, and a test-mode payment must never auto-activate — so until now
 * the queue existed and no screen opened it. A queue nobody can see is a
 * customer waiting with no one aware of it.
 *
 * The tenant comes from the SESSION, never from a query parameter. That table
 * is not in the generated Database type (see provisioning.server.ts for the
 * measured reason), so nothing type-checks the tenant filter — the explicit
 * `.eq("tenant_id", …)` inside `listProvisioningQueue` is the whole boundary,
 * and it is fed from here.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listProvisioningQueue } from "@/lib/provisioning/provisioning.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data } = await supabase
    .from("users")
    .select("tenant_id")
    .eq("id", auth.user.id)
    .single();
  const tenantId = (data as { tenant_id?: string | null } | null)?.tenant_id;
  if (!tenantId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const rows = await listProvisioningQueue(tenantId);

  /**
   * Counts are computed here rather than in the browser so the screen and any
   * future alert agree on what "waiting" means. `queued` is the only status
   * that represents a customer still waiting; activated / failed / cancelled
   * are all finished, in different ways.
   */
  const waiting = rows.filter((r) => r.status === "queued");
  return NextResponse.json({
    rows,
    counts: {
      total: rows.length,
      waiting: waiting.length,
      /** Waiting AND blocked — the ones that need a decision, not just time. */
      blocked: waiting.filter((r) => r.blocker !== null).length,
      testMode: waiting.filter((r) => r.payment_mode === "test").length,
    },
  });
}
