/**
 * POST /api/attendance/self  { photo?: "data:image/jpeg;base64,..." }
 *
 * Self check-in for a logged-in app user. The login proves WHO (identity), and
 * — when the tenant keeps require_selfie on — a live selfie proves the person is
 * actually present (anti buddy-punching, same posture as the shared kiosk).
 *
 * Flow: mark_self_attendance() (uses auth.uid() internally) → attach the selfie
 * to the day's attendance row (best-effort, never blocks the mark once recorded).
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const photo = body?.photo as string | undefined; // optional data:image/jpeg;base64,...

  // Caller's tenant + linked employee — needed for the selfie storage path.
  const { data: me } = await supabase
    .from("users").select("tenant_id, employee_id").eq("id", authData.user.id).single();
  if (!me?.employee_id) {
    return NextResponse.json(
      { error: "Pehle apna employee record link karo, phir attendance mark hogi." },
      { status: 400 },
    );
  }

  // Selfie requirement — the SAME tenant setting the kiosk honours (default on).
  const { data: settings } = await supabase
    .from("attendance_settings")
    .select("require_selfie")
    .maybeSingle();
  const requireSelfie = settings?.require_selfie ?? true;
  if (requireSelfie && !photo) {
    return NextResponse.json(
      { error: "Selfie zaroori hai — camera allow karke dobara try karo." },
      { status: 400 },
    );
  }

  const { data, error } = await supabase.rpc("mark_self_attendance");
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  const action = data as unknown as string;

  // Attach the selfie (best-effort — attendance is already recorded).
  if (photo && (action === "checked_in" || action === "checked_out")) {
    try {
      const base64 = photo.includes(",") ? photo.split(",")[1] : photo;
      const buf = Buffer.from(base64, "base64");
      if (me.tenant_id && buf.length > 0 && buf.length < 3_000_000) {
        const workDate = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
        const slot = action === "checked_in" ? "in" : "out";
        const path = `${me.tenant_id}/${workDate}/${me.employee_id}_${slot}.jpg`;
        const up = await supabase.storage.from("attendance-selfies").upload(path, buf, { contentType: "image/jpeg", upsert: true });
        if (!up.error) {
          await supabase.from("attendance")
            .update(slot === "in" ? { selfie_in: path } : { selfie_out: path })
            .eq("employee_id", me.employee_id).eq("work_date", workDate);
        }
      }
    } catch { /* photo is best-effort; never block attendance */ }
  }

  return NextResponse.json({ action });
}
