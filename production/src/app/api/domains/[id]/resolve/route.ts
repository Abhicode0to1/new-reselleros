/**
 * POST /api/domains/:id/resolve — closing a paid-but-undelivered registration.
 *
 * A `domains` row that is `failed` with an `amount_paid` is a customer who HAS
 * PAID AND HAS NO DOMAIN. The provisioning cron retries on a bounded budget and
 * then stops so a person decides (lib/domains/retry.ts); this is where that
 * decision is recorded.
 *
 * Every rule — staff only, the already-resolved refusal, the atomic claim, the
 * audit line — lives in `lib/domains/resolve.server.ts`, shared with the hosting
 * route. The two differ in one word, and a second copy is how they come to
 * disagree about who may resolve what.
 */
import { NextResponse, type NextRequest } from "next/server";
import { resolvePaidNotDelivered } from "@/lib/domains/resolve.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  let raw: unknown;
  try { raw = await req.json(); } catch { raw = {}; }

  const out = await resolvePaidNotDelivered("domain", params.id, raw);
  return out.ok
    ? NextResponse.json({ ok: true, resolution: out.resolution, audited: out.audited })
    : NextResponse.json({ error: out.error }, { status: out.status });
}
