/**
 * GET /api/admin/egress-ip — what address does this deployment call out from?
 *
 * Ported from the DMS engine's `/api/admin/check-ip` on 10 Sep 2026.
 *
 * ─── WHY THIS EXISTS, AND WHY IT IS THE FIRST THING TO CHECK ─────────────────
 * ResellerClub and DirectAdmin both gate on our egress IP, and NEITHER says so
 * when it refuses: RC returns an error whose text has to be read to tell it from
 * a bad api-key, and DA returns its HTML login page, which looks exactly like
 * wrong credentials. So when a paid domain order starts failing, "has our egress
 * IP changed?" is the first question — and until now answering it meant finding
 * somebody with cloud console access.
 *
 * ─── GET, UNLIKE THE SSO ROUTE ───────────────────────────────────────────────
 * `/api/hosting/[id]/sso` is a POST specifically because calling it MINTS a
 * credential. This mints nothing, changes nothing upstream, and is safe to
 * prefetch or reload — three outbound HTTP requests that ask "what is my IP".
 * The audit row it writes is a record of a diagnostic, not of an access.
 *
 * ─── STAFF ONLY ──────────────────────────────────────────────────────────────
 * Not because the answer is secret — an egress IP is observable by anything we
 * connect to — but because the probes are outbound requests on our budget, and
 * an unauthenticated endpoint that makes three of them per call is a free
 * traffic amplifier.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { assessEgress, probeAll, egressNeedsAction } from "@/lib/ops/egress-ip";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The address the upstreams have been told to allow.
 *
 * From the environment, with NO hardcoded default. The known value today is
 * 34.14.190.227 (the static NAT — quoted in lib/resellerclub/index.ts and
 * lib/directadmin/index.ts), but baking it in here would make this file lie the
 * day the infrastructure changes, and a diagnostic that lies is worse than one
 * that says "nothing configured to compare against". That is exactly the mistake
 * DMS's `KNOWN_PACKAGES` made in the other direction.
 */
const EXPECTED_EGRESS_IP = process.env.EXPECTED_EGRESS_IP?.trim() || null;

export async function GET(_req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });

  /* `users` holds staff; a portal customer lives in `customer_users` and has no
     row here at all. Checked BEFORE any outbound request is made — the point of
     the gate is the traffic, so refusing after spending it would be pointless. */
  const { data: staff } = await supabase
    .from("users").select("id, tenant_id, is_active").eq("id", user.id).maybeSingle();
  if (!staff || staff.is_active === false) {
    return NextResponse.json({ ok: false, error: "This diagnostic is for the team that manages this deployment." }, { status: 403 });
  }

  const probes = await probeAll();
  const assessment = assessEgress(probes, EXPECTED_EGRESS_IP);

  /* Recorded so "when did this change?" is answerable later — the question
     nobody can answer from a live reading alone. The admin client is used
     because the row belongs to the deployment rather than to the caller's
     session, and `checked_by` names the person who asked. */
  const admin = createAdminClient();
  const { error: writeErr } = await admin.from("egress_ip_checks").insert({
    tenant_id: staff.tenant_id,
    observed_ip: assessment.observedIp,
    observed_ips: assessment.observedIps,
    expected_ip: assessment.expectedIp,
    verdict: assessment.verdict,
    probes: probes.map((p) => ({ service: p.service, ip: p.ip, error: p.error, ms: p.ms })),
    checked_by: staff.id,
  });

  if (writeErr) {
    /* The reading is still valid and still worth showing — losing the history
       row is much less bad than refusing to answer the question somebody is
       stuck on. Reported in the response rather than hidden, so nobody later
       wonders why the history has a gap. */
    console.error("[admin/egress-ip] could not record the check:", writeErr.message);
  }

  if (egressNeedsAction(assessment.verdict)) {
    console.warn(`[admin/egress-ip] ${assessment.verdict}: ${assessment.summary}`);
  }

  return NextResponse.json(
    {
      ok: true,
      verdict: assessment.verdict,
      observed_ip: assessment.observedIp,
      observed_ips: assessment.observedIps,
      expected_ip: assessment.expectedIp,
      needs_action: egressNeedsAction(assessment.verdict),
      summary: assessment.summary,
      probes,
      recorded: !writeErr,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
