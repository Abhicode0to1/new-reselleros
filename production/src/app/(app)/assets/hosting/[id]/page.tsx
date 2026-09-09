/**
 * /assets/hosting/:id — one hosting account, everything the desk needs on it.
 *
 * Same three-group shape as the domain detail page — what the SERVER says, what
 * the MONEY says, then the problem — because somebody troubleshooting reads them
 * in that order.
 *
 * ─── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────────
 * There is no DNS editor here, and no suspend/unsuspend button, and neither is
 * an oversight:
 *
 *   · DNS. DirectAdmin's zone API needs per-user impersonation auth
 *     (`ADMIN_USER|username`) which `lib/directadmin/` does not have yet, so the
 *     module is unported. A domain's DNS is editable at /assets/domains/:id
 *     because ResellerClub holds that zone; a hosting account's is not, and
 *     showing a disabled editor would only imply one exists.
 *   · Suspend / terminate. `daSuspendAccount` and `daDeleteAccount` DO exist, and
 *     that is precisely why they are not wired to a button yet: terminating a
 *     hosting account destroys a customer's site and mailboxes, so it wants a
 *     confirmation flow and an audit trail somebody has agreed to, not a click
 *     that happened to be easy to add while building a read screen.
 *
 * `last_synced_at` is shown because everything in the server column is a copy.
 * If nothing has ever synced it, the honest thing is to say so rather than let
 * the reader assume the quotas are live.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { daysUntil } from "@/lib/domains/lifecycle";
import type { HostingAccountStatus } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";

type BadgeKind = "success" | "warning" | "danger" | "info" | "muted";

const STATUS: Record<HostingAccountStatus, { label: string; kind: BadgeKind }> = {
  active:     { label: "Active",       kind: "success" },
  pending:    { label: "Provisioning", kind: "info"    },
  suspended:  { label: "Suspended",    kind: "danger"  },
  expired:    { label: "Expired",      kind: "danger"  },
  terminated: { label: "Terminated",   kind: "muted"   },
  failed:     { label: "Failed",       kind: "danger"  },
};

const ERROR_KIND: Record<string, string> = {
  server_unreachable: "The server could not be reached. The order itself is fine — retry.",
  collision_exhausted: "The username generator ran out of variants. Somebody needs to pick one by hand.",
  hard_failure: "DirectAdmin refused the request outright. The message below is its reason.",
};

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-3xs uppercase tracking-wider text-ink-3">{label}</p>
      <div className="text-sm text-ink mt-0.5">{children}</div>
    </div>
  );
}

/** MB as somebody would say it out loud. */
function quota(mb: number | null): string {
  if (mb === null || mb === undefined) return "—";
  if (mb === 0) return "unlimited";
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB`;
  return `${mb} MB`;
}

export default async function HostingDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient();

  const { data: h } = await supabase
    .from("hosting_accounts")
    .select(`
      id, tenant_id, domain_name, status, server, da_username, da_package, ip_address,
      nameservers, disk_quota_mb, bandwidth_quota_mb, plan_code, plan_name, is_trial,
      trial_ends_at, started_at, expires_at, suspended_at, auto_renew, subscription_id,
      quote_id, amount_paid, last_error, last_error_at, last_error_kind, last_synced_at,
      customer_id, customers ( name )
    `)
    .eq("id", params.id)
    .is("deleted_at", null)
    .maybeSingle();

  if (!h) notFound();

  const { data: sub } = h.subscription_id
    ? await supabase.from("subscriptions").select("id, renewal_date, status").eq("id", h.subscription_id).maybeSingle()
    : { data: null };

  const s = STATUS[h.status as HostingAccountStatus] ?? STATUS.pending;
  /* The trial/paid distinction again — see the list page's header. */
  const deadline = h.is_trial ? h.trial_ends_at : h.expires_at;
  const days = deadline ? daysUntil(deadline) : null;
  const customer = (h.customers as unknown as { name?: string } | null)?.name;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1200px] mx-auto">
      {/* min-h-[44px]: measured 13px, and a standalone back link is not the
          inline-in-a-sentence case WCAG 2.5.8 exempts — the customer link below
          is, and is left alone. CLAUDE.md:605. */}
      <Link href={"/assets/hosting" as never} className="inline-flex items-center min-h-[44px] text-2xs text-ink-3 hover:text-ink">← All hosting</Link>

      <div className="mt-2 mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-serif text-3xl md:text-4xl leading-tight break-all">{h.domain_name}</h1>
          <p className="text-sm text-ink-3 mt-1">
            {customer?.trim()
              ? <>Owned by <Link href={`/customers/${h.customer_id}` as never} className="underline">{customer}</Link></>
              : "Customer unknown"}
          </p>
        </div>
        <span className="flex items-center gap-2">
          {h.is_trial && <Badge kind="info">Free trial</Badge>}
          <Badge kind={s.kind} dot>{s.label}</Badge>
        </span>
      </div>

      {h.last_error && (
        <Card className="p-4 mb-5 border-rose/40 bg-rose-soft/30">
          <p className="text-3xs uppercase tracking-wider text-rose-ink font-semibold">Provisioning problem</p>
          {h.last_error_kind && (
            <p className="text-sm text-ink font-medium mt-1">
              {ERROR_KIND[h.last_error_kind] ?? h.last_error_kind}
            </p>
          )}
          <p className="text-sm text-ink-2 mt-1">{h.last_error}</p>
          {h.last_error_at && <p className="text-2xs text-ink-3 mt-1">{formatDate(h.last_error_at)}</p>}
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-2 mb-5">
        <Card className="p-5">
          <h2 className="font-serif text-lg mb-4">What the server says</h2>
          <div className="grid grid-cols-2 gap-4">
            <Fact label="Server">{h.server || "—"}</Fact>
            <Fact label="cPanel user"><span className="font-mono text-2xs">{h.da_username || "—"}</span></Fact>
            <Fact label="Package"><span className="font-mono text-2xs">{h.da_package || "—"}</span></Fact>
            <Fact label="IP"><span className="font-mono text-2xs">{h.ip_address ? String(h.ip_address) : "—"}</span></Fact>
            <Fact label="Disk">{quota(h.disk_quota_mb)}</Fact>
            <Fact label="Bandwidth">{quota(h.bandwidth_quota_mb)}</Fact>
            <Fact label="Started">{h.started_at ? formatDate(h.started_at) : "—"}</Fact>
            <Fact label={h.is_trial ? "Trial ends" : "Expires"}>
              {deadline ? (
                <>
                  {formatDate(deadline)}
                  {days !== null && (
                    <span className={`ml-2 text-2xs ${days < 0 || days <= 14 ? "text-rose-ink" : days <= 45 ? "text-amber-ink" : "text-ink-3"}`}>
                      {days < 0 ? `${Math.abs(days)}d ago` : `${days}d`}
                    </span>
                  )}
                </>
              ) : <span className="text-ink-3">not set</span>}
            </Fact>
            {h.suspended_at && (
              <div className="col-span-2"><Fact label="Suspended">{formatDate(h.suspended_at)}</Fact></div>
            )}
            <div className="col-span-2">
              <Fact label="Nameservers">
                {h.nameservers?.length ? (
                  <ul className="font-mono text-2xs text-ink-2 space-y-0.5">
                    {h.nameservers.map((ns: string) => <li key={ns} className="break-all">{ns}</li>)}
                  </ul>
                ) : <span className="text-ink-3">none recorded</span>}
              </Fact>
            </div>
            <div className="col-span-2">
              <Fact label="Last synced from the server">
                {/* Everything above is a copy. Saying "never" is the difference
                    between a stale number and a number nobody has ever checked. */}
                {h.last_synced_at
                  ? formatDate(h.last_synced_at)
                  : <span className="text-amber-ink">never — these values are as provisioning left them</span>}
              </Fact>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="font-serif text-lg mb-4">What the money says</h2>
          <div className="grid grid-cols-2 gap-4">
            <Fact label="Paid">{h.amount_paid !== null ? `₹${h.amount_paid.toLocaleString("en-IN")}` : h.is_trial ? "trial — nothing paid" : "—"}</Fact>
            <Fact label="Plan">{h.plan_name || "—"}</Fact>
            <Fact label="Quote">{h.quote_id ? <span className="font-mono text-2xs">{h.quote_id}</span> : "—"}</Fact>
            <Fact label="Subscription">
              {sub ? <Link href={`/subscriptions?id=${sub.id}` as never} className="underline text-2xs">{sub.status}</Link> : <span className="text-ink-3">none linked</span>}
            </Fact>
            <Fact label="Billing renewal">{sub?.renewal_date ? formatDate(sub.renewal_date) : <span className="text-ink-3">—</span>}</Fact>
            <Fact label="Auto-renew">{h.auto_renew ? "On" : "Off"}</Fact>
          </div>

          {h.is_trial && (
            <p className="mt-4 text-2xs text-ink-2 bg-paper-2/60 border border-hairline rounded-md px-3 py-2">
              A trial counts down to its own date, not to an expiry — so the figure above is
              <b> trial_ends_at</b>. Reading the other column would tell this customer they have a year.
            </p>
          )}
        </Card>
      </div>

      <Card className="p-5">
        <h2 className="font-serif text-lg mb-2">DNS and server actions</h2>
        <p className="text-sm text-ink-3">
          Not available from here yet. A domain&apos;s DNS is editable at its own page when
          ResellerClub holds the zone; a hosting account&apos;s zone lives on DirectAdmin, whose API
          needs per-user authentication this app does not have yet. Suspend and terminate exist in
          the code and are deliberately not wired to a button — destroying a customer&apos;s site and
          mailboxes should not be one click away from a read-only screen.
        </p>
      </Card>
    </div>
  );
}
