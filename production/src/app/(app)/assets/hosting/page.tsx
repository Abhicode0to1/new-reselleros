/**
 * /assets/hosting — the staff view of every hosting account this tenant runs.
 *
 * The sibling of /assets/domains, and NOT at /hosting for the same reason that
 * one is not at /domains: both of those are public marketing landing pages, and
 * Next resolves the route groups to the same URL.
 *
 * ─── THE ONE THING THIS SCREEN HAS TO GET RIGHT ──────────────────────────────
 * A TRIAL COUNTS DOWN TO `trial_ends_at` AND A PAID ACCOUNT TO `expires_at`.
 * Reading the wrong column tells a trial customer they have a year — the same
 * trap `lib/domains/lifecycle.ts` documents for the sweep, and the same one the
 * customer portal's hosting page avoids. There is one `endsAt()` here and every
 * column goes through it.
 *
 * ─── WHY last_error_kind IS A COLUMN ─────────────────────────────────────────
 * Because the three values mean three different jobs, and a desk that only sees
 * "failed" does the wrong one:
 *   · `server_unreachable`   — wait, or check the box. The order is fine.
 *   · `collision_exhausted`  — the username generator ran out of variants; needs
 *                              a human to pick one.
 *   · `hard_failure`         — DirectAdmin refused outright. Read the message.
 */
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
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

/** What the desk should do about it, not what went wrong. */
const ERROR_KIND: Record<string, string> = {
  server_unreachable: "server unreachable — the order is fine, retry",
  collision_exhausted: "username collisions exhausted — pick one by hand",
  hard_failure: "DirectAdmin refused — read the message",
};

type Row = {
  id: string; domain_name: string; status: string; plan_name: string | null;
  da_username: string | null; is_trial: boolean; trial_ends_at: string | null;
  expires_at: string | null; last_error: string | null; last_error_kind: string | null;
  customer_id: string; customers: unknown;
};

/** The ONE place the trial/paid distinction is made. */
function endsAt(r: Pick<Row, "is_trial" | "trial_ends_at" | "expires_at">): string | null {
  return r.is_trial ? r.trial_ends_at : r.expires_at;
}

function ends(r: Row): { text: string; tone: string } {
  const at = endsAt(r);
  if (!at) return { text: "—", tone: "text-ink-3" };
  const days = daysUntil(at);
  const what = r.is_trial ? "Trial ended" : "Expired";
  if (days < 0)   return { text: `${what} ${Math.abs(days)}d ago`, tone: "text-rose-ink font-medium" };
  if (days === 0) return { text: r.is_trial ? "Trial ends today" : "Expires today", tone: "text-rose-ink font-medium" };
  if (days <= 14) return { text: `${days}d left`, tone: "text-rose-ink font-medium" };
  if (days <= 45) return { text: `${days}d left`, tone: "text-amber-ink font-medium" };
  return { text: formatDate(at), tone: "text-ink-2" };
}

