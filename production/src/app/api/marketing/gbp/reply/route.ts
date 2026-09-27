/**
 * POST /api/marketing/gbp/reply — publish a reply to a Google review.
 * Body: { reviewId, comment }. The reply is written on Google first; the local row is
 * updated only from Google's answer, so the page never shows a reply Google rejected.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { getFreshGbpAccessToken, replyToReview } from "@/lib/google/gbp-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { data: me } = await supabase.from("users").select("tenant_id, role").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) return NextResponse.json({ error: "No tenant." }, { status: 400 });
  if (!["owner", "manager"].includes((me as { role?: string }).role ?? "")) return NextResponse.json({ error: "Owner/manager only." }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { reviewId?: string; comment?: string };
  const comment = (body.comment ?? "").trim();
  if (!body.reviewId || !comment) return NextResponse.json({ error: "Reply text chahiye." }, { status: 400 });
  if (comment.length > 4096) return NextResponse.json({ error: "Reply 4096 characters se chhota rakho (Google ki limit)." }, { status: 400 });

  const admin = createAdminClient();
  const { data: review } = await admin.from("gbp_reviews")
    .select("id, review_name, location_id, gbp_locations!gbp_reviews_location_id_fkey(connected_user_id)")
    .eq("id", body.reviewId).eq("tenant_id", me.tenant_id).maybeSingle();
  if (!review) return NextResponse.json({ error: "Review nahi mila." }, { status: 404 });
  const syncUser = (review as unknown as { gbp_locations?: { connected_user_id: string } | null }).gbp_locations?.connected_user_id ?? user.id;

  try {
    const token = await getFreshGbpAccessToken(admin, syncUser);
    const reply = await replyToReview(token, review.review_name, comment);
    await admin.from("gbp_reviews").update({ reply_comment: reply.comment ?? comment, replied_at: reply.updateTime ?? new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", review.id);
    return NextResponse.json({ ok: true, reply });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || "Reply failed" }, { status: 502 });
  }
}
