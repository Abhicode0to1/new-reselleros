/**
 * GET /api/public/trial/hosting/status — can a free hosting trial start right now?
 * Public, no data: the checkout asks before showing "Start my 15-day free trial", so a paused
 * trial reads as paused instead of a failure after the customer has filled the form.
 */
import { NextResponse } from "next/server";
import { trialsConfigured, TRIALS_PAUSED_MESSAGE } from "@/lib/dms-engine/trials";

export const dynamic = "force-dynamic";

export function GET() {
  const open = trialsConfigured();
  return NextResponse.json(open ? { open } : { open, message: TRIALS_PAUSED_MESSAGE });
}
