/**
 * POST /api/dms/start-trial — a free hosting trial started inside the DMS panel.
 *
 * Owner decision, 26 Sep 2026 ("Move it to ResellerOS"): the panel's Start-trial button
 * calls this instead of DMS creating the trial itself, so there is ONE trial path for both
 * apps. ResellerOS then knows the trial, reminds before it ends, quotes the conversion and
 * bills it. Before this, an in-panel trial had no ResellerOS record, so its "convert" button
 * could only say "contact support".
 *
 * It calls `startHostingTrial`, the same function the site cart uses, unchanged: Starter
 * only, one trial per customer across both apps (checked against DMS's shared record), a
 * confirm-your-email link, and the account is created by the DMS engine only after the
 * customer confirms, behind HOSTING_TRIAL_LIVE.
 *
 * Auth: `Authorization: Bearer <DMS_PANEL_API_KEY>`, as for /api/dms/panel-order.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { checkPanelKey } from "@/lib/dms-engine/panel-auth";
import { startHostingTrial } from "@/lib/hosting/start-trial";

export const dynamic = "force-dynamic";

const schema = z.object({
  dmsUserId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  fullName: z.string().min(2).max(120),
  companyName: z.string().max(200).optional(),
  email: z.string().email().max(200),
  phone: z.string().min(10).max(20),
  domain: z.string().max(120).optional(),
  cycle: z.enum(["monthly", "yearly"]),
});

export async function POST(request: NextRequest) {
  const auth = checkPanelKey(request.headers);
  if (!auth.ok) {
    if (auth.status === 503) console.warn("[dms/start-trial]", auth.error);
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid trial request: the request was not JSON. No trial was started." }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid trial request: " + parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") + ". No trial was started." },
      { status: 400 },
    );
  }
  const r = parsed.data;
  const started = await startHostingTrial(
    createAdminClient(),
    {
      fullName: r.fullName,
      // The panel may not know a company; the lead still needs a name for it.
      companyName: r.companyName?.trim() || r.fullName,
      email: r.email,
      phone: r.phone,
      domain: r.domain,
      cycle: r.cycle,
    },
    request,
    { utm_source: "dms-panel", dmsUserId: r.dmsUserId },
  );
  if (!started.ok) {
    // An earlier trial is the customer's answer, not a fault: 409, so DMS shows it as it is.
    return NextResponse.json(
      { error: started.error, alreadyTrialled: started.alreadyTrialled === true },
      { status: started.alreadyTrialled ? 409 : 500 },
    );
  }
  return NextResponse.json({ success: true, leadId: started.leadId, trialEnds: started.trialEnds });
}
