/**
 * POST /api/hosting/:id/resolve — closing a paid-but-undelivered hosting account.
 *
 * The hosting twin of the domain route, added 11 Sep 2026 once
 * `provision-hosting` started leaving a row behind on failure. Before that there
 * was nothing to resolve: a refused DirectAdmin wrote no `hosting_accounts` row
 * at all, so a customer who had paid saw an empty /portal/hosting and no queue
 * existed for an operator to work from.
 *
 * All the rules are in `lib/domains/resolve.server.ts`, shared with the domain
 * route. Nothing here refunds money or creates an account — it records who
 * decided what.
 */
import { NextResponse, type NextRequest } from "next/server";
import { resolvePaidNotDelivered } from "@/lib/domains/resolve.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  let raw: unknown;
  try { raw = await req.json(); } catch { raw = {}; }

  const out = await resolvePaidNotDelivered("hosting", params.id, raw);
  return out.ok
    ? NextResponse.json({ ok: true, resolution: out.resolution, audited: out.audited })
    : NextResponse.json({ error: out.error }, { status: out.status });
}
