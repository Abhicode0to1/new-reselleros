/**
 * GET /api/ai/action-log — what the app did on its own, newest first.
 *
 * A route rather than a client query for the same reason as `api/ai/autonomy`:
 * `ai_action_log` is absent from the generated `Database` type, and registering one extra
 * table in that map took typecheck from 4 errors to 2,722 (AGENTS.md L31).
 *
 * Readable by ANYONE in the workspace, not just the owner. The RLS select policy says the
 * same. A log only one person can open is a log nobody reads, and the rows that matter most
 * — the HELD ones — are a queue of customers waiting on a human, which is exactly the thing
 * a whole team should be able to see.
 *
 * `?held=1` narrows to that queue, and there is a partial index behind it.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { readAiActionLog } from "@/lib/ai/autonomy.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data } = await supabase
    .from("users").select("tenant_id").eq("id", auth.user.id).single();
  const tenantId = (data as { tenant_id?: string | null } | null)?.tenant_id;
  if (!tenantId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url      = new URL(request.url);
  const heldOnly = url.searchParams.get("held") === "1";
  const limit    = Number(url.searchParams.get("limit") ?? "100");

  const { rows, error } = await readAiActionLog(tenantId, {
    heldOnly,
    limit: Number.isFinite(limit) ? limit : 100,
  });

  if (error) {
    /* A read failure is reported as a failure and not as an empty log. "The app did nothing"
       and "we could not find out what the app did" look identical on screen and mean
       opposite things. */
    return NextResponse.json({ error }, { status: 500 });
  }

  return NextResponse.json({ rows }, { headers: { "cache-control": "no-store, max-age=0" } });
}
