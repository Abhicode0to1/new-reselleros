/**
 * /portal/domains — the domains this customer owns.
 *
 * Until migration 20260908100000 there was nothing to put on this page: a
 * registered domain was not recorded anywhere a customer could be shown it. It
 * reads `domains`, which is the REGISTRAR's truth (what exists, and when it
 * expires up there) — not the billing schedule, which lives on `subscriptions`.
 *
 * ─── WHAT THIS PAGE IS FOR ───────────────────────────────────────────────────
 * One question, above all others: **is anything about to lapse?** A domain that
 * expires is released and can be taken by anybody, and unlike a lapsed seat it
 * cannot be bought back at the old price — sometimes not at all. So expiry is
 * the loudest thing here, sorted first, and stated in days rather than a date
 * the reader has to subtract from today.
 *
 * ─── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 * There is no auto-renew toggle. That is migration 0063's decision, not an
 * omission: with no stored-card autopay, a switch marked "auto-renew" promises
 * a charge that cannot happen, and a customer who trusts it loses the name.
 * Renewal is a conversation, so the page routes to one.
 */
import Link from "next/link";
import { requirePortalSession } from "@/lib/portal/session";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate, daysBetween } from "@/lib/utils";
import type { DomainAssetStatus } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";

type BadgeKind = "success" | "warning" | "danger" | "info" | "muted";

/**
 * How the registrar's word is shown. `grace` and `redemption` are ICANN states
 * with a deadline and a fee attached — collapsing them into "expired" would
 * hide the one fact that matters, which is that the name can still be saved.
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

/** Days to expiry as a phrase, with the urgency it deserves. */
function expiry(expiresAt: string | null): { text: string; kind: BadgeKind; days: number | null } {
  if (!expiresAt) return { text: "—", kind: "muted", days: null };
  const days = daysBetween(new Date(), expiresAt);
  if (days < 0)  return { text: `Expired ${Math.abs(days)}d ago`, kind: "danger",  days };
  if (days === 0) return { text: "Expires today",                 kind: "danger",  days };
  if (days <= 30) return { text: `${days}d left`,                 kind: "danger",  days };
  if (days <= 60) return { text: `${days}d left`,                 kind: "warning", days };
  return { text: formatDate(expiresAt), kind: "muted", days };
}

export default async function PortalDomainsPage() {
  const session  = await requirePortalSession();
  const reseller = session.tenantContactName ?? session.tenantName;
  const supabase = createClient();

  /* RLS scopes this to the signed-in customer (policy
     `domains_select_own_customer`), so there is no customer_id filter here —
     one definition of "yours", and it lives in the database. */
  const { data } = await supabase
    .from("domains")
    .select("id, domain_name, status, expires_at, registered_at, auto_renew, nameservers, privacy_protection, registration_years")
    .order("expires_at", { ascending: true, nullsFirst: false });

  const rows = data ?? [];
  const urgent = rows.filter((d) => {
    const e = expiry(d.expires_at);
    return e.days !== null && e.days <= 30 && d.status !== "cancelled" && d.status !== "transferred_out";
  });

  return (
    <div className="max-w-[1080px] mx-auto px-6 py-8">
      <div className="mb-6">
        <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Your Domains</h1>
        <p className="text-sm text-ink-3 mt-1">
          Every domain registered on your account, and when each one is due to renew.
        </p>
      </div>

      {/* The one thing worth interrupting for. §24: says what, why, and where to go. */}
      {urgent.length > 0 && (
        <Card className="p-4 mb-6 border-rose/40 bg-rose-soft/30">
          <p className="text-sm text-ink-2">
            <b>{urgent.length === 1 ? "1 domain expires" : `${urgent.length} domains expire`} within 30 days.</b>{" "}
            A domain that lapses is released and someone else can register it.{" "}
            <Link href="/portal/support/new" className="text-rose-ink underline">
              Ask {reseller} to renew →
            </Link>
          </p>
        </Card>
      )}

      {rows.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-ink-3">
            No domains on your account yet. A domain you buy appears here within a few
            minutes of the payment clearing.
          </p>
          <Link href="/portal/shop" className="inline-block mt-4 text-sm text-amber-ink underline">
            Search for a domain →
          </Link>
        </Card>
      ) : (
        <>
          {/* Phone: card list (§20 — the portal is a phone-first surface). */}
          <ul className="md:hidden space-y-3">
            {rows.map((d) => {
              const e = expiry(d.expires_at);
              const s = STATUS[d.status] ?? STATUS.pending;
              return (
                <li key={d.id}>
                  <Card className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <p className="font-mono text-sm text-ink break-all">{d.domain_name}</p>
                      <Badge kind={s.kind} dot>{s.label}</Badge>
                    </div>
                    <div className="mt-3 flex items-end justify-between gap-3">
                      <div>
                        <p className="text-3xs uppercase tracking-wider text-ink-3">Renews</p>
                        <p className={`text-sm font-medium ${e.kind === "danger" ? "text-rose-ink" : e.kind === "warning" ? "text-amber-ink" : "text-ink-2"}`}>
                          {e.text}
                        </p>
                      </div>
                      <p className="text-2xs text-ink-3">
                        {d.expires_at ? formatDate(d.expires_at) : "date not confirmed"}
                      </p>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>

          <Card className="overflow-hidden hidden md:block">
            {/* Wide content scrolls inside its own container, never the page. */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                  <tr>
                    <th className="text-left px-4 py-3">Domain</th>
                    <th className="text-left px-4 py-3">Status</th>
                    <th className="text-left px-4 py-3">Renews</th>
                    <th className="text-left px-4 py-3">Expiry date</th>
                    <th className="text-left px-4 py-3">Privacy</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {rows.map((d) => {
                    const e = expiry(d.expires_at);
                    const s = STATUS[d.status] ?? STATUS.pending;
                    return (
                      <tr key={d.id} className="hover:bg-paper-2/40">
                        <td className="px-4 py-3 font-mono text-ink">{d.domain_name}</td>
                        <td className="px-4 py-3"><Badge kind={s.kind} dot>{s.label}</Badge></td>
                        <td className={`px-4 py-3 font-medium ${e.kind === "danger" ? "text-rose-ink" : e.kind === "warning" ? "text-amber-ink" : "text-ink-2"}`}>
                          {e.text}
                        </td>
                        <td className="px-4 py-3 text-ink-3">
                          {d.expires_at ? formatDate(d.expires_at) : "not confirmed yet"}
                        </td>
                        <td className="px-4 py-3 text-ink-3">
                          {d.privacy_protection ? "On" : "Off"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {rows.length > 0 && (
        <p className="mt-4 text-2xs text-ink-3">
          Renewals are handled by {reseller} — there is no card stored on your account, so
          nothing is charged automatically.{" "}
          <Link href="/portal/support/new" className="underline">Raise a request</Link> to renew,
          transfer, or change where a domain points.
        </p>
      )}
    </div>
  );
}
