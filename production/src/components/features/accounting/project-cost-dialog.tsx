/**
 * ProjectCostDialog — what "Cost of goods (project delivery)" on the P&L is made of:
 * every employee allocation that counted in the period (project, % of time, the dates
 * inside the period, months, monthly salary, cost) and every project-tagged expense.
 *
 * Same lines lib/accounting/project-cost.ts summed for the statement, so the total here
 * is the number on the row that opened it.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { rupee, formatDate } from "@/lib/utils";
import type { ProjectCostResult } from "@/lib/accounting/project-cost";

interface Props {
  open: boolean;
  onClose: () => void;
  result: ProjectCostResult;
  employeeNames: ReadonlyMap<string, string>;
  periodLabel: string;
}

export function ProjectCostDialog({ open, onClose, result, employeeNames, periodLabel }: Props) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-2xl">
        <DialogHeader>
          <DialogTitle>Project delivery cost · {rupee(result.total)}</DialogTitle>
          <DialogDescription>
            {periodLabel} · salary of the people allocated to customer projects
            {result.direct > 0 ? " + expenses tagged to a project" : ""}. Moved here from operating expenses — not added.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto -mx-1 px-1 space-y-5">
          {result.labourLines.length > 0 && (
            <section>
              <h3 className="text-2xs font-semibold uppercase tracking-wider text-ink-3 mb-2">
                Salary on projects · {rupee(result.labour)}
              </h3>
              <ul className="divide-y divide-hairline">
                {result.labourLines.map((l) => (
                  <li key={`${l.projectId}-${l.employeeId}`} className="flex items-start justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <div className="text-sm text-ink">
                        {employeeNames.get(l.employeeId) ?? "Employee"}
                        <span className="text-ink-3"> · {l.percent}% on </span>
                        <Link href={`/projects/${l.projectId}`} className="text-ink hover:underline">{l.projectTitle}</Link>
                      </div>
                      <div className="text-2xs text-ink-3 tabular-nums">
                        {formatDate(l.from)} – {formatDate(l.to)} · {l.months} mo × {rupee(l.monthlyGross)}/mo × {l.percent}%
                        {l.cost !== l.allocated && <> · {rupee(l.allocated)} scaled to salary booked</>}
                      </div>
                    </div>
                    <span className="shrink-0 font-mono text-sm text-rose tabular-nums">− {rupee(l.cost)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {result.directLines.length > 0 && (
            <section>
              <h3 className="text-2xs font-semibold uppercase tracking-wider text-ink-3 mb-2">
                Project expenses · {rupee(result.direct)}
              </h3>
              <ul className="divide-y divide-hairline">
                {result.directLines.map((d, i) => (
                  <li key={i} className="flex items-start justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <div className="text-sm text-ink truncate">
                        {d.vendor || d.description || d.category || "Expense"}
                        <span className="text-ink-3"> · </span>
                        <Link href={`/projects/${d.projectId}`} className="text-ink-2 hover:underline">{d.projectTitle}</Link>
                      </div>
                      <div className="text-2xs text-ink-3">
                        {d.date ? formatDate(d.date) : "—"}{d.category ? ` · ${d.category}` : ""}{d.description && d.vendor ? ` · ${d.description}` : ""}
                      </div>
                    </div>
                    <span className="shrink-0 font-mono text-sm text-rose tabular-nums">− {rupee(d.amount)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {result.capped && (
            <p className="text-2xs text-amber-ink leading-snug">
              Allocations add up to {rupee(result.labourAllocated)}, more than the {rupee(result.salaryPool)} of salary booked in
              this period — so each line is scaled down to what was actually booked.
            </p>
          )}
          {result.undated > 0 && (
            <p className="text-2xs text-amber-ink leading-snug">
              {result.undated} allocation{result.undated === 1 ? " has" : "s have"} no start date, so {result.undated === 1 ? "it is" : "they are"} not
              counted. Add a start date on the project page (Team / Labour).
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
