/**
 * ProjectMarginCard — software built for customers, one line per project for the period:
 * revenue invoiced against its milestones, minus the salary of the people allocated to
 * it and the expenses tagged to it.
 *
 * Figures come from lib/accounting/project-cost.ts — the same numbers the P&L moved out
 * of operating expenses and into cost of goods, so this card and the statement agree.
 * Who works on which project is edited on the project page; this card only reads it.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { rupee } from "@/lib/utils";
import type { ProjectCostResult } from "@/lib/accounting/project-cost";

export function ProjectMarginCard({ result, periodLabel }: { result: ProjectCostResult; periodLabel: string }) {
  const totals = result.byProject.reduce(
    (t, p) => ({ revenue: t.revenue + p.revenue, labour: t.labour + p.labour, direct: t.direct + p.direct }),
    { revenue: 0, labour: 0, direct: 0 },
  );
  const margin = totals.revenue - totals.labour - totals.direct;

  return (
    <Card className="p-5 md:p-6 mb-6">
      <div className="mb-4">
        <h2 className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">Project margin</h2>
        <p className="text-2xs text-ink-3 mt-0.5">
          {periodLabel} · revenue from project milestones − salary of the people on the project − project expenses.
          This cost is part of “Cost of goods” above, not operating expenses.
        </p>
      </div>

      {result.byProject.length > 0 && (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-[13px] tabular-nums">
            <thead>
              <tr className="text-2xs uppercase tracking-wider text-ink-3 text-left">
                <th className="px-1 py-1.5 font-semibold">Project</th>
                <th className="px-1 py-1.5 font-semibold text-right">Revenue</th>
                <th className="px-1 py-1.5 font-semibold text-right">Salary</th>
                <th className="px-1 py-1.5 font-semibold text-right hidden sm:table-cell">Expenses</th>
                <th className="px-1 py-1.5 font-semibold text-right">Margin</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {result.byProject.map((p) => (
                <tr key={p.projectId}>
                  <td className="px-1 py-2 min-w-0">
                    <Link href={`/projects/${p.projectId}`} className="text-ink hover:underline">{p.title}</Link>
                    {p.customerName && <div className="text-2xs text-ink-3 truncate">{p.customerName}</div>}
                  </td>
                  <td className="px-1 py-2 text-right text-ink">
                    {p.revenue > 0 ? rupee(p.revenue) : <span className="text-2xs text-ink-3">not invoiced</span>}
                  </td>
                  <td className="px-1 py-2 text-right text-rose">{p.labour > 0 ? `− ${rupee(p.labour)}` : "—"}</td>
                  <td className="px-1 py-2 text-right text-rose hidden sm:table-cell">{p.direct > 0 ? `− ${rupee(p.direct)}` : "—"}</td>
                  <td className={`px-1 py-2 text-right font-medium ${p.margin >= 0 ? "text-emerald" : "text-rose"}`}>
                    {p.margin < 0 ? `− ${rupee(-p.margin)}` : rupee(p.margin)}
                    {p.marginPct !== null && <span className="text-2xs text-ink-3 ml-1">{p.marginPct}%</span>}
                  </td>
                </tr>
              ))}
            </tbody>
            {result.byProject.length > 1 && (
              <tfoot>
                <tr className="border-t-2 border-ink font-semibold">
                  <td className="px-1 py-2 text-ink">Total</td>
                  <td className="px-1 py-2 text-right text-ink">{rupee(totals.revenue)}</td>
                  <td className="px-1 py-2 text-right text-rose">− {rupee(totals.labour)}</td>
                  <td className="px-1 py-2 text-right text-rose hidden sm:table-cell">− {rupee(totals.direct)}</td>
                  <td className={`px-1 py-2 text-right ${margin >= 0 ? "text-emerald" : "text-rose"}`}>{margin < 0 ? `− ${rupee(-margin)}` : rupee(margin)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {/* A project with salary spent but nothing invoiced yet is work in progress, not a
          loss-making project — said so, so the red margin is read correctly. */}
      {result.byProject.some((p) => p.revenue === 0 && p.labour + p.direct > 0) && (
        <p className="mt-3 text-2xs text-ink-3 leading-snug">
          “Not invoiced” — salary was spent on this project in the period but no milestone was invoiced yet.
          It shows as a negative margin until the milestone is billed.
        </p>
      )}
      {result.capped && (
        <p className="mt-2 text-2xs text-amber-ink leading-snug">
          Allocated salary ({rupee(result.labourAllocated)}) is more than the salary booked in this period
          ({rupee(result.salaryPool)}), so each project&apos;s salary has been scaled down to what was booked.
        </p>
      )}
      {result.undated > 0 && (
        <p className="mt-2 text-2xs text-amber-ink leading-snug">
          {result.undated} labour allocation{result.undated === 1 ? " has" : "s have"} no start date (on the allocation or the project),
          so {result.undated === 1 ? "it is" : "they are"} not counted in any period.
        </p>
      )}
    </Card>
  );
}
