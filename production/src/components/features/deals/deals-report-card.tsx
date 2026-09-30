/**
 * Reports hub — "Deals" card: win rate, average won deal, days to close, per-owner table.
 *
 * Numbers: lib/deals/pipeline-summary.ts (dealReport) over deals DECIDED in the last 90 IST
 * days. A figure with nothing behind it shows "—", never 0 (a 0% win rate is a claim).
 * Renders nothing for roles that cannot open /deals.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { Card } from "@/components/ui/card";
import { KPI } from "@/components/shared/kpi";
import { Skeleton } from "@/components/ui/skeleton";
import { useDealRows } from "@/lib/queries/deals";
import { useTeamMembers, memberLabel } from "@/lib/queries/team";
import { dealReport, REPORT_WINDOW_DAYS } from "@/lib/deals/pipeline-summary";
import { canSeeDeals } from "@/lib/deals/access";
import { formatIstDate } from "@/lib/dates/ist";
import { rupee } from "@/lib/utils";

export function DealsReportCard({ role }: { role: string | null | undefined }) {
  const allowed = canSeeDeals(role);
  const { data, isLoading, error } = useDealRows(allowed);
  const { data: members } = useTeamMembers();
  const report = React.useMemo(() => (data ? dealReport(data) : null), [data]);
  if (!allowed) return null;

  const nameOf = (id: string | null) => {
    if (id === null) return "Unassigned";
    const m = members?.find((x) => x.id === id);
    return m ? memberLabel(m) : "Purana teammate";
  };

  return (
    <Card className="p-5 mb-4">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <p className="text-sm font-semibold text-ink leading-tight">Deals</p>
          <p className="text-xs text-ink-3 mt-0.5">
            Pichhle {REPORT_WINDOW_DAYS} din me jo deals won ya lost hui
            {report ? ` · ${formatIstDate(report.since)} se aaj tak` : ""}
          </p>
        </div>
        <Link href={"/deals" as Route} className="shrink-0 text-xs font-medium text-amber-ink hover:underline">
          Deals kholo →
        </Link>
      </div>

      {error ? (
        <p className="text-sm text-rose-ink">Deals load nahi hue — {(error as Error).message}</p>
      ) : isLoading || !report ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24" />)}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
            <KPI
              label="Win rate"
              value={report.winRatePct === null ? "—" : `${report.winRatePct}%`}
              trend={`${report.won} won · ${report.lost} lost`}
              icon="target"
            />
            <KPI label="Won ₹" value={rupee(report.wonValue, { compact: true })} accent={report.wonValue > 0 ? "emerald" : "ink"} icon="rupee" />
            <KPI
              label="Avg won deal"
              value={report.avgWonValue === null ? "—" : rupee(report.avgWonValue, { compact: true })}
              icon="award"
            />
            <KPI
              label="Avg days to close"
              value={report.avgDaysToClose === null ? "—" : `${report.avgDaysToClose}`}
              unit={report.avgDaysToClose === null ? undefined : "din"}
              trend="lead bana → won"
              icon="calendar"
            />
          </div>

          {report.byOwner.length === 0 ? (
            <p className="text-sm text-ink-3 py-4 text-center">
              Is window me koi deal won ya lost nahi hui — jaise hi hogi, yahan owner-wise dikhegi.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Deals by owner, last {REPORT_WINDOW_DAYS} days</caption>
                <thead>
                  <tr className="text-left text-2xs uppercase tracking-wide text-ink-3 border-b border-hairline">
                    <th scope="col" className="py-2 pr-3 font-medium">Owner</th>
                    <th scope="col" className="py-2 px-3 font-medium text-right">Won</th>
                    <th scope="col" className="py-2 px-3 font-medium text-right">Won ₹</th>
                    <th scope="col" className="py-2 pl-3 font-medium text-right">Win rate</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byOwner.map((o) => (
                    <tr key={o.ownerId ?? "none"} className="border-b border-hairline last:border-0">
                      <td className="py-2 pr-3 text-ink">{nameOf(o.ownerId)}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{o.won}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{rupee(o.wonValue, { compact: true })}</td>
                      <td className="py-2 pl-3 text-right tabular-nums">
                        {o.winRatePct === null ? "—" : `${o.winRatePct}%`}
                        <span className="text-ink-3 text-xs ml-1">({o.won}/{o.won + o.lost})</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
