/**
 * POST /api/dms/trial-eligibility — "may this customer start a free trial?", asked by DMS.
 *
 * Owner decision, 26 Sep 2026 ("Ask ResellerOS instead"): DMS's panel used to answer this
 * with its own checks before offering the trial, while ResellerOS decided again at checkout,
 * so the two could disagree. Now the panel asks here, and this runs `checkTrialEligibility`,
 * the very function `startHostingTrial` uses, so the answer the panel shows is the answer
 * checkout gives.
 *
 * Read-only: nothing is written. POST rather than GET so the email and phone travel in the
 * body, not in a URL that lands in access logs.
 *
 * Answers:
 * - 200 `{ eligible: true }`;
 * - 200 `{ eligible: false, reason }`: an earlier trial, and the reason is written for the customer;
 * - 503 `{ error }`: the trial history could not be read. NEVER reported as eligible (fail closed).
 *
 * Auth: `Authorization: Bearer <DMS_PANEL_API_KEY>`, as for the other /api/dms routes.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { checkPanelKey } from "@/lib/dms-engine/panel-auth";
import { checkTrialEligibility } from "@/lib/hosting/start-trial";

export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().email().max(200),
  phone: z.string().max(20).optional(),
  domain: z.string().max(120).optional(),
});

export async function POST(request: NextRequest) {
  const auth = checkPanelKey(request.headers);
  if (!auth.ok) {
    if (auth.status === 503) console.warn("[dms/trial-eligibility]", auth.error);
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid eligibility request: the request was not JSON." }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid eligibility request: " + parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") },
      { status: 400 },
    );
  }
  const r = parsed.data;
  const result = await checkTrialEligibility(createAdminClient(), { email: r.email, phone: r.phone ?? "", domain: r.domain });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 503 });
  return result.eligible
    ? NextResponse.json({ eligible: true })
    : NextResponse.json({ eligible: false, reason: result.error });
}
