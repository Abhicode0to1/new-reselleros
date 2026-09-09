/**
 * /assets/domains/:id — one domain, everything the desk needs to act on it.
 *
 * Three groups, in the order somebody troubleshooting reads them:
 *   1. what the REGISTRAR says (status, expiry, nameservers, locks) — the truth;
 *   2. what the MONEY says (the quote, the subscription, what was paid) — ours;
 *   3. the DNS zone, which is where the actual fixing happens.
 *
 * The registrar's expiry and the billing renewal date are shown side by side and
 * NOT reconciled here, because the migration keeps them apart on purpose: their
 * disagreement is the signal. `asset-sweep` flags a wide gap; this screen just
 * shows both numbers so a human can see which one looks wrong.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { daysUntil, expiryDisagreementDays, disagreementIsWorthFlagging } from "@/lib/domains/lifecycle";
import { DnsEditor, type DnsRecordView } from "./dns-editor";
import type { DomainAssetStatus } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";

type BadgeKind = "success" | "warning" | "danger" | "info" | "muted";

const STATUS: Record<DomainAssetStatus, { label: string; kind: BadgeKind }> = {
  active:          { label: "Active",          kind: "success" },
  pending:         { label: "Registering",     kind: "info"    },
  expiring_soon:   { label: "Expiring soon",   kind: "warning" },
  grace:           { label: "In grace period", kind: "danger"  },
  redemption:      { label: "Redemption",      kind: "danger"  },
  suspended:       { label: "Suspended",       kind: "danger"  },
  transferred_out: { label: "Transferred out", kind: "muted"   },
  failed:          { label: "Failed",          kind: "danger"  },
  cancelled:       { label: "Cancelled",       kind: "muted"   },
};

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-3xs uppercase tracking-wider text-ink-3">{label}</p>
      <div className="text-sm text-ink mt-0.5">{children}</div>
    </div>
  );
}

export default async function DomainDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient();

  const { data: domain } = await supabase
    .from("domains")
    .select(`
      id, tenant_id, domain_name, tld, status, registrar, registrar_order_id,
      registrar_customer_id, registrar_contact_id, registered_at, expires_at,
      registration_years, auto_renew, privacy_protection, transfer_lock, nameservers,
      subscription_id, quote_id, amount_paid, last_error, last_error_at,
      next_action_at, customer_id, customers ( name )
    `)
    .eq("id", params.id)
    .is("deleted_at", null)
    .maybeSingle();

  if (!domain) notFound();

  const [{ data: records }, { data: staff }, { data: sub }] = await Promise.all([
    supabase
      .from("dns_records")
      .select("id, record_type, host, value, ttl, priority, provider_record_id")
      .eq("domain_id", params.id)
      .order("record_type", { ascending: true })
      .order("host", { ascending: true }),
    /* Same test the API applies before it touches the registrar. Asked here so
       the editor is not rendered to somebody every button would refuse — a form
       that only fails on submit is worse than one that was never shown. */
    supabase.from("users").select("id, tenant_id").eq("tenant_id", domain.tenant_id).limit(1),
    domain.subscription_id
      ? supabase.from("subscriptions").select("id, renewal_date, status").eq("id", domain.subscription_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const s = STATUS[domain.status as DomainAssetStatus] ?? STATUS.pending;
  const days = domain.expires_at ? daysUntil(domain.expires_at) : null;
  const customer = (domain.customers as unknown as { name?: string } | null)?.name;
  const gap = expiryDisagreementDays(domain.expires_at, sub?.renewal_date ?? null);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1200px] mx-auto">
      <Link href={"/assets/domains" as never} className="inline-flex items-center min-h-[44px] text-2xs text-ink-3 hover:text-ink">← All domains</Link>

      <div className="mt-2 mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-serif text-3xl md:text-4xl leading-tight break-all">{domain.domain_name}</h1>
          <p className="text-sm text-ink-3 mt-1">
            {customer?.trim()
              ? <>Owned by <Link href={`/customers/${domain.customer_id}` as never} className="underline">{customer}</Link></>
              : "Customer unknown"}
          </p>
        </div>
        <Badge kind={s.kind} dot>{s.label}</Badge>
      </div>

      {domain.last_error && (
        <Card className="p-4 mb-5 border-rose/40 bg-rose-soft/30">
          <p className="text-3xs uppercase tracking-wider text-rose-ink font-semibold">Last upstream error</p>
          <p className="text-sm text-ink-2 mt-1">{domain.last_error}</p>
          {domain.last_error_at && (
            <p className="text-2xs text-ink-3 mt-1">{formatDate(domain.last_error_at)}</p>
          )}
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-2 mb-5">
        <Card className="p-5">
          <h2 className="font-serif text-lg mb-4">What the registrar says</h2>
          <div className="grid grid-cols-2 gap-4">
            <Fact label="Registrar">{domain.registrar}</Fact>
            <Fact label="Order id"><span className="font-mono text-2xs">{domain.registrar_order_id || "—"}</span></Fact>
            <Fact label="Registered">{domain.registered_at ? formatDate(domain.registered_at) : "—"}</Fact>
            <Fact label="Expires">
              {domain.expires_at ? (
                <>
                  {formatDate(domain.expires_at)}
                  {days !== null && (
                    <span className={`ml-2 text-2xs ${days < 0 ? "text-rose-ink" : days <= 30 ? "text-rose-ink" : days <= 60 ? "text-amber-ink" : "text-ink-3"}`}>
                      {days < 0 ? `${Math.abs(days)}d ago` : `${days}d`}
                    </span>
                  )}
                </>
              ) : <span className="text-ink-3">not confirmed yet</span>}
            </Fact>
            <Fact label="Transfer lock">{domain.transfer_lock ? "On" : <span className="text-amber-ink">Off</span>}</Fact>
            <Fact label="Privacy">{domain.privacy_protection ? "On" : "Off"}</Fact>
            <div className="col-span-2">
              <Fact label="Nameservers">
                {domain.nameservers?.length ? (
                  <ul className="font-mono text-2xs text-ink-2 space-y-0.5">
                    {domain.nameservers.map((ns: string) => <li key={ns} className="break-all">{ns}</li>)}
                  </ul>
                ) : <span className="text-ink-3">none recorded</span>}
              </Fact>
            </div>
            <div className="col-span-2">
              <Fact label="Registrant at the registrar">
                <span className="font-mono text-2xs text-ink-3">
                  customer {domain.registrar_customer_id || "—"} · contact {domain.registrar_contact_id || "—"}
                </span>
              </Fact>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="font-serif text-lg mb-4">What the money says</h2>
          <div className="grid grid-cols-2 gap-4">
            <Fact label="Paid">{domain.amount_paid !== null ? `₹${domain.amount_paid.toLocaleString("en-IN")}` : "—"}</Fact>
            <Fact label="Term">{domain.registration_years ? `${domain.registration_years} year${domain.registration_years > 1 ? "s" : ""}` : "—"}</Fact>
            <Fact label="Quote">
              {domain.quote_id ? <span className="font-mono text-2xs">{domain.quote_id}</span> : "—"}
            </Fact>
            <Fact label="Subscription">
              {sub ? <Link href={`/subscriptions?id=${sub.id}` as never} className="underline text-2xs">{sub.status}</Link> : <span className="text-ink-3">none linked</span>}
            </Fact>
            <Fact label="Billing renewal">{sub?.renewal_date ? formatDate(sub.renewal_date) : <span className="text-ink-3">—</span>}</Fact>
            <Fact label="Auto-renew">
              {/* Reads false on every row today, and that is migration 0063's
                  decision rather than a bug: there is no stored card, so nothing
                  can renew itself. */}
              {domain.auto_renew ? "On" : "Off"}
            </Fact>
          </div>

          {disagreementIsWorthFlagging(gap) && (
            <p className="mt-4 text-2xs text-ink-2 bg-amber-soft/30 border border-amber/40 rounded-md px-3 py-2">
              The registrar&apos;s expiry and the billing renewal date are <b>{Math.abs(gap as number)} days</b> apart.
              Neither is corrected automatically — one of them is wrong, and which one is a question about
              what was sold.
            </p>
          )}
        </Card>
      </div>

      <DnsEditor
        domainId={domain.id}
        domainName={domain.domain_name}
        initialRecords={(records ?? []) as DnsRecordView[]}
        canManage={(staff ?? []).length > 0}
        registrarLinked={!!domain.registrar_customer_id}
      />
    </div>
  );
}
