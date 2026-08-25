/**
 * ESI Register — month-wise, employee-wise ESI contributions (employee 0.75% +
 * employer 3.25%), with accrued-vs-paid totals. Read-only compliance report for
 * the owner and the CA. Rates/ceiling live in src/lib/payroll/esi.ts.
 */
"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { rupee } from "@/lib/utils";
import { ESI_EMPLOYEE_RATE, ESI_EMPLOYER_RATE, ESI_WAGE_CEILING } from "@/lib/payroll/esi";
import { useEsiRegister, type EsiRegisterRow } from "@/lib/queries/payroll";

function periodLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m) return period;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", { month: "short", year: "numeric" });
}

/** Export one month's rows in the ESIC "Monthly Contribution" bulk-upload
 *  column order. The portal computes the 0.75%/3.25% itself from wages + days,
 *  so the file carries IP number, name, paid days and total wages only. */
function downloadEsicCsv(period: string, rows: EsiRegisterRow[]) {
  const header = [
    "IP Number", "IP Name", "No of Days", "Total Monthly Wages",
    "Reason Code for Zero Working Days", "Last Working Day",
  ];
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([r.esiNo ?? "", esc(r.employee), r.days, r.wage, "0", ""].join(","));
  }
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ESIC-MC-${period}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function EsiRegisterPage() {
  const { data, isLoading } = useEsiRegister();

  const byPeriod = React.useMemo(() => {
    const map = new Map<string, EsiRegisterRow[]>();
    for (const r of data?.rows ?? []) {
      const arr = map.get(r.period) ?? [];
      arr.push(r);
      map.set(r.period, arr);
    }
    return Array.from(map.entries()); // already newest-first from the query
  }, [data]);

  return (
    <div className="mx-auto max-w-[1240px] p-4 md:p-6 lg:p-8 space-y-6">
      <header>
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Payroll</p>
        <h1 className="font-serif text-3xl text-ink">ESI Register</h1>
        <p className="text-sm text-ink-2 mt-1">
          Employees' State Insurance — employee {(ESI_EMPLOYEE_RATE * 100).toFixed(2)}% + employer{" "}
          {(ESI_EMPLOYER_RATE * 100).toFixed(2)}% on wages up to ₹{ESI_WAGE_CEILING.toLocaleString("en-IN")}/month.
        </p>
      </header>

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : (data?.rows.length ?? 0) === 0 ? (
        <Card className="py-2">
          <EmptyState
            icon="file"
            title="No ESI contributions yet"
            body="When you pay a salary for an ESI-applicable employee, the employee + employer ESI is recorded here. Tick “ESI applicable” on the employee, then run payroll."
          />
        </Card>
      ) : (
        <>
          {/* Accrued vs paid */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Card className="p-4">
              <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">ESI accrued</div>
              <div className="font-serif text-2xl text-ink mt-1">{rupee(data!.accrued)}</div>
              <div className="text-2xs text-ink-3 mt-0.5">employee + employer, all payslips</div>
            </Card>
            <Card className="p-4">
              <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Paid to ESIC</div>
              <div className="font-serif text-2xl text-ink mt-1">{rupee(data!.paid)}</div>
              <div className="text-2xs text-ink-3 mt-0.5">challans reconciled</div>
            </Card>
            <Card className="p-4">
              <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Still payable</div>
              <div className={`font-serif text-2xl mt-1 ${data!.outstanding > 0 ? "text-rose" : "text-emerald"}`}>{rupee(data!.outstanding)}</div>
              <div className="text-2xs text-ink-3 mt-0.5">accrued − paid</div>
            </Card>
          </div>

          {byPeriod.map(([period, rows]) => {
            const emp = rows.reduce((s, r) => s + r.employeeShare, 0);
            const empr = rows.reduce((s, r) => s + r.employerShare, 0);
            return (
              <Card key={period} className="overflow-hidden">
                <div className="flex items-center justify-between gap-3 bg-paper-2/50 px-4 py-2.5">
                  <span className="font-semibold text-ink">{periodLabel(period)}</span>
                  <div className="flex items-center gap-3">
                    <span className="hidden sm:inline text-xs text-ink-2 font-mono">
                      employee {rupee(emp)} · employer {rupee(empr)} · <b className="text-ink">{rupee(emp + empr)}</b>
                    </span>
                    <Button size="sm" variant="outline" icon="download" onClick={() => downloadEsicCsv(period, rows)}>
                      ESIC upload
                    </Button>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                      <tr>
                        <th className="text-left px-4 py-2">Employee</th>
                        <th className="text-left px-4 py-2">ESI no.</th>
                        <th className="text-right px-4 py-2">Days</th>
                        <th className="text-right px-4 py-2">Wages</th>
                        <th className="text-right px-4 py-2">Employee 0.75%</th>
                        <th className="text-right px-4 py-2">Employer 3.25%</th>
                        <th className="text-right px-4 py-2">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={i} className="border-t border-hairline">
                          <td className="px-4 py-2.5 text-ink">{r.employee}</td>
                          <td className="px-4 py-2.5 font-mono text-ink-3 text-xs">{r.esiNo ?? "—"}</td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums">{r.days}</td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums">{rupee(r.wage)}</td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums">{rupee(r.employeeShare)}</td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums">{rupee(r.employerShare)}</td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold text-ink">{rupee(r.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            );
          })}
        </>
      )}
    </div>
  );
}
