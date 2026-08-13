/**
 * GET /api/dns/verify?domain=example.com[&token=<google-site-verification token>]
 *
 * Resolves a customer's MX / TXT records over DNS-over-HTTPS and judges them
 * against Google Workspace's published requirements. Read-only: it queries public
 * DNS and writes nothing.
 *
 * Thin on purpose. The lookup lives in lib/dns/doh.ts and the judgement in
 * lib/dns/workspace-dns.ts, both of which are testable without a session; this
 * route only authenticates, validates the input, and composes the two.
 *
 * WHY AUTHENTICATED. An unauthenticated endpoint that resolves any name from a
 * query string is an open resolver — useful to someone mapping infrastructure, and
 * attributable to us. Requiring a session costs nothing, so it does. Note this is
 * a route-level check, not the middleware's: it therefore still applies when
 * NEXT_PUBLIC_DEMO_MODE bypasses the middleware for UI review.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveDoh, normaliseDomainInput, DNS_TYPE } from "@/lib/dns/doh";
import {
  parseMx, checkMx, checkVerificationTxt, checkSpf, overallState,
  type MxRecord, type DnsCheck,
} from "@/lib/dns/workspace-dns";

export const dynamic = "force-dynamic";
export const runtime  = "nodejs";

export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });

  const domain = normaliseDomainInput(req.nextUrl.searchParams.get("domain"));
  if (!domain) {
    return NextResponse.json(
      { ok: false, error: "Enter a domain like example.com — not a URL or an email address." },
      { status: 400 },
    );
  }

  const token = req.nextUrl.searchParams.get("token")?.trim() || null;

  const [mxRes, txtRes] = await Promise.all([
    resolveDoh(domain, DNS_TYPE.MX),
    resolveDoh(domain, DNS_TYPE.TXT),
  ]);

  if (!mxRes.ok && mxRes.kind === "nxdomain") {
    return NextResponse.json({
      ok: true, domain, overall: "fail" as const,
      checks: [{
        id: "mx", label: "Domain", state: "fail",
        detail: `${domain} does not resolve at all — check the spelling, or the domain may not be registered yet.`,
      }] satisfies DnsCheck[],
      raw: { mx: [], txt: [] },
    });
  }

  // A resolver failure is reported as a resolver failure, never as "records
  // missing". Telling a customer their DNS is wrong because OUR lookup timed out
  // is the one answer this endpoint must never give.
  const lookupError = (!mxRes.ok && mxRes.error) || (!txtRes.ok && txtRes.error) || null;
  if (lookupError) {
    return NextResponse.json(
      { ok: false, domain, error: `DNS lookup failed — ${lookupError}. That's our lookup, not the customer's DNS; try again.` },
      { status: 502 },
    );
  }

  const mxRecords: MxRecord[] = (mxRes.ok ? mxRes.data : [])
    .map(parseMx).filter((r): r is MxRecord => r !== null);
  const txts = txtRes.ok ? txtRes.data : [];

  const checks: DnsCheck[] = [
    checkMx(mxRecords),
    checkVerificationTxt(txts, token),
    checkSpf(txts),
  ];

  return NextResponse.json({
    ok: true,
    domain,
    overall: overallState(checks),
    checks,
    // Cheap to return, and it saves the "are you sure you actually looked?" round trip.
    raw: { mx: mxRes.ok ? mxRes.data : [], txt: txts },
  });
}
