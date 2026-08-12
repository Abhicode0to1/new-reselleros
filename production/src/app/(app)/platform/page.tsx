/**
 * Platform › Signups — FOUNDER-ONLY view of every reseller that signed up for
 * ResellerOS. Cross-tenant, so it reads through /api/platform/signups (which
 * re-checks the founder allowlist server-side before using the admin client).
 * Displays Owner Name, Email ID, Phone Number, Sign Up date & status.
 */
"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { EmptyState } from "@/components/shared/empty-state";
import { formatDate } from "@/lib/utils";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";

type SignupRow = {
  id: string;
  name: string;
  owner: string;
  email: string | null;
  phone: string | null;
  signedUp: string;
  tier: string | null;
  gstin: string | null;
  state: string | null;
  activated: boolean;
  users: number;
  customers: number;
};

export default function PlatformSignupsPage() {
  const { data: me, isLoading: meLoading } = useCurrentUser();
  const [searchQuery, setSearchQuery] = React.useState("");

  const q = useQuery({
    queryKey: ["platform-signups"],
    enabled: Boolean(me?.isPlatformAdmin),
    queryFn: async (): Promise<{ count: number; tenants: SignupRow[] }> => {
      const res = await fetch("/api/platform/signups");
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? "Failed to load");
      return res.json();
    },
  });

  if (meLoading) return <div className="p-4 md:p-6 lg:p-8"><Skeleton className="h-40 w-full" /></div>;

  if (!me?.isPlatformAdmin) {
    return (
      <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
        <Card className="py-2">
          <EmptyState icon="lock" title="Not authorized" body="This founder view is limited to the ResellerOS platform owner." />
        </Card>
      </div>
    );
  }

  const allRows = q.data?.tenants ?? [];
  const activatedCount = allRows.filter((r) => r.activated).length;

  const filteredRows = allRows.filter((r) => {
    if (!searchQuery.trim()) return true;
    const s = searchQuery.toLowerCase().trim();
    return (
      r.name.toLowerCase().includes(s) ||
      r.owner.toLowerCase().includes(s) ||
      (r.email ?? "").toLowerCase().includes(s) ||
      (r.phone ?? "").toLowerCase().includes(s) ||
      (r.gstin ?? "").toLowerCase().includes(s)
    );
  });

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Platform Control</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Reseller Signups</h1>
          <p className="text-sm text-ink-3 mt-1">Every registered cloud reseller business on ResellerOS. Founder view.</p>
        </div>

        <div className="w-full sm:w-72">
          <Input
            placeholder="Search reseller name, email, phone..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-9 text-xs bg-paper"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
        <Card className="p-3">
          <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Total Resellers</div>
          <div className="font-serif text-2xl font-bold">{q.data ? q.data.count : "—"}</div>
        </Card>
        <Card className="p-3">
          <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Activated Workspaces</div>
          <div className="font-serif text-2xl font-bold text-emerald">{q.data ? activatedCount : "—"}</div>
        </Card>
        <Card className="p-3">
          <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Setup Pending</div>
          <div className="font-serif text-2xl font-bold text-amber-dark">{q.data ? q.data.count - activatedCount : "—"}</div>
        </Card>
      </div>

      {q.isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : q.isError ? (
        <Card className="py-2"><EmptyState icon="alert" title="Could not load signups" body={(q.error as Error)?.message ?? "Try again."} /></Card>
      ) : filteredRows.length === 0 ? (
        <Card className="py-2"><EmptyState icon="users" title="No signups found" body="No registered reseller matches your search." /></Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-paper-2/50 text-[10px] uppercase tracking-wider text-ink-3 font-semibold">
              <tr>
                <th className="text-left px-4 py-3">Business</th>
                <th className="text-left px-4 py-3">Owner Contact</th>
                <th className="text-left px-4 py-3">Phone</th>
                <th className="text-left px-4 py-3 whitespace-nowrap">Signed Up</th>
                <th className="text-left px-4 py-3">Tier</th>
                <th className="text-right px-4 py-3">Users</th>
                <th className="text-right px-4 py-3">Customers</th>
                <th className="text-left px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {filteredRows.map((t) => (
                <tr key={t.id} className="hover:bg-paper-2/40">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-ink">{t.name}</div>
                    {t.gstin && (
                      <div className="font-mono text-[11px] text-ink-3">
                        {t.gstin}{t.state ? ` · ${t.state}` : ""}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-ink-2">{t.owner}</div>
                    {t.email ? (
                      <a
                        href={`mailto:${t.email}`}
                        className="text-xs text-amber-dark hover:underline flex items-center gap-1 mt-0.5"
                      >
                        <Icon name="mail" size={12} />
                        <span>{t.email}</span>
                      </a>
                    ) : (
                      <span className="text-xs text-ink-3">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {t.phone ? (
                      <a
                        href={`tel:${t.phone}`}
                        className="font-mono text-xs text-ink-2 hover:text-amber flex items-center gap-1"
                      >
                        <Icon name="phone" size={12} />
                        <span>{t.phone}</span>
                      </a>
                    ) : (
                      <span className="text-xs text-ink-3">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-ink-2 whitespace-nowrap text-xs">
                    {formatDate(t.signedUp, "short")}
                  </td>
                  <td className="px-4 py-3">
                    <Badge kind={t.tier === "distributor" ? "info" : "muted"} size="sm">
                      {t.tier ?? "reseller"}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-xs font-medium">{t.users}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-xs font-medium">{t.customers}</td>
                  <td className="px-4 py-3">
                    {t.activated ? (
                      <Badge kind="success" size="sm" dot>Activated</Badge>
                    ) : (
                      <Badge kind="warning" size="sm" dot>Setup Pending</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