export default async function HostingPage() {
  const supabase = createClient();

  const { data } = await supabase
    .from("hosting_accounts")
    .select("id, domain_name, status, plan_name, da_username, is_trial, trial_ends_at, expires_at, last_error, last_error_kind, customer_id, customers ( name )")
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  const rows = (data ?? []) as unknown as Row[];

  /* Ordered by what ends soonest, computed AFTER the query because the deadline
     lives in one of two columns and no single `order by` can pick between them. */
  const sorted = [...rows].sort((a, b) => {
    const A = endsAt(a), B = endsAt(b);
    if (!A && !B) return 0;
    if (!A) return 1;
    if (!B) return -1;
    return new Date(A).getTime() - new Date(B).getTime();
  });

  const endingSoon = sorted.filter((r) => {
    const at = endsAt(r);
    return at !== null && daysUntil(at) <= 14 && r.status !== "terminated";
  }).length;
  const stuck = sorted.filter((r) => r.status === "failed" || !!r.last_error).length;
  const trials = sorted.filter((r) => r.is_trial && r.status === "active").length;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      <div className="mb-6">
        <h1 className="font-serif text-3xl md:text-4xl leading-tight">Hosting</h1>
        <p className="text-sm text-ink-3 mt-1">
          Every hosting account on this tenant, what the server says about it, and when it runs out.
        </p>
      </div>

      {(endingSoon > 0 || stuck > 0 || trials > 0) && (
        <div className="flex flex-wrap gap-3 mb-5">
          {endingSoon > 0 && (
            <Card className="px-4 py-3 border-rose/40 bg-rose-soft/30">
              <p className="text-sm text-ink-2"><b>{endingSoon}</b> {endingSoon === 1 ? "account ends" : "accounts end"} within 14 days</p>
            </Card>
          )}
          {stuck > 0 && (
            <Card className="px-4 py-3 border-amber/40 bg-amber-soft/30">
              <p className="text-sm text-ink-2"><b>{stuck}</b> {stuck === 1 ? "account carries" : "accounts carry"} a provisioning error</p>
            </Card>
          )}
          {trials > 0 && (
            <Card className="px-4 py-3">
              <p className="text-sm text-ink-2"><b>{trials}</b> live {trials === 1 ? "trial" : "trials"}</p>
            </Card>
          )}
        </div>
      )}

      {sorted.length === 0 ? (
        <EmptyState
          title="No hosting accounts yet"
          description="An account appears here once a paid order or a trial reaches the server. Until then it sits in the provisioning queue."
        />
      ) : (
        <>
          {/* Phone: cards. Built with the table rather than after it — the domains
              list next door shipped table-only and dropped its two most useful
              columns off the right edge at 375px. §20. */}
          <ul className="md:hidden space-y-3">
            {sorted.map((r) => {
              const s = STATUS[r.status as HostingAccountStatus] ?? STATUS.pending;
              const e = ends(r);
              const customer = (r.customers as { name?: string } | null)?.name;
              return (
                <li key={r.id}>
                  <Card className="p-4">
                    <Link href={`/assets/hosting/${r.id}` as never} className="flex items-start justify-between gap-3 min-h-[44px]">
                      <span className="font-mono text-sm text-ink break-all underline decoration-hairline">{r.domain_name}</span>
                      <span className="flex flex-col items-end gap-1 flex-shrink-0">
                        {r.is_trial && <Badge kind="info">Trial</Badge>}
                        <Badge kind={s.kind} dot>{s.label}</Badge>
                      </span>
                    </Link>
                    <div className="mt-3 flex items-end justify-between gap-3">
                      <div>
                        <p className="text-3xs uppercase tracking-wider text-ink-3">{r.is_trial ? "Trial ends" : "Renews"}</p>
                        <p className={`text-sm ${e.tone}`}>{e.text}</p>
                      </div>
                      <p className="text-2xs text-ink-3 text-right">
                        {customer?.trim() || <span className="italic">customer unknown</span>}
                      </p>
                    </div>
                    {r.last_error && (
                      <p className="mt-3 text-2xs text-rose-ink border-t border-hairline pt-2">
                        {r.last_error_kind ? <b>{ERROR_KIND[r.last_error_kind] ?? r.last_error_kind}. </b> : null}
                        {r.last_error}
                      </p>
                    )}
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
                    <th className="text-left px-4 py-3">Customer</th>
                    <th className="text-left px-4 py-3">Status</th>
                    <th className="text-left px-4 py-3">Ends</th>
                    <th className="text-left px-4 py-3">Plan</th>
                    <th className="text-left px-4 py-3">cPanel user</th>
                    <th className="text-left px-4 py-3">Problem</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {sorted.map((r) => {
                    const s = STATUS[r.status as HostingAccountStatus] ?? STATUS.pending;
                    const e = ends(r);
                    const customer = (r.customers as { name?: string } | null)?.name;
                    return (
                      <tr key={r.id} className="hover:bg-paper-2/40">
                        <td className="px-4">
                          {/* Padding on the link so the tap area is the row height. */}
                          <Link href={`/assets/hosting/${r.id}` as never} className="flex items-center min-h-[44px] font-mono text-ink hover:text-amber-ink underline decoration-hairline">
                            {r.domain_name}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-ink-2">{customer?.trim() || <span className="text-ink-3 italic">unknown</span>}</td>
                        <td className="px-4 py-3">
                          <span className="flex items-center gap-1.5">
                            {r.is_trial && <Badge kind="info">Trial</Badge>}
                            <Badge kind={s.kind} dot>{s.label}</Badge>
                          </span>
                        </td>
                        <td className={`px-4 py-3 ${e.tone}`}>{e.text}</td>
                        <td className="px-4 py-3 text-ink-3">{r.plan_name || "—"}</td>
                        <td className="px-4 py-3 font-mono text-2xs text-ink-3">{r.da_username || "—"}</td>
                        <td className="px-4 py-3 text-2xs max-w-[20rem]">
                          {r.last_error ? (
                            <span className="text-rose-ink line-clamp-2" title={r.last_error}>
                              {r.last_error_kind ? ERROR_KIND[r.last_error_kind] ?? r.last_error_kind : r.last_error}
                            </span>
                          ) : <span className="text-ink-3">—</span>}
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
    </div>
  );
}
