/**
 * SalaryLinesDialog — turn unmatched salary lines on a bank account into salary
 * records and reconcile them, after the operator has seen exactly what will happen.
 *
 * Auto-reconcile can only MATCH a line to a salary that Payroll already recorded.
 * When salaries were paid from the bank but never entered in Payroll, every salary
 * line sits unmatched. This reads the payee and month from each narration
 * (lib/banking/salary-lines.ts) and proposes, per line:
 *   • reconcile to the existing salary record for that employee + month, or
 *   • create that record (via the Payroll RPC) and reconcile to it, or
 *   • create the employee first, when no one by that name exists.
 * Nothing is written until "Book"; every line can be unticked, re-assigned or moved to
 * another month first. Anything unclear (two employees with the name, no readable
 * name, a month already paid) starts unticked and says why.
 */
"use client";

import * as React from "react";
import Link from "next/link";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate } from "@/lib/utils";
import type { BankTransactionRow } from "@/lib/queries/bank";
import { useEmployees, useSalaryPayments } from "@/lib/queries/payroll";
import { useBookSalaryLines, type SalaryGroupInput, type SalaryGroupResult } from "@/lib/queries/salary-from-bank";
import { parseSalaryNarration, matchEmployee, titleCaseName, type SalaryNarration } from "@/lib/banking/salary-lines";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  transactions: BankTransactionRow[];
}

/** "" = not chosen · "create" = create employee from the statement name · else employee id */
type Choice = string;

type Line = { txn: BankTransactionRow; parsed: SalaryNarration };

/** Unmatched money-out lines that read as salary. */
export function salaryLinesOf(transactions: BankTransactionRow[]): Line[] {
  return transactions.flatMap((txn) => {
    if (txn.matched_to_type !== null || txn.debit <= 0) return [];
    const parsed = parseSalaryNarration(txn.description ?? "", txn.txn_date);
    return parsed ? [{ txn, parsed }] : [];
  });
}

