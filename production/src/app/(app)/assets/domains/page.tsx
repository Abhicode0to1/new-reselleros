/**
 * /assets/domains — the staff view of every domain this tenant holds.
 *
 * NOT /domains: that path is the PUBLIC marketing landing page (as is /hosting),
 * and Next resolves both route groups to the same URL — so putting it there is a
 * build error rather than a matter of taste. Found by doing it. /assets/* also
 * leaves room for the hosting equivalent to sit beside this one.
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The `domains` table, its RLS, the registrar write path and the customer's
 * read-only portal page all shipped before any staff screen did — so the people
 * who actually have to act on a lapsing domain had nowhere to look. The customer
 * could see their own domains and the desk could not see anybody's.
 *
 * ─── HOW THIS DIFFERS FROM /portal/domains ───────────────────────────────────
 * Same table, different job, so deliberately not the same columns. The portal
 * answers one question — "is anything of mine about to lapse?" — and hides
 * everything operational. This screen is where somebody fixes things, so it
 * carries the parts the customer must never be shown a raw version of: which
 * customer owns it, the registrar order id, and the last upstream error. A
 * failed provisioning attempt is invisible on the portal by design; here it is
 * the most useful column on the page.
 */
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate } from "@/lib/utils";
import { daysUntil } from "@/lib/domains/lifecycle";
import type { DomainAssetStatus } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";

type BadgeKind = "success" | "warning" | "danger" | "info" | "muted";

/**
 * The registrar's word, in ours. Same vocabulary as the portal's version on
 * purpose — a domain described as "In grace period" to the customer must not be
 * "Expired" to the person they are talking to.
 */
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

function renews(expiresAt: string | null): { text: string; tone: string } {
  if (!expiresAt) return { text: "—", tone: "text-ink-3" };
  const days = daysUntil(expiresAt);
  if (days < 0)   return { text: `Expired ${Math.abs(days)}d ago`, tone: "text-rose-ink font-medium" };
  if (days === 0) return { text: "Expires today",                 tone: "text-rose-ink font-medium" };
  if (days <= 30) return { text: `${days}d left`,                 tone: "text-rose-ink font-medium" };
  if (days <= 60) return { text: `${days}d left`,                 tone: "text-amber-ink font-medium" };
  return { text: formatDate(expiresAt), tone: "text-ink-2" };
}

export default async function DomainsPage() {
  const supabase = createClient();

  /* RLS scopes this to the caller's tenant — no tenant_id filter here, one
     definition of "yours", and it lives in the database. */
  const { data } = await supabase
    .from("domains")
    .select("id, domain_name, status, expires_at, registrar_order_id, last_error, customer_id, customers ( name )")
    .is("deleted_at", null)
    .order("expires_at", { ascending: true, nullsFirst: false });

  const rows = data ?? [];

  /* Two counts worth having above the table, because they are the two reasons
     somebody opens this screen. */
  const lapsing = rows.filter((d) => {
    const days = d.expires_at ? daysUntil(d.expires_at) : null;
    return days !== null && days <= 30 && d.status !== "cancelled" && d.status !== "transferred_out";
  }).length;
  const stuck = rows.filter((d) => d.status === "failed" || !!d.last_error).length;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      <div className="mb-6">
        <h1 className="font-serif text-3xl md:text-4xl leading-tight">Domains</h1>
        <p className="text-sm text-ink-3 mt-1">
          Every domain registered on this account, what the registrar says about it, and where its DNS points.
        </p>
      </div>

      {(lapsing > 0 || stuck > 0) && (
        <div className="flex flex-wrap gap-3 mb-5">
          {lapsing > 0 && (
            <Card className="px-4 py-3 border-rose/40 bg-rose-soft/30">
              <p className="text-sm text-ink-2">
                <b>{lapsing}</b> {lapsing === 1 ? "domain expires" : "domains expire"} within 30 days
              </p>
            </Card>
          )}
          {stuck > 0 && (
            <Card className="px-4 py-3 border-amber/40 bg-amber-soft/30">
              <p className="text-sm text-ink-2">
                <b>{stuck}</b> {stuck === 1 ? "domain carries" : "domains carry"} an upstream error
              </p>
            </Card>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title="No domains yet"
          description="A domain appears here once a paid order reaches the registrar. Until then it sits in the provisioning queue."
        />
      ) : (
        <Card className="overflow-hidden">
          {/* Wide content scrolls inside its own container, never the page. */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                <tr>
                  <th className="text-left px-4 py-3">Domain</th>
                  <th className="text-left px-4 py-3">Customer</th>
                  <th className="text-left px-4 py-3">Status</th>
                  <th className="text-left px-4 py-3">Renews</th>
                  <th className="text-left px-4 py-3">Order id</th>
                  <th className="text-left px-4 py-3">Last error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {rows.map((d) => {
                  const s = STATUS[d.status as DomainAssetStatus] ?? STATUS.pending;
                  const r = renews(d.expires_at);
                  const customer = (d.customers as unknown as { name?: string } | null)?.name;
                  return (
                    <tr key={d.id} className="hover:bg-paper-2/40">
                      {/* Padding on the LINK, not the cell, so the tap area is the row
                          height rather than the 18px of text inside it — CLAUDE.md:605
                          (§20) asks for 44px, and padding a parent does not grow a
                          child's hit area. Measured: 18px before, 44 after. */}
                      <td className="px-4">
                        <Link
                          href={`/assets/domains/${d.id}` as never}
                          className="flex items-center min-h-[44px] font-mono text-ink hover:text-amber-ink underline decoration-hairline"
                        >
                          {d.domain_name}
                        </Link>
                      </td>
                      {/* The customer's name can be blank on a real record, so say
                          "unknown" rather than leaving the cell empty and letting
                          the row lose whose it is. */}
                      <td className="px-4 py-3 text-ink-2">{customer?.trim() || <span className="text-ink-3 italic">unknown</span>}</td>
                      <td className="px-4 py-3"><Badge kind={s.kind} dot>{s.label}</Badge></td>
                      <td className={`px-4 py-3 ${r.tone}`}>{r.text}</td>
                      <td className="px-4 py-3 font-mono text-2xs text-ink-3">{d.registrar_order_id || "—"}</td>
                      {/* Truncated with a title, because the full reason is often a
                          paragraph from ResellerClub and the row still has to be
                          readable. */}
                      <td className="px-4 py-3 text-2xs text-rose-ink max-w-[22rem]">
                        {d.last_error ? <span className="line-clamp-2" title={d.last_error}>{d.last_error}</span> : <span className="text-ink-3">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
