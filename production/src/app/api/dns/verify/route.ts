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
import {
  sendingReport, dkimHost, dmarcHost, RESEND_DEFAULTS,
} from "@/lib/dns/email-sending";

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

  /**
   * `?check=sending` answers the other half: can this domain SEND?
   *
   * That is what blocks per-tenant email today. `RESEND_FROM_OVERRIDE` is set in
   * production precisely because no tenant domain is verified with the provider,
   * so every message goes out under one shared From. The senders already pass
   * `from: tenant.email` — it is DNS, not code, that is missing. This makes the
   * gap visible instead of leaving it to a dashboard nobody opens.
   *
   * The provider's expected values are overridable by query param, because a
   * checker that hardcodes one provider's records goes stale and then calls a
   * healthy domain broken.
   */
  if ((req.nextUrl.searchParams.get("check") ?? "").toLowerCase() === "sending") {
    const expected = {
      spfInclude:   req.nextUrl.searchParams.get("spf_include")?.trim()   || RESEND_DEFAULTS.spfInclude,
      dkimSelector: req.nextUrl.searchParams.get("dkim_selector")?.trim() || RESEND_DEFAULTS.dkimSelector,
      providerName: req.nextUrl.searchParams.get("provider")?.trim()      || RESEND_DEFAULTS.providerName,
    };

    const [rootTxt, dkimTxt, dmarcTxt] = await Promise.all([
      resolveDoh(domain, DNS_TYPE.TXT),
      resolveDoh(dkimHost(domain, expected.dkimSelector), DNS_TYPE.TXT),
      resolveDoh(dmarcHost(domain), DNS_TYPE.TXT),
    ]);

    // Same rule as below: only the ROOT lookup failing is a real resolver error.
    // A missing DKIM or DMARC name legitimately returns nxdomain, and reporting
    // that as "our lookup failed" would hide the actual finding.
    if (!rootTxt.ok && rootTxt.error) {
      return NextResponse.json(
        { ok: false, domain, error: `DNS lookup failed — ${rootTxt.error}. That's our lookup, not the customer's DNS; try again.` },
        { status: 502 },
      );
    }

    const report = sendingReport(
      domain,
      rootTxt.ok ? rootTxt.data : [],
      dkimTxt.ok ? dkimTxt.data : [],
      dmarcTxt.ok ? dmarcTxt.data : [],
      expected,
    );

    return NextResponse.json({
      ok: true,
      domain,
      mode: "sending" as const,
      provider: report.provider,
      overall: report.state,
      canSend: report.canSend,
      checks: report.checks,
      raw: {
        txt:   rootTxt.ok ? rootTxt.data : [],
        dkim:  dkimTxt.ok ? dkimTxt.data : [],
        dmarc: dmarcTxt.ok ? dmarcTxt.data : [],
      },
    });
  }

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
