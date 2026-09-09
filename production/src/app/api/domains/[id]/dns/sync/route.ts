/**
 * POST /api/domains/:id/dns/sync — pull the registrar's zone into our mirror.
 *
 * This is the repair path every other DNS route points at when a write lands
 * upstream but the mirror does not catch it, and it is also how a domain that
 * was managed outside this app gets its records in at all.
 *
 * ─── THE PART WORTH BEING CAREFUL ABOUT ──────────────────────────────────────
 * A sync deletes local rows the registrar no longer has — which is correct, and
 * is also one bad read away from deleting records that are perfectly alive.
 * Listing a zone takes seven calls (one per record type), so a single
 * rate-limited MX query makes every MX record look absent.
 *
 * All of that judgement lives in `planDnsSync`, which refuses to propose a
 * deletion unless it was handed a COMPLETE list. This route's job is to fetch,
 * apply the plan, and report what it did — including what it deliberately did
 * not do, because a sync that silently declines to delete looks broken.
 *
 * `?dry_run=1` returns the plan without applying it. Worth having on an endpoint
 * whose failure mode is data loss.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { rcListDnsRecords } from "@/lib/resellerclub/dns";
import { planDnsSync, planIsNoop, toDnsRow, type LocalDnsRow } from "@/lib/domains/dns-sync";
import { authorizeDomainWrite } from "@/lib/domains/authz";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });

  const { data: domain } = await supabase
    .from("domains")
    .select("id, tenant_id, domain_name, registrar_customer_id")
    .eq("id", params.id)
    .is("deleted_at", null)
    .maybeSingle();

  if (!domain) return NextResponse.json({ ok: false, error: "No such domain." }, { status: 404 });
  /* Authorization BEFORE anything about the domain's state is disclosed, and
     before the RC read — a sync inserts, updates and DELETES mirror rows, so it
     is a write path. Ordered this way after an end-to-end check returned 409
     "no registrar customer id" to a portal customer who should simply have been
     told no: an unauthorized caller had learned something about the domain. */
  const authz = await authorizeDomainWrite(supabase, domain.tenant_id);
  if (!authz.ok) return NextResponse.json({ ok: false, error: authz.error }, { status: authz.status });

  if (!domain.registrar_customer_id) {
    return NextResponse.json({
      ok: false,
      error: "This domain has no ResellerClub customer id yet, so its zone cannot be read. It is set when the registration lands.",
    }, { status: 409 });
  }

  const dryRun = ["1", "true", "yes"].includes((req.nextUrl.searchParams.get("dry_run") ?? "").toLowerCase());

  const [upstream, localRes] = await Promise.all([
    rcListDnsRecords(domain.domain_name, domain.registrar_customer_id),
    supabase
      .from("dns_records")
      .select("id, record_type, host, value, ttl, priority, provider_record_id")
      .eq("domain_id", domain.id),
  ]);

  if (localRes.error) {
    console.error("[dns:sync] reading the mirror failed:", localRes.error.message);
    return NextResponse.json({ ok: false, error: "Could not read this app's DNS copy." }, { status: 500 });
  }

  const local = (localRes.data ?? []) as LocalDnsRow[];
  const plan = planDnsSync(upstream, local);

  const report = {
    ok: true,
    domain: domain.domain_name,
    dry_run: dryRun,
    upstream: upstream.kind,
    /* Named individually rather than as one "changes" count, because "3 deleted"
       is the number somebody wants to see before they believe a sync. */
    planned: { insert: plan.insert.length, update: plan.update.length, delete: plan.delete.length },
    applied: { insert: 0, update: 0, delete: 0 },
    types_covered: plan.typesCovered,
    /* The honest half: why an obviously-stale row survived. */
    deletes_withheld: plan.deletesWithheld,
    failed_types: upstream.kind === "partial" ? upstream.failed : [],
  };

  if (upstream.kind === "hard_failure") {
    return NextResponse.json({ ...report, ok: false, error: upstream.reason }, { status: 502 });
  }

  if (dryRun || planIsNoop(plan)) return NextResponse.json(report);

  if (plan.insert.length > 0) {
    const rows = plan.insert.map((r) => toDnsRow(r, domain.tenant_id, domain.id));
    const { data, error } = await supabase.from("dns_records").insert(rows).select("id");
    if (error) console.error("[dns:sync] insert failed:", error.message);
    report.applied.insert = data?.length ?? 0;
  }

  for (const u of plan.update) {
    const { error } = await supabase
      .from("dns_records")
      .update({
        record_type: u.to.type,
        host: u.to.host,
        value: u.to.value,
        ttl: u.to.ttl,
        priority: u.to.priority,
        provider_record_id: u.to.providerRecordId,
      })
      .eq("id", u.id);
    if (error) console.error("[dns:sync] update failed:", error.message);
    else report.applied.update++;
  }

  if (plan.delete.length > 0) {
    const { data, error } = await supabase.from("dns_records").delete().in("id", plan.delete).select("id");
    if (error) console.error("[dns:sync] delete failed:", error.message);
    report.applied.delete = data?.length ?? 0;
  }

  return NextResponse.json(report);
}
