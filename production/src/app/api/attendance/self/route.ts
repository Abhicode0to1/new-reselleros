/**
 * POST /api/attendance/self  { photo?, code?, lat?, lng?, accuracy? }
 *
 * Self check-in for a logged-in app user. Defense-in-depth:
 *   • Identity  — the login (auth.uid()) proves WHO.
 *   • Presence  — when require_presence is on, the rotating office code proves
 *                 the person is physically at the office (can only be read off
 *                 the office tablet). Validated server-side against the secret.
 *   • Proof     — when require_selfie is on, a live selfie is captured; GPS is
 *                 always stored (soft audit signal) if the phone shares it.
 *
 * Flow: validate presence → mark_self_attendance() → attach selfie + geo to the
 * day's row (best-effort; never blocks the mark once recorded).
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { validateCode } from "@/lib/attendance/presence";

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const photo = body?.photo as string | undefined; // data:image/jpeg;base64,...
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  const lat = typeof body?.lat === "number" ? body.lat : null;
  const lng = typeof body?.lng === "number" ? body.lng : null;
  const accuracy = typeof body?.accuracy === "number" ? body.accuracy : null;

  // Caller's tenant + linked employee — needed for the selfie storage path.
  const { data: me } = await supabase
    .from("users").select("tenant_id, employee_id").eq("id", authData.user.id).single();
  if (!me?.employee_id) {
    return NextResponse.json(
      { error: "Pehle apna employee record link karo, phir attendance mark hogi." },
      { status: 400 },
    );
  }

  const { data: settings } = await supabase
    .from("attendance_settings")
    .select("require_selfie, require_presence, presence_secret")
    .maybeSingle();
  const requireSelfie = settings?.require_selfie ?? true;
  const requirePresence = settings?.require_presence ?? false;

  // Presence gate — must know the current rotating office code.
  if (requirePresence) {
    if (!settings?.presence_secret || !validateCode(settings.presence_secret, code, Date.now())) {
      return NextResponse.json(
        { error: "Office code galat ya expire ho gaya — office tablet pe abhi jo code hai wahi daalo." },
        { status: 400 },
      );
    }
  }

  if (requireSelfie && !photo) {
    return NextResponse.json(
      { error: "Selfie zaroori hai — camera allow karke dobara try karo." },
      { status: 400 },
    );
  }

  // DPDP shield — never store a face selfie without recorded consent.
  if (requireSelfie) {
    const { data: emp } = await supabase
      .from("employees").select("attendance_consent_at").eq("id", me.employee_id).maybeSingle();
    if (!emp?.attendance_consent_at) {
      return NextResponse.json(
        { error: "NEEDS_CONSENT", needsConsent: true },
        { status: 428 },
      );
    }
  }

  const { data, error } = await supabase.rpc("mark_self_attendance");
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  const action = data as unknown as string;

  // Attach selfie + geo (best-effort — attendance is already recorded).
  if (action === "checked_in" || action === "checked_out") {
    try {
      const workDate = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
      const slot = action === "checked_in" ? "in" : "out";
      const patch: { selfie_in?: string; selfie_out?: string; geo_in?: string; geo_out?: string } = {};

      if (photo) {
        const base64 = photo.includes(",") ? photo.split(",")[1] : photo;
        const buf = Buffer.from(base64, "base64");
        if (me.tenant_id && buf.length > 0 && buf.length < 3_000_000) {
          const path = `${me.tenant_id}/${workDate}/${me.employee_id}_${slot}.jpg`;
          const up = await supabase.storage.from("attendance-selfies").upload(path, buf, { contentType: "image/jpeg", upsert: true });
          if (!up.error) patch[slot === "in" ? "selfie_in" : "selfie_out"] = path;
        }
      }
      if (lat !== null && lng !== null) {
        patch[slot === "in" ? "geo_in" : "geo_out"] = `${lat.toFixed(6)},${lng.toFixed(6)}${accuracy !== null ? `,${Math.round(accuracy)}` : ""}`;
      }
      if (Object.keys(patch).length) {
        await supabase.from("attendance").update(patch)
          .eq("employee_id", me.employee_id).eq("work_date", workDate);
      }
    } catch { /* selfie/geo is best-effort; never block attendance */ }
  }

  return NextResponse.json({ action });
}