const monthLabel = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y}`;
};

export function SalaryLinesDialog({ open, onOpenChange, accountId, transactions }: Props) {
  const lines = React.useMemo(() => salaryLinesOf(transactions), [transactions]);
  const { data: employees = [], isLoading: empLoading } = useEmployees();
  const { data: salaries = [] } = useSalaryPayments();
  const book = useBookSalaryLines();

  const [choice, setChoice]   = React.useState<Record<string, Choice>>({});
  const [period, setPeriod]   = React.useState<Record<string, string>>({});
  const [include, setInclude] = React.useState<Record<string, boolean>>({});
  const [results, setResults] = React.useState<SalaryGroupResult[] | null>(null);

  /* Defaults, once employees have loaded — recomputed when the dialog reopens. */
  React.useEffect(() => {
    if (!open || empLoading) return;
    const c: Record<string, Choice> = {};
    const p: Record<string, string> = {};
    for (const { txn, parsed } of lines) {
      const m = matchEmployee(parsed.name, employees);
      c[txn.id] = m.kind === "match" ? m.id : m.kind === "none" && parsed.name ? "create" : "";
      p[txn.id] = parsed.period;
    }
    setChoice(c);
    setPeriod(p);
    setInclude({});
    setResults(null);
  }, [open, empLoading, lines, employees]);

  const activeEmployees = employees.filter((e) => e.is_active);
  const nameOf = (id: string) => employees.find((e) => e.id === id)?.name ?? "employee";

  /* The first line (top to bottom) set to create each name — the only one whose
     dropdown says "Create". */
  const firstCreateByName = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const x of lines) {
      const key = (x.parsed.name ?? "").toUpperCase();
      if (choice[x.txn.id] === "create" && (include[x.txn.id] ?? true) && !m.has(key)) m.set(key, x.txn.id);
    }
    return m;
  }, [lines, choice, include]);
  const isFirstCreate = (l: Line) => firstCreateByName.get((l.parsed.name ?? "").toUpperCase()) === l.txn.id;

  /** What booking this line would do — or why it cannot. */
  const planFor = (l: Line): { ok: boolean; text: string } => {
    const c = choice[l.txn.id] ?? "";
    const per = period[l.txn.id] ?? l.parsed.period;
    if (c === "") {
      const m = matchEmployee(l.parsed.name, employees);
      return { ok: false, text: m.kind === "ambiguous" ? "More than one employee has this name — pick one." : "No name on the line — pick the employee." };
    }
    if (c === "create") {
      /* One employee per name, however many lines carry it: only the first line
         creates, the rest say they reuse it. */
      const who = `"${titleCaseName(l.parsed.name ?? "")}"`;
      const emp = isFirstCreate(l) ? `New employee ${who}` : `Same new employee ${who} as above (not created again)`;
      return { ok: true, text: `${emp} + new ${monthLabel(per)} salary record` };
    }
    const rec = salaries.find((s) => s.employee_id === c && s.period === per);
    if (!rec) return { ok: true, text: `New ${monthLabel(per)} salary record for ${nameOf(c)}` };
    const remaining = rec.net - rec.paid_amount;
    if (rec.paid_status === "paid" || remaining <= 0) return { ok: false, text: `${monthLabel(per)} salary is already paid — will not be touched.` };
    if (l.txn.debit > remaining) return { ok: false, text: `${monthLabel(per)} record has only ${rupee(remaining)} left to pay.` };
    return { ok: true, text: `Reconcile to existing ${monthLabel(per)} record (${rupee(remaining)} left)` };
  };

  const isOn = (l: Line) => (include[l.txn.id] ?? true) && planFor(l).ok;
  const selected = lines.filter(isOn);
  const selectedTotal = selected.reduce((s, l) => s + l.txn.debit, 0);
  const anyCreatesRecord = selected.some((l) => planFor(l).text.includes("New "));

  const onBook = async () => {
    /* One group per employee + month: two transfers for the same month become one
       salary record, which is what Payroll's unique (employee, period) requires. */
    const groups = new Map<string, SalaryGroupInput>();
    for (const l of selected) {
      const c = choice[l.txn.id];
      const per = period[l.txn.id] ?? l.parsed.period;
      const empKey = c === "create" ? `create:${(l.parsed.name ?? "").toUpperCase()}` : c;
      const key = `${empKey}|${per}`;
      const g = groups.get(key) ?? {
        employee: c === "create"
          ? { createName: titleCaseName(l.parsed.name ?? ""), monthlyGross: l.txn.debit }
          : { id: c },
        period: per,
        lines: [],
      };
      g.lines.push({ txnId: l.txn.id, txnDate: l.txn.txn_date, amount: l.txn.debit, description: l.txn.description ?? "" });
      groups.set(key, g);
    }

    try {
      setResults(await book.mutateAsync({ accountId, groups: [...groups.values()] }));
    } catch {
      /* hook shows the error */
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-[640px] md:max-w-[760px] p-0 flex flex-col overflow-x-hidden">
        <SheetHeader>
          <SheetTitle>Salary lines → salary records</SheetTitle>
          <SheetDescription>
            Salary transfers found on this account that are not reconciled yet. For each one we
            read the employee and month from the narration — check them, then book. The salary
            record is created the same way Payroll creates it, and the bank line is reconciled to it.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3">
          {results ? (
            <div className="space-y-2">
              <p className="text-sm font-semibold text-ink">Result</p>
              {results.map((r, i) => (
                <div key={i} className={`rounded-md border px-3 py-2 text-2xs ${r.ok ? "border-emerald/30 bg-emerald-soft/40" : "border-rose/30 bg-rose-soft/40"}`}>
                  <p className="font-medium text-ink flex items-center gap-1.5">
                    <Icon name={r.ok ? "check_circle" : "alert"} size={13} className={r.ok ? "text-emerald" : "text-rose"} />
                    {r.label} · {monthLabel(r.period)}
                  </p>
                  <p className="text-ink-2 mt-0.5">{r.message}</p>
                </div>
              ))}
            </div>
          ) : lines.length === 0 ? (
            <p className="text-sm text-ink-2">No unreconciled salary lines on this account.</p>
          ) : (
            <>
              {activeEmployees.length === 0 && !empLoading && (
                <p className="rounded-md border border-amber/30 bg-amber-soft/40 px-3 py-2 text-2xs text-amber-ink">
                  No employees in Payroll yet. Lines with a readable name will create the employee
                  (monthly salary set to the amount paid — edit it later in{" "}
                  <Link href={"/accounting/payroll" as never} className="underline">Payroll</Link>).
                </p>
              )}

              <ul className="divide-y divide-hairline rounded-md border border-hairline">
                {lines.map((l) => {
                  const plan = planFor(l);
                  const on = isOn(l);
                  const c = choice[l.txn.id] ?? "";
                  const per = period[l.txn.id] ?? l.parsed.period;
                  return (
                    <li key={l.txn.id} className={`px-3 py-2.5 ${on ? "" : "bg-paper-2/40"}`}>
                      <div className="flex items-start gap-2.5">
                        <input
                          type="checkbox"
                          className="mt-1 accent-amber"
                          aria-label={`Book ${l.txn.description}`}
                          checked={on}
                          disabled={!plan.ok}
                          onChange={(e) => setInclude((s) => ({ ...s, [l.txn.id]: e.target.checked }))}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <p className="text-[12px] text-ink truncate" title={l.txn.description ?? ""}>{l.txn.description}</p>
                            <span className="text-[12px] font-semibold tabular-nums text-rose shrink-0">{rupee(l.txn.debit)}</span>
                          </div>
                          <p className="text-3xs text-ink-3">{formatDate(l.txn.txn_date)}</p>

                          <div className="mt-1.5 flex flex-wrap items-center gap-2">
                            <select
                              aria-label="Employee"
                              value={c}
                              onChange={(e) => setChoice((s) => ({ ...s, [l.txn.id]: e.target.value }))}
                              className="rounded border border-hairline bg-paper px-1.5 py-0.5 text-2xs text-ink max-w-[220px]"
                            >
                              <option value="">— pick employee —</option>
                              {l.parsed.name && (
                                <option value="create">
                                  {c === "create" && !isFirstCreate(l)
                                    ? `${titleCaseName(l.parsed.name)} (new, created above)`
                                    : `+ Create “${titleCaseName(l.parsed.name)}”`}
                                </option>
                              )}
                              {activeEmployees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                            </select>
                            <input
                              type="month"
                              aria-label="Salary month"
                              value={per}
                              onChange={(e) => setPeriod((s) => ({ ...s, [l.txn.id]: e.target.value }))}
                              className="rounded border border-hairline bg-paper px-1.5 py-0.5 text-2xs text-ink"
                            />
                            {!l.parsed.periodFromNarration && (
                              <Badge kind="warning" size="sm">month assumed</Badge>
                            )}
                            {l.parsed.fullAndFinal && (
                              <Badge kind="info" size="sm">full &amp; final</Badge>
                            )}
                          </div>
                          <p className={`mt-1 text-3xs ${plan.ok ? "text-ink-3" : "text-rose-ink"}`}>{plan.text}</p>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>

              {anyCreatesRecord && (
                <p className="text-3xs text-ink-3">
                  A new salary record is booked with <b>gross = the amount paid</b> and no TDS / PF / ESI
                  deductions — the bank line only shows the net. If deductions applied, delete the
                  record in Payroll before it is reconciled, or adjust it with your CA.
                </p>
              )}
            </>
          )}
        </div>

        <SheetFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {results ? "Close" : "Cancel"}
          </Button>
          {!results && (
            <Button
              variant="primary"
              icon="check"
              disabled={selected.length === 0}
              loading={book.isPending}
              onClick={onBook}
            >
              {`Book ${selected.length} line${selected.length === 1 ? "" : "s"} · ${rupee(selectedTotal)}`}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
