/**
 * GET  /api/domains/:id/dns   — the DNS records we hold for one domain.
 * POST /api/domains/:id/dns   — add a record at the registrar, then mirror it.
 *
 * ─── WHICH SIDE IS TRUE, AND WHAT THAT MEANS FOR ORDER OF OPERATIONS ─────────
 * ResellerClub is. `dns_records` is a mirror, so a write goes UPSTREAM FIRST and
 * is only mirrored once RC has accepted it. The other order — write locally,
 * push later — produces a zone the app displays and the internet does not have,
 * which is the worst possible thing for a DNS screen to do: the customer reads
 * "mail.acmecorp.com MX 10" from our table while their mail bounces.
 *
 * A failed mirror-after-success is therefore the one inconsistency this accepts,
 * and it is the safe direction: the record EXISTS upstream and is missing from
 * our list, which the sync route repairs. Nothing is lost.
 *
 * ─── WHY RLS AND NOT A TENANT CHECK ──────────────────────────────────────────
 * Every query here uses the request-scoped client, so `dns_records_write_staff`
 * and the domain's own policy decide what this user may touch. There is exactly
 * one definition of "yours" and it lives in the database — a tenant_id compare
 * written here would be a second one, and the second one is the one that goes
 * stale. RLS is NOT the whole story for writes, though: it guards the table, and
 * the upstream call happens first, so POST also carries an explicit staff check
 * before any side effect. lib/domains/authz.ts says why at length.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { rcAddDnsRecord, RC_DNS_TYPES } from "@/lib/resellerclub/dns";
import { toDnsRow } from "@/lib/domains/dns-sync";
import { authorizeDomainWrite } from "@/lib/domains/authz";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RecordInput = z.object({
  type: z.enum(RC_DNS_TYPES),
  /** "@" is the apex. Left as the caller typed it; the RC layer normalises. */
  host: z.string().trim().min(1).max(253),
  value: z.string().trim().min(1).max(1024),
  ttl: z.coerce.number().int().positive().max(2_592_000).optional(),
  priority: z.coerce.number().int().min(0).max(65535).optional(),
  weight: z.coerce.number().int().min(0).max(65535).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
});

/** The domain, as far as RLS will show it to this caller. */
async function loadDomain(supabase: ReturnType<typeof createClient>, id: string) {
  const { data } = await supabase
    .from("domains")
    .select("id, tenant_id, domain_name, status, registrar_customer_id, registrar_order_id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  return data;
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });

  const domain = await loadDomain(supabase, params.id);
  if (!domain) return NextResponse.json({ ok: false, error: "No such domain." }, { status: 404 });

  const { data: records, error } = await supabase
    .from("dns_records")
    .select("id, record_type, host, value, ttl, priority, provider_record_id, updated_at")
    .eq("domain_id", params.id)
    .order("record_type", { ascending: true })
    .order("host", { ascending: true });

  if (error) {
    console.error("[dns] list failed:", error.message);
    return NextResponse.json({ ok: false, error: "Could not read the DNS records." }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    domain: { id: domain.id, name: domain.domain_name, status: domain.status },
    records: records ?? [],
    /* Said plainly, because an empty list has two very different causes and the
       screen should not have to guess which. */
    mirrored_from_registrar: !!domain.registrar_customer_id,
  });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });

  const domain = await loadDomain(supabase, params.id);
  if (!domain) return NextResponse.json({ ok: false, error: "No such domain." }, { status: 404 });

  /* BEFORE any upstream call. RLS would refuse the mirror insert but only after
     the record was already live at the registrar — see lib/domains/authz.ts. */
  const authz = await authorizeDomainWrite(supabase, domain.tenant_id);
  if (!authz.ok) return NextResponse.json({ ok: false, error: authz.error }, { status: authz.status });

  if (!domain.registrar_customer_id) {
    /* Without RC's customer id there is nobody to file the record under. This is
       a data gap, not a validation error — say which, so the reader looks in the
       right place. */
    return NextResponse.json({
      ok: false,
      error: "This domain has no ResellerClub customer id yet, so a DNS record cannot be filed upstream. It is set when the registration lands.",
    }, { status: 409 });
  }

  let body: unknown;
  try { body = await req.json(); } catch { body = null; }
  const parsed = RecordInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
    }, { status: 400 });
  }

  /* Upstream first. `rcAddDnsRecord` refuses an MX with no priority and an SRV
     without weight/port rather than defaulting them — the same rules
     `dns_records` enforces — so a refusal here is a 400 and not a 502. */
  const wrote = await rcAddDnsRecord(domain.domain_name, domain.registrar_customer_id, parsed.data);

  if (wrote.kind === "refused") {
    return NextResponse.json({ ok: false, error: wrote.reason }, { status: 400 });
  }
  if (wrote.kind === "hard_failure") {
    return NextResponse.json({ ok: false, error: wrote.reason }, { status: 502 });
  }

  const { data: mirrored, error: mirrorErr } = await supabase
    .from("dns_records")
    .insert(toDnsRow({
      providerRecordId: wrote.providerRecordId,
      type: parsed.data.type,
      host: parsed.data.host,
      value: parsed.data.value,
      ttl: wrote.ttlUsed ?? parsed.data.ttl ?? 7200,
      priority: parsed.data.priority ?? null,
    }, domain.tenant_id, domain.id))
    .select("id, record_type, host, value, ttl, priority, provider_record_id")
    .maybeSingle();

  if (mirrorErr || !mirrored) {
    /* The record IS live upstream. Reporting a failure here would invite a
       retry that files it a second time, so this is a 200 with a warning and a
       pointer at the repair. */
    console.error("[dns] added upstream but the mirror insert failed:", mirrorErr?.message);
    return NextResponse.json({
      ok: true,
      warning: "The record was created at the registrar but could not be saved to this app's copy. Run a sync to pull it in — do NOT add it again, it already exists upstream.",
      record: null,
      ttl_used: wrote.ttlUsed ?? null,
    });
  }

  return NextResponse.json({
    ok: true,
    record: mirrored,
    /* Surfaced because RC silently raises anything below its floor, and a caller
       that asked for 300 would otherwise believe it got 300. */
    ttl_used: wrote.ttlUsed ?? null,
  });
}
