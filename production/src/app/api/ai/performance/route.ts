/**
 * GET /api/ai/performance — what the AI actually did, for this tenant.
 *
 * OWNER-ONLY, matching /api/health/money, and for a related reason: the funnel names which
 * automation dials are holding replies and which guards are firing. That is a map of where this
 * business's automation is switched off, which is not something every logged-in user needs.
 * A non-owner gets an empty answer rather than a 403 — the card then renders nothing, the same
 * way the money-health card does.
 *
 * The window is computed HERE rather than inside the loader, so the pure module never reads a
 * clock and its tests never need one frozen. `localDateISO`'s sibling rule (AGENTS.md §4): a
 * date boundary belongs at the edge, in IST, not scattered through the maths.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadAiPerformance, PERFORMANCE_WINDOW_DAYS } from "@/lib/ai/performance.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401 });
  }

  const { data: me } = await supabase
    .from("users")
    .select("tenant_id, role")
    .eq("id", authData.user.id)
    .single();
  if (!me?.tenant_id) {
    return NextResponse.json({ ok: false, error: "User not linked to a tenant" }, { status: 403 });
  }
  if (me.role !== "owner") return NextResponse.json({ ok: true, performance: null });

  const since = new Date(Date.now() - PERFORMANCE_WINDOW_DAYS * 86_400_000).toISOString();
  const performance = await loadAiPerformance({ tenantId: me.tenant_id, since });

  return NextResponse.json({ ok: true, performance, windowDays: PERFORMANCE_WINDOW_DAYS });
}
