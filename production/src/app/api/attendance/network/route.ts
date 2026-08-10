/**
 * GET  /api/attendance/network  → { allowedIps, currentIp, onAllowedNetwork }
 * POST /api/attendance/network  { action: 'lock' | 'clear' | 'remove', ip? }
 *
 * Owner/manager manages the office-network allowlist for attendance. "lock"
 * captures the CURRENT public IP (read server-side) as an allowed office
 * network; "remove" drops one; "clear" turns the gate off.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { newPresenceSecret } from "@/lib/attendance/presence";

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip")?.trim() ?? "";
}

async function me(supabase: ReturnType<typeof createClient>) {
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return null;
  const { data } = await supabase.from("users").select("tenant_id, role").eq("id", authData.user.id).single();
  return data ? { userId: authData.user.id, ...data } : null;
}

export async function GET(request: NextRequest) {
  const supabase = createClient();
  const u = await me(supabase);
  if (!u) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { data } = await supabase.from("attendance_settings").select("allowed_ips, require_selfie, require_presence").maybeSingle();
  const allowedIps: string[] = data?.allowed_ips ?? [];
  const currentIp = clientIp(request);
  return NextResponse.json({
    allowedIps,
    currentIp,
    onAllowedNetwork: allowedIps.length === 0 || allowedIps.includes(currentIp),
    requireSelfie: data?.require_selfie ?? true,
    requirePresence: data?.require_presence ?? false,
  });
}

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const u = await me(supabase);
  if (!u) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (u.role !== "owner") {
    return NextResponse.json({ error: "Only the owner can change attendance security" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const action = body?.action as string | undefined;
  const currentIp = clientIp(request);

  const { data: existing } = await supabase.from("attendance_settings").select("allowed_ips, require_selfie, require_presence, presence_secret").maybeSingle();
  let allowed: string[] = existing?.allowed_ips ?? [];
  let requireSelfie: boolean = existing?.require_selfie ?? true;
  let requirePresence: boolean = existing?.require_presence ?? false;
  let presenceSecret: string | null = existing?.presence_secret ?? null;

  if (action === "lock") {
    if (!currentIp) return NextResponse.json({ error: "Couldn't read this network's IP" }, { status: 400 });
    if (!allowed.includes(currentIp)) allowed = [...allowed, currentIp];
  } else if (action === "remove") {
    const ip = body?.ip as string | undefined;
    allowed = allowed.filter((a) => a !== ip);
  } else if (action === "clear") {
    allowed = [];
  } else if (action === "require_selfie") {
    requireSelfie = Boolean(body?.value);
  } else if (action === "require_presence") {
    requirePresence = Boolean(body?.value);
    // Enabling for the first time → mint the rotating-code seed.
    if (requirePresence && !presenceSecret) presenceSecret = newPresenceSecret();
  } else {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const { error } = await supabase
    .from("attendance_settings")
    .upsert({ tenant_id: u.tenant_id, allowed_ips: allowed, require_selfie: requireSelfie, require_presence: requirePresence, presence_secret: presenceSecret, updated_at: new Date().toISOString() }, { onConflict: "tenant_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ allowedIps: allowed, currentIp, requireSelfie, requirePresence });
}
