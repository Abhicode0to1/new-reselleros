/**
 * POST /api/attendance/mark  { employeeId, pin }
 *
 * Server-side attendance mark. The office-network gate lives HERE, not on the
 * client: we read the client IP from `x-forwarded-for` and, if the tenant has
 * locked an allowlist of office IPs, reject anything from outside it. Then we
 * call mark_attendance, logging the source IP.
 *
 * ─── "THE BROWSER CAN'T FORGE IT" WAS NOT TRUE ───────────────────────
 * That is what this header said, above a local `clientIp` that took
 * `x-forwarded-for.split(",")[0]`. Google's own documentation says the
 * infrastructure APPENDS to a header the caller already set —
 * `<existing-value>,<client-ip>,<load-balancer-ip>` — and "does not verify any
 * IP addresses that precede the client-ip". So `[0]` is whatever the caller
 * typed, and one `curl -H "x-forwarded-for: <an office IP>"` walked straight
 * through the office-network gate from anywhere.
 *
 * It now uses the shared `clientIp` from lib/security/rate-limit.ts, which
 * counts from the RIGHT — the end only our own infrastructure writes. That is
 * one implementation for the whole app instead of four copies of the same
 * mistake, and it is the one with tests.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { clientIp } from "@/lib/security/rate-limit";

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const employeeId = body?.employeeId as string | undefined;
  const pin = body?.pin as string | undefined;
  const photo = body?.photo as string | undefined; // optional data:image/jpeg;base64,...
  if (!employeeId || !pin) return NextResponse.json({ error: "Missing employee or PIN" }, { status: 400 });

  const ip = clientIp(request.headers);

  // Office-network gate (opt-in) + selfie requirement (anti buddy-punching).
  const { data: settings } = await supabase
    .from("attendance_settings")
    .select("allowed_ips, require_selfie")
    .maybeSingle();
  const allowed = settings?.allowed_ips ?? [];
  if (allowed.length > 0 && !allowed.includes(ip)) {
    return NextResponse.json(
      { error: "You're not on the office network — attendance can only be marked at the office." },
      { status: 403 },
    );
  }
  // Selfie required (default): a PIN alone can't mark — every mark needs a photo
  // of who did it, so knowing someone else's PIN isn't enough to punch them in.
  const requireSelfie = settings?.require_selfie ?? true;
  if (requireSelfie && !photo) {
    return NextResponse.json(
      { error: "A selfie is required to mark attendance. Please allow the camera and try again." },
      { status: 400 },
    );
  }

  const { data, error } = await supabase.rpc("mark_attendance", {
    p_employee_id: employeeId,
    p_pin: pin,
    p_ip: ip || null,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  const action = data as string;

  // Attach the selfie (best-effort — attendance is already recorded).
  if (photo && (action === "checked_in" || action === "checked_out")) {
    try {
      const { data: me } = await supabase.from("users").select("tenant_id").eq("id", authData.user.id).single();
      const base64 = photo.includes(",") ? photo.split(",")[1] : photo;
      const buf = Buffer.from(base64, "base64");
      if (me?.tenant_id && buf.length > 0 && buf.length < 3_000_000) {
        const workDate = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
        const slot = action === "checked_in" ? "in" : "out";
        const path = `${me.tenant_id}/${workDate}/${employeeId}_${slot}.jpg`;
        const up = await supabase.storage.from("attendance-selfies").upload(path, buf, { contentType: "image/jpeg", upsert: true });
        if (!up.error) {
          await supabase.from("attendance")
            .update(slot === "in" ? { selfie_in: path } : { selfie_out: path })
            .eq("employee_id", employeeId).eq("work_date", workDate);
        }
      }
    } catch { /* photo is best-effort; never block attendance */ }
  }

  return NextResponse.json({ action });
}
