/** POST /api/leads/finder/run — { profileId } — run the AI Lead Finder for one profile now. */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { runLeadFinder } from "@/lib/leads/lead-finder.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { data: me } = await supabase.from("users").select("tenant_id, role").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) return NextResponse.json({ error: "No tenant." }, { status: 400 });
  if (!["owner", "manager"].includes((me as { role?: string }).role ?? "")) return NextResponse.json({ error: "Owner/manager only." }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { profileId?: string };
  if (!body.profileId) return NextResponse.json({ error: "profileId chahiye." }, { status: 400 });
  try {
    const r = await runLeadFinder(createAdminClient(), me.tenant_id, body.profileId, "manual");
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || "Run failed" }, { status: 502 });
  }
}
