/**
 * GET /api/public/health/live — is the app up AND can it reach its database?
 *
 * For the Cloud Monitoring uptime check (scripts/setup-uptime-checks.sh). Under /api/public
 * because it is public on purpose (the api-auth wiring test holds every other admin-client
 * route to a session check; /api/public/* is rate-limited by the middleware instead) and
 * and carries nothing a stranger can use: no config, no counts, no tenant data — a boolean
 * per dependency and the build sha (already public at /api/version).
 *
 * /api/version answers without touching the DB, so a dead data plane still returned 200
 * there; that is the gap this closes. 503 when the database does not answer within 5s, so
 * the uptime check pages on the failure that actually takes the business down.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const sha = (process.env.BUILD_SHA ?? process.env.COMMIT_SHA ?? "").slice(0, 12) || null;
  let db = false;
  let reason: string | null = null;
  try {
    const probe = createAdminClient().from("tenants").select("id", { head: true, count: "exact" }).limit(1);
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("db timeout 5s")), 5000));
    const { error } = await Promise.race([probe, timeout]);
    if (error) throw new Error(error.message);
    db = true;
  } catch (e) {
    reason = (e as Error).message.slice(0, 120);
  }
  return NextResponse.json(
    { ok: db, db, sha, at: new Date().toISOString(), ...(reason ? { reason } : {}) },
    { status: db ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
