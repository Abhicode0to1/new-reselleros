/**
 * PATCH  /api/domains/:id/dns/:recordId — change a record upstream, then mirror.
 * DELETE /api/domains/:id/dns/:recordId — delete it upstream, then unmirror.
 *
 * Same order of operations as the collection route, for the same reason:
 * ResellerClub is the truth and `dns_records` is the mirror, so nothing is
 * written here until RC has accepted it. See that file's header.
 *
 * `:recordId` is OUR row id, not RC's. A caller should not have to know the
 * registrar's identifiers to edit a row it just read from us — and our row is
 * the thing RLS can scope. RC's `provider_record_id` is read off the row.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { rcModifyDnsRecord, rcDeleteDnsRecord, RC_DNS_TYPES } from "@/lib/resellerclub/dns";
import { authorizeDomainWrite } from "@/lib/domains/authz";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PatchInput = z.object({
  type: z.enum(RC_DNS_TYPES).optional(),
  host: z.string().trim().min(1).max(253).optional(),
  value: z.string().trim().min(1).max(1024).optional(),
  ttl: z.coerce.number().int().positive().max(2_592_000).optional(),
  priority: z.coerce.number().int().min(0).max(65535).optional(),
});

async function load(supabase: ReturnType<typeof createClient>, domainId: string, recordId: string) {
  const { data: domain } = await supabase
    .from("domains")
    .select("id, tenant_id, domain_name, registrar_customer_id")
    .eq("id", domainId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!domain) return { domain: null, record: null };

  const { data: record } = await supabase
    .from("dns_records")
    .select("id, record_type, host, value, ttl, priority, provider_record_id")
    .eq("id", recordId)
    .eq("domain_id", domainId)
    .maybeSingle();

  return { domain, record };
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string; recordId: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });

  const { domain, record } = await load(supabase, params.id, params.recordId);
  if (!domain) return NextResponse.json({ ok: false, error: "No such domain." }, { status: 404 });
  if (!record) return NextResponse.json({ ok: false, error: "No such DNS record on this domain." }, { status: 404 });

  const authz = await authorizeDomainWrite(supabase, domain.tenant_id);
  if (!authz.ok) return NextResponse.json({ ok: false, error: authz.error }, { status: authz.status });

  if (!record.provider_record_id) {
    /* We hold a record the registrar never gave us an id for — usually a row
       that predates a sync. A modify cannot address it upstream, and editing
       only our copy would put the app and the internet out of step. */
    return NextResponse.json({
      ok: false,
      error: "This record has no registrar id, so it cannot be changed upstream. Run a sync first to match it to the registrar's zone.",
    }, { status: 409 });
  }

  let body: unknown;
  try { body = await req.json(); } catch { body = null; }
  const parsed = PatchInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
    }, { status: 400 });
  }

  /* RC's modify replaces the whole record, so the unchanged fields have to be
     sent as they are. A PATCH that forwarded only the changed keys would blank
     the rest. */
  const merged = {
    type: parsed.data.type ?? (record.record_type as (typeof RC_DNS_TYPES)[number]),
    host: parsed.data.host ?? record.host,
    value: parsed.data.value ?? record.value,
    ttl: parsed.data.ttl ?? record.ttl,
    priority: parsed.data.priority ?? record.priority ?? undefined,
  };

  const wrote = await rcModifyDnsRecord(domain.domain_name, record.provider_record_id, merged);
  if (wrote.kind === "refused") return NextResponse.json({ ok: false, error: wrote.reason }, { status: 400 });
  if (wrote.kind === "hard_failure") return NextResponse.json({ ok: false, error: wrote.reason }, { status: 502 });

  const { data: updated, error } = await supabase
    .from("dns_records")
    .update({
      record_type: merged.type,
      host: merged.host,
      value: merged.value,
      ttl: wrote.ttlUsed ?? merged.ttl,
      priority: merged.priority ?? null,
    })
    .eq("id", record.id)
    .select("id, record_type, host, value, ttl, priority, provider_record_id")
    .maybeSingle();

  if (error || !updated) {
    console.error("[dns] changed upstream but the mirror update failed:", error?.message);
    return NextResponse.json({
      ok: true,
      warning: "The change was made at the registrar but this app's copy still shows the old values. Run a sync to pull the current zone.",
      record: null,
      ttl_used: wrote.ttlUsed ?? null,
    });
  }

  return NextResponse.json({ ok: true, record: updated, ttl_used: wrote.ttlUsed ?? null });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string; recordId: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });

  const { domain, record } = await load(supabase, params.id, params.recordId);
  if (!domain) return NextResponse.json({ ok: false, error: "No such domain." }, { status: 404 });
  if (!record) return NextResponse.json({ ok: false, error: "No such DNS record on this domain." }, { status: 404 });

  const authz = await authorizeDomainWrite(supabase, domain.tenant_id);
  if (!authz.ok) return NextResponse.json({ ok: false, error: authz.error }, { status: authz.status });

  if (record.provider_record_id) {
    const gone = await rcDeleteDnsRecord(domain.domain_name, record.provider_record_id, {
      type: record.record_type as (typeof RC_DNS_TYPES)[number],
      host: record.host,
      value: record.value,
    });
    /* `rcDeleteDnsRecord` already treats an already-absent record as done, so a
       hard_failure here means RC genuinely refused — and the mirror row stays,
       because removing it would hide a record that is still live. */
    if (gone.kind === "hard_failure") {
      return NextResponse.json({ ok: false, error: gone.reason }, { status: 502 });
    }
    if (gone.kind === "refused") {
      return NextResponse.json({ ok: false, error: gone.reason }, { status: 400 });
    }
  }
  /* No registrar id: nothing to delete upstream, and the row is a local stray.
     Removing it is then the correct repair rather than a risk. */

  const { error } = await supabase.from("dns_records").delete().eq("id", record.id);
  if (error) {
    console.error("[dns] deleted upstream but the mirror delete failed:", error.message);
    return NextResponse.json({
      ok: true,
      warning: "The record was deleted at the registrar but this app's copy still lists it. Run a sync to reconcile.",
    });
  }

  return NextResponse.json({ ok: true, deleted: record.id });
}
